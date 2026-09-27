import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { FacilitatorClient } from '@x402/core/server';
import { KITE_MAINNET, KITE_TESTNET } from '../src/kite.js';
import { createPaymentMiddleware } from '../src/payment.js';
import { checkPaymentQuote, decodeBoundedBase64Json, MAX_PAYMENT_HEADER_BYTES,
  validatePaymentPolicy, type PaymentPolicy } from '../src/payment-quote.js';

const RESOURCE = 'https://audit.example/v1/memory/audit';
const RECIPIENT = '0x1234567890123456789012345678901234567890';
const MAX_UINT256 = ((1n << 256n) - 1n).toString();
const policy = (network: PaymentPolicy['network'] = 'testnet'): PaymentPolicy => ({
  url: RESOURCE, network, payTo: RECIPIENT, maxAmount: '1000000000000000',
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
function quote(network: PaymentPolicy['network'] = 'testnet') {
  const chain = network === 'testnet' ? KITE_TESTNET : KITE_MAINNET;
  return {
    x402Version: 2, resource: { url: RESOURCE, description: 'ERC-8350 memory history', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: chain.network, asset: chain.assetAddress,
      amount: '1000', payTo: RECIPIENT, maxTimeoutSeconds: 120,
      extra: { name: chain.eip712Name, version: chain.eip712Version } }],
  };
}

for (const network of ['testnet', 'mainnet'] as const) {
  test(`valid ${network} quote matches independent policy and excludes display metadata`, () => {
    const offer = quote(network);
    const original = structuredClone(offer);
    const checked = checkPaymentQuote(encode(offer), policy(network));
    assert.equal(checked.resourceUrl, RESOURCE);
    assert.equal(checked.requirements.amount, '1000');
    assert.equal(checked.requirements.network, network === 'testnet' ? 'eip155:2368' : 'eip155:2366');
    assert.equal(checked.requirements.payTo, RECIPIENT);
    assert.deepEqual(Object.keys(checked).sort(), ['requirements', 'resourceUrl']);
    assert.deepEqual(offer, original);
  });
}

test('amount comparison is exact over the uint256 domain without Number rounding', () => {
  const offer = quote();
  offer.accepts[0]!.amount = MAX_UINT256;
  assert.equal(checkPaymentQuote(encode(offer), { ...policy(), maxAmount: MAX_UINT256 }).requirements.amount, MAX_UINT256);
  offer.accepts[0]!.amount = '9007199254740993';
  assert.throws(() => checkPaymentQuote(encode(offer), { ...policy(), maxAmount: '9007199254740992' }), /exceeds/);
  offer.accepts[0]!.amount = '1';
  assert.equal(checkPaymentQuote(encode(offer), { ...policy(), maxAmount: '1' }).requirements.amount, '1');
});

test('both the policy limit and quote amount must be positive canonical uint256 strings', () => {
  for (const invalid of ['0', '00', '01', '-1', '+1', '1.0', '1e3', ' 1', '1 ', '', 'NaN', 'SECRET_BAD_AMOUNT',
    (1n << 256n).toString(), '9'.repeat(79), 1, null]) {
    const offer = quote();
    const malformedOffer = { ...offer, accepts: [{ ...offer.accepts[0], amount: invalid }] };
    assert.throws(() => checkPaymentQuote(encode(malformedOffer), policy()), /Invalid payment quote/);
    assert.throws(() => validatePaymentPolicy({ ...policy(), maxAmount: invalid }), /Invalid payment policy/);
  }
});

test('untrusted offers cannot change network, token, recipient, EIP-712 domain or price', () => {
  const mutations = [
    { network: 'eip155:2366' }, { network: 'eip155:5042002' }, { network: 'eip155:02368' },
    { asset: KITE_MAINNET.assetAddress }, { asset: RECIPIENT },
    { payTo: '0x2345678901234567890123456789012345678901' },
    { amount: '1000000000000001' },
    { extra: { name: 'USDC', version: '1' } }, { extra: { name: 'pieUSD', version: '2' } },
    { extra: { name: 'pieusd', version: '1' } },
  ];
  for (const change of mutations) {
    const offer = quote();
    Object.assign(offer.accepts[0]!, change);
    assert.throws(() => checkPaymentQuote(encode(offer), policy()), /Payment quote/);
  }
});

test('zero or malformed addresses fail in either policy or challenge', () => {
  for (const address of [`0x${'00'.repeat(20)}`, '0x1', '0xZZ34567890123456789012345678901234567890', null]) {
    assert.throws(() => validatePaymentPolicy({ ...policy(), payTo: address }), /Invalid payment policy/);
    for (const field of ['asset', 'payTo']) {
      const offer = quote();
      const modified = { ...offer, accepts: [{ ...offer.accepts[0], [field]: address }] };
      assert.throws(() => checkPaymentQuote(encode(modified), policy()), /Invalid payment quote/);
    }
  }
});

test('resource URL must equal the independent approved URL byte for byte', () => {
  for (const url of ['https://attacker.example/v1/memory/audit', `${RESOURCE}/`, `${RESOURCE}?token=secret`,
    `${RESOURCE}#secret`, 'https://user:password@audit.example/v1/memory/audit',
    'https://AUDIT.example/v1/memory/audit', 'https://audit.example:443/v1/memory/audit']) {
    const offer = quote(); offer.resource.url = url;
    assert.throws(() => checkPaymentQuote(encode(offer), policy()), /does not match the approved URL/);
  }
});

test('policy rejects noncanonical URLs, alternate paths, credentials, query and fragment delimiters', () => {
  for (const url of ['http://audit.example/v1/memory/audit', 'file:///v1/memory/audit', '/v1/memory/audit',
    `${RESOURCE}?`, `${RESOURCE}#`, `${RESOURCE}/`, `${RESOURCE} `,
    'https://user:password@audit.example/v1/memory/audit',
    'https://audit.example/v1/memory/../memory/audit', 'https://audit.example/v1/%6demory/audit',
    'https://AUDIT.example/v1/memory/audit', 'https://audit.example:443/v1/memory/audit',
    'https:\\audit.example\\v1\\memory\\audit']) {
    assert.throws(() => validatePaymentPolicy({ ...policy(), url }));
  }
});

test('loopback is available only through explicit opt-in and cannot enable remote HTTP', () => {
  for (const url of ['http://127.0.0.1:8080/v1/memory/audit', 'http://[::1]:8080/v1/memory/audit',
    'http://localhost:8080/v1/memory/audit', 'https://127.0.0.1/v1/memory/audit',
    'https://[::ffff:7f00:1]/v1/memory/audit']) {
    const localPolicy = { ...policy(), url };
    assert.throws(() => validatePaymentPolicy(localPolicy), /Loopback/);
    assert.equal(validatePaymentPolicy(localPolicy, { allowLoopback: true }).url, url);
    const offer = quote(); offer.resource.url = url;
    assert.throws(() => checkPaymentQuote(encode(offer), localPolicy), /Loopback/);
    assert.equal(checkPaymentQuote(encode(offer), localPolicy, { allowLoopback: true }).resourceUrl, url);
  }
  for (const url of ['http://remote.example/v1/memory/audit', 'http://127.attacker.example/v1/memory/audit',
    'http://localhost.attacker.example/v1/memory/audit']) {
    assert.throws(() => validatePaymentPolicy({ ...policy(), url }, { allowLoopback: true }), /HTTPS/);
  }
});

test('timeout must be an integer in the bounded 30–300 second authorization window', () => {
  for (const timeout of [30, 300]) {
    const offer = quote(); offer.accepts[0]!.maxTimeoutSeconds = timeout;
    assert.equal(checkPaymentQuote(encode(offer), policy()).requirements.maxTimeoutSeconds, timeout);
  }
  for (const maxTimeoutSeconds of [0, 29, 301, 1.5, '120', null]) {
    const offer = quote();
    assert.throws(() => checkPaymentQuote(encode({ ...offer, accepts: [{ ...offer.accepts[0], maxTimeoutSeconds }] }), policy()), /Invalid payment quote/);
  }
});

test('only one exact x402 v2 offer is accepted', () => {
  const offer = quote();
  for (const modified of [null, [], {}, { ...offer, x402Version: 1 }, { ...offer, x402Version: '2' },
    { ...offer, accepts: [] }, { ...offer, accepts: [offer.accepts[0], offer.accepts[0]] },
    { ...offer, accepts: [{ ...offer.accepts[0], scheme: 'upto' }] },
    { ...offer, accepts: [{ ...offer.accepts[0], extra: undefined }] }]) {
    assert.throws(() => checkPaymentQuote(encode(modified), policy()), /Invalid payment quote/);
  }
});

test('extensions and unknown fields cannot alter the checked payment semantics', () => {
  const offer = quote();
  for (const modified of [
    { ...offer, extensions: {} }, { ...offer, extensions: { 'sign-in-with-x': {} } },
    { ...offer, paymentFlow: 'upfront' },
    { ...offer, accepts: [{ ...offer.accepts[0], paymentFlow: 'upfront' }] },
    { ...offer, accepts: [{ ...offer.accepts[0], extra: { ...offer.accepts[0]!.extra, assetTransferMethod: 'permit2' } }] },
    { ...offer, accepts: [{ ...offer.accepts[0], extra: { ...offer.accepts[0]!.extra, spender: RECIPIENT } }] },
    { ...offer, resource: { ...offer.resource, extensions: {} } },
  ]) assert.throws(() => checkPaymentQuote(encode(modified), policy()), /Invalid payment quote/);
  assert.throws(() => validatePaymentPolicy({ ...policy(), allowLoopback: true }), /Invalid payment policy/);
  assert.throws(() => validatePaymentPolicy({ ...policy(), network: 'dev' }), /Invalid payment policy/);
});

test('base64 decoder enforces canonical standard alphabet, padding and a 32 KiB header limit', () => {
  assert.deepEqual(decodeBoundedBase64Json(encode({ ok: true })), { ok: true });
  assert.equal(decodeBoundedBase64Json('MA=='), 0);
  for (const invalid of ['', 'MA', 'MA=', 'MA===', 'MB==', 'MA==\n', ' MA==', 'eyJ4Ijoi_18ifQ==', '!!!!']) {
    assert.throws(() => decodeBoundedBase64Json(invalid), /Invalid payment header/);
  }
  const exactBoundary = encode('a'.repeat(24_574));
  assert.equal(exactBoundary.length, MAX_PAYMENT_HEADER_BYTES);
  assert.equal((decodeBoundedBase64Json(exactBoundary) as string).length, 24_574);
  assert.throws(() => decodeBoundedBase64Json(`${exactBoundary}AAAA`), /Invalid payment header/);
});

test('malformed UTF-8 and JSON fail without reflecting input', () => {
  for (const bytes of [Buffer.from([0x22, 0xc3, 0x28, 0x22]), Buffer.from('{SECRET_INVALID_JSON'), Buffer.from('')]) {
    assert.throws(() => decodeBoundedBase64Json(bytes.toString('base64')), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /SECRET_INVALID_JSON/);
      return true;
    });
  }
});

test('actual service middleware challenge passes the checker without wallet activity', async t => {
  const facilitator: FacilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: KITE_TESTNET.network }], extensions: [], signers: {} }; },
    async verify() { throw new Error('Unpaid preflight must not verify payment'); },
    async settle() { throw new Error('Unpaid preflight must not settle payment'); },
  };
  const app = express();
  app.use(createPaymentMiddleware({ payTo: RECIPIENT, network: 'testnet', priceUsd: '0.001', resourceUrl: RESOURCE, facilitator }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/memory/audit`, { method: 'POST' });
  assert.equal(response.status, 402);
  const checked = checkPaymentQuote(response.headers.get('payment-required')!, policy());
  assert.equal(checked.requirements.amount, '1000000000000000');
  assert.equal(checked.requirements.maxTimeoutSeconds, 120);
  assert.equal(checked.resourceUrl, RESOURCE);
});
