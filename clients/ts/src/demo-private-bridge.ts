/**
 * Privacy Bridge Demo Script
 * 
 * Demonstrates end-to-end private bridging between Base Sepolia and Solana Devnet
 * using Inco Lightning for encrypted transfers.
 * 
 * Usage: npx ts-node src/demo-private-bridge.ts
 */

import { PrivacyBridgeClient, PrivateBridgeConfig } from './privacy-client';
import { createWalletClient, http, parseEther } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';

// Configuration - UPDATE THESE VALUES
const PRIVATE_KEY = process.env.PRIVATE_KEY || '0x...';
const SOLANA_KEYPAIR_PATH = process.env.SOLANA_KEYPAIR || '~/.config/solana/id.json';

const CONFIG: PrivateBridgeConfig = {
    // Base Sepolia
    baseRpcUrl: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
    confidentialBridgeAddress: '0x0000000000000000000000000000000000000000' as const, // TODO: Update after deployment
    confidentialTokenAddress: '0x0000000000000000000000000000000000000000' as const, // TODO: Update after deployment

    // Solana Devnet
    solanaRpcUrl: process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    bridgeProgramId: new PublicKey('EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9'),

    // Inco
    incoEnvironment: 'testnet',
};

async function main() {
    console.log('🔐 Privacy Bridge Demo\n');
    console.log('========================\n');

    // Initialize client
    const client = new PrivacyBridgeClient(CONFIG);
    console.log('✅ Initialized PrivacyBridgeClient\n');

    // Setup Base wallet
    const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(CONFIG.baseRpcUrl),
    });
    console.log(`📍 Base wallet: ${account.address}`);

    // Setup Solana wallet
    const solanaKeypair = Keypair.generate(); // For demo, use actual keypair in production
    console.log(`📍 Solana wallet: ${solanaKeypair.publicKey.toBase58()}\n`);

    // Demo 1: Encrypt amount for Base
    console.log('--- Demo 1: Base Encryption ---');
    const amount = parseEther('1.0');
    console.log(`Amount to encrypt: ${amount} (1 token)`);

    try {
        const encrypted = await client.encryptForBase(amount, account.address);
        console.log(`Encrypted ciphertext: ${encrypted.slice(0, 50)}...`);
    } catch (e: any) {
        console.log(`Encryption requires Inco testnet: ${e.message}`);
    }

    // Demo 2: Encrypt amount for Solana
    console.log('\n--- Demo 2: Solana Encryption ---');
    try {
        const solanaEncrypted = await client.encryptForSolana(
            BigInt('1000000000'), // 1 token with 9 decimals
            solanaKeypair.publicKey
        );
        console.log(`Encrypted buffer length: ${solanaEncrypted.length} bytes`);
    } catch (e: any) {
        console.log(`Solana encryption requires @inco/solana-sdk: ${e.message}`);
    }

    // Demo 3: Show bridge flow (without actual execution)
    console.log('\n--- Demo 3: Bridge Flow ---');
    console.log('Base → Solana Private Bridge:');
    console.log('  1. User encrypts amount using Inco JS SDK');
    console.log('  2. Calls ConfidentialBridge.bridgePrivateToSolana()');
    console.log('  3. Burns from ConfidentialCrossChainERC20 (encrypted)');
    console.log('  4. Emits ConfidentialBridgeInitiated event');
    console.log('  5. Relayer picks up and calls Solana bridge');
    console.log('  6. Mints to Solana ConfidentialVault (encrypted)');

    console.log('\nSolana → Base Private Bridge:');
    console.log('  1. User encrypts amount using @inco/solana-sdk');
    console.log('  2. Calls bridge.bridge_confidential_out()');
    console.log('  3. Burns from ConfidentialVault (encrypted)');
    console.log('  4. Emits ConfidentialBridgeOutEvent');
    console.log('  5. Relayer picks up and calls Base bridge');
    console.log('  6. Mints to ConfidentialCrossChainERC20 (encrypted)');

    console.log('\n========================');
    console.log('🎉 Demo complete!\n');
    console.log('To run actual transfers, deploy contracts and update CONFIG addresses.');
}

main().catch(console.error);
