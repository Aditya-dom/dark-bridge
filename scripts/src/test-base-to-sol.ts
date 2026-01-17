#!/usr/bin/env bun
/**
 * Simple test script to bridge from Base to Solana
 * Calls a dummy instruction on Solana
 */

import { createWalletClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
  throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const BRIDGE_CONTRACT = "0x8e46419298a9620ea326113baf4019a23594bb11";

// Dummy Solana program ID for testing
const DUMMY_PROGRAM_ID = "11111111111111111111111111111111"; // System program

async function main() {
  console.log("=== Testing Base → Solana Bridge ===\n");

  const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  console.log(`Signer: ${account.address}`);
  console.log(`Bridge: ${BRIDGE_CONTRACT}\n`);

  // Convert Solana program ID to bytes32
  const programIdBytes32 = "0xc671a23760000000000000000000000000000000000000000000000000000000";

  // Create a simple bridge call with empty instruction data
  const tx = await walletClient.writeContract({
    address: BRIDGE_CONTRACT,
    abi: parseAbi([
      "function bridgeCall((bytes32,bytes[],bytes)[] instructions) external payable",
    ]),
    functionName: "bridgeCall",
    args: [
      [
        {
          programId: programIdBytes32,
          accounts: [] as `0x${string}`[],
          data: "0x",
        },
      ],
    ],
  });

  console.log(`✅ Transaction sent: ${tx}`);
  console.log(`https://sepolia.basescan.org/tx/${tx}`);
  console.log("\nWaiting for Base → Solana auto-relayer to pick this up...");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
