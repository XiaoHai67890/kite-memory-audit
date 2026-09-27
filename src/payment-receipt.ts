import { toEventSelector, toHex } from 'viem';
import { kiteChainByName, type KiteNetworkName } from './kite.js';

export interface ReceiptExpectation {
  network: KiteNetworkName;
  transaction: string;
  payer: string;
  payTo: string;
  /** Integer base units, not a decimal token quantity. */
  amount: string;
  /** The ERC-3009 authorization nonce from the original payment, never a new nonce. */
  nonce: string;
  minimumConfirmations?: number;
}

/** Raw read-only JSON-RPC. Injected adapters must return unmodified RPC result fields. */
export type ReceiptRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface ReceiptVerification {
  status: 'verified' | 'mismatch' | 'unknown';
  code: string;
  reason: string;
  evidence: {
    network?: string;
    chainId?: number;
    token?: string;
    transaction?: string;
    block?: { number: string; hash: string; observedHead: string; confirmations: string; minimumConfirmations: number };
    transfer?: { payer: string; payTo: string; amount: string; logIndex: string };
    authorization?: { payer: string; nonce: string; logIndex: string };
  };
  limitations: string[];
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)').toLowerCase();
const AUTHORIZATION_USED = toEventSelector('AuthorizationUsed(address,bytes32)').toLowerCase();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;
const UINT256_MAX = (1n << 256n) - 1n;
const MAX_LOGS = 4_096;
const MAX_BLOCK_TRANSACTIONS = 50_000;
const RPC_METHODS = new Set(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber']);
type JsonObject = Record<string, unknown>;

class ReceiptRpcError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new ReceiptRpcError('INVALID_RPC_EVIDENCE', 'The RPC returned malformed or contradictory receipt evidence.'); }
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as JsonObject;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid();
  return value.toLowerCase();
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) invalid();
  return value.toLowerCase();
}
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !QUANTITY.test(value)) invalid();
  return BigInt(value);
}
function addressTopic(value: string): string {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) invalid();
  return `0x${value.slice(-40)}`.toLowerCase();
}

interface ParsedReceipt {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  transactionIndex: bigint;
  success: boolean;
  logs: { address: string; topics: string[]; data: string; logIndex: bigint }[];
}

function parseReceipt(raw: unknown, expectedTransaction: string, chainId: number): ParsedReceipt {
  const r = object(raw);
  const transactionHash = hash(r.transactionHash);
  if (transactionHash !== expectedTransaction) invalid();
  const blockNumber = quantity(r.blockNumber);
  const blockHash = hash(r.blockHash);
  const transactionIndex = quantity(r.transactionIndex);
  if (r.status !== '0x0' && r.status !== '0x1') invalid();
  // chainId is nonstandard in a receipt, but if present it must not contradict eth_chainId.
  if (r.chainId !== undefined && quantity(r.chainId) !== BigInt(chainId)) invalid();
  if (!Array.isArray(r.logs) || r.logs.length > MAX_LOGS) invalid();
  if (r.status === '0x0' && r.logs.length !== 0) invalid();
  let previousIndex = -1n;
  const logs = r.logs.map(value => {
    const log = object(value);
    if (log.removed !== false || hash(log.transactionHash) !== transactionHash
      || hash(log.blockHash) !== blockHash || quantity(log.blockNumber) !== blockNumber
      || quantity(log.transactionIndex) !== transactionIndex) invalid();
    const logIndex = quantity(log.logIndex);
    if (logIndex <= previousIndex) invalid();
    previousIndex = logIndex;
    if (!Array.isArray(log.topics) || log.topics.length > 4) invalid();
    const topics = log.topics.map(hash);
    if (typeof log.data !== 'string' || !BYTES.test(log.data) || log.data.length > 131_074) invalid();
    return { address: address(log.address), topics, data: log.data.toLowerCase(), logIndex };
  });
  return { transactionHash, blockNumber, blockHash, transactionIndex, success: r.status === '0x1', logs };
}

function parseBlock(raw: unknown, receipt: ParsedReceipt): { number: bigint; hash: string } {
  if (raw === null) throw new ReceiptRpcError('BLOCK_UNAVAILABLE', 'The receipt block is unavailable; settlement is unconfirmed.');
  const b = object(raw);
  const number = quantity(b.number), blockHash = hash(b.hash);
  if (number !== receipt.blockNumber) invalid();
  if (blockHash !== receipt.blockHash) throw new ReceiptRpcError('REORG_DETECTED', 'The receipt block no longer matches the canonical block; settlement is unconfirmed.');
  if (!Array.isArray(b.transactions) || b.transactions.length > MAX_BLOCK_TRANSACTIONS) invalid();
  const transactions = b.transactions.map(hash);
  if (receipt.transactionIndex >= BigInt(transactions.length)
    || transactions[Number(receipt.transactionIndex)] !== receipt.transactionHash
    || new Set(transactions).size !== transactions.length) invalid();
  return { number, hash: blockHash };
}

/**
 * Observes one explicitly configured RPC's confirmed settlement events. This is
 * not a light-client/receipt-inclusion proof, signature revalidation, or proof
 * that a merchant delivered this HTTP request's report. The caller must bind its
 * original payment authorization and HTTP response to this expectation.
 * Every outcome, including mismatch, is read-only: never authorize a retry here.
 */
export async function verifyPaymentReceipt(expected: ReceiptExpectation, rpc: ReceiptRpc): Promise<ReceiptVerification> {
  const evidence: ReceiptVerification['evidence'] = {};
  const result = (status: ReceiptVerification['status'], code: string, reason: string): ReceiptVerification => ({
    status, code, reason, evidence,
    limitations: [
      'This observes one configured RPC and the fixed Kite token contract. It is not an independent consensus, finality, token-code, or receipt-inclusion proof.',
      'Matching transfer and authorization events do not prove the merchant delivered a report or bind that report to an HTTP request. The caller must establish that association separately.',
      'Confirmations reduce reorganization risk but do not guarantee finality. Unknown or mismatching evidence is not permission to sign a new payment; reconcile the original transaction and nonce first.',
    ],
  });
  const confirmationsRequired = expected.minimumConfirmations ?? 2;
  if (!['testnet', 'mainnet'].includes(expected.network)
    || typeof expected.transaction !== 'string' || !HASH.test(expected.transaction)
    || typeof expected.payer !== 'string' || !ADDRESS.test(expected.payer)
    || typeof expected.payTo !== 'string' || !ADDRESS.test(expected.payTo)
    || expected.payer.toLowerCase() === ZERO_ADDRESS || expected.payTo.toLowerCase() === ZERO_ADDRESS
    || typeof expected.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(expected.amount) || BigInt(expected.amount) > UINT256_MAX
    || typeof expected.nonce !== 'string' || !HASH.test(expected.nonce) || !Number.isSafeInteger(confirmationsRequired)
    || confirmationsRequired < 1 || confirmationsRequired > 10_000) {
    return result('mismatch', 'INVALID_EXPECTATION', 'The expected payment fields or confirmation requirement are invalid.');
  }
  const chain = kiteChainByName(expected.network);
  const chainId = Number(chain.network.split(':')[1]);
  const transaction = expected.transaction.toLowerCase();
  const payer = expected.payer.toLowerCase(), payTo = expected.payTo.toLowerCase();
  const token = chain.assetAddress.toLowerCase();
  Object.assign(evidence, { network: chain.network, chainId, token, transaction });
  const started = Date.now();
  async function call(method: string, params: readonly unknown[]): Promise<unknown> {
    const remaining = 30_000 - (Date.now() - started);
    if (remaining <= 0) throw new ReceiptRpcError('RPC_TIMEOUT', 'Receipt verification timed out; settlement remains unknown.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([rpc(method, params), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReceiptRpcError('RPC_TIMEOUT', 'Receipt verification timed out; settlement remains unknown.')), Math.min(10_000, remaining));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    if (quantity(await call('eth_chainId', [])) !== BigInt(chainId)) {
      return result('mismatch', 'CHAIN_MISMATCH', 'The configured RPC is connected to a different payment network.');
    }
    const raw = await call('eth_getTransactionReceipt', [transaction]);
    if (raw === null) return result('unknown', 'RECEIPT_UNAVAILABLE', 'No receipt was observed. The transaction may be pending, absent, or unavailable; do not sign a replacement payment.');
    const receipt = parseReceipt(raw, transaction, chainId);
    parseBlock(await call('eth_getBlockByNumber', [toHex(receipt.blockNumber), false]), receipt);
    const head = quantity(await call('eth_blockNumber', []));
    if (head < receipt.blockNumber) return result('unknown', 'INCONSISTENT_CHAIN_HEAD', 'The observed head precedes the receipt block; settlement remains unknown.');
    const confirmations = head - receipt.blockNumber + 1n;
    evidence.block = { number: receipt.blockNumber.toString(), hash: receipt.blockHash,
      observedHead: head.toString(), confirmations: confirmations.toString(), minimumConfirmations: confirmationsRequired };
    if (confirmations < BigInt(confirmationsRequired)) return result('unknown', 'INSUFFICIENT_CONFIRMATIONS', 'The receipt has fewer confirmations than required; do not sign a replacement payment.');
    // Re-read the canonical block after observing confirmations; never mix fork evidence.
    parseBlock(await call('eth_getBlockByNumber', [toHex(receipt.blockNumber), false]), receipt);
    if (!receipt.success) return result('mismatch', 'TRANSACTION_REVERTED', 'The confirmed transaction receipt reports a revert. This does not authorize another payment.');

    const transfers: { payTo: string; amount: bigint; logIndex: bigint }[] = [];
    const authorizations: { nonce: string; logIndex: bigint }[] = [];
    for (const log of receipt.logs) {
      if (log.address !== token) continue;
      if (log.topics[0] === TRANSFER) {
        if (log.topics.length !== 3 || !HASH.test(log.data)) invalid();
        const from = addressTopic(log.topics[1]!);
        const to = addressTopic(log.topics[2]!);
        if (from === payer) transfers.push({ payTo: to, amount: BigInt(log.data), logIndex: log.logIndex });
      } else if (log.topics[0] === AUTHORIZATION_USED) {
        // ERC-3009: both authorizer and nonce are indexed; no non-indexed data.
        if (log.topics.length !== 3 || log.data !== '0x') invalid();
        if (addressTopic(log.topics[1]!) === payer) authorizations.push({ nonce: log.topics[2]!, logIndex: log.logIndex });
      }
    }
    if (transfers.length > 1 || authorizations.length > 1) return result('mismatch', 'AMBIGUOUS_PAYMENT', 'Multiple transfers or authorizations for this payer and token make batch settlement attribution ambiguous.');
    const transfer = transfers[0], authorization = authorizations[0];
    if (!transfer) return result('mismatch', 'TRANSFER_MISSING', 'No transfer from the expected payer was observed for the fixed Kite token.');
    evidence.transfer = { payer, payTo: transfer.payTo, amount: transfer.amount.toString(), logIndex: transfer.logIndex.toString() };
    if (transfer.payTo !== payTo) return result('mismatch', 'RECIPIENT_MISMATCH', 'The observed token transfer has a different recipient.');
    if (transfer.amount !== BigInt(expected.amount)) return result('mismatch', 'AMOUNT_MISMATCH', 'The observed token transfer amount differs from the expected base units.');
    if (!authorization) return result('mismatch', 'AUTHORIZATION_MISSING', 'The matching payer has no ERC-3009 AuthorizationUsed event in this receipt.');
    evidence.authorization = { payer, nonce: authorization.nonce, logIndex: authorization.logIndex.toString() };
    if (authorization.nonce !== expected.nonce.toLowerCase()) return result('mismatch', 'NONCE_MISMATCH', 'The observed authorization nonce differs from the original payment nonce.');
    return result('verified', 'PAYMENT_OBSERVED', 'A successful confirmed receipt contains one matching token transfer and one matching authorization nonce.');
  } catch (error) {
    if (error instanceof ReceiptRpcError) return result('unknown', error.code, error.message);
    // Provider exceptions can contain API keys, full URLs or response bodies.
    return result('unknown', 'RPC_UNAVAILABLE', 'The configured RPC could not complete receipt verification; settlement remains unknown.');
  }
}

export interface ReceiptRpcOptions { timeoutMs?: number; maxResponseBytes?: number }

/** The URL is operator configuration, never a value from an x402 response. No retries or signing methods. */
export function createReceiptRpc(url: string, options: ReceiptRpcOptions = {}): ReceiptRpc {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Configure a valid payment RPC URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Payment RPC must use HTTPS, or HTTP loopback, without embedded login credentials or fragments.');
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 8 * 1024 * 1024) {
    throw new Error('Payment RPC timeout or response limit is invalid.');
  }
  let nextId = 0;
  return async (method, params) => {
    if (!RPC_METHODS.has(method)) throw new ReceiptRpcError('RPC_METHOD_NOT_ALLOWED', 'This payment RPC adapter only permits receipt-verification reads.');
    const id = ++nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(parsed.href, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      if (!response.ok || !response.body) throw new ReceiptRpcError('RPC_UNAVAILABLE', 'The configured RPC could not complete receipt verification.');
      const reader = response.body.getReader();
      let length = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > maxResponseBytes) {
          await reader.cancel();
          throw new ReceiptRpcError('RPC_RESPONSE_LIMIT', 'The RPC receipt response exceeded the configured size limit.');
        }
        chunks.push(chunk.value);
      }
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (envelope.jsonrpc !== '2.0' || envelope.id !== id || !Object.hasOwn(envelope, 'result') || Object.hasOwn(envelope, 'error')) invalid();
      return envelope.result;
    } catch (error) {
      if (controller.signal.aborted) throw new ReceiptRpcError('RPC_TIMEOUT', 'Receipt verification timed out; settlement remains unknown.');
      if (error instanceof ReceiptRpcError) throw error;
      throw new ReceiptRpcError('RPC_UNAVAILABLE', 'The configured RPC could not complete receipt verification.');
    } finally { clearTimeout(timer); }
  };
}
