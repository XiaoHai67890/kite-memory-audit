import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Address, Hex } from 'viem';
import { auditHistory } from '../src/audit.js';
import { computeNextStateRoot, EXPERIENCE_DELTA_TYPEHASH, hashExperienceDelta, MEMORY_STATE_TYPEHASH, ZERO32 } from '../src/erc8350.js';
import type { AuditEvent, EvidenceSnapshot, ExperienceDelta } from '../src/types.js';

// Independent known answers: original upstream files and exact provenance live in fixtures/.
const v1 = JSON.parse(readFileSync(new URL('./fixtures/erc8350-v1.json', import.meta.url), 'utf8'));
const v2 = JSON.parse(readFileSync(new URL('./fixtures/erc8350-v2.json', import.meta.url), 'utf8')) as {
  space: { controller: Address; authorizer: Address; spaceId: Hex };
  chain: { delta: ExperienceDelta; expected: { transitionId: Hex; nextStateRoot: Hex } }[];
};
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const nextAuthorizer = '0x9999999999999999999999999999999999999999' as Address;
type Transition = Extract<AuditEvent, { type: 'transition' }>;
const position = (n: number) => ({ blockNumber: String(n + 10), blockHash: hash(n + 10),
  transactionHash: hash(n + 100), transactionIndex: 0, logIndex: 0 });

function snapshot(): EvidenceSnapshot {
  const last = v2.chain.at(-1)!;
  return {
    chainId: 11155111, registry: '0x4444444444444444444444444444444444444444',
    spaceId: v2.space.spaceId, block: { number: '99', hash: hash(99), timestamp: '1700000000' },
    registryEvidence: { fromBlock: '10', expectedCodeHash: hash(55), actualCodeHash: hash(55),
      source: 'Synthetic snapshot; pinned upstream golden delta vectors.' },
    head: { transitionId: last.expected.transitionId, stateRoot: last.expected.nextStateRoot, sequence: last.delta.sequence },
    authorization: { controller: v2.space.controller, authorizer: v2.space.authorizer, configNonce: '0' },
    events: [
      { ...position(0), type: 'registered', controller: v2.space.controller, authorizer: v2.space.authorizer },
      ...v2.chain.map((entry, i): AuditEvent => ({ ...position(i + 1), type: 'transition',
        delta: structuredClone(entry.delta), ...entry.expected, authorizer: v2.space.authorizer })),
    ], rpcLabel: 'synthetic-test',
  };
}
function transition(s: EvidenceSnapshot, i = 1): Transition {
  const e = s.events[i]!;
  assert.equal(e.type, 'transition');
  return e as Transition;
}
function has(s: EvidenceSnapshot, id: string, status: string) {
  return auditHistory(s).checks.some(c => c.id === id && c.status === status);
}
function rehash(e: Transition) {
  e.transitionId = hashExperienceDelta(e.delta);
  e.nextStateRoot = computeNextStateRoot(e.delta.prevStateRoot, e.transitionId);
}

test('v1 golden type hashes, transition ID, and state root match published known answers', () => {
  assert.equal(EXPERIENCE_DELTA_TYPEHASH, v1.expected.experienceDeltaTypehash);
  assert.equal(MEMORY_STATE_TYPEHASH, v1.expected.memoryStateTypehash);
  assert.equal(hashExperienceDelta(v1.delta), v1.expected.transitionId);
  assert.equal(computeNextStateRoot(v1.delta.prevStateRoot, v1.expected.transitionId), v1.expected.nextStateRoot);
});

test('v2 five-step replay permits optional zero commitments and changing profiles', () => {
  let previousRoot = ZERO32;
  for (const { delta, expected } of v2.chain) {
    assert.equal(delta.prevStateRoot, previousRoot);
    assert.equal(hashExperienceDelta(delta), expected.transitionId);
    assert.equal(computeNextStateRoot(previousRoot, expected.transitionId), expected.nextStateRoot);
    previousRoot = expected.nextStateRoot;
  }
  assert.equal(auditHistory(snapshot()).verdict, 'consistent');
});

test('sorting shuffled evidence is deterministic and does not mutate the input', () => {
  const s = snapshot();
  s.events.reverse();
  const before = structuredClone(s);
  assert.equal(auditHistory(s).verdict, 'consistent');
  assert.deepEqual(s, before);
});

test('the transaction order within a block, then global log index, controls replay', () => {
  const s = snapshot();
  s.events.forEach((e, i) => Object.assign(e, { blockNumber: '10', blockHash: hash(10),
    transactionIndex: Math.floor(i / 2), transactionHash: hash(100 + Math.floor(i / 2)), logIndex: i }));
  s.events.reverse();
  assert.equal(auditHistory(s).verdict, 'consistent');
  s.events[0]!.logIndex = 0;
  assert.equal(auditHistory(s).verdict, 'inconsistent');
});

test('mutating every committed field breaks the transition identity', () => {
  for (const field of ['spaceId', 'prevStateRoot', 'deltaCommitment', 'provenanceCommitment', 'profileId', 'locatorCommitment'] as const) {
    const s = snapshot(); transition(s).delta[field] = hash(777);
    assert(has(s, 'transition-hash', 'fail'), field);
  }
  const s = snapshot(); transition(s).delta.sequence = '2';
  assert(has(s, 'transition-hash', 'fail'));
});

test('wrong emitted next root is a contradiction even if later events are missing', () => {
  const s = snapshot(); transition(s).nextStateRoot = hash(999); s.events.length = 2;
  assert.equal(auditHistory(s).verdict, 'inconsistent');
  assert(has(s, 'state-root', 'fail'));
});

test('a self-consistently rehashed transition must still link to the prior root', () => {
  const s = snapshot(); const e = transition(s, 2);
  e.delta.prevStateRoot = hash(777); rehash(e);
  assert(has(s, 'previous-root', 'fail'));
});

test('genesis must reference zero and sequence cannot be zero', () => {
  const s = snapshot(); const e = transition(s);
  e.delta.prevStateRoot = hash(777); rehash(e);
  assert(has(s, 'previous-root', 'fail'));
  e.delta.sequence = '0'; rehash(e);
  assert(has(s, 'sequence-order', 'fail'));
});

test('required commitments cannot be zero even with correct hashes', () => {
  for (const field of ['deltaCommitment', 'profileId'] as const) {
    const s = snapshot(); const e = transition(s); e.delta[field] = ZERO32; rehash(e);
    assert(has(s, 'required-commitments', 'fail'));
  }
});

test('duplicate log positions and repeated transition IDs are rejected', () => {
  const s = snapshot(); s.events.push(structuredClone(s.events[1]!));
  assert(has(s, 'duplicate-event', 'fail'));
  assert(has(s, 'duplicate-transition', 'fail'));
});

test('duplicate sequences at different positions are contradictions', () => {
  const s = snapshot(); const e = transition(s, 2); e.delta.sequence = '1'; rehash(e);
  assert(has(s, 'sequence-order', 'fail'));
});

test('one transaction hash cannot occupy two block or transaction positions', () => {
  const s = snapshot();
  s.events[2]!.transactionHash = s.events[1]!.transactionHash;
  s.events[2]!.logIndex = 1; // Different global log index must not hide the conflicting position.
  assert(has(s, 'transaction-position', 'fail'));
  s.events[2]!.blockNumber = s.events[1]!.blockNumber;
  s.events[2]!.blockHash = s.events[1]!.blockHash;
  s.events[2]!.transactionIndex = 1;
  assert(has(s, 'transaction-position', 'fail'));
});

test('missing prefix, middle, or tail transition evidence stays inconclusive', () => {
  for (const index of [1, 3, 5]) {
    const s = snapshot(); s.events.splice(index, 1);
    assert.equal(auditHistory(s).verdict, 'inconclusive', `missing index ${index}`);
  }
});

test('missing registration and an entirely empty unknown snapshot stay inconclusive', () => {
  const s = snapshot(); s.events.shift();
  assert.equal(auditHistory(s).verdict, 'inconclusive');
  s.events = []; s.head = { sequence: '0', transitionId: ZERO32, stateRoot: ZERO32 };
  s.authorization = { controller: `0x${'00'.repeat(20)}`, authorizer: `0x${'00'.repeat(20)}`, configNonce: '0' };
  assert.equal(auditHistory(s).verdict, 'inconclusive');
});

test('registered empty history has the defined zero head', () => {
  const s = snapshot(); s.events.length = 1;
  s.head = { sequence: '0', transitionId: ZERO32, stateRoot: ZERO32 };
  assert.equal(auditHistory(s).verdict, 'consistent');
  s.head.stateRoot = hash(999);
  assert(has(s, 'head', 'fail'));
});

test('a second registration or registration after a transition is a contradiction', () => {
  const s = snapshot(); s.events.push({ ...s.events[0]!, ...position(8) });
  assert(has(s, 'registration', 'fail'));
  s.events.pop(); Object.assign(s.events[0]!, position(8));
  assert(has(s, 'registration-order', 'fail'));
});

function withRotation(): EvidenceSnapshot {
  const s = snapshot();
  // Rotation follows transition 2 in the same block and precedes transition 3.
  s.events.push({ ...position(2), logIndex: 1, type: 'authorization', controller: v2.space.controller,
    authorizer: nextAuthorizer, configNonce: '1' });
  for (const e of s.events) if (e.type === 'transition' && BigInt(e.delta.sequence) >= 3n) e.authorizer = nextAuthorizer;
  s.authorization = { controller: v2.space.controller, authorizer: nextAuthorizer, configNonce: '1' };
  return s;
}

test('rotation replays in log order and each transition uses the active authorizer', () => {
  const s = withRotation();
  assert.equal(auditHistory(s).verdict, 'consistent');
  transition(s, 3).authorizer = v2.space.authorizer;
  assert(has(s, 'event-authorizer', 'fail'));
});

test('missing authorization evidence is inconclusive rather than falsely blaming the authorizer', () => {
  const s = withRotation(); s.events.pop();
  assert.equal(auditHistory(s).verdict, 'inconclusive');
  assert(!has(s, 'event-authorizer', 'fail'));
});

test('authorization nonce gaps are incomplete, nonce regressions are contradictory', () => {
  const s = withRotation(); const rotation = s.events.at(-1)!;
  assert(rotation.type === 'authorization'); rotation.configNonce = '2'; s.authorization.configNonce = '2';
  assert.equal(auditHistory(s).verdict, 'inconclusive');
  rotation.configNonce = '0';
  assert(has(s, 'authorization-nonce', 'fail'));
});

test('snapshot authorization state and counters must agree with observed history', () => {
  const s = withRotation(); s.authorization.authorizer = v2.space.authorizer;
  assert(has(s, 'authorization-head', 'fail'));
  s.authorization.configNonce = '0';
  assert(has(s, 'authorization-head', 'fail'));
});

test('head root, transition and backwards sequence are contradictions', () => {
  for (const field of ['stateRoot', 'transitionId'] as const) {
    const s = snapshot(); s.head[field] = hash(777); assert(has(s, 'head', 'fail'));
  }
  const s = snapshot(); s.head.sequence = '4'; assert(has(s, 'head', 'fail'));
});

test('checkpoint can match genesis, a prior version, or the current head', () => {
  const s = snapshot();
  for (const checkpoint of [{ sequence: '0', stateRoot: ZERO32, transitionId: ZERO32 },
    ...v2.chain.map(x => ({ sequence: x.delta.sequence, stateRoot: x.expected.nextStateRoot, transitionId: x.expected.transitionId }))]) {
    const r = auditHistory(s, checkpoint);
    assert.equal(r.verdict, 'consistent'); assert.equal(r.checkpoint.status, 'matches');
  }
});

test('checkpoint mismatch and insufficient checkpoint evidence are distinct', () => {
  const s = snapshot();
  const mismatch = auditHistory(s, { sequence: '3', stateRoot: hash(888) });
  assert.equal(mismatch.verdict, 'inconsistent'); assert.equal(mismatch.checkpoint.status, 'mismatch');
  const ahead = auditHistory(s, { sequence: '6', stateRoot: hash(888) });
  assert.equal(ahead.verdict, 'inconclusive'); assert.equal(ahead.checkpoint.status, 'ahead');
  s.events.splice(3, 1);
  assert.equal(auditHistory(s, { sequence: '3', stateRoot: hash(888) }).checkpoint.status, 'unverifiable');
});

test('checkpoint transition ID is checked even if its state root matches', () => {
  const s = snapshot();
  assert.equal(auditHistory(s, { sequence: s.head.sequence, stateRoot: s.head.stateRoot,
    transitionId: hash(777) }).checkpoint.status, 'mismatch');
});

test('bytecode mismatch or omitted provenance does not endorse a registry', () => {
  const s = snapshot(); s.registryEvidence.actualCodeHash = hash(777);
  assert.equal(auditHistory(s).verdict, 'inconclusive');
  s.registryEvidence.actualCodeHash = s.registryEvidence.expectedCodeHash; s.registryEvidence.source = '';
  assert.equal(auditHistory(s).verdict, 'inconclusive');
});

test('events outside coverage and conflicting block hashes are rejected', () => {
  const s = snapshot(); s.registryEvidence.fromBlock = '11';
  assert(has(s, 'event-range', 'fail'));
  s.registryEvidence.fromBlock = '10'; s.events[1]!.blockNumber = '100';
  assert(has(s, 'event-range', 'fail'));
  s.events[1]!.blockNumber = '99'; s.events[1]!.blockHash = hash(777);
  assert(has(s, 'block-hash', 'fail'));
});

test('uint64 overflow and malformed evidence return an explicit failure without throwing', () => {
  const s = snapshot(); transition(s).delta.sequence = '18446744073709551616';
  assert(has(s, 'evidence-shape', 'fail'));
  const invalidHex = snapshot(); transition(invalidHex).delta.deltaCommitment = '0x12';
  assert(has(invalidHex, 'evidence-shape', 'fail'));
});
