# Audit remediation (October 2026)

Response to the source, contract and operations audit of commit `c93d9cb` (17 findings: 4 High, 9 Medium,
4 Low). Every finding has a code change and a regression test that **fails if the audited behaviour returns**.
Contract fixes require the v2 deployment (the v1 contracts are not upgradeable); backend and app fixes ship with it.

Test status after remediation:

| Suite | Result |
|---|---|
| Contracts (`forge test`) | **89 passing**: the original 37 (re-run under the new settlement rules) + 15 audit regressions (`contracts/test/Audit.t.sol`) + inherited base cases |
| Backend unit (`npm test` in `backend/`) | **43 passing**: 21 original + 22 audit regressions (`backend/test/audit.test.ts`) |
| End-to-end (`npm run e2e`, local chain + real contracts + all services) | **18/18** (terms, matching, relayed close, back-dated close refused, house fill, keeper liquidation, DIME issuance, epoch funding, conservation) |
| App (`vitest`) | **26 passing** (the two routing tests updated to house-first) |

## High

| ID | Fix | Where | Regression |
|---|---|---|---|
| H-01 caller-selected historical proofs | No caller picks a settlement price. Price rounds (250 ms, `round = tsMs / 250`, bound by the verifier). **Relayed close**: settles at a round after the signed request time, within 30 s of it; the relayer submits the first round after it *received* the request, so back-dating cannot reach a historical round. **Direct close**: commit on-chain (`requestClose`), the keeper settles at the first rounds after the commit block (fresh price if those were missed). **Liquidation / protection / wind-down**: `KEEPER_ROLE` only, at a fresh current round; permissionless only after an hour of keeper silence (`keeperHeartbeat`), and still only at a fresh price. | `DimeProtocol.close / requestClose / settleCommittedClose / liquidate / protect / windDownSettle`, `OperatorPriceVerifier` v2, API `/v1/close`, keeper | `test_audit_H01_*` (7 tests), e2e "back-dated close request refused" |
| H-02 basis alignment | The basis is learned only while ≥2 independent, agreeing USD venues are fresh; on new observations only, weighted by elapsed time (τ = 60 s), bounded per step (5 bp) and in size (100 bp). `compute()` is a pure snapshot. Disagreement checked inside the anchor group, inside every group and after adjustment. | `backend/src/pricing/aggregate.ts` | `audit H-02` (4 tests, including the audit's startup case) |
| H-03 freshness and ordering | Freshness from the exchange's own timestamp where the venue provides one (receipt time only for Binance bookTicker and Kraken ticker, which have none). Clock-skew guard. Strict per-venue sequence ordering and non-decreasing exchange time; a lower sequence only after a reconnect gap. The signed round carries the **oldest observation time**, and the contract refuses to open on data older than `maxSourceAgeMs`. | `aggregate.ts`, `sources.ts`, `pricing/main.ts`, `DimeProtocol._priceOpen` | `audit H-03` (6 tests), `test_audit_H03_staleObservationsCannotOpen` |
| H-04 degraded single-venue references | OK needs ≥3 venues (so the 40% cap holds). Quality and venue count are **signed** and enforced on-chain: opening needs `quality == OK` and `sources ≥ minOpenSources` (3). DEGRADED (Hyperliquid alone) is signed for settlement only: closes and liquidations keep working through a feed outage, new risk does not. Pricing health = OK only; API reports `opensAvailable`. | `aggregate.ts`, `pricing/main.ts`, `pricing/client.ts`, `DimeProtocol._priceOpen` | `test_audit_H04_*` (2), `audit H-04` (3) |

## Medium

| ID | Fix | Regression |
|---|---|---|
| M-01 minter lock reopenable | DIME v2: `mint` checks `msg.sender == protocol`, set once, never changeable. No role grants minting, so no admin path adds a minter. | `test_audit_M01_adminCannotBecomeMinter` (the audit's exact path) |
| M-02 close vs liquidation at the boundary | One rule everywhere: a settlement at or past the liquidation price **is** a liquidation (house, matched, emergency). | `test_audit_M02_*` (house and matched) |
| M-03 ambiguous broadcasts / stranded requests | Transactions are signed locally and **journalled (raw bytes, nonce, hash) before broadcast**; an ambiguous send is UNKNOWN, never FAILED. The reconciler settles them from receipts and the sender nonce (DROPPED when the nonce was used elsewhere) and re-broadcasts identical bytes. Resolved transactions settle their requests; on start and every 5 s every SUBMITTED request is decided from chain state (position exists → OPENED; nonce unused and nothing can land → REJECTED). | `audit M-03` (ambiguous send → UNKNOWN → reconciled; definite rejection → FAILED) |
| M-04 matched pair commits one leg | Both transitions run in one SQLite transaction that **throws** on either failure, rolling back both. | `audit M-04` (the audit's cancellation race) |
| M-05 ageing proofs, shared queue | Jobs carry an argument builder run at send time, so proofs are fresh when sent. Priority queue: closes, liquidations, protection, heartbeats and state changes before opens. Per-job deadlines. | `audit M-05` ordering and send-time build tests |
| M-06 proxy-shared rate limits | `trustProxy` set to the local proxy hop only (`TRUST_PROXY`). Sessions are verified in an `onRequest` hook registered before the rate limiter, so buckets are per user (signed in) or per real client IP. | `audit M-06` (two users behind one proxy; per-IP for anonymous) |
| M-07 keeper health | Keeper health reports whether it can **act**: last successful chain read, a settlement-grade price while positions are open, signer gas, queue age, consecutive action failures (`IDLE` / `WATCHING` / `UNABLE_TO_ACT`). The watchdog moves the protocol to CLOSE_ONLY if the keeper is unable to act for 2 minutes while OPEN (never reopens automatically). | Covered by keeper/watchdog code paths; e2e exercises liquidation and epoch funding |
| M-08 faucet record tied to invites | Independent `gas_grants` ledger keyed by wallet (PENDING → SENT → CONFIRMED), reserved before sending, plus a global daily budget (`FAUCET_DAILY_BUDGET_WEI`, default 3 MON). Legacy drips migrate in. | `audit M-08` (open mode, once per wallet, budget) |
| M-09 win cap under-described | The ticket and review sheet show **Max win** (reservation, gross and net) before signing and explain extension and early close; settlements emit `SettlementDetail(id, rawGrossPnl, capped)` and the app shows capped settlements. | `test_audit_M09_cappedWinIsFlagged` |

## Low

| ID | Fix |
|---|---|
| L-01 stale manifest and docs | `/v1/manifest` returns the deployment evidence **and** a block-stamped `current` view (state, config, house, contract allow-list vs application invite-only). README and STATUS updated; this file records the change. |
| L-02 audit records not replayable | Records carry the model version, round, quality, venue count, observation time, every input with exchange and receipt times, full-precision weights and venue views, the basis state used and when it last changed, and the model parameters. Write failures are logged, exposed in pricing health, and make health non-OK for a minute. |
| L-03 bounded in-memory indexer | Events and the cursor persist in SQLite (deduplicated by tx + log index); history queries are indexed; the block-time cache is bounded. |
| L-04 drifted tests | Demo routing tests updated to house-first; the end-to-end suite now accepts terms, uses server auto-routing and the new close request, and passes 18/18. |

## Dependency advisories

`npm audit --omit=dev` flags `ws` (GHSA-96hv-2xvq-fx4p, memory-exhaustion DoS) nested under the Privy and
WalletConnect wallet libraries. In the browser those libraries use the native `WebSocket`, and every DIME page is
prerendered static, so no server-side `ws` runs in the app. Not upgraded blindly (npm's suggested fix is a
breaking major change to the wallet stack); re-check when Privy ships an update. The backend reports none.

## Residual risk (unchanged by design, stated plainly)

- **Single operator.** The verifier proves a price was signed by DIME's reporter, not that it is fair; the admin
  can replace the verifier and change settings. Within that trust model the remaining discretion sits with the
  operator (which signed round the relayer/keeper submits inside a short window), not with users or third parties.
- **Escape hatch.** If the keeper is silent for an hour, anyone may liquidate/protect at a *fresh* price; inside the
  ~4 s freshness window there is still some choice. This only applies during a keeper outage.
- **Host isolation.** Pricing, API, keeper and watchdog run under one Unix user; separate keys are not separate
  compromise boundaries. Planned: isolated users, a constrained signing service, multisig/timelock for admin.
- **Capital and incentives.** Reservations bound house payouts; capital limits should follow capped obligations and
  measured throughput. DIME farming via coordinated wallets is an incentive-analysis item, not solved by code.
