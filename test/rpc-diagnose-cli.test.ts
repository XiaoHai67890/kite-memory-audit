import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDiagnosticCLI } from '../scripts/rpc-diagnose.js';
import { loadDiagnosticSources } from '../src/diagnostic-config.js';
import type { RpcDiagnosticsResult } from '../src/rpc-diagnostics.js';
import { parseAuditReport } from '../src/report-verifier.js';
import { parseAuditRequest } from '../src/validation.js';

const config = JSON.parse(await readFile(new URL('../config/rpc-diagnostics.example.json', import.meta.url), 'utf8'));
const report = parseAuditReport(JSON.parse(await readFile(new URL('../evidence/live-sepolia-report.json', import.meta.url), 'utf8')));
const request = parseAuditRequest(report.subject);
const environment = {
  SEPOLIA_RPC_PRIMARY: 'https://primary.example.invalid/rpc?token=PRIVATE_PRIMARY_TOKEN',
  SEPOLIA_RPC_SECONDARY: 'https://secondary.example.invalid/rpc/PRIVATE_SECONDARY_TOKEN',
};
const redactedError = /^Invalid diagnostic configuration or independently configured RPC sources\.$/;

function diagnostic(status: RpcDiagnosticsResult['status'] = 'agree'): RpcDiagnosticsResult {
  return {
    schemaVersion: '1', status, code: status === 'agree' ? 'SOURCES_AGREE' : 'SOURCES_INCONCLUSIVE', request,
    selectedBlock: { number: report.evidence.block.number },
    sources: [
      { id: 'primary', code: 'REPORT_COLLECTED', requestCount: 9, finalizedBlock: report.evidence.block,
        report: { ...report, evidence: { ...report.evidence, rpcLabel: 'primary' } } },
      { id: 'secondary', code: 'REPORT_COLLECTED', requestCount: 9, finalizedBlock: report.evidence.block,
        report: { ...report, evidence: { ...report.evidence, rpcLabel: 'secondary' } } },
    ],
    comparison: { performed: true, differences: [], missingFromPrimary: [], missingFromSecondary: [], changedEvents: [] },
    limitations: ['Agreement compares configured sources, not independently proven chain state.'],
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'kite-rpc-diagnose-cli-'));
  const networkLog = join(directory, 'network.log');
  t.after(async () => {
    try { await assert.rejects(access(networkLog)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const configPath = join(directory, 'config.json'), requestPath = join(directory, 'request.json');
  await writeFile(configPath, JSON.stringify(config)); await writeFile(requestPath, JSON.stringify(request));
  const guardPath = join(directory, 'deny-network.mjs');
  await writeFile(guardPath, `import {appendFileSync} from 'node:fs'; import net from 'node:net'; const deny=()=>{appendFileSync(${JSON.stringify(networkLog)},'attempt');throw new Error('Network forbidden');};globalThis.fetch=deny;net.Socket.prototype.connect=deny;`);
  const runChild = (args: string[], overrides: Record<string, string> = {}, preload = guardPath) => spawnSync(process.execPath,
    ['--import', 'tsx', '--import', preload, 'scripts/rpc-diagnose.ts', ...args],
    { cwd: process.cwd(), env: { ...process.env, ...environment, ...overrides }, encoding: 'utf8', timeout: 15_000 });
  return { directory, configPath, requestPath, networkLog, runChild };
}

test('diagnostic config resolves only environment endpoints and exposes bounded options with safe source labels', () => {
  const sources = loadDiagnosticSources(config, environment);
  assert.deepEqual(sources.map(source => source.id), ['primary', 'secondary']);
  assert.equal(sources[0].registry.rpcUrl, environment.SEPOLIA_RPC_PRIMARY);
  assert.equal(sources[1].registry.rpcUrl, environment.SEPOLIA_RPC_SECONDARY);
  assert.equal(sources[0].registry.label, 'primary');
  assert.equal(sources[1].registry.source, 'Independent local diagnostic registry policy');
  assert.deepEqual(sources[0].options, { maxRequests: 128, requestTimeoutMs: 10_000, totalTimeoutMs: 45_000 });
  assert.notEqual(sources[0].options, sources[1].options);
  assert.equal(Object.hasOwn(sources[0], 'rpcEnv'), false);
});

test('strict diagnostic config rejects extra keys, invalid pins, repeated sources and unreasonable limits', () => {
  const invalid = [
    { ...config, url: 'https://PRIVATE_URL.invalid' },
    { ...config, registry: { ...config.registry, rpcUrl: 'https://PRIVATE_URL.invalid' } },
    { ...config, registry: { ...config.registry, expectedCodeHash: '0x' + '00'.repeat(32) } },
    { ...config, registry: { ...config.registry, address: '0x' + '00'.repeat(20) } },
    { ...config, registry: { ...config.registry, fromBlock: '01' } },
    { ...config, sources: config.sources.slice(0, 1) },
    { ...config, sources: [...config.sources, config.sources[0]] },
    { ...config, sources: [config.sources[1], config.sources[0]] },
    { ...config, sources: [config.sources[0], { ...config.sources[1], rpcEnv: config.sources[0].rpcEnv }] },
    { ...config, sources: [{ ...config.sources[0], url: 'https://PRIVATE_URL.invalid' }, config.sources[1]] },
    { ...config, sources: [{ ...config.sources[0], rpcEnv: 'invalid env' }, config.sources[1]] },
    { ...config, limits: { maxRequests: 513 } }, { ...config, limits: { requestTimeoutMs: 30_001 } },
    { ...config, limits: { totalTimeoutMs: 120_001 } }, { ...config, limits: { maxRequests: 0 } },
    { ...config, limits: { maxRequests: 1.5 } }, { ...config, limits: { unknown: 1 } },
    { ...config, limits: { requestTimeoutMs: 10_000, totalTimeoutMs: 9_000 } },
  ];
  for (const input of invalid) assert.throws(() => loadDiagnosticSources(input, environment), { message: redactedError });
});

test('endpoint policy rejects missing URLs, credentials, non-HTTPS, fragments and same host/path despite query differences', () => {
  for (const endpoint of [undefined, '', 'http://localhost/rpc', 'ftp://PRIVATE_URL.invalid/rpc',
    'https://user:PRIVATE_SECRET@rpc.example.invalid/', 'https://rpc.example.invalid/rpc#PRIVATE_SECRET',
    'https://rpc.example.invalid/rpc#', ' https://rpc.example.invalid/', 'https://rpc.example.invalid/\n',
    'PRIVATE_NOT_A_URL']) {
    assert.throws(() => loadDiagnosticSources(config, { ...environment, SEPOLIA_RPC_PRIMARY: endpoint }), { message: redactedError });
  }
  for (const second of ['https://primary.example.invalid/rpc?token=DIFFERENT_SECRET',
    'https://PRIMARY.example.invalid:443/rpc', 'https://primary.example.invalid./rpc']) {
    assert.throws(() => loadDiagnosticSources(config, { ...environment, SEPOLIA_RPC_SECONDARY: second }), { message: redactedError });
  }
  // Distinct paths are accepted as configured endpoints, not certified provider independence.
  assert.equal(loadDiagnosticSources(config, { ...environment, SEPOLIA_RPC_SECONDARY: 'https://primary.example.invalid/other-rpc' }).length, 2);
});

test('CLI help, bad configuration and bounded inputs stop before any network or output', async t => {
  const f = await fixture(t);
  const help = f.runChild(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /CONFIG REQUEST NEW_OUTPUT/);
  assert.match(help.stdout, /not an independent on-chain proof/);
  assert.equal(f.runChild([]).status, 2);
  const output = join(f.directory, 'output.json');
  for (const endpoint of ['', 'http://PRIVATE_HOST.invalid/rpc', 'https://user:PRIVATE_SECRET@rpc.example.invalid/rpc',
    environment.SEPOLIA_RPC_SECONDARY]) {
    const result = f.runChild([f.configPath, f.requestPath, output], { SEPOLIA_RPC_PRIMARY: endpoint });
    assert.equal(result.status, 2); assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE_|https?:/);
  }
  await writeFile(f.configPath, ' '.repeat(65_537));
  assert.equal(f.runChild([f.configPath, f.requestPath, output]).status, 2);
  await writeFile(f.configPath, JSON.stringify(config)); await writeFile(f.requestPath, 'PRIVATE_BAD_JSON');
  const malformed = f.runChild([f.configPath, f.requestPath, output]);
  assert.equal(malformed.status, 2); assert.doesNotMatch(malformed.stderr, /PRIVATE_BAD_JSON|SyntaxError/);
  await assert.rejects(access(output));
});

test('CLI refuses existing output, input overwrite and both existing and dangling symlinks before networking', async t => {
  const f = await fixture(t), output = join(f.directory, 'existing.json');
  await writeFile(output, 'PRESERVE_REPORT');
  assert.equal(f.runChild([f.configPath, f.requestPath, output]).status, 2);
  assert.equal(await readFile(output, 'utf8'), 'PRESERVE_REPORT');
  const before = await readFile(f.requestPath, 'utf8');
  assert.equal(f.runChild([f.configPath, f.requestPath, f.requestPath]).status, 2);
  assert.equal(await readFile(f.requestPath, 'utf8'), before);
  const link = join(f.directory, 'link.json'); await symlink(output, link);
  assert.equal(f.runChild([f.configPath, f.requestPath, link]).status, 2);
  const dangling = join(f.directory, 'dangling.json'), missing = join(f.directory, 'missing.json'); await symlink(missing, dangling);
  assert.equal(f.runChild([f.configPath, f.requestPath, dangling]).status, 2);
  await assert.rejects(access(missing));
  const inputLink = join(f.directory, 'input-link.json'); await symlink(f.requestPath, inputLink);
  assert.equal(f.runChild([f.configPath, inputLink, join(f.directory, 'new.json')]).status, 2);
});

test('injected offline diagnosis observes private pending output and saves both full reports without endpoint secrets', async t => {
  const f = await fixture(t), output = join(f.directory, 'diagnostic.json');
  const messages: string[] = []; let calls = 0;
  const requested = parseAuditRequest({ ...request, atBlock: report.evidence.block.number, checkpoint: report.evidence.head });
  await writeFile(f.requestPath, JSON.stringify(requested));
  const result = { ...diagnostic(), request: requested };
  const exit = await runDiagnosticCLI([f.configPath, f.requestPath, output], { environment,
    stdout: value => messages.push(value), stderr: value => messages.push(value),
    diagnose: async (input, sources) => {
      calls++; assert.deepEqual(input, requested);
      assert.equal(sources[0].registry.rpcUrl, environment.SEPOLIA_RPC_PRIMARY);
      assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'pending');
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      return result;
    },
  });
  assert.equal(exit, 0); assert.equal(calls, 1);
  const text = await readFile(output, 'utf8'); assert.deepEqual(JSON.parse(text), result);
  assert.equal(JSON.parse(text).sources.length, 2);
  assert.equal(JSON.parse(text).sources[1].report.evidence.events.length, report.evidence.events.length);
  assert.doesNotMatch(text + messages.join('\n'), /PRIVATE_|example\.invalid|SEPOLIA_RPC_/);
  assert.match(messages.join('\n'), /not an independent on-chain proof/);
});

test('every non-agree status exits 2 and a thrown diagnostic retains private pending evidence without leaking errors', async t => {
  const f = await fixture(t), messages: string[] = [];
  for (const status of ['divergent', 'inconclusive', 'unavailable'] as const) {
    const output = join(f.directory, status + '.json');
    assert.equal(await runDiagnosticCLI([f.configPath, f.requestPath, output], { environment,
      diagnose: async () => diagnostic(status), stdout: value => messages.push(value), stderr: value => messages.push(value) }), 2);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).status, status);
  }
  const output = join(f.directory, 'thrown.json');
  assert.equal(await runDiagnosticCLI([f.configPath, f.requestPath, output], { environment,
    diagnose: async () => { throw new Error('PRIVATE_RPC_ERROR ' + environment.SEPOLIA_RPC_PRIMARY); },
    stdout: value => messages.push(value), stderr: value => messages.push(value) }), 2);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'pending');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.doesNotMatch(messages.join('\n'), /PRIVATE_|https:\/\//);
});

test('concurrent CLI runs only diagnose once, and replacing the reserved path cannot overwrite another report', async t => {
  const f = await fixture(t), output = join(f.directory, 'concurrent.json');
  let calls = 0;
  const options = { environment, stdout: () => {}, stderr: () => {}, diagnose: async () => { calls++; return diagnostic(); } };
  const codes = await Promise.all(Array.from({ length: 6 }, () => runDiagnosticCLI([f.configPath, f.requestPath, output], options)));
  assert.equal(calls, 1); assert.equal(codes.filter(code => code === 0).length, 1);
  const replaced = join(f.directory, 'replaced.json'), retained = join(f.directory, 'retained-pending.json');
  const victim = join(f.directory, 'other-report.json'); await writeFile(victim, 'PRESERVE_OTHER_REPORT');
  assert.equal(await runDiagnosticCLI([f.configPath, f.requestPath, replaced], { ...options, diagnose: async () => {
    await rename(replaced, retained); await symlink(victim, replaced); return diagnostic();
  } }), 2);
  assert.equal(await readFile(victim, 'utf8'), 'PRESERVE_OTHER_REPORT');
  assert.equal(JSON.parse(await readFile(retained, 'utf8')).status, 'pending');
});

test('CLI rejects a request outside the pinned registry or before deployment without diagnosis', async t => {
  const f = await fixture(t); let calls = 0;
  for (const changed of [{ ...request, chainId: 1 }, { ...request, registry: '0x' + '12'.repeat(20) },
    { ...request, atBlock: '1' }]) {
    await writeFile(f.requestPath, JSON.stringify(changed));
    const output = join(f.directory, 'mismatch.json');
    assert.equal(await runDiagnosticCLI([f.configPath, f.requestPath, output], { environment,
      diagnose: async () => { calls++; return diagnostic(); }, stdout: () => {}, stderr: () => {} }), 2);
    await assert.rejects(access(output));
  }
  assert.equal(calls, 0);
});
