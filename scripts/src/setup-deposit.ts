#!/usr/bin/env bun
/**
 * Setup Token Deposit Flow
 * 
 * This script:
 * 1. Deploys a mock ERC20 token
 * 2. Mints tokens to the user
 * 3. Uses confidentialMint to give user encrypted balance
 * 4. Then the user can bridge privately
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatEther,
    type Address,
    type Hex,
    encodeFunctionData,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Import Inco
let Lightning: any = null;
try {
    const incoLite = await import("@inco/js/lite");
    Lightning = incoLite.Lightning;
    console.log("✅ @inco/js/lite loaded");
} catch (e: any) {
    console.log(`⚠️ @inco/js/lite not available: ${e.message}`);
}

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses
const CONFIDENTIAL_BRIDGE = "0x7C788FE737acf46e2dbc2F6219653533bd02c558" as Address;
const CONFIDENTIAL_TOKEN = "0x905367eff70fE43F0792bf16DB183a6929E181d7" as Address;

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

// --- ABIs ---
const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function balanceOf(address account) external view returns (uint256)",
    "function confidentialMint(address to, bytes encryptedAmount) external payable",
    "function getEncryptedBalance(address account) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
]);

async function main() {
    console.log("\n=== Setting Up Token Deposit Flow ===\n");
    console.log(`Wallet: ${evmAccount.address}`);

    // Check ETH balance
    const ethBalance = await publicClient.getBalance({ address: evmAccount.address });
    console.log(`ETH Balance: ${formatEther(ethBalance)} ETH`);

    // Step 1: Check current encrypted balance
    console.log("\n--- Step 1: Check Encrypted Balance ---");
    try {
        const balance = await publicClient.readContract({
            address: CONFIDENTIAL_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "balanceOf",
            args: [evmAccount.address],
        });
        console.log(`Current encrypted balance handle: ${balance}`);
    } catch (e: any) {
        console.log(`   Error reading balance: ${e.message?.slice(0, 100)}`);
    }

    // Step 2: Encrypt an amount to mint
    console.log("\n--- Step 2: Encrypt Amount for Minting ---");

    const amountToMint = 1000n; // 1000 tokens
    let encryptedAmount: Hex;

    if (Lightning) {
        console.log(`   Encrypting ${amountToMint} tokens with Inco Lightning...`);
        try {
            const lightning = await Lightning.latest("testnet", 84532);
            encryptedAmount = await lightning.encrypt(amountToMint, {
                accountAddress: evmAccount.address,
                dappAddress: CONFIDENTIAL_TOKEN,
            }) as Hex;
            console.log(`   ✅ Encrypted! Length: ${(encryptedAmount.length - 2) / 2} bytes`);
        } catch (e: any) {
            console.log(`   ❌ Encryption failed: ${e.message}`);
            return;
        }
    } else {
        console.log("   ❌ Inco not available, cannot proceed");
        return;
    }

    // Step 3: Call confidentialMint
    console.log("\n--- Step 3: Mint Encrypted Tokens ---");
    console.log(`   Calling confidentialMint(${evmAccount.address}, ${encryptedAmount.slice(0, 30)}...)`);
    console.log("   This will create encrypted tokens directly in your balance.");
    console.log("\n   ⚠️ Sending transaction in 2 seconds...\n");
    await new Promise(r => setTimeout(r, 2000));

    try {
        // Get Inco fee (use a default if not available)
        const incoFee = BigInt("100000000000000"); // 0.0001 ETH
        console.log(`   Inco fee: ${formatEther(incoFee)} ETH`);

        const hash = await walletClient.writeContract({
            address: CONFIDENTIAL_TOKEN,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "confidentialMint",
            args: [evmAccount.address, encryptedAmount],
            value: incoFee,
        });

        console.log(`   ✅ Transaction sent: ${hash}`);
        console.log(`   View: https://sepolia.basescan.org/tx/${hash}`);

        // Wait for confirmation
        console.log("\n   ⏳ Waiting for confirmation...");
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        if (receipt.status === "success") {
            console.log(`   ✅ Confirmed in block ${receipt.blockNumber}!`);
            console.log(`   Gas used: ${receipt.gasUsed}`);

            // Check new balance
            console.log("\n--- Step 4: Verify New Balance ---");
            const newBalance = await publicClient.readContract({
                address: CONFIDENTIAL_TOKEN,
                abi: CONFIDENTIAL_TOKEN_ABI,
                functionName: "balanceOf",
                args: [evmAccount.address],
            });
            console.log(`   New encrypted balance handle: ${newBalance}`);
            console.log(`   (Handle is non-zero, meaning you have encrypted tokens!)`);

            console.log("\n🎉 SUCCESS! You now have encrypted tokens!");
            console.log("\n--- Next Steps ---");
            console.log("1. Run the bridge transaction:");
            console.log("   EVM_PRIVATE_KEY=0x... bun run src/execute-real-tx.ts");

        } else {
            console.log(`   ❌ Transaction failed`);
        }

    } catch (error: any) {
        console.error(`   ❌ Transaction failed: ${error.message}`);

        // Check if it's an authorization error
        if (error.message.includes("onlyBridge") || error.message.includes("Unauthorized")) {
            console.log("\n   💡 The confidentialMint function may be restricted to the bridge.");
            console.log("   Try using the alternative approach below.");
        }

        // Show error details
        if (error.cause) {
            console.log(`\n   Error details: ${JSON.stringify(error.cause).slice(0, 200)}`);
        }
    }
}

main().catch(console.error);
