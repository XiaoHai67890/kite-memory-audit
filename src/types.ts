import type { Address, Hex } from 'viem';

export interface AuditRequest {
  chainId: number;
  registry: Address;
  spaceId: Hex;
  atBlock?: string;
  checkpoint?: { sequence: string; stateRoot: Hex; transitionId?: Hex };
}
export interface ExperienceDelta {
  spaceId: Hex;
  sequence: string;
  prevStateRoot: Hex;
  deltaCommitment: Hex;
  provenanceCommitment: Hex;
  profileId: Hex;
  locatorCommitment: Hex;
}
export interface EventPosition {
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}
export type AuditEvent = EventPosition & (
  | { type: 'registered'; controller: Address; authorizer: Address }
  | { type: 'authorization'; controller: Address; authorizer: Address; configNonce: string }
  | { type: 'transition'; delta: ExperienceDelta; transitionId: Hex; nextStateRoot: Hex; authorizer: Address }
);
export interface RegistryConfig {
  chainId: number;
  address: Address;
  fromBlock: string;
  expectedCodeHash: Hex;
  rpcUrl: string;
  label: string;
  source: string;
}
export interface EvidenceSnapshot {
  chainId: number;
  registry: Address;
  spaceId: Hex;
  block: { number: string; hash: Hex; timestamp: string };
  registryEvidence: {
    fromBlock: string;
    expectedCodeHash: Hex;
    actualCodeHash: Hex;
    source: string;
  };
  head: { transitionId: Hex; stateRoot: Hex; sequence: string };
  authorization: { controller: Address; authorizer: Address; configNonce: string };
  events: AuditEvent[];
  rpcLabel: string;
}
export interface AuditCheck {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  message: string;
  sequence?: string;
}
export interface AuditReport {
  schemaVersion: '1';
  verdict: 'consistent' | 'inconsistent' | 'inconclusive';
  subject: { chainId: number; registry: Address; spaceId: Hex };
  checks: AuditCheck[];
  checkpoint: { status: 'matches' | 'mismatch' | 'ahead' | 'not_provided' | 'unverifiable'; sequence?: string };
  summary: { transitionCount: number; authorizationUpdateCount: number; headSequence: string };
  evidence: EvidenceSnapshot;
  limitations: string[];
}
