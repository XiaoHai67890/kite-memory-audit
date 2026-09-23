import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = { AUDIT_MODE: 'local', HOST: '127.0.0.1', SEPOLIA_RPC_URL: 'https://rpc.example.invalid', REGISTRIES_FILE: 'config/registries.json' };
test('local development configuration is explicitly restricted to loopback', async () => {
  assert.equal((await loadConfig(base)).mode, 'local');
  await assert.rejects(loadConfig({ ...base, HOST: '0.0.0.0' }), /loopback/);
});
test('public mode requires a nonzero receiver and canonical HTTPS resource', async () => {
  const paid = { ...base, AUDIT_MODE: 'paid', HOST: '0.0.0.0', PAY_TO: `0x${'11'.repeat(20)}`, PUBLIC_BASE_URL: 'https://audit.example.invalid' };
  assert.equal((await loadConfig(paid)).network, 'testnet');
  for (const value of ['', `0x${'00'.repeat(20)}`]) await assert.rejects(loadConfig({ ...paid, PAY_TO: value }));
  for (const value of ['http://audit.example.invalid', 'https://audit.example.invalid/path', 'https://user:secret@audit.example.invalid', 'https://audit.example.invalid?secret=x']) {
    await assert.rejects(loadConfig({ ...paid, PUBLIC_BASE_URL: value }));
  }
});
test('RPC endpoint errors omit secret values; invalid prices and concurrency fail startup', async () => {
  await assert.rejects(loadConfig({ ...base, SEPOLIA_RPC_URL: 'secret-not-a-url' }), error => !String(error).includes('secret-not-a-url'));
  for (const value of ['0', '-1', 'NaN', '0.0000001']) await assert.rejects(loadConfig({ ...base, PRICE_USD: value }));
  for (const value of ['0', '17']) await assert.rejects(loadConfig({ ...base, MAX_CONCURRENT_AUDITS: value }));
});
