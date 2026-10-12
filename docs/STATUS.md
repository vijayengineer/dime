# Status: what's completed, mocked, tested and blocked

_As of 2026-10-12. Path: testnet → founder-only mainnet commissioning → public mainnet
(see BACKEND_BRIEF.md, DEPLOYMENT.md)._

## Completed and tested locally

| Area | What | Evidence |
|---|---|---|
| Contracts | `DimeProtocol` (custody, house and matched positions, settlement, liquidation, protection, wind-down, states, allow-list), `DimeMath`, `DimeRights`, `OperatorPriceVerifier`, `TestUSDC`, deploy script with manifest | `forge test`: **28 passing**. Covers the custody cap, allow-list, the fee reducing the payout only, high-water-mark rights, liquidation through a gap, protection extend and close, capacity, house fallback timing, counterparty close, matched gap cap, matched liquidation, self-match and mismatch, replay and cancel, signature binding (chain, contract, signer, tamper), config and expiry, one position per wallet, relayer-only opens, stale or future or unauthorised prices, price limit, CLOSE_ONLY and ORACLE_HOLD, wind-down batch, the full rights lifecycle, duplicate-claim prevention, loss recovery before distribution, and two 256-run fuzz tests of the conservation invariant |
| Backend | Pricing (6 live feeds, basis-adjusted median, quality flags, operator reference signing), API (quotes, intents, cancel, close, manifest, metrics, WS stream, Privy JWT, CORS, rate limits, idempotency), FIFO whole-ticket matcher, sequential relayer executor with receipt reconciliation, event watcher, keeper, watchdog | `npm test`: **12 passing**. `npm run e2e`: **15/15** against a local chain with the real contracts. Covers matched open (shared pairId), idempotent replay, duplicate nonce, relayed close settling both legs, match-only expiry, house fallback after the window, keeper liquidation on a shock, rights issued, keeper epoch funding and activation, and the on-chain conservation invariant |
| Pricing v2 (live) | Hyperliquid BTC perp + Binance BTC/USDT on **2 redundant connections each** (deduped by sequence; Binance fails over across 3 public endpoints; staggered rotation before forced disconnects; 20 s pings for HL's 60 s idle limit), plus Coinbase, OKX, Bybit, Kraken. Per-venue **microprice**, quote-group basis (USD / USDT / USDC perp), **liquidity-weighted median** capped at 40%/venue with freshness decay; plain median kept for comparison; Hyperliquid oracle as a cross-check | 75 s live run with forced drops of one Binance and one Hyperliquid link: **0 gaps, 0 index outages** (each dropped link reconnected; 8,914 and 675 duplicate updates absorbed). Internal processing p50 0.57 ms / p99 1.26 ms (n = 19,886). Weighted vs plain median 0.03 bp; disagreement 1.6 bp; HL oracle +10.6 bp vs the USD estimate (USDT-denominated). Single-link venues show trade-driven quiet intervals as "gaps" (labelled). 18 backend unit tests |
| Demo with live data | `NEXT_PUBLIC_PRICE_FEED_URL` → demo uses the real feed (trading still simulated, banner says so; feed loss shows an error, no synthetic fallback). Activity → Price feed health shows links, weights, uptime, gaps, latency; Scenario lab has a failover drill | Verified in the browser: dropping a Binance link turns one dot red while uptime stays 100% and gaps 0; the link reconnects within seconds |
| Envio | v3 config generated from the manifest; schema and handlers for all protocol and rights events | `envio codegen` plus `tsc` against the generated types pass. **Not run**: needs Docker (local) or a HyperSync token |
| Frontend | Demo mode as before. The live adapter now uses the generated ABI, signed cancels and real distribution getters | `tsc`, `next build`, and the static export (`out/`) all pass. 23 tests pass |
| Ops | `scripts/deploy.sh` (stage and chain guard, canonical-USDC confirmation, MonadVision Sourcify verification), `finalize-manifest` (real transaction hashes and block), systemd units (dedicated user, hardening), nginx (TLS via certbot, `/api` proxy, WS), `setup-server.sh`, runbook | Written. Server steps not run (no VPS access yet) |

Local measurements (local chain with 1 s blocks and a mock feed, so **not** Monad performance):
- quote p50 0.19 ms
- admission p50 4.3 ms
- relayer send→inclusion p50 768 ms
- admit→opened p50 552 ms (n = 3)

| DIME token + staking | `DimeToken` (non-transferable until a one-way admin switch), issuance of 0.1 DIME per $1 eligible house loss decaying above $1M reserve with a per-epoch cap, stake/unstake with next-epoch activation, USDC rewards to stakers. House page redesigned (Your DIME, House on Monad, DIME stats, reward curve, distribution, exposure) | Contracts: **33 passing** (adds emission decay, mint cap, stake/unstake, non-transferability, one-way enable, minter-only). Frontend 26 tests. Backend 18 unit + **15/15 e2e** on the new contracts |
| Simplified trading | Ticket is side → margin → leverage; route, window and tolerance are auto-selected server-side (`shared/execution.ts`) and shown before signing | Demo engine tests updated (auto fallback, match-only when the house is full, capacity loss mid-window) |

## Mocks and labels

- `OperatorPriceVerifier`: an operator-signed reference. It reports `isIndependentOracle() == false` and is
  allowed only for testnet and commissioning.
- `TestUSDC`: worthless testnet collateral with a faucet. The deploy script and config refuse it outside the
  testnet stage.
- `PRICE_SOURCES=mock` and `AUTH_MODE=none` are for local tests only and are refused when `NODE_ENV=production`.
- The frontend demo engine is unchanged and still labelled.

## Deployment blockers (need you)

1. **Testnet deploy:**
   - a deployer keystore on your machine or the server;
   - testnet MON for the deployer, relayer and keeper;
   - role addresses (admin, relayer, guardian, reporter).

   Then `scripts/deploy.sh`.
2. **VPS:** host, SSH user and key path, and a subdomain (`dime.rndm.io`?) with DNS. I'll inspect the box
   read-only first, without touching Cathena.
3. **Envio:** an `ENVIO_API_TOKEN` (HyperSync; Monad 143 and 10143 are supported) in the server env file,
   not in chat. Or Docker to run it locally.
4. **Privy:** an app ID for `AUTH_MODE=privy` and the frontend.
5. **Commissioning only:** the canonical USDC address on Monad mainnet, confirmed by you (the script asks you to
   type YES after showing the token's symbol and decimals).

## Unresolved decisions (change financial rights; not improvised)

0. **DIME transferability and legal review.** DIME is non-transferable until the admin schedules transfers with
   at least 7 days' notice. A transferable token whose stakers earn protocol revenue needs legal sign-off
   before `scheduleTransfers()` on mainnet. The emission
   parameters (0.1 DIME/$, $1M decay, per-epoch cap) are UNVALIDATED; see the farming bound in CONTRACTS.md.

1. **Matched gap policy.** Currently backstop = 0, so the winner's gross is capped at the loser's collateral.
2. **House reserve protection.** A reservation of 20× margin is extended from free capacity, or the position is
   closed early. In practice this is a dynamic ceiling.
3. **Liquidation buffer.** The loser forfeits the full margin, including the 10% maintenance buffer, to the
   counterparty.
4. **1000× and the match window.** A ~9 bp liquidation distance means ~2 bp tolerance, so expect rejections on
   longer windows. Needs measured testnet data.
5. **Oracle for public mainnet.** Adapter design, freshness and outage recovery are unresolved. The
   operator-signed reference is not acceptable for public real money.
6. **Insolvency shortfall rule.** The contract records the shortfall and enters INSOLVENT, but the pro-rata
   settlement policy is not specified.
7. **Parameters** marked UNVALIDATED. The commissioning config is more conservative (deposit cap $1, max margin
   $0.50, 3 house slots and 5 pairs).

## Known gaps and untested assumptions

- Monad specifics are untested until testnet:
  - whether consecutive blocks can share a timestamp (the contract allows 1 s granularity);
  - the CREATE2 deployer used for the libraries;
  - gas costs.
- The e2e test runs on anvil only. No load test yet: throughput is bounded by one relayer with one transaction
  in flight.
- Correlated-wallet risk: address-level self-match prevention only. Rights farming is limited because matched
  trades issue no rights and house issuance follows the net-loss high-water mark (tested). Multi-wallet
  wash-trading against the house is not prevented beyond deposit caps and the allow-list.
- The Envio indexer has not been run. The live frontend's indexer-lag query (`chain_metadata`) needs checking
  against Envio v3.
- No external audit.
