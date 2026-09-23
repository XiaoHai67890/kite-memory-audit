import {
  decodeEventLog, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256,
  toFunctionSelector, toHex, zeroAddress, type Hex,
} from 'viem';
import { ServiceError } from './errors.js';
import { registryAbi, registryEventTopics } from './registry-abi.js';
import type { AuditEvent, AuditRequest, EvidenceSnapshot, RegistryConfig } from './types.js';

export type RpcTransport = (method: string, params: readonly unknown[], signal: AbortSignal) => Promise<unknown>;
export interface CollectionOptions {
  transport?: RpcTransport;
  pageSizeBlocks?: number;
  maxRequests?: number;
  maxLogs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
}
export const defaultCollectionLimits = Object.freeze({
  pageSizeBlocks: 50_000, maxRequests: 128, maxLogs: 5_000,
  requestTimeoutMs: 10_000, totalTimeoutMs: 45_000, maxResponseBytes: 4 * 1024 * 1024,
});
const unknownSpaceSelector = toFunctionSelector('UnknownSpace()');
const bytes32 = /^0x[0-9a-fA-F]{64}$/;
const bytes = /^0x(?:[0-9a-fA-F]{2})*$/;
const quantity = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const addressWord = /^0x0{24}[0-9a-fA-F]{40}$/;
const maxUint64 = (1n << 64n) - 1n;
type ObjectValue = Record<string, unknown>;

function invalid(message = 'The RPC returned malformed or inconsistent evidence.'): never {
  throw new ServiceError('RPC_INVALID_RESPONSE', message);
}
function object(value: unknown): ObjectValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  return value as ObjectValue;
}
function hex32(value: unknown): Hex {
  if (typeof value !== 'string' || !bytes32.test(value)) invalid();
  return value as Hex;
}
function parseQuantity(value: unknown): bigint {
  if (typeof value !== 'string' || !quantity.test(value)) invalid();
  return BigInt(value);
}
function index(value: unknown): number {
  const n = parseQuantity(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(n);
}
function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

// Only this locally configured URL can reach the network; AuditRequest has no URL field.
function httpTransport(url: string, maxResponseBytes: number): RpcTransport {
  let id = 0;
  return async (method, params, signal) => {
    const requestId = ++id;
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    if (!response.ok) throw new ServiceError('RPC_UNAVAILABLE', 'The configured RPC could not complete the request.');
    if (!response.body) invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxResponseBytes) {
        await reader.cancel();
        throw new ServiceError('EVIDENCE_LIMIT', 'An RPC response exceeded the configured evidence size limit.', 422);
      }
      chunks.push(chunk.value);
    }
    let envelope: ObjectValue;
    try { envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { invalid(); }
    if (envelope.jsonrpc !== '2.0' || envelope.id !== requestId) invalid();
    if (envelope.error !== undefined) {
      // Intentionally do not propagate provider messages, which may contain credentials or URLs.
      const error = object(envelope.error);
      if (typeof error.data === 'string' && error.data.toLowerCase() === unknownSpaceSelector.toLowerCase()) {
        throw new ServiceError('UNKNOWN_SPACE', 'This Memory Space is not registered at the selected block.', 404);
      }
      throw new ServiceError('RPC_UNAVAILABLE', 'The configured RPC rejected a required evidence query.');
    }
    if (!Object.hasOwn(envelope, 'result')) invalid();
    return envelope.result;
  };
}

function block(value: unknown): { number: bigint; hash: Hex; timestamp: bigint } {
  if (value === null) throw new ServiceError('BLOCK_UNAVAILABLE', 'The requested block is unavailable.');
  const raw = object(value);
  return { number: parseQuantity(raw.number), hash: hex32(raw.hash), timestamp: parseQuantity(raw.timestamp) };
}

function decodeLog(value: unknown, request: AuditRequest, from: bigint, to: bigint): AuditEvent {
  const log = object(value);
  if (typeof log.address !== 'string' || !same(log.address, request.registry) || log.removed !== false) invalid();
  if (!Array.isArray(log.topics) || log.topics.length !== 4) invalid();
  const topics = log.topics.map(hex32) as [Hex, ...Hex[]];
  if (!registryEventTopics.some(topic => same(topic, topics[0])) || !same(topics[1]!, request.spaceId)) invalid();
  if (typeof log.data !== 'string' || !bytes.test(log.data)) invalid();
  // Reject trailing ABI data rather than accepting a prefix as a valid event.
  const expectedDataBytes = same(topics[0], registryEventTopics[0]) ? 0 : same(topics[0], registryEventTopics[1]) ? 32 : 224;
  if (log.data.length !== 2 + expectedDataBytes * 2) invalid();
  // viem decodes padded addresses and uint64 values permissively; reject noncanonical words.
  if (expectedDataBytes < 224) {
    if (!addressWord.test(topics[2]!) || !addressWord.test(topics[3]!)) invalid();
    if (expectedDataBytes === 32 && BigInt(log.data) > maxUint64) invalid();
  } else if (BigInt(topics[3]!) > maxUint64 || !addressWord.test(`0x${log.data.slice(-64)}`)) invalid();
  const blockNumber = parseQuantity(log.blockNumber);
  if (blockNumber < from || blockNumber > to) invalid();
  const position = {
    blockNumber: blockNumber.toString(), blockHash: hex32(log.blockHash),
    transactionHash: hex32(log.transactionHash), transactionIndex: index(log.transactionIndex), logIndex: index(log.logIndex),
  };
  try {
    const event = decodeEventLog({ abi: registryAbi, topics, data: log.data as Hex, strict: true });
    if (event.eventName === 'SpaceRegistered') {
      return { ...position, type: 'registered', controller: event.args.controller, authorizer: event.args.authorizer };
    }
    if (event.eventName === 'SpaceAuthorizationUpdated') {
      return { ...position, type: 'authorization', controller: event.args.controller, authorizer: event.args.authorizer, configNonce: event.args.configNonce.toString() };
    }
    const a = event.args;
    return {
      ...position, type: 'transition', transitionId: a.transitionId, nextStateRoot: a.nextStateRoot, authorizer: a.authorizer,
      delta: { spaceId: a.spaceId, sequence: a.sequence.toString(), prevStateRoot: a.prevStateRoot, deltaCommitment: a.deltaCommitment, provenanceCommitment: a.provenanceCommitment, profileId: a.profileId, locatorCommitment: a.locatorCommitment },
    };
  } catch { invalid(); }
}

/** Collects evidence from one trusted RPC. This is not a cryptographic proof of RPC honesty. */
export async function collectEvidence(request: AuditRequest, registry: RegistryConfig, options: CollectionOptions = {}): Promise<EvidenceSnapshot> {
  if (request.chainId !== registry.chainId || !same(request.registry, registry.address)) {
    throw new ServiceError('REGISTRY_NOT_ALLOWED', 'The requested chain and registry do not match the configured registry.', 400);
  }
  const limits = { ...defaultCollectionLimits, ...options };
  for (const key of Object.keys(defaultCollectionLimits) as (keyof typeof defaultCollectionLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) throw new ServiceError('CONFIGURATION_ERROR', 'Collection limits must be positive safe integers.', 500);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(registry.fromBlock) || !bytes32.test(registry.expectedCodeHash)) {
    throw new ServiceError('CONFIGURATION_ERROR', 'The registry evidence configuration is invalid.', 500);
  }
  if (request.atBlock !== undefined && !/^(0|[1-9][0-9]*)$/.test(request.atBlock)) {
    throw new ServiceError('INVALID_BLOCK', 'atBlock must be a nonnegative decimal block number.', 400);
  }
  const transport = options.transport ?? httpTransport(registry.rpcUrl, limits.maxResponseBytes);
  const startedAt = Date.now();
  let requests = 0;
  async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    if (++requests > limits.maxRequests) throw new ServiceError('EVIDENCE_LIMIT', 'The audit exceeded the configured RPC query budget.', 422);
    const remaining = limits.totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) throw new ServiceError('RPC_TIMEOUT', 'Evidence collection exceeded its time limit.', 504);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        transport(method, params, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ServiceError('RPC_TIMEOUT', 'Evidence collection exceeded its time limit.', 504));
          }, Math.min(limits.requestTimeoutMs, remaining));
        }),
      ]);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (controller.signal.aborted) throw new ServiceError('RPC_TIMEOUT', 'Evidence collection exceeded its time limit.', 504);
      throw new ServiceError('RPC_UNAVAILABLE', 'The configured RPC could not complete the evidence query.');
    } finally { if (timer) clearTimeout(timer); }
  }

  if (parseQuantity(await rpc('eth_chainId', [])) !== BigInt(registry.chainId)) {
    throw new ServiceError('RPC_CHAIN_MISMATCH', 'The configured RPC is connected to a different chain.');
  }
  let finalized: ReturnType<typeof block>;
  try { finalized = block(await rpc('eth_getBlockByNumber', ['finalized', false])); }
  catch (error) {
    if (error instanceof ServiceError && (error.code === 'RPC_UNAVAILABLE' || error.code === 'BLOCK_UNAVAILABLE')) {
      throw new ServiceError('FINALITY_UNAVAILABLE', 'The RPC must support the finalized block tag; an unfinalized fallback is not allowed.');
    }
    throw error;
  }
  const fromBlock = BigInt(registry.fromBlock);
  const selectedNumber = request.atBlock === undefined ? finalized.number : BigInt(request.atBlock);
  if (selectedNumber > finalized.number) throw new ServiceError('BLOCK_NOT_FINALIZED', 'The selected block has not finalized.', 422);
  if (selectedNumber < fromBlock) throw new ServiceError('BLOCK_BEFORE_REGISTRY', 'The selected block precedes the configured registry deployment.', 422);
  const selected = selectedNumber === finalized.number ? finalized : block(await rpc('eth_getBlockByNumber', [toHex(selectedNumber), false]));
  if (selected.number !== selectedNumber) invalid();
  const pinnedBlock = { blockHash: selected.hash, requireCanonical: true };
  const code = await rpc('eth_getCode', [registry.address, pinnedBlock]);
  if (typeof code !== 'string' || !bytes.test(code)) invalid();
  if (code === '0x') throw new ServiceError('REGISTRY_NO_CODE', 'No registry bytecode exists at the selected block.', 422);
  const actualCodeHash = keccak256(code as Hex);
  if (!same(actualCodeHash, registry.expectedCodeHash)) throw new ServiceError('REGISTRY_CODE_MISMATCH', 'The registry bytecode does not match the independently configured code hash.');

  const rawHead = await rpc('eth_call', [{ to: registry.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'head', args: [request.spaceId] }) }, pinnedBlock]);
  const rawAuthorization = await rpc('eth_call', [{ to: registry.address, data: encodeFunctionData({ abi: registryAbi, functionName: 'spaceAuthorization', args: [request.spaceId] }) }, pinnedBlock]);
  let head: EvidenceSnapshot['head'];
  let authorization: EvidenceSnapshot['authorization'];
  try {
    if (typeof rawHead !== 'string' || rawHead.length !== 194 || typeof rawAuthorization !== 'string' || rawAuthorization.length !== 194) invalid();
    const h = decodeFunctionResult({ abi: registryAbi, functionName: 'head', data: rawHead as Hex });
    const a = decodeFunctionResult({ abi: registryAbi, functionName: 'spaceAuthorization', data: rawAuthorization as Hex });
    if (!same(encodeFunctionResult({ abi: registryAbi, functionName: 'head', result: h }), rawHead)
      || !same(encodeFunctionResult({ abi: registryAbi, functionName: 'spaceAuthorization', result: a }), rawAuthorization)) invalid();
    head = { transitionId: h[0], stateRoot: h[1], sequence: h[2].toString() };
    authorization = { controller: a[0], authorizer: a[1], configNonce: a[2].toString() };
  } catch { invalid(); }
  if (same(authorization.controller, zeroAddress)) throw new ServiceError('UNKNOWN_SPACE', 'This Memory Space is not registered at the selected block.', 404);

  const events: AuditEvent[] = [];
  const uniqueLogs = new Set<string>();
  const blockHashes = new Map<string, string>();
  for (let from = fromBlock; from <= selected.number; from += BigInt(limits.pageSizeBlocks)) {
    const to = from + BigInt(limits.pageSizeBlocks) - 1n < selected.number ? from + BigInt(limits.pageSizeBlocks) - 1n : selected.number;
    const logs = await rpc('eth_getLogs', [{ address: registry.address, fromBlock: toHex(from), toBlock: toHex(to), topics: [registryEventTopics, request.spaceId] }]);
    if (!Array.isArray(logs)) invalid();
    if (events.length + logs.length > limits.maxLogs) throw new ServiceError('EVIDENCE_LIMIT', 'The audit exceeded the configured event limit; no partial report was produced.', 422);
    for (const raw of logs) {
      const event = decodeLog(raw, request, from, to);
      const key = `${event.blockNumber}:${event.logIndex}`;
      if (uniqueLogs.has(key)) invalid('The RPC returned duplicate event positions.');
      uniqueLogs.add(key);
      const previousHash = blockHashes.get(event.blockNumber);
      if (previousHash !== undefined && !same(previousHash, event.blockHash)) invalid();
      if (event.blockNumber === selected.number.toString() && !same(event.blockHash, selected.hash)) invalid();
      blockHashes.set(event.blockNumber, event.blockHash);
      events.push(event);
    }
  }
  // A range log response can contain stale fork records even when its bounds are correct.
  // Check each observed historical block against the RPC's canonical block header, then
  // recheck the finalized pin below. These are consistency checks, not header/receipt proofs.
  for (const [number, expectedHash] of blockHashes) {
    if (number === selected.number.toString()) continue;
    const observed = block(await rpc('eth_getBlockByNumber', [toHex(BigInt(number)), false]));
    if (observed.number !== BigInt(number) || !same(observed.hash, expectedHash)) {
      throw new ServiceError('REORG_DETECTED', 'Event evidence does not match canonical block headers; retry with consistent finalized evidence.');
    }
  }
  events.sort((a, b) => BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
  const endBlock = block(await rpc('eth_getBlockByNumber', [toHex(selected.number), false]));
  if (endBlock.number !== selected.number || !same(endBlock.hash, selected.hash)) {
    throw new ServiceError('REORG_DETECTED', 'The pinned block changed during collection; retry against a finalized canonical block.');
  }
  return {
    chainId: registry.chainId, registry: registry.address, spaceId: request.spaceId,
    block: { number: selected.number.toString(), hash: selected.hash, timestamp: selected.timestamp.toString() },
    registryEvidence: { fromBlock: registry.fromBlock, expectedCodeHash: registry.expectedCodeHash, actualCodeHash, source: registry.source },
    head, authorization, events, rpcLabel: registry.label,
  };
}
