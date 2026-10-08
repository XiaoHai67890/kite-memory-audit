import { type Hex } from 'viem';
import { auditHistory } from './audit.js';
import { ServiceError } from './errors.js';
import { collectEvidence, createRpcTransport, defaultCollectionLimits, type CollectionOptions, type RpcTransport } from './rpc.js';
import { parseAuditReport, reportPolicySchema } from './report-verifier.js';
import { parseAuditRequest } from './validation.js';
import type { AuditEvent, AuditReport, AuditRequest, EventPosition, RegistryConfig } from './types.js';

export interface RpcDiagnosticSource {
  id: 'primary' | 'secondary';
  registry: RegistryConfig;
  options?: CollectionOptions;
}
export interface DiagnosticBlock { number: string; hash: Hex; timestamp: string }
export interface RpcDiagnosticSourceResult {
  id: RpcDiagnosticSource['id'];
  code: string;
  requestCount: number;
  finalizedBlock?: DiagnosticBlock;
  report?: AuditReport;
}
export interface RpcDiagnosticsResult {
  schemaVersion: '1';
  status: 'agree' | 'divergent' | 'inconclusive' | 'unavailable';
  code: string;
  request: AuditRequest;
  selectedBlock?: { number: string };
  sources: [RpcDiagnosticSourceResult, RpcDiagnosticSourceResult];
  comparison: {
    performed: boolean;
    differences: string[];
    missingFromPrimary: EventPosition[];
    missingFromSecondary: EventPosition[];
    changedEvents: EventPosition[];
  };
  limitations: string[];
}

const safeSource = 'Independent local registry policy; provider URLs and labels are omitted.';
const limitations = [
  'This compares two RPC observations at one selected finalized height. Agreement is not proof of on-chain truth, consensus, finality, or complete event history; providers may share infrastructure or omit the same data.',
  'Agree describes source agreement, not a correct history. Inspect each report verdict and checks: both sources can agree on inconsistent evidence.',
  'Each source is collected and replayed separately. Events are never merged, missing evidence is never filled from another source, and no winning provider is selected.',
  'Finalized tags, block headers and runtime code are RPC claims. Memory truth, historical code identity, signatures, payment settlement and hosted service availability are not verified.',
];
const allowedCodes = new Set([
  'RPC_CHAIN_MISMATCH', 'RPC_INVALID_RESPONSE', 'RPC_UNAVAILABLE', 'RPC_TIMEOUT', 'EVIDENCE_LIMIT',
  'UNKNOWN_SPACE', 'BLOCK_UNAVAILABLE', 'FINALITY_UNAVAILABLE', 'BLOCK_NOT_FINALIZED',
  'BLOCK_BEFORE_REGISTRY', 'REGISTRY_NO_CODE', 'REGISTRY_CODE_MISMATCH', 'REORG_DETECTED',
]);
const errorCode = (error: unknown): string => error instanceof ServiceError && allowedCodes.has(error.code)
  ? error.code : 'RPC_UNAVAILABLE';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const failure = (code: string): ServiceError => new ServiceError(code, 'Diagnostic evidence is unavailable.');
const maxUint64 = (1n << 64n) - 1n;

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/.test(value)) throw failure('RPC_INVALID_RESPONSE');
  const number = BigInt(value);
  if (number > maxUint64) throw failure('RPC_INVALID_RESPONSE');
  return number;
}
function finalizedBlock(value: unknown): DiagnosticBlock {
  if (value === null) throw failure('FINALITY_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('RPC_INVALID_RESPONSE');
  const raw = value as Record<string, unknown>;
  if (typeof raw.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash)) throw failure('RPC_INVALID_RESPONSE');
  return { number: quantity(raw.number).toString(), hash: raw.hash.toLowerCase() as Hex,
    timestamp: quantity(raw.timestamp).toString() };
}

type Prepared = { registry: RegistryConfig; options: CollectionOptions; output: RpcDiagnosticSourceResult; transport: RpcTransport };

// viem's event selector lookup is case sensitive. Canonicalize only known RPC
// hex fields before handing the unchanged strict collector the same values.
function normalizeRpcHex(method: string, value: unknown, maxLogs: number): unknown {
  const hex = (part: unknown) => typeof part === 'string' && /^0x[0-9a-fA-F]*$/.test(part) ? part.toLowerCase() : part;
  if (method === 'eth_getLogs' && Array.isArray(value)) {
    if (value.length > maxLogs) throw failure('EVIDENCE_LIMIT');
    return value.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const log = raw as Record<string, unknown>;
      return { ...log, address: hex(log.address), blockNumber: hex(log.blockNumber), blockHash: hex(log.blockHash),
        transactionHash: hex(log.transactionHash), transactionIndex: hex(log.transactionIndex), logIndex: hex(log.logIndex),
        data: hex(log.data), topics: Array.isArray(log.topics) ? log.topics.map(hex) : log.topics };
    });
  }
  if (method === 'eth_getBlockByNumber' && value && typeof value === 'object' && !Array.isArray(value)) {
    const block = value as Record<string, unknown>;
    return { ...block, number: hex(block.number), hash: hex(block.hash), timestamp: hex(block.timestamp) };
  }
  return hex(value);
}

/** Covers both preliminary probes and all collector calls, including a noncooperative injected transport. */
function boundedTransport(source: RpcDiagnosticSource, output: RpcDiagnosticSourceResult, startedAt: number): RpcTransport {
  const limits = { ...defaultCollectionLimits, ...source.options };
  const underlying = source.options?.transport ?? createRpcTransport(source.registry.rpcUrl, limits.maxResponseBytes);
  return async (method, params, parentSignal) => {
    if (output.requestCount >= limits.maxRequests) throw failure('EVIDENCE_LIMIT');
    const remaining = limits.totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0 || parentSignal.aborted) throw failure('RPC_TIMEOUT');
    output.requestCount++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => underlying(method, params, controller.signal)),
        new Promise<never>((_resolve, reject) => {
          abort = () => { controller.abort(); reject(failure('RPC_TIMEOUT')); };
          parentSignal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(abort, Math.min(limits.requestTimeoutMs, remaining));
        }),
      ]);
      const normalized = normalizeRpcHex(method, value, limits.maxLogs);
      // A resolved promise can run before an expired timer gets its turn.
      if (Date.now() - startedAt >= limits.totalTimeoutMs) throw failure('RPC_TIMEOUT');
      return normalized;
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) parentSignal.removeEventListener('abort', abort);
    }
  };
}

function prepare(request: AuditRequest, sources: readonly [RpcDiagnosticSource, RpcDiagnosticSource], startedAt: number): [Prepared, Prepared] {
  if (!Array.isArray(sources) || sources.length !== 2
    || new Set(sources.map(source => source.id)).size !== 2
    || sources.some(source => source.id !== 'primary' && source.id !== 'secondary')) throw new Error('Invalid sources.');
  let expectedPolicy: string | undefined;
  const endpointPaths = new Set<string>();
  const prepared = [...sources].sort((a, b) => a.id === b.id ? 0 : a.id === 'primary' ? -1 : 1).map(source => {
    const policy = reportPolicySchema.parse({ chainId: source.registry.chainId, registry: source.registry.address,
      fromBlock: source.registry.fromBlock, expectedCodeHash: source.registry.expectedCodeHash });
    if (policy.chainId !== request.chainId || !same(policy.registry, request.registry)) throw new Error('Invalid policy.');
    const serialized = JSON.stringify(policy);
    if (expectedPolicy !== undefined && serialized !== expectedPolicy) throw new Error('Different registry policies.');
    expectedPolicy = serialized;
    const url = new URL(source.registry.rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid RPC URL.');
    const endpointPath = `${url.host}${url.pathname}`;
    if (endpointPaths.has(endpointPath)) throw new Error('Duplicate RPC endpoint.');
    endpointPaths.add(endpointPath);
    const options = { ...source.options };
    if (Object.keys(options).some(key => key !== 'transport' && !Object.hasOwn(defaultCollectionLimits, key))) throw new Error('Invalid options.');
    const limits = { ...defaultCollectionLimits, ...options };
    for (const key of Object.keys(defaultCollectionLimits) as (keyof typeof defaultCollectionLimits)[]) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new Error('Invalid limit.');
    }
    if (options.transport !== undefined && typeof options.transport !== 'function') throw new Error('Invalid transport.');
    const registry: RegistryConfig = Object.freeze({ chainId: policy.chainId, address: policy.registry, fromBlock: policy.fromBlock,
      expectedCodeHash: policy.expectedCodeHash, rpcUrl: url.href, label: source.id, source: safeSource });
    Object.freeze(options);
    const output: RpcDiagnosticSourceResult = { id: source.id, code: 'NOT_COLLECTED', requestCount: 0 };
    return { registry, options, output, transport: boundedTransport({ id: source.id, registry, options }, output, startedAt) };
  });
  return prepared as [Prepared, Prepared];
}

function position(event: AuditEvent): EventPosition {
  return { blockNumber: event.blockNumber, blockHash: event.blockHash, transactionHash: event.transactionHash,
    transactionIndex: event.transactionIndex, logIndex: event.logIndex };
}
function compare(primary: AuditReport, secondary: AuditReport): RpcDiagnosticsResult['comparison'] {
  const a = primary.evidence, b = secondary.evidence;
  const result: RpcDiagnosticsResult['comparison'] = { performed: true, differences: [],
    missingFromPrimary: [], missingFromSecondary: [], changedEvents: [] };
  const fields = {
    block: [a.block, b.block], head: [a.head, b.head], authorization: [a.authorization, b.authorization],
    registryPolicy: [a.registryEvidence, b.registryEvidence],
  };
  for (const [field, [left, right]] of Object.entries(fields)) {
    if (JSON.stringify(left) !== JSON.stringify(right)) result.differences.push(field);
  }
  const key = (event: AuditEvent) => `${event.blockNumber}:${event.logIndex}`;
  const left = new Map(a.events.map(event => [key(event), event]));
  const right = new Map(b.events.map(event => [key(event), event]));
  for (const [location, event] of left) {
    const other = right.get(location);
    if (!other) result.missingFromSecondary.push(position(event));
    else if (JSON.stringify(event) !== JSON.stringify(other)) result.changedEvents.push(position(event));
  }
  for (const [location, event] of right) if (!left.has(location)) result.missingFromPrimary.push(position(event));
  if (result.missingFromPrimary.length) result.differences.push('missingFromPrimary');
  if (result.missingFromSecondary.length) result.differences.push('missingFromSecondary');
  if (result.changedEvents.length) result.differences.push('changedEvents');
  return result;
}

/** Read-only diagnostics. Input/configuration failures throw only a generic error, before any RPC call. */
export async function diagnoseRpcSources(requestInput: unknown,
  sources: readonly [RpcDiagnosticSource, RpcDiagnosticSource]): Promise<RpcDiagnosticsResult> {
  const startedAt = Date.now();
  let request: AuditRequest;
  let prepared: [Prepared, Prepared];
  try {
    request = parseAuditRequest(structuredClone(requestInput));
    prepared = prepare(request, sources, startedAt);
  } catch { throw new Error('Invalid diagnostic request or source configuration.'); }
  let selectedBlock: RpcDiagnosticsResult['selectedBlock'];
  let comparison: RpcDiagnosticsResult['comparison'] = { performed: false, differences: [],
    missingFromPrimary: [], missingFromSecondary: [], changedEvents: [] };
  const finish = (status: RpcDiagnosticsResult['status'], code: string): RpcDiagnosticsResult => ({
    schemaVersion: '1', status, code, request, ...(selectedBlock ? { selectedBlock } : {}),
    sources: [prepared[0].output, prepared[1].output], comparison, limitations: [...limitations],
  });
  await Promise.all(prepared.map(async source => {
    const signal = new AbortController().signal;
    try {
      if (quantity(await source.transport('eth_chainId', [], signal)) !== BigInt(source.registry.chainId)) throw failure('RPC_CHAIN_MISMATCH');
      source.output.finalizedBlock = finalizedBlock(await source.transport('eth_getBlockByNumber', ['finalized', false], signal));
      source.output.code = 'FINALITY_READY';
    } catch (error) { source.output.code = errorCode(error); }
  }));
  if (prepared.some(source => !source.output.finalizedBlock)) return finish('unavailable', 'SOURCE_UNAVAILABLE');
  const finalized = prepared.map(source => BigInt(source.output.finalizedBlock!.number));
  const selected = request.atBlock === undefined ? (finalized[0]! < finalized[1]! ? finalized[0]! : finalized[1]!) : BigInt(request.atBlock);
  selectedBlock = { number: selected.toString() };
  for (const source of prepared) {
    if (selected > BigInt(source.output.finalizedBlock!.number)) source.output.code = 'BLOCK_NOT_FINALIZED';
    else if (selected < BigInt(source.registry.fromBlock)) source.output.code = 'BLOCK_BEFORE_REGISTRY';
  }
  if (prepared.some(source => source.output.code !== 'FINALITY_READY')) return finish('unavailable', 'BLOCK_UNAVAILABLE');
  await Promise.all(prepared.map(async source => {
    try {
      const snapshot = await collectEvidence({ ...request, atBlock: selected.toString() }, source.registry,
        { ...source.options, transport: source.transport });
      const probe = source.output.finalizedBlock!;
      if (probe.number === snapshot.block.number && (!same(probe.hash, snapshot.block.hash) || probe.timestamp !== snapshot.block.timestamp)) {
        throw failure('REORG_DETECTED');
      }
      // Reparse complete output: normalize case and reject evidence outside report bounds.
      let report: AuditReport;
      try { report = parseAuditReport(auditHistory(snapshot, request.checkpoint)); }
      catch { throw failure('RPC_INVALID_RESPONSE'); }
      if (Date.now() - startedAt >= (source.options.totalTimeoutMs ?? defaultCollectionLimits.totalTimeoutMs)) {
        throw failure('RPC_TIMEOUT');
      }
      source.output.report = report;
      source.output.code = 'COLLECTED';
    } catch (error) { source.output.code = errorCode(error); }
  }));
  const primary = prepared[0].output.report, secondary = prepared[1].output.report;
  if (!primary || !secondary) return finish('unavailable', 'SOURCE_UNAVAILABLE');
  comparison = compare(primary, secondary);
  if (comparison.differences.length) return finish('divergent', 'SOURCE_DIVERGENCE');
  if ([primary, secondary].some(report => report.checks.some(check => check.status === 'unknown'))) {
    return finish('inconclusive', 'INSUFFICIENT_EVIDENCE');
  }
  return finish('agree', 'SOURCES_AGREE');
}
