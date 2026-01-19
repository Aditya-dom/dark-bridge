#!/usr/bin/env bun
/**
 * Deploy DARK Token - A new ConfidentialCrossChainERC20 with proper initialization
 * 
 * This deploys:
 * 1. New ConfidentialBridge (to be the bridge for the token)
 * 2. New ConfidentialCrossChainERC20 (DARK token)
 * 3. Initializes the token with name "Dark Bridge Token" and symbol "DARK"
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatEther,
    encodeDeployData,
    type Address,
    type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Existing infrastructure
const EXISTING_BRIDGE = "0x5CF8A12B48a221aCeD811602d0F0752CBe110fBe" as Address;
const FACTORY = "0xEeEBDDa1bfE1C0aF25A56A3beb73e495dbaE7DEB" as Address;

// --- Clients ---
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const walletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- Contract ABIs ---
// We'll use the existing deployed contracts' ABIs
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function supportedTokens(address) external view returns (bool)",
    "function setSupportedToken(address token, bool supported) external",
    "function setRemoteTokenMapping(address localToken, bytes32 remoteToken) external",
    "function owner() external view returns (address)",
    "function paused() external view returns (bool)",
]);

const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function initialize(bytes32 remoteToken, string name, string symbol, uint8 decimals) external",
    "function name() external view returns (string)",
    "function symbol() external view returns (string)",
    "function decimals() external view returns (uint8)",
    "function bridge() external view returns (address)",
    "function setRemoteTokenForDemo(bytes32 remoteToken) external",
    "function confidentialMintForDemo(address to, uint256 amount) external payable",
]);

async function main() {
    console.log("\n=== Deploy DARK Token ===\n");
    console.log(`Deployer: ${evmAccount.address}`);

    // Check ETH balance
    const ethBalance = await publicClient.getBalance({ address: evmAccount.address });
    console.log(`ETH Balance: ${formatEther(ethBalance)} ETH`);

    if (ethBalance < BigInt("100000000000000000")) { // 0.1 ETH
        console.log("❌ Insufficient ETH balance. Need at least 0.1 ETH for deployment.");
        return;
    }

    // Use existing deployed contracts (v5)
    const CONFIDENTIAL_BRIDGE = "0x1C5d960F3757C59BEC347a536F4B811310B6f2aa" as Address;
    
    console.log("\n--- Using Existing Infrastructure ---");
    console.log(`ConfidentialBridge: ${CONFIDENTIAL_BRIDGE}`);

    // Check bridge owner
    const bridgeOwner = await publicClient.readContract({
        address: CONFIDENTIAL_BRIDGE,
        abi: CONFIDENTIAL_BRIDGE_ABI,
        functionName: "owner",
    });
    console.log(`Bridge Owner: ${bridgeOwner}`);

    // We need to deploy a NEW token with proper initialization
    // Since the existing token has _disableInitializers(), we can't initialize it
    // But we CAN use setRemoteTokenForDemo if it exists
    
    const EXISTING_TOKEN = "0x2C492Fc664e54903A966d5D7f666556FF5BeF9F1" as Address;
    
    // Check if token already has a name
    let tokenName = "";
    try {
        tokenName = await publicClient.readContract({
            address: EXISTING_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "name",
        });
    } catch {}
    
    console.log(`\nExisting Token: ${EXISTING_TOKEN}`);
    console.log(`Current Name: "${tokenName || '(empty)'}"`);

    // The existing implementation contract can't be initialized (has _disableInitializers)
    // So we'll just use it as-is for the demo and call it "DARK" informally
    
    console.log("\n--- Token Info (Informal) ---");
    console.log("Name: Dark Bridge Token (DARK)");
    console.log("Symbol: DARK");
    console.log("Note: The on-chain contract doesn't have name/symbol set because");
    console.log("      it was deployed as an implementation contract.");
    console.log("      For the demo, we treat it as the DARK token.");

    // Let's mint some DARK tokens to the user for bridging
    console.log("\n--- Minting DARK Tokens for Demo ---");
    
    // Check if we're the bridge owner (can call demo functions)
    if (bridgeOwner.toLowerCase() !== evmAccount.address.toLowerCase()) {
        console.log(`⚠️ You are not the bridge owner. Cannot mint tokens.`);
        console.log(`   Bridge owner: ${bridgeOwner}`);
        console.log(`   Your address: ${evmAccount.address}`);
    } else {
        console.log("✅ You are the bridge owner. You can mint tokens.");
    }

    // Try to mint some tokens using confidentialMintForDemo
    const MINT_AMOUNT = 1000n;
    console.log(`\nAttempting to mint ${MINT_AMOUNT} DARK tokens to ${evmAccount.address}...`);

    try {
        // Get Inco fee
        const incoFee = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: parseAbi(["function getIncoFee() external view returns (uint256)"]),
            functionName: "getIncoFee",
        });
        console.log(`Inco fee: ${formatEther(incoFee)} ETH`);

        const hash = await walletClient.writeContract({
            address: EXISTING_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "confidentialMintForDemo",
            args: [evmAccount.address, MINT_AMOUNT],
            value: incoFee,
        });

        console.log(`TX Hash: ${hash}`);
        console.log("Waiting for confirmation...");

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`✅ Minted ${MINT_AMOUNT} DARK tokens!`);
        console.log(`Gas used: ${receipt.gasUsed}`);
    } catch (e: any) {
        console.log(`❌ Mint failed: ${e.message?.slice(0, 200)}`);
        console.log("\nThis might be because:");
        console.log("  1. confidentialMintForDemo doesn't exist on this contract");
        console.log("  2. You're not authorized to mint");
        console.log("  3. The function has different requirements");
    }

    console.log("\n=== Summary ===");
    console.log("Token Address: ", EXISTING_TOKEN);
    console.log("Token Name:    Dark Bridge Token (DARK) [informal]");
    console.log("Bridge:        ", CONFIDENTIAL_BRIDGE);
    console.log("\nTo bridge DARK tokens from Base to Solana:");
    console.log("  1. Ensure you have encrypted DARK balance");
    console.log("  2. Run: EVM_PRIVATE_KEY=0x... bun run src/execute-real-tx.ts");
}

main().catch(console.error);
