# Kite bounty submission preparation

Direction: **01 — x402 paid service**.

## Implemented contribution

An ERC-8350 memory-history audit API with an allowlisted registry, finalized-block
evidence collection, replay/checkpoint reporting, Kite x402 payment integration,
and adversarial tests. Reused vectors/schema/network constants are attributed in
NOTICE; the original contribution is the collector, report logic and service
integration, not a copy of upstream history.

## Evidence to complete before submitting

- [x] Activity dashboard confirms a verified wallet and bound GitHub account `XiaoHai67890`.
- [ ] Commit the actual reviewed implementation using the contributor's own Git
      name/email and GitHub identity, inside the activity's current statistical week.
- [ ] Publish the source repository and record the exact commit URL.
- [ ] Deploy to a public HTTPS origin and configure the actual receiving address.
- [ ] Run `npm run check` and `npm run build`; save the CI workflow URL.
- [ ] Generate and validate the service manifest with actual maintainer/address.
- [ ] Capture an unpaid request returning 402, including decoded PAYMENT-REQUIRED.
- [ ] Resolve the current Passport/Kite payment-network compatibility prerequisite
      in [PAID_CALL.md](./PAID_CALL.md); facilitator support alone does not establish
      Passport payer support. Confirm any alternative client's eligibility.
- [ ] Use the participant's Passport Agent to make a successful paid call.
- [ ] Save the response, settlement transaction hash, network, timestamp and request.
- [ ] Exercise an upstream failure and record that no settlement occurred.
- [ ] Set `status: testnet` only for deployed/tested pieUSD service; `live` requires
      deployed/tested Kite mainnet USDC.e. Confirm the bounty accepts the chosen network.
- [ ] Include deployment URL, manifest, report, tests and real payment evidence.
- [ ] Complete any required Electric Capital registration; do not claim it is merged
      or rewards are available without checking the activity dashboard.

Automated mocked facilitator tests and read-only RPC reports do **not** satisfy the
real participant-paid-call item. A locally created Git repository without a commit
or remote is not a published GitHub contribution. Never backdate a commit.

## Suggested commit title

`feat: add ERC-8350 memory audit service with Kite x402 payments`

## Completion description template

> Implemented an ERC-8350 memory-history audit API with finalized-block evidence,
> sequence/root replay, authorization history and checkpoint checks. Integrated
> Kite x402 payments with verify → audit → settle ordering; incomplete evidence
> returns non-2xx without settlement. Added golden-vector, adversarial RPC and
> payment-flow tests. Deployed at [ACTUAL URL] on [ACTUAL PAYMENT NETWORK].
> Paid-call evidence: [TRANSACTION HASH / RECORD]. CI: [WORKFLOW URL].

Fill only facts verified in the submitted version. Do not include the deployment
or paid-call sentences until those actions have actually succeeded.
