#!/usr/bin/env bun
/**
 * Test Attested Decrypt Flow
 * 
 * This simulates what the UI would do:
 * 1. Load the Solana wallet
 * 2. Sign the handle to prove ownership
 * 3. Call Inco covalidator for attested decrypt
 * 4. Get the real plaintext amount
 */

import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import nacl from "tweetnacl";

// Inco covalidator endpoint
const INCO_ATTESTED_DECRYPT_ENDPOINT = 
    "https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/getDecryptAttested";

// The handle from our previous bridge transaction
const HANDLE_FROM_SOLANA_TX = BigInt("171523420492091030202552582106436067856");

// Load wallet
const keypairPath = path.join(process.env.HOME || "", ".config/solana/id.json");
const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

console.log("=== Test Attested Decrypt Flow ===\n");
console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
console.log(`Handle: ${HANDLE_FROM_SOLANA_TX}`);

async function testAttestedDecrypt() {
    const handle = HANDLE_FROM_SOLANA_TX;
    const address = wallet.publicKey.toBase58();
    
    // Step 1: Sign the handle (this is what the UI wallet would do)
    console.log("\n📝 Step 1: Signing handle to prove ownership...");
    
    const handleStr = handle.toString();
    const messageBytes = new TextEncoder().encode(handleStr);
    
    // Sign with nacl (simulating wallet.signMessage)
    const signatureBytes = nacl.sign.detached(messageBytes, wallet.secretKey);
    const signature = bs58.encode(signatureBytes);
    
    console.log(`   Message: "${handleStr}"`);
    console.log(`   Signature: ${signature.slice(0, 30)}...`);
    
    // Step 2: Call Inco covalidator API
    console.log("\n📝 Step 2: Calling Inco covalidator for attested decrypt...");
    console.log(`   Endpoint: ${INCO_ATTESTED_DECRYPT_ENDPOINT}`);
    
    const requestBody = {
        handle: handleStr,
        address: address,
        signature: signature,
    };
    
    console.log(`   Request body: ${JSON.stringify(requestBody, null, 2)}`);
    
    try {
        const response = await fetch(INCO_ATTESTED_DECRYPT_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });
        
        console.log(`   Response status: ${response.status}`);
        
        const responseText = await response.text();
        console.log(`   Response body: ${responseText}`);
        
        if (response.ok) {
            const data = JSON.parse(responseText);
            console.log("\n✅ Attested decrypt successful!");
            console.log(`   Plaintext amount: ${data.plaintext}`);
            console.log(`   Covalidator signature: ${data.signature?.slice(0, 50)}...`);
            return BigInt(data.plaintext);
        } else {
            console.log("\n❌ Attested decrypt failed");
            return null;
        }
    } catch (error: any) {
        console.log(`\n❌ Error: ${error.message}`);
        return null;
    }
}

// Also try a few alternative endpoints/formats
async function tryAlternativeFormats() {
    const handle = HANDLE_FROM_SOLANA_TX;
    const address = wallet.publicKey.toBase58();
    
    console.log("\n\n=== Trying Alternative Formats ===\n");
    
    // Format 1: Handle as hex
    const handleHex = handle.toString(16);
    console.log(`Handle as hex: 0x${handleHex}`);
    
    // Format 2: Handle as bytes
    const handleBuffer = Buffer.alloc(16);
    let remaining = handle;
    for (let i = 0; i < 16; i++) {
        handleBuffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    console.log(`Handle as bytes: ${handleBuffer.toString('hex')}`);
    
    // Try the decrypt endpoint without signature (might work for "allow anyone" handles)
    console.log("\n📝 Trying simple decrypt endpoint...");
    
    const endpoints = [
        `https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/decrypt`,
        `https://api.solana-devnet.alpha.devnet.inco.org/decrypt`,
    ];
    
    for (const endpoint of endpoints) {
        console.log(`\n   Trying: ${endpoint}`);
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handle: handle.toString() }),
            });
            console.log(`   Status: ${response.status}`);
            const text = await response.text();
            console.log(`   Response: ${text.slice(0, 200)}`);
        } catch (e: any) {
            console.log(`   Error: ${e.message}`);
        }
    }
}

async function main() {
    const plaintext = await testAttestedDecrypt();
    
    if (!plaintext) {
        await tryAlternativeFormats();
    }
    
    console.log("\n\n=== Summary ===");
    if (plaintext) {
        console.log(`✅ Successfully decrypted: ${plaintext} tokens`);
        console.log("\nThis means in the UI, users CAN sign to decrypt their amounts!");
    } else {
        console.log("⚠️ Attested decrypt requires proper ACL permissions on the handle.");
        console.log("\nPossible reasons:");
        console.log("1. Handle doesn't have 'allow' for our address");
        console.log("2. Handle was created by bridge program, not user");
        console.log("3. API format might be different");
        console.log("\nFor UI to work, the bridge_confidential_out instruction needs to");
        console.log("grant 'allow' permission to the user's address on the handle.");
    }
}

main().catch(console.error);
