#!/usr/bin/env bun
/**
 * Test Encrypt and Decrypt Flow
 * 
 * Creates a fresh encrypted value and tries to decrypt it
 */

import { encryptValue } from '@inco/solana-sdk';
import { decrypt } from '@inco/solana-sdk/attested-decrypt';
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as nacl from 'tweetnacl';

// Load wallet
const keypairPath = path.join(process.env.HOME || '', '.config/solana/id.json');
const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));

console.log('=== Test Encrypt/Decrypt Flow ===\n');
console.log('Wallet:', wallet.publicKey.toBase58());

async function main() {
    // Encrypt a test value using the SDK
    console.log('\n📝 Encrypting value 42...');
    const result = encryptValue(42n, 'uint128', wallet.publicKey.toBase58());
    console.log('   Handle:', result.handle.toString());
    console.log('   Ciphertext length:', result.ciphertext.length);

    // Try to decrypt immediately
    console.log('\n🔓 Attempting to decrypt...');
    
    try {
        const decryptResult = await decrypt([result.handle.toString()], {
            address: wallet.publicKey,
            signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, wallet.secretKey),
        });
        
        console.log('\n✅ Decrypted:', decryptResult.plaintexts[0]);
    } catch (e: any) {
        console.log('\n❌ Decrypt failed:', e.message);
        
        // The handle was just created locally, not submitted to chain
        // This is expected - handles only exist after on-chain operations
        console.log('\n💡 Note: Client-side encrypted handles only become');
        console.log('   decryptable after being submitted to a contract');
        console.log('   via a Solana transaction (new_euint128, as_euint128, etc.)');
    }
}

main().catch(console.error);
