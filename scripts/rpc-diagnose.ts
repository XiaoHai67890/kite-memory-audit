import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDiagnosticSources } from '../src/diagnostic-config.js';
import { diagnoseRpcSources } from '../src/rpc-diagnostics.js';
import { MAX_METADATA_BYTES, readBoundedJson } from '../src/report-files.js';
import { parseAuditRequest } from '../src/validation.js';

const usage = 'Usage: npm run rpc:diagnose -- CONFIG REQUEST NEW_OUTPUT';
const comparisonNotice = 'Agreement compares configured RPC sources; it is not an independent on-chain proof.';
interface CliDependencies {
  environment?: Readonly<Record<string, string | undefined>>;
  diagnose?: typeof diagnoseRpcSources;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Dependency injection is for offline tests; the command has no network-policy bypass flag. */
export async function runDiagnosticCLI(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  try {
    if (args.length === 1 && args[0] === '--help') { stdout(usage + '\n' + comparisonNotice); return 0; }
    if (args.length !== 3 || args.some(argument => argument.length === 0)) throw new Error('Invalid arguments.');
    const [configPath, requestPath, outputPath] = args as [string, string, string];
    const sources = loadDiagnosticSources(await readBoundedJson(configPath, MAX_METADATA_BYTES), dependencies.environment);
    const request = parseAuditRequest(await readBoundedJson(requestPath, MAX_METADATA_BYTES));
    const registry = sources[0].registry;
    if (request.chainId !== registry.chainId || request.registry.toLowerCase() !== registry.address.toLowerCase()
      || (request.atBlock !== undefined && BigInt(request.atBlock) < BigInt(registry.fromBlock))) {
      throw new Error('Request does not match independent registry policy.');
    }

    // Hold the exclusively created inode through completion, so final writes cannot
    // follow a replaced output path or overwrite another run's report.
    const output = await open(outputPath, 'wx', 0o600);
    try {
      await output.chmod(0o600);
      const reserved = await output.stat();
      await output.writeFile(JSON.stringify({ schemaVersion: '1', status: 'pending',
        code: 'DIAGNOSTIC_INCOMPLETE', limitation: comparisonNotice }) + '\n');
      await output.sync();
      const parent = await open(await realpath(dirname(resolve(outputPath))), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }

      const result = await (dependencies.diagnose ?? diagnoseRpcSources)(request, sources);
      const current = await lstat(outputPath);
      if (!current.isFile() || current.dev !== reserved.dev || current.ino !== reserved.ino) {
        throw new Error('Reserved output was replaced.');
      }
      const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n', 'utf8');
      // Explicit positions are required because truncate does not reset a file offset.
      await output.truncate(0);
      let position = 0;
      while (position < bytes.length) {
        const { bytesWritten } = await output.write(bytes, position, bytes.length - position, position);
        if (bytesWritten < 1) throw new Error('Diagnostic write failed.');
        position += bytesWritten;
      }
      await output.sync();
      stdout(`Saved RPC diagnostic. Outcome: ${result.status}. ${comparisonNotice}`);
      return result.status === 'agree' ? 0 : 2;
    } finally { await output.close(); }
  } catch {
    stderr('RPC diagnostic stopped. Check local configuration, environment variables, request and a new output path. Existing or pending evidence is retained; no payment was attempted.');
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runDiagnosticCLI(process.argv.slice(2));
}
