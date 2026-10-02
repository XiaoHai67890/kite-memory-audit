import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_REPORT_BYTES, parseAuditReport } from './report-verifier.js';
import { parseAuditRequest } from './validation.js';
import type { AuditRequest } from './types.js';

export const MAX_METADATA_BYTES = 65_536;
export const CAPTURE_LIMITATION = 'These hashes correlate local files only. They are not a merchant signature, on-chain request commitment, payment proof, or proof of report authenticity.';
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const resourceSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.href === value && url.pathname === '/v1/memory/audit'
      && !url.username && !url.password && !value.includes('?') && !value.includes('#');
  } catch { return false; }
});
export const reportManifestSchema = z.object({
  schemaVersion: z.literal('1'), status: z.literal('captured'),
  requestFile: z.literal('request.json'), reportFile: z.literal('report.json'),
  reportBytes: z.number().int().positive().max(MAX_REPORT_BYTES),
  requestSha256: digestSchema, reportSha256: digestSchema, resourceUrl: resourceSchema,
  limitation: z.literal(CAPTURE_LIMITATION),
}).strict();
const pendingRecord = {
  schemaVersion: '1', status: 'pending',
  message: 'Capture reserved before payment. This start record is permanent; inspect manifest.json and payment.json for later outcomes. Never automatically repeat payment.',
  limitation: CAPTURE_LIMITATION,
} as const;
const pendingSchema = z.object({
  schemaVersion: z.literal(pendingRecord.schemaVersion), status: z.literal(pendingRecord.status),
  message: z.literal(pendingRecord.message), limitation: z.literal(CAPTURE_LIMITATION),
}).strict();
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const fileError = (): Error => new Error('Report file operation failed. Inspect existing local evidence before continuing.');

export interface JsonDocument { value: unknown; text: string; sha256: string; bytes: number }

/** Reject ambiguous keys before preserving raw bytes; JSON.parse alone discards earlier values. */
export function parseUnambiguousJson(text: string): unknown {
  try {
    const stack: { object: boolean; expectingKey: boolean; keys: Set<string> }[] = [];
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '"') {
        const start = index;
        while (++index < text.length) {
          if (text[index] === '\\') { index++; continue; }
          if (text[index] === '"') break;
        }
        const frame = stack.at(-1);
        if (frame?.object && frame.expectingKey) {
          const key = JSON.parse(text.slice(start, index + 1)) as string;
          if (frame.keys.has(key)) throw fileError();
          frame.keys.add(key); frame.expectingKey = false;
        }
      } else if (character === '{' || character === '[') {
        if (stack.length >= 128) throw fileError();
        stack.push({ object: character === '{', expectingKey: character === '{', keys: new Set() });
      } else if (character === '}' || character === ']') {
        stack.pop();
      } else if (character === ',') {
        const frame = stack.at(-1);
        if (frame?.object) frame.expectingKey = true;
      }
    }
    return JSON.parse(text);
  } catch { throw fileError(); }
}

/** Bounded reads also catch files that grow after stat; never follow the final symlink. */
export async function readBoundedJsonDocument(path: string, maxBytes: number): Promise<JsonDocument> {
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REPORT_BYTES) throw fileError();
    // NONBLOCK prevents a FIFO from hanging before the regular-file check.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) throw fileError();
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes + 1));
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - total + 1), null);
        if (bytesRead === 0) break;
        if (total + bytesRead > maxBytes) throw fileError();
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        total += bytesRead;
      }
      const bytes = Buffer.concat(chunks, total);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { value: parseUnambiguousJson(text), text, sha256: sha256(bytes), bytes: total };
    } finally { await file.close(); }
  } catch { throw fileError(); }
}

export async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  return (await readBoundedJsonDocument(path, maxBytes)).value;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writePrivateExclusive(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    try { await file.close(); }
    finally { await syncDirectory(await realpath(dirname(path))); }
  }
}

/** Failed writes are deliberately retained; an existing file is never replaced. */
export async function writePrivateJsonExclusive(path: string, value: unknown): Promise<void> {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) throw fileError();
    await writePrivateExclusive(path, serialized + '\n');
  } catch { throw fileError(); }
}

/** Reserve a new directory before a payment attempt, without reusing old evidence. */
export async function reserveReportDirectory(directory: string): Promise<void> {
  try {
    const requested = resolve(directory);
    await mkdir(requested, { mode: 0o700 });
    const handle = await open(requested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o700);
      await handle.sync();
      await syncDirectory(await realpath(dirname(requested)));
      await writePrivateJsonExclusive(join(requested, 'pending.json'), pendingRecord);
    } finally { await handle.close(); }
  } catch { throw fileError(); }
}

async function reservedDirectory(directory: string): Promise<string> {
  const requested = resolve(directory);
  const handle = await open(requested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (((await handle.stat()).mode & 0o777) !== 0o700) throw fileError();
    const canonical = await realpath(requested);
    pendingSchema.parse(await readBoundedJson(join(canonical, 'pending.json'), MAX_METADATA_BYTES));
    return canonical;
  } finally { await handle.close(); }
}

export interface ReportCapture {
  request: AuditRequest; reportText: string; reportSha256: string;
  requestSha256: string; resourceUrl: string;
}

/** Save the exact response bytes and canonical request; never persist signed payment headers. */
export async function saveReportCapture(directory: string, capture: ReportCapture): Promise<void> {
  try {
    const canonical = await reservedDirectory(directory);
    const request = parseAuditRequest(capture.request);
    const requestText = JSON.stringify(request);
    if (typeof capture.reportText !== 'string' || Buffer.byteLength(capture.reportText, 'utf8') > MAX_REPORT_BYTES) throw fileError();
    parseAuditReport(parseUnambiguousJson(capture.reportText));
    const manifest = reportManifestSchema.parse({
      schemaVersion: '1', status: 'captured', requestFile: 'request.json', reportFile: 'report.json',
      reportBytes: Buffer.byteLength(capture.reportText, 'utf8'),
      requestSha256: capture.requestSha256, reportSha256: capture.reportSha256,
      resourceUrl: capture.resourceUrl, limitation: CAPTURE_LIMITATION,
    });
    if (manifest.requestSha256 !== sha256(requestText) || manifest.reportSha256 !== sha256(capture.reportText)) throw fileError();
    await writePrivateExclusive(join(canonical, 'request.json'), requestText + '\n');
    await writePrivateExclusive(join(canonical, 'report.json'), capture.reportText);
    // Publish the completed manifest last; partial files plus pending remain on failure.
    await writePrivateJsonExclusive(join(canonical, 'manifest.json'), manifest);
  } catch { throw fileError(); }
}

const paymentSummarySchema = z.object({
  schemaVersion: z.literal('1'), status: z.enum(['verified', 'unknown', 'rejected']),
  code: z.string().regex(/^[a-zA-Z0-9_]{1,96}$/), requestSha256: digestSchema, resourceUrl: resourceSchema,
  httpStatus: z.number().int().min(100).max(599).optional(),
  transaction: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), reportSha256: digestSchema.optional(),
  limitation: z.literal(CAPTURE_LIMITATION),
}).strict();

/** Save an allowlisted public outcome only, never arbitrary receipts, headers or signatures. */
export async function finalizeReportCapture(directory: string, paymentEvidence: unknown): Promise<void> {
  try {
    const canonical = await reservedDirectory(directory);
    if (!paymentEvidence || typeof paymentEvidence !== 'object' || Array.isArray(paymentEvidence)) throw fileError();
    const evidence = paymentEvidence as Record<string, unknown>;
    const expectation = evidence.expectation as { transaction?: unknown } | undefined;
    const report = evidence.report as { sha256?: unknown } | undefined;
    const summary = paymentSummarySchema.parse({
      schemaVersion: '1', status: evidence.status, code: evidence.code,
      requestSha256: evidence.requestSha256, resourceUrl: evidence.resourceUrl,
      httpStatus: evidence.httpStatus, transaction: expectation?.transaction,
      reportSha256: report?.sha256, limitation: CAPTURE_LIMITATION,
    });
    await writePrivateJsonExclusive(join(canonical, 'payment.json'), summary);
  } catch { throw fileError(); }
}
