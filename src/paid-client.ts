import { createHash } from 'node:crypto';
import { z } from 'zod';
import { recoverTypedDataAddress, type Hex } from 'viem';
import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { checkPaymentQuote, decodeBoundedBase64Json, validatePaymentPolicy, type CheckedQuote, type PaymentPolicy } from './payment-quote.js';
import { verifyPaymentReceipt, type ReceiptExpectation, type ReceiptRpc, type ReceiptVerification } from './payment-receipt.js';
import { kiteChainByName } from './kite.js';
import { parseAuditRequest, addressSchema, hashSchema } from './validation.js';
import type { AuditRequest } from './types.js';

export const MAX_CLIENT_RESPONSE_BYTES = 4_000_000;
const uint256 = z.string().refine(v => /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n);
const authorizationSchema = z.object({
  from: addressSchema, to: addressSchema, value: uint256,
  validAfter: uint256, validBefore: uint256, nonce: hashSchema,
}).strict();
const payloadSchema = z.object({
  x402Version: z.literal(2), resource: z.object({ url: z.string() }).strict(),
  accepted: z.unknown(),
  payload: z.object({ authorization: authorizationSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict(),
}).strict();
const authorizationTypes = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;

export type FetchClient = (input: string, init: RequestInit) => Promise<Response>;
export interface Preflight {
  schemaVersion: '1'; method: 'POST'; request: AuditRequest; requestSha256: string; quote: CheckedQuote;
}
export interface Attempt {
  schemaVersion: '1'; resourceUrl: string; requestSha256: string; payer: string;
  network: PaymentPolicy['network']; payTo: string; amount: string; nonce: string;
  validBefore: string; createdAt: string;
}
export interface PaidCallEvidence {
  schemaVersion: '1'; status: 'verified' | 'unknown' | 'rejected'; code: string;
  requestSha256: string; resourceUrl: string; attempt?: Attempt;
  httpStatus?: number; receipt?: ReceiptVerification; expectation?: ReceiptExpectation;
  report?: { sha256: string; verdict: string; subject: AuditRequest };
  limitations: string[];
}
const limitations = [
  'The payment authorization binds the token transfer, not the HTTP body. The request digest is a local correlation record, not an on-chain commitment.',
  'Receipt verification trusts the supplied RPC. Confirmations are not a consensus proof or a guarantee against later reorgs.',
  'An HTTP report is merchant-provided data. This client checks its requested subject and completeness markers, not memory truth.',
  'Unknown payment outcomes must be investigated before signing another authorization. This client never automatically retries a paid request.',
];
export function sha256(data: string): string { return createHash('sha256').update(data).digest('hex'); }

async function readBody(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_CLIENT_RESPONSE_BYTES)) throw new Error('response_too_large');
  if (!response.body) throw new Error('missing_response_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.length;
      if (total > MAX_CLIENT_RESPONSE_BYTES) throw new Error('response_too_large');
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Unpaid, read-only preflight. Never follows a redirect to another merchant. */
export async function preflightAudit(policyInput: PaymentPolicy, input: unknown, fetcher: FetchClient = fetch): Promise<Preflight> {
  const policy = validatePaymentPolicy(policyInput);
  const request = parseAuditRequest(input);
  const body = JSON.stringify(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(policy.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      redirect: 'manual', signal: controller.signal, credentials: 'omit',
    });
    try {
      if (response.status !== 402) throw new Error('preflight_requires_http_402');
      const header = response.headers.get('payment-required');
      if (!header) throw new Error('payment_required_header_missing');
      const quote = checkPaymentQuote(header, policy);
      return { schemaVersion: '1', method: 'POST', request, requestSha256: sha256(body), quote };
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    // Do not copy server bodies, headers, URLs with credentials or transport errors.
    if (error instanceof Error && /^(preflight_requires_http_402|payment_required_header_missing)$/.test(error.message)) throw error;
    throw new Error('Preflight failed: unavailable service or an unacceptable payment quote.');
  } finally { clearTimeout(timer); }
}

/** Caller supplies a wallet-backed signer. No private-key loading or transaction broadcasting. */
export async function createSignedPayment(quote: CheckedQuote, signer: ClientEvmSigner): Promise<PaymentPayload> {
  // Re-check the format at the signing boundary as well. The independent user
  // budget/recipient policy is enforced by preflightAudit / executePaidAudit.
  const checked = checkPaymentQuote(Buffer.from(JSON.stringify({
    x402Version: 2, resource: { url: quote.resourceUrl }, accepts: [quote.requirements],
  })).toString('base64'), {
    url: quote.resourceUrl, network: quote.requirements.network === 'eip155:2368' ? 'testnet' : 'mainnet',
    payTo: quote.requirements.payTo, maxAmount: quote.requirements.amount,
  });
  // Only expose the minimal signing capability to the SDK; no Permit2/approval helpers.
  const scheme = new ExactEvmScheme({ address: signer.address, signTypedData: msg => signer.signTypedData(msg) });
  const result = await scheme.createPaymentPayload(2, checked.requirements);
  return { x402Version: 2, resource: { url: checked.resourceUrl }, accepted: checked.requirements, payload: result.payload };
}

/** Restrict this first client to recoverable EOA EIP-3009 signatures. Contract wallets fail closed. */
export async function validateSignedPayment(raw: unknown, quote: CheckedQuote, payerInput: string, now = Math.floor(Date.now() / 1000)): Promise<PaymentPayload> {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unsupported or malformed signed payment.');
  const payment = parsed.data;
  const payer = addressSchema.parse(payerInput);
  const accepted = checkPaymentQuote(Buffer.from(JSON.stringify({
    x402Version: 2, resource: payment.resource, accepts: [payment.accepted],
  })).toString('base64'), {
    url: quote.resourceUrl, network: quote.requirements.network === 'eip155:2368' ? 'testnet' : 'mainnet',
    payTo: quote.requirements.payTo, maxAmount: quote.requirements.amount,
  });
  if (JSON.stringify(accepted.requirements) !== JSON.stringify(quote.requirements)) throw new Error('Signed payment does not match the current quote.');
  const auth = payment.payload.authorization;
  if (auth.from.toLowerCase() !== payer.toLowerCase() || auth.to.toLowerCase() !== quote.requirements.payTo.toLowerCase() || auth.value !== quote.requirements.amount) {
    throw new Error('Payment payer, recipient or amount does not match.');
  }
  if (!Number.isSafeInteger(now) || BigInt(auth.validAfter) > BigInt(now) || BigInt(auth.validBefore) < BigInt(now + 6)
    || BigInt(auth.validBefore) > BigInt(now + quote.requirements.maxTimeoutSeconds + 5)) throw new Error('Payment authorization validity window is unacceptable.');
  const extra = quote.requirements.extra!;
  const recovered = await recoverTypedDataAddress({
    domain: { name: extra.name as string, version: extra.version as string,
      chainId: Number(quote.requirements.network.split(':')[1]), verifyingContract: quote.requirements.asset as Hex },
    types: authorizationTypes, primaryType: 'TransferWithAuthorization',
    message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
    signature: payment.payload.signature as Hex,
  });
  if (recovered.toLowerCase() !== payer.toLowerCase()) throw new Error('Payment signature does not recover the expected payer.');
  return { ...payment, accepted: structuredClone(accepted.requirements) } as PaymentPayload;
}

const responseSchema = z.object({
  success: z.literal(true), transaction: hashSchema.refine(v => BigInt(v) !== 0n), network: z.string(),
  payer: addressSchema.optional(), amount: uint256.optional(),
}).strict();
const reportSchema = z.object({
  schemaVersion: z.literal('1'), verdict: z.enum(['consistent', 'inconsistent']),
  subject: z.object({ chainId: z.number(), registry: addressSchema, spaceId: hashSchema }).strict(),
  checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'fail']), message: z.string() })).min(1).max(100_000),
  checkpoint: z.object({ status: z.enum(['matches', 'mismatch', 'not_provided']), sequence: uint256.optional() }).strict(),
  evidence: z.object({ block: z.object({ number: uint256, hash: hashSchema }) }),
});

export interface PaidAuditOptions {
  policy: PaymentPolicy; request: unknown; payer: string; rpc: ReceiptRpc;
  /** Invoked once, only after preflight. May present a wallet approval to its user. */
  sign: (quote: CheckedQuote) => Promise<unknown>;
  /** Persist/claim the payer+network+nonce before sending; throw to prevent duplicate execution. */
  beforeSend: (attempt: Attempt) => Promise<void>;
  fetcher?: FetchClient;
}

/** One unpaid challenge and at most one signed HTTP request. No automatic signing or HTTP retry. */
export async function executePaidAudit(options: PaidAuditOptions): Promise<PaidCallEvidence> {
  // Snapshot inputs before invoking any external callback (including the signer).
  const policy = validatePaymentPolicy(structuredClone(options.policy));
  const payer = addressSchema.parse(options.payer);
  const preflight = await preflightAudit(policy, structuredClone(options.request), options.fetcher);
  const quote = structuredClone(preflight.quote);
  const base = { schemaVersion: '1' as const, requestSha256: preflight.requestSha256, resourceUrl: policy.url, limitations };
  let payment: PaymentPayload;
  try {
    const signed = await options.sign(structuredClone(quote));
    payment = await validateSignedPayment(signed, quote, payer);
  } catch { return { ...base, status: 'rejected', code: 'signature_rejected' }; }
  const auth = authorizationSchema.parse((payment.payload as { authorization: unknown }).authorization);
  const attempt: Attempt = {
    schemaVersion: '1', resourceUrl: policy.url, requestSha256: preflight.requestSha256,
    payer, network: policy.network, payTo: quote.requirements.payTo, amount: auth.value,
    nonce: auth.nonce, validBefore: auth.validBefore, createdAt: new Date().toISOString(),
  };
  try { await options.beforeSend(structuredClone(attempt)); }
  catch { return { ...base, attempt, status: 'rejected', code: 'attempt_not_claimed' }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  let response: Response;
  let text: string;
  try {
    response = await (options.fetcher ?? fetch)(policy.url, {
      method: 'POST', body: JSON.stringify(preflight.request), credentials: 'omit', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment) },
    });
    text = await readBody(response);
  } catch { return { ...base, attempt, status: 'unknown', code: 'paid_response_unavailable' }; }
  finally { clearTimeout(timer); }
  const receiptHeader = response.headers.get('payment-response');
  if (!receiptHeader) return { ...base, attempt, httpStatus: response.status, status: 'unknown', code: 'settlement_receipt_missing' };
  let settlement: z.infer<typeof responseSchema>;
  try { settlement = responseSchema.parse(decodeBoundedBase64Json(receiptHeader)); }
  catch { return { ...base, attempt, httpStatus: response.status, status: 'unknown', code: 'settlement_receipt_invalid' }; }
  if (settlement.network !== kiteChainByName(policy.network).network
    || (settlement.payer && settlement.payer.toLowerCase() !== payer.toLowerCase())
    || (settlement.amount !== undefined && settlement.amount !== auth.value)) {
    return { ...base, attempt, httpStatus: response.status, status: 'unknown', code: 'settlement_metadata_mismatch' };
  }
  const expectation: ReceiptExpectation = {
    network: policy.network, transaction: settlement.transaction, payer, payTo: quote.requirements.payTo,
    amount: auth.value, nonce: auth.nonce,
  };
  const receipt = await verifyPaymentReceipt(expectation, options.rpc);
  const evidence = { ...base, attempt, httpStatus: response.status, expectation, receipt };
  if (receipt.status !== 'verified') return { ...evidence, status: 'unknown', code: 'settlement_not_verified' };
  if (response.status !== 200) return { ...evidence, status: 'unknown', code: 'settled_without_http_200' };
  try {
    const report = reportSchema.parse(JSON.parse(text));
    const requested = preflight.request;
    if (report.subject.chainId !== requested.chainId || report.subject.registry !== requested.registry
      || report.subject.spaceId !== requested.spaceId || (requested.atBlock && report.evidence.block.number !== requested.atBlock)) {
      throw new Error('report_subject_mismatch');
    }
    if (requested.checkpoint
      ? report.checkpoint.status === 'not_provided' || report.checkpoint.sequence !== requested.checkpoint.sequence
      : report.checkpoint.status !== 'not_provided' || report.checkpoint.sequence !== undefined) {
      throw new Error('report_checkpoint_mismatch');
    }
    return { ...evidence, status: 'verified', code: 'settlement_verified_report_received',
      report: { sha256: sha256(text), verdict: report.verdict, subject: report.subject } };
  } catch { return { ...evidence, status: 'unknown', code: 'settled_without_matching_report' }; }
}
