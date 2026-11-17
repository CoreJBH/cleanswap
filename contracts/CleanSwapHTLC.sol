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
///         The swap id is derived from the terms alone —
///         `sha256(hashlock, receiver, token, amount, timelock)` — so both
///         phones compute the same id off-line, before either one has sent a
///         transaction, and the app can read the escrow state with `swaps(id)`
///         without knowing who locked it. The sender is recorded at lock time;
///         it is not part of the id because the receiver, the amount, the
///         hashlock and the timelock already fix the whole deal.
///
///         Reveal R on this side (claim) and the Lightning HTLC becomes
///         claimable by whoever holds the invoice; if nobody claims here before
///         `timelock`, the token leg is refundable to the sender.
///
///         Deliberately minimal: no fees, no owner, no upgrade path, no
///         reentrancy guard (checks-effects-interactions plus a one-shot
///         `claimed` flag is enough for an idempotent swap record).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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

    /// @notice Refuse timelocks so short a refund could race the claim.
    uint256 public constant MIN_TIMELOCK_DELTA = 5 minutes;

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
    error TimelockTooSoon(uint256 timelock, uint256 minimum);
    error SwapExists(bytes32 swapId);
    error SwapUnknown(bytes32 swapId);
    error AlreadySettled(bytes32 swapId);
    error HashlockMismatch(bytes32 expected, bytes32 actual);
    error TimelockExpired(uint256 timelock, uint256 timestamp);
    error TimelockNotExpired(uint256 timelock, uint256 timestamp);
    error TransferFailed();

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
    ) external returns (bytes32 swapId) {
        if (amount == 0) revert ZeroAmount();
        if (receiver == address(0) || token == address(0)) revert ZeroAddress();
        uint256 minimum = block.timestamp + MIN_TIMELOCK_DELTA;
        if (timelock < minimum) revert TimelockTooSoon(timelock, minimum);

        swapId = computeSwapId(hashlock, receiver, token, amount, timelock);
        if (swaps[swapId].sender != address(0)) revert SwapExists(swapId);

        Swap storage s = swaps[swapId];
        s.hashlock = hashlock;
        s.amount = amount;
        s.timelock = timelock;
        s.token = token;
        s.sender = msg.sender;
        s.receiver = receiver;

        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }
        emit Locked(swapId, msg.sender, receiver, token, amount, hashlock, timelock);
    }

    // --------------------------------------------------------------- claim ---

    /// @notice Reveal the preimage and pay the receiver. Emits R on-chain.
    /// @dev    Callable by anyone holding R — the token can only go to the
    ///         receiver fixed at lock time, so a front-runner gains nothing.
    function claim(bytes32 swapId, bytes32 preimage) external {
        Swap storage s = swaps[swapId];
        if (s.sender == address(0)) revert SwapUnknown(swapId);
        if (s.claimed || s.refunded) revert AlreadySettled(swapId);
        if (block.timestamp >= s.timelock) revert TimelockExpired(s.timelock, block.timestamp);

        bytes32 computed = sha256(abi.encodePacked(preimage));
        if (computed != s.hashlock) revert HashlockMismatch(s.hashlock, computed);

        s.claimed = true; // effects before the external call
        if (!IERC20(s.token).transfer(s.receiver, s.amount)) revert TransferFailed();
        emit Claimed(swapId, preimage);
    }

    // -------------------------------------------------------------- refund ---

    /// @notice After the timelock, return the tokens to the sender.
    /// @dev    Permissionless: the destination is fixed, so anyone may clean up.
    function refund(bytes32 swapId) external {
        Swap storage s = swaps[swapId];
        if (s.sender == address(0)) revert SwapUnknown(swapId);
        if (s.claimed || s.refunded) revert AlreadySettled(swapId);
        if (block.timestamp < s.timelock) revert TimelockNotExpired(s.timelock, block.timestamp);

        s.refunded = true;
        if (!IERC20(s.token).transfer(s.sender, s.amount)) revert TransferFailed();
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

    /// @notice Deterministic swap id from the terms; mirrors the id `lock` uses.
    function computeSwapId(
        bytes32 hashlock,
        address receiver,
        address token,
        uint256 amount,
        uint256 timelock
    ) public pure returns (bytes32) {
        return sha256(abi.encodePacked(hashlock, receiver, token, amount, timelock));
    }
}
