/**
 * Base → Solana Relayer
 * 
 * Monitors Base bridge for MessageInitiated events and queues them for relay.
 * This is a simplified version for monitoring.
 */

import {
    createPublicClient,
    http,
    type Hex,
    parseAbiItem,
} from "viem";
import type { RelayerConfig } from "./config.js";

// MessageInitiated event ABI
const MESSAGE_INITIATED_EVENT = parseAbiItem(
    "event MessageInitiated(bytes32 indexed messageHash, address indexed sender, uint256 indexed nonce, bytes message)"
);

export class BaseToSolanaRelayer {
    private config: RelayerConfig;
    private publicClient;
    private running: boolean = false;
    private lastProcessedBlock: bigint = 0n;
    private pendingCount: number = 0;

    constructor(config: RelayerConfig) {
        this.config = config;

        this.publicClient = createPublicClient({
            chain: config.baseChain,
            transport: http(config.baseRpcUrl),
        });
    }

    /**
     * Start the relayer service
     */
    async start(): Promise<void> {
        console.log("🚀 Starting Base → Solana Relayer");
        console.log(`   Base RPC: ${this.config.baseRpcUrl}`);
        console.log(`   Solana RPC: ${this.config.solanaRpcUrl}`);
        console.log(`   Poll interval: ${this.config.pollIntervalMs}ms`);

        // Get current block to start from
        this.lastProcessedBlock = await this.publicClient.getBlockNumber();
        console.log(`   Starting from block: ${this.lastProcessedBlock}`);

        this.running = true;

        while (this.running) {
            try {
                await this.tick();
            } catch (error) {
                console.error("Relayer tick failed:", error);
            }
            await this.sleep(this.config.pollIntervalMs);
        }
    }

    /**
     * Stop the relayer service
     */
    stop(): void {
        this.running = false;
        console.log("Stopping Base → Solana Relayer");
    }

    /**
     * One tick of the relayer - check for new events
     */
    async tick(): Promise<void> {
        console.log(`\nBase→Solana Tick @ ${new Date().toISOString()}`);

        const currentBlock = await this.publicClient.getBlockNumber();

        if (currentBlock > this.lastProcessedBlock) {
            // Scan for new MessageInitiated events
            console.log(`Scanning blocks ${this.lastProcessedBlock + 1n} to ${currentBlock}...`);

            try {
                const logs = await this.publicClient.getLogs({
                    address: this.config.baseBridgeContract as Hex,
                    event: MESSAGE_INITIATED_EVENT,
                    fromBlock: this.lastProcessedBlock + 1n,
                    toBlock: currentBlock,
                });

                if (logs.length > 0) {
                    console.log(`Found ${logs.length} new message(s)`);
                    this.pendingCount += logs.length;
                } else {
                    console.log(`No new messages`);
                }
            } catch (error) {
                console.error(`Failed to scan logs:`, error);
            }

            this.lastProcessedBlock = currentBlock;
        }

        console.log(`Block: ${currentBlock}, Pending: ${this.pendingCount}`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
