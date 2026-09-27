import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test, type TestContext } from 'node:test';
import { toEventSelector, toHex } from 'viem';
import { KITE_MAINNET, KITE_TESTNET } from '../src/kite.js';
import { createReceiptRpc, verifyPaymentReceipt, type ReceiptExpectation, type ReceiptRpc } from '../src/payment-receipt.js';

const h = (n: number) => toHex(BigInt(n), { size: 32 });
const payer = '0x1111111111111111111111111111111111111111';
const payTo = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const addressTopic = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const expected: ReceiptExpectation = { network: 'testnet', transaction: h(100), payer, payTo, amount: '1000000000000000', nonce: h(200) };
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const AUTH = toEventSelector('AuthorizationUsed(address,bytes32)');

function fixture() {
  const position = { blockNumber: '0x64', blockHash: h(300), transactionHash: expected.transaction,
    transactionIndex: '0x1', removed: false };
  const receipt = { transactionHash: expected.transaction, transactionIndex: '0x1', blockNumber: '0x64',
    blockHash: h(300), status: '0x1', from: other, to: KITE_TESTNET.assetAddress,
    logs: [
      { ...position, address: KITE_TESTNET.assetAddress, topics: [AUTH, addressTopic(payer), expected.nonce], data: '0x', logIndex: '0x2' },
      { ...position, address: KITE_TESTNET.assetAddress, topics: [TRANSFER, addressTopic(payer), addressTopic(payTo)], data: toHex(BigInt(expected.amount), { size: 32 }), logIndex: '0x3' },
    ],
  };
  const block = { number: '0x64', hash: h(300), transactions: [h(99), expected.transaction] };
  const calls: string[] = [];
  const rpc: ReceiptRpc = async (method, params) => {
    calls.push(method);
    if (method === 'eth_chainId') return '0x940';
    if (method === 'eth_getTransactionReceipt') { assert.deepEqual(params, [expected.transaction]); return receipt; }
    if (method === 'eth_getBlockByNumber') { assert.deepEqual(params, ['0x64', false]); return block; }
    if (method === 'eth_blockNumber') return '0x65';
    throw new Error('Unexpected write or read');
  };
  return { receipt, block, calls, rpc };
}

test('confirms a unique fixed-token Transfer and authorization nonce with two confirmations', async () => {
  const { rpc, calls } = fixture();
  const result = await verifyPaymentReceipt(expected, rpc);
  assert.equal(result.status, 'verified');
  assert.equal(result.code, 'PAYMENT_OBSERVED');
  assert.equal(result.evidence.block?.confirmations, '2');
  assert.equal(result.evidence.transfer?.amount, expected.amount);
  assert.equal(result.evidence.authorization?.nonce, expected.nonce);
  assert.equal(result.evidence.token, KITE_TESTNET.assetAddress.toLowerCase());
  assert.deepEqual(calls, ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber', 'eth_getBlockByNumber']);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.match(result.limitations.join(' '), /do not prove the merchant delivered/);
});

test('mainnet uses its fixed USDC.e token and independent chain identifier', async () => {
  const f = fixture();
  f.receipt.logs.forEach(log => { log.address = KITE_MAINNET.assetAddress; });
  const result = await verifyPaymentReceipt({ ...expected, network: 'mainnet' }, async (method, params) =>
    method === 'eth_chainId' ? '0x93e' : f.rpc(method, params));
  assert.equal(result.status, 'verified');
  assert.equal(result.evidence.chainId, 2366);
});

test('rejects the wrong RPC network before looking up a transaction', async () => {
  const f = fixture();
  const result = await verifyPaymentReceipt(expected, async () => '0x1');
  assert.equal(result.code, 'CHAIN_MISMATCH');
  assert.equal(result.status, 'mismatch');
  assert.equal(f.calls.length, 0);
});

test('missing receipt, unavailable RPC and timeout remain unknown, never inferred payment failure', async () => {
  const f = fixture();
  const missing = await verifyPaymentReceipt(expected, async (method, params) =>
    method === 'eth_getTransactionReceipt' ? null : f.rpc(method, params));
  assert.equal(missing.status, 'unknown'); assert.equal(missing.code, 'RECEIPT_UNAVAILABLE');
  const unavailable = await verifyPaymentReceipt(expected, async () => { throw new Error('https://provider.test/secret-api-key'); });
  assert.equal(unavailable.status, 'unknown');
  assert(!JSON.stringify(unavailable).includes('secret-api-key'));
});

test('wrong recipient, amount and nonce cannot validate the receipt', async () => {
  for (const [change, code] of [
    [{ payTo: other }, 'RECIPIENT_MISMATCH'],
    [{ amount: '1' }, 'AMOUNT_MISMATCH'],
    [{ nonce: h(999) }, 'NONCE_MISMATCH'],
    [{ payer: other }, 'TRANSFER_MISSING'],
  ] as const) {
    const result = await verifyPaymentReceipt({ ...expected, ...change }, fixture().rpc);
    assert.equal(result.status, 'mismatch'); assert.equal(result.code, code);
  }
});

test('matching event payloads from a different token are not accepted', async () => {
  const f = fixture(); f.receipt.logs.forEach(log => { log.address = other; });
  const result = await verifyPaymentReceipt(expected, f.rpc);
  assert.equal(result.code, 'TRANSFER_MISSING'); assert.equal(result.status, 'mismatch');
});

test('a transfer without AuthorizationUsed or with another payer authorization is insufficient', async () => {
  for (const remove of [true, false]) {
    const f = fixture();
    if (remove) f.receipt.logs.shift(); else f.receipt.logs[0]!.topics[1] = addressTopic(other);
    assert.equal((await verifyPaymentReceipt(expected, f.rpc)).code, 'AUTHORIZATION_MISSING');
  }
});

test('multiple payer transfers or authorizations make batch attribution ambiguous', async () => {
  for (const index of [0, 1]) {
    const f = fixture(); const extra = structuredClone(f.receipt.logs[index]!);
    extra.logIndex = '0x4';
    if (index === 0) extra.topics[2] = h(999); else extra.topics[2] = addressTopic(other);
    f.receipt.logs.push(extra);
    const result = await verifyPaymentReceipt(expected, f.rpc);
    assert.equal(result.status, 'mismatch'); assert.equal(result.code, 'AMBIGUOUS_PAYMENT');
  }
});

test('unrelated other-payer or other-token events do not create false attribution', async () => {
  const f = fixture();
  const extra = structuredClone(f.receipt.logs[1]!); extra.logIndex = '0x4'; extra.topics[1] = addressTopic(other);
  f.receipt.logs.push(extra);
  const alien = structuredClone(f.receipt.logs[1]!); alien.logIndex = '0x5'; alien.address = other;
  f.receipt.logs.push(alien);
  assert.equal((await verifyPaymentReceipt(expected, f.rpc)).status, 'verified');
});

test('a confirmed reverted transaction is mismatch, without authorizing retries', async () => {
  const f = fixture(); f.receipt.status = '0x0'; f.receipt.logs = [];
  const result = await verifyPaymentReceipt(expected, f.rpc);
  assert.equal(result.status, 'mismatch'); assert.equal(result.code, 'TRANSACTION_REVERTED');
  assert.match(result.reason, /does not authorize another payment/);
});

test('an unconfirmed receipt and a head behind its block remain unknown', async () => {
  for (const [head, code] of [['0x64', 'INSUFFICIENT_CONFIRMATIONS'], ['0x63', 'INCONSISTENT_CHAIN_HEAD']] as const) {
    const f = fixture();
    const result = await verifyPaymentReceipt(expected, async (method, params) => method === 'eth_blockNumber' ? head : f.rpc(method, params));
    assert.equal(result.status, 'unknown'); assert.equal(result.code, code);
  }
  assert.equal((await verifyPaymentReceipt({ ...expected, minimumConfirmations: 3 }, fixture().rpc)).code, 'INSUFFICIENT_CONFIRMATIONS');
});

test('a receipt is only accepted if its transaction occupies the claimed canonical block position', async () => {
  for (const transactions of [[h(99), h(888)], [expected.transaction, h(99)], [expected.transaction, expected.transaction], [h(99), expected.transaction, h(99)]]) {
    const f = fixture(); f.block.transactions = transactions;
    const result = await verifyPaymentReceipt(expected, f.rpc);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'INVALID_RPC_EVIDENCE');
  }
});

test('initial stale-fork receipt and reorg during confirmation observation remain unknown', async () => {
  for (const changeAt of [1, 2]) {
    const f = fixture(); let blockCalls = 0;
    const result = await verifyPaymentReceipt(expected, async (method, params) => {
      if (method === 'eth_getBlockByNumber' && ++blockCalls === changeAt) return { ...f.block, hash: h(777) };
      return f.rpc(method, params);
    });
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'REORG_DETECTED');
  }
});

test('duplicate or reordered log indices are invalid evidence, not two valid payment observations', async () => {
  for (const index of ['0x2', '0x1']) {
    const f = fixture(); f.receipt.logs[1]!.logIndex = index;
    assert.equal((await verifyPaymentReceipt(expected, f.rpc)).code, 'INVALID_RPC_EVIDENCE');
  }
});

test('wrong transaction/block/log metadata and noncanonical quantities are rejected', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.receipt.transactionHash = h(888); },
    (f: ReturnType<typeof fixture>) => { f.receipt.blockNumber = '0x064'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.status = '0x01'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.transactionHash = h(888); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.blockHash = h(888); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.blockNumber = '0x63'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.transactionIndex = '0x0'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.removed = true; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.receipt, { chainId: '0x1' }); },
    (f: ReturnType<typeof fixture>) => { f.receipt.status = '0x0'; }, // reverted receipts cannot retain logs
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    const result = await verifyPaymentReceipt(expected, f.rpc);
    assert.equal(result.status, 'unknown'); assert.equal(result.code, 'INVALID_RPC_EVIDENCE');
  }
});

test('strict event ABI rejects padded addresses, extra topics/data, and fake short values', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[1]!.topics[1] = `0x${'f'.repeat(24)}${payer.slice(2)}`; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.topics.push(h(888)); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[0]!.data = h(0); },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[1]!.data = '0x01'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[1]!.data += '00'; },
    (f: ReturnType<typeof fixture>) => { f.receipt.logs[1]!.topics[0] = '0x12'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.equal((await verifyPaymentReceipt(expected, f.rpc)).code, 'INVALID_RPC_EVIDENCE');
  }
});

test('invalid expected quantities, zero addresses and confirmation limits cause no RPC calls', async () => {
  for (const change of [{ amount: '0' }, { amount: '01' }, { amount: '-1' }, { amount: '1.5' },
    { amount: (1n << 256n).toString() }, { payer: `0x${'00'.repeat(20)}` }, { transaction: '0x12' },
    { nonce: '0x12' }, { minimumConfirmations: 0 }, { minimumConfirmations: 1.5 }]) {
    const f = fixture();
    assert.equal((await verifyPaymentReceipt({ ...expected, ...change }, f.rpc)).code, 'INVALID_EXPECTATION');
    assert.equal(f.calls.length, 0);
  }
});

async function rpcServer(t: TestContext, reply: (body: Record<string, unknown>) => unknown | Promise<unknown>) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const result = await reply(body);
    response.setHeader('Content-Type', 'application/json');
    response.end(typeof result === 'string' ? result : JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address(); assert(bound && typeof bound !== 'string');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${bound.port}/private-rpc-key`, requests: () => requests };
}

test('HTTP adapter is read-only, validates envelopes and performs no automatic retries', async t => {
  const server = await rpcServer(t, body => ({ jsonrpc: '2.0', id: body.id, result: '0x940' }));
  const rpc = createReceiptRpc(server.url);
  assert.equal(await rpc('eth_chainId', []), '0x940');
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x']), /only permits receipt-verification reads/);
  assert.equal(server.requests(), 1);
});

test('HTTP error bodies, wrong IDs and oversize responses remain private unknown evidence', async t => {
  for (const mode of ['error', 'id', 'size'] as const) {
    const server = await rpcServer(t, body => mode === 'size' ? ' '.repeat(2048)
      : mode === 'id' ? { jsonrpc: '2.0', id: 9999, result: '0x940' }
        : { jsonrpc: '2.0', id: body.id, error: { message: 'secret-api-key' } });
    const result = await verifyPaymentReceipt(expected, createReceiptRpc(server.url, { maxResponseBytes: 1024 }));
    assert.equal(result.status, 'unknown');
    assert(!JSON.stringify(result).includes('secret-api-key'));
    assert(!JSON.stringify(result).includes('private-rpc-key'));
    assert.equal(server.requests(), 1);
  }
});

test('HTTP timeout is bounded and does not retry or report a failed payment', async t => {
  const server = await rpcServer(t, async body => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { jsonrpc: '2.0', id: body.id, result: '0x940' };
  });
  const result = await verifyPaymentReceipt(expected, createReceiptRpc(server.url, { timeoutMs: 10 }));
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'RPC_TIMEOUT');
  assert(server.requests() <= 1);
});

test('RPC URL validation never echoes embedded keys and allows only secure/local transports', () => {
  for (const url of ['secret-api-key', 'http://rpc.example/private-rpc-key', 'https://user:secret-api-key@rpc.example/', 'file:///private-rpc-key']) {
    assert.throws(() => createReceiptRpc(url), error => error instanceof Error && !error.message.includes('secret-api-key') && !error.message.includes('private-rpc-key'));
  }
});
