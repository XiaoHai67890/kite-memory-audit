# Real paid-call handoff

Reviewed on 2026-09-23. **A real participant payment is still pending.** Mocked
facilitator tests, an unpaid 402, and read-only Sepolia reports are separate
evidence; none proves that a Passport payment succeeded.

## Resolve the Passport network prerequisite first

The official [Kite x402 service README, commit 893a275](https://github.com/gokite-ai/kite-x402-services/blob/893a27509648b660bbba626b0da59619a94f04ab/README.md#test-with-a-kite-passport-agent)
describes a Kite testnet/pieUSD sandbox flow. The Pieverse facilitator's public
`/v2/supported` response was also observed to include Kite `eip155:2368` and
`eip155:2366`. This supports the service's facilitator configuration.

However, the current official [Passport execute reference, commit a1541a2](https://github.com/gokite-ai/passport-skills/blob/a1541a2d1bf388fcf9de33e8ce0721ac2c1496cd/x402-execute/references/commands.md)
advertises **Arc testnet only** for its development backend and lists mainnet
networks without Kite. Its current command is `kpass session execute`. The
[session documentation at the same commit](https://github.com/gokite-ai/passport-skills/blob/a1541a2d1bf388fcf9de33e8ce0721ac2c1496cd/request-session/SKILL.md)
also replaces normal-session amount/TTL flags with a delegation JSON object.

Consequently, **a currently supported Passport-to-Kite route has not been
established**. Facilitator support does not imply that the Passport payer backend
supports the same chain. Obtain confirmation from Kite of a compatible participant
environment/client before authorizing a session. An alternative x402 client must
explicitly support Kite's asset and EIP-712 domain; if the activity requires
Passport evidence, confirm whether that alternative is acceptable. Do not change
the payment network or use an undocumented backend to make a demonstration pass.

## Once a compatible participant client is confirmed

1. Follow the [official Passport installation/account guide](https://docs.gokite.ai/kite-agent-passport/beginner-setup).
   The participant handles email verification and passkey prompts. No private key,
   seed phrase, OTP, or session credential belongs in this repository.
2. Confirm the public service returns a 402 for the valid JSON request in
   `examples/request.json`. For this testnet service, inspect network `eip155:2368`,
   pieUSD asset `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`, the intended recipient,
   and the advertised price. At `0.001`, the amount is `1000000000000000` units.
3. Create a session using that compatible client's documented syntax. Scope it
   to the exact service's `POST /v1/memory/audit`, pieUSD, one request's budget,
   and a short expiry. The participant reviews the delegation and approves it
   with their passkey. Test tokens still require an actual signed authorization.
4. If the confirmed client supports the current `session execute` interface,
   the POST invocation is:

```sh
audit_url='https://YOUR-PUBLIC-ORIGIN/v1/memory/audit'
audit_body="$(cat examples/request.json)"
kpass session execute --method POST --url "$audit_url" \
  --headers '{"Content-Type":"application/json"}' --body "$audit_body" \
  --output json > evidence/passport-call.local.json
```

This is a conditional command template, not a claim that the current default
Passport backend accepts this service. Do not run it until the network
prerequisite and participant approval are satisfied.

## Evidence to retain

Keep the raw CLI result private (`*.local.json` is ignored). Publish a reviewed
record containing the service URL, UTC time, request body, HTTP 200 audit report,
actual payment network/token/amount, and settlement transaction reference from
the returned receipt. Verify that reference on the reported chain. Include the
service commit and CI run. Do not publish session credentials, cookies, payment
signature headers, or account details.

The audited registry in the example is on Sepolia; payment is on Kite testnet.
An incomplete report is non-2xx and is not submitted for settlement. A timeout
during settlement can be ambiguous: check the existing receipt/chain before
authorizing another payment. Keep the manifest in `draft` until the real paid
call has been demonstrated and the activity's network requirement is confirmed.
