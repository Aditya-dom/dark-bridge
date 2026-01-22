#!/usr/bin/env bun
/**
 * Test Full Privacy: Base → Solana with Commitment-Based Claiming
 * 
 * This script tests the FULL PRIVACY flow:
 * - Sender: HIDDEN (relayer submits via EIP-712)
 * - Amount: ENCRYPTED (Inco TEE)
 * - Recipient: HIDDEN (commitment-based claiming on Solana)
 * 
 * Flow:
 * 1. Recipient (on Solana) generates a secret off-chain
 * 2. Recipient creates commitment = keccak256(secret)
 * 3. Sender signs EIP-712 message (doesn't submit directly)
 * 4. Relayer submits bridgePrivateViaRelayer with commitment
 * 5. Relayer creates claim on Solana using commitment
 * 6. Recipient claims on Solana using secret
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    toHex,
    type Address,
    type Hex,
    parseAbi,
    encodePacked,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
    Connection,
    Keypair,
    PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY required");
}
const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Contract addresses
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xfa1CBa0067D967bbD17eFd2Ab815B92AaB418A7f" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xc4104aCBa7059c2f8FEFdf746a1c4b9B8a89Ec7D" as Address;

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
    "function bridgePrivateViaRelayer(address localToken, bytes32 commitment, bytes encryptedAmount, address sender, uint256 senderNonce, uint256 deadline, bytes signature) external payable",
    "function getUserNonce(address user) external view returns (uint256)",
    "function getIncoFee() external view returns (uint256)",
    "function domainSeparator() external view returns (bytes32)",
    "event PrivateBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed commitment, uint256 encryptedAmount)",
]);

async function main() {
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║     FULL PRIVACY: Base → Solana with Commitment Claiming       ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    // Load Solana keypair (for demonstration)
    const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const solanaWallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

    console.log(`🔐 Base Sender (HIDDEN!): ${evmAccount.address}`);
    console.log(`🔐 Solana Claimer:        ${solanaWallet.publicKey.toBase58()}`);
    console.log("");

    // === STEP 1: Generate secret and commitment ===
    console.log("─── Step 1: Generate Secret & Commitment ───\n");

    // Generate a random 32-byte secret
    const secret = crypto.randomBytes(32);
    const secretHex = `0x${secret.toString("hex")}` as Hex;

    // Compute commitment = keccak256(secret)
    // For Solana claiming, we use the same commitment scheme
    const commitment = keccak256(secretHex);

    console.log(`🔑 Secret (KEEP PRIVATE!): ${secretHex.slice(0, 20)}...`);
    console.log(`📦 Commitment (public):    ${commitment.slice(0, 20)}...`);
    console.log("");
    console.log(`⚠️  Only the Solana recipient knows the secret!`);
    console.log(`⚠️  The commitment reveals NOTHING about who will claim.`);

    // === STEP 2: Get nonces and fees ===
    console.log("\n─── Step 2: Get Nonces and Fees ───\n");

    const userNonce = await basePublicClient.readContract({
        address: CONFIDENTIAL_BRIDGE_ADDRESS,
        abi: CONFIDENTIAL_BRIDGE_ABI,
        functionName: "getUserNonce",
        args: [evmAccount.address],
    });
    console.log(`User nonce: ${userNonce}`);

    let incoFee: bigint;
    try {
        incoFee = await basePublicClient.readContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getIncoFee",
        });
    } catch {
        incoFee = BigInt("1000000000000"); // Default
    }
    console.log(`Inco fee: ${incoFee} wei`);

    // === STEP 3: Sign EIP-712 message ===
    console.log("\n─── Step 3: Sign EIP-712 Message ───\n");

    // Create test encrypted amount
    const encryptedAmount = `0x${Buffer.alloc(114).fill(5).toString("hex")}` as Hex;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    // EIP-712 domain
    const domain = {
        name: "ConfidentialBridge",
        version: "1",
        chainId: baseSepolia.id,
        verifyingContract: CONFIDENTIAL_BRIDGE_ADDRESS,
    };

    // EIP-712 types
    const types = {
        PrivateBridge: [
            { name: "localToken", type: "address" },
            { name: "commitment", type: "bytes32" },
            { name: "encryptedAmount", type: "bytes" },
            { name: "sender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    };

    // Message to sign
    const message = {
        localToken: CONFIDENTIAL_TOKEN_ADDRESS,
        commitment: commitment,
        encryptedAmount: keccak256(encryptedAmount), // Hash of encrypted amount
        sender: evmAccount.address,
        nonce: userNonce,
        deadline: deadline,
    };

    console.log(`Signing EIP-712 message...`);
    console.log(`  Token: ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`  Commitment: ${commitment.slice(0, 20)}...`);
    console.log(`  Deadline: ${deadline}`);

    const signature = await baseWalletClient.signTypedData({
        domain,
        types,
        primaryType: "PrivateBridge",
        message,
    });

    console.log(`✅ Signature: ${signature.slice(0, 30)}...`);

    // === STEP 4: Describe relayer submission ===
    console.log("\n─── Step 4: Relayer Submits Transaction ───\n");

    console.log(`📋 In production, the relayer would call:`);
    console.log(`   ConfidentialBridge.bridgePrivateViaRelayer(`);
    console.log(`     localToken:     ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`     commitment:     ${commitment.slice(0, 20)}...`);
    console.log(`     encryptedAmount: <ciphertext>`);
    console.log(`     sender:         ${evmAccount.address}`);
    console.log(`     senderNonce:    ${userNonce}`);
    console.log(`     deadline:       ${deadline}`);
    console.log(`     signature:      ${signature.slice(0, 20)}...`);
    console.log(`   )`);
    console.log("");
    console.log(`🔒 SENDER PRIVACY: Relayer's address appears on-chain, not user's!`);

    // === STEP 5: Describe Solana claim ===
    console.log("\n─── Step 5: Solana Claim Creation & Redemption ───\n");

    console.log(`📋 The relayer monitors PrivateBridgeInitiated event and calls:`);
    console.log(`   create_confidential_claim(`);
    console.log(`     commitment_hash: ${commitment.slice(0, 20)}...`);
    console.log(`     encrypted_amount: <from event>`);
    console.log(`     claim_duration: 3600`);
    console.log(`   )`);
    console.log("");
    console.log(`📋 To claim, the Solana recipient calls:`);
    console.log(`   redeem_confidential_claim(`);
    console.log(`     secret: ${secretHex.slice(0, 20)}...`);
    console.log(`   )`);
    console.log("");
    console.log(`🎉 ONLY at claim time is the Solana recipient's address revealed!`);

    // === Summary ===
    console.log("\n╔════════════════════════════════════════════════════════════════╗");
    console.log("║                      PRIVACY SUMMARY                           ║");
    console.log("╠════════════════════════════════════════════════════════════════╣");
    console.log("║  Sender (Base)      │ 🟢 HIDDEN (relayer submits)              ║");
    console.log("║  Amount             │ 🟢 ENCRYPTED (Inco TEE)                  ║");
    console.log("║  Recipient (Solana) │ 🟢 HIDDEN until claim                    ║");
    console.log("╚════════════════════════════════════════════════════════════════╝\n");

    console.log(`💾 Save this secret for the Solana recipient to claim:`);
    console.log(`   ${secretHex}`);
}

main().catch(console.error);
