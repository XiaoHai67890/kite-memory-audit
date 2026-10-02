import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { auditHistory } from './audit.js';
import type { AuditReport, AuditRequest } from './types.js';

export const MAX_REPORT_BYTES = 4_000_000;
const MAX_EVENTS = 5_000;
const MAX_CHECKS = 50_000;
const UINT64_MAX = (1n << 64n) - 1n;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const decimal = /^(0|[1-9][0-9]{0,19})$/;
const uint64 = z.string().max(20).refine(value => decimal.test(value)
  && BigInt(value) <= UINT64_MAX);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const chainId = integer.refine(value => value > 0);
const address = z.string().length(42).regex(/^0x[0-9a-fA-F]{40}$/)
  .transform(value => value.toLowerCase() as Address);
const hash = z.string().length(66).regex(/^0x[0-9a-fA-F]{64}$/)
  .transform(value => value.toLowerCase() as Hex);
const nonzeroAddress = address.refine(value => value !== ZERO_ADDRESS);
const nonzeroHash = hash.refine(value => value !== ZERO_HASH);

/** Supply this policy independently of the untrusted report being verified. */
export const reportPolicySchema = z.object({
  chainId,
  registry: nonzeroAddress,
  fromBlock: uint64,
  expectedCodeHash: nonzeroHash,
}).strict();
export type ReportPolicy = z.infer<typeof reportPolicySchema>;

const requestSchema = z.object({
  chainId,
  registry: nonzeroAddress,
  spaceId: nonzeroHash,
  atBlock: uint64.optional(),
  checkpoint: z.object({
    sequence: uint64,
    stateRoot: hash,
    transitionId: hash.optional(),
  }).strict().optional(),
}).strict();

const position = {
  blockNumber: uint64,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: integer,
  logIndex: integer,
};
const event = z.discriminatedUnion('type', [
  z.object({ ...position, type: z.literal('registered'), controller: address, authorizer: address }).strict(),
  z.object({ ...position, type: z.literal('authorization'), controller: address,
    authorizer: address, configNonce: uint64 }).strict(),
  z.object({ ...position, type: z.literal('transition'),
    delta: z.object({
      spaceId: hash, sequence: uint64, prevStateRoot: hash, deltaCommitment: hash,
      provenanceCommitment: hash, profileId: hash, locatorCommitment: hash,
    }).strict(),
    transitionId: hash, nextStateRoot: hash, authorizer: address,
  }).strict(),
]);

// Zero values remain representable in evidence: they may be the inconsistency
// an honest report describes. The independent request and policy forbid them.
export const auditReportSchema = z.object({
  schemaVersion: z.literal('1'),
  verdict: z.enum(['consistent', 'inconsistent', 'inconclusive']),
  subject: z.object({ chainId, registry: address, spaceId: hash }).strict(),
  checks: z.array(z.object({
    id: z.string().min(1).max(128),
    status: z.enum(['pass', 'fail', 'unknown']),
    message: z.string().max(2_048),
    sequence: uint64.optional(),
  }).strict()).max(MAX_CHECKS),
  checkpoint: z.object({
    status: z.enum(['matches', 'mismatch', 'ahead', 'not_provided', 'unverifiable']),
    sequence: uint64.optional(),
  }).strict(),
  summary: z.object({
    transitionCount: integer.max(MAX_EVENTS),
    authorizationUpdateCount: integer.max(MAX_EVENTS),
    headSequence: uint64,
  }).strict(),
  evidence: z.object({
    chainId, registry: address, spaceId: hash,
    block: z.object({ number: uint64, hash, timestamp: uint64 }).strict(),
    registryEvidence: z.object({
      fromBlock: uint64, expectedCodeHash: hash, actualCodeHash: hash,
      source: z.string().max(2_048),
    }).strict(),
    head: z.object({ transitionId: hash, stateRoot: hash, sequence: uint64 }).strict(),
    authorization: z.object({ controller: address, authorizer: address, configNonce: uint64 }).strict(),
    events: z.array(event).max(MAX_EVENTS),
    rpcLabel: z.string().max(256),
  }).strict(),
  limitations: z.array(z.string().max(2_048)).max(32),
}).strict();

/** Bound compact JSON size before parsing; never execute object getters/toJSON. */
function assertJsonBudget(input: unknown, limit: number): void {
  let remaining = limit;
  let nodes = 0;
  const ancestors = new Set<object>();
  const consume = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) throw new Error('Invalid input.');
  };
  const string = (value: string) => {
    if (value.length > remaining) throw new Error('Invalid input.');
    consume(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 16) throw new Error('Invalid input.');
    if (typeof value === 'string') return string(value);
    if (value === null || typeof value === 'boolean') return consume(value === null ? 4 : value ? 4 : 5);
    if (typeof value === 'number' && Number.isFinite(value)) return consume(String(value).length);
    if (typeof value !== 'object' || !value || ancestors.has(value)) throw new Error('Invalid input.');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) throw new Error('Invalid input.');
    if (array && value.length > MAX_CHECKS) throw new Error('Invalid input.');
    const keys = Object.keys(value);
    if ((!array && keys.length > 32) || (array && keys.length !== value.length)
      || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid input.');
    ancestors.add(value);
    consume(2 + Math.max(0, keys.length - 1));
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (array && key !== String(index)) throw new Error('Invalid input.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('Invalid input.');
      if (!array) { string(key); consume(1); }
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  visit(input, 0);
}

/** Input is an already decoded JSON value, not a JSON string. Errors are redacted. */
export function parseAuditReport(input: unknown): AuditReport {
  try {
    assertJsonBudget(input, MAX_REPORT_BYTES);
    return auditReportSchema.parse(input);
  } catch {
    throw new Error('Invalid or oversized audit report.');
  }
}

export interface ReportVerification {
  schemaVersion: '1';
  status: 'verified' | 'mismatch' | 'unknown';
  code: string;
  checks: { id: string; status: 'pass' | 'fail' | 'unknown'; message: string }[];
  replayVerdict?: AuditReport['verdict'];
  limitations: string[];
}

const LIMITATIONS = [
  'Verified means offline internal consistency with the supplied request and independent registry policy. It is not proof that the supplied events or snapshot occurred on chain.',
  'The policy must come from a separately trusted configuration. This verifier cannot authenticate its provenance or the RPC source, prove log completeness, consensus, finality, freshness, or historical bytecode identity.',
  'Replay uses the same ERC-8350 audit engine as the service, not an independent implementation. A correctly reported inconsistent history can pass report verification; consult replayVerdict.',
  'Free-form report messages, provenance labels, and limitations are not endorsed. Memory truth, commitment preimages, signature policies, payment settlement, and binding a payment to this HTTP response are not verified.',
];

/** No network or wallet calls. Merchant conclusions are recomputed from evidence. */
export function verifyAuditReport(requestInput: unknown, reportInput: unknown,
  policyInput: unknown): ReportVerification {
  const checks: ReportVerification['checks'] = [];
  let replayVerdict: AuditReport['verdict'] | undefined;
  const result = (status: ReportVerification['status'], code: string): ReportVerification => ({
    schemaVersion: '1', status, code, checks,
    ...(replayVerdict === undefined ? {} : { replayVerdict }), limitations: [...LIMITATIONS],
  });
  const check = (id: string, passes: boolean, message: string) => {
    checks.push({ id, status: passes ? 'pass' : 'fail', message });
    return passes;
  };
  let request: AuditRequest;
  try {
    assertJsonBudget(requestInput, 16_384);
    request = requestSchema.parse(requestInput);
  } catch {
    check('request-schema', false, 'The independent audit request is invalid.');
    return result('mismatch', 'REQUEST_INVALID');
  }
  check('request-schema', true, 'The independent audit request has the supported shape.');
  let policy: ReportPolicy;
  try {
    assertJsonBudget(policyInput, 16_384);
    policy = reportPolicySchema.parse(policyInput);
  } catch {
    check('policy-schema', false, 'The independent registry policy is invalid.');
    return result('mismatch', 'POLICY_INVALID');
  }
  check('policy-schema', true, 'The independent registry policy has the supported shape.');
  let report: AuditReport;
  try { report = parseAuditReport(reportInput); }
  catch {
    check('report-schema', false, 'The supplied report is malformed, unsupported, or exceeds the bounds.');
    return result('mismatch', 'REPORT_INVALID');
  }
  check('report-schema', true, 'The complete report has the supported bounded shape.');
  if (!check('request-policy', request.chainId === policy.chainId && request.registry === policy.registry,
    'The request chain and registry must match the independently supplied policy.')) {
    return result('mismatch', 'REQUEST_POLICY_MISMATCH');
  }
  const matchesSubject = (subject: AuditReport['subject']) => subject.chainId === request.chainId
    && subject.registry === request.registry && subject.spaceId === request.spaceId;
  if (!check('report-subject', matchesSubject(report.subject),
    'The declared report subject must match the original request.')) {
    return result('mismatch', 'REPORT_REQUEST_MISMATCH');
  }
  if (!check('evidence-subject', matchesSubject(report.evidence),
    'The evidence subject must match the original request.')) {
    return result('mismatch', 'EVIDENCE_REQUEST_MISMATCH');
  }
  if (!check('snapshot-block', request.atBlock === undefined || request.atBlock === report.evidence.block.number,
    'When the request specifies a block, the evidence must use that exact height.')) {
    return result('mismatch', 'SNAPSHOT_BLOCK_MISMATCH');
  }
  if (!check('coverage-policy', report.evidence.registryEvidence.fromBlock === policy.fromBlock,
    'Declared log coverage must start at the independently configured block.')) {
    return result('mismatch', 'COVERAGE_POLICY_MISMATCH');
  }
  if (!check('registry-policy', report.evidence.registryEvidence.expectedCodeHash === policy.expectedCodeHash
    && report.evidence.registryEvidence.actualCodeHash === policy.expectedCodeHash,
    'Both declared and observed bytecode hashes must match the independent policy.')) {
    return result('mismatch', 'REGISTRY_POLICY_MISMATCH');
  }
  let replay: AuditReport;
  try { replay = auditHistory(report.evidence, request.checkpoint); }
  catch {
    checks.push({ id: 'replay', status: 'unknown', message: 'The evidence could not be replayed.' });
    return result('unknown', 'REPLAY_UNAVAILABLE');
  }
  replayVerdict = replay.verdict;
  check('declared-verdict', report.verdict === replay.verdict,
    'The declared verdict must agree with the recomputed verdict.');
  check('declared-checkpoint', report.checkpoint.status === replay.checkpoint.status
    && report.checkpoint.sequence === replay.checkpoint.sequence,
    'Checkpoint status and sequence must be recomputed using the original requested root and transition.');
  check('declared-summary', report.summary.transitionCount === replay.summary.transitionCount
    && report.summary.authorizationUpdateCount === replay.summary.authorizationUpdateCount
    && report.summary.headSequence === replay.summary.headSequence,
    'Declared event counts and terminal sequence must agree with replay.');
  check('declared-checks', report.checks.length === replay.checks.length
    && report.checks.every((declared, index) => {
      const computed = replay.checks[index]!;
      return declared.id === computed.id && declared.status === computed.status
        && declared.sequence === computed.sequence;
    }), 'All semantic check identifiers, statuses, sequences, duplicates, and ordering must agree with replay.');
  if (checks.some(item => item.status === 'fail')) return result('mismatch', 'REPORT_REPLAY_MISMATCH');
  const complete = !replay.checks.some(item => item.status === 'unknown');
  checks.push({ id: 'replay-completeness', status: complete ? 'pass' : 'unknown', message: complete
    ? 'Replay produced no unknown checks within the supplied evidence.'
    : 'Replay contains unknown checks; the supplied evidence cannot support conclusive verification.' });
  return result(complete ? 'verified' : 'unknown', complete ? 'REPORT_VERIFIED' : 'EVIDENCE_INCOMPLETE');
}
