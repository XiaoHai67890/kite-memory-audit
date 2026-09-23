# Deploy the API to Vercel

Vercel's native Express integration runs the root `app.ts` default export as one
Node.js Function. The existing `npm start` entrypoint remains for Node/Docker.
No URL rewrites, Edge runtime, or payment proxy are needed.

## Project settings

Import this repository, use the **Express** framework, Node.js **22.x or newer**,
and keep **Fluid compute enabled**. `vercel.json` sets a 120-second function limit
and includes the reviewed registry file in the function bundle. This allows
15 seconds for payment verification, 45 seconds for evidence collection, and
15 seconds for settlement, with additional startup/response headroom.

Vercel currently documents a 300-second maximum for Hobby with Fluid compute.
Legacy Hobby functions without Fluid are capped at 60 seconds and are unsuitable
for this API's full request budget. Vercel's Hobby plan is restricted to personal,
non-commercial use; do not assume an API charging real money or a rewarded bounty
deployment qualifies. Select a suitable plan before operating commercially.

## Environment

Configure these in the Vercel project's **Production** environment before the
production deployment. If testing a Preview, configure its environment separately.

| Variable | Value |
| --- | --- |
| `AUDIT_MODE` | `paid` |
| `KITE_NETWORK` | `testnet` for the first real integration |
| `PAY_TO` | The participant's actual nonzero public EVM receiving address |
| `PUBLIC_BASE_URL` | The stable production HTTPS origin, with no path/query |
| `PRICE_USD` | `0.001` for the example; this is denominated in the selected asset |
| `SEPOLIA_RPC_URL` | A reliable HTTPS Sepolia RPC supporting finalized/history queries |
| `REGISTRIES_FILE` | `config/registries.json` |
| `MAX_CONCURRENT_AUDITS` | `2` per function instance |

Leave `FACILITATOR_URL` unset to use the official configured facilitator. The
service never needs a private key. Mark credential-bearing RPC URLs as sensitive.

`PAY_TO` and `PUBLIC_BASE_URL` are captured from the deployment environment, not
from request Host headers, forwarding headers, preview URLs, or request bodies.
Changing them requires a new deployment. The hosted entrypoint rejects `local`
mode even if `HOST=127.0.0.1` is set. Do not change this guard for a public demo.

If selecting a different registry file, commit its reviewed public configuration
and update `includeFiles` in `vercel.json` to include it. Do not store an RPC key in
that file. The concurrency limit is per instance; Vercel may run several instances.

## Validate the deployed service

1. Ensure the production API can be reached by the Passport client without a
   Vercel login page. Preview Deployment Protection is not x402 authentication.
2. Check `GET /healthz` reports `mode: paid` and the intended payment network.
3. Send `examples/request.json` to `POST /v1/memory/audit` without payment. Expect
   402 and decode `PAYMENT-REQUIRED`; verify the receiver, asset, amount and exact
   `PUBLIC_BASE_URL` resource before authorizing any payment.
4. Run a genuine Passport Agent call on Kite testnet and retain the report,
   request, receipt, transaction hash, network and timestamp. Tests using the
   fake facilitator do not count as this evidence.
5. Follow `SUBMISSION.md`; a successful deployment alone is not a paid-call proof.

Do not enable request cancellation for this function: terminating an in-flight
settlement can leave its outcome unknown. Existing settlement-timeout limitations
and the need to inspect receipts before retrying still apply.

Official references, checked 2026-09-23:

- [Express integration](https://vercel.com/docs/frameworks/backend/express)
- [Function duration](https://vercel.com/docs/functions/configuring-functions/duration)
- [Function limits](https://vercel.com/docs/functions/limitations)
- [Function file inclusion](https://vercel.com/docs/project-configuration/vercel-json#functions)
- [Hobby plan scope](https://vercel.com/docs/plans/hobby)
