# Deployment runbook

There are three stages, each a separate decision:
1. **Testnet**
2. **Founder-only mainnet commissioning**
3. **Public mainnet** — a separate go/no-go; the deploy script refuses this stage today.

## 0. Keys and roles (once per stage)

Each role uses a different key. None of them is ever pasted into chat, committed or logged.

| Role | Holds | Used by | Notes |
|---|---|---|---|
| Deployer | Foundry keystore (`cast wallet import dime-deployer --interactive`) | `scripts/deploy.sh` | Deploys the contracts, hands admin over, and keeps no role afterwards |
| Admin | Founder cold wallet or multisig (`DIME_ADMIN`) | manual only | Config, allow-list, reopening, reserve funding and withdrawal |
| Relayer | `/etc/dime/keys/relayer.key` | API | `RELAYER_ROLE`: opens matched and house positions, relays closes. Needs gas. |
| Reporter | `/etc/dime/keys/reporter.key` | pricing | Signs the **operator-controlled** reference price (commissioning only) |
| Keeper | `/etc/dime/keys/keeper.key` | keeper | No role needed: liquidate, protect and fund are permissionless. Needs gas. |
| Guardian | `/etc/dime/keys/guardian.key` | watchdog | `GUARDIAN_ROLE`: can only move the protocol toward less risk |

Generate the operational keys **on the server**, so they never leave it:
```bash
sudo -u dime sh -c 'cast wallet new --json | jq -r .[0].private_key > /etc/dime/keys/relayer.key'   # repeat per role
sudo chown root:dime /etc/dime/keys/*.key && sudo chmod 640 /etc/dime/keys/*.key
cast wallet address --private-key "$(sudo cat /etc/dime/keys/relayer.key)"   # address only; for DIME_RELAYER
```

## 1. Testnet (Monad testnet, chain 10143)

```bash
# Gas: fund the deployer, relayer and keeper with testnet MON from the Monad faucet.
DIME_STAGE=testnet RPC_URL=https://testnet-rpc.monad.xyz DIME_EPOCH_SECONDS=3600 \
DIME_ADMIN=0x… DIME_RELAYER=0x… DIME_GUARDIAN=0x… DIME_REPORTER=0x… scripts/deploy.sh
```

The script:
- deploys `TestUSDC` ("DIME Test USDC (testnet, no value)") and the libraries, verifier and protocol;
- writes `deployments/10143.json` with the real transaction hashes and deployment block;
- verifies the contracts on MonadVision (Sourcify);
- regenerates `shared/abi.ts` and `envio/config.yaml`.

Then, as the admin, fund the house reserve with test tokens: `TestUSDC.mint`, `approve`, then `DimeProtocol.fundReserve(10e6)`.

Record the evidence (transaction hashes, explorer links) in `docs/EVIDENCE.md`. Never fabricate it.

## 2. Server (shared VPS)

Read `deploy/setup-server.sh` first. It runs as a dedicated `dime` user and doesn't touch other services (Cathena included). It doesn't reload nginx or handle keys.

```bash
rsync -a --exclude node_modules ./ vps:/opt/dime/app/   # or git clone
ssh vps 'cd /opt/dime/app && sudo deploy/setup-server.sh'
ssh vps 'cd /opt/dime/app/backend && sudo -u dime npm ci'
# /etc/dime/backend.env  ← from backend/.env.example
#   (CHAIN_ID, RPC_URL, MANIFEST_PATH=/opt/dime/app/deployments/10143.json, key file paths, CORS, PRIVY_APP_ID, AUTH_MODE=privy)
sudo systemctl enable --now dime-pricing dime-api dime-keeper dime-watchdog
# Frontend (static):
NEXT_PUBLIC_APP_MODE=live NEXT_PUBLIC_API_URL=https://dime.rndm.io/api NEXT_PUBLIC_STREAM_URL=wss://dime.rndm.io/api/v1/stream \
NEXT_PUBLIC_ENVIO_GRAPHQL_URL=… NEXT_PUBLIC_VAULT_ADDRESS=… NEXT_PUBLIC_USDC_ADDRESS=… NEXT_PUBLIC_CHAIN_ID=10143 \
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz NEXT_PUBLIC_PRIVY_APP_ID=… STATIC_EXPORT=1 npm run build   # → out/
sudo ln -s /etc/nginx/sites-available/dime.conf /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dime.rndm.io
```

Pricing (port 8710) and the keeper (8730) bind to localhost. Only nginx (80/443) is public.

**Envio:**
- Run `node scripts/envio-config.mjs deployments/10143.json`.
- Set `ENVIO_API_TOKEN` in the indexer's environment (HyperSync requires it).
- Run `envio start` (self-hosted, needs Docker for Postgres) or deploy to Envio's hosted service.

## 3. Founder-only mainnet commissioning (chain 143)

Preconditions: testnet acceptance tests passed with evidence recorded, and the open decisions in STATUS.md are acknowledged.

```bash
DIME_STAGE=commissioning RPC_URL=https://rpc.monad.xyz DIME_COLLATERAL=<canonical USDC, verified by you> \
DIME_ADMIN=… DIME_RELAYER=… DIME_GUARDIAN=… DIME_REPORTER=… scripts/deploy.sh
```

The commissioning config:
- allow-list on;
- per-wallet deposit cap of $1;
- margin $0.10–$0.50;
- 3 house slots and 5 matched pairs;
- daily epochs.

Then, as the admin: `setAllowlisted([founder wallets], true)`, then `fundReserve(10e6)`.

The UI must show "operator-signed reference (not an independent oracle)". The manifest records `independentOracle: false`.

## Incident runbook

| Situation | Who | Action |
|---|---|---|
| Reference stale for 10 s or more | watchdog (automatic) | Guardian → `ORACLE_HOLD`. New opens and settlements wait; withdrawals of free funds continue. |
| Recovery from `ORACLE_HOLD` | admin (manual) | Confirm price health (`/health`, `/metrics`), then `setProtocolState(OPEN)`, or `CLOSE_ONLY` first |
| Suspected bug or abnormal loss | guardian / admin | `CLOSE_ONLY` (no new risk; closes and liquidations continue) |
| Orderly shutdown | guardian / admin | `WIND_DOWN`; the keeper settles open positions in batches of 20 at verified prices |
| Unfunded liabilities above 0 | contract (automatic) | `INSOLVENT`; alert fires. Settlement follows the published shortfall policy (still an open decision). |
| Low gas on relayer or keeper | watchdog alert | Top up. The executor never resubmits blindly; `UNKNOWN` transactions are reconciled from receipts. |

## Public mainnet go/no-go (not yet possible)

- An independent oracle adapter is designed and tested (replacing `OperatorPriceVerifier`).
- The gap policy, reserve protection and liquidation buffer decisions are recorded.
- An external contract review is complete.
- Testnet and commissioning evidence plus measured latency and failure results are published.
- The admin is a multisig.
