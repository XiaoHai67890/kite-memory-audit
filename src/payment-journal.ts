import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Attempt } from './paid-client.js';

/** Persist only public correlation fields, never a reusable signed payment. */
function publicAttempt(attempt: Attempt): Attempt {
  if (!['testnet', 'mainnet'].includes(attempt.network)
    || !/^0x[0-9a-fA-F]{40}$/.test(attempt.payer)
    || !/^0x[0-9a-fA-F]{64}$/.test(attempt.nonce)) {
    throw new Error('Invalid payment attempt identity.');
  }
  return {
    schemaVersion: attempt.schemaVersion, resourceUrl: attempt.resourceUrl,
    requestSha256: attempt.requestSha256, payer: attempt.payer,
    network: attempt.network, payTo: attempt.payTo, amount: attempt.amount,
    nonce: attempt.nonce, validBefore: attempt.validBefore, createdAt: attempt.createdAt,
  };
}

async function syncParents(directory: string): Promise<void> {
  // Sync every ancestor, including when a different concurrent process created
  // a previously missing parent. Otherwise a crash could lose the journal path.
  let path = dirname(directory);
  while (true) {
    const parent = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    const next = dirname(path);
    if (next === path) return;
    path = next;
  }
}

/**
 * One durable claim per network+payer+nonce, independent of output or recipient.
 * Never remove a claim on failure: even an empty/partial file blocks another send.
 * The caller must not transmit the authorization unless this promise fulfills.
 */
export async function claimPaymentAttempt(directory: string, attempt: Attempt): Promise<void> {
  const record = publicAttempt(attempt);
  const serialized = JSON.stringify(record, null, 2) + '\n';
  const key = createHash('sha256').update(`${record.network}:${record.payer.toLowerCase()}:${record.nonce.toLowerCase()}`).digest('hex');
  const requested = resolve(directory);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const journal = await open(requested, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (((await journal.stat()).mode & 0o777) !== 0o700) {
      throw new Error('Payment journal directory must have private 0700 permissions.');
    }
    const canonical = await realpath(requested);
    const file = await open(join(canonical, key + '.json'), 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      // Persist the exclusive directory entry even if the content write failed.
      try { await file.close(); }
      finally { await journal.sync(); await syncParents(canonical); }
    }
  } finally { await journal.close(); }
}
