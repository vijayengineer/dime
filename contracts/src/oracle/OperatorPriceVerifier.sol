// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IPriceVerifier} from "../interfaces/IDime.sol";

/// @title OperatorPriceVerifier v2 — OPERATOR-CONTROLLED reference (testnet / founder-only commissioning)
/// @notice A signature from a REPORTER proves who signed a price round, NOT that the price is fair.
///         `isIndependentOracle()` returns false so UIs and manifests must label it.
///         Each signed round binds price, signing time, round id, quality, venue count and the oldest
///         exchange observation behind the price, so the protocol can enforce opening quorum and data age.
/// @dev payload = abi.encode(uint256 price, uint64 tsMs, uint64 round, uint8 quality, uint8 sources, uint64 obsMs, bytes sig)
///      signed message = keccak256(abi.encode(TAG, chainid, address(this), market, price, tsMs, round, quality, sources, obsMs)),
///      EIP-191 prefixed. round must equal tsMs / ROUND_MS.
contract OperatorPriceVerifier is IPriceVerifier, AccessControl {
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant TAG = keccak256("DIME_OPERATOR_PRICE_V2");
    uint64 public constant ROUND_MS = 250;

    error BadReporter();
    error BadRound();
    error BadQuality();

    constructor(address admin, address reporter) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (reporter != address(0)) _grantRole(REPORTER_ROLE, reporter);
    }

    function digest(bytes32 market, PriceData memory d) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(
            TAG, block.chainid, address(this), market, d.price, d.tsMs, d.round, d.quality, d.sources, d.obsMs
        )));
    }

    function verify(bytes32 market, bytes calldata payload) external view returns (PriceData memory d) {
        bytes memory sig;
        (d.price, d.tsMs, d.round, d.quality, d.sources, d.obsMs, sig) =
            abi.decode(payload, (uint256, uint64, uint64, uint8, uint8, uint64, bytes));
        if (d.round != d.tsMs / ROUND_MS) revert BadRound();
        if (d.quality > 1) revert BadQuality();
        address signer = ECDSA.recover(digest(market, d), sig);
        if (!hasRole(REPORTER_ROLE, signer)) revert BadReporter();
    }

    function isIndependentOracle() external pure returns (bool) { return false; }
    function oracleKind() external pure returns (string memory) { return "OPERATOR_SIGNED_COMMISSIONING"; }
}
