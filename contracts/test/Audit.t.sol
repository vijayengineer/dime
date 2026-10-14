// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {DimeTest} from "./Dime.t.sol";
import {DimeProtocol} from "../src/DimeProtocol.sol";
import {OperatorPriceVerifier} from "../src/oracle/OperatorPriceVerifier.sol";
import {IDimePositions} from "../src/interfaces/IDime.sol";

/// Security regressions for the October 2026 source/contract audit. Each test asserts the FIXED behaviour:
/// it fails if the audited behaviour comes back.
contract AuditRegressionTest is DimeTest {
    function _signClose(uint256 pk, CloseRequest memory req) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("CloseRequest(address user,bytes32 positionId,uint64 requestedAtMs,uint64 expiry,uint256 nonce)"),
            req.user, req.positionId, req.requestedAtMs, req.expiry, req.nonce
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domain(address(dime), block.chainid), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _closeReq(address user, bytes32 id, uint64 requestedAtMs) internal returns (CloseRequest memory) {
        return CloseRequest(user, id, requestedAtMs, uint64(vm.getBlockTimestamp() + 30), nonceSeq++);
    }

    /* ---------------------------------------------------------------- H-01: no caller-selected prices */

    /// The audit's winning-close-after-reversal: a favourable round from BEFORE the request cannot settle it.
    function test_audit_H01_relayedCloseCannotUseEarlierRound() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        uint64 t0 = uint64(vm.getBlockTimestamp() * 1000);
        PriceProof memory favourable = _pxAt(P0 + 50e8, t0 + 1000); // +0.05%: a win
        vm.warp(vm.getBlockTimestamp() + 3); // price reverses; alice asks to close now
        uint64 requested = uint64(vm.getBlockTimestamp() * 1000);
        CloseRequest memory req = _closeReq(alice, id, requested);
        bytes memory sig = _signClose(alicePk, req);
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.BadRound.selector);
        dime.close(req, sig, favourable);
        // ...and it settles at the first round after the request: here a loss.
        PriceProof memory first = _pxAt(P0 - 50e8, requested + 250);
        vm.prank(relayer);
        dime.close(req, sig, first);
        assertEq(dime.freeBalance(alice), 2e6 - 0.05e6);
        _invariant();
    }

    /// The window after the request is bounded (30 s): a round past it is refused too.
    function test_audit_H01_relayedCloseRejectsRoundAfterWindow() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        uint64 requested = uint64(vm.getBlockTimestamp() * 1000);
        CloseRequest memory req = _closeReq(alice, id, requested);
        bytes memory sig = _signClose(alicePk, req);
        vm.warp(vm.getBlockTimestamp() + 29);
        PriceProof memory late = _pxAt(P0 + 50e8, requested + 31_000); // round r0 + 124 > r0 + 120
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.BadRound.selector);
        dime.close(req, sig, late);
    }

    /// A request time far in the past (to reach a historical round) is refused.
    function test_audit_H01_backdatedCloseRequestRejected() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        vm.warp(vm.getBlockTimestamp() + 60);
        uint64 requested = uint64((vm.getBlockTimestamp() - 40) * 1000);
        CloseRequest memory req = _closeReq(alice, id, requested);
        bytes memory sig = _signClose(alicePk, req);
        PriceProof memory px = _pxAt(P0 + 50e8, requested + 250);
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.Expired.selector);
        dime.close(req, sig, px);
    }

    /// A direct close commits on-chain; the keeper must settle at the first rounds after the commit block.
    function test_audit_H01_committedCloseCannotUseEarlierRound() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        PriceProof memory favourable = _pxAt(P0 + 50e8, uint64(vm.getBlockTimestamp() * 1000));
        vm.warp(vm.getBlockTimestamp() + 2);
        vm.prank(alice);
        dime.requestClose(id);
        vm.prank(keeper);
        vm.expectRevert(DimeProtocol.BadRound.selector);
        dime.settleCommittedClose(id, favourable);
        // the user cannot settle their own commit while the keeper is live
        PriceProof memory after_ = _pxAt(P0, uint64((vm.getBlockTimestamp() + 1) * 1000));
        vm.prank(alice);
        vm.expectRevert(DimeProtocol.KeeperOnly.selector);
        dime.settleCommittedClose(id, after_);
    }

    /// If the first rounds after a commit were missed, the keeper settles at a fresh price newer than the
    /// commit (never an older one), so a direct close cannot get stuck.
    function test_audit_H01_missedCommitRoundsSettleAtFreshPrice() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        vm.prank(alice);
        dime.requestClose(id);
        uint256 committed = vm.getBlockTimestamp();
        vm.warp(committed + 11);
        PriceProof memory beforeCommit = _pxAt(P0 + 50e8, uint64(committed * 1000));
        vm.prank(keeper);
        vm.expectRevert(DimeProtocol.StalePrice.selector); // an old (pre-commit) round is refused
        dime.settleCommittedClose(id, beforeCommit);
        PriceProof memory current = _px(P0 - 20e8);
        vm.prank(keeper);
        dime.settleCommittedClose(id, current);
        assertEq(dime.freeBalance(alice), 2e6 - 0.02e6);
        _invariant();
    }

    /// The audit's third-party liquidation after recovery: only the keeper liquidates while it is live.
    function test_audit_H01_thirdPartyLiquidationRejectedWhileKeeperLive() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        PriceProof memory dip = _px(P0 - 90e8);
        vm.prank(carol);
        vm.expectRevert(DimeProtocol.KeeperOnly.selector);
        dime.liquidate(id, dip);
    }

    /// Escape hatch: after an hour of keeper silence anyone may liquidate, but only at a FRESH price.
    function test_audit_H01_escapeHatchRequiresFreshPrice() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        PriceProof memory old = _pxAt(P0 - 90e8, uint64((vm.getBlockTimestamp() - 10) * 1000));
        vm.prank(carol);
        vm.expectRevert(DimeProtocol.StalePrice.selector);
        dime.liquidate(id, old);
        PriceProof memory fresh = _px(P0 - 90e8);
        vm.prank(carol);
        dime.liquidate(id, fresh);
        assertEq(dime.getPosition(id).user, address(0));
    }

    /// A keeper heartbeat (or any keeper action) closes the escape hatch again.
    function test_audit_H01_heartbeatClosesEscapeHatch() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.prank(keeper);
        dime.keeperHeartbeat();
        PriceProof memory dip = _px(P0 - 90e8);
        vm.prank(carol);
        vm.expectRevert(DimeProtocol.KeeperOnly.selector);
        dime.liquidate(id, dip);
        vm.prank(carol);
        vm.expectRevert(); // AccessControl: only the keeper beats
        dime.keeperHeartbeat();
    }

    /* ---------------------------------------------------------------- H-03 / H-04: opening needs a fresh quorum */

    function test_audit_H04_degradedOrThinPriceCannotOpen() public {
        OrderIntent memory it = _intent(alice, 0, 2);
        bytes memory sig = _sign(alicePk, it);
        uint64 ts = uint64(vm.getBlockTimestamp() * 1000);
        PriceProof memory degraded = _pxQ(P0, ts, 1, 1, ts); // Hyperliquid alone
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.PriceQuality.selector);
        dime.openHouse(it, sig, degraded);
        PriceProof memory twoVenues = _pxQ(P0, ts, 0, 2, ts);
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.PriceQuality.selector);
        dime.openHouse(it, sig, twoVenues);
    }

    function test_audit_H04_degradedPriceStillSettles() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        uint64 ts = uint64(vm.getBlockTimestamp() * 1000);
        PriceProof memory degraded = _pxQ(P0 - 90e8, ts, 1, 1, ts);
        vm.prank(keeper);
        dime.liquidate(id, degraded);
        assertEq(dime.getPosition(id).user, address(0));
    }

    function test_audit_H03_staleObservationsCannotOpen() public {
        OrderIntent memory it = _intent(alice, 0, 2);
        bytes memory sig = _sign(alicePk, it);
        uint64 ts = uint64(vm.getBlockTimestamp() * 1000);
        PriceProof memory delayed = _pxQ(P0, ts, 0, 6, ts - 100_000); // freshly signed, ~100 s old data
        vm.prank(relayer);
        vm.expectRevert(DimeProtocol.StalePrice.selector);
        dime.openHouse(it, sig, delayed);
    }

    function test_audit_verifierBindsRoundAndQuality() public {
        uint64 ts = uint64(vm.getBlockTimestamp() * 1000);
        PriceData memory d = PriceData(P0, ts, ts / 250 - 1, 0, 6, ts); // round does not match its time
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(reporterPk, oracle.digest(MKT, d));
        bytes memory bad = abi.encode(d.price, d.tsMs, d.round, d.quality, d.sources, d.obsMs, abi.encodePacked(r, s, v));
        vm.expectRevert(OperatorPriceVerifier.BadRound.selector);
        oracle.verify(MKT, bad);
        d = PriceData(P0, ts, ts / 250, 7, 6, ts);
        (v, r, s) = vm.sign(reporterPk, oracle.digest(MKT, d));
        bad = abi.encode(d.price, d.tsMs, d.round, d.quality, d.sources, d.obsMs, abi.encodePacked(r, s, v));
        vm.expectRevert(OperatorPriceVerifier.BadQuality.selector);
        oracle.verify(MKT, bad);
    }

    /* ---------------------------------------------------------------- M-02: one liquidation boundary */

    /// The audit's case: closing exactly at the liquidation price used to keep 10% of margin.
    function test_audit_M02_closeAtLiquidationPriceIsLiquidation() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        uint256 liq = dime.getPosition(id).liquidationPrice;
        _closeWith(alice, id, _px(liq));
        assertEq(dime.freeBalance(alice), 2e6 - 0.1e6); // whole margin, exactly as a keeper liquidation
        assertEq(dime.houseStats().collectedLosses, 0.1e6);
        _invariant();
    }

    function test_audit_M02_matchedCloseAtBoundaryIsLiquidation() public {
        (bytes32 l,) = _openPair(P0);
        uint256 liq = dime.getPosition(l).liquidationPrice;
        _closeWith(alice, l, _px(liq));
        assertEq(dime.freeBalance(alice), 1.9e6); // loser forfeits all margin
        assertEq(dime.freeBalance(bob), 1.9e6 + 0.2e6 - 0.025e6);
        _invariant();
    }

    /* ---------------------------------------------------------------- M-09: capped wins are flagged */

    function test_audit_M09_cappedWinIsFlagged() public {
        bytes32 id = _openHouse(alicePk, alice, 0, P0);
        // +3% on $100 = $3 gross uncapped; reservation is $2 (20 × $0.10)
        vm.prank(alice);
        dime.requestClose(id);
        PriceProof memory up = _pxAt(P0 + 3_000e8, uint64((vm.getBlockTimestamp() + 1) * 1000));
        vm.expectEmit(true, false, false, true, address(dime));
        emit IDimePositions.SettlementDetail(id, 3e6, true);
        vm.prank(keeper);
        dime.settleCommittedClose(id, up);
        assertEq(dime.freeBalance(alice), 2e6 - 0.1e6 + 0.1e6 + 1.5e6); // capped $2 gross − 25% fee
        _invariant();
    }
}
