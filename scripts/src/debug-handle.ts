#!/usr/bin/env bun
/**
 * Debug Handle Computation
 * 
 * This script helps debug the Inco handle computation by comparing
 * the SDK's computed handle with what the contract expects.
 */

import { Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';
import { parseEther, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` || '0x' + '00'.repeat(32);

async function main() {
  console.log('─── Debug Handle Computation ───\n');
  
  const account = privateKeyToAccount(PRIVATE_KEY);
  
  // IMPORTANT: Use 'devnet' to match deployed contracts (0x4732520194584a04Cac0224e067658619F4086bD)
  const zap = await Lightning.latest('devnet', 84532);
  
  console.log('SDK Configuration:');
  console.log(`  Chain ID: ${zap.chainId}`);
  console.log(`  Executor Address: ${zap.executorAddress}`);
  
  const userAddress = account.address.toLowerCase() as `0x${string}`;
  const dappAddress = '0x6f7c0515daF8459c0eBf35DB0411fC665fEf838a' as `0x${string}`;
  const amount = parseEther('5');
  
  console.log('\nTest Parameters:');
  console.log(`  User Address: ${userAddress}`);
  console.log(`  Dapp Address: ${dappAddress}`);
  console.log(`  Amount: ${amount}`);
  
  console.log('\nEncrypting with SDK...');
  const ciphertext = await zap.encrypt(amount, {
    accountAddress: userAddress,
    dappAddress: dappAddress,
    handleType: handleTypes.euint256,
  }) as Hex;
  
  console.log(`Ciphertext: ${ciphertext.slice(0, 50)}...`);
  console.log(`Ciphertext length: ${(ciphertext.length - 2) / 2} bytes`);
  
  // Parse the ciphertext structure
  // First 32 bytes = handle
  const handle = ciphertext.slice(0, 66) as Hex;
  console.log(`\nExternal Handle (from ciphertext): ${handle}`);
  
  console.log('\n─── Handle Components ───');
  console.log(`Chain ID: ${zap.chainId} (Base Sepolia)`);
  console.log(`ACL/Executor: ${zap.executorAddress}`);
  console.log(`User: ${userAddress}`);
  console.log(`Contract: ${dappAddress}`);
  
  // Break down the ciphertext
  console.log('\nCiphertext byte breakdown:');
  const bytes = ciphertext.slice(2);
  console.log(`  Total bytes: ${bytes.length / 2}`);
  console.log(`  First 32 bytes (handle): 0x${bytes.slice(0, 64)}`);
  console.log(`  Bytes 32-64 (offset?): 0x${bytes.slice(64, 128)}`);
  console.log(`  Bytes 64-96 (length?): 0x${bytes.slice(128, 192)}`);
  console.log(`  Remaining payload: 0x${bytes.slice(192, 256)}...`);
  
  // Extract handle metadata
  const handleHex = bytes.slice(0, 64);
  const handleBigInt = BigInt('0x' + handleHex);
  const indexHandle = handleBigInt >> 16n;
  const handleType = (handleBigInt >> 8n) & 0xffn;
  const handleVersion = handleBigInt & 0xffn;
  
  console.log('\nHandle metadata:');
  console.log(`  Index Handle: ${indexHandle & 0xffn}`);
  console.log(`  Handle Type: ${handleType} (should be 8 for euint256)`);
  console.log(`  Handle Version: ${handleVersion}`);
}

main().catch(console.error);
