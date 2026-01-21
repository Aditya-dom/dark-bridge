// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {euint256, ebool, e, inco} from "@inco/lightning/src/Lib.sol";

/// @title SimpleConfidentialToken
/// @notice A fungible token with confidential balances and transfer amounts
/// @dev Uses Inco Lightning for encrypted state
contract SimpleConfidentialToken {
    using e for euint256;
    using e for ebool;
    using e for uint256;
    using e for bytes;
    using e for address;

    /// @notice Encrypted balance per address (handles stored as euint256)
    mapping(address => euint256) public balanceOf;

    /// @notice Token decimals (9 = GWEI units, standard for confidential tokens)
    uint8 public constant decimals = 9;

    constructor() {
        // Mint 1000 tokens to deployer using trivial encryption
        balanceOf[msg.sender] = uint256(1000 * 1e9).asEuint256();
    }

    /// @notice Transfer tokens using encrypted input (for EOAs/smart wallets)
    /// @param to Recipient address
    /// @param valueInput Encrypted amount (from JS SDK)
    /// @return success Encrypted boolean indicating if transfer succeeded
    function transfer(address to, bytes memory valueInput) external payable returns (ebool) {
        require(msg.value >= inco.getFee(), "Fee not paid");
        euint256 value = valueInput.newEuint256(msg.sender);
        return _transfer(to, value);
    }

    /// @notice Transfer tokens using existing encrypted handle (for contracts)
    /// @param to Recipient address
    /// @param value Encrypted amount handle
    /// @return success Encrypted boolean indicating if transfer succeeded
    function transfer(address to, euint256 value) public returns (ebool success) {
        // SECURITY: Always verify caller has access to the handle
        require(msg.sender.isAllowed(value), "Unauthorized value handle access");
        return _transfer(to, value);
    }

    /// @dev Internal transfer logic
    function _transfer(address to, euint256 value) internal returns (ebool success) {
        // Check if sender has sufficient balance (encrypted comparison)
        success = balanceOf[msg.sender].ge(value);
        
        // Use multiplexer pattern: transfer value if success, else 0
        euint256 transferredValue = success.select(value, uint256(0).asEuint256());

        // Calculate new balances
        euint256 senderNewBalance = balanceOf[msg.sender].sub(transferredValue);
        euint256 receiverNewBalance = balanceOf[to].add(transferredValue);

        // Update state
        balanceOf[msg.sender] = senderNewBalance;
        balanceOf[to] = receiverNewBalance;

        // CRITICAL: Grant access permissions
        // Users need access to see their balances
        senderNewBalance.allow(msg.sender);
        receiverNewBalance.allow(to);
        
        // Contract needs access for future operations
        senderNewBalance.allowThis();
        receiverNewBalance.allowThis();
        
        // Caller sees if transfer succeeded
        success.allow(msg.sender);
    }

    /// @notice Get balance of an address (returns handle, not value)
    function getBalance(address account) external view returns (euint256) {
        return balanceOf[account];
    }
}
