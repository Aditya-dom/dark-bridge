// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @title DeployMockToken
/// @notice Deploy mock ERC20 for testing private bridge deposits.
contract DeployMockToken is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying MockERC20...");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        MockERC20 token = new MockERC20();
        console2.log("MockERC20 deployed:", address(token));

        vm.stopBroadcast();

        console2.log("\n=== Mock Token Deployed ===");
        console2.log("Address:", address(token));
        console2.log("Symbol: DARK");
        console2.log("Balance:", token.balanceOf(deployer));
    }
}
