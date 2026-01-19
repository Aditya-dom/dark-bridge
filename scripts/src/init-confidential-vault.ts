#!/usr/bin/env bun
/**
 * Initialize Confidential Vault on Solana
 * 
 * Creates a ConfidentialVault for a user to receive encrypted tokens.
 * 
 * Usage:
 *   bun run src/init-confidential-vault.ts <OWNER_PUBKEY> <TOKEN_MINT_PUBKEY>
 */

import { Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

import { CONFIGS } from "@internal/constants";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID  
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

async function initializeVault(ownerPubkey: PublicKey, tokenMintPubkey: PublicKey) {
    console.log("\n=== Initialize Confidential Vault ===");
    console.log(`Owner: ${ownerPubkey.toBase58()}`);
    console.log(`Token Mint: ${tokenMintPubkey.toBase58()}`);

    // Load payer keypair
    const payerPath = os.homedir() + "/.config/solana/id.json";
    const payerKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf-8")))
    );
    console.log(`Payer: ${payerKeypair.publicKey.toBase58()}`);

    // Check if payer is owner
    if (!payerKeypair.publicKey.equals(ownerPubkey)) {
        console.error("\n⚠️  Warning: Payer is not the owner!");
        console.error("The owner must sign the initialization transaction.");
        console.error("Make sure the Solana CLI is configured with the owner's keypair.");
    }

    // Derive vault PDA
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("confidential_vault"),
            ownerPubkey.toBuffer(),
            tokenMintPubkey.toBuffer(),
        ],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Vault PDA: ${vaultPda.toBase58()}`);

    // Derive bridge authority PDA
    const [bridgeAuthority, _] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_authority")],
        BRIDGE_PROGRAM_ID
    );
    console.log(`Bridge Authority: ${bridgeAuthority.toBase58()}`);

    // Check if vault already exists
    const connection = new Connection(config.solana.rpcUrl, "confirmed");
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    
    if (vaultInfo) {
        console.log("\n✅ Vault already exists!");
        console.log(`   Data length: ${vaultInfo.data.length} bytes`);
        return vaultPda;
    }

    // Build initialize_confidential_vault instruction
    // Anchor discriminator for "initialize_confidential_vault"
    const discriminator = crypto.createHash("sha256")
        .update("global:initialize_confidential_vault")
        .digest()
        .slice(0, 8);

    // No additional instruction data needed for initialize_confidential_vault
    const instructionData = discriminator;

    console.log(`\n📝 Building initialize_confidential_vault instruction:`);
    console.log(`   Discriminator: ${discriminator.toString("hex")}`);

    // Accounts in order:
    // 1. owner (signer, mutable) - pays for account creation
    // 2. token_mint (readonly)
    // 3. bridge_authority (readonly)
    // 4. vault (init, mutable)
    // 5. inco_lightning_program (readonly)
    // 6. system_program (readonly)
    const instruction = new TransactionInstruction({
        programId: BRIDGE_PROGRAM_ID,
        keys: [
            { pubkey: ownerPubkey, isSigner: true, isWritable: true },           // owner
            { pubkey: tokenMintPubkey, isSigner: false, isWritable: false },     // token_mint
            { pubkey: bridgeAuthority, isSigner: false, isWritable: false },     // bridge_authority
            { pubkey: vaultPda, isSigner: false, isWritable: true },             // vault
            { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },   // inco_lightning_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data: Buffer.from(instructionData),
    });

    console.log(`\n📤 Sending transaction...`);

    const tx = new Transaction().add(instruction);
    
    try {
        const signature = await sendAndConfirmTransaction(
            connection,
            tx,
            [payerKeypair],
            { commitment: "confirmed" }
        );
        
        console.log(`\n✅ Vault initialized successfully!`);
        console.log(`   Signature: ${signature}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
        console.log(`\n   Vault PDA: ${vaultPda.toBase58()}`);
        
        return vaultPda;
    } catch (error: any) {
        console.error(`\n❌ Transaction failed: ${error.message}`);
        if (error.logs) {
            console.error(`   Logs:`);
            error.logs.forEach((log: string) => console.error(`      ${log}`));
        }
        throw error;
    }
}

async function main() {
    const ownerArg = process.argv[2];
    const tokenMintArg = process.argv[3];

    if (!ownerArg || !tokenMintArg) {
        console.log("\nUsage:");
        console.log("  bun run src/init-confidential-vault.ts <OWNER_PUBKEY> <TOKEN_MINT_PUBKEY>");
        console.log("\nExample:");
        console.log("  bun run src/init-confidential-vault.ts 14dJMJ5atWDe2LCKxMnKmC94z7uU1uBtvuhAXhUamP1z 14dJMJ5atWDe2LCKxMnKmC94z7uU1uBtvuhAXhUamP1z");
        return;
    }

    const ownerPubkey = new PublicKey(ownerArg);
    const tokenMintPubkey = new PublicKey(tokenMintArg);

    await initializeVault(ownerPubkey, tokenMintPubkey);
}

main().catch(console.error);
