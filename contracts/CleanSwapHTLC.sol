// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title  CleanSwapHTLC
/// @notice One-file HTLC that escrows an ERC-20 (USDT on Arbitrum) behind a
///         Bitcoin-style SHA-256 hashlock, so a single 32-byte preimage settles
///         both legs of a Lightning <-> token atomic swap.
/// @dev    The hashlock is `sha256(abi.encodePacked(preimage))`, exactly the
///         construction Bitcoin scripts use (OP_SHA256) and BOLT 4 hashes in a
///         Lightning HTLC. A keccak256 hashlock would be dead weight here: no
///         Lightning node can pay against it.
///
///         The swap id is derived from the terms and the address that funds the
///         escrow —
///         `sha256(hashlock, sender, receiver, token, amount, timelock)` — so
///         the sender is part of the id. Both phones compute the same id
///         off-line once the funding address is known, and a third party who
///         copies the terms cannot pre-occupy the id: their own address gives
///         them a different id. (Without the sender, anyone could lock the same
///         terms first, let the timelock pass, refund, and leave the real swap
///         permanently unusable under that id.)
///
///         Reveal R on this side (claim) and the Lightning HTLC becomes
///         claimable by whoever holds the invoice; if nobody claims here before
///         `timelock`, the token leg is refundable to the sender.
///
///         Deliberately minimal: no fees, no owner, no upgrade path. The three
///         functions that move tokens carry a reentrancy guard: checks-effects-
///         interactions and a one-shot `claimed` flag would cover this escrow
///         on their own, but the token is a stranger's contract, and a token
///         that calls back during a transfer must not be able to enter a second
///         time. Token movement goes through `_safeTransfer`/`_safeTransferFrom`,
///         which accept tokens that return no bool but refuse any transfer whose
///         actual balance movement differs from the agreed amount, so a
///         fee-on-transfer token cannot quietly short the other side.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract CleanSwapHTLC {
    struct Swap {
        bytes32 hashlock; // slot 0 — sha256(preimage)
        uint256 amount;   // slot 1 — token units escrowed (USDT: 6 decimals)
        uint256 timelock; // slot 2 — unix seconds; claim closes / refund opens
        address token;    // slot 3 — 20 bytes …
        address sender;   //          + 20 bytes  (one slot)
        address receiver; // slot 4 — 20 bytes + claimed + refunded
        bool claimed;
        bool refunded;
    }

    /// @notice swapId => swap, readable by anyone: `swaps(id)` returns the whole
    ///         record as a tuple, which is exactly what the app's `eth_call`
    ///         decodes. A zero `sender` means "no such swap".
    mapping(bytes32 swapId => Swap) public swaps;

    /// @dev Reentrancy guard state for `lock`, `claim` and `refund`.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private guardState = NOT_ENTERED;

    /// @dev Refuse a call that re-enters one of the three that move tokens,
    ///      through a token (or a receiver) that calls back mid-transfer.
    modifier nonReentrant() {
        if (guardState == ENTERED) revert ReentrantCall();
        guardState = ENTERED;
        _;
        guardState = NOT_ENTERED;
    }

    /// @notice Refuse timelocks so short a refund could race the claim.
    uint256 public constant MIN_TIMELOCK_DELTA = 5 minutes;
    /// @notice Refuse timelocks so long the funding side's money is stuck for
    ///         a season if the other side goes quiet. 7 days is the ceiling the
    ///         app also enforces before it lets anyone approve a swap.
    uint256 public constant MAX_TIMELOCK_DELTA = 7 days;

    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );

    /// @notice R is emitted in the clear: this reveal is what lets the
    ///         Lightning leg be settled (or swept) by the BTC side.
    event Claimed(bytes32 indexed swapId, bytes32 preimage);

    event Refunded(bytes32 indexed swapId);

    error ZeroAmount();
    error ZeroAddress();
    error EmptyHashlock();
    error ReceiverIsEscrow();
    error ReentrantCall();
    error TimelockTooSoon(uint256 timelock, uint256 minimum);
    error TimelockTooFar(uint256 timelock, uint256 maximum);
    error SwapExists(bytes32 swapId);
    error SwapUnknown(bytes32 swapId);
    error AlreadySettled(bytes32 swapId);
    error HashlockMismatch(bytes32 expected, bytes32 actual);
    error TimelockExpired(uint256 timelock, uint256 timestamp);
    error TimelockNotExpired(uint256 timelock, uint256 timestamp);
    error TransferFailed();
    error TransferAmountMismatch(uint256 wanted, uint256 moved);

    // ---------------------------------------------------------------- lock ---

    /// @notice Pull `amount` of `token` into escrow against `hashlock`.
    /// @param  hashlock sha256(preimage) — the secret both legs are tied to.
    /// @param  timelock unix seconds after which the sender may refund.
    /// @param  receiver who receives the tokens when `preimage` is revealed.
    /// @param  token    ERC-20 to escrow (TestUSDT on testnet, USDT on Arbitrum One).
    /// @param  amount   token units, must already be approved to this contract.
    function lock(
        bytes32 hashlock,
        uint256 timelock,
        address receiver,
        address token,
        uint256 amount
    ) external nonReentrant returns (bytes32 swapId) {
        if (amount == 0) revert ZeroAmount();
        /* A zero hashlock is a swap nobody can claim: sha256() never returns
           zero, so such a lock would only ever be refunded. A receiver that is
           this contract would have the tokens paid back into the escrow and
           counted as a swap that settled. Both are refused at the door. */
        if (hashlock == bytes32(0)) revert EmptyHashlock();
        if (receiver == address(0) || token == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert ReceiverIsEscrow();
        uint256 minimum = block.timestamp + MIN_TIMELOCK_DELTA;
        if (timelock < minimum) revert TimelockTooSoon(timelock, minimum);
        uint256 maximum = block.timestamp + MAX_TIMELOCK_DELTA;
        if (timelock > maximum) revert TimelockTooFar(timelock, maximum);

        swapId = computeSwapId(hashlock, msg.sender, receiver, token, amount, timelock);
        if (swaps[swapId].sender != address(0)) revert SwapExists(swapId);

        Swap storage s = swaps[swapId];
        s.hashlock = hashlock;
        s.amount = amount;
        s.timelock = timelock;
        s.token = token;
        s.sender = msg.sender;
        s.receiver = receiver;

        _safeTransferFrom(token, msg.sender, amount);
        emit Locked(swapId, msg.sender, receiver, token, amount, hashlock, timelock);
    }

    // --------------------------------------------------------------- claim ---

    /// @notice Reveal the preimage and pay the receiver. Emits R on-chain.
    /// @dev    Callable by anyone holding R — the token can only go to the
    ///         receiver fixed at lock time, so a front-runner gains nothing.
    function claim(bytes32 swapId, bytes32 preimage) external nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.sender == address(0)) revert SwapUnknown(swapId);
        if (s.claimed || s.refunded) revert AlreadySettled(swapId);
        if (block.timestamp >= s.timelock) revert TimelockExpired(s.timelock, block.timestamp);

        bytes32 computed = sha256(abi.encodePacked(preimage));
        if (computed != s.hashlock) revert HashlockMismatch(s.hashlock, computed);

        s.claimed = true; // effects before the external call
        _safeTransfer(s.token, s.receiver, s.amount);
        emit Claimed(swapId, preimage);
    }

    // -------------------------------------------------------------- refund ---

    /// @notice After the timelock, return the tokens to the sender.
    /// @dev    Permissionless: the destination is fixed, so anyone may clean up.
    function refund(bytes32 swapId) external nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.sender == address(0)) revert SwapUnknown(swapId);
        if (s.claimed || s.refunded) revert AlreadySettled(swapId);
        if (block.timestamp < s.timelock) revert TimelockNotExpired(s.timelock, block.timestamp);

        s.refunded = true;
        _safeTransfer(s.token, s.sender, s.amount);
        emit Refunded(swapId);
    }

    // --------------------------------------------------------------- views ---

    /// @notice The swap record, or zeroed fields when unknown.
    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return swaps[swapId];
    }

    /// @notice Claim window still open?
    function canClaim(bytes32 swapId) external view returns (bool) {
        Swap storage s = swaps[swapId];
        return s.sender != address(0) && !s.claimed && !s.refunded && block.timestamp < s.timelock;
    }

    /// @notice Refund window open?
    function canRefund(bytes32 swapId) external view returns (bool) {
        Swap storage s = swaps[swapId];
        return s.sender != address(0) && !s.claimed && !s.refunded && block.timestamp >= s.timelock;
    }

    /// @notice sha256 of a candidate preimage — the same primitive as Bitcoin.
    function hashPreimage(bytes32 preimage) external pure returns (bytes32) {
        return sha256(abi.encodePacked(preimage));
    }

    /// @notice Deterministic swap id from the terms and the funding address;
    ///         mirrors the id `lock` uses.
    function computeSwapId(
        bytes32 hashlock,
        address sender,
        address receiver,
        address token,
        uint256 amount,
        uint256 timelock
    ) public pure returns (bytes32) {
        return sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock));
    }

    // ------------------------------------------------------------- transfers --

    /// @dev A transfer that refuses to move less than `amount`: the escrow's
    ///      own balance has to grow by exactly the agreed number of units.
    function _safeTransferFrom(address token, address from, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(address(this));
        _callToken(token, abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        uint256 moved = IERC20(token).balanceOf(address(this)) - before;
        if (moved != amount) revert TransferAmountMismatch(amount, moved);
    }

    /// @dev A transfer that refuses to deliver less than `amount`: the
    ///      destination's balance has to grow by exactly the agreed units.
    function _safeTransfer(address token, address to, uint256 amount) private {
        uint256 before = IERC20(token).balanceOf(to);
        _callToken(token, abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        uint256 moved = IERC20(token).balanceOf(to) - before;
        if (moved != amount) revert TransferAmountMismatch(amount, moved);
    }

    /// @dev ERC-20 tokens that return nothing (USDT on some chains) are
    ///      accepted; a `false` return or a failed call is not.
    function _callToken(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || !_returnedTrue(ret)) revert TransferFailed();
    }

    function _returnedTrue(bytes memory ret) private pure returns (bool) {
        if (ret.length == 0) return true;                       // no return value at all
        if (ret.length != 32) return false;
        return abi.decode(ret, (bool));
    }
}
