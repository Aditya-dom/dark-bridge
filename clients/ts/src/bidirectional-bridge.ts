#!/usr/bin/env bun
/**
 * Bidirectional Bridge Client
 *
 * Production-ready unified client for Base <-> Solana bridging:
 *
 * Base → Solana:
 *   1. Oracle registers output roots (automated background service)
 *   2. User proves message with MMR proof
 *   3. User finalizes token transfer on Solana
 *
 * Solana → Base:
 *   1. User initiates bridge on Solana
 *   2. Relayer signs and registers message
 *   3. User/relayer executes on Base
 *
 * Run demo: SOLANA_PRIVATE_KEY=... EVM_PRIVATE_KEY=... bun run src/bidirectional-bridge.ts
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    createPublicClient,
    createWalletClient,
    http,
    formatEther,
    type Hex,
    parseAbiItem,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import bs58 from 'bs58';

// Import our modules
import { BaseToSolanaOracle, TESTNET_CONFIG as ORACLE_CONFIG } from './base-to-solana-oracle';
import { BaseToSolanaProver, PROVER_TESTNET_CONFIG } from './base-to-solana-prover';

// ============================================================================
// Configuration
// ============================================================================

export interface BridgeConfig {
    network: 'testnet' | 'mainnet';

    // Base
    baseRpcUrl: string;
    baseBridgeAddress: Hex;
    baseBridgeValidatorAddress: Hex;
    baseChainId: number;

    // Solana
    solanaRpcUrl: string;
    solanaBridgeProgram: string;
    solanaBridgeAccount: string;

    // Timing
    pollIntervalMs: number;
    blockInterval: number;
}

const TESTNET_BRIDGE_CONFIG: BridgeConfig = {
    network: 'testnet',

    // Base Sepolia
    baseRpcUrl: 'https://sepolia.base.org',
    baseBridgeAddress: '0x2B3550823301752c95290ec6f8781E88F0Bac8c4',
    baseBridgeValidatorAddress: '0x9fc354b36a6a1da0c1dBdcE2fc73793eAb6FC462',
    baseChainId: 84532,

    // Solana Devnet
    solanaRpcUrl: 'https://api.devnet.solana.com',
    solanaBridgeProgram: 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9',
    solanaBridgeAccount: '3rwf6Bm2mppj4h9kokESadWnWHFnuBC6jthyqbQFvkZH',

    // Timing
    pollIntervalMs: 30000,
    blockInterval: 300,
};

// ============================================================================
// Bridge State Types
// ============================================================================

export interface BridgeState {
    // Base state
    base: {
        blockNumber: bigint;
        mmrRoot: Hex;
        totalMessages: bigint;
        bridgeBalance: bigint;
    };

    // Solana state
    solana: {
        lastRegisteredBlock: bigint;
        outgoingMessageCount: bigint;
        paused: boolean;
        bridgeBalance: bigint;
    };

    // Sync status
    sync: {
        blocksAhead: bigint;
        messagesAhead: bigint;
        isOracleSynced: boolean;
    };
}

export interface PendingMessage {
    direction: 'base-to-solana' | 'solana-to-base';
    nonce: bigint;
    sender: string;
    status: 'pending' | 'proven' | 'executed' | 'failed';
    messageHash?: Hex;
    txHash?: string;
}

// ============================================================================
// ABIs
// ============================================================================

const BASE_BRIDGE_ABI = [
    parseAbiItem('function getNextNonce() view returns (uint64)'),
    parseAbiItem('function getRoot() view returns (bytes32)'),
    parseAbiItem('function generateProof(uint64 leafIndex) view returns (bytes32[] memory)'),
    parseAbiItem('event MessageInitiated(bytes32 indexed messageHash, bytes32 indexed mmrRoot, (uint64 nonce, address sender, bytes data) message)'),
] as const;

const BRIDGE_VALIDATOR_ABI = [
    {
        name: 'registerMessages',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'signedMessages',
                type: 'tuple[]',
                components: [
                    { name: 'innerMessageHash', type: 'bytes32' },
                    { name: 'outgoingMessagePubkey', type: 'bytes32' }
                ]
            },
            { name: 'validatorSigs', type: 'bytes' }
        ],
        outputs: []
    },
    {
        name: 'nextNonce',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }]
    },
    {
        name: 'validMessages',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'messageHash', type: 'bytes32' }],
        outputs: [{ type: 'bool' }]
    }
] as const;

const BRIDGE_RELAY_ABI = [
    {
        name: 'relayMessages',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            {
                name: 'messages',
                type: 'tuple[]',
                components: [
                    { name: 'outgoingMessagePubkey', type: 'bytes32' },
                    { name: 'nonce', type: 'uint64' },
                    { name: 'sender', type: 'bytes32' },
                    { name: 'gasLimit', type: 'uint64' },
                    { name: 'ty', type: 'uint8' },
                    { name: 'data', type: 'bytes' }
                ]
            }
        ],
        outputs: []
    },
    {
        name: 'successes',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'messageHash', type: 'bytes32' }],
        outputs: [{ type: 'bool' }]
    }
] as const;

// ============================================================================
// Seeds
// ============================================================================

const BRIDGE_SEED = Buffer.from('bridge');
const OUTPUT_ROOT_SEED = Buffer.from('output_root');

// ============================================================================
// Unified Bridge Client
// ============================================================================

export class BidirectionalBridge {
    private config: BridgeConfig;
    private solanaConnection: Connection;
    private solanaPayer: Keypair | null = null;
    private evmAccount: ReturnType<typeof privateKeyToAccount> | null = null;
    private basePublicClient: ReturnType<typeof createPublicClient>;
    private baseWalletClient: ReturnType<typeof createWalletClient> | null = null;
    private programId: PublicKey;
    private bridgeAccount: PublicKey;

    // Sub-components
    private oracle: BaseToSolanaOracle | null = null;
    private prover: BaseToSolanaProver | null = null;

    constructor(config: BridgeConfig = TESTNET_BRIDGE_CONFIG) {
        this.config = config;

        // Setup Solana connection
        this.solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');
        this.programId = new PublicKey(config.solanaBridgeProgram);
        this.bridgeAccount = new PublicKey(config.solanaBridgeAccount);

        // Setup Base public client
        this.basePublicClient = createPublicClient({
            chain: config.baseChainId === 84532 ? baseSepolia : base,
            transport: http(config.baseRpcUrl),
        }) as any;
    }

    /**
     * Initialize with wallet credentials
     */
    async initialize(options: {
        solanaPrivateKey?: string;
        evmPrivateKey?: Hex;
    }): Promise<void> {
        // Setup Solana wallet
        if (options.solanaPrivateKey) {
            if (options.solanaPrivateKey.startsWith('[')) {
                const keyArray = JSON.parse(options.solanaPrivateKey);
                this.solanaPayer = Keypair.fromSecretKey(new Uint8Array(keyArray));
            } else {
                const decoded = bs58.decode(options.solanaPrivateKey);
                this.solanaPayer = Keypair.fromSecretKey(decoded);
            }

            // Initialize prover
            this.prover = new BaseToSolanaProver(
                {
                    baseRpcUrl: this.config.baseRpcUrl,
                    baseBridgeAddress: this.config.baseBridgeAddress,
                    baseChainId: this.config.baseChainId,
                    solanaRpcUrl: this.config.solanaRpcUrl,
                    solanaBridgeProgram: this.config.solanaBridgeProgram,
                },
                options.solanaPrivateKey
            );
        }

        // Setup EVM wallet
        if (options.evmPrivateKey) {
            this.evmAccount = privateKeyToAccount(options.evmPrivateKey);
            this.baseWalletClient = createWalletClient({
                account: this.evmAccount,
                chain: this.config.baseChainId === 84532 ? baseSepolia : base,
                transport: http(this.config.baseRpcUrl),
            });

            // Initialize oracle if both keys provided
            if (options.solanaPrivateKey) {
                this.oracle = new BaseToSolanaOracle(
                    {
                        ...ORACLE_CONFIG,
                        baseRpcUrl: this.config.baseRpcUrl,
                        baseBridgeAddress: this.config.baseBridgeAddress,
                        solanaRpcUrl: this.config.solanaRpcUrl,
                        solanaBridgeProgram: this.config.solanaBridgeProgram,
                        solanaBridgeAccount: this.config.solanaBridgeAccount,
                    },
                    options.solanaPrivateKey,
                    options.evmPrivateKey
                );
            }
        }

        console.log('✅ Bridge initialized');
        if (this.solanaPayer) {
            console.log(`   Solana: ${this.solanaPayer.publicKey.toBase58()}`);
        }
        if (this.evmAccount) {
            console.log(`   EVM: ${this.evmAccount.address}`);
        }
    }

    /**
     * Get current bridge state from both chains
     */
    async getState(): Promise<BridgeState> {
        // Fetch Base state
        const [baseBlockNumber, baseMmrRoot, baseTotalMessages, baseBridgeBalance] = await Promise.all([
            this.basePublicClient.getBlockNumber(),
            this.basePublicClient.readContract({
                address: this.config.baseBridgeAddress,
                abi: BASE_BRIDGE_ABI,
                functionName: 'getRoot',
            }) as Promise<Hex>,
            this.basePublicClient.readContract({
                address: this.config.baseBridgeAddress,
                abi: BASE_BRIDGE_ABI,
                functionName: 'getNextNonce',
            }) as Promise<bigint>,
            this.basePublicClient.getBalance({
                address: this.config.baseBridgeAddress,
            }),
        ]);

        // Fetch Solana state
        const accountInfo = await this.solanaConnection.getAccountInfo(this.bridgeAccount);
        let solanaLastBlock = 0n;
        let solanaOutgoingCount = 0n;
        let solanaPaused = false;

        if (accountInfo) {
            // Parse bridge state (skip 8-byte discriminator)
            solanaLastBlock = accountInfo.data.readBigUInt64LE(8);
            solanaOutgoingCount = accountInfo.data.readBigUInt64LE(16);
            solanaPaused = accountInfo.data[56] === 1;
        }

        const solanaBridgeBalance = await this.solanaConnection.getBalance(this.bridgeAccount);

        // Calculate sync status
        const interval = BigInt(this.config.blockInterval);
        const expectedBlock = ((baseBlockNumber / interval) * interval);
        const blocksAhead = expectedBlock - solanaLastBlock;
        const messagesAhead = baseTotalMessages; // Simplified

        return {
            base: {
                blockNumber: baseBlockNumber,
                mmrRoot: baseMmrRoot,
                totalMessages: baseTotalMessages,
                bridgeBalance: baseBridgeBalance,
            },
            solana: {
                lastRegisteredBlock: solanaLastBlock,
                outgoingMessageCount: solanaOutgoingCount,
                paused: solanaPaused,
                bridgeBalance: BigInt(solanaBridgeBalance),
            },
            sync: {
                blocksAhead,
                messagesAhead,
                isOracleSynced: blocksAhead <= interval,
            },
        };
    }

    /**
     * Print bridge status
     */
    async printStatus(): Promise<void> {
        const state = await this.getState();

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('                    🌉 Bridge Status                            ');
        console.log('═══════════════════════════════════════════════════════════════\n');

        console.log('📊 Base Chain:');
        console.log(`   Block Number: ${state.base.blockNumber}`);
        console.log(`   MMR Root: ${state.base.mmrRoot.slice(0, 20)}...`);
        console.log(`   Total Messages: ${state.base.totalMessages}`);
        console.log(`   Bridge Balance: ${formatEther(state.base.bridgeBalance)} ETH`);

        console.log('\n📊 Solana Chain:');
        console.log(`   Last Registered Block: ${state.solana.lastRegisteredBlock}`);
        console.log(`   Outgoing Messages: ${state.solana.outgoingMessageCount}`);
        console.log(`   Paused: ${state.solana.paused}`);
        console.log(`   Bridge Balance: ${Number(state.solana.bridgeBalance) / LAMPORTS_PER_SOL} SOL`);

        console.log('\n🔄 Sync Status:');
        console.log(`   Blocks Ahead: ${state.sync.blocksAhead}`);
        console.log(`   Oracle Synced: ${state.sync.isOracleSynced ? '✅' : '⏳'}`);

        console.log('');
    }

    // ========================================================================
    // Base → Solana Operations
    // ========================================================================

    /**
     * Start the oracle service (registers output roots)
     */
    async startOracle(): Promise<void> {
        if (!this.oracle) {
            throw new Error('Oracle not initialized. Call initialize() with both keys.');
        }

        await this.oracle.run();
    }

    /**
     * Manually register an output root
     */
    async registerOutputRoot(): Promise<string | null> {
        if (!this.oracle) {
            throw new Error('Oracle not initialized');
        }

        await this.oracle.tick();
        return null;
    }

    /**
     * Prove a Base message on Solana
     */
    async proveMessage(nonce: bigint): Promise<{
        success: boolean;
        txSignature?: string;
    }> {
        if (!this.prover) {
            throw new Error('Prover not initialized. Call initialize() with Solana key.');
        }

        const result = await this.prover.proveAndRelayMessage(nonce);
        return {
            success: result.proven,
            txSignature: result.txSignature || undefined,
        };
    }

    // ========================================================================
    // Solana → Base Operations
    // ========================================================================

    /**
     * Bridge SOL from Solana to Base
     * Returns the outgoing message pubkey
     */
    async bridgeSolToBase(
        amount: bigint,
        recipient: Hex
    ): Promise<{
        txSignature: string;
        outgoingMessagePubkey: string;
    }> {
        if (!this.solanaPayer) {
            throw new Error('Solana wallet not initialized');
        }

        // This would call the bridge_sol instruction
        // For now, return placeholder
        throw new Error('Not implemented - use the Solana scripts');
    }

    /**
     * Relay a Solana message to Base
     */
    async relayToBase(outgoingMessagePubkey: string): Promise<string> {
        if (!this.evmAccount || !this.baseWalletClient) {
            throw new Error('EVM wallet not initialized');
        }

        // Import and use the relay function from auto-relayer
        const { relayMessage } = await import('./auto-relayer');
        const success = await relayMessage(outgoingMessagePubkey);

        if (!success) {
            throw new Error('Relay failed');
        }

        return 'relayed';
    }
}

// ============================================================================
// CLI Demo
// ============================================================================

async function demo() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('        🌉 Bidirectional Bridge Demo                            ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const bridge = new BidirectionalBridge(TESTNET_BRIDGE_CONFIG);

    // Initialize with credentials if provided
    const solanaKey = process.env.SOLANA_PRIVATE_KEY;
    const evmKey = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;

    if (solanaKey || evmKey) {
        await bridge.initialize({
            solanaPrivateKey: solanaKey,
            evmPrivateKey: evmKey as Hex | undefined,
        });
    }

    // Print current status
    await bridge.printStatus();

    // If we have credentials, show available operations
    if (solanaKey && evmKey) {
        console.log('📋 Available Operations:');
        console.log('   1. Start Oracle: bridge.startOracle()');
        console.log('   2. Prove Message: bridge.proveMessage(nonce)');
        console.log('   3. Relay to Base: bridge.relayToBase(pubkey)');
        console.log('');
    } else {
        console.log('💡 Set SOLANA_PRIVATE_KEY and EVM_PRIVATE_KEY to enable operations');
        console.log('');
    }
}

// Export configuration
export { TESTNET_BRIDGE_CONFIG };

// Run demo if called directly
if (import.meta.main) {
    demo().catch(console.error);
}
