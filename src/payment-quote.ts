import type { PaymentRequirements } from '@x402/core/types';
import { getAddress, zeroAddress } from 'viem';
import { z } from 'zod';
import { kiteChainByName } from './kite.js';

export interface PaymentPolicy {
  /** Independently approved endpoint, never copied from an untrusted challenge. */
  url: string;
  network: 'testnet' | 'mainnet';
  payTo: string;
  /** Positive uint256 in atomic token units; never a floating-point USD value. */
  maxAmount: string;
}

export interface CheckedQuote {
  resourceUrl: string;
  requirements: PaymentRequirements;
}

export interface PaymentQuoteOptions {
  /** Explicit local-test opt-in. Production callers should omit this. */
  allowLoopback?: boolean;
}

export const MAX_PAYMENT_HEADER_BYTES = 32 * 1024;
const UINT256_MAX = (1n << 256n) - 1n;
const amountPattern = /^[1-9][0-9]{0,77}$/;
const positiveAmount = z.string().refine(value => amountPattern.test(value) && BigInt(value) <= UINT256_MAX);
const nonzeroAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .refine(value => value.toLowerCase() !== zeroAddress)
  .transform(value => getAddress(value.toLowerCase()));
const policySchema = z.object({
  url: z.string().max(2048),
  network: z.enum(['testnet', 'mainnet']),
  payTo: nonzeroAddress,
  maxAmount: positiveAmount,
}).strict();
const quoteSchema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: z.object({
    url: z.string().max(2048),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    serviceName: z.string().optional(),
    tags: z.array(z.string()).optional(),
    iconUrl: z.string().optional(),
  }).strict(),
  accepts: z.array(z.object({
    scheme: z.literal('exact'),
    network: z.string(),
    asset: nonzeroAddress,
    amount: positiveAmount,
    payTo: nonzeroAddress,
    maxTimeoutSeconds: z.number().int().min(30).max(300),
    extra: z.object({ name: z.string(), version: z.string() }).strict(),
  }).strict()).length(1),
}).strict();

function validateResourceUrl(value: string, options: PaymentQuoteOptions): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Payment policy URL must be an absolute canonical URL.'); }
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || /^127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(url.hostname)
    || url.hostname === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(url.hostname);
  if (loopback && options.allowLoopback !== true) {
    throw new Error('Loopback payment URLs require explicit test opt-in.');
  }
  if (url.protocol !== 'https:' && !(options.allowLoopback === true && loopback && url.protocol === 'http:')) {
    throw new Error('Payment policy URL must use HTTPS.');
  }
  // Comparing href also rejects whitespace, dot-segment normalization, raw
  // backslashes, non-canonical host spelling and implicit default-port aliases.
  if (url.href !== value || url.pathname !== '/v1/memory/audit' || url.username || url.password
    || value.includes('?') || value.includes('#')) {
    throw new Error('Payment policy URL must be canonical /v1/memory/audit without credentials, query or fragment.');
  }
}

/** Validate the caller's policy before contacting a merchant or signing. */
export function validatePaymentPolicy(policy: unknown, options: PaymentQuoteOptions = {}): PaymentPolicy {
  const parsed = policySchema.safeParse(policy);
  if (!parsed.success) throw new Error('Invalid payment policy: expected URL, Kite network, nonzero recipient and positive uint256 maximum.');
  validateResourceUrl(parsed.data.url, options);
  return parsed.data;
}

/**
 * Decode standard, padded, canonical base64 with an input bound. Node's base64
 * decoder is permissive, so explicitly reject whitespace, base64url, bad padding
 * and nonzero pad bits before accepting JSON. Invalid UTF-8 also fails closed.
 * Errors deliberately contain no input excerpt or payment authorization data.
 */
export function decodeBoundedBase64Json(header: string): unknown {
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_PAYMENT_HEADER_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(header)) {
    throw new Error('Invalid payment header: expected bounded canonical base64.');
  }
  const bytes = Buffer.from(header, 'base64');
  if (bytes.toString('base64') !== header) throw new Error('Invalid payment header: noncanonical base64.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Invalid payment header: expected UTF-8 JSON.'); }
}

/** Accept only the service's exact Kite EIP-3009 payment format and user limits. */
export function checkPaymentQuote(header: string, policy: PaymentPolicy, options: PaymentQuoteOptions = {}): CheckedQuote {
  const checkedPolicy = validatePaymentPolicy(policy, options);
  const parsed = quoteSchema.safeParse(decodeBoundedBase64Json(header));
  if (!parsed.success) throw new Error('Invalid payment quote: expected one x402 v2 exact offer without extensions or unknown fields.');
  const quote = parsed.data;
  if (quote.resource.url !== checkedPolicy.url) throw new Error('Payment quote resource does not match the approved URL.');
  const offer = quote.accepts[0]!;
  const chain = kiteChainByName(checkedPolicy.network);
  if (offer.network !== chain.network || offer.asset.toLowerCase() !== chain.assetAddress.toLowerCase()) {
    throw new Error('Payment quote network or asset does not match the approved Kite network.');
  }
  if (offer.extra.name !== chain.eip712Name || offer.extra.version !== chain.eip712Version) {
    throw new Error('Payment quote EIP-712 domain does not match the approved Kite asset.');
  }
  if (offer.payTo !== checkedPolicy.payTo) throw new Error('Payment quote recipient does not match the approved recipient.');
  if (BigInt(offer.amount) > BigInt(checkedPolicy.maxAmount)) throw new Error('Payment quote exceeds the approved amount.');
  // Return only the checked payment fields, never arbitrary merchant metadata.
  return {
    resourceUrl: checkedPolicy.url,
    requirements: {
      scheme: 'exact', network: chain.network, asset: offer.asset,
      amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: offer.maxTimeoutSeconds,
      extra: { name: chain.eip712Name, version: chain.eip712Version },
    },
  };
}
