#!/usr/bin/env bun
/**
 * Test Direct Privacy Bridge (No Relayer)
 * 
 * This tests the direct `bridgePrivateToSolana` call where the user
 * calls the contract directly (msg.sender = user).
 * 
 * This helps verify that Inco encryption is working correctly.
 */

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseEther,
  keccak256,
  encodePacked,
  Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';

// Configuration
const CONFIG = {
  rpcUrl: 'https://sepolia.base.org',
  confidentialBridge: '0x6f7c0515daF8459c0eBf35DB0411fC665fEf838a' as `0x${string}`,
  cDarkToken: '0x06eb490068dFdc3b071A89381e06032B9E657906' as `0x${string}`,
};

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable required');
  process.exit(1);
}

const CONFIDENTIAL_BRIDGE_ABI = [
  { 
    name: 'bridgePrivateToSolana', 
    type: 'function', 
    inputs: [
      { name: 'localToken', type: 'address' },
      { name: 'toSolana', type: 'bytes32' },
      { name: 'encryptedAmount', type: 'bytes' },
    ], 
    outputs: [], 
    stateMutability: 'payable' 
  },
  { 
    name: 'getIncoFee', 
    type: 'function', 
    inputs: [], 
    outputs: [{ type: 'uint256' }], 
    stateMutability: 'view' 
  },
] as const;

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        DIRECT PRIVACY BRIDGE TEST (NO RELAYER)              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

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

  console.log(`📍 User Address: ${account.address}`);
  console.log(`📍 Bridge:       ${CONFIG.confidentialBridge}`);

  // Get Inco fee
  const incoFee = await publicClient.readContract({
    address: CONFIG.confidentialBridge,
    abi: CONFIDENTIAL_BRIDGE_ABI,
    functionName: 'getIncoFee',
  });
  console.log(`📍 Inco Fee:     ${Number(incoFee) / 1e18} ETH`);

  // Initialize Inco Lightning SDK
  console.log('\n─── Initializing Inco Lightning SDK ───\n');
  // IMPORTANT: Use 'devnet' to match deployed contracts (0x4732520194584a04Cac0224e067658619F4086bD)
  const zap = await Lightning.latest('devnet', 84532);
  console.log('✅ Inco Lightning SDK initialized');

  // Encrypt amount
  const bridgeAmount = parseEther('1');
  const accountAddressLower = account.address.toLowerCase() as `0x${string}`;
  const dappAddressLower = CONFIG.confidentialBridge.toLowerCase() as `0x${string}`;

  console.log(`\nEncrypting ${Number(bridgeAmount) / 1e18} tokens...`);
  console.log(`  Account Address: ${accountAddressLower}`);
  console.log(`  Dapp Address:    ${dappAddressLower}`);
  console.log(`  Handle Type:     euint256`);

  const encryptedAmount = await zap.encrypt(bridgeAmount, {
    accountAddress: accountAddressLower,
    dappAddress: dappAddressLower,
    handleType: handleTypes.euint256,
  }) as Hex;
  
  console.log(`✅ Amount encrypted`);
  console.log(`   Ciphertext: ${encryptedAmount.slice(0, 40)}...${encryptedAmount.slice(-20)}`);
  console.log(`   Length: ${(encryptedAmount.length - 2) / 2} bytes`);

  // Create test Solana recipient
  const solanaRecipient = keccak256(encodePacked(['string'], ['test-solana-recipient']));
  console.log(`\n📍 Solana Recipient: ${solanaRecipient.slice(0, 20)}...`);

  // Call bridge directly (user is msg.sender)
  console.log('\n─── Calling bridgePrivateToSolana ───\n');
  console.log('This is a DIRECT call where msg.sender = user');
  console.log('No relayer involved - user pays gas and is visible on-chain\n');

  try {
    const txHash = await walletClient.writeContract({
      address: CONFIG.confidentialBridge,
      abi: CONFIDENTIAL_BRIDGE_ABI,
      functionName: 'bridgePrivateToSolana',
      args: [CONFIG.cDarkToken, solanaRecipient, encryptedAmount],
      value: incoFee * 2n, // 2x fee for burn + bridge
    });

    console.log(`✅ Transaction submitted: ${txHash}`);
    
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`✅ Transaction confirmed!`);
    console.log(`   Block: ${receipt.blockNumber}`);
    console.log(`   Gas Used: ${receipt.gasUsed}`);
    console.log(`   Status: ${receipt.status}`);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                     SUCCESS!                                   ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('\nInco encryption is working correctly with direct calls.');
    console.log('The issue must be with the relayer flow (msg.sender mismatch).');

  } catch (error: any) {
    console.error('❌ Transaction failed:', error.message?.slice(0, 500));
    
    if (error.message?.includes('0x5924bb27')) {
      console.log('\n⚠️  ExternalHandleDoesNotMatchComputedHandle error');
      console.log('   This means encryption context is still wrong.');
    }
  }
}

main().catch(console.error);
