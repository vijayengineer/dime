// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {
    IDimeVault, IDimePositions, IDimeHouse, IDimeRights, IDimeConfig, IPriceVerifier
} from "./interfaces/IDime.sol";
import {DimeMath} from "./lib/DimeMath.sol";
import {DimeRights} from "./lib/DimeRights.sol";

interface IDimeMintable is IERC20 {
    function mint(address to, uint256 amount) external;
}

/// @title DimeProtocol (v2)
/// @notice Isolated-margin BTC positions against the house reserve or a matched counterparty,
///         plus non-transferable earnings rights on eligible house-trade losses.
/// @dev Single contract exposing all IDime modules. Rounding: amounts owed TO a trader round
///      toward -inf, amounts owed BY a trader and fees round up; dust accrues to the house reserve.
///      Reward-index dust stays in the claims pool. See docs/CONTRACTS.md.
///      Invariant: token.balanceOf(this) == totalFree + totalLocked + reserve + fundedUnclaimed.
///      Settlement price policy (audit H-01): no caller picks the price. Opens need a fresh OK multi-venue
///      round. A close settles at one of the first CLOSE_ROUND_SLACK rounds after its request time (relayed)
///      or after its on-chain commit (direct). Liquidation, protection and wind-down use the keeper's
///      current round; anyone may act only after the keeper has been silent for KEEPER_ESCAPE_SECONDS.
///      Any settlement at or past the liquidation price settles as a liquidation (audit M-02).
contract DimeProtocol is
    IDimeVault, IDimePositions, IDimeHouse, IDimeRights, IDimeConfig, EIP712, AccessControl, ReentrancyGuard
{
    using SafeERC20 for IERC20;

    /* ------------------------------------------------------------------ constants */
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant BTC_MARKET = keccak256("BTC-USD");
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "OrderIntent(address user,bytes32 market,uint8 side,uint128 collateral,uint16 leverage,uint8 routeMask,uint64 matchDeadline,uint128 priceLimit,uint32 configVersion,uint64 expiry,uint256 nonce)"
    );
    bytes32 public constant CLOSE_TYPEHASH =
        keccak256("CloseRequest(address user,bytes32 positionId,uint64 requestedAtMs,uint64 expiry,uint256 nonce)");
    uint8 internal constant ROUTE_MATCHED = 1;
    uint8 internal constant ROUTE_HOUSE = 2;
    uint256 internal constant BPS = 1e4;
    /// block.timestamp has 1s granularity; price timestamps are ms.
    uint256 internal constant TS_GRANULARITY_MS = 1000;
    uint256 internal constant MAX_FUTURE_MS = 2000;
    /// Price rounds are 250 ms (verifier: round = tsMs / ROUND_MS).
    uint64 public constant ROUND_MS = 250;
    /// A committed (direct) close settles at one of the first CLOSE_ROUND_SLACK rounds after its commit (2 s):
    /// the keeper submits the first available; the window only covers a missed round, it is not a price choice.
    uint64 public constant CLOSE_ROUND_SLACK = 8;
    /// A relayed close request must reach the chain within this long of being made.
    uint64 public constant CLOSE_REQUEST_MAX_AGE_MS = 30_000;
    /// Liquidation / protection / wind-down are keeper-only until the keeper has been silent this long.
    uint64 public constant KEEPER_ESCAPE_SECONDS = 1 hours;
    /// If the first rounds after a direct close's commit were missed, the keeper settles at a fresh price
    /// newer than the commit once this long has passed (so a commit can never get stuck).
    uint64 public constant COMMIT_ROUND_SECONDS = 10;

    /* ------------------------------------------------------------------ errors */
    error BadMarket();
    error BadSide();
    error BadRoute();
    error BadSize();
    error ConfigMismatch();
    error Expired();
    error NonceUsed();
    error BadSignature();
    error ActivePosition();
    error NotAllowlisted();
    error InsufficientFree();
    error FundingCapExceeded();
    error StateForbids();
    error StalePrice();
    error PriceFromFuture();
    error PriceBeforeOpen();
    error PriceLimit();
    error MatchWindow();
    error SelfMatch();
    error IncompatiblePair();
    error CapacityUnavailable();
    error ConcentrationLimit();
    error SlotsFull();
    error UnknownPosition();
    error NotOwner();
    error NotLiquidatable();
    error NotTriggered();
    error EpochNotOver();
    error BadConfig();
    error ReserveLocked();
    error BelowMinStake();
    error PriceQuality();
    error BadRound();
    error BadRequestTime();
    error KeeperOnly();
    error NotCommitted();
    error AlreadyCommitted();

    /* ------------------------------------------------------------------ storage */
    IERC20 internal immutable _token;
    IDimeMintable internal immutable _dime;
    IPriceVerifier public verifier;

    Config internal _cfg;
    ProtocolState internal _state;
    bool public allowlistEnabled;
    mapping(address => bool) public allowlisted;

    mapping(address => uint256) internal _free;
    mapping(address => uint256) internal _deposited;
    uint256 public totalFree;
    uint256 public totalLocked;

    mapping(bytes32 => Position) internal _positions;
    mapping(address => bytes32) internal _active;
    mapping(bytes32 => bytes32[2]) internal _pairs; // pairId => [longId, shortId]
    mapping(address => mapping(uint256 => bool)) internal _nonceUsed;

    uint256 internal _reserve;
    uint256 internal _reservedLiabilities;
    uint256 internal _matchedLocked;
    uint256 internal _matchedBackstop;
    uint256 internal _fundedUnclaimed;
    uint256 internal _unfunded;
    uint256 internal _collectedLosses;
    uint256 internal _netWinningPayouts;
    uint256 internal _matchedFees;
    int256 internal _netDirectional;
    uint256 internal _houseLong;
    uint256 internal _houseShort;
    uint256 internal _matchedNotional;
    uint32 internal _openHouse;
    uint32 internal _openPairs;
    mapping(address => uint256) public unfundedOwed;
    mapping(bytes32 => uint64) internal _closeCommit; // positionId => block.timestamp of a direct close request
    uint64 public lastKeeperHeartbeat;

    DimeRights.State internal _r;
    uint256 public distributionsClaimed;

    event VerifierChanged(address verifier);

    /* ------------------------------------------------------------------ setup */
    constructor(
        IERC20 token_,
        uint8 expectedDecimals,
        IDimeMintable dime_,
        IPriceVerifier verifier_,
        Config memory cfg,
        address admin,
        string memory domainName
    ) EIP712(domainName, "1") {
        if (IERC20Metadata(address(token_)).decimals() != expectedDecimals) revert BadConfig();
        _token = token_;
        _dime = dime_;
        verifier = verifier_;
        _setConfig(cfg);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _r.epoch = 1;
        _r.epochStartedAt = uint64(block.timestamp);
        lastKeeperHeartbeat = uint64(block.timestamp); // escape hatch closed at deploy
        emit VerifierChanged(address(verifier_));
    }

    /* ================================================================== modifiers */
    // Bitmask of permitted ProtocolStates: bit i set ⇒ state i allowed.
    uint8 internal constant S_OPEN = 1 << 0;
    uint8 internal constant S_CLOSE_ONLY = 1 << 1;
    uint8 internal constant S_HOLD = 1 << 2;
    uint8 internal constant S_WIND_DOWN = 1 << 3;
    uint8 internal constant S_INSOLVENT = 1 << 4;
    /// Settlement (closes, liquidations, protection) is allowed in every state except ORACLE_HOLD.
    uint8 internal constant S_SETTLE = S_OPEN | S_CLOSE_ONLY | S_WIND_DOWN | S_INSOLVENT;

    function _requireState(uint8 mask) internal view {
        if ((mask >> uint8(_state)) & 1 == 0) revert StateForbids();
    }

    /* ================================================================== vault */
    function collateralToken() external view returns (address) { return address(_token); }

    function deposit(uint256 amount) external nonReentrant {
        _requireState(S_OPEN);
        _requireAllowed(msg.sender);
        if (amount == 0) revert BadSize();
        uint256 next = _deposited[msg.sender] + amount;
        if (next > _cfg.fundingCapPerWallet) revert FundingCapExceeded();
        _deposited[msg.sender] = next;
        _free[msg.sender] += amount;
        totalFree += amount;
        _token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, next);
    }

    /// @notice Free funds are withdrawable in every protocol state.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || _free[msg.sender] < amount) revert InsufficientFree();
        _free[msg.sender] -= amount;
        totalFree -= amount;
        _token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function freeBalance(address user) external view returns (uint256) { return _free[user]; }
    function lockedCollateral(address user) external view returns (uint256) { return _positions[_active[user]].collateral; }
    function depositedTotal(address user) external view returns (uint256) { return _deposited[user]; }

    /* ================================================================== opening */
    function openHouse(OrderIntent calldata it, bytes calldata sig, PriceProof calldata price)
    external
    onlyRole(RELAYER_ROLE)
    
    returns (bytes32 id)
  {
        _requireState(S_OPEN);
        if (it.routeMask & ROUTE_HOUSE == 0) revert BadRoute();
        // With matched also permitted, house is only a fallback after the user's window.
        if (it.routeMask & ROUTE_MATCHED != 0 && block.timestamp <= it.matchDeadline) revert MatchWindow();
        _consumeIntent(it, sig);
        (uint256 px, uint64 ts) = _priceOpen(price);
        _checkLimit(it, px);

        uint256 reservation = uint256(it.collateral) * _cfg.houseReservationMultiple;
        if (_openHouse >= _cfg.maxConcurrentHousePositions) revert SlotsFull();
        if (reservation > _available()) revert CapacityUnavailable();
        int256 notional = int256(uint256(it.collateral) * it.leverage);
        int256 nextNet = _netDirectional + (it.side == 0 ? notional : -notional);
        int256 limit = int256(_reserve * _cfg.houseMaxNetNotionalMultiple);
        if (_abs(nextNet) > limit && _abs(nextNet) > _abs(_netDirectional)) revert ConcentrationLimit();

        _lock(it.user, it.collateral);
        if (it.side == 0) _houseLong += uint256(notional);
        else _houseShort += uint256(notional);
        _reservedLiabilities += reservation;
        _openHouse += 1;
        _netDirectional = nextNet;
        id = _store(it, Route.HOUSE, px, ts, reservation, 0, bytes32(0));
    }

    function openMatched(
    OrderIntent calldata longIt, bytes calldata longSig,
    OrderIntent calldata shortIt, bytes calldata shortSig,
    PriceProof calldata price
  ) external onlyRole(RELAYER_ROLE) returns (bytes32 longId, bytes32 shortId) {
        _requireState(S_OPEN);
        if (longIt.side != 0 || shortIt.side != 1) revert IncompatiblePair();
        if (longIt.user == shortIt.user) revert SelfMatch();
        if (longIt.collateral != shortIt.collateral || longIt.leverage != shortIt.leverage) revert IncompatiblePair();
        if (longIt.routeMask & ROUTE_MATCHED == 0 || shortIt.routeMask & ROUTE_MATCHED == 0) revert BadRoute();
        if (block.timestamp > longIt.matchDeadline || block.timestamp > shortIt.matchDeadline) revert MatchWindow();
        if (_openPairs >= _cfg.maxConcurrentMatchedPairs) revert SlotsFull();
        uint256 backstop = _cfg.matchedGapBackstop;
        if (backstop > _available()) revert CapacityUnavailable();

        _consumeIntent(longIt, longSig);
        _consumeIntent(shortIt, shortSig);
        (uint256 px, uint64 ts) = _priceOpen(price);
        _checkLimit(longIt, px);
        _checkLimit(shortIt, px);

        _lock(longIt.user, longIt.collateral);
        _lock(shortIt.user, shortIt.collateral);
        _matchedLocked += uint256(longIt.collateral) * 2;
        _matchedNotional += uint256(longIt.collateral) * longIt.leverage;
        _matchedBackstop += backstop;
        _openPairs += 1;

        bytes32 pairId = keccak256(abi.encode(longIt.user, longIt.nonce, shortIt.user, shortIt.nonce));
        uint128 maxWin = uint128(uint256(longIt.collateral) + backstop);
        longId = _store(longIt, Route.MATCHED, px, ts, 0, maxWin, pairId);
        shortId = _store(shortIt, Route.MATCHED, px, ts, 0, maxWin, pairId);
        _pairs[pairId] = [longId, shortId];
    }

    /* ================================================================== closing */
    /// @notice Relayed close (gasless for the user). Settles at a price round AFTER the signed request time
    ///         and within CLOSE_REQUEST_MAX_AGE_MS of it — never a round from before the request (audit H-01).
    ///         The relayer submits the first round after it RECEIVED the request, so a user cannot pick a round
    ///         by back-dating; the window only bounds the operator.
    function close(CloseRequest calldata req, bytes calldata sig, PriceProof calldata price)
    external
    onlyRole(RELAYER_ROLE)
  {
        _requireState(S_SETTLE);
        if (block.timestamp > req.expiry) revert Expired();
        uint256 nowMs = block.timestamp * 1000;
        if (req.requestedAtMs > nowMs + MAX_FUTURE_MS) revert BadRequestTime();
        if (nowMs > uint256(req.requestedAtMs) + CLOSE_REQUEST_MAX_AGE_MS) revert Expired();
        if (_nonceUsed[req.user][req.nonce]) revert NonceUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLOSE_TYPEHASH, req)));
        if (!SignatureChecker.isValidSignatureNow(req.user, digest, sig)) revert BadSignature();
        _nonceUsed[req.user][req.nonce] = true;
        Position memory p = _get(req.positionId);
        if (p.user != req.user) revert NotOwner();
        uint64 first = req.requestedAtMs / ROUND_MS + 1;
        uint64 last = first + CLOSE_REQUEST_MAX_AGE_MS / ROUND_MS - 1;
        _closePosition(p, _priceInRounds(price, first, last, p.openedAtMs), CloseReason.USER);
    }

    /// @notice Direct close without the relayer: commit now, settle at the first price rounds after this block.
    function requestClose(bytes32 positionId) external {
        _requireState(S_SETTLE);
        Position memory p = _get(positionId);
        if (p.user != msg.sender) revert NotOwner();
        if (_closeCommit[positionId] != 0) revert AlreadyCommitted();
        _closeCommit[positionId] = uint64(block.timestamp);
        emit CloseCommitted(positionId, msg.sender, uint64(block.timestamp));
    }

    /// @notice Keeper settles a committed close at the first rounds after the commit block. If the keeper
    ///         has been silent, anyone may settle it at a fresh price newer than the commit.
    function settleCommittedClose(bytes32 positionId, PriceProof calldata price) external {
        _requireState(S_SETTLE);
        uint64 c = _closeCommit[positionId];
        if (c == 0) revert NotCommitted();
        Position memory p = _get(positionId);
        // Rounds that start after the commit block's second: unknown when the commit was sent.
        uint64 first = ((uint64(c) + 1) * 1000) / ROUND_MS;
        uint256 px;
        if (_isKeeper()) {
            if (block.timestamp <= uint256(c) + COMMIT_ROUND_SECONDS) {
                px = _priceInRounds(price, first, first + CLOSE_ROUND_SLACK - 1, p.openedAtMs);
            } else {
                uint64 nb = (uint64(c) + 1) * 1000;
                px = _priceCurrent(price, nb > p.openedAtMs ? nb : p.openedAtMs);
            }
        } else {
            if (block.timestamp <= uint256(c) + KEEPER_ESCAPE_SECONDS) revert KeeperOnly();
            uint64 notBefore = (uint64(c) + 1) * 1000;
            px = _priceCurrent(price, notBefore > p.openedAtMs ? notBefore : p.openedAtMs);
        }
        _closePosition(p, px, CloseReason.USER);
    }

    function closeCommittedAt(bytes32 positionId) external view returns (uint64) { return _closeCommit[positionId]; }

    /// @notice Keeper liveness. While the keeper is live, only it can liquidate, protect or wind down.
    function keeperHeartbeat() external onlyRole(KEEPER_ROLE) {
        lastKeeperHeartbeat = uint64(block.timestamp);
        emit KeeperHeartbeat(msg.sender, uint64(block.timestamp));
    }

    /// @notice Keeper-only at the current price; permissionless only if the keeper has been silent.
    ///         Not available during ORACLE_HOLD.
    function liquidate(bytes32 positionId, PriceProof calldata price) external {
        _requireState(S_SETTLE);
        _requireKeeperOrEscape();
        Position memory p = _get(positionId);
        uint256 px = _priceCurrent(price, p.openedAtMs);
        if (!_liquidatable(p, px)) revert NotLiquidatable();
        if (p.route == Route.HOUSE) _settleHouse(p, px, CloseReason.LIQUIDATION);
        else _settlePair(p.pairId, px, CloseReason.LIQUIDATION, bytes32(0));
    }

    /// @notice Reserve protection (keeper, or anyone if the keeper is silent): extend the reservation
    ///         from free capacity, otherwise close early at the current verified price.
    function protect(bytes32 positionId, PriceProof calldata price) external {
        _requireState(S_SETTLE);
        _requireKeeperOrEscape();
        Position memory p = _get(positionId);
        if (p.route != Route.HOUSE) revert BadRoute();
        uint256 px = _priceCurrent(price, p.openedAtMs);
        int256 raw = _rawPnl(p, px);
        if (raw < int256((uint256(p.houseReservation) * _cfg.protectionTriggerBps) / BPS)) revert NotTriggered();
        uint256 ext = uint256(p.collateral) * _cfg.houseReservationMultiple;
        if (ext <= _available()) {
            _positions[positionId].houseReservation = p.houseReservation + uint128(ext);
            _reservedLiabilities += ext;
            emit HouseReservationChanged(positionId, p.houseReservation + ext);
        } else {
            _settleHouse(p, px, CloseReason.RESERVE_PROTECTION);
        }
    }

    /// @notice WIND_DOWN: the keeper (or anyone, if the keeper is silent) settles a bounded batch at the current price.
    function windDownSettle(bytes32[] calldata ids, PriceProof calldata price) external {
        _requireState(S_WIND_DOWN);
        _requireKeeperOrEscape();
        for (uint256 i; i < ids.length; ++i) {
            Position memory p = _positions[ids[i]];
            if (p.user == address(0)) continue; // already settled (e.g. other leg of a pair)
            uint256 px = _priceCurrent(price, p.openedAtMs);
            if (p.route == Route.HOUSE) _settleHouse(p, px, CloseReason.EMERGENCY);
            else _settlePair(p.pairId, px, CloseReason.EMERGENCY, bytes32(0));
        }
    }

    function cancelNonce(uint256 nonce) external {
        _nonceUsed[msg.sender][nonce] = true;
        emit IntentCancelled(msg.sender, nonce);
    }

    function nonceUsed(address user, uint256 nonce) external view returns (bool) { return _nonceUsed[user][nonce]; }
    function positionOf(address user) external view returns (Position memory) { return _positions[_active[user]]; }
    function getPosition(bytes32 id) external view returns (Position memory) { return _positions[id]; }

    /* ================================================================== house */
    function fundReserve(uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        _reserve += amount;
        _token.safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveFunded(msg.sender, amount);
    }

    /// @notice Admin may remove house capital only above what open risk and the distribution floor need.
    function withdrawExcessReserve(uint256 amount, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_state == ProtocolState.INSOLVENT) revert StateForbids();
        if (amount > _reserve) revert ReserveLocked();
        uint256 after_ = _reserve - amount;
        uint256 used = _reservedLiabilities + _matchedBackstop;
        if ((after_ * _cfg.houseMaxUtilisationBps) / BPS < used) revert ReserveLocked();
        if (_openHouse + _openPairs > 0 && after_ < used + _cfg.distributionReserveFloor) revert ReserveLocked();
        _reserve = after_;
        _token.safeTransfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    function houseStats() external view returns (HouseStats memory s) {
        s.reserve = _reserve;
        s.reservedLiabilities = _reservedLiabilities;
        s.availableCapacity = _available();
        s.matchedCollateralLocked = _matchedLocked;
        s.matchedBackstopReserved = _matchedBackstop;
        s.fundedUnclaimed = _fundedUnclaimed;
        s.unfundedLiabilities = _unfunded;
        s.collectedLosses = _collectedLosses;
        s.netWinningPayouts = _netWinningPayouts;
        s.matchedFees = _matchedFees;
        s.netDirectionalNotional = _netDirectional;
        s.houseLongNotional = _houseLong;
        s.houseShortNotional = _houseShort;
        s.matchedNotionalPerSide = _matchedNotional;
        s.openHousePositions = _openHouse;
        s.openMatchedPairs = _openPairs;
    }

    function protocolState() external view returns (ProtocolState) { return _state; }

    /// @notice Guardian can only reduce risk (CLOSE_ONLY / ORACLE_HOLD / WIND_DOWN). Only admin reopens.
    function setProtocolState(ProtocolState s) external {
        if (s == ProtocolState.INSOLVENT) revert StateForbids();
        if (s == ProtocolState.OPEN || _state == ProtocolState.WIND_DOWN || _state == ProtocolState.INSOLVENT) {
            _checkRole(DEFAULT_ADMIN_ROLE);
        } else if (!hasRole(GUARDIAN_ROLE, msg.sender)) {
            _checkRole(DEFAULT_ADMIN_ROLE);
        }
        _state = s;
        emit ProtocolStateChanged(s);
    }

    function setAllowlistEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowlistEnabled = enabled;
        emit AllowlistEnabled(enabled);
    }

    function setAllowlisted(address[] calldata users, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i; i < users.length; ++i) {
            allowlisted[users[i]] = allowed;
            emit AllowlistChanged(users[i], allowed);
        }
    }

    function setVerifier(IPriceVerifier v) external onlyRole(DEFAULT_ADMIN_ROLE) {
        verifier = v;
        emit VerifierChanged(address(v));
    }

    /* ================================================================== config */
    function activeConfig() external view returns (Config memory) { return _cfg; }

    function setConfig(Config calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) { _setConfig(cfg); }

    function _setConfig(Config memory cfg) internal {
        if (
            cfg.minCollateral == 0 || cfg.minCollateral > cfg.maxCollateral || cfg.maxLeverage == 0
                || cfg.maxLeverage > 1000 || cfg.profitFeeBps > 5000 || cfg.maintenanceBps == 0
                || cfg.maintenanceBps >= BPS || cfg.houseReservationMultiple == 0 || cfg.protectionTriggerBps == 0
                || cfg.protectionTriggerBps > BPS || cfg.houseMaxUtilisationBps > BPS || cfg.epochSeconds < 60
                || cfg.maxPriceAgeMs == 0 || cfg.distributionShareBps > BPS
                || cfg.minOpenSources == 0 || cfg.maxSourceAgeMs == 0
        ) revert BadConfig();
        cfg.version = _cfg.version + 1;
        _cfg = cfg;
        emit ConfigActivated(cfg.version);
    }

    /* ================================================================== rights */
    function epoch() external view returns (uint64) { return _r.epoch; }
    function epochStartedAt() external view returns (uint64) { return _r.epochStartedAt; }
    function totalActive() external view returns (uint256) { return _r.totalActive; }
    function pendingForEpoch(uint64 e) external view returns (uint256) { return _r.pendingFor[e]; }
    function rewardIndex() external view returns (uint256) { return _r.rewardIndex; }
    function houseCumulativeEarnings() external view returns (int256) { return _r.houseEarnings; }
    function earningsHighWater() external view returns (int256) { return _r.earningsHwm; }
    function distributionsFunded() external view returns (uint256) { return _r.funded; }

    function rightsOf(address user) external view returns (RightsAccount memory) { return DimeRights.account(_r, user); }

    /// @notice Permissionless once the epoch has elapsed. Funds the closing epoch, THEN advances,
    ///         so rights activating now never share earlier earnings.
    function fundAndAdvance() external {
        if (block.timestamp < uint256(_r.epochStartedAt) + _cfg.epochSeconds) revert EpochNotOver();
        uint256 needed = _reservedLiabilities + _matchedBackstop + _cfg.distributionReserveFloor;
        uint256 surplus = _reserve > needed ? _reserve - needed : 0;
        uint256 funded = DimeRights.fundAndAdvance(_r, surplus, _cfg.distributionShareBps);
        if (funded > 0) {
            _reserve -= funded;
            _fundedUnclaimed += funded;
        }
    }

    /// @notice DIME per $1 of eligible loss (18dp): flat up to `emissionDecayTvl` of house reserve,
    ///         then inversely proportional to the reserve (halves each time the reserve doubles).
    function emissionRate() public view returns (uint256) {
        uint256 r = _reserve;
        if (r <= _cfg.emissionDecayTvl || r == 0) return _cfg.dimePerUsdE18;
        return (uint256(_cfg.dimePerUsdE18) * _cfg.emissionDecayTvl) / r;
    }

    function dimeToken() external view returns (address) { return address(_dime); }

    /// @notice Stake DIME (requires approve). Activates next epoch, so stake can't be added just before funding.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadSize();
        RightsAccount memory a = DimeRights.account(_r, msg.sender);
        if (a.active + a.pending + amount < _cfg.minStake) revert BelowMinStake();
        IERC20(address(_dime)).safeTransferFrom(msg.sender, address(this), amount);
        DimeRights.stake(_r, msg.sender, amount);
    }

    /// @notice Unstake DIME back to the wallet (pending first, then active). Accrued USDC stays claimable.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadSize();
        DimeRights.unstake(_r, msg.sender, amount);
        IERC20(address(_dime)).safeTransfer(msg.sender, amount);
    }

    /// @notice Credits accrued distributions to the caller's free balance (withdrawable).
    function claim() external returns (uint256 amt) {
        amt = DimeRights.claim(_r, msg.sender);
        _fundedUnclaimed -= amt;
        distributionsClaimed += amt;
        _free[msg.sender] += amt;
        totalFree += amt;
    }

    /* ================================================================== internals */
    function _requireAllowed(address user) internal view {
        if (allowlistEnabled && !allowlisted[user]) revert NotAllowlisted();
    }

    function _consumeIntent(OrderIntent calldata it, bytes calldata sig) internal {
        if (it.market != BTC_MARKET) revert BadMarket();
        if (it.side > 1) revert BadSide();
        if (it.configVersion != _cfg.version) revert ConfigMismatch();
        if (block.timestamp > it.expiry) revert Expired();
        if (it.collateral < _cfg.minCollateral || it.collateral > _cfg.maxCollateral) revert BadSize();
        if (it.leverage == 0 || it.leverage > _cfg.maxLeverage) revert BadSize();
        if (_nonceUsed[it.user][it.nonce]) revert NonceUsed();
        // All OrderIntent fields are static, so abi.encode(typehash, struct) == EIP-712 encodeData.
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH, it)));
        if (!SignatureChecker.isValidSignatureNow(it.user, digest, sig)) revert BadSignature();
        _nonceUsed[it.user][it.nonce] = true;
        if (_active[it.user] != bytes32(0)) revert ActivePosition();
        _requireAllowed(it.user);
    }

    function _verify(PriceProof calldata p) internal view returns (PriceData memory d) {
        d = verifier.verify(BTC_MARKET, p.payload);
        if (d.price == 0 || d.sources == 0) revert StalePrice();
        if (d.tsMs > block.timestamp * 1000 + MAX_FUTURE_MS || d.obsMs > uint256(d.tsMs) + MAX_FUTURE_MS) revert PriceFromFuture();
    }

    function _fresh(uint64 tsMs) internal view {
        uint256 nowMs = block.timestamp * 1000;
        if (nowMs > tsMs && nowMs - tsMs > uint256(_cfg.maxPriceAgeMs) + TS_GRANULARITY_MS) revert StalePrice();
    }

    /// Opening: a fresh round with an OK multi-venue quorum built from fresh exchange data (audit H-03/H-04).
    function _priceOpen(PriceProof calldata p) internal view returns (uint256, uint64) {
        PriceData memory d = _verify(p);
        if (d.quality != 0 || d.sources < _cfg.minOpenSources) revert PriceQuality();
        _fresh(d.tsMs);
        uint256 nowMs = block.timestamp * 1000;
        if (nowMs > d.obsMs && nowMs - d.obsMs > uint256(_cfg.maxSourceAgeMs) + TS_GRANULARITY_MS) revert StalePrice();
        return (d.price, d.tsMs);
    }

    /// Keeper actions: the current round (OK or DEGRADED, so settlement keeps working during a feed outage).
    function _priceCurrent(PriceProof calldata p, uint64 notBeforeMs) internal view returns (uint256) {
        PriceData memory d = _verify(p);
        _fresh(d.tsMs);
        if (d.tsMs < notBeforeMs) revert PriceBeforeOpen();
        return d.price;
    }

    /// Closes: a round inside [lo, hi], fixed by the request time rather than chosen by the caller (audit H-01).
    function _priceInRounds(PriceProof calldata p, uint64 lo, uint64 hi, uint64 notBeforeMs) internal view returns (uint256) {
        PriceData memory d = _verify(p);
        if (d.round < lo || d.round > hi) revert BadRound();
        if (d.tsMs < notBeforeMs) revert PriceBeforeOpen();
        return d.price;
    }

    function _isKeeper() internal returns (bool) {
        if (!hasRole(KEEPER_ROLE, msg.sender)) return false;
        lastKeeperHeartbeat = uint64(block.timestamp);
        return true;
    }

    function _requireKeeperOrEscape() internal {
        if (_isKeeper()) return;
        if (block.timestamp <= uint256(lastKeeperHeartbeat) + KEEPER_ESCAPE_SECONDS) revert KeeperOnly();
    }

    function _checkLimit(OrderIntent calldata it, uint256 px) internal pure {
        if (it.side == 0 ? px > it.priceLimit : px < it.priceLimit) revert PriceLimit();
    }

    function _lock(address user, uint256 amount) internal {
        if (_free[user] < amount) revert InsufficientFree();
        _free[user] -= amount;
        totalFree -= amount;
        totalLocked += amount;
    }

    function _store(
        OrderIntent calldata it, Route route, uint256 px, uint64 ts, uint256 reservation, uint128 maxWin, bytes32 pairId
    ) internal returns (bytes32 id) {
        id = keccak256(abi.encode(block.chainid, address(this), it.user, it.nonce));
        uint256 move = (px * (BPS - _cfg.maintenanceBps)) / (BPS * it.leverage); // floor ⇒ closer to entry
        Position storage p = _positions[id];
        p.id = id;
        p.user = it.user;
        p.route = route;
        p.side = Side(it.side);
        p.collateral = it.collateral;
        p.leverage = it.leverage;
        p.feeBps = _cfg.profitFeeBps;
        p.entryPrice = uint128(px);
        p.liquidationPrice = uint128(it.side == 0 ? px - move : px + move);
        p.houseReservation = uint128(reservation);
        p.maxGrossWin = maxWin;
        p.pairId = pairId;
        p.configVersion = _cfg.version;
        p.openedAtMs = ts;
        _active[it.user] = id;
        emit PositionOpened(
            id, it.user, route, Side(it.side), it.collateral, it.leverage, px, p.liquidationPrice, reservation, pairId, _cfg.version
        );
    }

    function _get(bytes32 id) internal view returns (Position memory p) {
        p = _positions[id];
        if (p.user == address(0)) revert UnknownPosition();
    }

    function _closePosition(Position memory p, uint256 px, CloseReason reason) internal {
        if (p.route == Route.HOUSE) _settleHouse(p, px, reason);
        else _settlePair(p.pairId, px, reason, p.id);
    }

    function _available() internal view returns (uint256) {
        uint256 ceiling = (_reserve * _cfg.houseMaxUtilisationBps) / BPS;
        uint256 used = _reservedLiabilities + _matchedBackstop;
        return ceiling > used ? ceiling - used : 0;
    }

    function _liquidatable(Position memory p, uint256 px) internal pure returns (bool) {
        return p.side == Side.LONG ? px <= p.liquidationPrice : px >= p.liquidationPrice;
    }

    function _rawPnl(Position memory p, uint256 exit) internal pure returns (int256) {
        return DimeMath.rawPnl(p.side == Side.LONG, p.collateral, p.leverage, p.entryPrice, exit);
    }

    function _settleHouse(Position memory p, uint256 exit, CloseReason reason) internal {
        // One boundary rule for every path (audit M-02): at or past the liquidation price it is a liquidation.
        if (_liquidatable(p, exit)) reason = CloseReason.LIQUIDATION;
        int256 coll = int256(uint256(p.collateral));
        int256 gross = DimeMath.houseGross(
            p.side == Side.LONG, p.collateral, p.leverage, p.entryPrice, exit, p.houseReservation,
            reason == CloseReason.LIQUIDATION
        );
        uint256 fee = DimeMath.fee(gross, p.feeBps);
        int256 net = gross - int256(fee);

        _reservedLiabilities -= p.houseReservation;
        _openHouse -= 1;
        int256 notional = int256(uint256(p.collateral) * p.leverage);
        _netDirectional -= (p.side == Side.LONG ? notional : -notional);
        if (p.side == Side.LONG) _houseLong -= uint256(notional);
        else _houseShort -= uint256(notional);

        uint256 returned;
        if (net < 0) {
            uint256 loss = uint256(-net);
            _reserve += loss;
            _collectedLosses += loss;
            returned = uint256(coll) - loss;
        } else {
            uint256 pay = uint256(net);
            uint256 paid = _payFromReserve(p.user, pay);
            _netWinningPayouts += paid;
            returned = uint256(coll) + paid;
        }
        // The fee is the unpaid part of a win; it is NOT added as extra revenue.
        _r.houseEarnings -= net;
        _release(p, returned);
        uint256 issued = DimeRights.recordHouseResult(_r, p.user, net, emissionRate(), _cfg.maxMintPerEpoch);
        if (issued > 0) _dime.mint(address(this), issued); // held by the protocol as the user's pending stake
        int256 raw = _rawPnl(p, exit);
        emit SettlementDetail(p.id, raw, reason != CloseReason.LIQUIDATION && raw > int256(uint256(p.houseReservation)));
        emit PositionSettled(p.id, p.user, Route.HOUSE, exit, gross, fee, net, returned, reason);
    }

    function _settlePair(bytes32 pairId, uint256 exit, CloseReason reason, bytes32 initiator) internal {
        bytes32[2] memory ids = _pairs[pairId];
        Position memory L = _positions[ids[0]];
        Position memory S = _positions[ids[1]];
        // Same boundary rule as the house route (audit M-02).
        if (_liquidatable(L, exit) || _liquidatable(S, exit)) reason = CloseReason.LIQUIDATION;
        bool liq = reason == CloseReason.LIQUIDATION;
        DimeMath.PairResult memory c =
            DimeMath.pair(L.collateral, L.leverage, L.entryPrice, exit, L.maxGrossWin, L.feeBps, liq);
        (Position memory W, Position memory X) = c.longWins ? (L, S) : (S, L);
        uint256 xColl = X.collateral;
        uint256 backstop = W.maxGrossWin > xColl ? W.maxGrossWin - xColl : 0;

        // House: matched fee + rounding/liquidation dust − backstop paid. Matched losses pay the winner, not the house.
        _matchedFees += c.fee;
        _reserve = _reserve + c.fee + (c.loss - c.base) - c.gapPaid;
        _r.houseEarnings += int256(c.fee + (c.loss - c.base)) - int256(c.gapPaid);
        _matchedBackstop -= backstop;
        _matchedLocked -= uint256(L.collateral) + S.collateral;
        _matchedNotional -= uint256(L.collateral) * L.leverage;
        _openPairs -= 1;

        uint256 wReturned = uint256(W.collateral) + c.winnerGross - c.fee;
        uint256 xReturned = xColl - c.loss;
        CloseReason wReason;
        CloseReason xReason;
        if (reason == CloseReason.USER) {
            wReason = W.id == initiator ? CloseReason.USER : CloseReason.COUNTERPARTY;
            xReason = X.id == initiator ? CloseReason.USER : CloseReason.COUNTERPARTY;
        } else if (liq) {
            wReason = CloseReason.COUNTERPARTY_LIQUIDATED;
            xReason = CloseReason.LIQUIDATION;
        } else {
            wReason = reason;
            xReason = reason;
        }
        _release(W, wReturned);
        _release(X, xReturned);
        delete _pairs[pairId];
        int256 wg = int256(c.winnerGross);
        emit PositionSettled(W.id, W.user, Route.MATCHED, exit, wg, c.fee, wg - int256(c.fee), wReturned, wReason);
        emit PositionSettled(X.id, X.user, Route.MATCHED, exit, -int256(c.loss), 0, -int256(c.loss), xReturned, xReason);
    }

    function _release(Position memory p, uint256 returned) internal {
        totalLocked -= p.collateral;
        _free[p.user] += returned;
        totalFree += returned;
        delete _active[p.user];
        delete _positions[p.id];
        delete _closeCommit[p.id];
    }

    function _payFromReserve(address user, uint256 amount) internal returns (uint256 paid) {
        if (amount <= _reserve) {
            _reserve -= amount;
            return amount;
        }
        // Should be unreachable under admission rules; recorded explicitly rather than reverting a settlement.
        paid = _reserve;
        uint256 shortfall = amount - paid;
        _reserve = 0;
        _unfunded += shortfall;
        unfundedOwed[user] += shortfall;
        _state = ProtocolState.INSOLVENT;
        emit ProtocolStateChanged(ProtocolState.INSOLVENT);
    }

    function _abs(int256 x) internal pure returns (int256) { return x < 0 ? -x : x; }
}
