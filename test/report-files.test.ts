import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CAPTURE_LIMITATION, finalizeReportCapture, parseUnambiguousJson, readBoundedJson, readBoundedJsonDocument, reserveReportDirectory, saveReportCapture, writePrivateJsonExclusive } from '../src/report-files.js';
import { parseAuditRequest } from '../src/validation.js';
import { MAX_REPORT_BYTES } from '../src/report-verifier.js';

const reportText = await readFile(new URL('../evidence/live-sepolia-report.json', import.meta.url), 'utf8');
const request = parseAuditRequest(JSON.parse(reportText).subject);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const capture = { request, reportText, reportSha256: hash(reportText),
  requestSha256: hash(JSON.stringify(request)), resourceUrl: 'https://audit.example.invalid/v1/memory/audit' };

async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kite-report-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('bounded JSON reads preserve exact byte digest and reject oversized, invalid UTF-8 and non-files', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'input.json');
  const text = '{"name":"界"}\n';
  await writeFile(path, text);
  const document = await readBoundedJsonDocument(path, Buffer.byteLength(text));
  assert.deepEqual(document.value, { name: '界' }); assert.equal(document.text, text);
  assert.equal(document.sha256, hash(text)); assert.equal(document.bytes, Buffer.byteLength(text));
  await assert.rejects(readBoundedJson(path, Buffer.byteLength(text) - 1), /Report file operation failed/);
  await writeFile(path, Buffer.from([0x22, 0xc0, 0xaf, 0x22]));
  await assert.rejects(readBoundedJson(path, 64));
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"BOM"}')]));
  await assert.rejects(readBoundedJson(path, 64), /Report file operation failed/);
  await assert.rejects(readBoundedJson(directory, 64));
  await assert.rejects(readBoundedJson(path, MAX_REPORT_BYTES + 1));
});

test('actual read bounds cannot be bypassed by a stale smaller stat size', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'grown.json');
  await writeFile(path, '"' + 'x'.repeat(128) + '"');
  const probe = await open(path, 'r');
  const prototype = Object.getPrototypeOf(probe), original = probe.stat;
  await probe.close();
  const stale = t.mock.method(prototype, 'stat', async function(this: FileHandle) {
    const value = await original.call(this); value.size = 2; return value;
  });
  await assert.rejects(readBoundedJson(path, 64), /Report file operation failed/);
  stale.mock.restore();
});

test('raw JSON rejects duplicate and escaped-equivalent keys rather than retaining hidden secret fields', async t => {
  const directory = join(await temporary(t), 'capture');
  await reserveReportDirectory(directory);
  const hidden = '{"schemaVersion":{"PAYMENT-SIGNATURE":"SECRET_HIDDEN_SIGNATURE"},' + reportText.trimStart().slice(1);
  // Ordinary JSON parsing would silently discard the first schemaVersion.
  assert.equal(JSON.parse(hidden).schemaVersion, '1');
  await assert.rejects(saveReportCapture(directory, { ...capture, reportText: hidden, reportSha256: hash(hidden) }));
  assert.deepEqual(await readdir(directory), ['pending.json']);
  const path = join(await temporary(t), 'duplicate.json');
  await writeFile(path, '{"a":{"x":"SECRET"},"\\u0061":1}');
  await assert.rejects(readBoundedJson(path, 1024));
  assert.throws(() => parseUnambiguousJson('{"nested":{"x":1,"x":2}}'));
  assert.throws(() => parseUnambiguousJson('['.repeat(129) + '0' + ']'.repeat(129)));
  assert.deepEqual(parseUnambiguousJson('{"a":[{"x":"escaped \\\" brace } comma ,"},{"x":2}],"b":{"x":3}}'),
    { a: [{ x: 'escaped " brace } comma ,' }, { x: 2 }], b: { x: 3 } });
});

test('file helpers never follow final symlinks or overwrite files, and redact parser details', async t => {
  const directory = await temporary(t);
  const target = join(directory, 'target.json'), link = join(directory, 'link.json');
  await writeFile(target, '{"marker":"secret-input"}');
  await symlink(target, link);
  await assert.rejects(readBoundedJson(link, 1024));
  await assert.rejects(writePrivateJsonExclusive(link, { replacement: true }));
  await assert.rejects(writePrivateJsonExclusive(target, { replacement: true }));
  assert.equal(await readFile(target, 'utf8'), '{"marker":"secret-input"}');
  const invalid = join(directory, 'private-secret-path.json');
  await writeFile(invalid, 'secret-input');
  await assert.rejects(readBoundedJson(invalid, 1024), error => {
    assert(error instanceof Error); assert.doesNotMatch(error.message, /secret-input|private-secret-path/); return true;
  });
});

test('private exclusive output permits only one concurrent writer', async t => {
  const path = join(await temporary(t), 'output.json');
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, id) => writePrivateJsonExclusive(path, { id })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(typeof JSON.parse(await readFile(path, 'utf8')).id, 'number');
});

test('capture reservation is exclusive and writes a private permanent start record', async t => {
  const directory = join(await temporary(t), 'capture');
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveReportDirectory(directory)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'pending.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8')).status, 'pending');
  await assert.rejects(reserveReportDirectory(directory));
});

test('capture preserves exact report text, canonical request, public digests and safe payment summary', async t => {
  const directory = join(await temporary(t), 'capture');
  await reserveReportDirectory(directory);
  const withSecrets = { ...capture, signature: 'SECRET_SIGNATURE', headers: { authorization: 'SECRET_HEADER' } };
  await saveReportCapture(directory, withSecrets);
  assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), reportText);
  assert.equal(await readFile(join(directory, 'request.json'), 'utf8'), JSON.stringify(request) + '\n');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.reportSha256, hash(reportText)); assert.equal(manifest.requestSha256, hash(JSON.stringify(request)));
  assert.equal(manifest.reportBytes, Buffer.byteLength(reportText)); assert.equal(manifest.limitation, CAPTURE_LIMITATION);
  await finalizeReportCapture(directory, { schemaVersion: '1', status: 'unknown', code: 'settlement_not_verified',
    requestSha256: capture.requestSha256, resourceUrl: capture.resourceUrl, httpStatus: 200,
    expectation: { transaction: '0x' + '12'.repeat(32), signature: 'SECRET_SIGNATURE' },
    report: { sha256: capture.reportSha256, raw: 'SECRET_RAW_RESPONSE' },
    receipt: { headers: 'SECRET_HEADER' }, limitations: ['SECRET_SERVER_TEXT'], signature: 'SECRET_SIGNATURE' });
  const summaryText = await readFile(join(directory, 'payment.json'), 'utf8');
  assert.doesNotMatch(summaryText, /SECRET_|"signature"|"headers"|"receipt"/);
  assert.equal(JSON.parse(summaryText).transaction, '0x' + '12'.repeat(32));
  for (const name of await readdir(directory)) {
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /SECRET_/);
  }
  assert.equal(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8')).status, 'pending');
  await assert.rejects(saveReportCapture(directory, capture));
  await assert.rejects(finalizeReportCapture(directory, { status: 'unknown' }));
});

test('capture rejects changed digests, credential URLs and malformed or oversized reports before writing data', async t => {
  const directory = join(await temporary(t), 'capture');
  await reserveReportDirectory(directory);
  for (const change of [
    { reportSha256: '0'.repeat(64) }, { requestSha256: '0'.repeat(64) },
    { resourceUrl: 'https://user:SECRET_PASSWORD@audit.example.invalid/v1/memory/audit' },
    { resourceUrl: 'https://audit.example.invalid/v1/memory/audit?token=SECRET_TOKEN' },
    { reportText: '{}' }, { reportText: '界'.repeat(Math.ceil(MAX_REPORT_BYTES / 3) + 1) },
  ]) await assert.rejects(saveReportCapture(directory, { ...capture, ...change }));
  assert.deepEqual(await readdir(directory), ['pending.json']);
});

test('capture refuses unreserved directories and symlinked directories or output files', async t => {
  const parent = await temporary(t), directory = join(parent, 'capture');
  await assert.rejects(saveReportCapture(parent, capture));
  await reserveReportDirectory(directory);
  const link = join(parent, 'capture-link');
  await symlink(directory, link, 'dir');
  await assert.rejects(saveReportCapture(link, capture));
  const target = join(parent, 'untouched.json'); await writeFile(target, 'untouched');
  await symlink(target, join(directory, 'request.json'));
  await assert.rejects(saveReportCapture(directory, capture));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.deepEqual((await readdir(directory)).sort(), ['pending.json', 'request.json']);
});

test('a report write failure retains pending and partial files, and a retry cannot overwrite them', async t => {
  const directory = join(await temporary(t), 'capture');
  await reserveReportDirectory(directory);
  const probe = await open(join(await temporary(t), 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), original = probe.writeFile;
  await probe.close();
  let writes = 0;
  const failing = t.mock.method(prototype, 'writeFile', async function(this: FileHandle, data: string) {
    writes++;
    if (writes === 2) { await original.call(this, 'partial-report'); throw new Error('SECRET_DISK_ERROR'); }
    await original.call(this, data);
  });
  await assert.rejects(saveReportCapture(directory, capture), error => {
    assert(error instanceof Error); assert.doesNotMatch(error.message, /SECRET_/); return true;
  });
  failing.mock.restore();
  assert.deepEqual((await readdir(directory)).sort(), ['pending.json', 'report.json', 'request.json']);
  assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), 'partial-report');
  await assert.rejects(saveReportCapture(directory, capture));
  assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), 'partial-report');
});
