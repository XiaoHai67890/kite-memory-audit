import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { EvidenceSnapshot } from '../src/types.js';
import { ServiceError } from '../src/errors.js';

const hash = `0x${'11'.repeat(32)}` as const;
const zero = `0x${'00'.repeat(32)}` as const;
const address = `0x${'11'.repeat(20)}` as const;
const request = { chainId: 11155111, registry: address, spaceId: hash };
const config: AppConfig = {
  mode: 'local', host: '127.0.0.1', port: 8080, network: 'testnet', priceUsd: '0.001', maxConcurrent: 2,
  registries: [{ chainId: 11155111, address, fromBlock: '0', expectedCodeHash: hash,
    rpcUrl: 'https://rpc.example.invalid/SECRET', label: 'fixture', source: 'https://example.invalid/contract' }],
};
function snapshot(): EvidenceSnapshot {
  return { ...request, block: { number: '2', hash, timestamp: '100' },
    registryEvidence: { fromBlock: '0', actualCodeHash: hash, expectedCodeHash: hash, source: 'https://example.invalid/contract' },
    head: { sequence: '0', stateRoot: zero, transitionId: zero },
    authorization: { controller: address, authorizer: address, configNonce: '0' }, rpcLabel: 'fixture',
    events: [{ type: 'registered', controller: address, authorizer: address, blockNumber: '1', blockHash: hash, transactionHash: hash, transactionIndex: 0, logIndex: 0 }],
  };
}
async function serve(t: TestContext, options: Parameters<typeof createApp>[1] = {}, conf = config) {
  const server = createApp(conf, options).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  return `http://127.0.0.1:${addr.port}`;
}
const post = (url: string, body: unknown, path = '/v1/memory/audit') => fetch(url + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('local API returns a complete report without exposing RPC URL', async t => {
  const url = await serve(t, { collect: async () => snapshot() });
  const response = await post(url, request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-audit-payment-mode'), 'local-unpaid');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).verdict, 'consistent');
  const registries = await (await fetch(url + '/v1/registries')).text();
  assert(!registries.includes('SECRET'));
  assert(!registries.includes('rpcUrl'));
});
test('validation rejects arbitrary URLs, private payloads, numbers, and unknown registry before payment or RPC', async t => {
  let paid = 0, queried = 0;
  const url = await serve(t, { payment: (_req, _res, next) => { paid++; next(); }, collect: async () => { queried++; return snapshot(); } },
    { ...config, mode: 'paid', payTo: address, publicBaseUrl: 'https://example.invalid' });
  for (const body of [
    { ...request, rpcUrl: 'http://169.254.169.254' }, { ...request, memory: 'private contents' },
    { ...request, atBlock: 2 }, { ...request, atBlock: '18446744073709551616' },
    { ...request, checkpoint: { sequence: 1, stateRoot: hash } }, { ...request, chainId: 1 },
  ]) assert.equal((await post(url, body)).status, 400);
  assert.equal(paid, 0); assert.equal(queried, 0);
});
test('malformed JSON, oversize bodies, query strings, methods, case and trailing-slash paths cannot reach collector', async t => {
  let queries = 0;
  const url = await serve(t, { collect: async () => { queries++; return snapshot(); } });
  assert.equal((await fetch(url + '/v1/memory/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post(url, { ...request, padding: 'a'.repeat(9000) })).status, 413);
  assert.equal((await post(url, request, '/v1/memory/audit?x=1')).status, 400);
  for (const path of ['/v1/memory/audit/', '/V1/MEMORY/AUDIT']) assert.equal((await post(url, request, path)).status, 404);
  assert.equal((await fetch(url + '/v1/memory/audit')).status, 404);
  assert.equal(queries, 0);
});
test('incomplete history is 503, including a mixed contradictory checkpoint', async t => {
  const value = snapshot(); value.events = [];
  const url = await serve(t, { collect: async () => value });
  assert.equal((await post(url, request)).status, 503);
  const result = await post(url, { ...request, checkpoint: { sequence: '0', stateRoot: hash } });
  assert.equal(result.status, 503);
  const report = await result.json();
  assert(report.checks.some((check: { status: string }) => check.status === 'unknown'));
});
test('complete contradictory checkpoint is a successfully delivered audit', async t => {
  const url = await serve(t, { collect: async () => snapshot() });
  const response = await post(url, { ...request, checkpoint: { sequence: '0', stateRoot: hash } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verdict, 'inconsistent');
});
test('unknown space is 404 and unexpected errors never disclose provider credentials', async t => {
  let unknown = true;
  const url = await serve(t, { collect: async () => { if (unknown) throw new ServiceError('UNKNOWN_SPACE', 'Space not registered.', 404); throw new Error('https://SECRET@rpc.invalid'); } });
  assert.equal((await post(url, request)).status, 404);
  unknown = false;
  const response = await post(url, request);
  assert.equal(response.status, 503);
  assert(!(await response.text()).includes('SECRET'));
});
