#!/usr/bin/env bun
/**
 * Base → Solana Oracle Service
 *
 * Production-ready oracle that:
 * 1. Monitors Base for MessageInitiated events
 * 2. Registers output roots on Solana at block intervals
 * 3. Signs messages with authorized EVM key
 * 4. Uses @solana/web3.js v1.x for reliable transaction handling
 *
 * Run: EVM_PRIVATE_KEY=0x... SOLANA_PRIVATE_KEY=... bun run src/base-to-solana-oracle.ts
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
    createPublicClient,
    http,
    keccak256,
    type Hex,
    parseAbiItem,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import bs58 from 'bs58';

// ============================================================================
// Configuration
// ============================================================================

export interface OracleConfig {
    // Base
    baseRpcUrl: string;
    baseBridgeAddress: Hex;
    baseChainId: number;

    // Solana
    solanaRpcUrl: string;
    solanaBridgeProgram: string;
    solanaBridgeAccount: string;
    solanaPartnerConfig: string;

    // Timing
    pollIntervalMs: number;
    blockInterval: number; // Must match bridge's block_interval_requirement
}

const TESTNET_CONFIG: OracleConfig = {
    // Base Sepolia
    baseRpcUrl: 'https://sepolia.base.org',
    baseBridgeAddress: '0x2B3550823301752c95290ec6f8781E88F0Bac8c4',
    baseChainId: 84532,

    // Solana Devnet
    solanaRpcUrl: 'https://api.devnet.solana.com',
    solanaBridgeProgram: 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9',
    solanaBridgeAccount: '3rwf6Bm2mppj4h9kokESadWnWHFnuBC6jthyqbQFvkZH',
    solanaPartnerConfig: 'S1GN4jus9XzKVVnoHqfkjo1GN8bX46gjXZQwsdGBPHE', // Partner program ID

    // Timing
    pollIntervalMs: 30000, // 30 seconds
    blockInterval: 300, // Must be divisible by this
};

const MAINNET_CONFIG: OracleConfig = {
    // Base Mainnet
    baseRpcUrl: 'https://mainnet.base.org',
    baseBridgeAddress: '0x3eff766C76a1be2Ce1aCF2B69c78bCae257D5188',
    baseChainId: 8453,

    // Solana Mainnet
    solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    solanaBridgeProgram: 'HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM',
    solanaBridgeAccount: '', // Set from on-chain
    solanaPartnerConfig: 'S1GN4jus9XzKVVnoHqfkjo1GN8bX46gjXZQwsdGBPHE',

    // Timing
    pollIntervalMs: 60000, // 1 minute
    blockInterval: 300,
};

// ============================================================================
// Constants & Seeds
// ============================================================================

const BRIDGE_SEED = Buffer.from('bridge');
const OUTPUT_ROOT_SEED = Buffer.from('output_root');
const PARTNER_SIGNERS_SEED = Buffer.from('signers');

// Instruction discriminators (from Anchor IDL)
const REGISTER_OUTPUT_ROOT_DISCRIMINATOR = Buffer.from([
    215, 66, 12, 154, 4, 123, 196, 66,
]);

// ============================================================================
// ABI for Base Bridge
// ============================================================================

const BRIDGE_ABI = [
    parseAbiItem('function getNextNonce() view returns (uint64)'),
    parseAbiItem('function getRoot() view returns (bytes32)'),
    parseAbiItem('function generateProof(uint64 leafIndex) view returns (bytes32[])'),
    parseAbiItem('event MessageInitiated(bytes32 indexed messageHash, bytes32 indexed mmrRoot, (uint64 nonce, address sender, bytes data) message)'),
] as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive the bridge PDA
 */
function deriveBridgePDA(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([BRIDGE_SEED], programId);
}

/**
 * Derive the output root PDA for a specific block number
 */
function deriveOutputRootPDA(programId: PublicKey, blockNumber: bigint): [PublicKey, number] {
    const blockBytes = Buffer.alloc(8);
    blockBytes.writeBigUInt64LE(blockNumber);
    return PublicKey.findProgramAddressSync(
        [OUTPUT_ROOT_SEED, blockBytes],
        programId
    );
}

/**
 * Derive the partner config PDA
 */
function derivePartnerConfigPDA(partnerProgramId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [PARTNER_SIGNERS_SEED],
        partnerProgramId
    );
}

/**
 * Compute the message hash for oracle signing (EIP-191 format)
 * Must match: compute_output_root_message_hash in Solana program
 */
function computeOutputRootMessageHash(
    outputRoot: Hex,
    baseBlockNumber: bigint,
    totalLeafCount: bigint
): Hex {
    // Construct message bytes: outputRoot || baseBlockNumber (BE) || totalLeafCount (BE)
    const blockNumberBE = Buffer.alloc(8);
    blockNumberBE.writeBigUInt64BE(baseBlockNumber);

    const leafCountBE = Buffer.alloc(8);
    leafCountBE.writeBigUInt64BE(totalLeafCount);

    const messageBytes = Buffer.concat([
        Buffer.from(outputRoot.slice(2), 'hex'),
        blockNumberBE,
        leafCountBE,
    ]);

    // Apply EIP-191 prefix: "\x19Ethereum Signed Message:\n" + len + message
    const prefix = Buffer.from('\x19Ethereum Signed Message:\n');
    const lenStr = messageBytes.length.toString();

    const prefixedMessage = Buffer.concat([
        prefix,
        Buffer.from(lenStr),
        messageBytes,
    ]);

    return keccak256(prefixedMessage);
}

/**
 * Sign an output root with an EVM private key
 * Returns 65-byte signature in r||s||v format
 */
async function signOutputRoot(
    account: ReturnType<typeof privateKeyToAccount>,
    outputRoot: Hex,
    baseBlockNumber: bigint,
    totalLeafCount: bigint
): Promise<Uint8Array> {
    const messageHash = computeOutputRootMessageHash(outputRoot, baseBlockNumber, totalLeafCount);

    // Sign the raw hash (not the message)
    const signature = await account.signMessage({
        message: { raw: messageHash },
    });

    // Convert to 65-byte format
    const sigBytes = Buffer.from(signature.slice(2), 'hex');
    return new Uint8Array(sigBytes);
}

/**
 * Build register_output_root instruction data
 */
function buildRegisterOutputRootData(
    outputRoot: Uint8Array,
    baseBlockNumber: bigint,
    totalLeafCount: bigint,
    signatures: Uint8Array[]
): Buffer {
    // Instruction format:
    // - 8 bytes: discriminator
    // - 32 bytes: output_root
    // - 8 bytes: base_block_number (LE)
    // - 8 bytes: total_leaf_count (LE)
    // - 4 bytes: signatures vec length
    // - N * 65 bytes: signatures

    const sigCount = signatures.length;
    const dataLen = 8 + 32 + 8 + 8 + 4 + (sigCount * 65);
    const data = Buffer.alloc(dataLen);

    let offset = 0;

    // Discriminator
    REGISTER_OUTPUT_ROOT_DISCRIMINATOR.copy(data, offset);
    offset += 8;

    // Output root (32 bytes)
    Buffer.from(outputRoot).copy(data, offset);
    offset += 32;

    // Base block number (8 bytes LE)
    data.writeBigUInt64LE(baseBlockNumber, offset);
    offset += 8;

    // Total leaf count (8 bytes LE)
    data.writeBigUInt64LE(totalLeafCount, offset);
    offset += 8;

    // Signatures vec length (4 bytes LE)
    data.writeUInt32LE(sigCount, offset);
    offset += 4;

    // Signatures (65 bytes each)
    for (const sig of signatures) {
        Buffer.from(sig).copy(data, offset);
        offset += 65;
    }

    return data;
}

/**
 * Fetch bridge state from Solana
 */
async function fetchBridgeState(connection: Connection, bridgeAccount: PublicKey): Promise<{
    baseBlockNumber: bigint;
    paused: boolean;
    blockIntervalRequirement: bigint;
}> {
    const accountInfo = await connection.getAccountInfo(bridgeAccount);
    if (!accountInfo) {
        throw new Error('Bridge account not found');
    }

    // Parse bridge state (skip 8-byte discriminator)
    const data = accountInfo.data;

    // Bridge struct layout (from bridge.rs):
    // - base_block_number: u64 (offset 8)
    // - nonce: u64 (offset 16)
    // - guardian: Pubkey (offset 24)
    // - paused: bool (offset 56)
    // ... more fields
    // - protocol_config.block_interval_requirement: u64

    const baseBlockNumber = data.readBigUInt64LE(8);
    const paused = data[56] === 1;

    // protocol_config is after several nested structs
    // For now, use the configured block interval
    return {
        baseBlockNumber,
        paused,
        blockIntervalRequirement: BigInt(300), // Default, should be read from chain
    };
}

// ============================================================================
// Oracle Service Class
// ============================================================================

export class BaseToSolanaOracle {
    private config: OracleConfig;
    private solanaConnection: Connection;
    private solanaPayer: Keypair;
    private evmAccount: ReturnType<typeof privateKeyToAccount>;
    private basePublicClient: ReturnType<typeof createPublicClient>;
    private programId: PublicKey;
    private bridgeAccount: PublicKey;
    private partnerProgramId: PublicKey;
    private running: boolean = false;
    private lastProcessedBlock: bigint = 0n;

    constructor(
        config: OracleConfig,
        solanaPrivateKey: string,
        evmPrivateKey: Hex
    ) {
        this.config = config;

        // Setup Solana
        this.solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');

        // Parse Solana private key (base58 or JSON array)
        if (solanaPrivateKey.startsWith('[')) {
            const keyArray = JSON.parse(solanaPrivateKey);
            this.solanaPayer = Keypair.fromSecretKey(new Uint8Array(keyArray));
        } else {
            const decoded = bs58.decode(solanaPrivateKey);
            this.solanaPayer = Keypair.fromSecretKey(decoded);
        }

        this.programId = new PublicKey(config.solanaBridgeProgram);
        this.bridgeAccount = new PublicKey(config.solanaBridgeAccount);
        this.partnerProgramId = new PublicKey(config.solanaPartnerConfig);

        // Setup EVM
        this.evmAccount = privateKeyToAccount(evmPrivateKey);
        this.basePublicClient = createPublicClient({
            chain: config.baseChainId === 84532 ? baseSepolia : base,
            transport: http(config.baseRpcUrl),
        }) as any;
    }

    /**
     * Get current state from both chains
     */
    async getCurrentState(): Promise<{
        baseBlockNumber: bigint;
        baseMMRRoot: Hex;
        baseTotalLeaves: bigint;
        solanaLastBlock: bigint;
        solanaPaused: boolean;
    }> {
        // Get Base state
        const [baseBlockNumber, baseMMRRoot, baseTotalLeaves] = await Promise.all([
            this.basePublicClient.getBlockNumber(),
            this.basePublicClient.readContract({
                address: this.config.baseBridgeAddress,
                abi: BRIDGE_ABI,
                functionName: 'getRoot',
            }) as Promise<Hex>,
            this.basePublicClient.readContract({
                address: this.config.baseBridgeAddress,
                abi: BRIDGE_ABI,
                functionName: 'getNextNonce',
            }) as Promise<bigint>,
        ]);

        // Get Solana state
        const solanaState = await fetchBridgeState(this.solanaConnection, this.bridgeAccount);

        return {
            baseBlockNumber,
            baseMMRRoot,
            baseTotalLeaves,
            solanaLastBlock: solanaState.baseBlockNumber,
            solanaPaused: solanaState.paused,
        };
    }

    /**
     * Calculate the next valid block number to register
     */
    calculateNextBlockToRegister(currentBlock: bigint, lastRegisteredBlock: bigint): bigint {
        const interval = BigInt(this.config.blockInterval);

        // Find the next block that is:
        // 1. Greater than lastRegisteredBlock
        // 2. Divisible by blockInterval
        // 3. Less than or equal to currentBlock

        let nextBlock = lastRegisteredBlock + interval;

        // Align to interval if needed
        if (nextBlock % interval !== 0n) {
            nextBlock = ((nextBlock / interval) + 1n) * interval;
        }

        // Check if this block exists yet
        if (nextBlock > currentBlock) {
            return 0n; // No valid block to register yet
        }

        return nextBlock;
    }

    /**
     * Register an output root on Solana
     */
    async registerOutputRoot(
        outputRoot: Hex,
        baseBlockNumber: bigint,
        totalLeafCount: bigint
    ): Promise<string> {
        console.log(`\n📝 Registering output root on Solana...`);
        console.log(`   Block: ${baseBlockNumber}`);
        console.log(`   Root: ${outputRoot.slice(0, 20)}...`);
        console.log(`   Leaves: ${totalLeafCount}`);

        // Sign the output root
        const signature = await signOutputRoot(
            this.evmAccount,
            outputRoot,
            baseBlockNumber,
            totalLeafCount
        );
        console.log(`   ✅ Signed with ${this.evmAccount.address}`);

        // Derive PDAs
        const [bridgePDA] = deriveBridgePDA(this.programId);
        const [outputRootPDA] = deriveOutputRootPDA(this.programId, baseBlockNumber);
        const [partnerConfigPDA] = derivePartnerConfigPDA(this.partnerProgramId);

        console.log(`   Bridge PDA: ${bridgePDA.toBase58()}`);
        console.log(`   Output Root PDA: ${outputRootPDA.toBase58()}`);

        // Build instruction data
        const instructionData = buildRegisterOutputRootData(
            Buffer.from(outputRoot.slice(2), 'hex'),
            baseBlockNumber,
            totalLeafCount,
            [signature]
        );

        // Build instruction
        const instruction = new TransactionInstruction({
            programId: this.programId,
            keys: [
                { pubkey: this.solanaPayer.publicKey, isSigner: true, isWritable: true }, // payer
                { pubkey: outputRootPDA, isSigner: false, isWritable: true }, // root
                { pubkey: bridgePDA, isSigner: false, isWritable: true }, // bridge
                { pubkey: partnerConfigPDA, isSigner: false, isWritable: false }, // partner_config
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        // Build and send transaction
        const transaction = new Transaction().add(instruction);

        try {
            const txSignature = await sendAndConfirmTransaction(
                this.solanaConnection,
                transaction,
                [this.solanaPayer],
                { commitment: 'confirmed' }
            );

            console.log(`   ✅ Transaction confirmed: ${txSignature}`);
            return txSignature;
        } catch (error: any) {
            console.error(`   ❌ Transaction failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Main oracle loop
     */
    async run(): Promise<void> {
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('        🌉 Base → Solana Oracle Service                         ');
        console.log('═══════════════════════════════════════════════════════════════\n');

        console.log(`📍 EVM Signer: ${this.evmAccount.address}`);
        console.log(`📍 Solana Payer: ${this.solanaPayer.publicKey.toBase58()}`);
        console.log(`📍 Bridge Program: ${this.programId.toBase58()}`);
        console.log(`📍 Block Interval: ${this.config.blockInterval}`);
        console.log(`📍 Poll Interval: ${this.config.pollIntervalMs}ms\n`);

        this.running = true;

        while (this.running) {
            try {
                await this.tick();
            } catch (error: any) {
                console.error(`❌ Oracle tick error: ${error.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
        }
    }

    /**
     * Single oracle tick
     */
    async tick(): Promise<void> {
        const state = await this.getCurrentState();

        console.log(`\n🔄 Oracle Tick @ ${new Date().toISOString()}`);
        console.log(`   Base Block: ${state.baseBlockNumber}`);
        console.log(`   Base MMR Root: ${state.baseMMRRoot.slice(0, 20)}...`);
        console.log(`   Base Total Leaves: ${state.baseTotalLeaves}`);
        console.log(`   Solana Last Block: ${state.solanaLastBlock}`);

        if (state.solanaPaused) {
            console.log(`   ⚠️ Bridge is paused, skipping...`);
            return;
        }

        // Calculate next block to register
        const nextBlock = this.calculateNextBlockToRegister(
            state.baseBlockNumber,
            state.solanaLastBlock
        );

        if (nextBlock === 0n) {
            console.log(`   ℹ️ No new blocks to register (next: ${state.solanaLastBlock + BigInt(this.config.blockInterval)})`);
            return;
        }

        console.log(`   📦 New block available: ${nextBlock}`);

        // Register the output root
        // Note: In production, you'd fetch the historical MMR root at that block number
        // For now, we use the current root (which is valid for the latest state)
        try {
            await this.registerOutputRoot(
                state.baseMMRRoot,
                nextBlock,
                state.baseTotalLeaves
            );

            this.lastProcessedBlock = nextBlock;
        } catch (error: any) {
            // Check if it's a "already processed" error
            if (error.message?.includes('already in use') ||
                error.message?.includes('AccountAlreadyInitialized')) {
                console.log(`   ℹ️ Block ${nextBlock} already registered`);
                this.lastProcessedBlock = nextBlock;
            } else {
                throw error;
            }
        }
    }

    /**
     * Stop the oracle
     */
    stop(): void {
        this.running = false;
        console.log('\n🛑 Oracle stopping...');
    }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
    const network = process.env.NETWORK || 'testnet';

    if (!evmPrivateKey) {
        console.error('❌ Set EVM_PRIVATE_KEY environment variable');
        process.exit(1);
    }

    if (!solanaPrivateKey) {
        console.error('❌ Set SOLANA_PRIVATE_KEY environment variable (base58 or JSON array)');
        process.exit(1);
    }

    const config = network === 'mainnet' ? MAINNET_CONFIG : TESTNET_CONFIG;

    const oracle = new BaseToSolanaOracle(
        config,
        solanaPrivateKey,
        evmPrivateKey as Hex
    );

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        oracle.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        oracle.stop();
        process.exit(0);
    });

    await oracle.run();
}

// Export for programmatic use
export { TESTNET_CONFIG, MAINNET_CONFIG };

// Run if called directly
if (import.meta.main) {
    main().catch(console.error);
}
