import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { KITE_TESTNET } from '../src/kite.js';

test('hosted entrypoint refuses unpaid mode even with a loopback HOST setting', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./app.ts')"], {
    cwd: process.cwd(),
    env: { ...process.env, AUDIT_MODE: 'local', HOST: '127.0.0.1' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Local mode must bind a loopback host/);
});

test('hosted export preserves paid routing and captures the configured receiver and HTTPS origin', async t => {
  // Offline HTTP facilitator, not a real payment or a deployment simulation.
  const calls: string[] = [];
  const facilitator = createServer((req, res) => {
    calls.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/supported') {
      res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: KITE_TESTNET.network }], extensions: [], signers: {} }));
    } else {
      res.statusCode = 500;
      res.end('{}');
    }
  });
  facilitator.listen(0, '127.0.0.1');
  await once(facilitator, 'listening');
  t.after(() => new Promise<void>(resolve => { facilitator.closeAllConnections(); facilitator.close(() => resolve()); }));
  const address = facilitator.address();
  assert(address && typeof address !== 'string');

  const receiver = `0x${'11'.repeat(20)}`;
  const origin = 'https://memory-audit.example.invalid';
  const settings = {
    AUDIT_MODE: 'paid', HOST: '127.0.0.1', KITE_NETWORK: 'testnet', PAY_TO: receiver,
    PUBLIC_BASE_URL: origin, PRICE_USD: '0.001', REGISTRIES_FILE: 'config/registries.json',
    SEPOLIA_RPC_URL: 'https://rpc.example.invalid', MAX_CONCURRENT_AUDITS: '2',
    FACILITATOR_URL: `http://127.0.0.1:${address.port}`,
  };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, settings);
  const { default: app } = await import('../app.js');
  process.env.PAY_TO = `0x${'22'.repeat(20)}`;
  process.env.PUBLIC_BASE_URL = 'https://changed.example.invalid';
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const serverAddress = server.address();
  assert(serverAddress && typeof serverAddress !== 'string');
  const base = `http://127.0.0.1:${serverAddress.port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal((await health.json()).mode, 'paid');
  assert.equal(health.headers.get('x-powered-by'), null);

  const body = await readFile('examples/request.json', 'utf8');
  const response = await fetch(`${base}/v1/memory/audit`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', host: 'attacker.example.invalid', 'x-forwarded-host': 'attacker.example.invalid' },
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('x-audit-payment-mode'), null);
  const required = decodePaymentRequiredHeader(response.headers.get('payment-required')!);
  assert.equal(required.resource.url, `${origin}/v1/memory/audit`);
  assert.equal(required.accepts[0]?.payTo, receiver);
  assert.equal(required.accepts[0]?.network, KITE_TESTNET.network);
  for (const route of ['/v1/memory/audit/', '/V1/MEMORY/AUDIT']) {
    assert.equal((await fetch(base + route, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 404);
  }
  assert(calls.length > 0);
  assert(calls.every(path => path === '/supported'));
});
