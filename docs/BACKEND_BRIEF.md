# Brief: DIME backend and smart contracts

DIME (Degen Intelligence Monad Exchange) is RNDM's small-ticket BTC trading product
on Monad. This brief covers the backend and the contracts. The frontend already exists
in this repository; see README.md, docs/CONTRACTS.md, docs/API.md and docs/STATUS.md.

Before editing, inspect the repository, AGENTS.md, server configuration and Git
changes. Preserve existing work. Do not alter unrelated services running on the server
(for example, the Cathena services on the shared VPS).

## Responsibility

Build and test:
- Solidity contracts.
- Backend API and price ingestion.
- Small-scale matching.
- Risk checks, settlement and keepers.
- Frontend integration types and ABIs.
- Envio integration.
- Reproducible server and contract deployment.

## Deployment path (three separate milestones)

1. **Monad testnet**, with clearly labelled test collateral (a mock "Test USDC") and a
   labelled operator-controlled price reference.
2. **Founder-only mainnet commissioning:**
   - Real USDC, with an on-chain allow-list of wallets controlled by the founder or by
     explicitly consenting testers.
   - Per-wallet deposit cap of about $1, and the founder's $10 reserve.
   - The operator-controlled reference may be used only if it is labelled as such in
     the UI and the manifest.
   - A guardian can move the protocol to CLOSE_ONLY at any time.
   - Free-balance withdrawals always work.
3. **Public mainnet**, only after all of these are done:
   - the pricing and oracle design is resolved;
   - accounting and emergency procedures are validated on testnet and in commissioning;
   - the open financial decisions in docs/STATUS.md are settled;
   - an external review has taken place.

## Product

BTC only, USDC collateral, isolated margin, up to 1,000× gross leverage.

The initial external funding cap is $10 per wallet, and it is configurable. Trade
tickets are small: $0.10 margin is an illustrative test setting, not a validated
production parameter.

There is no fixed 20-wallet registration limit. Active positions, exposure, request
throughput and sponsored gas are each bounded separately.

The founder's $10 reserve is a commissioning test, not the public-launch capital target.

No Perpl or Kuru execution. Privy handles wallet onboarding and signing in the
frontend. Envio indexes contract activity; it is not an oracle and not proof that market
prices are correct.

## Execution routes

**House-backed**
- The house is the counterparty.
- Positions open only within contract-enforced reserve capacity.
- No fixed dollar profit ceiling and no mandatory fixed expiry.
- Disclosed emergency and reserve-protection rules may close positions early.
- Finite unhedged reserves cannot guarantee every uncapped payoff.

**Matched**
- Pair compatible, equal-size, opposing requests at the same eligible reference price.
- Lock both users' collateral and open both positions atomically.
- Whole tickets only: no partial fills and no automatic counterparty replacement.
- Either participant's close, or a liquidation, settles both sides.
- Disclose counterparty-triggered early closure explicitly.
- No automatic migration into house backing.
- Any house gap backstop must be budgeted explicitly at opening. How an uncovered
  shortfall is treated must be specified before any real-money use.

Users authorise the matching window and whether house fallback is permitted. Expired
or unfilled requests are not positions.

## Accounting and rewards

Keep these balances distinct: free customer balances, locked collateral, house capital,
funded rewards and unfunded obligations.

The working fee is 25% of positive realised P&L. Do not charge it on returned
principal. On house trades the fee reduces the winning payout; do not count it twice as
revenue.

Eligible house-trade losses may mint non-transferable earnings rights:
- No principal redemption and no guaranteed yield.
- Issuance follows a cumulative net-loss high-water mark.
- Rights activate from a later epoch.
- Dilution is explicit.
- Distributions come only from new eligible surplus, after loss recovery, obligations,
  costs and buffers.

Matched losses mainly pay the winners. Keep matched reward issuance disabled until a
separate fee-funded policy has been specified and tested.

A later $1–2m house-funding campaign is pitch material only. Do not implement
fundraising or assume that capital exists.

## Pricing and security

Inspect any existing RNDM pricing code before reusing it. Do not assume it is available
or validated.

Keep model estimates separate from the contract-verifiable reference. Production source
selection, freshness thresholds and outage recovery are still unresolved.

An operator-controlled reference may support labelled testnet and founder-only
commissioning. It must not pass itself off as an independent production oracle; the
verifier contract reports this on-chain.

Bind signed requests to chain, contract, user, market, direction, size, leverage, route
permissions, fee/configuration version, expiry and nonce. Enforce capacity, collateral
and the commissioning allow-list on-chain.

Use fixed-point arithmetic with documented rounding. Test replay, cancellation,
concurrent requests, correlated wallets and reward farming.

Do not assume equal long and short notional removes risk once collateral is exhausted or
positions exit.

## Backend and server

Prefer TypeScript with standard EVM tooling, unless the repository establishes another
suitable stack.

Keep these components separate:
- API and request admission.
- Market-data and reference adapters.
- Matcher.
- Transaction submission and receipt reconciliation.
- Keeper and watchdog.
- Indexed portfolio and history reads.

Use persistent storage for the request lifecycle and reconciliation; don't rely on
process memory for correctness. Contract state remains authoritative.

Use idempotency, bounded queues, structured logs and health checks. A timeout must not
trigger a blind transaction resubmission.

Run supervised services under a dedicated non-root account. Configure TLS, explicit
frontend origins and request limits. Keep databases and privileged endpoints private.

Keep deployment/admin authority separate from operational signing (relayer, keeper,
reporter, guardian). Never print private keys, put them in Git, expose them to the
frontend or ask for them in chat. Use the server's approved secret/signing setup.

Coordinate deployments: no two people or agents may change the same files or restart
the same services at the same time.

## Frontend contract

The frontend's typed schemas (`src/domain/types.ts`, `src/adapters/types.ts`) are the
starting point. Change them only together with the frontend. They cover:
- Market and configuration.
- Account balances.
- Quote and request lifecycle.
- Execution route.
- Position and estimated net P&L.
- House capacity and risk state.
- Earnings rights and claims.
- Transaction and indexed history.

Encode amounts as integer strings with explicit decimals. Distinguish the submitted,
included, finalised, verified and indexed states.

Generate ABIs and a deployment manifest containing: chain ID, contract addresses,
collateral identity, deployment block, configuration version, the allow-list flag and
the oracle type. Never fabricate addresses or live metrics.

## Delivery order

1. Inspect the repository and server, and record deployment blockers.
2. Establish shared types, accounting invariants and contract interfaces.
3. Implement and test custody plus one house-trade lifecycle.
4. Implement and test one matched-pair lifecycle.
5. Add earnings activation, funded distribution and claim.
6. Connect the API, keepers and Envio.
7. Deploy to testnet with the configured signer; verify the contracts and record the
   actual transaction evidence.
8. Run the failure scenarios and publish measured latency and failure results.
9. Founder-only mainnet commissioning: allow-list on, minimal caps.
10. Public mainnet: a separate go/no-go decision.

Acceptance covers:
- deposits and free withdrawals;
- wins and losses;
- duplicate requests and simultaneous openings;
- matched exits;
- stale references and oracle recovery;
- price gaps and reserve exhaustion;
- duplicate-claim prevention;
- allow-list enforcement.

Proceed with implementation and tests on your own. Ask only for missing access, or for
decisions that change financial rights. Clearly separate completed work from mocks,
untested assumptions and deployment blockers.
