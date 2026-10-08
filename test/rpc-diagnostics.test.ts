import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, toHex, type Address, type Hex } from 'viem';
import { diagnoseRpcSources, type RpcDiagnosticSource } from '../src/rpc-diagnostics.js';
import { ServiceError } from '../src/errors.js';
import { registryAbi } from '../src/registry-abi.js';
import type { CollectionOptions, RpcTransport } from '../src/rpc.js';
import type { AuditRequest, ExperienceDelta, RegistryConfig } from '../src/types.js';

// Pinned, attributed upstream delta vectors: see test/fixtures/provenance.json.
const vector = JSON.parse(readFileSync(new URL('./fixtures/erc8350-v2.json', import.meta.url), 'utf8')) as {
  space: { controller: Address; authorizer: Address; spaceId: Hex };
  chain: { delta: ExperienceDelta; expected: { transitionId: Hex; nextStateRoot: Hex } }[];
};
const hash = (number: number): Hex => toHex(number, { size: 32 });
const registryAddress: Address = '0x4444444444444444444444444444444444444444';
const code: Hex = '0x6001600055';
const request: AuditRequest = { chainId: 11155111, registry: registryAddress, spaceId: vector.space.spaceId };
const registry: RegistryConfig = { chainId: request.chainId, address: registryAddress, fromBlock: '10',
  expectedCodeHash: keccak256(code), rpcUrl: 'https://rpc.invalid/token?apiKey=PRIVATE',
  label: 'PRIVATE-LABEL', source: 'https://PRIVATE-SOURCE.invalid' };
const last = vector.chain.at(-1)!;
const headData = encodeFunctionData({ abi: registryAbi, functionName: 'head', args: [request.spaceId] });
const head = encodeFunctionResult({ abi: registryAbi, functionName: 'head',
  result: [last.expected.transitionId, last.expected.nextStateRoot, BigInt(last.delta.sequence)] });
const authorization = encodeFunctionResult({ abi: registryAbi, functionName: 'spaceAuthorization',
  result: [vector.space.controller, vector.space.authorizer, 0n] });
type RawLog = { address: Address; blockNumber: Hex; blockHash: Hex; transactionHash: Hex;
  transactionIndex: Hex; logIndex: Hex; removed: boolean; topics: readonly unknown[]; data: Hex };
function logs(): RawLog[] {
  const location = (number: number) => ({ address: registryAddress, blockNumber: toHex(number), blockHash: hash(1_000 + number),
    transactionHash: hash(2_000 + number), transactionIndex: '0x0' as Hex, logIndex: '0x0' as Hex, removed: false });
  return [
    { ...location(10), data: '0x', topics: encodeEventTopics({ abi: registryAbi, eventName: 'SpaceRegistered', args: vector.space }) },
    ...vector.chain.map((entry, index) => ({
      ...location(index + 11),
      topics: encodeEventTopics({ abi: registryAbi, eventName: 'TransitionCommitted', args: {
        spaceId: request.spaceId, transitionId: entry.expected.transitionId, sequence: BigInt(entry.delta.sequence),
      } }),
      data: encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
        { type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }], [entry.delta.prevStateRoot,
        entry.expected.nextStateRoot, entry.delta.deltaCommitment, entry.delta.provenanceCommitment,
        entry.delta.profileId, entry.delta.locatorCommitment, vector.space.authorizer]),
    })),
  ];
}
interface FixtureOptions {
  finalized?: number; chain?: number; events?: RawLog[]; head?: Hex; authorization?: Hex;
  hashOffset?: number; timestamp?: number; uppercase?: boolean; nullFinalized?: boolean;
  changeFinalizedAfterProbe?: boolean;
}
function fixture(id: RpcDiagnosticSource['id'], overrides: FixtureOptions = {}, options: CollectionOptions = {}) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  let finalizedCalls = 0;
  const normal: RpcTransport = async (method, params) => {
    if (method === 'eth_chainId') return toHex(overrides.chain ?? request.chainId);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') {
        finalizedCalls++;
        if (overrides.nullFinalized) return null;
      }
      const number = params[0] === 'finalized' ? overrides.finalized ?? 100 : Number(BigInt(params[0] as string));
      return { number: toHex(number), hash: hash(1_000 + number + (overrides.hashOffset ?? 0)
        + (overrides.changeFinalizedAfterProbe && finalizedCalls >= 2 && number === (overrides.finalized ?? 100) ? 1 : 0)),
      timestamp: toHex(overrides.timestamp ?? 1_700_000_000) };
    }
    if (method === 'eth_getCode') return code;
    if (method === 'eth_call') return (params[0] as { data: string }).data === headData
      ? overrides.head ?? head : overrides.authorization ?? authorization;
    if (method === 'eth_getLogs') {
      const filter = params[0] as { fromBlock: string; toBlock: string };
      return (overrides.events ?? logs()).filter(event => BigInt(event.blockNumber) >= BigInt(filter.fromBlock)
        && BigInt(event.blockNumber) <= BigInt(filter.toBlock));
    }
    throw new Error('Unexpected private provider method');
  };
  const transport: RpcTransport = async (method, params, signal) => {
    calls.push({ method, params });
    const value = await normal(method, params, signal);
    return overrides.uppercase ? JSON.parse(JSON.stringify(value, (_key, part: unknown) =>
      typeof part === 'string' && /^0x[0-9a-fA-F]+$/.test(part) ? `0x${part.slice(2).toUpperCase()}` : part)) : value;
  };
  const source: RpcDiagnosticSource = { id, registry: { ...registry, rpcUrl: `https://${id}.example.invalid/token?apiKey=PRIVATE` },
    options: { transport, ...options } };
  return { source, calls, transport };
}

test('complete sources agree despite event order and hex case, using the lower finalized height', async () => {
  const a = fixture('primary', { finalized: 110 });
  const b = fixture('secondary', { finalized: 100, events: logs().reverse(), uppercase: true });
  const original = structuredClone(request);
  const result = await diagnoseRpcSources(request, [b.source, a.source]);
  assert.equal(result.status, 'agree'); assert.equal(result.code, 'SOURCES_AGREE');
  assert.deepEqual(result.selectedBlock, { number: '100' });
  assert.deepEqual(result.request, original); assert.equal(result.request.atBlock, undefined);
  assert(result.comparison.performed); assert.deepEqual(result.comparison.differences, []);
  assert.deepEqual(result.sources.map(source => source.id), ['primary', 'secondary']);
  for (const [index, f] of [a, b].entries()) {
    const source = result.sources[index]!;
    assert.equal(source.report?.verdict, 'consistent'); assert.equal(source.report.evidence.events.length, 6);
    assert.equal(source.requestCount, f.calls.length);
    const pinned = f.calls.filter(call => call.method === 'eth_call' || call.method === 'eth_getCode');
    assert(pinned.every(call => (call.params[1] as { blockHash: string }).blockHash.toLowerCase() === hash(1_100)));
    assert(!JSON.stringify(f.calls).includes('latest'));
  }
});

test('an explicitly requested finalized height is retained instead of substituted', async () => {
  const a = fixture('primary'), b = fixture('secondary', { finalized: 99 });
  const result = await diagnoseRpcSources({ ...request, atBlock: '90' }, [a.source, b.source]);
  assert.equal(result.status, 'agree'); assert.equal(result.selectedBlock?.number, '90');
  assert.equal(result.request.atBlock, '90');
  assert(result.sources.every(source => source.report?.evidence.block.number === '90'));
});

test('one empty log source is divergent without merging or selecting the complete source', async () => {
  for (const empty of ['primary', 'secondary'] as const) {
    const a = fixture('primary', { events: empty === 'primary' ? [] : logs() });
    const b = fixture('secondary', { events: empty === 'secondary' ? [] : logs() });
    const result = await diagnoseRpcSources(request, [a.source, b.source]);
    assert.equal(result.status, 'divergent');
    assert.equal(result.comparison[empty === 'primary' ? 'missingFromPrimary' : 'missingFromSecondary'].length, 6);
    const missing = result.sources.find(source => source.id === empty)!;
    assert.equal(missing.report?.evidence.events.length, 0);
    assert.equal(missing.report.verdict, 'inconclusive');
    assert.equal(missing.report.evidence.head.sequence, '5');
  }
});

test('both empty log sources with head five are inconclusive, not agreed complete', async () => {
  const a = fixture('primary', { events: [] }), b = fixture('secondary', { events: [] });
  const result = await diagnoseRpcSources(request, [a.source, b.source]);
  assert.equal(result.status, 'inconclusive'); assert.equal(result.code, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(result.comparison.differences, []);
  assert(result.sources.every(source => source.report?.verdict === 'inconclusive'));
});

test('identical incomplete interior history also remains inconclusive', async () => {
  const incomplete = logs(); incomplete.splice(2, 1);
  const result = await diagnoseRpcSources(request, [fixture('primary', { events: incomplete }).source,
    fixture('secondary', { events: incomplete }).source]);
  assert.equal(result.status, 'inconclusive');
});

test('changed payload at one location is separate from a missing event', async () => {
  const changed = logs(); changed[2]!.transactionHash = hash(9_999);
  const result = await diagnoseRpcSources(request, [fixture('primary').source, fixture('secondary', { events: changed }).source]);
  assert.equal(result.status, 'divergent');
  assert.deepEqual(result.comparison.differences, ['changedEvents']);
  assert.equal(result.comparison.changedEvents.length, 1);
  assert.equal(result.comparison.changedEvents[0]?.blockNumber, '12');
  assert.equal(result.comparison.missingFromPrimary.length, 0);
  assert.equal(result.comparison.missingFromSecondary.length, 0);
});

test('different snapshot hashes or timestamps are divergent even with empty histories', async () => {
  for (const change of [{ hashOffset: 1 }, { timestamp: 1_700_000_001 }]) {
    const result = await diagnoseRpcSources(request, [fixture('primary', { events: [] }).source,
      fixture('secondary', { events: [], ...change }).source]);
    assert.equal(result.status, 'divergent'); assert(result.comparison.differences.includes('block'));
  }
});

test('head and authorization disagreements are identified independently', async () => {
  const changedHead = encodeFunctionResult({ abi: registryAbi, functionName: 'head',
    result: [hash(8), hash(9), 5n] });
  const changedAuthorization = encodeFunctionResult({ abi: registryAbi, functionName: 'spaceAuthorization',
    result: [vector.space.controller, registryAddress, 0n] });
  for (const [change, field] of [[{ head: changedHead }, 'head'], [{ authorization: changedAuthorization }, 'authorization']] as const) {
    const result = await diagnoseRpcSources(request, [fixture('primary').source, fixture('secondary', change).source]);
    assert.equal(result.status, 'divergent'); assert(result.comparison.differences.includes(field));
  }
});

test('identical conclusively inconsistent evidence is source agreement, not endorsement of history', async () => {
  const incorrectHead = encodeFunctionResult({ abi: registryAbi, functionName: 'head', result: [hash(8), hash(9), 5n] });
  const result = await diagnoseRpcSources(request, [fixture('primary', { head: incorrectHead }).source,
    fixture('secondary', { head: incorrectHead }).source]);
  assert.equal(result.status, 'agree');
  assert(result.sources.every(source => source.report?.verdict === 'inconsistent'));
  assert(result.limitations.some(text => text.includes('not a correct history')));
});

test('wrong chain or unavailable finalized tag stops collection with no latest fallback', async () => {
  for (const [override, expected] of [[{ chain: 1 }, 'RPC_CHAIN_MISMATCH'], [{ nullFinalized: true }, 'FINALITY_UNAVAILABLE']] as const) {
    const a = fixture('primary'), b = fixture('secondary', override);
    const result = await diagnoseRpcSources(request, [a.source, b.source]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.sources[1].code, expected);
    assert.equal(result.comparison.performed, false);
    assert(![...a.calls, ...b.calls].some(call => call.method === 'eth_getLogs'));
    assert(!JSON.stringify([...a.calls, ...b.calls]).includes('latest'));
  }
});

test('unfinalized requested block and predeployment common block fail before collection', async () => {
  const a = fixture('primary'), b = fixture('secondary', { finalized: 99 });
  const result = await diagnoseRpcSources({ ...request, atBlock: '100' }, [a.source, b.source]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sources[1].code, 'BLOCK_NOT_FINALIZED');
  assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 2);
  const early = await diagnoseRpcSources(request, [fixture('primary', { finalized: 9 }).source, fixture('secondary').source]);
  assert.equal(early.status, 'unavailable'); assert.equal(early.sources[0].code, 'BLOCK_BEFORE_REGISTRY');
});

test('probe-to-collection block change is detected rather than silently repinning', async () => {
  const result = await diagnoseRpcSources(request, [fixture('primary', { changeFinalizedAfterProbe: true }).source,
    fixture('secondary').source]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sources[0].code, 'REORG_DETECTED');
  assert.equal(result.sources[0].report, undefined); assert(result.sources[1].report);
});

test('source failures retain a successful peer report but never promote it to overall success', async () => {
  const a = fixture('primary'), b = fixture('secondary');
  b.source.options!.transport = async (method, params, signal) => {
    if (method === 'eth_getLogs') throw new ServiceError('PRIVATE_ERROR_CODE', 'https://credential:SECRET@rpc.invalid');
    return b.transport(method, params, signal);
  };
  const result = await diagnoseRpcSources(request, [a.source, b.source]);
  assert.equal(result.status, 'unavailable'); assert(result.sources[0].report);
  assert.equal(result.sources[1].code, 'RPC_UNAVAILABLE'); assert.equal(result.comparison.performed, false);
  assert(!JSON.stringify(result).includes('PRIVATE')); assert(!JSON.stringify(result).includes('SECRET'));
});

test('query budgets include both preprobes and collector requests and do not count rejected dispatches', async () => {
  for (const maxRequests of [1, 2, 3]) {
    const a = fixture('primary', {}, { maxRequests }), b = fixture('secondary');
    const result = await diagnoseRpcSources(request, [a.source, b.source]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.sources[0].code, 'EVIDENCE_LIMIT');
    assert.equal(result.sources[0].requestCount, maxRequests); assert.equal(a.calls.length, maxRequests);
  }
});

test('noncooperative injected transport times out even when it ignores the abort signal', async () => {
  const a = fixture('primary', {}, { requestTimeoutMs: 15, totalTimeoutMs: 100 });
  a.source.options!.transport = async () => new Promise<never>(() => {});
  const started = Date.now();
  const result = await diagnoseRpcSources(request, [a.source, fixture('secondary').source]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sources[0].code, 'RPC_TIMEOUT');
  assert.equal(result.sources[0].requestCount, 1); assert(Date.now() - started < 1_000);
});

test('global deadline includes probing and waiting for the slower peer before collection', async () => {
  const a = fixture('primary', {}, { totalTimeoutMs: 10, requestTimeoutMs: 100 });
  const b = fixture('secondary', {}, { totalTimeoutMs: 200, requestTimeoutMs: 100 });
  b.source.options!.transport = async (method, params, signal) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return b.transport(method, params, signal);
  };
  const result = await diagnoseRpcSources(request, [a.source, b.source]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sources[0].code, 'RPC_TIMEOUT');
  assert.equal(result.sources[0].requestCount, 2);
  assert.equal(a.calls.length, 2);
});

test('a final RPC result arriving after the total deadline cannot publish a report before timer dispatch', async t => {
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const a = fixture('primary', {}, { totalTimeoutMs: 1_000, requestTimeoutMs: 1_000 });
  const b = fixture('secondary', {}, { totalTimeoutMs: 1_000, requestTimeoutMs: 1_000 });
  a.source.options!.transport = async (method, params, signal) => {
    const value = await a.transport(method, params, signal);
    // All evidence has been returned. Simulate a late final response while the
    // JS event loop has not yet dispatched the total-budget timer callback.
    if (method === 'eth_getBlockByNumber' && params[0] === '0x64') clock = 1_001;
    return value;
  };
  const result = await diagnoseRpcSources(request, [a.source, b.source]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.sources[0].code, 'RPC_TIMEOUT');
  assert.equal(result.sources[0].report, undefined);
  assert.equal(result.sources[0].requestCount, a.calls.length);
  assert.equal(result.comparison.performed, false);
  assert.equal(a.calls.at(-1)?.method, 'eth_getBlockByNumber');
  assert.equal(a.calls.at(-1)?.params[0], '0x64');
});

test('configuration, policy and subject mismatches fail generically before any network call', async () => {
  for (const mutate of [
    (source: RpcDiagnosticSource) => { source.registry.fromBlock = '11'; },
    (source: RpcDiagnosticSource) => { source.registry.expectedCodeHash = hash(9); },
    (source: RpcDiagnosticSource) => { source.registry.address = vector.space.authorizer; },
    (source: RpcDiagnosticSource) => { source.registry.chainId = 1; },
    (source: RpcDiagnosticSource) => { source.id = 'primary'; },
    (source: RpcDiagnosticSource) => { source.registry.rpcUrl = 'file:///PRIVATE'; },
    (source: RpcDiagnosticSource) => { source.options!.maxRequests = 0; },
  ]) {
    const a = fixture('primary'), b = fixture('secondary'); mutate(b.source);
    await assert.rejects(diagnoseRpcSources(request, [a.source, b.source]), { message: 'Invalid diagnostic request or source configuration.' });
    assert.equal(a.calls.length, 0); assert.equal(b.calls.length, 0);
  }
  const a = fixture('primary'), b = fixture('secondary');
  await assert.rejects(diagnoseRpcSources({ ...request, privateKey: 'PRIVATE' }, [a.source, b.source]),
    { message: 'Invalid diagnostic request or source configuration.' });
  assert.equal(a.calls.length + b.calls.length, 0);
});

test('provider credentials, labels and arbitrary provenance text never enter diagnostic reports', async () => {
  const result = await diagnoseRpcSources(request, [fixture('primary').source, fixture('secondary').source]);
  const text = JSON.stringify(result);
  assert(!/PRIVATE|secret|rpc\.invalid|user:/.test(text));
  assert.deepEqual(result.sources.map(source => source.report!.evidence.rpcLabel), ['primary', 'secondary']);
  assert(result.sources.every(source => !source.report!.evidence.registryEvidence.source.includes('https:')));
});

test('HTTP loopback, basic credentials, fragments and query-only endpoint differences are rejected before network', async () => {
  for (const url of ['http://127.0.0.1:3000', 'https://user:SECRET@secondary.example.invalid/',
    'https://secondary.example.invalid/#SECRET', 'https://primary.example.invalid/token?another=SECRET']) {
    const a = fixture('primary'), b = fixture('secondary'); b.source.registry.rpcUrl = url;
    await assert.rejects(diagnoseRpcSources(request, [a.source, b.source]),
      { message: 'Invalid diagnostic request or source configuration.' });
    assert.equal(a.calls.length + b.calls.length, 0);
  }
});

test('external callback mutation cannot change snapshotted request, source policies, limits or transports', async () => {
  const a = fixture('primary'), b = fixture('secondary'); const input = structuredClone(request);
  let changed = false;
  a.source.options!.transport = async (method, params, signal) => {
    if (!changed) {
      changed = true;
      input.chainId = 1; input.spaceId = hash(999);
      a.source.registry.fromBlock = '99'; b.source.registry.address = vector.space.authorizer;
      b.source.options!.maxRequests = 1;
      b.source.options!.transport = async () => { throw new Error('Must not use changed transport'); };
    }
    return a.transport(method, params, signal);
  };
  const result = await diagnoseRpcSources(input, [a.source, b.source]);
  assert.equal(result.status, 'agree');
  assert.equal(result.request.chainId, request.chainId);
  assert.equal(result.request.spaceId, request.spaceId);
  assert(result.sources.every(source => source.report?.evidence.registryEvidence.fromBlock === '10'));
  assert(result.sources.every(source => source.report?.evidence.registry === registryAddress));
});

test('malformed probe quantities and hashes are rejected without arbitrary error contents', async () => {
  for (const bad of [null, { number: '0x01', hash: hash(100), timestamp: '0x1' },
    { number: '0x10000000000000000', hash: hash(100), timestamp: '0x1' },
    { number: '0x64', hash: 'PRIVATE', timestamp: '0x1' }]) {
    const a = fixture('primary');
    a.source.options!.transport = async (method, params, signal) => method === 'eth_getBlockByNumber'
      ? bad : a.transport(method, params, signal);
    const result = await diagnoseRpcSources(request, [a.source, fixture('secondary').source]);
    assert.equal(result.status, 'unavailable'); assert(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('duplicate logs and a changed historical block are rejected rather than compared as valid sources', async () => {
  const duplicated = logs(); duplicated.push(structuredClone(duplicated[0]!));
  const result = await diagnoseRpcSources(request, [fixture('primary', { events: duplicated }).source, fixture('secondary').source]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.sources[0].code, 'RPC_INVALID_RESPONSE');
  const stale = await diagnoseRpcSources(request, [fixture('primary', { hashOffset: 1 }).source, fixture('secondary').source]);
  assert.equal(stale.status, 'unavailable'); assert.equal(stale.sources[0].code, 'REORG_DETECTED');
});
