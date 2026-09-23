import { encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem';
import type { ExperienceDelta } from './types.js';

// Normative v1 strings: ERC-8350, pinned reference 81b14054a75852f4300f612fb88c94457e57299f.
export const EXPERIENCE_DELTA_TYPEHASH = keccak256(stringToHex(
  'ExperienceDelta(bytes32 spaceId,uint64 sequence,bytes32 prevStateRoot,bytes32 deltaCommitment,bytes32 provenanceCommitment,bytes32 profileId,bytes32 locatorCommitment)',
));
export const MEMORY_STATE_TYPEHASH = keccak256(stringToHex(
  'MemoryState(bytes32 prevStateRoot,bytes32 transitionId)',
));
export const ZERO32 = `0x${'00'.repeat(32)}` as Hex;

/** Transition identity is the EIP-712 struct hash, NOT the signing digest. */
export function hashExperienceDelta(delta: ExperienceDelta): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'bytes32' },
      { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [EXPERIENCE_DELTA_TYPEHASH, delta.spaceId, BigInt(delta.sequence), delta.prevStateRoot,
      delta.deltaCommitment, delta.provenanceCommitment, delta.profileId, delta.locatorCommitment],
  ));
}

export function computeNextStateRoot(prevStateRoot: Hex, transitionId: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [MEMORY_STATE_TYPEHASH, prevStateRoot, transitionId],
  ));
}
