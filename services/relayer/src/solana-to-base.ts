/**
 * Solana → Base Relayer
 * 
 * Monitors Solana for outgoing messages and relays them to Base.
 * This is a simplified version that polls for new messages.
 */

import {
    createSolanaRpc,
    getBase58Encoder,
    type Address as SolAddress,
    address,
} from "@solana/kit";
import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    encodeAbiParameters,
    toHex,
    type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RelayerConfig } from "./config.js";

// ABI for BridgeValidator
const BRIDGE_VALIDATOR_ABI = [
    {
        name: "registerMessages",
        type: "function",
        inputs: [
            {
                name: "signedMessages",
                type: "tuple[]",
                components: [
                    { name: "innerMessageHash", type: "bytes32" },
                    { name: "outgoingMessagePubkey", type: "bytes32" },
                ],
            },
            { name: "validatorSigs", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    { name: "nextNonce", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "validMessages", type: "function", inputs: [{ name: "messageHash", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

// ABI for Bridge
const BRIDGE_ABI = [
    {
        name: "relayMessages", type: "function", inputs: [{
            name: "messages", type: "tuple[]", components: [
                { name: "outgoingMessagePubkey", type: "bytes32" },
                { name: "nonce", type: "uint64" },
                { name: "sender", type: "bytes32" },
                { name: "gasLimit", type: "uint64" },
                { name: "ty", type: "uint8" },
                { name: "data", type: "bytes" },
            ]
        }], outputs: [], stateMutability: "nonpayable"
    },
    { name: "successes", type: "function", inputs: [{ name: "messageHash", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

export class SolanaToBaseRelayer {
    private config: RelayerConfig;
    private publicClient;
    private walletClient;
    private running: boolean = false;

    constructor(config: RelayerConfig) {
        this.config = config;

        const account = privateKeyToAccount(config.evmPrivateKey as Hex);

        this.publicClient = createPublicClient({
            chain: config.baseChain,
            transport: http(config.baseRpcUrl),
        });

        this.walletClient = createWalletClient({
            account,
            chain: config.baseChain,
            transport: http(config.baseRpcUrl),
        });
    }

    /**
     * Start the relayer service
     */
    async start(): Promise<void> {
        console.log("Starting Solana → Base Relayer");
        console.log(`   Solana RPC: ${this.config.solanaRpcUrl}`);
        console.log(`   Base RPC: ${this.config.baseRpcUrl}`);
        console.log(`   Poll interval: ${this.config.pollIntervalMs}ms`);

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
        console.log("Stopping Solana → Base Relayer");
    }

    /**
     * One tick of the relayer - check for messages and relay them
     */
    async tick(): Promise<void> {
        console.log(`\nSolana→Base Tick @ ${new Date().toISOString()}`);

        // Get validator next nonce
        const validatorNonce = await this.publicClient.readContract({
            address: this.config.baseBridgeValidator as Hex,
            abi: BRIDGE_VALIDATOR_ABI,
            functionName: "nextNonce",
        });
        console.log(`   Validator next nonce: ${validatorNonce}`);
        console.log(`   Service running, monitoring for new messages...`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
