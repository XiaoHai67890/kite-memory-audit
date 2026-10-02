import { open, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { executePaidAudit, preflightAudit, type Attempt } from '../src/paid-client.js';
import { claimPaymentAttempt } from '../src/payment-journal.js';
import { validatePaymentPolicy } from '../src/payment-quote.js';
import { createReceiptRpc, verifyPaymentReceipt, type ReceiptExpectation } from '../src/payment-receipt.js';
import { addressSchema } from '../src/validation.js';
import { reserveReportDirectory, saveReportCapture, finalizeReportCapture } from '../src/report-files.js';

// Signed authorizations must be obtained from a compatible wallet/client under
// the participant's control. This CLI never asks for or imports a private key.
async function jsonFile(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size > 65_536) throw new Error('Input file exceeds 64 KiB.');
    const text = await file.readFile('utf8');
    if (Buffer.byteLength(text) > 65_536) throw new Error('Input file exceeds 64 KiB.');
    return JSON.parse(text);
  } finally { await file.close(); }
}
const configSchema = z.object({
  policy: z.unknown(), payer: addressSchema,
  receiptRpcUrl: z.string().url(),
  journalDirectory: z.string().min(1).default('.payment-attempts'),
}).strict();

async function main(): Promise<void> {
  const [command, configPath, requestPath, fourth, fifth, ...extra] = process.argv.slice(2);
  if (!command || !['preflight', 'execute', 'verify'].includes(command) || !configPath || !requestPath || !fourth
    || extra.length || (command === 'execute' ? !fifth : !!fifth)) {
    throw new Error('Usage: npm run payment:client -- preflight CONFIG REQUEST OUTPUT | execute CONFIG REQUEST SIGNED_PAYMENT OUTPUT | verify CONFIG EVIDENCE OUTPUT');
  }
  const config = configSchema.parse(await jsonFile(configPath));
  const policy = validatePaymentPolicy(config.policy);
  const output = resolve(command === 'execute' ? fifth! : fourth);
  // Never overwrite another run's record or an input file.
  try { await stat(output); throw new Error('Output file already exists; use a new file.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let result: unknown;
  if (command === 'preflight') {
    result = await preflightAudit(policy, await jsonFile(requestPath));
  } else if (command === 'verify') {
    const saved = await jsonFile(requestPath) as { expectation?: ReceiptExpectation; attempt?: Attempt };
    // Evidence comes from the original client run; don't accept a new payment
    // configuration or a receiver supplied by the remote server at review time.
    const expected = saved.expectation;
    if (!expected || expected.network !== policy.network || expected.payer.toLowerCase() !== config.payer.toLowerCase()
      || expected.payTo.toLowerCase() !== policy.payTo.toLowerCase() || !/^[1-9][0-9]{0,77}$/.test(expected.amount)
      || BigInt(expected.amount) > BigInt(policy.maxAmount)) throw new Error('Saved expectation does not match the independent client configuration.');
    result = await verifyPaymentReceipt(expected, createReceiptRpc(config.receiptRpcUrl));
    if ((result as { status: string }).status !== 'verified') process.exitCode = 2;
  } else {
    const signed = await jsonFile(fourth);
    const journal = resolve(config.journalDirectory);
    // Reserve the output before any signing/sending. A final evidence write
    // failure still leaves a durable nonce claim and a visible pending record.
    await writeFile(output, JSON.stringify({ status: 'pending', message: 'Inspect the local attempt journal; do not repeat payment.' }) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      const reportDirectory = `${output}.report`;
      // Reserve private storage before any paid request. An existing bundle
      // prevents this run from proceeding; it is never overwritten.
      await reserveReportDirectory(reportDirectory);
      result = await executePaidAudit({
        policy, request: await jsonFile(requestPath), payer: config.payer,
        rpc: createReceiptRpc(config.receiptRpcUrl), sign: async () => signed,
        beforeSend: attempt => claimPaymentAttempt(journal, attempt),
        captureReport: capture => saveReportCapture(reportDirectory, capture),
      });
      await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      // Preserve the transaction expectation in the main output even if the
      // secondary bundle summary cannot be saved. Never repeat payment.
      await finalizeReportCapture(reportDirectory, result);
      if ((result as { status: string }).status !== 'verified') process.exitCode = 2;
      console.log(`Saved payment evidence. Outcome: ${(result as { status: string }).status}.`);
      return;
    } catch {
      throw new Error('Execution stopped; inspect the output and attempt journal before trying any payment again.');
    }
  }
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${command} result.`);
}
main().catch(() => {
  // Never print raw RPC URLs, response bodies, payment files, or parser errors.
  console.error('Payment client stopped. Check arguments/configuration and existing evidence; never retry an unknown payment automatically. See CLIENT.md.');
  process.exitCode = 2;
});
