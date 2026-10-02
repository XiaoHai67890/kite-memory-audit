import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Address, Hex } from 'viem';
import { auditHistory } from '../src/audit.js';
import {
  auditReportSchema, MAX_REPORT_BYTES, parseAuditReport, reportPolicySchema, verifyAuditReport,
  type ReportPolicy,
} from '../src/report-verifier.js';
import type { AuditEvent, AuditReport, AuditRequest } from '../src/types.js';

// Independent request and deployment pins, not values selected from a mutated report.
const request: AuditRequest = {
  chainId: 11155111,
  registry: '0xDdf21937ba80b5fF973610877A0955b320C91241',
  spaceId: '0xfbe20b841e2cb8d5e8094da6a9be9ebe19bb4d52c6155f465b40aa7bf1c13564',
  atBlock: '11764865',
};
const policy: ReportPolicy = {
  chainId: 11155111, registry: request.registry, fromBlock: '11353452',
  expectedCodeHash: '0xcf6373071bf2a31293ce508c6b711c1886b6019cf963acf7919fbaefde8bd5db',
};
const fixture = (): AuditReport => JSON.parse(readFileSync(
  new URL('../evidence/live-sepolia-report.json', import.meta.url), 'utf8')) as AuditReport;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const otherAddress: Address = '0x9999999999999999999999999999999999999999';
type Transition = Extract<AuditEvent, { type: 'transition' }>;
function transition(report: AuditReport, index = 1): Transition {
  const event = report.evidence.events[index]!;
  assert.equal(event.type, 'transition');
  return event as Transition;
}
const verify = (report: unknown, originalRequest: unknown = request, originalPolicy: unknown = policy) =>
  verifyAuditReport(originalRequest, report, originalPolicy);
const replay = (report: AuditReport, originalRequest: AuditRequest = request) =>
  auditHistory(report.evidence, originalRequest.checkpoint);
function assertMismatch(report: unknown, code: string = 'REPORT_REPLAY_MISMATCH') {
  const result = verify(report);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.code, code);
}

test('saved live report replays against independent request and registry pins without network access', () => {
  const report = fixture();
  const before = structuredClone(report);
  const result = verify(report);
  assert.equal(result.status, 'verified');
  assert.equal(result.code, 'REPORT_VERIFIED');
  assert.equal(result.replayVerdict, 'consistent');
  assert(result.checks.every(check => check.status === 'pass'));
  assert(result.limitations.some(value => value.includes('not proof')));
  assert(result.limitations.some(value => value.includes('same ERC-8350 audit engine')));
  assert.deepEqual(report, before);
  assert.equal(MAX_REPORT_BYTES, 4_000_000);
});

test('case normalization accepts equivalent addresses and hashes without mutating inputs', () => {
  const upper = (value: string) => `0x${value.slice(2).toUpperCase()}`;
  const original = fixture();
  const report = JSON.parse(JSON.stringify(original, (_key, value: unknown) =>
    typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? upper(value) : value));
  const before = JSON.stringify(report);
  const result = verify(report, { ...request, registry: upper(request.registry), spaceId: upper(request.spaceId) },
    { ...policy, registry: upper(policy.registry), expectedCodeHash: upper(policy.expectedCodeHash) });
  assert.equal(result.status, 'verified');
  assert.equal(parseAuditReport(report).subject.registry, request.registry.toLowerCase());
  assert.equal(JSON.stringify(report), before);
});

test('tampered emitted root cannot retain a consistent verdict', () => {
  const report = fixture();
  transition(report).nextStateRoot = hash(777);
  assertMismatch(report);
  assert.equal(verify(report).replayVerdict, 'inconsistent');
});

test('correctly described contradictory evidence verifies the report, not the history', () => {
  const report = fixture();
  transition(report).nextStateRoot = hash(777);
  const honest = replay(report);
  assert.equal(honest.verdict, 'inconsistent');
  assert(!honest.checks.some(check => check.status === 'unknown'));
  const result = verify(honest);
  assert.equal(result.status, 'verified');
  assert.equal(result.replayVerdict, 'inconsistent');
});

test('deleting a transition rejects a conclusive claim and yields unknown when honestly disclosed', () => {
  const report = fixture();
  report.evidence.events.splice(2, 1);
  assertMismatch(report);
  const result = verify(replay(report));
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'EVIDENCE_INCOMPLETE');
  assert.equal(result.replayVerdict, 'inconclusive');
});

test('missing registration, terminal events, and rotation history cannot verify', () => {
  const mutations: ((report: AuditReport) => void)[] = [
    report => { report.evidence.events.shift(); },
    report => { report.evidence.events.pop(); },
    report => { report.evidence.events = []; },
    report => { report.evidence.authorization.configNonce = '1'; },
    report => { report.evidence.registryEvidence.source = ''; },
  ];
  for (const mutate of mutations) {
    const report = fixture(); mutate(report);
    assert.equal(verify(replay(report)).status, 'unknown');
  }
});

test('an inconsistent report that also has missing evidence still remains unknown', () => {
  const report = fixture();
  transition(report).nextStateRoot = hash(777);
  report.evidence.events.pop();
  const honest = replay(report);
  assert.equal(honest.verdict, 'inconsistent');
  assert(honest.checks.some(check => check.status === 'unknown'));
  assert.equal(verify(honest).status, 'unknown');
});

test('forged verdict and every summary field are compared with replay', () => {
  const report = fixture(); report.verdict = 'inconclusive'; assertMismatch(report);
  for (const field of ['transitionCount', 'authorizationUpdateCount', 'headSequence'] as const) {
    const changed = fixture();
    if (field === 'headSequence') changed.summary[field] = '6';
    else changed.summary[field] += 1;
    assertMismatch(changed);
  }
});

test('check identifiers, statuses, sequences, missing checks, order and duplicates are all compared with replay', () => {
  const mutations: ((report: AuditReport) => void)[] = [
    report => { report.checks[0]!.id = 'fabricated'; },
    report => { report.checks[0]!.status = 'unknown'; },
    report => { report.checks[4]!.sequence = '2'; },
    report => { report.checks[0]!.sequence = '0'; },
    report => { report.checks.pop(); },
    report => { report.checks.reverse(); },
    report => { report.checks.push(structuredClone(report.checks[0]!)); },
    report => { report.checks[0] = structuredClone(report.checks[1]!); },
  ];
  for (const mutate of mutations) { const report = fixture(); mutate(report); assertMismatch(report); }
});

test('free-form explanation and source strings are neither trusted nor reflected in verification output', () => {
  const secret = 'PRIVATE_UNTRUSTED_SOURCE_TEXT';
  const report = fixture();
  report.checks.forEach(check => { check.message = secret; });
  report.limitations = [secret]; report.evidence.registryEvidence.source = secret; report.evidence.rpcLabel = secret;
  const result = verify(report);
  assert.equal(result.status, 'verified');
  assert(!JSON.stringify(result).includes(secret));
  report.checks[0]!.id = secret;
  assert.equal(verify(report).status, 'mismatch');
  assert(!JSON.stringify(verify(report)).includes(secret));
});

test('checkpoint root and transition come from the original request, not declared status alone', () => {
  const report = fixture();
  const checkpoint = { ...report.evidence.head };
  const originalRequest = { ...request, checkpoint };
  const honest = replay(report, originalRequest);
  assert.equal(verify(honest, originalRequest).status, 'verified');
  assert.equal(verify(honest, { ...originalRequest, checkpoint: { ...checkpoint, stateRoot: hash(777) } }).status, 'mismatch');
  assert.equal(verify(honest, { ...originalRequest, checkpoint: { ...checkpoint, transitionId: hash(777) } }).status, 'mismatch');
  const altered = structuredClone(honest); altered.checkpoint.sequence = '4';
  assert.equal(verify(altered, originalRequest).status, 'mismatch');
  assert.equal(verify(honest, request).status, 'mismatch');
  const wrong = { ...originalRequest, checkpoint: { ...checkpoint, stateRoot: hash(777) } };
  const correctlyDeclared = replay(report, wrong);
  assert.equal(correctlyDeclared.checkpoint.status, 'mismatch');
  assert.equal(verify(correctlyDeclared, wrong).status, 'verified');
});

test('an ahead checkpoint remains unknown and does not establish rollback', () => {
  const report = fixture();
  const originalRequest = { ...request, checkpoint: { sequence: '6', stateRoot: hash(777) } };
  const honest = replay(report, originalRequest);
  assert.equal(honest.checkpoint.status, 'ahead');
  assert.equal(verify(honest, originalRequest).status, 'unknown');
  honest.checkpoint.status = 'mismatch';
  assert.equal(verify(honest, originalRequest).status, 'mismatch');
});

test('forged checkpoint metadata without a requested checkpoint fails', () => {
  const report = fixture(); report.checkpoint.sequence = '0'; assertMismatch(report);
  report.checkpoint = { status: 'matches', sequence: '5' }; assertMismatch(report);
});

test('swapped subject is checked independently in the request, declaration, and evidence', () => {
  const subjectMutations = [{ chainId: 1 }, { registry: otherAddress }, { spaceId: hash(777) }];
  for (const mutation of subjectMutations) {
    assert.equal(verify(fixture(), { ...request, ...mutation }).status, 'mismatch');
    const declared = fixture(); Object.assign(declared.subject, mutation);
    assertMismatch(declared, 'REPORT_REQUEST_MISMATCH');
    const evidence = fixture(); Object.assign(evidence.evidence, mutation);
    assertMismatch(evidence, 'EVIDENCE_REQUEST_MISMATCH');
  }
});

test('atBlock is exact when specified, and an omitted block does not claim freshness', () => {
  const report = fixture();
  assert.equal(verify(report, { ...request, atBlock: '11764866' }).code, 'SNAPSHOT_BLOCK_MISMATCH');
  const { atBlock: _atBlock, ...latestRequest } = request;
  const result = verify(report, latestRequest);
  assert.equal(result.status, 'verified');
  assert(result.limitations.some(value => value.includes('freshness')));
});

test('report cannot self-select its coverage start or expected runtime hash', () => {
  const from = fixture(); from.evidence.registryEvidence.fromBlock = '11353453';
  assertMismatch(replay(from), 'COVERAGE_POLICY_MISMATCH');
  const changed = fixture();
  changed.evidence.registryEvidence.expectedCodeHash = hash(777);
  changed.evidence.registryEvidence.actualCodeHash = hash(777);
  assertMismatch(replay(changed), 'REGISTRY_POLICY_MISMATCH');
  const actual = fixture(); actual.evidence.registryEvidence.actualCodeHash = hash(777);
  assertMismatch(replay(actual), 'REGISTRY_POLICY_MISMATCH');
  const expected = fixture(); expected.evidence.registryEvidence.expectedCodeHash = hash(777);
  assertMismatch(replay(expected), 'REGISTRY_POLICY_MISMATCH');
});

test('policy chain and registry must agree with the independent request', () => {
  for (const mutation of [{ chainId: 1 }, { registry: otherAddress }]) {
    assert.equal(verify(fixture(), request, { ...policy, ...mutation }).code, 'REQUEST_POLICY_MISMATCH');
  }
});

test('authorization events participate in full schema validation and nonce replay', () => {
  const report = fixture();
  report.evidence.events.push({
    type: 'authorization', blockNumber: report.evidence.block.number, blockHash: report.evidence.block.hash,
    transactionHash: hash(777), transactionIndex: 0, logIndex: 0,
    controller: report.evidence.authorization.controller, authorizer: otherAddress, configNonce: '1',
  });
  report.evidence.authorization.authorizer = otherAddress; report.evidence.authorization.configNonce = '1';
  const honest = replay(report);
  assert.equal(verify(honest).status, 'verified');
  const rotation = honest.evidence.events.at(-1)!;
  assert.equal(rotation.type, 'authorization');
  if (rotation.type === 'authorization') rotation.configNonce = '2';
  assert.equal(verify(honest).status, 'mismatch');
  assert.equal(verify(replay(honest)).status, 'unknown');
});

test('duplicate log locations must be honestly reported', () => {
  const report = fixture(); report.evidence.events.push(structuredClone(report.evidence.events[1]!));
  assertMismatch(report);
  assert.equal(verify(replay(report)).status, 'verified');
  assert.equal(verify(replay(report)).replayVerdict, 'inconsistent');
});

test('all nested unknown fields are rejected instead of silently stripped', () => {
  const selectors: ((report: AuditReport) => object)[] = [
    report => report, report => report.subject, report => report.checks[0]!, report => report.checkpoint,
    report => report.summary, report => report.evidence, report => report.evidence.block,
    report => report.evidence.registryEvidence, report => report.evidence.head,
    report => report.evidence.authorization, report => report.evidence.events[0]!,
    report => report.evidence.events[1]!, report => transition(report).delta,
  ];
  for (const select of selectors) {
    const report = fixture(); Object.assign(select(report), { privateUnknownField: 'do-not-echo' });
    assertMismatch(report, 'REPORT_INVALID');
    assert.throws(() => parseAuditReport(report), { message: 'Invalid or oversized audit report.' });
  }
  const report = fixture();
  report.evidence.events.push({ ...report.evidence.events[0]!, type: 'authorization',
    controller: otherAddress, authorizer: otherAddress, configNonce: '1', privateUnknownField: true } as unknown as AuditEvent);
  assertMismatch(report, 'REPORT_INVALID');
});

test('unknown event variants and forbidden event-variant fields fail closed', () => {
  for (const mutation of [{ type: 'merged' }, { configNonce: '1' }, { delta: transition(fixture()).delta }]) {
    const report = fixture(); Object.assign(report.evidence.events[0]!, mutation);
    assertMismatch(report, 'REPORT_INVALID');
  }
});

test('invalid, huge, negative and overflowing counters never leak parser exceptions', () => {
  for (const malformed of ['-1', '01', '', '0x1', '18446744073709551616', '9'.repeat(100_000), 'SECRET']) {
    const report = fixture(); report.evidence.head.sequence = malformed;
    assertMismatch(report, 'REPORT_INVALID');
    assert.throws(() => parseAuditReport(report), { message: 'Invalid or oversized audit report.' });
    const result = verify(fixture(), { ...request, atBlock: malformed });
    assert.equal(result.code, 'REQUEST_INVALID');
    assert(!JSON.stringify(result).includes(malformed.length > 20 ? malformed : 'SECRET'));
    assert.equal(verify(fixture(), request, { ...policy, fromBlock: malformed }).code, 'POLICY_INVALID');
  }
});

test('uint64 maximum is parsed while unsafe numeric indices and counters are rejected', () => {
  assert.equal(reportPolicySchema.parse({ ...policy, fromBlock: '18446744073709551615' }).fromBlock,
    '18446744073709551615');
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const report = fixture(); report.evidence.events[0]!.logIndex = bad;
    assertMismatch(report, 'REPORT_INVALID');
  }
});

test('malformed or oversized hex and zero independent identities fail closed', () => {
  for (const malformed of ['0x', `0x${'g'.repeat(64)}`, `0x${'1'.repeat(1_000_000)}`, 'SECRET']) {
    const report = fixture(); report.evidence.head.stateRoot = malformed as Hex;
    assertMismatch(report, 'REPORT_INVALID');
  }
  assert.equal(verify(fixture(), { ...request, spaceId: hash(0) }).code, 'REQUEST_INVALID');
  assert.equal(verify(fixture(), request, { ...policy, expectedCodeHash: hash(0) }).code, 'POLICY_INVALID');
  assert.equal(verify(fixture(), request, { ...policy, registry: `0x${'0'.repeat(40)}` }).code, 'POLICY_INVALID');
});

test('nested string, list, and total UTF8 JSON bounds are enforced', () => {
  const mutations: ((report: AuditReport) => void)[] = [
    report => { report.checks[0]!.message = 'x'.repeat(2_049); },
    report => { report.evidence.registryEvidence.source = 'x'.repeat(2_049); },
    report => { report.evidence.rpcLabel = 'x'.repeat(257); },
    report => { report.limitations = Array.from({ length: 33 }, () => 'x'); },
    report => { report.evidence.events = Array.from({ length: 5_001 }, () => structuredClone(report.evidence.events[0]!)); },
    report => { report.checks = Array.from({ length: 50_001 }, () => ({ id: 'x', status: 'pass', message: '' })); },
  ];
  for (const mutate of mutations) { const report = fixture(); mutate(report); assertMismatch(report, 'REPORT_INVALID'); }
  const report = fixture();
  report.checks = Array.from({ length: 1_000 }, () => ({ id: 'x', status: 'pass', message: '界'.repeat(2_048) }));
  assert(JSON.stringify(report).length < MAX_REPORT_BYTES);
  assert(Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES);
  // Every individual field is valid, but the total encoded report is too large.
  assert(auditReportSchema.safeParse(report).success);
  assertMismatch(report, 'REPORT_INVALID');
});

test('non-JSON values, cycles, accessors and hostile objects produce generic results', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let getterCalled = false;
  const getter = { get schemaVersion() { getterCalled = true; throw new Error('SECRET'); } };
  const toJSON = { toJSON() { throw new Error('SECRET'); } };
  for (const malformed of [null, [], '', 1, undefined, 1n, cycle, getter, toJSON, new Date(), Object.create({ x: 1 })]) {
    assertMismatch(malformed, 'REPORT_INVALID');
    assert.throws(() => parseAuditReport(malformed), { message: 'Invalid or oversized audit report.' });
    assert(!JSON.stringify(verify(malformed)).includes('SECRET'));
  }
  assert.equal(getterCalled, false);
});

test('unknown request and policy fields are rejected', () => {
  assert.equal(verify(fixture(), { ...request, rpcUrl: 'https://secret.invalid' }).code, 'REQUEST_INVALID');
  assert.equal(verify(fixture(), request, { ...policy, rpcUrl: 'https://secret.invalid' }).code, 'POLICY_INVALID');
  assert.equal(verify(fixture(), { ...request, checkpoint: { sequence: '0', stateRoot: hash(0), extra: true } }).code,
    'REQUEST_INVALID');
});
