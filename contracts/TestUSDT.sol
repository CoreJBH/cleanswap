// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  TestUSDT
/// @notice A throwaway 6-decimal ERC-20 with an open faucet, for exercising
///         LightningUsdtHTLC on Arbitrum Sepolia or any EVM testnet.
/// @dev    No access control, no upgradeability, no real value. Deploy it,
///         hit `faucet()`, approve the HTLC, and trade.
contract TestUSDT {
    string public constant name = "Test Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    mapping(address account => uint256) public lastFaucet;

    /// @notice 10,000 USDT per drip.
    uint256 public constant FAUCET_AMOUNT = 10_000 * 1e6;
    /// @notice One drip per address per hour.
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Faucet(address indexed account, uint256 amount);

    error InsufficientBalance(address account, uint256 balance, uint256 needed);
    error InsufficientAllowance(address owner, uint256 allowance, uint256 needed);
    error FaucetCooldown(uint256 readyAt);

    /// @notice Mint yourself 10,000 test USDT.
    function faucet() external returns (uint256) {
        uint256 readyAt = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < readyAt) revert FaucetCooldown(readyAt);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit Faucet(msg.sender, FAUCET_AMOUNT);
        return FAUCET_AMOUNT;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance(from, allowed, value);
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        uint256 balance = balanceOf[from];
        if (balance < value) revert InsufficientBalance(from, balance, value);
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        unchecked {
            balanceOf[to] += value;
        }
        emit Transfer(address(0), to, value);
    }
}
