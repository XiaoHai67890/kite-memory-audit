import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult,
  keccak256, toFunctionSelector, toHex, type Hex,
} from 'viem';
import { ServiceError } from '../src/errors.js';
import { collectEvidence, type RpcTransport } from '../src/rpc.js';
import { registryAbi, registryEventTopics } from '../src/registry-abi.js';
import type { AuditRequest, RegistryConfig } from '../src/types.js';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const address = '0x1111111111111111111111111111111111111111';
const controller = '0x2222222222222222222222222222222222222222';
const authorizer = '0x3333333333333333333333333333333333333333';
const code: Hex = '0x6001600055';
const request: AuditRequest = { chainId: 11155111, registry: address, spaceId: h(1) };
const config: RegistryConfig = {
  chainId: 11155111, address, fromBlock: '1', expectedCodeHash: keccak256(code),
  rpcUrl: 'https://secret-rpc.invalid/key-do-not-leak', label: 'test RPC', source: 'test fixture',
};
const head = encodeFunctionResult({ abi: registryAbi, functionName: 'head', result: [h(10), h(11), 1n] });
const authorization = encodeFunctionResult({ abi: registryAbi, functionName: 'spaceAuthorization', result: [controller, authorizer, 1n] });
const headData = encodeFunctionData({ abi: registryAbi, functionName: 'head', args: [request.spaceId] });

function eventPosition(n: number, logIndex = 0) {
  return { address, blockNumber: toHex(n), blockHash: h(100 + n), transactionHash: h(200 + n), transactionIndex: '0x0', logIndex: toHex(logIndex), removed: false };
}
function eventFixtures() {
  return [
    { ...eventPosition(1), data: '0x', topics: encodeEventTopics({ abi: registryAbi, eventName: 'SpaceRegistered', args: { spaceId: request.spaceId, controller, authorizer } }) },
    { ...eventPosition(2), data: encodeAbiParameters([{ type: 'uint64' }], [1n]), topics: encodeEventTopics({ abi: registryAbi, eventName: 'SpaceAuthorizationUpdated', args: { spaceId: request.spaceId, controller, authorizer } }) },
    { ...eventPosition(3), topics: encodeEventTopics({ abi: registryAbi, eventName: 'TransitionCommitted', args: { spaceId: request.spaceId, transitionId: h(10), sequence: 1n } }), data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [h(0), h(11), h(12), h(13), h(14), h(15), authorizer]) },
  ];
}

type Call = { method: string; params: readonly unknown[] };
function fixture(overrides: { logs?: unknown[]; chainId?: string; code?: string; reorg?: boolean; head?: string; authorization?: string; finalized?: unknown } = {}) {
  const calls: Call[] = [];
  const transport: RpcTransport = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return overrides.chainId ?? toHex(config.chainId);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized' && Object.hasOwn(overrides, 'finalized')) return overrides.finalized;
      const n = params[0] === 'finalized' ? 4 : Number(BigInt(params[0] as string));
      return { number: toHex(n), hash: overrides.reorg && params[0] !== 'finalized' ? h(999) : h(100 + n), timestamp: '0x1234' };
    }
    if (method === 'eth_getCode') return overrides.code ?? code;
    if (method === 'eth_call') return (params[0] as { data: string }).data === headData ? overrides.head ?? head : overrides.authorization ?? authorization;
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: Hex; toBlock: Hex };
      return overrides.logs ?? eventFixtures().filter(log => BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock)).reverse();
    }
    throw new Error(`Unexpected method: ${method}`);
  };
  return { transport, calls };
}
function errorCode(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes('secret-rpc') && !error.message.includes('key-do-not-leak'));
    return true;
  };
}

test('collects three event types in canonical order, pages logs and pins reads to finalized block hash', async () => {
  const { transport, calls } = fixture();
  const result = await collectEvidence(request, config, { transport, pageSizeBlocks: 2 });
  assert.equal(result.block.number, '4');
  assert.equal(result.block.hash, h(104));
  assert.equal(result.registryEvidence.actualCodeHash, keccak256(code));
  assert.equal(result.head.sequence, '1');
  assert.deepEqual(result.events.map(event => event.type), ['registered', 'authorization', 'transition']);
  const transition = result.events[2]!;
  assert.equal(transition.type === 'transition' && transition.delta.sequence, '1');
  const logCalls = calls.filter(call => call.method === 'eth_getLogs');
  assert.deepEqual(logCalls.map(call => call.params[0]), [
    { address, fromBlock: '0x1', toBlock: '0x2', topics: [registryEventTopics, request.spaceId] },
    { address, fromBlock: '0x3', toBlock: '0x4', topics: [registryEventTopics, request.spaceId] },
  ]);
  for (const call of calls.filter(call => call.method === 'eth_call' || call.method === 'eth_getCode')) {
    assert.deepEqual(call.params[1], { blockHash: h(104), requireCanonical: true });
  }
  assert.deepEqual(calls.at(-1), { method: 'eth_getBlockByNumber', params: ['0x4', false] });
  assert.ok(!JSON.stringify(result).includes(config.rpcUrl));
});

test('refuses non-allowlisted subject before any network request', async () => {
  const { transport, calls } = fixture();
  await assert.rejects(collectEvidence({ ...request, chainId: 1 }, config, { transport }), errorCode('REGISTRY_NOT_ALLOWED'));
  await assert.rejects(collectEvidence({ ...request, registry: controller }, config, { transport }), errorCode('REGISTRY_NOT_ALLOWED'));
  assert.equal(calls.length, 0);
});

test('verifies live chain and exact deployed code', async () => {
  await assert.rejects(collectEvidence(request, config, fixture({ chainId: '0x1' })), errorCode('RPC_CHAIN_MISMATCH'));
  await assert.rejects(collectEvidence(request, config, fixture({ code: '0x' })), errorCode('REGISTRY_NO_CODE'));
  await assert.rejects(collectEvidence(request, config, fixture({ code: '0x6002' })), errorCode('REGISTRY_CODE_MISMATCH'));
});

test('never silently substitutes latest for unsupported finalized', async () => {
  const { transport, calls } = fixture({ finalized: null });
  await assert.rejects(collectEvidence(request, config, { transport }), errorCode('FINALITY_UNAVAILABLE'));
  assert.ok(!JSON.stringify(calls).includes('latest'));
});

test('rejects unfinalized or predeployment block and supports explicit historical block', async () => {
  await assert.rejects(collectEvidence({ ...request, atBlock: '5' }, config, fixture()), errorCode('BLOCK_NOT_FINALIZED'));
  await assert.rejects(collectEvidence({ ...request, atBlock: '0' }, config, fixture()), errorCode('BLOCK_BEFORE_REGISTRY'));
  const result = await collectEvidence({ ...request, atBlock: '2' }, config, fixture());
  assert.equal(result.block.number, '2');
  assert.equal(result.events.length, 2);
});

test('detects a changed pinned block instead of returning mixed evidence', async () => {
  const normal = fixture();
  const transport: RpcTransport = async (method, params, signal) => {
    const result = await normal.transport(method, params, signal);
    if (method === 'eth_getBlockByNumber' && params[0] === '0x4') return { ...(result as object), hash: h(999) };
    return result;
  };
  await assert.rejects(collectEvidence(request, config, { transport }), errorCode('REORG_DETECTED'));
});

test('rejects stale-fork historical logs even if the finalized pin remains stable', async () => {
  const logs = eventFixtures();
  logs[0]!.blockHash = h(999);
  await assert.rejects(collectEvidence(request, config, fixture({ logs })), errorCode('REORG_DETECTED'));
});

test('checks every unique historical event block against its canonical header', async () => {
  const { transport, calls } = fixture();
  await collectEvidence(request, config, { transport });
  assert.deepEqual(calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params[0]).sort(), ['0x1', '0x2', '0x3', '0x4', 'finalized']);
});

test('rejects wrong subject, topic, bounds, removed logs, duplicates and malformed ABI', async t => {
  const registration = eventFixtures()[0]!;
  const cases: [string, unknown[]][] = [
    ['address', [{ ...registration, address: controller }]],
    ['space', [{ ...registration, topics: [registration.topics[0], h(999), ...registration.topics.slice(2)] }]],
    ['topic', [{ ...registration, topics: [h(999), ...registration.topics.slice(1)] }]],
    ['bounds', [{ ...registration, blockNumber: '0x5' }]],
    ['removed', [{ ...registration, removed: true }]],
    ['duplicate', [registration, registration]],
    ['trailing data', [{ ...registration, data: h(0) }]],
    ['malformed topic', [{ ...registration, topics: ['0x', ...registration.topics.slice(1)] }]],
    ['noncanonical address padding', [{ ...registration, topics: [registration.topics[0], registration.topics[1], `0x${'f'.repeat(24)}${controller.slice(2)}`, registration.topics[3]] }]],
    ['uint64 overflow', [{ ...eventFixtures()[1], data: h(1).slice(0, -17) + '20000000000000000' }]],
  ];
  for (const [name, logs] of cases) await t.test(name, async () => {
    await assert.rejects(collectEvidence(request, config, fixture({ logs })), errorCode('RPC_INVALID_RESPONSE'));
  });
});

test('fails closed on query budget, event limit, and malformed call responses', async () => {
  await assert.rejects(collectEvidence(request, config, { ...fixture(), maxRequests: 6, pageSizeBlocks: 1 }), errorCode('EVIDENCE_LIMIT'));
  await assert.rejects(collectEvidence(request, config, { ...fixture(), maxLogs: 2 }), errorCode('EVIDENCE_LIMIT'));
  await assert.rejects(collectEvidence(request, config, fixture({ head: '0x' })), errorCode('RPC_INVALID_RESPONSE'));
  await assert.rejects(collectEvidence(request, config, fixture({ authorization: '0x' })), errorCode('RPC_INVALID_RESPONSE'));
});

test('timeouts also bound an injected transport that ignores abort', async () => {
  let signal: AbortSignal | undefined;
  const transport: RpcTransport = async (_method, _params, s) => { signal = s; return new Promise(() => {}); };
  await assert.rejects(collectEvidence(request, config, { transport, requestTimeoutMs: 10 }), errorCode('RPC_TIMEOUT'));
  assert.equal(signal?.aborted, true);
});

test('sanitizes transport errors', async () => {
  await assert.rejects(collectEvidence(request, config, { transport: async () => { throw new Error(config.rpcUrl); } }), errorCode('RPC_UNAVAILABLE'));
});

test('maps the registry UnknownSpace revert and bounds HTTP response size', async () => {
  let mode: 'unknown' | 'oversize' = 'unknown';
  const normal = fixture().transport;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params: unknown[] };
    res.setHeader('content-type', 'application/json');
    if (mode === 'oversize') { res.end(' '.repeat(2048)); return; }
    if (body.method === 'eth_call') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: config.rpcUrl, data: toFunctionSelector('UnknownSpace()') } }));
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: await normal(body.method, body.params, new AbortController().signal) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  assert.ok(bound && typeof bound !== 'string');
  try {
    const localConfig = { ...config, rpcUrl: `http://127.0.0.1:${bound.port}` };
    await assert.rejects(collectEvidence(request, localConfig), errorCode('UNKNOWN_SPACE'));
    mode = 'oversize';
    await assert.rejects(collectEvidence(request, localConfig, { maxResponseBytes: 1024 }), errorCode('EVIDENCE_LIMIT'));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
