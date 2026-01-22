#!/usr/bin/env bun
/**
 * Test Bridge Confidential Out via Relayer (SENDER PRIVACY)
 * 
 * This script tests the new relay_bridge_confidential_out instruction which
 * allows a relayer to submit the bridge transaction on behalf of the user.
 * 
 * Result: Only the relayer's address is visible on-chain - the user's
 * Solana address is completely hidden!
 * 
 * Flow:
 * 1. User signs a message off-chain (Ed25519 signature)
 * 2. Submits signature + parameters to relayer
 * 3. Relayer verifies signature and submits relay_bridge_confidential_out
 * 4. User's address never appears as a signer
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
    SystemProgram,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Try to import Inco SDK
let encryptValue: any;
try {
    const incoSdk = await import('@inco/solana-sdk/encryption');
    encryptValue = incoSdk.encryptValue;
    console.log("✅ Inco Solana SDK loaded");
} catch (e) {
    console.log("⚠️ @inco/solana-sdk not available, using test ciphertext");
}

// --- Configuration ---
const SOLANA_RPC = "https://api.devnet.solana.com";

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID  
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// The DARK token mint (from remote token set on Base)
const TOKEN_MINT = new PublicKey("GXo4sG2pUdJXx8HGaGb1BashYpr9h8XFbNMsm57ffv6Z");

// Destination EVM address (the user's address on Base)
const DESTINATION_EVM = "0xF8AF04bF0Ac151f2050436603d81Ba20f449028F";

async function main() {
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║  BRIDGE CONFIDENTIAL OUT VIA RELAYER (SENDER PRIVACY!)     ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    // Load BOTH keypairs - user (owner) and relayer
    const userKeypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    const userKeypairData = JSON.parse(fs.readFileSync(userKeypairPath, "utf-8"));
    const user = Keypair.fromSecretKey(new Uint8Array(userKeypairData));

    // For demo, use the same keypair as relayer (in production, different)
    // In a real scenario, the relayer would be a separate service
    const relayer = user; // Demo mode: same key

    console.log(`👤 User (Vault Owner): ${user.publicKey.toBase58()}`);
    console.log(`🤖 Relayer:            ${relayer.publicKey.toBase58()}`);
    console.log(`📍 Token Mint:         ${TOKEN_MINT.toBase58()}`);
    console.log(`📍 Destination EVM:    ${DESTINATION_EVM}`);
    console.log("");

    // Connect to Solana
    const connection = new Connection(SOLANA_RPC, "confirmed");

    // Check SOL balance
    const balance = await connection.getBalance(relayer.publicKey);
    console.log(`💰 Relayer SOL Balance: ${balance / 1e9} SOL`);

    // Derive vault PDA
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            user.publicKey.toBuffer(),
            TOKEN_MINT.toBuffer(),
        ],
        BRIDGE_PROGRAM_ID
    );
    console.log(`🏦 Vault PDA: ${vaultPda.toBase58()}`);

    // Derive bridge PDA
    const [bridgePda, bridgeBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`🌉 Bridge PDA: ${bridgePda.toBase58()}`);

    // Check if vault exists
    const vaultAccount = await connection.getAccountInfo(vaultPda);
    if (!vaultAccount) {
        console.error("\n❌ Vault does not exist! Initialize it first.");
        return;
    }
    console.log(`✅ Vault exists with ${vaultAccount.data.length} bytes`);

    // Parse vault to check balance handle
    const vaultData = vaultAccount.data;
    const encryptedBalance = vaultData.subarray(8 + 32 + 32 + 32, 8 + 32 + 32 + 32 + 16);
    const balanceHandle = readU128LE(encryptedBalance);
    console.log(`🔐 Encrypted balance handle: ${balanceHandle}`);

    if (balanceHandle === 0n) {
        console.error("\n❌ Vault has zero balance! Need to bridge tokens TO Solana first.");
        return;
    }

    // Amount to bridge back
    const amountToBridge = 5n;
    console.log(`\n📤 Amount to bridge back: ${amountToBridge} tokens`);

    // Create encrypted amount ciphertext
    let encryptedAmount: Buffer;
    if (encryptValue) {
        const encrypted = await encryptValue(amountToBridge);
        encryptedAmount = Buffer.from(encrypted, 'hex');
        console.log(`✅ Encrypted with Inco SDK (${encryptedAmount.length} bytes)`);
    } else {
        encryptedAmount = createTestCiphertext(amountToBridge);
        console.log(`⚠️ Test ciphertext (${encryptedAmount.length} bytes)`);
    }

    // Convert destination EVM to bytes
    const destinationBytes = Buffer.from(DESTINATION_EVM.slice(2), "hex");

    // === STEP 1: User signs message off-chain ===
    console.log("\n─── Step 1: User Signs Message Off-Chain ───\n");

    const nonce = Date.now();
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour

    // Create message to sign
    const messageHash = crypto.createHash("sha256")
        .update("relay_bridge_confidential_out")
        .update(vaultPda.toBuffer())
        .update(crypto.createHash("sha256").update(encryptedAmount).digest())
        .update(destinationBytes)
        .update(Buffer.from(nonce.toString()))
        .update(Buffer.from(deadline.toString()))
        .digest();

    console.log(`📝 Message hash: ${messageHash.toString("hex").slice(0, 40)}...`);

    // Sign with Ed25519
    const signature = nacl.sign.detached(messageHash, user.secretKey);
    console.log(`✅ Signature: ${Buffer.from(signature).toString("hex").slice(0, 40)}...`);

    // === STEP 2: Build relay_bridge_confidential_out instruction ===
    console.log("\n─── Step 2: Build Relay Instruction ───\n");

    const discriminator = computeDiscriminator("global:relay_bridge_confidential_out");
    console.log(`🔧 Discriminator: ${Buffer.from(discriminator).toString("hex")}`);

    // Instruction data:
    // - discriminator (8)
    // - encrypted_amount (Vec<u8>: 4-byte length + bytes)
    // - destination_evm ([u8; 20])
    // - vault_owner (Pubkey, 32 bytes)
    // - message_signature ([u8; 64])
    // - nonce (u64, 8 bytes)
    // - deadline (i64, 8 bytes)

    const encryptedAmountLen = Buffer.alloc(4);
    encryptedAmountLen.writeUInt32LE(encryptedAmount.length, 0);

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce), 0);

    const deadlineBuf = Buffer.alloc(8);
    deadlineBuf.writeBigInt64LE(BigInt(deadline), 0);

    const instructionData = Buffer.concat([
        Buffer.from(discriminator),
        encryptedAmountLen,
        encryptedAmount,
        destinationBytes,
        user.publicKey.toBuffer(),
        Buffer.from(signature),
        nonceBuf,
        deadlineBuf,
    ]);

    console.log(`📦 Instruction data: ${instructionData.length} bytes`);

    // Accounts for relay_bridge_confidential_out:
    // 1. relayer (signer, mut) - pays for TX, visible on-chain
    // 2. bridge (PDA)
    // 3. vault (mut)
    // 4. inco_lightning_program
    // 5. system_program

    const accounts = [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: bridgePda, isSigner: false, isWritable: false },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const relayIx = new TransactionInstruction({
        keys: accounts,
        programId: BRIDGE_PROGRAM_ID,
        data: instructionData,
    });

    // === STEP 3: Relayer submits transaction ===
    console.log("\n─── Step 3: Relayer Submits Transaction ───\n");
    console.log("🔒 PRIVACY: Only relayer signs - user address NOT in signers!");

    try {
        const tx = new Transaction().add(relayIx);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = relayer.publicKey;

        // Only relayer signs! User's address is not a signer.
        const sig = await sendAndConfirmTransaction(connection, tx, [relayer], {
            commitment: "confirmed",
        });

        console.log(`\n✅ Transaction confirmed!`);
        console.log(`   Signature: ${sig}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

        // Verify privacy
        console.log("\n─── Privacy Verification ───\n");
        console.log(`🔒 Transaction signed by: ${relayer.publicKey.toBase58()}`);
        console.log(`🔒 User's address:        ${user.publicKey.toBase58()}`);
        if (relayer.publicKey.equals(user.publicKey)) {
            console.log("⚠️  Same key (demo mode) - in production, user is hidden!");
        } else {
            console.log("✅ User's address NOT visible as a signer!");
        }

        console.log("\n📋 To relay to Base, run:");
        console.log(`   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts ${sig}`);

    } catch (e: any) {
        console.error(`\n❌ Failed: ${e.message}`);

        if (e.logs) {
            console.log("\nProgram logs:");
            for (const log of e.logs) {
                console.log(`   ${log}`);
            }
        }
    }
}

function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

function computeDiscriminator(name: string): Uint8Array {
    const hash = crypto.createHash("sha256");
    hash.update(name);
    return new Uint8Array(hash.digest().subarray(0, 8));
}

function createTestCiphertext(amount: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let remaining = amount;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}

main().catch(console.error);
