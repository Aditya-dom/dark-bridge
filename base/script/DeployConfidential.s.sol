// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ConfidentialCrossChainERC20} from "../src/ConfidentialCrossChainERC20.sol";
import {ConfidentialBridge} from "../src/ConfidentialBridge.sol";

/// @title DeployConfidential
/// @notice Deployment script for confidential bridge contracts on Base Sepolia.
/// @dev Run with: forge script script/DeployConfidential.s.sol --rpc-url base-sepolia --broadcast
contract DeployConfidential is Script {
    // Existing bridge address on Base Sepolia (update with your deployment)
    address constant EXISTING_BRIDGE = address(0); // TODO: Set your bridge address

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console2.log("Deploying confidential contracts...");
        console2.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy Confidential Token Implementation (for beacon proxy pattern)
        ConfidentialCrossChainERC20 tokenImpl = new ConfidentialCrossChainERC20(
            EXISTING_BRIDGE
        );
        console2.log("ConfidentialCrossChainERC20 impl:", address(tokenImpl));

        // Deploy Confidential Bridge
        // Note: In production, you'd deploy a factory first
        ConfidentialBridge confidentialBridge = new ConfidentialBridge(
            EXISTING_BRIDGE,
            address(0) // TODO: Set factory address
        );
        console2.log("ConfidentialBridge:", address(confidentialBridge));

        vm.stopBroadcast();

        console2.log("\n=== Deployment Complete ===");
        console2.log("Token Implementation:", address(tokenImpl));
        console2.log("Confidential Bridge:", address(confidentialBridge));
    }
}
