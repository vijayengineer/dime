// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DimeProtocol} from "../src/DimeProtocol.sol";
import {OperatorPriceVerifier} from "../src/oracle/OperatorPriceVerifier.sol";
import {TestUSDC} from "../src/test-tokens/TestUSDC.sol";
import {DimeToken} from "../src/DimeToken.sol";
import {IDimeMintable} from "../src/DimeProtocol.sol";
import {IDimeTypes, IPriceVerifier} from "../src/interfaces/IDime.sol";

/// @notice Deploys DIME and writes deployments/<chainId>.json.
/// Usage (keys never on the command line; use a keystore account):
///   forge script contracts/script/Deploy.s.sol --rpc-url $RPC --account dime-deployer --broadcast
/// Env:
///   DIME_STAGE        testnet | commissioning | mainnet      (required)
///   DIME_ADMIN        final admin (multisig / founder cold wallet)
///   DIME_RELAYER, DIME_GUARDIAN, DIME_REPORTER, DIME_KEEPER (all required; the keeper gets KEEPER_ROLE)
///   DIME_COLLATERAL   canonical USDC address (required unless testnet, where a TestUSDC is deployed)
///   DIME_FUNDING_CAP, DIME_EPOCH_SECONDS  (optional overrides, base units / seconds)
contract Deploy is Script, IDimeTypes {
    uint256 constant MONAD_MAINNET = 143;

    function run() external {
        string memory stage = vm.envString("DIME_STAGE");
        bool isTestnet = _eq(stage, "testnet");
        bool isCommissioning = _eq(stage, "commissioning");
        require(isTestnet || isCommissioning || _eq(stage, "mainnet"), "DIME_STAGE");
        if (_eq(stage, "mainnet")) revert("Public mainnet is a separate go/no-go milestone: not deployable from this script yet");
        if (isTestnet) require(block.chainid != MONAD_MAINNET, "testnet stage on mainnet");

        address admin = vm.envAddress("DIME_ADMIN");
        address relayer = vm.envAddress("DIME_RELAYER");
        address guardian = vm.envAddress("DIME_GUARDIAN");
        address reporter = vm.envAddress("DIME_REPORTER");
        address keeper = vm.envAddress("DIME_KEEPER");

        // Signer: DEPLOYER_PK from the environment (set by scripts/deploy.sh from a root-only key file,
        // never a command-line argument), or the CLI-configured signer (keystore / hardware wallet).
        uint256 pk = vm.envOr("DEPLOYER_PK", uint256(0));
        address deployer;
        if (pk != 0) {
            vm.startBroadcast(pk);
            deployer = vm.addr(pk);
        } else {
            vm.startBroadcast();
            deployer = msg.sender;
        }

        IERC20 collateral;
        bool testToken;
        if (isTestnet && vm.envOr("DIME_COLLATERAL", address(0)) == address(0)) {
            collateral = IERC20(address(new TestUSDC()));
            testToken = true;
        } else {
            collateral = IERC20(vm.envAddress("DIME_COLLATERAL"));
        }
        require(IERC20Metadata(address(collateral)).decimals() == 6, "collateral decimals != 6");

        OperatorPriceVerifier oracle = new OperatorPriceVerifier(deployer, reporter);
        DimeToken dimeToken = new DimeToken(deployer);
        DimeProtocol dime = new DimeProtocol(
            collateral, 6, IDimeMintable(address(dimeToken)), IPriceVerifier(address(oracle)), _config(isCommissioning), deployer, "DIME"
        );
        dimeToken.setProtocol(address(dime));

        dime.grantRole(dime.RELAYER_ROLE(), relayer);
        dime.grantRole(dime.GUARDIAN_ROLE(), guardian);
        dime.grantRole(dime.KEEPER_ROLE(), keeper);
        if (isCommissioning && vm.envOr("DIME_ALLOWLIST_ON", false)) {
            dime.setAllowlistEnabled(true);
            // Founder / consenting tester wallets allowed to deposit and trade during commissioning.
            address[] memory allow = vm.envOr("DIME_ALLOWLIST", ",", new address[](0));
            if (allow.length > 0) dime.setAllowlisted(allow, true);
        }

        // Hand admin to the final admin; the deployer keeps nothing.
        if (admin != deployer) {
            dime.grantRole(dime.DEFAULT_ADMIN_ROLE(), admin);
            dime.renounceRole(dime.DEFAULT_ADMIN_ROLE(), deployer);
            oracle.grantRole(oracle.DEFAULT_ADMIN_ROLE(), admin);
            oracle.renounceRole(oracle.DEFAULT_ADMIN_ROLE(), deployer);
            dimeToken.grantRole(dimeToken.DEFAULT_ADMIN_ROLE(), admin);
            dimeToken.renounceRole(dimeToken.DEFAULT_ADMIN_ROLE(), deployer);
        }
        vm.stopBroadcast();

        _writeManifest(stage, dime, oracle, collateral, testToken, admin, relayer, guardian, reporter, keeper, dimeToken);
    }

    function _config(bool commissioning) internal view returns (Config memory c) {
        c.fundingCapPerWallet = uint128(vm.envOr("DIME_FUNDING_CAP", commissioning ? uint256(1e6) : uint256(10e6)));
        c.minCollateral = 0.1e6;
        c.maxCollateral = commissioning ? 1e6 : 2e6;
        c.maxLeverage = 1000;
        c.profitFeeBps = 2500;
        c.maintenanceBps = 1000;
        c.houseReservationMultiple = 20;
        c.protectionTriggerBps = 9000;
        c.houseMaxUtilisationBps = 8000;
        c.houseMaxNetNotionalMultiple = 200;
        c.maxConcurrentHousePositions = uint16(vm.envOr("DIME_HOUSE_SLOTS", uint256(commissioning ? 4 : 10)));
        c.maxConcurrentMatchedPairs = commissioning ? 5 : 25;
        c.matchedGapBackstop = 0;
        c.dimePerUsdE18 = 1000e18; // 1,000 DIME per $1 of eligible loss (live setting since config v2; UNVALIDATED)
        c.emissionDecayTvl = uint128(vm.envOr("DIME_EMISSION_DECAY_TVL", uint256(1_000_000e6))); // $1M house reserve
        c.minStake = uint128(vm.envOr("DIME_MIN_STAKE", uint256(100e18))); // 100 DIME (UNVALIDATED)
        c.maxMintPerEpoch = uint128(vm.envOr("DIME_MAX_MINT_PER_EPOCH", uint256(100_000e18)));
        c.distributionShareBps = 2000;
        c.distributionReserveFloor = 10e6;
        c.epochSeconds = uint64(vm.envOr("DIME_EPOCH_SECONDS", uint256(commissioning ? 86400 : 3600)));
        c.maxPriceAgeMs = 3000;
        c.minOpenSources = 3; // opening needs an OK price from at least 3 venues (audit H-04)
        c.maxSourceAgeMs = 2000; // ...built from exchange data no older than 2 s (audit H-03)
    }

    function _writeManifest(
        string memory stage, DimeProtocol dime, OperatorPriceVerifier oracle, IERC20 collateral, bool testToken,
        address admin, address relayer, address guardian, address reporter, address keeper, DimeToken dimeToken
    ) internal {
        string memory k = "m";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeString(k, "stage", stage);
        vm.serializeAddress(k, "protocol", address(dime));
        vm.serializeAddress(k, "verifier", address(oracle));
        vm.serializeAddress(k, "dimeToken", address(dimeToken));
        vm.serializeBool(k, "dimeTransfersEnabled", dimeToken.transfersEnabled());
        vm.serializeString(k, "oracleKind", oracle.oracleKind());
        vm.serializeBool(k, "independentOracle", oracle.isIndependentOracle());
        vm.serializeAddress(k, "collateral", address(collateral));
        vm.serializeString(k, "collateralSymbol", IERC20Metadata(address(collateral)).symbol());
        vm.serializeUint(k, "collateralDecimals", 6);
        vm.serializeBool(k, "collateralIsTestToken", testToken);
        vm.serializeUint(k, "deploymentBlock", block.number);
        vm.serializeUint(k, "configVersion", dime.activeConfig().version);
        vm.serializeBool(k, "allowlistEnabled", dime.allowlistEnabled());
        vm.serializeString(k, "eip712Name", "DIME");
        vm.serializeString(k, "eip712Version", "1");
        vm.serializeAddress(k, "admin", admin);
        vm.serializeAddress(k, "relayer", relayer);
        vm.serializeAddress(k, "guardian", guardian);
        vm.serializeAddress(k, "keeper", keeper);
        string memory json = vm.serializeAddress(k, "reporter", reporter);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("manifest written:", path);
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
