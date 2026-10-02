import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { reserveReportDirectory, saveReportCapture } from '../src/report-files.js';
import { parseAuditRequest } from '../src/validation.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'kite-report-cli-'));
  const networkLog = join(directory, 'network.log');
  t.after(async () => {
    try { await assert.rejects(access(networkLog)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const reportText = await readFile(new URL('../evidence/live-sepolia-report.json', import.meta.url), 'utf8');
  const request = parseAuditRequest(JSON.parse(reportText).subject);
  const policyPath = join(directory, 'policy.json'), requestPath = join(directory, 'request.json'), reportPath = join(directory, 'report.json');
  await writeFile(policyPath, await readFile(new URL('../config/report-policy.example.json', import.meta.url)));
  await writeFile(requestPath, JSON.stringify(request)); await writeFile(reportPath, reportText);
  const guardPath = join(directory, 'deny-network.mjs');
  await writeFile(guardPath, `import {appendFileSync} from 'node:fs'; import net from 'node:net'; const deny=()=>{appendFileSync(${JSON.stringify(networkLog)},'attempt');throw new Error('Network forbidden');};globalThis.fetch=deny;net.Socket.prototype.connect=deny;`);
  const run = (args: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', '--import', guardPath, 'scripts/report-verify.ts', ...args],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
  return { directory, reportText, request, policyPath, requestPath, reportPath, run };
}

test('offline CLI verifies the live evidence fixture without network and saves a private result', async t => {
  const f = await fixture(t), output = join(f.directory, 'verified.json');
  const result = f.run([f.policyPath, f.requestPath, f.reportPath, output]);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Outcome: verified/);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'verified');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test('optional capture manifest checks exact report bytes and the canonical request, not authenticity', async t => {
  const f = await fixture(t), captureDirectory = join(f.directory, 'capture');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  await reserveReportDirectory(captureDirectory);
  await saveReportCapture(captureDirectory, { request: f.request, reportText: f.reportText,
    reportSha256: hash(f.reportText), requestSha256: hash(JSON.stringify(f.request)), resourceUrl: 'https://audit.example.invalid/v1/memory/audit' });
  const manifest = join(captureDirectory, 'manifest.json');
  const output = join(f.directory, 'match.json');
  assert.equal(f.run([f.policyPath, f.requestPath, f.reportPath, output, manifest]).status, 0);
  const matched = JSON.parse(await readFile(output, 'utf8'));
  assert(matched.limitations.some((value: string) => value.includes('not a merchant signature')));
  await writeFile(f.reportPath, f.reportText + ' ');
  const changed = join(f.directory, 'changed.json');
  assert.equal(f.run([f.policyPath, f.requestPath, f.reportPath, changed, manifest]).status, 2);
  assert.equal(JSON.parse(await readFile(changed, 'utf8')).code, 'capture_digest_mismatch');
});

test('CLI rejects oversized and symlink inputs, preserves existing output and redacts local error content', async t => {
  const f = await fixture(t), output = join(f.directory, 'existing.json');
  await writeFile(output, 'PRESERVE');
  assert.equal(f.run([f.policyPath, f.requestPath, f.reportPath, output]).status, 2);
  assert.equal(await readFile(output, 'utf8'), 'PRESERVE');
  const invalid = join(f.directory, 'SECRET_PATH.json'); await writeFile(invalid, 'SECRET_CONTENT');
  const bad = f.run([f.policyPath, invalid, f.reportPath, join(f.directory, 'bad.json')]);
  assert.equal(bad.status, 2); assert.doesNotMatch(bad.stderr, /SECRET_|SyntaxError/);
  const link = join(f.directory, 'report-link.json'); await symlink(f.reportPath, link);
  assert.equal(f.run([f.policyPath, f.requestPath, link, join(f.directory, 'link-output.json')]).status, 2);
  const large = join(f.directory, 'large.json'); await writeFile(large, ' '.repeat(4_000_001));
  assert.equal(f.run([f.policyPath, f.requestPath, large, join(f.directory, 'large-output.json')]).status, 2);
  const duplicate = join(f.directory, 'duplicate.json');
  await writeFile(duplicate, '{"schemaVersion":{"signature":"SECRET_HIDDEN"},' + f.reportText.trimStart().slice(1));
  const duplicateResult = f.run([f.policyPath, f.requestPath, duplicate, join(f.directory, 'duplicate-output.json')]);
  assert.equal(duplicateResult.status, 2); assert.doesNotMatch(duplicateResult.stderr, /SECRET_HIDDEN/);
  await assert.rejects(access(join(f.directory, 'bad.json')));
  await assert.rejects(access(join(f.directory, 'link-output.json')));
  await assert.rejects(access(join(f.directory, 'large-output.json')));
  await assert.rejects(access(join(f.directory, 'duplicate-output.json')));
});

test('CLI reports a changed report as nonverified and supports help without reading inputs', async t => {
  const f = await fixture(t), changed = JSON.parse(f.reportText), output = join(f.directory, 'changed.json');
  changed.summary.transitionCount += 1;
  await writeFile(f.reportPath, JSON.stringify(changed));
  assert.equal(f.run([f.policyPath, f.requestPath, f.reportPath, output]).status, 2);
  assert.notEqual(JSON.parse(await readFile(output, 'utf8')).status, 'verified');
  const help = f.run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /POLICY REQUEST REPORT OUTPUT \[MANIFEST\]/);
  assert.equal(f.run([]).status, 2);
});
