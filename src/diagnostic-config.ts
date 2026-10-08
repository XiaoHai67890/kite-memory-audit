import { z } from 'zod';
import { addressSchema, hashSchema, uint64Schema } from './validation.js';
import { defaultCollectionLimits } from './rpc.js';
import type { RpcDiagnosticSource } from './rpc-diagnostics.js';

const environmentName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const limitsSchema = z.object({
  maxRequests: z.number().int().min(1).max(512).optional(),
  requestTimeoutMs: z.number().int().min(1).max(30_000).optional(),
  totalTimeoutMs: z.number().int().min(1).max(120_000).optional(),
}).strict();

/** RPC URLs belong in independent local environment variables, never this document. */
export const diagnosticConfigSchema = z.object({
  schemaVersion: z.literal('1'),
  registry: z.object({
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    address: addressSchema, fromBlock: uint64Schema,
    expectedCodeHash: hashSchema.refine(value => BigInt(value) !== 0n),
  }).strict(),
  sources: z.tuple([
    z.object({ id: z.literal('primary'), rpcEnv: environmentName }).strict(),
    z.object({ id: z.literal('secondary'), rpcEnv: environmentName }).strict(),
  ]),
  limits: limitsSchema.optional(),
}).strict();

function configuredEndpoint(value: string | undefined): { url: string; identity: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid diagnostic endpoint.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('#')) {
    throw new Error('Invalid diagnostic endpoint.');
  }
  // Query strings often carry provider tokens, not independent source identities.
  // This detects endpoint aliases; it cannot establish that two providers are independent.
  const host = url.hostname.toLowerCase().replace(/\.$/, '') + (url.port ? ':' + url.port : '');
  return { url: url.href, identity: host + url.pathname };
}

export function loadDiagnosticSources(input: unknown,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly [RpcDiagnosticSource, RpcDiagnosticSource] {
  try {
    const config = diagnosticConfigSchema.parse(input);
    if (config.sources[0].rpcEnv === config.sources[1].rpcEnv) throw new Error('Repeated source environment.');
    const endpoints = config.sources.map(source => configuredEndpoint(environment[source.rpcEnv]));
    if (endpoints[0]!.identity === endpoints[1]!.identity) throw new Error('Repeated source endpoint.');
    const limits = {
      maxRequests: config.limits?.maxRequests ?? defaultCollectionLimits.maxRequests,
      requestTimeoutMs: config.limits?.requestTimeoutMs ?? defaultCollectionLimits.requestTimeoutMs,
      totalTimeoutMs: config.limits?.totalTimeoutMs ?? defaultCollectionLimits.totalTimeoutMs,
    };
    if (limits.requestTimeoutMs > limits.totalTimeoutMs) throw new Error('Invalid diagnostic time budget.');
    return config.sources.map((source, index) => ({
      id: source.id,
      registry: { ...config.registry, rpcUrl: endpoints[index]!.url,
        label: source.id, source: 'Independent local diagnostic registry policy' },
      options: { ...limits },
    })) as [RpcDiagnosticSource, RpcDiagnosticSource];
  } catch {
    // Never include env names, endpoint credentials, schema excerpts or URL parser messages.
    throw new Error('Invalid diagnostic configuration or independently configured RPC sources.');
  }
}
