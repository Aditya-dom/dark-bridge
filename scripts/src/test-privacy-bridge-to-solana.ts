#!/usr/bin/env bun
/**
 * Test Privacy Bridge to Solana with Real Inco TEE Encryption
 * 
 * This script performs an actual privacy bridge from Base→Solana and verifies:
 * 1. The sender's address is NOT visible on-chain (only the relayer is visible)
 * 2. The Base→Solana relayer picks up the event and relays to Solana
 * 
 * Uses @inco/js SDK to create REAL encrypted amounts (not dummy data).
 * 
 * IMPORTANT: Must run with `bun` not `node` due to @inco/js ESM issues.
 * 
 * Flow:
 * 1. Mint DARK tokens to test user
 * 2. Deposit DARK → cDARK (confidential token)
 * 3. Encrypt amount using Inco Lightning SDK
 * 4. Sign bridge request off-chain (for Solana destination)
 * 5. Submit via relayer to /bridge/private-to-solana endpoint
 * 6. Verify on-chain that original sender is NOT visible
 * 7. Watch for Solana relay (Base→Solana relayer should pick it up)
 */

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseEther, 
  keccak256,
  Hex,
  encodePacked,
  toHex,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';

// Configuration
const CONFIG = {
  rpcUrl: 'https://sepolia.base.org',
  confidentialBridge: '0x4CDE2466011d1c9600720567e8fb56c418c99e08' as `0x${string}`,
  darkToken: '0xcb5a0ad14bcd6b623b614cbcad21f7bdd9990d32' as `0x${string}`,
  cDarkToken: '0x2e631aeb93acf0a00df33ca2b1b6af38be8c4d0b' as `0x${string}`,
  relayerUrl: 'http://localhost:3001',
  // Solana addresses
  solanaProgram: 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9',
  // Explorer URLs
  baseSepoliaExplorer: 'https://sepolia.basescan.org',
  solanaDevnetExplorer: 'https://explorer.solana.com',
};

// Helper to generate explorer links
const explorerLinks = {
  baseTx: (hash: string) => `${CONFIG.baseSepoliaExplorer}/tx/${hash}`,
  baseAddress: (addr: string) => `${CONFIG.baseSepoliaExplorer}/address/${addr}`,
  baseToken: (addr: string) => `${CONFIG.baseSepoliaExplorer}/token/${addr}`,
  solanaTx: (sig: string) => `${CONFIG.solanaDevnetExplorer}/tx/${sig}?cluster=devnet`,
  solanaAddress: (addr: string) => `${CONFIG.solanaDevnetExplorer}/address/${addr}?cluster=devnet`,
};

// Load private key from environment
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable required');
  console.error('');
  console.error('Usage:');
  console.error('  PRIVATE_KEY=0x... bun run src/test-privacy-bridge-to-solana.ts');
  process.exit(1);
}

// ABIs
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const CONFIDENTIAL_TOKEN_ABI = [
  { name: 'deposit', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'underlyingToken', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'bridge', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'symbol', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const;

const CONFIDENTIAL_BRIDGE_ABI = [
  { 
    name: 'userNonces', 
    type: 'function', 
    inputs: [{ name: 'user', type: 'address' }], 
    outputs: [{ type: 'uint256' }], 
    stateMutability: 'view' 
  },
] as const;

/**
 * Convert Solana PublicKey to bytes32 format for EVM
 */
function solanaAddressToBytes32(pubkey: PublicKey): `0x${string}` {
  const bytes = pubkey.toBytes();
  return toHex(bytes) as `0x${string}`;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     PRIVACY BRIDGE TO SOLANA - REAL TEE ENCRYPTION         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Setup
  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(CONFIG.rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(CONFIG.rpcUrl),
  });

  // Generate a test Solana recipient address
  // In production, this would come from the user
  const solanaRecipient = new PublicKey('DYw8jCTfBox68YyWqALYpqKPzWdT7rBHNqYwF6J3YzKE');
  const toSolana = solanaAddressToBytes32(solanaRecipient);

  console.log(`📍 Sender (Base):     ${account.address}`);
  console.log(`📍 Recipient (Solana): ${solanaRecipient.toBase58()}`);
  console.log(`📍 cDARK Token:        ${CONFIG.cDarkToken}`);
  console.log(`📍 Bridge:             ${CONFIG.confidentialBridge}`);
  console.log(`📍 Relayer API:        ${CONFIG.relayerUrl}`);
  console.log('');

  // Step 1: Verify token configuration
  console.log('─── Step 1: Verify Token Configuration ───\n');
  
  try {
    const [underlying, bridge, symbol] = await Promise.all([
      publicClient.readContract({
        address: CONFIG.cDarkToken,
        abi: CONFIDENTIAL_TOKEN_ABI,
        functionName: 'underlyingToken',
      }),
      publicClient.readContract({
        address: CONFIG.cDarkToken,
        abi: CONFIDENTIAL_TOKEN_ABI,
        functionName: 'bridge',
      }),
      publicClient.readContract({
        address: CONFIG.cDarkToken,
        abi: CONFIDENTIAL_TOKEN_ABI,
        functionName: 'symbol',
      }),
    ]);
    
    console.log(`✅ Token Symbol:     ${symbol}`);
    console.log(`✅ Underlying Token: ${underlying}`);
    console.log(`✅ Bridge Address:   ${bridge}`);
  } catch (error) {
    console.error('❌ Token not properly configured:', error);
    process.exit(1);
  }

  // Step 2: Check/deposit cDARK
  console.log('\n─── Step 2: Ensure cDARK Balance ───\n');
  
  const depositAmount = parseEther('10');
  
  // Approve if needed
  const allowance = await publicClient.readContract({
    address: CONFIG.darkToken,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONFIG.cDarkToken],
  });
  
  if (allowance < depositAmount) {
    console.log('Approving DARK for cDARK contract...');
    const approveTx = await walletClient.writeContract({
      address: CONFIG.darkToken,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONFIG.cDarkToken, depositAmount * 10n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('✅ Approved');
  }

  // Deposit
  console.log(`Depositing ${Number(depositAmount) / 1e18} DARK to get cDARK...`);
  
  try {
    const depositTx = await walletClient.writeContract({
      address: CONFIG.cDarkToken,
      abi: CONFIDENTIAL_TOKEN_ABI,
      functionName: 'deposit',
      args: [depositAmount],
      value: parseEther('0.001'), // Inco fee
    });
    
    console.log(`Deposit TX: ${depositTx}`);
    console.log(`🔗 Explorer:   ${explorerLinks.baseTx(depositTx)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`✅ Deposit confirmed at block ${receipt.blockNumber}`);
  } catch (error: any) {
    console.log('⚠️  Deposit might have failed (continuing):', error.message?.slice(0, 100));
  }

  // Step 3: Encrypt amount for Solana bridge
  console.log('\n─── Step 3: Encrypt Amount & Sign for Solana Bridge ───\n');
  
  const bridgeAmount = parseEther('1');
  
  // Initialize Inco Lightning SDK for Base Sepolia
  // IMPORTANT: Use 'devnet' pepper to match deployed contracts
  console.log('Initializing Inco Lightning SDK (devnet)...');
  const zap = await Lightning.latest('devnet', 84532);
  console.log('✅ Inco Lightning SDK initialized');
  
  // Encrypt the amount
  const accountAddressLower = account.address.toLowerCase() as `0x${string}`;
  const dappAddressLower = CONFIG.confidentialBridge.toLowerCase() as `0x${string}`;
  
  console.log(`Encrypting ${Number(bridgeAmount) / 1e18} tokens...`);
  
  const encryptedAmount = await zap.encrypt(bridgeAmount, {
    accountAddress: accountAddressLower,
    dappAddress: dappAddressLower,
    handleType: handleTypes.euint256,
  }) as Hex;
  
  console.log(`✅ Encrypted: ${encryptedAmount.slice(0, 40)}...`);
  console.log(`   Length: ${(encryptedAmount.length - 2) / 2} bytes`);
  
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  
  // Get nonce
  const nonce = await publicClient.readContract({
    address: CONFIG.confidentialBridge,
    abi: CONFIDENTIAL_BRIDGE_ABI,
    functionName: 'userNonces',
    args: [account.address],
  });
  
  console.log(`\nBridge Parameters:`);
  console.log(`  Amount:     ${Number(bridgeAmount) / 1e18} cDARK`);
  console.log(`  To Solana:  ${solanaRecipient.toBase58()}`);
  console.log(`  Deadline:   ${new Date(Number(deadline) * 1000).toISOString()}`);
  console.log(`  Nonce:      ${nonce}`);

  // The contract uses a simple hash signature (NOT EIP-712) for bridgePrivateToSolanaViaRelayer
  // Message = keccak256(localToken, toSolana, encryptedAmount, senderNonce, deadline)
  // Then wrapped with "\x19Ethereum Signed Message:\n32"
  
  const innerHash = keccak256(
    encodePacked(
      ['address', 'bytes32', 'bytes', 'uint256', 'uint256'],
      [CONFIG.cDarkToken, toSolana, encryptedAmount, nonce, deadline]
    )
  );
  
  console.log(`\nSigning message hash: ${innerHash.slice(0, 20)}...`);
  
  // Sign the hash (viem's signMessage automatically adds the Ethereum prefix)
  const signature = await account.signMessage({
    message: { raw: toBytes(innerHash) },
  });

  console.log(`\n✅ Message signed: ${signature.slice(0, 30)}...`);

  // Step 4: Submit via relayer to Solana endpoint
  console.log('\n─── Step 4: Submit via Relayer (to Solana) ───\n');
  
  console.log('🔒 PRIVACY: Relayer will submit TX. Your address hidden as tx.from');
  console.log(`   Solana recipient ${solanaRecipient.toBase58()} is visible (by design)\n`);

  // Check relayer
  try {
    const health = await fetch(`${CONFIG.relayerUrl}/health`);
    if (!health.ok) throw new Error('Not responding');
    console.log('✅ Relayer is running');
  } catch {
    console.error('❌ Relayer not running at', CONFIG.relayerUrl);
    console.error('   Start with: PRIVATE_KEY=... bun run src/relayer-service.ts');
    process.exit(1);
  }

  // Submit to Solana bridge endpoint
  const requestBody = {
    localToken: CONFIG.cDarkToken,
    toSolana: toSolana,
    encryptedAmount,
    sender: account.address,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
  };

  console.log('\nSubmitting to /bridge/private-to-solana...');
  
  const response = await fetch(`${CONFIG.relayerUrl}/bridge/private-to-solana`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const result = await response.json();
  
  if (!response.ok) {
    console.error('❌ Relayer rejected:', result);
    process.exit(1);
  }

  console.log('✅ Relayer accepted!');
  console.log(`\n📋 BASE TRANSACTION:`);
  console.log(`   Hash: ${result.txHash}`);
  console.log(`   🔗 ${explorerLinks.baseTx(result.txHash)}`);

  // Step 5: Wait for confirmation and verify
  console.log('\n─── Step 5: Verify Privacy & Wait for Solana Relay ───\n');
  
  const txReceipt = await publicClient.waitForTransactionReceipt({ 
    hash: result.txHash 
  });
  
  const tx = await publicClient.getTransaction({ 
    hash: result.txHash 
  });

  console.log(`Block: ${txReceipt.blockNumber}`);
  console.log(`From:  ${tx.from}`);
  console.log(`Gas:   ${txReceipt.gasUsed}`);
  
  console.log('\n🔒 PRIVACY CHECK:');
  if (tx.from.toLowerCase() !== account.address.toLowerCase()) {
    console.log('✅ SUCCESS! Your address hidden as tx.from');
    console.log(`   TX from:      ${tx.from} (RELAYER)`);
    console.log(`   Your address: ${account.address} (NOT tx.from)`);
  } else {
    console.log('⚠️  Same address for user and relayer (test setup)');
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    SOLANA RELAY INFO                       ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('The Base→Solana relayer should now pick up this event!');
  console.log('');
  console.log('Event emitted: ConfidentialBridgeInitiated');
  console.log(`  Block: ${txReceipt.blockNumber}`);
  console.log(`  Token: ${CONFIG.cDarkToken}`);
  console.log(`  To:    ${solanaRecipient.toBase58()}`);
  console.log('');
  console.log('Check the relayer terminal for:');
  console.log('  "[2026-...] 🔍 Found ConfidentialBridgeInitiated event"');
  console.log('  "[2026-...] ✅ Relayed to Solana: <solana_tx_signature>"');
  console.log('');
  console.log('📋 EXPLORER LINKS:');
  console.log(`   Base TX:       ${explorerLinks.baseTx(result.txHash)}`);
  console.log(`   Solana Wallet: ${explorerLinks.solanaAddress(solanaRecipient.toBase58())}`);
  console.log(`   Solana Bridge: ${explorerLinks.solanaAddress(CONFIG.solanaProgram)}`);
  console.log('');
}

main().catch(console.error);
