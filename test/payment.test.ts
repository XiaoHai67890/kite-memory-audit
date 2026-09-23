import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import express, { type RequestHandler } from "express";
import { FacilitatorResponseError, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { KITE_MAINNET, KITE_TESTNET, kitePriceAmount, type KiteNetworkName } from "../src/kite.js";
import { createPaymentMiddleware, FACILITATOR_MAX_INFLIGHT_PER_OPERATION, type PaymentOptions } from "../src/payment.js";
import { createApp, type AppDependencies } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { EvidenceSnapshot } from "../src/types.js";

// These are OFFLINE SDK integration tests. The facilitator is a stub and the
// authorization is synthetic: none of these tests is proof of real payment.
const PAY_TO = "0x1234567890123456789012345678901234567890";
const PAYER = "0x2345678901234567890123456789012345678901";
const RESOURCE_URL = "https://memory-audit.example/v1/memory/audit";
const TX_HASH = `0x${"aa".repeat(32)}`;

function mockFacilitator(events: string[], options: { valid?: boolean; settled?: boolean; settleThrows?: boolean } = {}): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: [KITE_TESTNET, KITE_MAINNET].map(chain => ({
          x402Version: 2,
          scheme: "exact",
          network: chain.network,
        })),
        extensions: [],
        signers: {},
      };
    },
    async verify(_payload, requirements) {
      events.push("verify");
      assert.equal(requirements.payTo, PAY_TO);
      return options.valid === false
        ? { isValid: false, invalidReason: "invalid_signature" }
        : { isValid: true, payer: PAYER };
    },
    async settle(_payload, requirements) {
      events.push("settle");
      if (options.settleThrows) throw new Error("synthetic facilitator outage");
      return options.settled === false
        ? { success: false, errorReason: "insufficient_funds", transaction: "", network: requirements.network }
        : { success: true, transaction: TX_HASH, network: requirements.network, payer: PAYER };
    },
  };
}

async function serve(t: TestContext, handler: RequestHandler, facilitator: FacilitatorClient, network: KiteNetworkName = "testnet"): Promise<string> {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(createPaymentMiddleware({ payTo: PAY_TO, priceUsd: "0.001", resourceUrl: RESOURCE_URL, network, facilitator }));
  app.post("/v1/memory/audit", handler);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return listen(t, app);
}

async function listen(t: TestContext, app: ReturnType<typeof express>): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function challenge(base: string, suffix = "", headers: Record<string, string> = {}): Promise<{ response: Response; required: PaymentRequired }> {
  const response = await fetch(`${base}/v1/memory/audit${suffix}`, { method: "POST", headers });
  const header = response.headers.get("payment-required");
  assert.equal(response.status, 402);
  assert.ok(header);
  return { response, required: decodePaymentRequiredHeader(header) };
}

function payment(required: PaymentRequired): string {
  const accepted = required.accepts[0];
  assert.ok(accepted);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { signature: "synthetic-offline-signature", authorization: { from: PAYER } },
  };
  return encodePaymentSignatureHeader(payload);
}

test("prices use exact integer units on both Kite assets, with positive six-decimal validation", () => {
  assert.equal(kitePriceAmount("0.001", KITE_MAINNET).amount, "1000");
  assert.equal(kitePriceAmount("0.001", KITE_TESTNET).amount, "1000000000000000");
  assert.equal(kitePriceAmount("12.345678", KITE_MAINNET).amount, "12345678");
  assert.equal(kitePriceAmount("12.345678", KITE_TESTNET).amount, "12345678000000000000");
  for (const invalid of ["0", "0.000000", "-1", "1e-3", "0.0000001", "NaN", "Infinity", "$0.001", " 0.001", ".1", "01", "1."]) {
    assert.throws(() => kitePriceAmount(invalid, KITE_TESTNET), /PRICE_USD/);
  }
});

test("payment options reject zero recipients and unsafe canonical URLs before SDK initialization", () => {
  const options: PaymentOptions = { payTo: PAY_TO, priceUsd: "0.001", resourceUrl: RESOURCE_URL, network: "testnet", facilitator: mockFacilitator([]) };
  assert.throws(() => createPaymentMiddleware({ ...options, payTo: `0x${"00".repeat(20)}` }), /nonzero EVM/);
  assert.throws(() => createPaymentMiddleware({ ...options, payTo: "garbage" }), /nonzero EVM/);
  for (const url of ["http://example.com/v1/memory/audit", `${RESOURCE_URL}?token=secret`, `${RESOURCE_URL}#secret`, "https://user:secret@example.com/v1/memory/audit", "https://example.com/other"]) {
    assert.throws(() => createPaymentMiddleware({ ...options, resourceUrl: url }));
  }
  assert.throws(() => createPaymentMiddleware({ ...options, facilitatorUrl: "https://user:secret@example.com/v2" }));
});

for (const [network, chain, expectedAmount] of [
  ["testnet", KITE_TESTNET, "1000000000000000"],
  ["mainnet", KITE_MAINNET, "1000"],
] as const) {
  test(`unpaid request advertises ${network} asset, amount and canonical resource without reflecting secrets`, async t => {
    const events: string[] = [];
    const base = await serve(t, (_req, res) => { events.push("audit"); res.json({ privateReport: true }); }, mockFacilitator(events), network);
    const { response, required } = await challenge(base, "?secret=NEVER_ECHO_THIS", { authorization: "Bearer NEVER_ECHO_HEADER" });
    assert.equal(required.resource.url, RESOURCE_URL);
    assert.equal(required.x402Version, 2);
    assert.deepEqual(required.accepts[0], {
      scheme: "exact", network: chain.network, amount: expectedAmount, asset: chain.assetAddress,
      payTo: PAY_TO, maxTimeoutSeconds: 120,
      extra: { name: chain.eip712Name, version: chain.eip712Version },
    });
    const body = await response.text();
    assert.match(body, /payment_required/);
    assert.doesNotMatch(body + JSON.stringify(required), /NEVER_ECHO|privateReport/);
    assert.deepEqual(events, []);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/memory/audit`)).status, 404);
  });
}

test("SDK verifies, computes audit, then settles and releases the response with receipt", async t => {
  const events: string[] = [];
  const base = await serve(t, async (_req, res) => {
    events.push("audit");
    await new Promise(resolve => setTimeout(resolve, 5));
    res.json({ status: "consistent", evidence: "public" });
  }, mockFacilitator(events));
  const { required } = await challenge(base);
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "consistent", evidence: "public" });
  assert.deepEqual(events, ["verify", "audit", "settle"]);
  assert.equal(decodePaymentResponseHeader(response.headers.get("payment-response")!).transaction, TX_HASH);
  assert.match(response.headers.get("cache-control")!, /private/);
});

test("invalid payment fails before audit and settlement", async t => {
  const events: string[] = [];
  const base = await serve(t, (_req, res) => { events.push("audit"); res.json({ privateReport: true }); }, mockFacilitator(events, { valid: false }));
  const { required } = await challenge(base);
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
  assert.equal(response.status, 402);
  assert.doesNotMatch(await response.text(), /privateReport/);
  assert.deepEqual(events, ["verify"]);
});

for (const status of [400, 422, 500, 503]) {
  test(`audit error ${status} is returned without settlement`, async t => {
    const events: string[] = [];
    const base = await serve(t, (_req, res) => {
      events.push("audit");
      res.status(status).json({ error: { code: status === 503 ? "incomplete_report" : "audit_failed" } });
    }, mockFacilitator(events));
    const { required } = await challenge(base);
    const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("payment-response"), null);
    assert.deepEqual(events, ["verify", "audit"]);
  });
}

test("failed settlement discards successful audit body", async t => {
  const events: string[] = [];
  const base = await serve(t, (_req, res) => {
    events.push("audit");
    res.json({ status: "consistent", privateReport: "DO_NOT_RELEASE_UNPAID" });
  }, mockFacilitator(events, { settled: false }));
  const { required } = await challenge(base);
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
  assert.equal(response.status, 402);
  const body = await response.text();
  assert.match(body, /payment_settlement_failed/);
  assert.doesNotMatch(body, /consistent|privateReport|DO_NOT_RELEASE_UNPAID/);
  assert.deepEqual(events, ["verify", "audit", "settle"]);
});

test("unexpected settlement failure never releases an audit report", async t => {
  const events: string[] = [];
  const base = await serve(t, (_req, res) => {
    events.push("audit");
    res.json({ privateReport: "DO_NOT_RELEASE_UNPAID" });
  }, mockFacilitator(events, { settleThrows: true }));
  const { required } = await challenge(base);
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
  assert.ok(response.status >= 400);
  const responseData = await response.text() + (response.headers.get("payment-response") ? JSON.stringify(decodePaymentResponseHeader(response.headers.get("payment-response")!)) : "");
  assert.doesNotMatch(responseData, /privateReport|DO_NOT_RELEASE_UNPAID|synthetic facilitator outage/);
  assert.deepEqual(events, ["verify", "audit", "settle"]);
});

test("malformed payment headers fail closed without audit or facilitator verification", async t => {
  const events: string[] = [];
  const base = await serve(t, (_req, res) => { events.push("audit"); res.json({ privateReport: true }); }, mockFacilitator(events));
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": "NOT_A_PAYMENT_SECRET" } });
  assert.equal(response.status, 402);
  assert.doesNotMatch(await response.text(), /NOT_A_PAYMENT_SECRET|privateReport/);
  assert.deepEqual(events, []);
});

test("malformed facilitator responses do not reflect upstream response excerpts", async t => {
  const events: string[] = [];
  const facilitator = mockFacilitator(events);
  facilitator.verify = async () => {
    throw new FacilitatorResponseError("Facilitator verify returned invalid JSON: UPSTREAM_PRIVATE_DETAIL");
  };
  const base = await serve(t, (_req, res) => { events.push("audit"); res.json({ privateReport: true }); }, facilitator);
  const { required } = await challenge(base);
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers: { "payment-signature": payment(required) } });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /UPSTREAM_PRIVATE_DETAIL|privateReport/);
  assert.deepEqual(events, []);
});

const integrationConfig: AppConfig = {
  mode: "paid", host: "127.0.0.1", port: 8080, network: "testnet", priceUsd: "0.001",
  payTo: PAY_TO, publicBaseUrl: "https://memory-audit.example", maxConcurrent: 1,
  registries: [{ chainId: 11155111, address: "0x4444444444444444444444444444444444444444",
    fromBlock: "1", expectedCodeHash: `0x${"11".repeat(32)}`, rpcUrl: "http://127.0.0.1:1",
    label: "offline synthetic registry", source: "https://example.com/synthetic-test-only" }],
};
const auditBody = JSON.stringify({ chainId: 11155111, registry: integrationConfig.registries[0]!.address,
  spaceId: `0x${"22".repeat(32)}` });

async function serveRealApp(t: TestContext, events: string[], collect: AppDependencies["collect"]) {
  const middleware = createPaymentMiddleware({ payTo: PAY_TO, priceUsd: "0.001", resourceUrl: RESOURCE_URL,
    network: "testnet", facilitator: mockFacilitator(events) });
  const base = await listen(t, createApp(integrationConfig, { payment: middleware, collect }));
  const response = await fetch(`${base}/v1/memory/audit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: auditBody,
  });
  assert.equal(response.status, 402);
  const required = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
  return { base, headers: { "content-type": "application/json", "payment-signature": payment(required) } };
}

test("real app asynchronous collector error is handled by Express without settlement or secret reflection", async t => {
  const events: string[] = [];
  const { base, headers } = await serveRealApp(t, events, async () => {
    events.push("collect");
    await Promise.resolve();
    throw new Error("PRIVATE_RPC_CREDENTIAL_IN_ERROR");
  });
  const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers, body: auditBody });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /AUDIT_UNAVAILABLE/);
  assert.doesNotMatch(body, /PRIVATE_RPC_CREDENTIAL_IN_ERROR/);
  assert.equal(response.headers.get("payment-response"), null);
  assert.deepEqual(events, ["verify", "collect"]);
});

test("real app capacity rejection after verified payment does not settle", async t => {
  const events: string[] = [];
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const { base, headers } = await serveRealApp(t, events, async () => {
    events.push("collect");
    started();
    await blocked;
    throw new Error("Synthetic collector cancellation after capacity check");
  });
  const first = fetch(`${base}/v1/memory/audit`, { method: "POST", headers, body: auditBody });
  await entered;
  try {
    const busy = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers, body: auditBody });
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, "BUSY");
    assert.equal(busy.headers.get("payment-response"), null);
  } finally { release(); }
  assert.equal((await first).status, 503);
  assert.deepEqual(events, ["verify", "collect", "verify"]);
});

function unknownEvidence(mixedFailure: boolean): EvidenceSnapshot {
  const registry = integrationConfig.registries[0]!;
  const zero = `0x${"00".repeat(32)}` as const;
  return {
    chainId: registry.chainId, registry: registry.address, spaceId: `0x${"22".repeat(32)}`,
    block: { number: "10", hash: `0x${"33".repeat(32)}`, timestamp: "1700000000" },
    registryEvidence: { fromBlock: "1", expectedCodeHash: registry.expectedCodeHash,
      actualCodeHash: registry.expectedCodeHash, source: "Synthetic offline missing-registration evidence" },
    head: { sequence: "0", transitionId: zero, stateRoot: mixedFailure ? `0x${"44".repeat(32)}` : zero },
    authorization: { controller: PAY_TO, authorizer: PAYER, configNonce: "0" },
    events: [], rpcLabel: "synthetic-offline-test",
  };
}

for (const mixedFailure of [false, true]) {
  test(`real app does not settle incomplete evidence (${mixedFailure ? "mixed fail and unknown" : "unknown only"})`, async t => {
    const events: string[] = [];
    const { base, headers } = await serveRealApp(t, events, async () => {
      events.push("collect");
      return unknownEvidence(mixedFailure);
    });
    const response = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers, body: auditBody });
    assert.equal(response.status, 503);
    const report = await response.json();
    assert.equal(report.verdict, mixedFailure ? "inconsistent" : "inconclusive");
    assert.ok(report.checks.some((check: { status: string }) => check.status === "unknown"));
    assert.equal(report.checks.some((check: { status: string }) => check.status === "fail"), mixedFailure);
    assert.equal(response.headers.get("payment-response"), null);
    assert.deepEqual(events, ["verify", "collect"]);
  });
}

test("facilitator verification slots remain occupied until real promises finish, including client disconnect", async t => {
  const facilitator = mockFacilitator([]);
  let calls = 0;
  let release!: () => void;
  let full!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupied = new Promise<void>(resolve => { full = resolve; });
  facilitator.verify = async () => {
    calls++;
    if (calls === FACILITATOR_MAX_INFLIGHT_PER_OPERATION) full();
    await gate;
    return { isValid: false, invalidReason: "synthetic_rejection" };
  };
  const base = await serve(t, (_req, res) => { res.json({ unexpectedAudit: true }); }, facilitator);
  const { required } = await challenge(base);
  const headers = { "payment-signature": payment(required) };
  const disconnected = new AbortController();
  const pending = Array.from({ length: FACILITATOR_MAX_INFLIGHT_PER_OPERATION }, (_, index) => fetch(`${base}/v1/memory/audit`, {
    method: "POST", headers, ...(index === 0 ? { signal: disconnected.signal } : {}),
  }).then(response => response.status, (error: Error) => error.name));
  try {
    await occupied;
    disconnected.abort();
    assert.equal(await pending[0], "AbortError");
    const extra = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers, signal: AbortSignal.timeout(1_000) });
    assert.equal(extra.status, 502);
    assert.match(await extra.text(), /capacity is full/);
    assert.equal(calls, FACILITATOR_MAX_INFLIGHT_PER_OPERATION);
  } finally { release(); }
  await Promise.all(pending);
  const after = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers });
  assert.equal(after.status, 402);
  assert.equal(calls, FACILITATOR_MAX_INFLIGHT_PER_OPERATION + 1);
});

test("facilitator settlement capacity fails closed without starting extra settlements or releasing reports", async t => {
  const facilitator = mockFacilitator([]);
  let calls = 0;
  let release!: () => void;
  let full!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupied = new Promise<void>(resolve => { full = resolve; });
  facilitator.settle = async (_payload, requirements) => {
    calls++;
    if (calls === FACILITATOR_MAX_INFLIGHT_PER_OPERATION) full();
    await gate;
    return { success: true, network: requirements.network, transaction: TX_HASH, payer: PAYER };
  };
  const base = await serve(t, (_req, res) => { res.json({ report: "DO_NOT_RELEASE_WITHOUT_SETTLEMENT" }); }, facilitator);
  const { required } = await challenge(base);
  const headers = { "payment-signature": payment(required) };
  const pending = Array.from({ length: FACILITATOR_MAX_INFLIGHT_PER_OPERATION }, () => fetch(`${base}/v1/memory/audit`, {
    method: "POST", headers,
  }));
  try {
    await occupied;
    const extra = await fetch(`${base}/v1/memory/audit`, { method: "POST", headers, signal: AbortSignal.timeout(1_000) });
    assert.equal(extra.status, 502);
    const body = await extra.text();
    assert.match(body, /settlement capacity is full/);
    assert.doesNotMatch(body, /DO_NOT_RELEASE_WITHOUT_SETTLEMENT/);
    assert.equal(calls, FACILITATOR_MAX_INFLIGHT_PER_OPERATION);
  } finally { release(); }
  for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
});
