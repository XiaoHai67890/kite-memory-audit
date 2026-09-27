import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { toEventSelector, toHex } from 'viem';
import type { PaymentPayload } from '@x402/core/types';
import { createSignedPayment, executePaidAudit, MAX_CLIENT_RESPONSE_BYTES, sha256, type FetchClient, type PaidAuditOptions } from '../src/paid-client.js';
import { KITE_TESTNET } from '../src/kite.js';
import { checkPaymentQuote, type CheckedQuote, type PaymentPolicy } from '../src/payment-quote.js';
import type { ReceiptRpc } from '../src/payment-receipt.js';

// PUBLIC, intentionally insecure private keys 1 and 2, used only for offline
// deterministic account identities. No wallet, facilitator, or chain is contacted.
const account = privateKeyToAccount(`0x${'0'.repeat(63)}1`);
const otherAccount = privateKeyToAccount(`0x${'0'.repeat(63)}2`);
const PAY_TO = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const RESOURCE_URL = 'https://audit.example/v1/memory/audit';
const h = (n: number) => toHex(BigInt(n), { size: 32 });
const TX = h(999), BLOCK_HASH = h(888);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const addressTopic = (value: string) => `0x${'0'.repeat(24)}${value.slice(2).toLowerCase()}`;
const template = JSON.parse(readFileSync(new URL('../evidence/live-sepolia-report.json', import.meta.url), 'utf8'));
interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
interface SignedPayload { authorization: Authorization; signature: string }

function fixture() {
  const policy: PaymentPolicy = { url: RESOURCE_URL, network: 'testnet', payTo: PAY_TO, maxAmount: '1000000000000000' };
  const request = structuredClone(template.subject);
  const report = structuredClone(template);
  const quote = {
    x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [{ scheme: 'exact', network: KITE_TESTNET.network,
      asset: KITE_TESTNET.assetAddress, amount: policy.maxAmount, payTo: PAY_TO, maxTimeoutSeconds: 120,
      extra: { name: KITE_TESTNET.eip712Name, version: KITE_TESTNET.eip712Version } }],
  };
  const state = {
    events: [] as string[], calls: [] as { url: string; body: string; redirect: RequestRedirect | undefined; headers: Headers }[],
    signCount: 0, paidStatus: 200, preflightStatus: 402, receiptHeader: true,
    signed: undefined as PaymentPayload | undefined,
    mutateSettlement: undefined as ((value: Record<string, unknown>) => void) | undefined,
    paidException: undefined as Error | undefined,
    responseText: undefined as string | undefined,
    responseLength: undefined as string | undefined,
    receiptNonce: undefined as string | undefined,
  };
  const fetcher: FetchClient = async (url, init) => {
    const headers = new Headers(init.headers);
    state.calls.push({ url, body: String(init.body), redirect: init.redirect, headers });
    if (!headers.has('PAYMENT-SIGNATURE')) {
      state.events.push('preflight');
      return new Response('untrusted-preflight-body-secret', { status: state.preflightStatus,
        headers: { 'PAYMENT-REQUIRED': b64(quote), Location: 'https://attacker.example/v1/memory/audit' } });
    }
    state.events.push('paid-http');
    if (state.paidException) throw state.paidException;
    const payload = JSON.parse(Buffer.from(headers.get('PAYMENT-SIGNATURE')!, 'base64').toString('utf8')) as PaymentPayload;
    state.signed = payload;
    const auth = (payload.payload as unknown as SignedPayload).authorization;
    state.receiptNonce = auth.nonce;
    const settlement: Record<string, unknown> = { success: true, transaction: TX, network: KITE_TESTNET.network,
      payer: account.address, amount: auth.value };
    state.mutateSettlement?.(settlement);
    const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (state.receiptHeader) responseHeaders['PAYMENT-RESPONSE'] = b64(settlement);
    if (state.responseLength !== undefined) responseHeaders['Content-Length'] = state.responseLength;
    return new Response(state.responseText ?? JSON.stringify(report), { status: state.paidStatus, headers: responseHeaders });
  };
  const rpc: ReceiptRpc = async (method) => {
    state.events.push(method);
    if (method === 'eth_chainId') return '0x940';
    if (method === 'eth_blockNumber') return '0x65';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: BLOCK_HASH, transactions: [TX] };
    if (method === 'eth_getTransactionReceipt') {
      const auth = (state.signed!.payload as unknown as SignedPayload).authorization;
      const position = { blockNumber: '0x64', blockHash: BLOCK_HASH, transactionHash: TX, transactionIndex: '0x0', removed: false };
      return { transactionHash: TX, blockNumber: '0x64', blockHash: BLOCK_HASH, transactionIndex: '0x0', status: '0x1', logs: [
        { ...position, address: KITE_TESTNET.assetAddress, logIndex: '0x0', data: '0x',
          topics: [toEventSelector('AuthorizationUsed(address,bytes32)'), addressTopic(auth.from), state.receiptNonce] },
        { ...position, address: KITE_TESTNET.assetAddress, logIndex: '0x1', data: toHex(BigInt(auth.value), { size: 32 }),
          topics: [toEventSelector('Transfer(address,address,uint256)'), addressTopic(auth.from), addressTopic(auth.to)] },
      ] };
    }
    throw new Error('Unexpected RPC method');
  };
  const sign = async (checked: CheckedQuote) => {
    state.signCount++; state.events.push('sign');
    return createSignedPayment(checked, account);
  };
  const options: PaidAuditOptions = { policy, request, payer: account.address, rpc, sign, fetcher,
    beforeSend: async () => { state.events.push('before-send'); } };
  return { options, policy, request, report, quote, state, sign, rpc };
}

test('offline EOA SDK client performs one challenge, one signature and one paid request in claim order', async () => {
  const f = fixture();
  const result = await executePaidAudit(f.options);
  assert.equal(result.status, 'verified');
  assert.equal(result.code, 'settlement_verified_report_received');
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.signCount, 1);
  assert.deepEqual(f.state.events.slice(0, 4), ['preflight', 'sign', 'before-send', 'paid-http']);
  assert.equal(f.state.calls[0]!.body, f.state.calls[1]!.body);
  assert.equal(result.requestSha256, sha256(f.state.calls[1]!.body));
  assert.equal(result.receipt?.status, 'verified');
  assert.equal(f.state.calls[0]!.redirect, 'manual'); assert.equal(f.state.calls[1]!.redirect, 'manual');
  const signature = (f.state.signed!.payload as unknown as SignedPayload).signature;
  assert(!JSON.stringify(result).includes(signature));
  assert(!JSON.stringify(result).includes('PAYMENT-SIGNATURE'));
  assert(!JSON.stringify(result).includes('untrusted-preflight-body-secret'));
});

test('unacceptable quote or redirect cannot trigger signing or a paid request', async () => {
  for (const change of ['recipient', 'amount', 'domain', 'url', 'redirect'] as const) {
    const f = fixture();
    if (change === 'recipient') f.quote.accepts[0]!.payTo = OTHER;
    if (change === 'amount') f.quote.accepts[0]!.amount = '1000000000000001';
    if (change === 'domain') f.quote.accepts[0]!.extra.name = 'WrongToken';
    if (change === 'url') f.quote.resource.url = 'https://attacker.example/v1/memory/audit';
    if (change === 'redirect') f.state.preflightStatus = 302;
    await assert.rejects(executePaidAudit(f.options));
    assert.equal(f.state.signCount, 0); assert.equal(f.state.calls.length, 1);
  }
});

test('wrong signer, expired authorization and payload tampering are rejected before paid HTTP', async () => {
  for (const change of ['signer', 'expired', 'amount', 'signature'] as const) {
    const f = fixture();
    f.options.sign = async checked => {
      const payment = await createSignedPayment(checked, change === 'signer' ? otherAccount : account);
      const payload = payment.payload as unknown as SignedPayload;
      if (change === 'expired') payload.authorization.validBefore = '1';
      if (change === 'amount') payload.authorization.value = '1';
      if (change === 'signature') payload.signature = `0x${'11'.repeat(65)}`;
      return payment;
    };
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'rejected'); assert.equal(result.code, 'signature_rejected');
    assert.equal(f.state.calls.length, 1); assert(!f.state.events.includes('before-send'));
  }
});

test('mutating signer callback cannot change snapshotted policy, request, or accepted quote', async () => {
  const f = fixture();
  const originalRequest = structuredClone(f.request);
  f.options.sign = async checked => {
    const payment = await f.sign(checked);
    f.policy.url = 'https://attacker.example/v1/memory/audit'; f.policy.payTo = OTHER;
    f.request.chainId = 1; f.request.spaceId = h(777);
    checked.resourceUrl = f.policy.url; checked.requirements.payTo = OTHER; checked.requirements.amount = '9000000000000000';
    return payment;
  };
  const result = await executePaidAudit(f.options);
  assert.equal(result.status, 'verified');
  assert.equal(f.state.calls[1]!.url, RESOURCE_URL);
  assert.deepEqual(JSON.parse(f.state.calls[1]!.body), originalRequest);
  assert.equal(result.attempt?.payTo, PAY_TO);
  assert.equal(result.attempt?.amount, '1000000000000000');
});

test('a signer returning a genuinely signed but mutated quote cannot redirect payment', async () => {
  const f = fixture();
  f.options.sign = async checked => { checked.requirements.payTo = OTHER; return createSignedPayment(checked, account); };
  const result = await executePaidAudit(f.options);
  assert.equal(result.status, 'rejected'); assert.equal(f.state.calls.length, 1);
});

test('beforeSend cannot mutate the returned signer payload or the claimed attempt used by HTTP', async () => {
  const f = fixture(); let original: PaymentPayload | undefined;
  f.options.sign = async checked => { original = await f.sign(checked); return original; };
  f.options.beforeSend = async attempt => {
    f.state.events.push('before-send');
    original!.accepted.payTo = OTHER;
    original!.accepted.amount = '1';
    original!.resource!.url = 'https://attacker.example/v1/memory/audit';
    const payload = original!.payload as unknown as SignedPayload;
    payload.authorization.to = OTHER; payload.authorization.value = '1';
    payload.signature = `0x${'11'.repeat(65)}`;
    attempt.payTo = OTHER; attempt.nonce = h(777); attempt.resourceUrl = 'https://attacker.example/v1/memory/audit';
  };
  const result = await executePaidAudit(f.options);
  assert.equal(result.status, 'verified');
  assert.equal(f.state.signed!.accepted.payTo, PAY_TO);
  assert.equal(f.state.signed!.accepted.amount, '1000000000000000');
  assert.equal(f.state.signed!.resource!.url, RESOURCE_URL);
  assert.equal(result.attempt?.payTo, PAY_TO);
  assert.equal(result.attempt?.resourceUrl, RESOURCE_URL);
  assert.notEqual(result.attempt?.nonce, h(777));
});

test('direct signing helper rejects unrecognized quote extras before invoking the signer', async () => {
  const f = fixture();
  const checked = checkPaymentQuote(b64(f.quote), f.policy);
  checked.requirements.extra = { ...checked.requirements.extra, assetTransferMethod: 'permit2' };
  let signatures = 0;
  await assert.rejects(createSignedPayment(checked, { address: account.address,
    signTypedData: async message => { signatures++; return account.signTypedData(message); } }));
  assert.equal(signatures, 0);
});

test('failure to claim original nonce prevents transmission and leaks no callback error', async () => {
  const f = fixture();
  f.options.beforeSend = async () => { throw new Error('journal-secret-token'); };
  const result = await executePaidAudit(f.options);
  assert.equal(result.code, 'attempt_not_claimed'); assert.equal(result.status, 'rejected');
  assert.equal(f.state.calls.length, 1); assert(!JSON.stringify(result).includes('journal-secret-token'));
});

test('non-200, missing settlement receipt, and paid transport timeout stay unknown with no retry', async () => {
  for (const mode of ['non-200', 'missing', 'timeout', 'redirect'] as const) {
    const f = fixture();
    if (mode === 'non-200') f.state.paidStatus = 503;
    if (mode === 'missing') f.state.receiptHeader = false;
    if (mode === 'timeout') f.state.paidException = new Error('AbortError https://rpc.example/private-api-key');
    if (mode === 'redirect') f.state.paidStatus = 307;
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown'); assert.equal(f.state.calls.length, 2); assert.equal(f.state.signCount, 1);
    assert(!JSON.stringify(result).includes('private-api-key'));
  }
});

test('settlement response wrong network/payer/amount or unsupported fields cannot verify', async () => {
  for (const change of [{ network: 'eip155:1' }, { payer: OTHER }, { amount: '1' }, { success: false }, { transaction: '0x12' }, { privateMetadata: 'secret' }]) {
    const f = fixture(); f.state.mutateSettlement = value => Object.assign(value, change);
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown'); assert(!JSON.stringify(result).includes('privateMetadata'));
    assert.equal(f.state.calls.length, 2);
  }
});

test('independent RPC receipt mismatch or absent receipt cannot produce verified client evidence', async () => {
  for (const mode of ['chain', 'nonce', 'missing'] as const) {
    const f = fixture();
    f.options.rpc = async (method, params) => {
      if (mode === 'chain' && method === 'eth_chainId') return '0x1';
      if (mode === 'missing' && method === 'eth_getTransactionReceipt') return null;
      if (mode === 'nonce' && method === 'eth_getTransactionReceipt') f.state.receiptNonce = h(777);
      return f.rpc(method, params);
    };
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'settlement_not_verified');
    assert.equal(f.state.signCount, 1); assert.equal(f.state.calls.length, 2);
  }
});

test('report subject, fixed block, unknown checks and invalid JSON cannot be accepted after settlement', async () => {
  for (const mode of ['chain', 'registry', 'space', 'block', 'unknown-check', 'json'] as const) {
    const f = fixture();
    if (mode === 'chain') f.report.subject.chainId = 1;
    if (mode === 'registry') f.report.subject.registry = OTHER;
    if (mode === 'space') f.report.subject.spaceId = h(777);
    if (mode === 'block') f.request.atBlock = '1';
    if (mode === 'unknown-check') f.report.checks[0].status = 'unknown';
    if (mode === 'json') f.state.responseText = 'secret-non-json-report';
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'settled_without_matching_report');
    assert.equal(result.receipt?.status, 'verified');
    assert(!JSON.stringify(result).includes('secret-non-json-report'));
  }
});

test('checkpoint request requires a conclusive checkpoint result for the same sequence', async () => {
  for (const mode of ['missing', 'not_provided', 'wrong-sequence', 'ahead'] as const) {
    const f = fixture();
    f.request.checkpoint = { sequence: '5', stateRoot: f.report.evidence.head.stateRoot };
    if (mode === 'missing') delete f.report.checkpoint;
    if (mode === 'not_provided') f.report.checkpoint = { status: 'not_provided' };
    if (mode === 'wrong-sequence') f.report.checkpoint = { status: 'matches', sequence: '4' };
    if (mode === 'ahead') f.report.checkpoint = { status: 'ahead', sequence: '5' };
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown', mode); assert.equal(result.code, 'settled_without_matching_report');
  }
});

test('matching checkpoint and completed checkpoint mismatch are both delivered audit reports', async () => {
  for (const status of ['matches', 'mismatch'] as const) {
    const f = fixture();
    f.request.checkpoint = { sequence: '5', stateRoot: f.report.evidence.head.stateRoot };
    f.report.checkpoint = { status, sequence: '5' };
    if (status === 'mismatch') f.report.verdict = 'inconsistent';
    assert.equal((await executePaidAudit(f.options)).status, 'verified');
  }
});

test('without a requested checkpoint, an unsolicited checkpoint result is not a matching report', async () => {
  const f = fixture(); f.report.checkpoint = { status: 'matches', sequence: '5' };
  const result = await executePaidAudit(f.options);
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'settled_without_matching_report');
});

test('oversized declared or streamed response remains unknown and never causes another payment', async () => {
  for (const declared of [true, false]) {
    const f = fixture();
    if (declared) f.state.responseLength = String(MAX_CLIENT_RESPONSE_BYTES + 1);
    else f.state.responseText = 'x'.repeat(MAX_CLIENT_RESPONSE_BYTES + 1);
    const result = await executePaidAudit(f.options);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'paid_response_unavailable');
    assert.equal(f.state.calls.length, 2); assert.equal(f.state.signCount, 1);
  }
});
