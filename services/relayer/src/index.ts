/**
 * Bridge Relayer Service
 * 
 * Bidirectional automatic relayer for Base <-> Solana bridge.
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run dev
 */

import { loadConfig } from "./config.js";
import { SolanaToBaseRelayer } from "./solana-to-base.js";
import { BaseToSolanaRelayer } from "./base-to-solana.js";

async function main() {
    console.log("═══════════════════════════════════════════════════════════");
    console.log("           Dark Bridge Relayer Service ");
    console.log("═══════════════════════════════════════════════════════════\n");

    // Load configuration
    const config = loadConfig();

    console.log("Configuration:");
    console.log(`   Base Bridge: ${config.baseBridgeContract}`);
    console.log(`   Solana Bridge: ${config.solanaBridgeProgram}`);
    console.log(`   Poll Interval: ${config.pollIntervalMs}ms\n`);

    // Create relayers
    const solToBase = new SolanaToBaseRelayer(config);
    const baseToSol = new BaseToSolanaRelayer(config);

    // Handle shutdown gracefully
    process.on("SIGINT", () => {
        console.log("\n\nShutting down...");
        solToBase.stop();
        baseToSol.stop();
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        console.log("\n\nShutting down...");
        solToBase.stop();
        baseToSol.stop();
        process.exit(0);
    });

    // Start both relayers concurrently
    console.log("Starting relayers...\n");

    await Promise.all([
        solToBase.start(),
        baseToSol.start(),
    ]);
}

main().catch(console.error);
