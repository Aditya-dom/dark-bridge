#!/usr/bin/env bun
/**
 * Test Official Inco SDK Decrypt
 * 
 * Uses the official @inco/solana-sdk/attested-decrypt module
 */

import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";

// Try to import the official SDK
console.log("=== Test Official Inco SDK Decrypt ===\n");

// Load wallet
const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

// The handle from the bridge event (NewEuint128)
const HANDLE = BigInt("181344707879741550063268618100736008385");
console.log(`Handle: ${HANDLE}`);

async function testOfficialDecrypt() {
    try {
        // Dynamic import of the official SDK
        const { decrypt } = await import("@inco/solana-sdk/attested-decrypt");
        
        console.log("\n✅ Loaded @inco/solana-sdk/attested-decrypt");
        
        // Create a wallet adapter-like interface
        const walletAdapter = {
            publicKey: wallet.publicKey,
            signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
                const nacl = await import("tweetnacl");
                return nacl.sign.detached(message, wallet.secretKey);
            },
        };
        
        console.log("\n📝 Calling decrypt() with official SDK...");
        console.log(`   Handle: ${HANDLE}`);
        console.log(`   Address: ${wallet.publicKey.toBase58()}`);
        
        // Convert BigInt to the format the SDK expects
        // The SDK might expect hex string or number
        const handleStr = HANDLE.toString();
        
        const result = await decrypt([handleStr], {
            address: wallet.publicKey,
            signMessage: walletAdapter.signMessage,
        });
        
        console.log("\n✅ Decrypt succeeded!");
        console.log(`   Plaintext: ${result.plaintexts[0]}`);
        
        if (result.ed25519Instructions) {
            console.log(`   Has ed25519 instructions: ${result.ed25519Instructions.length}`);
        }
        
        return result.plaintexts[0];
        
    } catch (error: any) {
        console.log(`\n❌ Decrypt failed: ${error.message}`);
        
        if (error.stack) {
            console.log(`\nStack trace:\n${error.stack}`);
        }
        
        return null;
    }
}

async function testAlternativeApproach() {
    console.log("\n\n=== Alternative: Try encryptValue wrapper ===\n");
    
    try {
        // The SDK might have different export patterns
        const sdk = await import("@inco/solana-sdk");
        console.log("Available exports from @inco/solana-sdk:");
        console.log(Object.keys(sdk));
        
    } catch (e: any) {
        console.log(`Could not load @inco/solana-sdk: ${e.message}`);
    }
    
    try {
        const encryption = await import("@inco/solana-sdk/encryption");
        console.log("\nAvailable exports from @inco/solana-sdk/encryption:");
        console.log(Object.keys(encryption));
        
    } catch (e: any) {
        console.log(`Could not load encryption module: ${e.message}`);
    }
}

async function main() {
    const plaintext = await testOfficialDecrypt();
    
    if (!plaintext) {
        await testAlternativeApproach();
    }
    
    console.log("\n\n=== Summary ===");
    if (plaintext) {
        console.log(`✅ Successfully decrypted: ${plaintext}`);
    } else {
        console.log("❌ Decrypt failed - handle doesn't have ACL for this address");
        console.log("\nThe Inco Lightning `allow` instruction must be called to grant");
        console.log("decrypt permission to an address. This requires:");
        console.log("1. Knowing the handle value (created during TX)");
        console.log("2. Deriving the allowance PDA from: [handle_bytes, allowed_address]");
        console.log("3. Passing the allowance account as a remaining_account");
        console.log("\nThis is a chicken-and-egg problem for newly created handles.");
    }
}

main().catch(console.error);
