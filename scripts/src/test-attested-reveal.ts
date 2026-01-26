#!/usr/bin/env npx tsx
/**
 * Test script for Inco decryption methods
 * 
 * Per SKILL.md:
 * - e.reveal(handle) marks handle for PUBLIC decryption (on-chain, IRREVERSIBLE)
 * - attestedReveal() can be called by ANYONE for revealed handles (no signature needed)
 * - attestedDecrypt() requires the handle owner's wallet signature
 * 
 * The contract calls e.reveal(amount), so attestedReveal should work.
 * If it fails (404), the covalidator may not support it yet.
 */

// Set TLS bypass before any imports
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Lightning } from "@inco/js/lite";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const HANDLE = "0xe7dda47431089b54bef733118464a1635cf6916f537f8f85a8c6fa31f3000800";
// User who initiated the bridge (owner of the handle)
const USER_PRIVATE_KEY = "0xac034c391ccf93f312693307d0a76d77c38b0da414734e0ad9ab197118697c63";

// Manual retry wrapper for when SDK retries aren't enough
async function retryWithDelay<T>(
    fn: () => Promise<T>, 
    maxRetries: number, 
    delayMs: number,
    description: string
): Promise<T> {
    let lastError: Error | null = null;
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`   Attempt ${i + 1}/${maxRetries}...`);
            return await fn();
        } catch (error: any) {
            lastError = error;
            console.log(`   Failed: ${error.message}`);
            if (i < maxRetries - 1) {
                console.log(`   Waiting ${delayMs / 1000}s before retry...`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastError;
}

async function main() {
    console.log("=== Testing Inco Decryption Methods ===");
    console.log(`Handle: ${HANDLE}`);
    
    // Create wallet client with the OWNER's private key (required for attestedDecrypt)
    const account = privateKeyToAccount(USER_PRIVATE_KEY as `0x${string}`);
    console.log(`Owner Wallet: ${account.address}`);
    
    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });
    
    // Try both devnet and testnet peppers
    const peppers = ['devnet', 'testnet'] as const;
    
    for (const pepper of peppers) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Trying pepper: ${pepper}`);
        console.log('='.repeat(50));
        
        try {
            const zap = await Lightning.latest(pepper, 84532);
            console.log(`Chain ID: ${zap.chainId}`);
            console.log(`Executor: ${zap.executorAddress}`);
            
            const backoffConfig = {
                maxRetries: 3,
                baseDelayInMs: 2000,
                backoffFactor: 1.5,
            };
            
            // Try attestedReveal
            console.log("\n--- Method 1: attestedReveal ---");
            try {
                const results = await zap.attestedReveal([HANDLE], backoffConfig);
                console.log(`✅ attestedReveal succeeded!`);
                console.log("Results:", JSON.stringify(results, (_, v) => 
                    typeof v === 'bigint' ? v.toString() : v, 2));
                return; // Success!
            } catch (e: any) {
                console.log(`❌ Failed: ${e.message}`);
            }
            
            // Try attestedDecrypt
            console.log("\n--- Method 2: attestedDecrypt ---");
            try {
                const results = await zap.attestedDecrypt(walletClient, [HANDLE], backoffConfig);
                console.log(`✅ attestedDecrypt succeeded!`);
                console.log("Results:", JSON.stringify(results, (_, v) => 
                    typeof v === 'bigint' ? v.toString() : v, 2));
                return; // Success!
            } catch (e: any) {
                console.log(`❌ Failed: ${e.message}`);
            }
            
        } catch (error: any) {
            console.error(`Error with ${pepper}: ${error.message}`);
        }
    }
    
    console.log("\n❌ All methods failed. Covalidator may not support decryption.");
}

main().catch(console.error);