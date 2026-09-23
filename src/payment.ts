import type { RequestHandler } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { FacilitatorResponseError, HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import { isAddress, zeroAddress } from "viem";
import { FACILITATOR_URL, kiteChainByName, kitePriceAmount, type KiteNetworkName } from "./kite.js";

export interface PaymentOptions {
  payTo: string;
  network: KiteNetworkName;
  priceUsd: string;
  /** Canonical URL; never constructed from caller-controlled Host or query. */
  resourceUrl: string;
  facilitatorUrl?: string;
  /** Dependency injection for offline integration tests. Never a test bypass. */
  facilitator?: FacilitatorClient;
}

export const FACILITATOR_MAX_INFLIGHT_PER_OPERATION = 4;

function validateUrl(value: string, label: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed for loopback development only)`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query parameters, or a fragment`);
  }
  return url;
}

/**
 * Redact upstream error text and bound actual facilitator promises. Each verify
 * and settle pool has four slots. Slots are held until the awaited operation
 * finishes, even when the caller disconnects; there is no background queue or
 * Promise.race timeout that could release a slot while work is still running.
 */
function privateFacilitatorErrors(client: FacilitatorClient): FacilitatorClient {
  let verifying = 0;
  let settling = 0;
  return {
    async getSupported() {
      try { return await client.getSupported(); }
      catch { throw new FacilitatorResponseError("Payment facilitator capabilities are unavailable."); }
    },
    async verify(payload, requirements) {
      if (verifying >= FACILITATOR_MAX_INFLIGHT_PER_OPERATION) {
        throw new FacilitatorResponseError("Payment verification capacity is full.");
      }
      verifying++;
      try {
        const result = await client.verify(payload, requirements);
        return result.isValid ? result : { isValid: false, invalidReason: "payment_verification_failed" };
      } catch (error) {
        if (error instanceof VerifyError) return { isValid: false, invalidReason: "payment_verification_failed" };
        throw new FacilitatorResponseError("Payment facilitator verification is unavailable.");
      } finally { verifying--; }
    },
    async settle(payload, requirements) {
      if (settling >= FACILITATOR_MAX_INFLIGHT_PER_OPERATION) {
        throw new FacilitatorResponseError("Payment settlement capacity is full; settlement was not attempted.");
      }
      settling++;
      try {
        const result = await client.settle(payload, requirements);
        if (!result.success) {
          return { success: false, errorReason: "payment_settlement_failed", transaction: "", network: requirements.network };
        }
        // No extensions are enabled by this service. Publish only receipt fields,
        // excluding arbitrary facilitator extra data and error messages.
        return {
          success: true, transaction: result.transaction, network: result.network,
          ...(result.payer === undefined ? {} : { payer: result.payer }),
          ...(result.amount === undefined ? {} : { amount: result.amount }),
        };
      } catch (error) {
        if (error instanceof SettleError) {
          return { success: false, errorReason: "payment_settlement_failed", transaction: "", network: requirements.network };
        }
        // A timed-out settlement may have reached the chain; never promise a
        // refund or suggest automatically signing a second payment.
        throw new FacilitatorResponseError("Payment settlement is unavailable; the settlement outcome may be unknown.");
      } finally { settling--; }
    },
  };
}

/**
 * Authorize first, run the audit handler, then settle. The official middleware
 * buffers the response and releases it only after successful settlement; 4xx
 * and 5xx audit responses do not settle. No signer or private key is needed.
 */
export function createPaymentMiddleware(options: PaymentOptions): RequestHandler {
  if (!isAddress(options.payTo, { strict: false }) || options.payTo.toLowerCase() === zeroAddress) {
    throw new Error("PAY_TO must be a nonzero EVM address");
  }
  const chain = kiteChainByName(options.network);
  const price = kitePriceAmount(options.priceUsd, chain);
  const resource = validateUrl(options.resourceUrl, "resourceUrl");
  if (resource.pathname !== "/v1/memory/audit") {
    throw new Error("resourceUrl must point to /v1/memory/audit");
  }
  const facilitatorUrl = validateUrl(options.facilitatorUrl ?? FACILITATOR_URL, "FACILITATOR_URL");
  const facilitator = options.facilitator ?? new HTTPFacilitatorClient({
    url: facilitatorUrl.href.replace(/\/$/, ""),
    timeoutMs: 15_000,
  });
  const resourceServer = new x402ResourceServer(privateFacilitatorErrors(facilitator))
    .register(chain.network, new ExactEvmScheme());
  return paymentMiddleware({
    "POST /v1/memory/audit": {
      resource: resource.href,
      accepts: {
        scheme: "exact",
        network: chain.network,
        payTo: options.payTo,
        price,
        // Allow the bounded 15s verify + 45s audit + 15s settlement path,
        // plus the client's time to sign and send the authorization.
        maxTimeoutSeconds: 120,
      },
      description: "ERC-8350 public memory history audit with fixed-block evidence",
      mimeType: "application/json",
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { error: { code: "payment_required", message: "A valid Kite x402 payment is required." } },
      }),
      settlementFailedResponseBody: () => ({
        contentType: "application/json",
        body: { error: { code: "payment_settlement_failed", message: "Payment settlement failed; no audit result was released." } },
      }),
    },
  }, resourceServer);
}
