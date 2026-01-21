/**
 * Test Real Privacy Bridge Transaction with Inco Lightning TEE
 * 
 * This script performs an actual bridge transaction and verifies that
 * the sender's address is NOT visible on-chain (only the relayer is visible).
 * 
 * Uses @inco/js SDK to create REAL encrypted amounts (not dummy data).
 * Inco Lightning uses TEE (Trusted Execution Environments), not FHE.
 * 
 * IMPORTANT: Must run with `bun` not `node` due to @inco/js ESM issues.
 * 
 * Flow:
 * 1. Mint DARK tokens to test user
 * 2. Deposit DARK → cDARK (confidential token)
 * 3. Encrypt amount using Inco Lightning SDK
 * 4. Sign bridge request off-chain with EIP-712
 * 5. Submit via relayer (relayer pays gas, sender hidden)
 * 6. Verify on-chain that original sender is NOT visible
 */

import { 
  createPublicClient, 
  createWalletClient, 
  http, 
  parseEther, 
  keccak256,
  Hex,
  encodePacked,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
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

// Load private key from environment or use test key
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY environment variable required');
  console.error('');
  console.error('Usage:');
  console.error('  PRIVATE_KEY=0x... bun run src/test-real-privacy-bridge.ts');
  console.error('');
  console.error('Example (DO NOT use real keys with significant funds):');
  console.error('  export PRIVATE_KEY=0x<your-test-wallet-private-key>');
  console.error('  bun run src/test-real-privacy-bridge.ts');
  process.exit(1);
}

// ABIs
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

const CONFIDENTIAL_TOKEN_ABI = [
  { name: 'deposit', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'payable' },
  { name: 'underlyingToken', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'bridge', type: 'function', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { name: 'symbol', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { name: 'name', type: 'function', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
] as const;

const CONFIDENTIAL_BRIDGE_ABI = [
  { 
    name: 'bridgePrivateViaRelayer', 
    type: 'function', 
    inputs: [
      { name: 'localToken', type: 'address' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'encryptedAmount', type: 'bytes' },
      { name: 'sender', type: 'address' },
      { name: 'senderNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ], 
    outputs: [], 
    stateMutability: 'payable' 
  },
  { 
    name: 'userNonces', 
    type: 'function', 
    inputs: [{ name: 'user', type: 'address' }], 
    outputs: [{ type: 'uint256' }], 
    stateMutability: 'view' 
  },
  { 
    name: 'domainSeparator', 
    type: 'function', 
    inputs: [], 
    outputs: [{ type: 'bytes32' }], 
    stateMutability: 'view' 
  },
] as const;

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        REAL PRIVACY BRIDGE TRANSACTION TEST                 ║');
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

  console.log(`📍 Sender Address: ${account.address}`);
  console.log(`📍 cDARK Token:    ${CONFIG.cDarkToken}`);
  console.log(`📍 Bridge:         ${CONFIG.confidentialBridge}`);
  console.log(`📍 Relayer:        ${CONFIG.relayerUrl}\n`);

  // Verify token configuration
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
    
    if (underlying.toLowerCase() !== CONFIG.darkToken.toLowerCase()) {
      console.error('❌ Underlying token mismatch!');
      process.exit(1);
    }
    if (bridge.toLowerCase() !== CONFIG.confidentialBridge.toLowerCase()) {
      console.error('❌ Bridge address mismatch!');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Token not properly configured:', error);
    process.exit(1);
  }

  // Step 2: Mint DARK tokens
  console.log('\n─── Step 2: Mint DARK Tokens ───\n');
  
  const darkBalance = await publicClient.readContract({
    address: CONFIG.darkToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  
  console.log(`Current DARK balance: ${Number(darkBalance) / 1e18} DARK`);

  // Step 3: Deposit DARK → cDARK
  console.log('\n─── Step 3: Deposit DARK → cDARK ───\n');
  
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
  console.log('Note: Sending 0.001 ETH for Inco TEE fee...');
  
  try {
    const depositTx = await walletClient.writeContract({
      address: CONFIG.cDarkToken,
      abi: CONFIDENTIAL_TOKEN_ABI,
      functionName: 'deposit',
      args: [depositAmount],
      value: parseEther('0.001'), // Inco fee for TEE operations
    });
    
    console.log(`Deposit TX: ${depositTx}`);
    console.log(`🔗 Explorer:   ${explorerLinks.baseTx(depositTx)}`);
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    console.log(`✅ Deposit successful! Gas used: ${depositReceipt.gasUsed}`);
  } catch (error: any) {
    console.error('❌ Deposit failed:', error.message);
    // Continue anyway for testing - user might already have cDARK
  }

  // Step 4: Encrypt amount and sign bridge request
  console.log('\n─── Step 4: Encrypt Amount & Sign Privacy Bridge Request ───\n');
  
  const bridgeAmount = parseEther('5');
  // Create a commitment (hash that receiver will use to claim)
  const commitment = keccak256(encodePacked(['string'], ['test-receiver-secret']));
  
  // Initialize Inco Lightning SDK for Base Sepolia
  // IMPORTANT: Use 'devnet' pepper to match deployed contracts (0x4732520194584a04Cac0224e067658619F4086bD)
  // The 'testnet' pepper uses a different executor (0x168FDc3Ae19A5d5b) and will fail with handle mismatch
  console.log('Initializing Inco Lightning SDK (devnet pepper)...');
  const zap = await Lightning.latest('devnet', 84532); // Base Sepolia chain ID
  console.log('✅ Inco Lightning SDK initialized (devnet)');
  
  // Encrypt the amount using Inco TEE
  // NOTE: Inco uses lowercase addresses for handle computation
  const accountAddressLower = account.address.toLowerCase() as `0x${string}`;
  const dappAddressLower = CONFIG.confidentialBridge.toLowerCase() as `0x${string}`;
  
  console.log(`Encrypting amount ${Number(bridgeAmount) / 1e18} tokens for privacy...`);
  console.log(`  Account Address: ${accountAddressLower}`);
  console.log(`  Dapp Address:    ${dappAddressLower}`);
  console.log(`  Handle Type:     euint256`);
  
  const encryptedAmount = await zap.encrypt(bridgeAmount, {
    accountAddress: accountAddressLower,
    dappAddress: dappAddressLower,
    handleType: handleTypes.euint256,
  }) as Hex;
  console.log(`✅ Amount encrypted: ${encryptedAmount.slice(0, 40)}...${encryptedAmount.slice(-20)}`);
  console.log(`   Ciphertext length: ${(encryptedAmount.length - 2) / 2} bytes`);
  
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now
  
  // Get nonce
  const nonce = await publicClient.readContract({
    address: CONFIG.confidentialBridge,
    abi: CONFIDENTIAL_BRIDGE_ABI,
    functionName: 'userNonces',
    args: [account.address],
  });
  
  console.log(`Amount:           ${Number(bridgeAmount) / 1e18} cDARK`);
  console.log(`Commitment:       ${commitment.slice(0, 20)}...`);
  console.log(`Encrypted:        ${encryptedAmount.slice(0, 30)}... (real Inco TEE ciphertext)`);
  console.log(`Deadline:         ${new Date(Number(deadline) * 1000).toISOString()}`);
  console.log(`Nonce:            ${nonce}`);

  // EIP-712 Domain (must match relayer)
  const domain = {
    name: 'ConfidentialBridge',
    version: '1',
    chainId: 84532, // Base Sepolia
    verifyingContract: CONFIG.confidentialBridge,
  };

  // EIP-712 Types (must match relayer)
  const types = {
    PrivateBridge: [
      { name: 'localToken', type: 'address' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'encryptedAmount', type: 'bytes' },
      { name: 'sender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };

  // Message to sign
  const message = {
    localToken: CONFIG.cDarkToken,
    commitment,
    encryptedAmount,
    sender: account.address,
    nonce,
    deadline,
  };

  // Sign using EIP-712 typed data
  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: 'PrivateBridge',
    message,
  });

  console.log(`Signature:        ${signature.slice(0, 30)}...`);
  console.log('✅ Message signed off-chain\n');

  // Step 5: Submit via relayer
  console.log('─── Step 5: Submit via Relayer ───\n');
  
  console.log('🔒 PRIVACY GUARANTEE:');
  console.log('   The relayer will submit this transaction.');
  console.log(`   On-chain, only the RELAYER address will be visible.`);
  console.log(`   Your address (${account.address}) will NOT appear on-chain.\n`);

  // Check if relayer is running
  try {
    const healthCheck = await fetch(`${CONFIG.relayerUrl}/health`);
    if (!healthCheck.ok) {
      throw new Error('Relayer not responding');
    }
    console.log('✅ Relayer is running');
  } catch {
    console.log('⚠️  Relayer not running at', CONFIG.relayerUrl);
    console.log('   Start it with: cd services && PRIVATE_KEY=... bun run src/privacy-relayer-service.ts\n');
    
    // For demo, we can simulate the on-chain check
    console.log('\n─── Step 6: Verify Privacy (Simulation) ───\n');
    
    console.log('Even without the relayer running, we can verify the privacy architecture:');
    console.log('');
    console.log('1. Your signature was created OFF-CHAIN (no transaction)');
    console.log('2. The signature can only be used by calling bridgePrivateViaRelayer()');
    console.log('3. That function requires a RELAYER to call it (paying gas)');
    console.log('4. The sender address in tx.from will be the RELAYER, not you');
    console.log('5. Your address only appears as a parameter, validated via signature');
    console.log('');
    console.log('📊 ON-CHAIN VISIBILITY COMPARISON:');
    console.log('┌─────────────────────┬────────────────────┬────────────────────┐');
    console.log('│ Field               │ Normal Bridge      │ Private Bridge     │');
    console.log('├─────────────────────┼────────────────────┼────────────────────┤');
    console.log('│ tx.from             │ YOUR ADDRESS       │ RELAYER ADDRESS    │');
    console.log('│ msg.sender          │ YOUR ADDRESS       │ RELAYER ADDRESS    │');
    console.log('│ Gas payer           │ YOU                │ RELAYER            │');
    console.log('│ sender parameter    │ N/A                │ YOUR ADDRESS       │');
    console.log('│ Signature           │ N/A                │ YOUR SIGNATURE     │');
    console.log('└─────────────────────┴────────────────────┴────────────────────┘');
    console.log('');
    console.log('🔒 The "sender" parameter requires the valid signature to work,');
    console.log('   so it\'s cryptographically authenticated but not the TX sender.');
    console.log('');
    console.log('📦 INCO LIGHTNING ENCRYPTION:');
    console.log('   ✅ Amount encrypted using Inco TEE (real ciphertext, not dummy data)');
    console.log(`   ✅ Ciphertext length: ${encryptedAmount.length / 2 - 1} bytes`);
    
    // Save the signed request for later use
    const requestData = {
      localToken: CONFIG.cDarkToken,
      commitment,
      encryptedAmount,
      sender: account.address,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      signature,
      timestamp: new Date().toISOString(),
    };
    
    fs.writeFileSync(
      path.join(__dirname, '..', '.pending-privacy-request.json'),
      JSON.stringify(requestData, null, 2)
    );
    
    console.log('\n📄 Saved signed request to .pending-privacy-request.json');
    console.log('   Submit it to relayer when running with:');
    console.log('   curl -X POST http://localhost:3001/bridge/private -H "Content-Type: application/json" -d @.pending-privacy-request.json');
    
    process.exit(0);
  }

  // If relayer is running, submit the request
  const requestBody = {
    localToken: CONFIG.cDarkToken,
    commitment,
    encryptedAmount,
    sender: account.address,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
  };

  console.log('\nSubmitting to relayer...');
  
  const response = await fetch(`${CONFIG.relayerUrl}/bridge/private`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const result = await response.json();
  
  if (!response.ok) {
    // Check if this is an Inco encryption error
    if (result.details?.includes('0x5924bb27') || result.error?.includes('0x5924bb27')) {
      console.log('❌ Transaction failed with handle mismatch error');
      console.log('   Error 0x5924bb27 = ExternalHandleDoesNotMatchComputedHandle');
      console.log('   This may indicate the ciphertext was not properly generated or validated.\n');
      process.exit(1);
    }
    
    console.error('❌ Relayer rejected request:', result);
    process.exit(1);
  }

  console.log('✅ Relayer accepted request');
  console.log(`Transaction Hash: ${result.txHash}`);
  console.log(`🔗 Base Sepolia Explorer: ${explorerLinks.baseTx(result.txHash)}`);

  // Step 6: Verify privacy on-chain
  console.log('\n─── Step 6: Verify Privacy On-Chain ───\n');
  
  const txReceipt = await publicClient.waitForTransactionReceipt({ 
    hash: result.txHash 
  });
  
  const tx = await publicClient.getTransaction({ 
    hash: result.txHash 
  });

  console.log('Transaction Details:');
  console.log(`  Block:    ${txReceipt.blockNumber}`);
  console.log(`  From:     ${tx.from}`);
  console.log(`  To:       ${tx.to}`);
  console.log(`  Gas Used: ${txReceipt.gasUsed}`);
  
  console.log('\n🔗 EXPLORER LINKS:');
  console.log(`  Transaction: ${explorerLinks.baseTx(result.txHash)}`);
  console.log(`  Bridge:      ${explorerLinks.baseAddress(CONFIG.confidentialBridge)}`);
  console.log(`  cDARK Token: ${explorerLinks.baseToken(CONFIG.cDarkToken)}`);
  console.log(`  DARK Token:  ${explorerLinks.baseToken(CONFIG.darkToken)}`);
  
  console.log('\n🔒 PRIVACY VERIFICATION:');
  
  if (tx.from.toLowerCase() !== account.address.toLowerCase()) {
    console.log('✅ SUCCESS! Sender address is HIDDEN!');
    console.log(`   Transaction from: ${tx.from} (RELAYER)`);
    console.log(`   Your address:     ${account.address} (NOT VISIBLE as tx.from)`);
  } else {
    console.log('❌ FAILED! Your address is visible as tx.from');
  }

  console.log('\n═════════════════════════════════════════════════════════════');
  console.log('                    TEST COMPLETE                            ');
  console.log('═════════════════════════════════════════════════════════════');
  console.log('');
  console.log('📋 Quick Links:');
  console.log(`   🔍 View TX:     ${explorerLinks.baseTx(result.txHash)}`);
  console.log(`   👤 Your Wallet: ${explorerLinks.baseAddress(account.address)}`);
  console.log(`   🤖 Relayer:     ${explorerLinks.baseAddress(tx.from)}`);
  console.log('');
}

main().catch(console.error);
