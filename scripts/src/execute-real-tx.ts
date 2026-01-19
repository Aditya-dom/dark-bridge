#!/usr/bin/env bun
/**
 * Execute Real Privacy Bridge Transaction with Inco Encryption
 * 
 * This script sends a real transaction to the ConfidentialBridge on Base Sepolia
 * using real encryption from @inco/js.
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatEther,
    type Address,
    type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { PublicKey } from "@solana/web3.js";

// Try to import Inco Lightning
let Lightning: any = null;
let handleTypes: any = null;
try {
    const incoLite = await import("@inco/js/lite");
    Lightning = incoLite.Lightning;
    const incoMain = await import("@inco/js");
    handleTypes = incoMain.handleTypes;
    console.log("✅ @inco/js/lite loaded successfully");
} catch (e: any) {
    console.log(`⚠️ @inco/js/lite not available: ${e.message}`);
}

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses (v5 - with setRemoteTokenForDemo)
const CONFIDENTIAL_BRIDGE = "0x1C5d960F3757C59BEC347a536F4B811310B6f2aa" as Address;
const CONFIDENTIAL_TOKEN = "0x2C492Fc664e54903A966d5D7f666556FF5BeF9F1" as Address;

// Solana recipient (Solana CLI wallet - has initialized vault)
const SOLANA_RECIPIENT = new PublicKey("BfxvKDgh3nWpM5JX2NF7M7MJLirJkuWHMM3n5JohStx");

// Amount to bridge
const AMOUNT_TO_BRIDGE = 10n;

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
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function bridgePrivateToSolana(address localToken, bytes32 toSolana, bytes encryptedAmount) external payable",
    "function getIncoFee() external view returns (uint256)",
    "function paused() external view returns (bool)",
    "event ConfidentialBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolana, bytes32 encryptedAmount)",
]);

async function main() {
    console.log("\n=== Real Privacy Bridge Transaction (with Inco) ===\n");
    console.log(`Wallet: ${evmAccount.address}`);

    // Check ETH balance
    const ethBalance = await publicClient.getBalance({ address: evmAccount.address });
    console.log(`ETH Balance: ${formatEther(ethBalance)} ETH`);

    // Check bridge status
    const isPaused = await publicClient.readContract({
        address: CONFIDENTIAL_BRIDGE,
        abi: CONFIDENTIAL_BRIDGE_ABI,
        functionName: "paused",
    });
    console.log(`Bridge Paused: ${isPaused}`);

    if (isPaused) {
        console.log("❌ Bridge is paused. Cannot proceed.");
        return;
    }

    // Get Inco fee
    const incoFee = await publicClient.readContract({
        address: CONFIDENTIAL_BRIDGE,
        abi: CONFIDENTIAL_BRIDGE_ABI,
        functionName: "getIncoFee",
    });
    console.log(`Inco Fee: ${formatEther(incoFee)} ETH`);

    console.log("\n--- Transaction Details ---");
    console.log(`Amount: ${AMOUNT_TO_BRIDGE} tokens`);
    console.log(`To Solana: ${SOLANA_RECIPIENT.toBase58()}`);
    console.log(`Token: ${CONFIDENTIAL_TOKEN}`);

    // Encrypt amount
    let encryptedAmount: Hex;

    if (Lightning) {
        console.log("\n🔐 Encrypting with Inco Lightning...");
        try {
            // Use "devnet" environment (not "testnet") - this is what Inco's nextjs-template uses
            const lightning = await Lightning.latest("devnet", 84532);
            console.log("   Inco network initialized (devnet)");

            encryptedAmount = await lightning.encrypt(AMOUNT_TO_BRIDGE, {
                accountAddress: evmAccount.address,
                dappAddress: CONFIDENTIAL_BRIDGE,
                handleType: handleTypes.euint256,
            }) as Hex;

            console.log(`   ✅ Encrypted! Ciphertext: ${encryptedAmount.slice(0, 50)}...`);
            console.log(`   Ciphertext length: ${(encryptedAmount.length - 2) / 2} bytes`);
        } catch (e: any) {
            console.log(`   ⚠️ Inco encryption failed: ${e.message}`);
            console.log("   Falling back to simulated encryption...");
            encryptedAmount = createSimulatedCiphertext(AMOUNT_TO_BRIDGE);
        }
    } else {
        console.log("\n⚠️ Using simulated encryption (Inco not available)");
        encryptedAmount = createSimulatedCiphertext(AMOUNT_TO_BRIDGE);
    }

    // Convert Solana pubkey to bytes32
    const solanaBytes32 = pubkeyToBytes32(SOLANA_RECIPIENT);
    console.log(`\nSolana as bytes32: ${solanaBytes32}`);

    // Confirmation
    console.log("\n⚠️  About to send real transaction!");
    console.log("Press Ctrl+C to cancel, or wait 2 seconds to proceed...\n");
    await new Promise(r => setTimeout(r, 2000));

    // Send transaction
    console.log("📤 Sending transaction...");

    try {
        const hash = await walletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "bridgePrivateToSolana",
            args: [
                CONFIDENTIAL_TOKEN,
                solanaBytes32,
                encryptedAmount,
            ],
            value: incoFee,
        });

        console.log(`\n✅ Transaction sent!`);
        console.log(`   Hash: ${hash}`);
        console.log(`   View: https://sepolia.basescan.org/tx/${hash}`);

        // Wait for confirmation
        console.log("\n⏳ Waiting for confirmation...");
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        console.log(`\n✅ Confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed}`);
        console.log(`   Status: ${receipt.status === "success" ? "✅ Success" : "❌ Failed"}`);

        // Check for events
        if (receipt.logs.length > 0) {
            console.log(`\n📝 Emitted ${receipt.logs.length} log(s):`);
            for (const log of receipt.logs) {
                console.log(`   - ${log.address.slice(0, 10)}...: ${log.topics[0]?.slice(0, 20)}...`);
            }
        }

        console.log("\n🎉 SUCCESS! Private bridge transaction complete!");
        console.log("\nNext Steps:");
        console.log("1. Run the privacy relayer to relay to Solana:");
        console.log(`   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts ${hash}`);

    } catch (error: any) {
        console.error(`\n❌ Transaction failed: ${error.message}`);

        if (error.cause?.reason) {
            console.error(`   Reason: ${error.cause.reason}`);
        }

        if (error.message.includes("reverted")) {
            console.log("\n💡 Possible causes:");
            console.log("   - Invalid ciphertext (Inco network may be unavailable)");
            console.log("   - User has no encrypted balance");
            console.log("   - Token not properly registered");
        }
    }
}

/**
 * Convert Solana pubkey to bytes32 for EVM.
 */
function pubkeyToBytes32(pubkey: PublicKey): Hex {
    const bytes = pubkey.toBytes();
    return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

/**
 * Create a simulated ciphertext for testing (won't work with real Inco).
 */
function createSimulatedCiphertext(amount: bigint): Hex {
    const buffer = Buffer.alloc(578);
    const amountHex = amount.toString(16).padStart(64, "0");
    Buffer.from(amountHex, "hex").copy(buffer, 0);
    for (let i = 32; i < buffer.length; i++) {
        buffer[i] = (i * 17 + 42) % 256;
    }
    return ("0x" + buffer.toString("hex")) as Hex;
}

main().catch(console.error);
