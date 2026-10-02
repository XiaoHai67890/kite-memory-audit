import { createHash } from 'node:crypto';
import { verifyAuditReport, reportPolicySchema, MAX_REPORT_BYTES } from '../src/report-verifier.js';
import { CAPTURE_LIMITATION, MAX_METADATA_BYTES, readBoundedJson, readBoundedJsonDocument, reportManifestSchema, writePrivateJsonExclusive } from '../src/report-files.js';
import { parseAuditRequest } from '../src/validation.js';

const usage = 'Usage: npm run report:verify -- POLICY REQUEST REPORT OUTPUT [MANIFEST]';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  if (args.length < 4 || args.length > 5) throw new Error(usage);
  const [policyPath, requestPath, reportPath, outputPath, manifestPath] = args as [string, string, string, string, string?];
  const policy = reportPolicySchema.parse(await readBoundedJson(policyPath, MAX_METADATA_BYTES));
  const request = parseAuditRequest(await readBoundedJson(requestPath, MAX_METADATA_BYTES));
  const report = await readBoundedJsonDocument(reportPath, MAX_REPORT_BYTES);
  let result = verifyAuditReport(request, report.value, policy);
  if (manifestPath) {
    const manifest = reportManifestSchema.parse(await readBoundedJson(manifestPath, MAX_METADATA_BYTES));
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const matches = manifest.requestSha256 === requestHash && manifest.reportSha256 === report.sha256
      && manifest.reportBytes === report.bytes;
    result = {
      ...result, ...(matches ? {} : { status: 'mismatch' as const, code: 'capture_digest_mismatch' }),
      checks: [...result.checks, { id: 'capture-manifest', status: matches ? 'pass' as const : 'fail' as const,
        message: matches ? 'Local file digests match the capture manifest; this is not authenticity proof.' : 'Local file bytes or canonical request do not match the capture manifest.' }],
      limitations: [...result.limitations, CAPTURE_LIMITATION],
    };
  }
  await writePrivateJsonExclusive(outputPath, result);
  if (result.status !== 'verified') process.exitCode = 2;
  console.log(`Saved offline report verification. Outcome: ${result.status}.`);
}

main().catch(() => {
  console.error('Report verification stopped. Check local arguments, bounded JSON inputs and existing output. No network or payment was attempted.');
  process.exitCode = 2;
});
