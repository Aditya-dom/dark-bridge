#!/usr/bin/env bun
/**
 * Grant Handle Access
 * 
 * Calls the grant_handle_access instruction to allow the user to decrypt a handle.
 * This is called AFTER bridge_confidential_out to grant ACL on the emitted handle.
 */

import { 
    Connection, 
    PublicKey, 
    Keypair, 
    SystemProgram, 
    TransactionInstruction, 
    Transaction, 
    sendAndConfirmTransaction 
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Program IDs
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// Connection
const connection = new Connection("https://api.devnet.solana.com", "confirmed");

// Load wallet
const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

function computeDiscriminator(name: string): Uint8Array {
    const hash = crypto.createHash("sha256");
    hash.update(name);
    return new Uint8Array(hash.digest().subarray(0, 8));
}

function handleToBuffer(handle: bigint): Buffer {
    const buffer = Buffer.alloc(16);
    let remaining = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return buffer;
}

function deriveAllowancePDA(handle: bigint, allowedAddress: PublicKey): [PublicKey, number] {
    // The allowance PDA is derived from: [handle_bytes_le, allowed_address]
    const handleBuffer = handleToBuffer(handle);
    
    return PublicKey.findProgramAddressSync(
        [handleBuffer, allowedAddress.toBuffer()],
        INCO_LIGHTNING_ID
    );
}

async function grantHandleAccess(handle: bigint) {
    console.log("=== Grant Handle Access ===\n");
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    console.log(`Handle: ${handle}`);
    console.log(`Handle hex: 0x${handle.toString(16)}`);
    
    // Derive the allowance PDA
    const [allowancePDA, bump] = deriveAllowancePDA(handle, wallet.publicKey);
    console.log(`\nAllowance PDA: ${allowancePDA.toBase58()}`);
    console.log(`Allowance PDA bump: ${bump}`);
    
    // Build instruction
    const discriminator = computeDiscriminator("global:grant_handle_access");
    console.log(`Discriminator: ${Buffer.from(discriminator).toString("hex")}`);
    
    // Instruction data: discriminator + handle (u128 little-endian)
    const handleBuffer = handleToBuffer(handle);
    const instructionData = Buffer.concat([
        Buffer.from(discriminator),
        handleBuffer,
    ]);
    
    console.log(`\nInstruction data: ${instructionData.toString("hex")}`);
    
    // Accounts:
    // 1. owner (signer, mut)
    // 2. inco_lightning_program
    // 3. system_program
    // + remaining_accounts:
    //   [0] allowance_account (writable)
    //   [1] allowed_address (owner pubkey)
    const accounts = [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        // Remaining accounts
        { pubkey: allowancePDA, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
    ];
    
    const instruction = new TransactionInstruction({
        keys: accounts,
        programId: BRIDGE_PROGRAM_ID,
        data: instructionData,
    });
    
    console.log("\n📤 Sending grant_handle_access transaction...");
    
    try {
        const tx = new Transaction().add(instruction);
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.feePayer = wallet.publicKey;
        
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
            commitment: "confirmed",
        });
        
        console.log(`\n✅ Transaction confirmed!`);
        console.log(`   Signature: ${sig}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
        
        return sig;
        
    } catch (e: any) {
        console.error(`\n❌ Failed: ${e.message}`);
        
        if (e.logs) {
            console.log("\nProgram logs:");
            for (const log of e.logs) {
                console.log(`   ${log}`);
            }
        }
        
        throw e;
    }
}

async function main() {
    const handleArg = process.argv[2];
    
    if (!handleArg) {
        console.log("Usage: bun run src/grant-handle-access.ts <HANDLE>");
        console.log("\nExample:");
        console.log("  bun run src/grant-handle-access.ts 171523420492091030202552582106436067856");
        return;
    }
    
    const handle = BigInt(handleArg);
    await grantHandleAccess(handle);
    
    console.log("\n\n📋 Now try attested decrypt:");
    console.log("   bun run src/test-official-decrypt.ts");
}

main().catch(console.error);
