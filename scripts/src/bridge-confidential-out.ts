#!/usr/bin/env bun
/**
 * Test Bridge Confidential Out (Solana → Base)
 * 
 * This script:
 * 1. Checks the vault balance
 * 2. Encrypts an amount using Inco
 * 3. Calls bridge_confidential_out on Solana
 * 4. Outputs the transaction signature for the relayer
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
import * as fs from "fs";
import * as path from "path";

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
    console.log("\n=== Test Bridge Confidential Out (Solana → Base) ===\n");

    // Load Solana keypair
    const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const payer = Keypair.fromSecretKey(new Uint8Array(keypairData));

    console.log(`Payer: ${payer.publicKey.toBase58()}`);
    console.log(`Token Mint: ${TOKEN_MINT.toBase58()}`);
    console.log(`Destination EVM: ${DESTINATION_EVM}`);

    // Connect to Solana
    const connection = new Connection(SOLANA_RPC, "confirmed");

    // Check SOL balance
    const balance = await connection.getBalance(payer.publicKey);
    console.log(`SOL Balance: ${balance / 1e9} SOL`);

    // Derive vault PDA
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            payer.publicKey.toBuffer(),
            TOKEN_MINT.toBuffer(),
        ],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Vault PDA: ${vaultPda.toBase58()}`);

    // Check if vault exists
    const vaultAccount = await connection.getAccountInfo(vaultPda);
    if (!vaultAccount) {
        console.error("\n❌ Vault does not exist! Initialize it first.");
        return;
    }
    console.log(`Vault exists with ${vaultAccount.data.length} bytes`);

    // Parse vault to check balance handle
    // Vault structure: discriminator (8) + owner (32) + token_mint (32) + bridge_authority (32) + encrypted_balance (16) + bump (1)
    const vaultData = vaultAccount.data;
    const encryptedBalance = vaultData.subarray(8 + 32 + 32 + 32, 8 + 32 + 32 + 32 + 16);
    const balanceHandle = readU128LE(encryptedBalance);
    console.log(`Current encrypted balance handle: ${balanceHandle}`);

    if (balanceHandle === 0n) {
        console.error("\n❌ Vault has zero balance! Need to bridge tokens TO Solana first.");
        console.log("Run: bun run src/execute-real-tx.ts to bridge from Base → Solana");
        return;
    }

    // Amount to bridge back (we'll bridge 5 tokens)
    const amountToBridge = 5n;
    console.log(`\nAmount to bridge back: ${amountToBridge} tokens`);

    // Create encrypted amount ciphertext
    let encryptedAmount: Buffer;
    if (encryptValue) {
        // Use real Inco encryption
        const encrypted = await encryptValue(amountToBridge);
        encryptedAmount = Buffer.from(encrypted, 'hex');
        console.log(`Encrypted with Inco SDK (${encryptedAmount.length} bytes)`);
    } else {
        // For testing, create a minimal ciphertext
        encryptedAmount = createTestCiphertext(amountToBridge);
        console.log(`Test ciphertext (${encryptedAmount.length} bytes)`);
    }
    console.log(`Ciphertext: ${encryptedAmount.toString("hex").slice(0, 40)}...`);

    // Convert destination EVM to bytes
    const destinationBytes = Buffer.from(DESTINATION_EVM.slice(2), "hex");
    console.log(`Destination bytes: ${destinationBytes.toString("hex")}`);

    // Build instruction
    const discriminator = computeDiscriminator("global:bridge_confidential_out");
    console.log(`Instruction discriminator: ${Buffer.from(discriminator).toString("hex")}`);

    // Instruction data: discriminator + encrypted_amount (Vec<u8>) + destination_evm ([u8; 20])
    // Vec<u8> is encoded as: 4-byte length (little-endian) + bytes
    const encryptedAmountLen = Buffer.alloc(4);
    encryptedAmountLen.writeUInt32LE(encryptedAmount.length, 0);

    const instructionData = Buffer.concat([
        Buffer.from(discriminator),
        encryptedAmountLen,
        encryptedAmount,
        destinationBytes,
    ]);

    // Accounts for bridge_confidential_out:
    // 1. owner (signer, mut)
    // 2. vault (mut)
    // 3. inco_lightning_program
    // 4. system_program
    // 
    // NOTE: We skip remaining_accounts for allow() calls because:
    // - The allowance PDA is derived from handle + allowed_address
    // - We don't know the handle until AFTER encrypted operations run
    // - This is a chicken-and-egg problem in Inco Lightning's design
    // 
    // The handle should still be decryptable by the signer who created it
    // via implicit ACL (signer-created handles are accessible to signer)
    
    const accounts = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const bridgeOutIx = new TransactionInstruction({
        keys: accounts,
        programId: BRIDGE_PROGRAM_ID,
        data: instructionData,
    });

    console.log("\n📤 Sending bridge_confidential_out transaction...");

    try {
        const tx = new Transaction().add(bridgeOutIx);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = payer.publicKey;

        const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
            commitment: "confirmed",
        });

        console.log(`\n✅ Transaction confirmed!`);
        console.log(`   Signature: ${sig}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

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
    const crypto = require("crypto");
    const hash = crypto.createHash("sha256");
    hash.update(name);
    return new Uint8Array(hash.digest().subarray(0, 8));
}

/**
 * Create a test ciphertext for the amount.
 * In production, this would use @inco/solana-sdk
 */
function createTestCiphertext(amount: bigint): Buffer {
    // Create a simple ciphertext structure
    // Format: amount as 16-byte little-endian
    const buffer = Buffer.alloc(16);
    let remaining = amount;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}

main().catch(console.error);
