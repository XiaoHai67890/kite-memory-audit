import { z } from 'zod';
import { getAddress, zeroAddress } from 'viem';
import type { AuditRequest } from './types.js';
import { ServiceError } from './errors.js';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
  .transform(value => getAddress(value.toLowerCase()))
  .refine(value => value !== zeroAddress, 'Zero address is not allowed');
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
  .transform(value => value.toLowerCase() as `0x${string}`);
export const uint64Schema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n, 'Value exceeds uint64');
export const auditRequestSchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  registry: addressSchema,
  spaceId: hashSchema.refine(value => BigInt(value) !== 0n, 'Zero space is not allowed'),
  atBlock: uint64Schema.optional(),
  checkpoint: z.object({
    sequence: uint64Schema,
    stateRoot: hashSchema,
    transitionId: hashSchema.optional(),
  }).strict().optional(),
}).strict();

export function parseAuditRequest(input: unknown): AuditRequest {
  const result = auditRequestSchema.safeParse(input);
  if (!result.success) {
    throw new ServiceError('INVALID_REQUEST',
      'Expected chainId, registry, spaceId, optional decimal-string atBlock and checkpoint. Unknown fields are rejected.', 400);
  }
  return result.data;
}
