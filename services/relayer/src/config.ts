/**
 * Relayer Service Configuration
 * 
 * Environment-based configuration for the bidirectional bridge relayer.
 */

import { baseSepolia } from "viem/chains";

export interface RelayerConfig {
    // Solana
    solanaRpcUrl: string;
    solanaBridgeProgram: string;

    // Base
    baseRpcUrl: string;
    baseBridgeContract: string;
    baseBridgeValidator: string;
    baseChain: typeof baseSepolia;

    // Polling
    pollIntervalMs: number;

    // Keys (from environment)
    evmPrivateKey: string;
    solanaPrivateKeyPath: string;
}

export function loadConfig(): RelayerConfig {
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    if (!evmPrivateKey) {
        throw new Error("EVM_PRIVATE_KEY environment variable is required");
    }

    const solanaPrivateKeyPath = process.env.SOLANA_KEYPAIR_PATH || "~/.config/solana/id.json";

    return {
        // Solana (Devnet)
        solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
        solanaBridgeProgram: process.env.SOLANA_BRIDGE_PROGRAM || "EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9",

        // Base (Sepolia)
        baseRpcUrl: process.env.BASE_RPC_URL || "https://sepolia.base.org",
        baseBridgeContract: process.env.BASE_BRIDGE_CONTRACT || "0x8e46419298a9620ea326113baf4019a23594bb11",
        baseBridgeValidator: process.env.BASE_BRIDGE_VALIDATOR || "0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462",
        baseChain: baseSepolia,

        // Polling
        pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "30000"),

        // Keys
        evmPrivateKey,
        solanaPrivateKeyPath,
    };
}
