/**
 * Solana to Base Relayer Service
 * 
 * Watches Solana bridge transactions and creates claims on Base.
 * 
 * Flow:
 * 1. Watch for bridge_call transactions on Solana
 * 2. Parse the transaction data
 * 3. Create a private claim on Base
 * 4. User claims with attestation signature
 */

import {
    createWalletClient,
    createPublicClient,
    http,
    parseAbi,
    type Address,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";

// Configuration
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A" as Address;
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const SOLANA_RPC = "https://api.devnet.solana.com";

// Environment
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Bridge ABI
const BRIDGE_ABI = parseAbi([
    "function createPrivateClaim(address localToken, bytes encryptedAmount, bytes encryptedRecipient, uint256 claimDuration) external payable returns (uint256 claimId)",
    "function getIncoFee() external view returns (uint256)",
    "event PrivateClaimCreated(uint256 indexed claimId, address indexed localToken, uint256 expiry)",
]);

// Viem clients
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const walletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Solana connection
const connection = new Connection(SOLANA_RPC, "confirmed");

// Track processed signatures to avoid duplicates
const processedSignatures = new Set<string>();

async function processTransaction(signature: string) {
    if (processedSignatures.has(signature)) return;
    processedSignatures.add(signature);

    console.log(`[${new Date().toISOString()}] Processing Solana TX: ${signature}`);

    try {
        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            console.error("  Transaction not found");
            return;
        }

        // Check if this is a bridge transaction
        const programIndex = tx.transaction.message.staticAccountKeys.findIndex(
            (key) => key.equals(BRIDGE_PROGRAM_ID)
        );

        if (programIndex === -1) {
            return; // Not our program
        }

        console.log("  Bridge transaction detected");
        console.log(`  Slot: ${tx.slot}`);

        // For demo: Log what we would do
        // In production: Parse instruction data, create claim on Base
        console.log("  Would create private claim on Base");

    } catch (error) {
        console.error("  Error processing transaction:", error);
    }
}

async function pollForTransactions() {
    const [bridgePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge")],
        BRIDGE_PROGRAM_ID
    );

    console.log(`Polling bridge PDA: ${bridgePda.toBase58()}`);

    try {
        const signatures = await connection.getSignaturesForAddress(bridgePda, {
            limit: 10,
        });

        for (const sig of signatures) {
            await processTransaction(sig.signature);
        }
    } catch (error) {
        console.error("Poll error:", error);
    }
}

async function startWatching() {
    console.log("=======================================================");
    console.log(" Solana to Base Relayer");
    console.log("=======================================================");
    console.log(`Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`Token: ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`Program: ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`Relayer: ${evmAccount.address}`);
    console.log("");
    console.log("Watching for Solana bridge transactions...");
    console.log("");

    // Initial poll
    await pollForTransactions();

    // Poll every 10 seconds
    setInterval(async () => {
        await pollForTransactions();
    }, 10000);

    // Heartbeat
    setInterval(() => {
        console.log(`[${new Date().toISOString()}] Relayer running...`);
    }, 60000);

    // Keep process running
    process.on("SIGINT", () => {
        console.log("\nShutting down...");
        process.exit(0);
    });
}

startWatching().catch((err) => {
    console.error("Failed to start relayer:", err);
    process.exit(1);
});
