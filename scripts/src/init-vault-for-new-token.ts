#!/usr/bin/env bun
/**
 * Initialize Confidential Vault for New Token
 * 
 * This script initializes a confidential vault on Solana for the new DARK token.
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

// --- Configuration ---
const SOLANA_RPC = "https://api.devnet.solana.com";

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// The token mint (derived from remote token on Base)
const TOKEN_MINT = new PublicKey("GXo4sG2pUdJXx8HGaGb1BashYpr9h8XFbNMsm57ffv6Z");

async function main() {
    console.log("\n=== Initialize Confidential Vault for New Token ===\n");

    // Load Solana keypair
    const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const payer = Keypair.fromSecretKey(new Uint8Array(keypairData));

    console.log(`Payer: ${payer.publicKey.toBase58()}`);
    console.log(`Token Mint: ${TOKEN_MINT.toBase58()}`);

    // Connect to Solana
    const connection = new Connection(SOLANA_RPC, "confirmed");

    // Derive vault PDA (same order as the relayer uses)
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            payer.publicKey.toBuffer(),
            TOKEN_MINT.toBuffer(),
        ],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Vault PDA: ${vaultPda.toBase58()}`);

    // Check if vault already exists
    const vaultAccount = await connection.getAccountInfo(vaultPda);
    if (vaultAccount) {
        console.log("\n✅ Vault already exists!");
        console.log(`   Data length: ${vaultAccount.data.length} bytes`);
        return;
    }

    // Derive other PDAs
    const [bridgeState] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Bridge State: ${bridgeState.toBase58()}`);

    // Derive bridge authority PDA
    const [bridgeAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_authority")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Bridge Authority: ${bridgeAuthority.toBase58()}`);

    // Build instruction for initialize_confidential_vault
    // The instruction discriminator for "initialize_confidential_vault" in Anchor
    const discriminator = Buffer.from([
        0x86, 0x3f, 0x0c, 0xfe, 0x2e, 0x89, 0x95, 0x06  // Calculated from sha256("global:initialize_confidential_vault")[0:8]
    ]);

    // We need to compute the actual discriminator
    const crypto = await import("crypto");
    const hash = crypto.createHash("sha256");
    hash.update("global:initialize_confidential_vault");
    const fullHash = hash.digest();
    const actualDiscriminator = fullHash.slice(0, 8);
    console.log(`Instruction discriminator: ${Buffer.from(actualDiscriminator).toString("hex")}`);

    // Build accounts for the instruction in the order defined in the Anchor struct:
    // owner, token_mint, bridge_authority, vault, inco_lightning_program, system_program
    const accounts = [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },          // owner
        { pubkey: TOKEN_MINT, isSigner: false, isWritable: false },             // token_mint
        { pubkey: bridgeAuthority, isSigner: false, isWritable: false },        // bridge_authority
        { pubkey: vaultPda, isSigner: false, isWritable: true },                // vault
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },      // inco_lightning_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ];

    const initVaultIx = new TransactionInstruction({
        keys: accounts,
        programId: BRIDGE_PROGRAM_ID,
        data: Buffer.from(actualDiscriminator),
    });

    console.log("\n📤 Sending initialize_confidential_vault transaction...");

    try {
        const tx = new Transaction().add(initVaultIx);
        const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
            commitment: "confirmed",
        });

        console.log(`\n✅ Vault initialized!`);
        console.log(`   Signature: ${sig}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (e: any) {
        console.error(`\n❌ Failed to initialize vault: ${e.message}`);
        
        // Try to get more details
        if (e.logs) {
            console.log("\nProgram logs:");
            for (const log of e.logs) {
                console.log(`   ${log}`);
            }
        }
    }
}

main().catch(console.error);
