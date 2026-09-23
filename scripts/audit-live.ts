import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { parseAuditRequest } from '../src/validation.js';
import { collectEvidence } from '../src/rpc.js';
import { auditHistory } from '../src/audit.js';

try {
  const input = process.argv[2] ?? 'examples/request.json';
  const output = process.argv[3];
  const request = parseAuditRequest(JSON.parse(await readFile(input, 'utf8')));
  // The CLI performs read-only RPC calls directly; it is not a payment receipt.
  const config = await loadConfig({ ...process.env, AUDIT_MODE: 'local', HOST: '127.0.0.1' });
  const registry = config.registries.find(item => item.chainId === request.chainId && item.address.toLowerCase() === request.registry.toLowerCase());
  if (!registry) throw new Error('Requested registry is not configured.');
  const snapshot = await collectEvidence(request, registry);
  const report = auditHistory(snapshot, request.checkpoint);
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) { await writeFile(output, json); console.log(`Saved ${report.verdict} report to ${output}`); }
  else process.stdout.write(json);
  if (report.verdict !== 'consistent') process.exitCode = report.verdict === 'inconclusive' ? 2 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Audit failed');
  process.exitCode = 2;
}
