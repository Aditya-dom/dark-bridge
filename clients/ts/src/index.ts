// Export each module under its own namespace to avoid conflicts
export * as Bridge from "./bridge";
export * as BaseRelayer from "./base-relayer";

// Export Base → Solana oracle and prover
export { BaseToSolanaOracle, TESTNET_CONFIG as ORACLE_TESTNET_CONFIG, MAINNET_CONFIG as ORACLE_MAINNET_CONFIG } from "./base-to-solana-oracle";
export { BaseToSolanaProver, PROVER_TESTNET_CONFIG } from "./base-to-solana-prover";

// Export unified bidirectional bridge client
export { BidirectionalBridge, TESTNET_BRIDGE_CONFIG, type BridgeConfig, type BridgeState, type PendingMessage } from "./bidirectional-bridge";

// Export auto-relayer for Solana → Base
export { relayMessage } from "./auto-relayer";
