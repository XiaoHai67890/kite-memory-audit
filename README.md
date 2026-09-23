# Kite Memory Audit

An HTTP service that replays **ERC-8350 Agent Memory State Registry** history,
compares an optional checkpoint, and returns a reproducible evidence report.
The service implements Kite x402 payment per completed report. Current Passport
payer compatibility requires confirmation; see [the paid-call handoff](./PAID_CALL.md).

[中文快速开始](./START_HERE.zh-CN.md) · [API definition](./openapi.yaml) · [Submission checklist](./SUBMISSION.md)

**Status: local implementation with a real, read-only Sepolia report.** Automated
payment tests use a fake facilitator. No public service deployment, real Passport
payment, GitHub publication, or bounty acceptance is claimed.

## What the service checks

- A finalized block and an explicitly configured registry runtime code hash.
- Registration, authorization rotation order/nonces, and event authorizer continuity.
- Canonical `ExperienceDelta` hashes, state roots, gapless sequence and genesis.
- Replayed history versus `head()` and `spaceAuthorization()` at that same block.
- An optional historical checkpoint, with a distinction between mismatch,
  unavailable evidence, and a checkpoint newer than the selected snapshot.
- Event positions, duplicate logs, block hashes, and end-of-query reorg detection.

Every report includes the checked public events, observed state, registry pin,
snapshot block hash, and limits of the conclusion. It contains no raw memory.

**Trust boundary:** consistency of an RPC snapshot is not proof of consensus,
truth, data availability, actual model use, or historic signature validity. The
collector trusts its configured RPC and reviewed registry semantics. It does not
re-execute historical ERC-1271 policies or certify arbitrary registry contracts.
ERC-8350 is Draft. See [the specification](https://eips.ethereum.org/EIPS/eip-8350)
and [registry configuration](./config/README.md).

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci --ignore-scripts
npm run check
npm run build
```

Read-only live CLI, without wallet or payment:

```sh
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  npm run audit:live -- examples/request.json evidence/my-report.local.json
```

Loopback-only development HTTP server, explicitly unpaid:

```sh
AUDIT_MODE=local SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  npm start

curl -sS http://127.0.0.1:8080/v1/memory/audit \
  -H 'Content-Type: application/json' --data-binary @examples/request.json
```

`local` mode refuses non-loopback binding and returns `X-Audit-Payment-Mode:
local-unpaid`. The CLI and local HTTP reports are **not payment evidence**.

## Paid service

Read [PAID_CALL.md](./PAID_CALL.md) before testing with Passport: current official
Passport network guidance conflicts with the older Kite sandbox walkthrough.
The facilitator supports Kite; a compatible participant payer is still required.

Copy `.env.example` to `.env`, supply your **public** `PAY_TO` receiving address,
and run `node --env-file=.env dist/src/index.js`. No private key is required by
the service. It defaults to Kite **testnet**, not mainnet.

For deployment use `AUDIT_MODE=paid`, `HOST=0.0.0.0`, a public HTTPS origin in
`PUBLIC_BASE_URL`, and a reliable Sepolia RPC in `SEPOLIA_RPC_URL`. `PAY_TO` must
be nonzero. `PRICE_USD` is a positive decimal string with at most six decimals.
The example price is `0.001`; set it according to actual RPC and hosting costs.

The Dockerfile builds a non-root Node image. Put it behind managed HTTPS:

```sh
docker build -t kite-memory-audit .
docker run --rm -p 8080:8080 --env-file .env \
  -e AUDIT_MODE=paid -e HOST=0.0.0.0 kite-memory-audit
```

For native Express hosting on Vercel, use the included `app.ts` entrypoint and
[Vercel deployment guide](./DEPLOY_VERCEL.md). Its hosted entrypoint rejects
unpaid local mode, and its function budget is 120 seconds with Fluid compute.

Only `POST /v1/memory/audit` is paid. The SDK verifies payment, the service
collects and audits evidence, and settlement occurs only for a successful 2xx
response. A complete report finding an inconsistency is a delivered service and
is charged. Missing evidence, RPC errors, validation errors, capacity errors,
and any report containing an unknown check are non-2xx and not settled by the
handler. Settlement failure prevents release of the successful report.

An ambiguous settlement timeout can still mean the transaction landed on-chain.
**Inspect the payment receipt/chain before retrying with a new authorization.**
This MVP has no durable settlement reconciliation or report-recovery database.

The payment chain and audited chain are distinct: the example audits Ethereum
Sepolia history and pays on Kite testnet. This is not a cross-chain migration or
a deployment of the registry on Kite.

## HTTP interface

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Free liveness/configuration summary, not an RPC health guarantee |
| `GET /v1/registries` | Free public allowlist; excludes RPC URLs |
| `POST /v1/memory/audit` | JSON request, x402 protected in paid mode |

Example request:

```json
{
  "chainId": 11155111,
  "registry": "0xDdf21937ba80b5fF973610877A0955b320C91241",
  "spaceId": "0xfbe20b841e2cb8d5e8094da6a9be9ebe19bb4d52c6155f465b40aa7bf1c13564"
}
```

Optional `atBlock` is a decimal **string** at or below the finalized height.
Optional `checkpoint` has `sequence` (decimal string), `stateRoot` (bytes32), and
optional `transitionId` (bytes32). It belongs to the request's chain, registry and
space. Unknown fields, URL query parameters, raw memory, and caller-selected RPC
endpoints are rejected. Body limit: 8 KiB.

| HTTP status | Meaning |
| --- | --- |
| 200 | Completed report: `consistent` or `inconsistent`; chargeable |
| 400 / 413 | Invalid input / oversized request; not chargeable |
| 402 | Missing/invalid payment; includes x402 `PAYMENT-REQUIRED` when appropriate |
| 404 | Unknown route or Memory Space |
| 422 | Evidence/query limit exceeded; not chargeable |
| 502 / 503 / 504 | Payment/RPC/service failure or incomplete report; successful report withheld |

A report may contain both contradictions and unknown checks. Its verdict can be
`inconsistent`, but the HTTP status remains 503 and it is **not charged**.
`checkpoint.status = ahead` is not proof of rollback.

## Tests and evidence

`npm run check` covers independent public golden vectors, tampering, missing
events, rotation, checkpoints, malformed RPC responses, finality/reorg behavior,
bounded collection, HTTP validation and actual x402 SDK buffering with a mocked
facilitator. Unit tests are deterministic and do not use keys or send payments.

`evidence/registry-bootstrap.json` records the real RPC/explorer bytecode comparison.
`evidence/live-sepolia-report.json`, when present, is a read-only live report.
`test/fixtures` are reused upstream test data, not original authored code. See
[NOTICE](./NOTICE) for exact source commits and attribution.

`npm run manifest` writes a draft `service.json` after `GITHUB_USERNAME` and
`PAY_TO` are supplied. It validates against the unmodified official Kite schema.
Change status to `testnet` / `live` only after real deployment and paid-call
evidence. If using a different RPC provider, update the public upstream metadata
in `scripts/manifest.ts` without exposing credentials.

## Scope before operating publicly

This is a small reference service. Production operation also needs deployment
monitoring, abuse/rate controls at the ingress, RPC capacity planning, and a
durable way to reconcile uncertain settlements and recover paid reports. The
service bounds concurrent audits and facilitator work, but that is not a complete
per-client rate limiter. Do not market it as a full security audit or a proof of
memory correctness.

Code is Apache-2.0. Standard text and public test data retain their source licenses.
