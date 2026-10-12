#!/usr/bin/env bash
# Deploy DIME contracts, record evidence, verify on MonadVision (Sourcify), regenerate ABIs + Envio config.
# Keys: uses a Foundry keystore account (never a raw key on the command line).
#   cast wallet import dime-deployer --interactive
# Usage:
#   DIME_STAGE=testnet RPC_URL=https://testnet-rpc.monad.xyz DIME_ADMIN=0x.. DIME_RELAYER=0x.. \
#   DIME_GUARDIAN=0x.. DIME_REPORTER=0x.. scripts/deploy.sh
#   (commissioning additionally needs DIME_COLLATERAL=<canonical USDC on Monad, verified by you>)
set -euo pipefail
: "${DIME_STAGE:?}" "${RPC_URL:?}" "${DIME_ADMIN:?}" "${DIME_RELAYER:?}" "${DIME_GUARDIAN:?}" "${DIME_REPORTER:?}"
ACCOUNT="${DEPLOYER_ACCOUNT:-dime-deployer}"
CHAIN=$(cast chain-id --rpc-url "$RPC_URL")
case "$DIME_STAGE:$CHAIN" in
  testnet:10143|testnet:31337|commissioning:143|commissioning:10143) ;;
  *) echo "refusing: stage $DIME_STAGE on chain $CHAIN"; exit 1 ;;
esac
if [ "$DIME_STAGE" = "commissioning" ]; then
  : "${DIME_COLLATERAL:?commissioning requires the canonical USDC address}"
  SYM=$(cast call "$DIME_COLLATERAL" "symbol()(string)" --rpc-url "$RPC_URL"); DEC=$(cast call "$DIME_COLLATERAL" "decimals()(uint8)" --rpc-url "$RPC_URL")
  echo "collateral $DIME_COLLATERAL symbol=$SYM decimals=$DEC — confirm this is the canonical USDC for chain $CHAIN"; read -r -p "type YES to continue: " ok; [ "$ok" = "YES" ]
fi

forge build
forge script contracts/script/Deploy.s.sol --rpc-url "$RPC_URL" --account "$ACCOUNT" --broadcast --slow
node scripts/finalize-manifest.mjs "$CHAIN"
node scripts/export-abis.mjs
node scripts/envio-config.mjs "deployments/$CHAIN.json"

if [ "$CHAIN" != "31337" ]; then
  M="deployments/$CHAIN.json"
  LIBS="--libraries contracts/src/lib/DimeMath.sol:DimeMath:$(jq -r .libraries.DimeMath $M) --libraries contracts/src/lib/DimeRights.sol:DimeRights:$(jq -r .libraries.DimeRights $M)"
  V="--chain $CHAIN --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/"
  forge verify-contract "$(jq -r .libraries.DimeMath $M)" contracts/src/lib/DimeMath.sol:DimeMath $V || true
  forge verify-contract "$(jq -r .libraries.DimeRights $M)" contracts/src/lib/DimeRights.sol:DimeRights $V || true
  forge verify-contract "$(jq -r .verifier $M)" contracts/src/oracle/OperatorPriceVerifier.sol:OperatorPriceVerifier $V || true
  forge verify-contract "$(jq -r .protocol $M)" contracts/src/DimeProtocol.sol:DimeProtocol $V $LIBS || true
  if [ "$(jq -r .collateralIsTestToken $M)" = "true" ]; then forge verify-contract "$(jq -r .collateral $M)" contracts/src/test-tokens/TestUSDC.sol:TestUSDC $V || true; fi
fi
echo "done: deployments/$CHAIN.json"
