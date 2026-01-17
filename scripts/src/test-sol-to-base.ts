#!/usr/bin/env bun
/**
 * Simple test script to bridge from Solana to Base
 * Calls the counter contract's increment function
 */

import { handleBridgeCall } from "./commands/sol/bridge/solana-to-base/bridge-call.handler";

async function main() {
  console.log("=== Testing Solana → Base Bridge ===\n");

  await handleBridgeCall({
    deployEnv: "testnet-alpha",
    payerKp: "config",
    to: "counter",
    value: "0",
    data: "increment",
    payForRelay: false,
  });

  console.log("\n✅ Bridge call transaction created!");
  console.log("The auto-relayer should pick this up and relay it to Base.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
