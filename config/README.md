# Registry configuration

Only operator-configured `(chainId, address)` pairs can be queried. Requests cannot
supply RPC URLs, deployment ranges, expected bytecode hashes, or raw memory.

`registries.json` includes the public **pre-audit Sepolia test registry**, using:

- Deployment transaction `0x3c31bb28420c943654155188caaed866d7836ff5aba11bb557b3ed1f24bff997`.
- Deployment block `11353452`; logs are scanned inclusively from that block.
- Runtime code hash `0xcf6373071bf2a31293ce508c6b711c1886b6019cf963acf7919fbaefde8bd5db`.
- Code: 6,016 bytes; RPC result matched the runtime bytecode displayed by the
  [verified explorer source](https://sepolia.etherscan.io/address/0xDdf21937ba80b5fF973610877A0955b320C91241#code).
- Bootstrap evidence: `../evidence/registry-bootstrap.json`.

This pin is an operator trust decision, **not a contract audit**. Review deployment
source, upgrade paths, deployment range, and bytecode before adding a registry.
Never learn the expected code hash from the same incoming audit request. Empty
proxy storage slots alone do not prove immutability. This service does not support
arbitrary registry addresses or make a full ERC compliance certification.

`rpcEnv` names the environment variable holding the endpoint. The RPC URL is never
returned by `GET /v1/registries`, placed in a report, or copied into client errors.
Use an archive-capable RPC with `finalized`, EIP-1898 block-hash selectors for
`eth_call` / `eth_getCode`, and up to 50,000 blocks per `eth_getLogs` query. If any
required feature is unavailable, the collector fails closed without charging.

Current bounds: 45 seconds overall, 10 seconds per call, 128 calls, 5,000 events,
4 MiB per RPC response. Exceeding a bound is an explicit service failure; no partial
history is reported as complete. `fromBlock` must be no later than deployment;
changing it for speed would invalidate the completeness assumption.

The report pins a finalized block, checks every event block's canonical hash,
and rechecks the snapshot block at the end. It still trusts the RPC's finality,
logs, and state reads; no light-client or receipt-inclusion proof is provided.
