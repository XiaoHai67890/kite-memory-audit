import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt } from '../src/paid-client.js';
import { claimPaymentAttempt } from '../src/payment-journal.js';

const attempt: Attempt = {
  schemaVersion: '1', resourceUrl: 'https://audit.example.invalid/v1/memory/audit',
  requestSha256: 'a'.repeat(64), payer: `0x${'ab'.repeat(20)}`, network: 'testnet',
  payTo: `0x${'12'.repeat(20)}`, amount: '1000000000000000', nonce: `0x${'cd'.repeat(32)}`,
  validBefore: '2000000000', createdAt: '2026-09-27T00:00:00.000Z',
};
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kite-payment-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('concurrent claims allow exactly one sender across changed outputs, recipients and hex casing', async t => {
  const directory = join(await temporary(t), 'nested', 'attempts');
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => claimPaymentAttempt(directory, {
    ...attempt, resourceUrl: `https://merchant-${index}.example.invalid/v1/memory/audit`,
    requestSha256: String(index).padStart(64, '0'), payTo: `0x${String(index).padStart(40, '0')}`,
    payer: index % 2 ? '0x' + attempt.payer.slice(2).toUpperCase() : attempt.payer,
    nonce: index % 2 ? '0x' + attempt.nonce.slice(2).toUpperCase() : attempt.nonce,
  })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await readdir(directory)).length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'EEXIST');
});

test('a new process refuses a previously persisted nonce', async t => {
  const directory = join(await temporary(t), 'attempts');
  await claimPaymentAttempt(directory, attempt);
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import { claimPaymentAttempt } from './src/payment-journal.ts'; await claimPaymentAttempt(process.argv[1], JSON.parse(process.argv[2])).then(() => process.exitCode=0, error => process.exitCode=error.code === 'EEXIST' ? 2 : 3);",
    directory, JSON.stringify(attempt)], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 2);
});

test('journal uses private permissions, stores only public fields, and separates payment namespaces', async t => {
  const directory = join(await temporary(t), 'attempts');
  const withSecrets = { ...attempt, signature: 'DO_NOT_SAVE_SIGNATURE', payload: { signature: 'DO_NOT_SAVE_PAYLOAD' } };
  await claimPaymentAttempt(directory, withSecrets);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const [name] = await readdir(directory);
  assert(name);
  const path = join(directory, name);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const contents = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(contents), attempt);
  assert.doesNotMatch(contents, /DO_NOT_SAVE|signature|payload/);
  await claimPaymentAttempt(directory, { ...attempt, network: 'mainnet' });
  await claimPaymentAttempt(directory, { ...attempt, payer: `0x${'34'.repeat(20)}` });
  await claimPaymentAttempt(directory, { ...attempt, nonce: `0x${'56'.repeat(32)}` });
  assert.equal((await readdir(directory)).length, 4);
});

test('a partial write failure leaves an exclusive claim that blocks a retry', async t => {
  const directory = join(await temporary(t), 'attempts');
  const probe = await open(join(await temporary(t), 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const original = probe.writeFile;
  await probe.close();
  const failingWrite = t.mock.method(prototype, 'writeFile', async function(this: FileHandle) {
    await original.call(this, 'partial-attempt');
    throw new Error('Synthetic disk write failure');
  });
  await assert.rejects(claimPaymentAttempt(directory, attempt), /Synthetic disk write failure/);
  failingWrite.mock.restore();
  const [name] = await readdir(directory);
  assert(name);
  assert.equal(await readFile(join(directory, name), 'utf8'), 'partial-attempt');
  await assert.rejects(claimPaymentAttempt(directory, attempt), { code: 'EEXIST' });
});

test('an existing symlink cannot redirect the journal to another directory', async t => {
  const parent = await temporary(t);
  const target = await temporary(t);
  const link = join(parent, 'attempts');
  await symlink(target, link, 'dir');
  await assert.rejects(claimPaymentAttempt(link, attempt));
  assert.deepEqual(await readdir(target), []);
});
