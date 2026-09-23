import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { addressSchema, hashSchema, uint64Schema } from './validation.js';
import type { RegistryConfig } from './types.js';

export const registryFileSchema = z.array(z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  address: addressSchema,
  fromBlock: uint64Schema,
  expectedCodeHash: hashSchema.refine(value => BigInt(value) !== 0n),
  rpcEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1).max(100),
  source: z.string().url(),
}).strict()).min(1).max(8);

export interface AppConfig {
  mode: 'local' | 'paid';
  host: string;
  port: number;
  network: 'testnet' | 'mainnet';
  priceUsd: string;
  payTo?: string;
  publicBaseUrl?: string;
  facilitatorUrl?: string;
  registries: RegistryConfig[];
  maxConcurrent: number;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const mode = z.enum(['local', 'paid']).parse(env.AUDIT_MODE ?? 'paid');
  const host = env.HOST ?? '127.0.0.1';
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (mode === 'local' && !loopback) throw new Error('Local mode must bind a loopback host. Use paid mode for deployment.');
  const port = z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? '8080');
  const network = z.enum(['testnet', 'mainnet']).parse(env.KITE_NETWORK ?? 'testnet');
  const priceUsd = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/)
    .refine(value => Number(value) > 0).parse(env.PRICE_USD ?? '0.001');
  const payTo = mode === 'paid' ? addressSchema.parse(env.PAY_TO) : undefined;
  let publicBaseUrl: string | undefined;
  if (mode === 'paid') {
    const url = new URL(env.PUBLIC_BASE_URL ?? '');
    const localUrl = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && localUrl && loopback))) {
      throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (HTTP loopback is allowed for local development).');
    }
    publicBaseUrl = url.origin;
  }
  let definitions: z.infer<typeof registryFileSchema>;
  try {
    definitions = registryFileSchema.parse(JSON.parse(await readFile(env.REGISTRIES_FILE ?? 'config/registries.json', 'utf8')));
  } catch {
    throw new Error('Provide a valid REGISTRIES_FILE with a reviewed registry address, deployment block, and nonzero runtime code hash. See config/README.md.');
  }
  const registries = definitions.map(({ rpcEnv, ...definition }) => {
    let url: URL;
    try { url = new URL(env[rpcEnv] ?? ''); } catch { throw new Error(`Set RPC environment variable ${rpcEnv}.`); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('RPC URL must use HTTP(S).');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Non-local RPC endpoints must use HTTPS.');
    }
    return { ...definition, rpcUrl: url.href };
  });
  if (new Set(registries.map(registry => `${registry.chainId}:${registry.address.toLowerCase()}`)).size !== registries.length) {
    throw new Error('Registry entries must be unique.');
  }
  return { mode, host, port, network, priceUsd, payTo, publicBaseUrl,
    facilitatorUrl: env.FACILITATOR_URL,
    registries, maxConcurrent: z.coerce.number().int().min(1).max(16).parse(env.MAX_CONCURRENT_AUDITS ?? '2') };
}
