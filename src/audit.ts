import { keccak256 } from 'viem';
import type { AuditCheck, AuditEvent, AuditReport, AuditRequest, EvidenceSnapshot } from './types.js';
import { computeNextStateRoot, hashExperienceDelta, ZERO32 } from './erc8350.js';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const UINT64_MAX = (1n << 64n) - 1n;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (s: unknown): s is string => typeof s === 'string' && /^0x[\da-f]{64}$/i.test(s);
const address = (s: unknown): s is string => typeof s === 'string' && /^0x[\da-f]{40}$/i.test(s);
const natural = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d*)$/.test(s);
const uint64 = (s: unknown): s is string => natural(s) && BigInt(s) <= UINT64_MAX;
const positionValid = (e: AuditEvent) => natural(e.blockNumber) && bytes32(e.blockHash)
  && bytes32(e.transactionHash) && Number.isSafeInteger(e.transactionIndex) && e.transactionIndex >= 0
  && Number.isSafeInteger(e.logIndex) && e.logIndex >= 0;

/** Pure evidence replay; verdicts concern the supplied RPC snapshot, not memory truth. */
export function auditHistory(snapshot: EvidenceSnapshot, checkpoint?: AuditRequest['checkpoint']): AuditReport {
  const checks: AuditCheck[] = [];
  const check = (id: string, status: AuditCheck['status'], message: string, sequence?: string) =>
    checks.push({ id, status, message, ...(sequence === undefined ? {} : { sequence }) });
  const transitions = snapshot.events.filter(e => e.type === 'transition');
  const rotations = snapshot.events.filter(e => e.type === 'authorization');
  let checkpointResult: AuditReport['checkpoint'] = checkpoint
    ? { status: 'unverifiable', sequence: checkpoint.sequence } : { status: 'not_provided' };
  const finish = (): AuditReport => ({
    schemaVersion: '1',
    verdict: checks.some(c => c.status === 'fail') ? 'inconsistent'
      : checks.some(c => c.status === 'unknown') ? 'inconclusive' : 'consistent',
    subject: { chainId: snapshot.chainId, registry: snapshot.registry, spaceId: snapshot.spaceId },
    checks, checkpoint: checkpointResult,
    summary: { transitionCount: transitions.length, authorizationUpdateCount: rotations.length,
      headSequence: snapshot.head.sequence },
    evidence: snapshot,
    limitations: [
      'This is consistency checking of one RPC snapshot, not an independently verified consensus, receipt-inclusion, or finality proof. The RPC provider and configured registry provenance are trust assumptions.',
      'Matching runtime bytecode at the snapshot block does not prove historical code identity or proxy implementation history. Only explicitly configured, reviewed registries are supported.',
      'Authorizer addresses and configuration events are replayed. Transaction signatures, direct-call permissions, ERC-1271 policies, and original registration salt are not independently revalidated.',
      'No raw memory, commitment preimages, provenance truth, profile semantics, availability, or actual model use is verified.',
      'A checkpoint beyond this snapshot is insufficient evidence of rollback; compare the same chain, registry, space, and appropriate block/finality before drawing that conclusion.',
    ],
  });

  const shapeValid = Number.isSafeInteger(snapshot.chainId) && snapshot.chainId > 0
    && address(snapshot.registry) && bytes32(snapshot.spaceId)
    && natural(snapshot.block.number) && bytes32(snapshot.block.hash) && natural(snapshot.block.timestamp)
    && natural(snapshot.registryEvidence.fromBlock) && bytes32(snapshot.registryEvidence.expectedCodeHash)
    && bytes32(snapshot.registryEvidence.actualCodeHash)
    && uint64(snapshot.head.sequence) && bytes32(snapshot.head.stateRoot) && bytes32(snapshot.head.transitionId)
    && address(snapshot.authorization.controller) && address(snapshot.authorization.authorizer)
    && uint64(snapshot.authorization.configNonce)
    && snapshot.events.every(e => positionValid(e) && (e.type === 'registered'
      ? address(e.controller) && address(e.authorizer)
      : e.type === 'authorization' ? address(e.controller) && address(e.authorizer) && uint64(e.configNonce)
        : e.type === 'transition' && uint64(e.delta.sequence) && address(e.authorizer)
          && [e.delta.spaceId, e.delta.prevStateRoot, e.delta.deltaCommitment, e.delta.provenanceCommitment,
            e.delta.profileId, e.delta.locatorCommitment, e.transitionId, e.nextStateRoot].every(bytes32)));
  check('evidence-shape', shapeValid ? 'pass' : 'fail', shapeValid
    ? 'Typed evidence uses canonical decimal integers, uint64 counters, addresses and bytes32 values.'
    : 'Malformed evidence cannot be replayed.');
  if (!shapeValid) return finish();
  if (equal(snapshot.spaceId, ZERO32) || equal(snapshot.registry, ZERO_ADDRESS)) {
    check('subject', 'fail', 'Registry address and memory space must be nonzero.');
  }
  const block = BigInt(snapshot.block.number);
  const fromBlock = BigInt(snapshot.registryEvidence.fromBlock);
  check('coverage-range', fromBlock <= block ? 'pass' : 'fail', `Declared log range: ${fromBlock} through ${block}, inclusive.`);
  const codeMatches = equal(snapshot.registryEvidence.expectedCodeHash, snapshot.registryEvidence.actualCodeHash)
    && !equal(snapshot.registryEvidence.actualCodeHash, ZERO32)
    && !equal(snapshot.registryEvidence.actualCodeHash, keccak256('0x'));
  check('registry-code', codeMatches ? 'pass' : 'unknown', codeMatches
    ? 'Snapshot runtime bytecode hash matches the configured registry hash.'
    : 'No trusted matching runtime bytecode hash; registry semantics cannot be endorsed.');
  if (!snapshot.registryEvidence.source.trim()) check('registry-source', 'unknown', 'Registry provenance is unspecified.');

  const events = [...snapshot.events].sort((a, b) => {
    const blockA = BigInt(a.blockNumber), blockB = BigInt(b.blockNumber);
    return blockA < blockB ? -1 : blockA > blockB ? 1
      : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;
  });
  const positions = new Set<string>();
  const transactionLogs = new Set<string>();
  const blockHashes = new Map<string, string>();
  const transactionHashes = new Map<string, string>();
  const transactionPositions = new Map<string, string>();
  let previousEvent: AuditEvent | undefined;
  for (const e of events) {
    if (BigInt(e.blockNumber) < fromBlock || BigInt(e.blockNumber) > block) {
      check('event-range', 'fail', `Event ${e.transactionHash}:${e.logIndex} is outside declared coverage.`);
    }
    const position = `${e.blockNumber}:${e.logIndex}`;
    const txLog = `${e.transactionHash.toLowerCase()}:${e.logIndex}`;
    if (positions.has(position) || transactionLogs.has(txLog)) check('duplicate-event', 'fail', `Duplicate event location ${position}.`);
    positions.add(position); transactionLogs.add(txLog);
    const knownBlockHash = blockHashes.get(e.blockNumber);
    if ((knownBlockHash && !equal(knownBlockHash, e.blockHash))
      || (BigInt(e.blockNumber) === block && !equal(e.blockHash, snapshot.block.hash))) {
      check('block-hash', 'fail', `Conflicting block hashes at height ${e.blockNumber}.`);
    }
    blockHashes.set(e.blockNumber, e.blockHash);
    const txPosition = `${e.blockNumber}:${e.transactionIndex}`;
    const knownTxHash = transactionHashes.get(txPosition);
    if (knownTxHash && !equal(knownTxHash, e.transactionHash)) check('transaction-position', 'fail', `Conflicting transaction hashes at ${txPosition}.`);
    transactionHashes.set(txPosition, e.transactionHash);
    const knownTxPosition = transactionPositions.get(e.transactionHash.toLowerCase());
    if (knownTxPosition && knownTxPosition !== txPosition) check('transaction-position', 'fail', 'One transaction hash occurs at multiple canonical positions.');
    transactionPositions.set(e.transactionHash.toLowerCase(), txPosition);
    if (previousEvent?.blockNumber === e.blockNumber && previousEvent.logIndex >= e.logIndex) {
      check('log-order', 'fail', 'Global log indices conflict with transaction order.');
    }
    previousEvent = e;
  }

  const registrations = events.filter(e => e.type === 'registered');
  check('registration', registrations.length === 1 ? 'pass' : registrations.length === 0 ? 'unknown' : 'fail',
    registrations.length === 1 ? 'One registration event is present in the declared range.'
      : registrations.length === 0 ? 'Registration evidence is missing; complete history cannot be established.'
        : 'A memory space must not be registered more than once.');
  if (registrations.length && events[0]?.type !== 'registered') check('registration-order', 'fail', 'Events precede the supplied registration.');

  let controller: string | undefined;
  let authorizer: string | undefined;
  let nonce = 0n;
  let authComplete = registrations.length === 1;
  let observedSequence = 0n;
  let observedRoot = ZERO32;
  let observedTransitionId = ZERO32;
  const transitionIds = new Set<string>();
  const expectedAuthorizers: { event: typeof transitions[number]; authorizer?: string }[] = [];
  const checkpoints = new Map<string, { stateRoot: string; transitionId: string }>();
  checkpoints.set('0', { stateRoot: ZERO32, transitionId: ZERO32 });

  for (const e of events) {
    if (e.type === 'registered' || e.type === 'authorization') {
      if (equal(e.controller, ZERO_ADDRESS) || equal(e.authorizer, ZERO_ADDRESS)) {
        check('authorization-address', 'fail', 'Registration and rotation addresses must be nonzero.');
      }
      controller = e.controller; authorizer = e.authorizer;
      if (e.type === 'authorization') {
        const nextNonce = BigInt(e.configNonce);
        if (nextNonce <= nonce) check('authorization-nonce', 'fail', `Authorization nonce ${nextNonce} repeats or moves backwards.`);
        else if (nextNonce !== nonce + 1n) {
          authComplete = false;
          check('authorization-gap', 'unknown', `Authorization history is missing nonce(s) between ${nonce} and ${nextNonce}.`);
        }
        nonce = nextNonce;
      }
      continue;
    }
    const sequence = BigInt(e.delta.sequence);
    expectedAuthorizers.push({ event: e, authorizer });
    if (!equal(e.delta.spaceId, snapshot.spaceId)) check('transition-space', 'fail', 'Transition belongs to a different memory space.', e.delta.sequence);
    if (equal(e.delta.deltaCommitment, ZERO32) || equal(e.delta.profileId, ZERO32)) {
      check('required-commitments', 'fail', 'deltaCommitment and profileId must be nonzero.', e.delta.sequence);
    }
    if (equal(e.authorizer, ZERO_ADDRESS)) check('transition-authorizer', 'fail', 'A transition authorizer must be nonzero.', e.delta.sequence);
    if (sequence <= observedSequence) check('sequence-order', 'fail', 'Transition sequence repeats or moves backwards.', e.delta.sequence);
    else if (sequence > observedSequence + 1n) check('sequence-gap', 'unknown', `Missing transition evidence between sequences ${observedSequence} and ${sequence}.`, e.delta.sequence);
    if (sequence === observedSequence + 1n && !equal(e.delta.prevStateRoot, observedRoot)) {
      check('previous-root', 'fail', 'Previous root disagrees with the preceding transition or genesis.', e.delta.sequence);
    }
    const transitionId = hashExperienceDelta(e.delta);
    const nextStateRoot = computeNextStateRoot(e.delta.prevStateRoot, transitionId);
    check('transition-hash', equal(transitionId, e.transitionId) ? 'pass' : 'fail',
      'Recomputed ERC-8350 ExperienceDelta struct hash compared with emitted transitionId.', e.delta.sequence);
    check('state-root', equal(nextStateRoot, e.nextStateRoot) ? 'pass' : 'fail',
      'Recomputed MemoryState hash compared with emitted nextStateRoot.', e.delta.sequence);
    if (transitionIds.has(e.transitionId.toLowerCase())) check('duplicate-transition', 'fail', 'Repeated transitionId.', e.delta.sequence);
    transitionIds.add(e.transitionId.toLowerCase());
    observedSequence = sequence; observedRoot = e.nextStateRoot; observedTransitionId = e.transitionId;
    checkpoints.set(e.delta.sequence, { stateRoot: e.nextStateRoot, transitionId: e.transitionId });
  }

  const finalNonce = BigInt(snapshot.authorization.configNonce);
  if (finalNonce < nonce) check('authorization-head', 'fail', 'Snapshot authorization nonce precedes an observed update.');
  else if (finalNonce > nonce) {
    authComplete = false;
    check('authorization-head', 'unknown', 'Snapshot authorization nonce indicates missing update events.');
  } else if (controller && authorizer) {
    check('authorization-head', equal(controller, snapshot.authorization.controller) && equal(authorizer, snapshot.authorization.authorizer) ? 'pass' : 'fail',
      'Final replayed authorization compared with the snapshot read.');
  } else check('authorization-head', 'unknown', 'No event establishes the snapshot authorization.');
  if (equal(snapshot.authorization.controller, ZERO_ADDRESS) || equal(snapshot.authorization.authorizer, ZERO_ADDRESS)) {
    check('space-existence', events.length ? 'fail' : 'unknown', 'Zero snapshot authorization does not establish a registered space.');
  }
  for (const { event, authorizer: expected } of expectedAuthorizers) {
    check('event-authorizer', authComplete && expected ? equal(event.authorizer, expected) ? 'pass' : 'fail' : 'unknown',
      authComplete && expected ? 'Emitted authorizer compared with the configuration active at this event.'
        : 'Incomplete authorization event history prevents establishing the active authorizer.', event.delta.sequence);
  }

  const headSequence = BigInt(snapshot.head.sequence);
  if (headSequence < observedSequence) check('head', 'fail', 'Snapshot head precedes an observed transition.');
  else if (headSequence > observedSequence) check('head', 'unknown', 'Snapshot head indicates missing later transition events.');
  else check('head', equal(snapshot.head.stateRoot, observedRoot) && equal(snapshot.head.transitionId, observedTransitionId) ? 'pass' : 'fail',
    'Replayed terminal transition, state root and sequence compared with the snapshot head.');

  if (checkpoint) {
    if (!uint64(checkpoint.sequence) || !bytes32(checkpoint.stateRoot)
      || (checkpoint.transitionId !== undefined && !bytes32(checkpoint.transitionId))) {
      check('checkpoint', 'fail', 'Checkpoint fields are malformed.');
    } else if (BigInt(checkpoint.sequence) > headSequence) {
      checkpointResult = { status: 'ahead', sequence: checkpoint.sequence };
      check('checkpoint', 'unknown', 'Checkpoint is ahead of this snapshot; this alone is not evidence of rollback.');
    } else {
      const evidence = checkpoints.get(checkpoint.sequence);
      if (!evidence || !registrations.length) {
        check('checkpoint', 'unknown', 'Evidence for the requested checkpoint is missing.');
      } else {
        const matches = equal(checkpoint.stateRoot, evidence.stateRoot)
          && (checkpoint.transitionId === undefined || equal(checkpoint.transitionId, evidence.transitionId));
        checkpointResult = { status: matches ? 'matches' : 'mismatch', sequence: checkpoint.sequence };
        check('checkpoint', matches ? 'pass' : 'fail', matches
          ? 'Checkpoint matches the observed version within this snapshot.' : 'Checkpoint conflicts with the observed version.');
      }
    }
  }
  return finish();
}
