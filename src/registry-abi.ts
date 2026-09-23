import { parseAbi, toEventSelector } from 'viem';

// ERC-8350 Draft interface, source revision recorded in README.
export const registryAbi = parseAbi([
  'event SpaceRegistered(bytes32 indexed spaceId, address indexed controller, address indexed authorizer)',
  'event SpaceAuthorizationUpdated(bytes32 indexed spaceId, address indexed controller, address indexed authorizer, uint64 configNonce)',
  'event TransitionCommitted(bytes32 indexed spaceId, bytes32 indexed transitionId, uint64 indexed sequence, bytes32 prevStateRoot, bytes32 nextStateRoot, bytes32 deltaCommitment, bytes32 provenanceCommitment, bytes32 profileId, bytes32 locatorCommitment, address authorizer)',
  'function head(bytes32 spaceId) view returns (bytes32 transitionId, bytes32 stateRoot, uint64 sequence)',
  'function spaceAuthorization(bytes32 spaceId) view returns (address controller, address authorizer, uint64 configNonce)',
]);

export const registryEventTopics = [
  toEventSelector('SpaceRegistered(bytes32,address,address)'),
  toEventSelector('SpaceAuthorizationUpdated(bytes32,address,address,uint64)'),
  toEventSelector('TransitionCommitted(bytes32,bytes32,uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,address)'),
] as const;
