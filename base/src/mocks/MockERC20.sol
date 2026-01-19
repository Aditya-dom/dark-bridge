// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Simple mock ERC20 for testing private bridge deposits.
contract MockERC20 is ERC20 {
    constructor() ERC20("Dark Bridge Test Token", "DARK") {
        // Mint 1 million tokens to deployer
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    /// @notice Anyone can mint for testing (testnet only)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
