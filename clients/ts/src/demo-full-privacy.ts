/**
 * Demo: Fully Private Bridge Transfer
 * 
 * This script demonstrates a fully private cross-chain transfer where:
 * 1. Sender's identity is hidden (via relayer)
 * 2. Receiver's identity is hidden (via commitment/claim)
 * 3. Amount is hidden (via FHE encryption)
 * 
 * Usage: npx ts-node src/demo-full-privacy.ts
 */

import { createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { PrivacyRelayerClient, generateClaimSecret } from './privacy-relayer-client';
import { PublicKey } from '@solana/web3.js';

// Configuration (replace with your deployed addresses)
const CONFIG = {
    baseRpcUrl: process.env.BASE_RPC_URL || 'https://sepolia.base.org',
    confidentialBridgeAddress: process.env.CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}` || '0x0000000000000000000000000000000000000000',
    confidentialTokenAddress: process.env.CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}` || '0x0000000000000000000000000000000000000000',
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    bridgeProgramId: new PublicKey(process.env.BRIDGE_PROGRAM_ID || 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9'),
    relayerEndpoint: process.env.RELAYER_ENDPOINT || 'http://localhost:3000',
    incoEnvironment: 'testnet' as const,
};

async function main() {
    console.log('🔐 Fully Private Bridge Transfer Demo\n');
    console.log('=' .repeat(60));
    
    // ============================================================================
    // SETUP
    // ============================================================================
    
    // Sender's wallet (private key - in production, use secure key management)
    const senderPrivateKey = process.env.SENDER_PRIVATE_KEY as Hex;
    if (!senderPrivateKey) {
        console.log('⚠️  Set SENDER_PRIVATE_KEY environment variable to run demo');
        console.log('   Showing flow without actual transactions...\n');
    }
    
    // Initialize privacy client
    const client = new PrivacyRelayerClient(CONFIG);
    await client.init();
    console.log('✅ Privacy client initialized\n');
    
    // ============================================================================
    // STEP 1: SENDER GENERATES CLAIM SECRET
    // ============================================================================
    
    console.log('📝 Step 1: Generate Claim Secret');
    console.log('-'.repeat(40));
    
    const claimSecret = generateClaimSecret();
    console.log(`   Secret:     ${claimSecret.secret.slice(0, 20)}...`);
    console.log(`   Commitment: ${claimSecret.commitment.slice(0, 20)}...`);
    console.log(`   (Commitment = keccak256(Secret))\n`);
    
    // ============================================================================
    // STEP 2: SENDER SHARES SECRET WITH RECIPIENT (OFF-CHAIN!)
    // ============================================================================
    
    console.log('🤝 Step 2: Share Secret with Recipient');
    console.log('-'.repeat(40));
    console.log('   ⚠️  This happens OFF-CHAIN (encrypted message, in person, etc.)');
    console.log('   ⚠️  NEVER put the secret on-chain!\n');
    console.log(`   Sharing via: [encrypted email/signal/etc]`);
    console.log(`   Secret sent: ${claimSecret.secret.slice(0, 20)}...\n`);
    
    // ============================================================================
    // STEP 3: SENDER CREATES SIGNED REQUEST
    // ============================================================================
    
    console.log('✍️  Step 3: Sender Signs Request (Off-Chain)');
    console.log('-'.repeat(40));
    
    if (senderPrivateKey) {
        const account = privateKeyToAccount(senderPrivateKey);
        const walletClient = createWalletClient({
            account,
            chain: baseSepolia,
            transport: http(CONFIG.baseRpcUrl),
        });
        
        const amount = 1000000n; // 1 USDC (6 decimals)
        
        console.log(`   Sender:     ${account.address}`);
        console.log(`   Amount:     ${amount} (will be encrypted)`);
        console.log(`   Commitment: ${claimSecret.commitment.slice(0, 20)}...`);
        
        try {
            const request = await client.createPrivateBridgeRequest(
                amount,
                claimSecret.commitment,
                walletClient
            );
            
            console.log(`   Signature:  ${request.signature.slice(0, 20)}...`);
            console.log(`   ✅ Request signed (EIP-712)\n`);
            
            // ============================================================================
            // STEP 4: SUBMIT VIA RELAYER
            // ============================================================================
            
            console.log('📤 Step 4: Submit via Relayer');
            console.log('-'.repeat(40));
            console.log('   What goes ON-CHAIN:');
            console.log(`     - Token:      ${request.localToken}`);
            console.log(`     - Commitment: ${request.commitment.slice(0, 20)}... (hash, not recipient)`);
            console.log(`     - Amount:     [ENCRYPTED]`);
            console.log(`     - msg.sender: [RELAYER ADDRESS, not sender!]\n`);
            console.log('   What stays HIDDEN:');
            console.log(`     - Sender:     ${account.address} ← NOT visible on-chain!`);
            console.log(`     - Recipient:  ??? ← Hidden behind commitment!`);
            console.log(`     - Amount:     ??? ← Encrypted via FHE!\n`);
            
            // Note: In production, uncomment this to actually submit
            // const result = await client.submitViaRelayer(request);
            // console.log(`   ✅ Submitted! Tx: ${result.txHash}\n`);
            console.log('   [Demo mode: Not actually submitting to relayer]\n');
            
        } catch (error) {
            console.log(`   ❌ Error: ${error}\n`);
        }
    } else {
        console.log('   [Skipped - no private key provided]\n');
    }
    
    // ============================================================================
    // STEP 5: RECIPIENT CLAIMS (On Destination Chain)
    // ============================================================================
    
    console.log('🎁 Step 5: Recipient Claims Tokens');
    console.log('-'.repeat(40));
    console.log('   Recipient has the secret (shared off-chain in Step 2)');
    console.log(`   Secret: ${claimSecret.secret.slice(0, 20)}...`);
    console.log('');
    console.log('   Recipient calls: redeemClaim(claimId, secret)');
    console.log('   - Contract verifies: keccak256(secret) == commitment');
    console.log('   - If valid: Mints tokens to msg.sender (recipient)');
    console.log('');
    console.log('   🔓 NOW recipient address is revealed (first time!)');
    console.log('   But observer CANNOT link to:');
    console.log('     - Original sender (hidden by relayer)');
    console.log('     - Bridge timestamp (claim can happen anytime)');
    console.log('     - Amount (still encrypted)\n');
    
    // ============================================================================
    // SUMMARY
    // ============================================================================
    
    console.log('=' .repeat(60));
    console.log('📊 Privacy Summary');
    console.log('=' .repeat(60));
    console.log('');
    console.log('   On-chain visibility at BRIDGE TIME:');
    console.log('   ┌─────────────────────────────────────────────┐');
    console.log('   │ Sender:     ████████ (Relayer visible only) │');
    console.log('   │ Recipient:  ████████ (Just a commitment)    │');
    console.log('   │ Amount:     ████████ (FHE encrypted)        │');
    console.log('   └─────────────────────────────────────────────┘');
    console.log('');
    console.log('   On-chain visibility at CLAIM TIME:');
    console.log('   ┌─────────────────────────────────────────────┐');
    console.log('   │ Claimer:    0xRecipient (revealed now)      │');
    console.log('   │ Linked to:  NOTHING (no sender info)        │');
    console.log('   │ Amount:     ████████ (still encrypted)      │');
    console.log('   └─────────────────────────────────────────────┘');
    console.log('');
    console.log('   ✅ Sender Privacy: Hidden behind relayer');
    console.log('   ✅ Receiver Privacy: Hidden behind commitment until claim');
    console.log('   ✅ Amount Privacy: FHE encrypted throughout');
    console.log('');
}

main().catch(console.error);
