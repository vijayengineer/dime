# DIME — Degen Intelligence Monad Exchange

Small-ticket BTC trading on Monad, by RNDM: two execution routes (peer-matched and house-backed),
a transparent house reserve, and non-transferable earnings rights. "Not paper. Real trades, dime-sized."
(Name provisional — see docs/NAMING.md; earlier working names CHALK and FLIP.)

> **Status:** contracts, backend and indexer are built and tested locally (local chain end to end).
> Live on Monad mainnet (invite-only, real USDC) at https://dime.rndm.io. Contract addresses: [docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md); live settings are block-stamped at `/v1/manifest`. October 2026 audit response: [docs/AUDIT-REMEDIATION.md](docs/AUDIT-REMEDIATION.md).

```bash
npm install && npm run dev          # frontend, demo mode: http://localhost:3000
npm test                            # frontend domain maths + demo engine (23)
forge test                          # contracts (28, incl. fuzz)
cd backend && npm ci && npm test    # backend unit tests (12)

# Full local stack end-to-end (15 checks): local chain → deploy → pricing/api/keeper → API flows
anvil --code-size-limit 131072 --block-time 1 &
DIME_STAGE=testnet RPC_URL=http://127.0.0.1:8545 DEPLOYER_ACCOUNT=<anvil keystore> \
  DIME_ADMIN=… DIME_RELAYER=… DIME_GUARDIAN=… DIME_REPORTER=… scripts/deploy.sh
cd backend && npm run e2e
```

To run live mode, copy `.env.example` to `.env.local`, set `NEXT_PUBLIC_APP_MODE=live`
and fill in every value. Missing values show an error screen; the app never falls back
to demo data.

## Layout

| Path | What |
|---|---|
| `src/config/brand.ts` | All naming. Rename the product here ([docs/NAMING.md](docs/NAMING.md)) |
| `src/config/protocol.ts` | Parameters. UNVALIDATED values are marked; live mode reads them from the chain |
| `src/domain/` | bigint fixed-point maths: settlement, fees, caps, liquidation, rights ledger, EIP-712 types. Unit tested |
| `src/adapters/types.ts` | Typed adapter interfaces: wallet, account, market, config, intents, positions, house, rights, history, tx |
| `src/adapters/demo/` | Deterministic demo engine + scenario lab |
| `src/adapters/live/` | Privy + viem + REST/WS + Envio implementation, aligned with the real backend + generated ABI (not yet run against a live deployment) |
| `src/state/` | Services provider, app-wide feed subscriptions, client-side metrics |
| `src/app/` | Play, The House, Activity |
| `contracts/src/` | `DimeProtocol.sol` + `lib/DimeMath`, `lib/DimeRights`, `oracle/OperatorPriceVerifier`, `test-tokens/TestUSDC` (Foundry tests in `contracts/test`) |
| `backend/` | Pricing, API + matcher + relayer, keeper, watchdog (TypeScript); unit + end-to-end tests |
| `envio/` | HyperIndex v3 schema + handlers (config generated from the deployment manifest) |
| `deploy/`, `scripts/` | systemd units, nginx, server setup, deploy/verify/manifest scripts |
| `shared/abi.ts`, `deployments/` | Generated ABIs; deployment manifests with on-chain evidence |
| `docs/` | [STATUS](docs/STATUS.md) · [CONTRACTS](docs/CONTRACTS.md) · [API](docs/API.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) · [BACKEND_BRIEF](docs/BACKEND_BRIEF.md) · [NAMING](docs/NAMING.md) |

## Design

"Slate & chalk": a dark chalkboard surface, hand-drawn display type (Cabin Sketch),
monospace numerals, and chalk-line SVG icons. The house visual is drawn to scale from
the real reserve split. Matched collateral and unclaimed distributions are drawn
*outside* the house because they aren't house capital. Every number carries a
provenance tag: Estimate, Contract state or Indexed. Long and short colours
(teal/ember) are validated for colour-vision deficiency and always appear with a text
label. Motion is used for feedback only and respects `prefers-reduced-motion`. Losses
are reported plainly, with no "play again" prompt.
