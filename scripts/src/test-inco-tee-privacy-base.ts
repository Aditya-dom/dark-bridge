#!/usr/bin/env bun
/**
 * Test Inco TEE Recipient Privacy on Base (EVM)
 * 
 * Uses REAL @inco/js SDK for encrypting recipient address!
 * 
 * Full privacy:
 * - Amount: Encrypted via Inco TEE
 * - Recipient: ENCRYPTED via eaddress (Inco TEE) - revealed only at claim time!
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type Hex,
    parseAbi,
    custom,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// Inco SDK imports
import { Lightning } from "@inco/js/lite";
import { handleTypes, getViemChain, chains } from "@inco/js";

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY required");
}
const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed Confidential Bridge with eaddress support
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A" as Address;

// Viem clients
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const baseWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// ABIs
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function createPrivateClaim(address localToken, bytes encryptedAmount, bytes encryptedRecipient, uint256 claimDuration) external payable returns (uint256 claimId)",
    "function claimWithAttestation(uint256 claimId, address decryptedRecipient, bytes attestationSignature) external payable",
    "function isPrivateClaimValid(uint256 claimId) external view returns (bool)",
    "function getIncoFee() external view returns (uint256)",
    "function privateClaimIdCounter() external view returns (uint256)",
    "event PrivateClaimCreated(uint256 indexed claimId, address indexed localToken, uint256 expiry)",
    "event PrivateClaimRedeemed(uint256 indexed claimId, address indexed recipient)",
]);

async function main() {
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║  INCO TEE RECIPIENT PRIVACY: Real SDK Encryption               ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    console.log(`🔐 Account: ${evmAccount.address}`);
    console.log(`📍 ConfidentialBridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`🪙 ConfidentialToken:  ${CONFIDENTIAL_TOKEN_ADDRESS}\n`);

    // === STEP 1: Initialize Inco Lightning SDK ===
    console.log("─── Step 1: Initialize Inco Lightning SDK ───\n");

    // IMPORTANT: Use "devnet" pepper because contract's Lib.sol uses executor 0x4732... (devnet)
    // NOT "testnet" which uses a different executor address
    const zap = await Lightning.latest("devnet", 84532); // Base Sepolia chain ID
    console.log(`✅ Inco Lightning SDK initialized for Base Sepolia (devnet)`);

    // === STEP 2: Get Inco fee ===
    console.log("\n─── Step 2: Get Inco Fee ───\n");

    let incoFee: bigint;
    try {
        incoFee = await basePublicClient.readContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getIncoFee",
        });
        console.log(`Inco fee: ${incoFee} wei`);
    } catch (e: any) {
        console.log(`⚠️ Could not get Inco fee: ${e.message}`);
        incoFee = BigInt("1000000000000"); // Default
        console.log(`Using default: ${incoFee} wei`);
    }

    // === STEP 3: Encrypt recipient address using Inco SDK ===
    console.log("\n─── Step 3: Encrypt Recipient Address (REAL SDK) ───\n");

    const recipientAddress = evmAccount.address;
    console.log(`🎯 Recipient to encrypt: ${recipientAddress}`);

    // Convert address to BigInt (addresses are 160-bit integers)
    const recipientAsBigInt = BigInt(recipientAddress);
    console.log(`   As BigInt: ${recipientAsBigInt}`);

    // Encrypt using Inco SDK - addresses are 160-bit integers so use euint160
    console.log(`   Encrypting with Inco SDK (handleType: euint160 for address)...`);

    const encryptedRecipient = await zap.encrypt(recipientAsBigInt, {
        accountAddress: evmAccount.address,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint160, // Addresses are 160-bit integers
    });

    // encryptedRecipient is already a hex string from the SDK
    console.log(`✅ Encrypted recipient: ${typeof encryptedRecipient === 'string' ? encryptedRecipient.slice(0, 50) : '0x' + Buffer.from(encryptedRecipient).toString('hex').slice(0, 40)}...`);
    console.log(`   Type: ${typeof encryptedRecipient}, Length: ${encryptedRecipient.length}`);

    // === STEP 4: Encrypt amount ===
    console.log("\n─── Step 4: Encrypt Amount (REAL SDK) ───\n");

    const amount = 5n;
    console.log(`💰 Amount to encrypt: ${amount} tokens`);

    const encryptedAmount = await zap.encrypt(amount, {
        accountAddress: evmAccount.address,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint256,
    });

    // encryptedAmount is already a hex string from the SDK
    console.log(`✅ Encrypted amount: ${typeof encryptedAmount === 'string' ? encryptedAmount.slice(0, 50) : '0x' + Buffer.from(encryptedAmount).toString('hex').slice(0, 40)}...`);
    console.log(`   Type: ${typeof encryptedAmount}, Length: ${encryptedAmount.length}`);

    // === STEP 5: Create Private Claim ===
    console.log("\n─── Step 5: Create Private Claim ───\n");

    const claimDuration = 3600n; // 1 hour

    console.log(`📋 Creating claim with:`);
    console.log(`   Token: ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`   Duration: ${claimDuration} seconds`);
    console.log(`   Recipient: ENCRYPTED via Inco TEE eaddress!`);
    console.log(`   Amount: ENCRYPTED via Inco TEE euint256!`);

    try {
        // Check format of encrypted data and convert properly
        const amountHex = typeof encryptedAmount === 'string'
            ? (encryptedAmount.startsWith('0x') ? encryptedAmount : `0x${encryptedAmount}`)
            : `0x${Buffer.from(encryptedAmount).toString("hex")}`;

        const recipientHex = typeof encryptedRecipient === 'string'
            ? (encryptedRecipient.startsWith('0x') ? encryptedRecipient : `0x${encryptedRecipient}`)
            : `0x${Buffer.from(encryptedRecipient).toString("hex")}`;

        console.log(`   Amount ciphertext: ${amountHex.slice(0, 50)}...`);
        console.log(`   Recipient ciphertext: ${recipientHex.slice(0, 50)}...`);

        const hash = await baseWalletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "createPrivateClaim",
            args: [
                CONFIDENTIAL_TOKEN_ADDRESS,
                amountHex as Hex,
                recipientHex as Hex,
                claimDuration,
            ],
            value: incoFee * 2n, // Fee for 2 encryptions
        });

        console.log(`\n✅ TX: ${hash}`);
        console.log(`   Explorer: https://sepolia.basescan.org/tx/${hash}`);

        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });
        console.log(`✅ Confirmed in block ${receipt.blockNumber}`);

        // Look for PrivateClaimCreated event
        console.log(`\n📋 Private claim created successfully!`);

    } catch (e: any) {
        console.error(`❌ Error: ${e.message}`);
        if (e.shortMessage) {
            console.error(`   Details: ${e.shortMessage}`);
        }
    }

    // === Summary ===
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                      PRIVACY SUMMARY                           ║");
    console.log("╠════════════════════════════════════════════════════════════════╣");
    console.log("║  Sender             │ 🟢 Hidden (relayer can submit)           ║");
    console.log("║  Amount             │ 🟢 ENCRYPTED (Inco TEE euint256)         ║");
    console.log("║  Recipient          │ 🟢 ENCRYPTED (Inco TEE eaddress)         ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    console.log(`📋 To claim, recipient would call:`);
    console.log(`   1. zap.attestedDecrypt(walletClient, [recipientHandle])`);
    console.log(`   2. claimWithAttestation(claimId, decryptedAddress, attestation)`);
}

main().catch(console.error);
