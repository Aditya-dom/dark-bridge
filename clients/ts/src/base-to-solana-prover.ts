#!/usr/bin/env bun
/**
 * Base → Solana Message Prover & Finalizer
 *
 * This module handles:
 * 1. Fetching MMR proofs from Base
 * 2. Proving messages on Solana via prove_message instruction
 * 3. Finalizing token transfers (SOL, SPL, wrapped tokens)
 *
 * Run: SOLANA_PRIVATE_KEY=... bun run src/base-to-solana-prover.ts <message_hash>
 */

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import {
    createPublicClient,
    http,
    keccak256,
    type Hex,
    parseAbiItem,
} from 'viem';
import { baseSepolia, base } from 'viem/chains';
import bs58 from 'bs58';

// ============================================================================
// Configuration
// ============================================================================

export interface ProverConfig {
    baseRpcUrl: string;
    baseBridgeAddress: Hex;
    baseChainId: number;
    solanaRpcUrl: string;
    solanaBridgeProgram: string;
}

const TESTNET_CONFIG: ProverConfig = {
    baseRpcUrl: 'https://sepolia.base.org',
    baseBridgeAddress: '0x2B3550823301752c95290ec6f8781E88F0Bac8c4',
    baseChainId: 84532,
    solanaRpcUrl: 'https://api.devnet.solana.com',
    solanaBridgeProgram: 'EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9',
};

// ============================================================================
// Constants & Seeds
// ============================================================================

const BRIDGE_SEED = Buffer.from('bridge');
const INCOMING_MESSAGE_SEED = Buffer.from('incoming_message');
const OUTPUT_ROOT_SEED = Buffer.from('output_root');

// Instruction discriminators
const PROVE_MESSAGE_DISCRIMINATOR = Buffer.from([
    167, 168, 193, 199, 157, 253, 144, 130,
]);

const FINALIZE_SOL_TRANSFER_DISCRIMINATOR = Buffer.from([
    97, 156, 255, 75, 169, 90, 180, 107,
]);

const FINALIZE_SPL_TRANSFER_DISCRIMINATOR = Buffer.from([
    45, 181, 153, 29, 197, 218, 216, 190,
]);

const RELAY_MESSAGE_DISCRIMINATOR = Buffer.from([
    47, 0, 172, 148, 136, 116, 179, 85,
]);

// ============================================================================
// Base Bridge ABI
// ============================================================================

const BRIDGE_ABI = [
    parseAbiItem('function getNextNonce() view returns (uint64)'),
    parseAbiItem('function getRoot() view returns (bytes32)'),
    parseAbiItem('function generateProof(uint64 leafIndex) view returns (bytes32[] memory)'),
    parseAbiItem('event MessageInitiated(bytes32 indexed messageHash, bytes32 indexed mmrRoot, (uint64 nonce, address sender, bytes data) message)'),
] as const;

// ============================================================================
// Types
// ============================================================================

export interface BaseMessage {
    nonce: bigint;
    sender: Hex;
    data: Hex;
    messageHash: Hex;
}

export interface MMRProof {
    proof: Hex[];
    root: Hex;
    totalLeafCount: bigint;
}

export interface ProvenMessage {
    messageHash: Hex;
    sender: Hex;
    executed: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Derive bridge PDA
 */
function deriveBridgePDA(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([BRIDGE_SEED], programId);
}

/**
 * Derive incoming message PDA
 */
function deriveIncomingMessagePDA(programId: PublicKey, messageHash: Hex): [PublicKey, number] {
    const hashBytes = Buffer.from(messageHash.slice(2), 'hex');
    return PublicKey.findProgramAddressSync(
        [INCOMING_MESSAGE_SEED, hashBytes],
        programId
    );
}

/**
 * Derive output root PDA
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
 * Compute message hash matching Base's _hashMessage
 */
function computeMessageHash(nonce: bigint, sender: Hex, data: Hex): Hex {
    // keccak256(abi.encodePacked(nonce, sender, data))
    const nonceBytes = Buffer.alloc(8);
    nonceBytes.writeBigUInt64BE(nonce);

    const packed = Buffer.concat([
        nonceBytes,
        Buffer.from(sender.slice(2), 'hex'),
        Buffer.from(data.slice(2), 'hex'),
    ]);

    return keccak256(packed);
}

/**
 * Serialize Borsh-encoded Message for Solana
 * The Message enum has variants: Transfer, Call
 */
function serializeMessageData(data: Hex): Buffer {
    // For now, pass the raw data - the Solana program will deserialize
    return Buffer.from(data.slice(2), 'hex');
}

// ============================================================================
// Prover Class
// ============================================================================

export class BaseToSolanaProver {
    private config: ProverConfig;
    private solanaConnection: Connection;
    private solanaPayer: Keypair;
    private basePublicClient: ReturnType<typeof createPublicClient>;
    private programId: PublicKey;

    constructor(config: ProverConfig, solanaPrivateKey: string) {
        this.config = config;

        // Setup Solana
        this.solanaConnection = new Connection(config.solanaRpcUrl, 'confirmed');

        if (solanaPrivateKey.startsWith('[')) {
            const keyArray = JSON.parse(solanaPrivateKey);
            this.solanaPayer = Keypair.fromSecretKey(new Uint8Array(keyArray));
        } else {
            const decoded = bs58.decode(solanaPrivateKey);
            this.solanaPayer = Keypair.fromSecretKey(decoded);
        }

        this.programId = new PublicKey(config.solanaBridgeProgram);

        // Setup Base client
        this.basePublicClient = createPublicClient({
            chain: config.baseChainId === 84532 ? baseSepolia : base,
            transport: http(config.baseRpcUrl),
        }) as any;
    }

    /**
     * Fetch message details from Base by transaction hash or event logs
     */
    async fetchMessageFromBase(nonce: bigint): Promise<BaseMessage | null> {
        // Get the message from events
        const logs = await this.basePublicClient.getLogs({
            address: this.config.baseBridgeAddress,
            event: parseAbiItem('event MessageInitiated(bytes32 indexed messageHash, bytes32 indexed mmrRoot, (uint64 nonce, address sender, bytes data) message)'),
            fromBlock: 'earliest',
            toBlock: 'latest',
        });

        for (const log of logs) {
            const args = log.args as any;
            if (args.message && BigInt(args.message.nonce) === nonce) {
                return {
                    nonce: BigInt(args.message.nonce),
                    sender: args.message.sender as Hex,
                    data: args.message.data as Hex,
                    messageHash: args.messageHash as Hex,
                };
            }
        }

        return null;
    }

    /**
     * Generate MMR proof from Base contract
     */
    async generateMMRProof(leafIndex: bigint): Promise<MMRProof> {
        const [proof, root, totalLeaves] = await Promise.all([
            this.basePublicClient.readContract({
                address: this.config.baseBridgeAddress,
                abi: BRIDGE_ABI,
                functionName: 'generateProof',
                args: [leafIndex],
            }) as Promise<Hex[]>,
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

        return {
            proof,
            root,
            totalLeafCount: totalLeaves,
        };
    }

    /**
     * Find the output root account for a given message
     * Returns the block number that has a registered output root >= message nonce
     */
    async findOutputRootForMessage(messageNonce: bigint, blockInterval: bigint = 300n): Promise<{
        blockNumber: bigint;
        outputRootPDA: PublicKey;
    } | null> {
        // Try to find an output root that covers this message
        // Start from the nonce rounded up to the next interval
        let blockNumber = ((messageNonce / blockInterval) + 1n) * blockInterval;

        // Try a few intervals to find a registered output root
        for (let i = 0; i < 10; i++) {
            const [outputRootPDA] = deriveOutputRootPDA(this.programId, blockNumber);

            try {
                const accountInfo = await this.solanaConnection.getAccountInfo(outputRootPDA);
                if (accountInfo && accountInfo.data.length > 0) {
                    return { blockNumber, outputRootPDA };
                }
            } catch {
                // Account doesn't exist, try next
            }

            blockNumber += blockInterval;
        }

        return null;
    }

    /**
     * Build prove_message instruction data
     */
    buildProveMessageData(
        nonce: bigint,
        sender: Hex,
        data: Hex,
        proof: Hex[],
        messageHash: Hex
    ): Buffer {
        // Instruction format:
        // - 8 bytes: discriminator
        // - 8 bytes: nonce (u64 LE)
        // - 20 bytes: sender ([u8; 20])
        // - 4 bytes + N: data (Vec<u8>)
        // - 4 bytes + N*32: proof (Vec<[u8; 32]>)
        // - 32 bytes: message_hash ([u8; 32])

        const dataBytes = Buffer.from(data.slice(2), 'hex');
        const proofBytes = proof.map(p => Buffer.from(p.slice(2), 'hex'));

        const totalLen = 8 + 8 + 20 + 4 + dataBytes.length + 4 + (proofBytes.length * 32) + 32;
        const buffer = Buffer.alloc(totalLen);

        let offset = 0;

        // Discriminator
        PROVE_MESSAGE_DISCRIMINATOR.copy(buffer, offset);
        offset += 8;

        // Nonce (u64 LE)
        buffer.writeBigUInt64LE(nonce, offset);
        offset += 8;

        // Sender (20 bytes)
        Buffer.from(sender.slice(2), 'hex').copy(buffer, offset);
        offset += 20;

        // Data (Vec<u8>)
        buffer.writeUInt32LE(dataBytes.length, offset);
        offset += 4;
        dataBytes.copy(buffer, offset);
        offset += dataBytes.length;

        // Proof (Vec<[u8; 32]>)
        buffer.writeUInt32LE(proofBytes.length, offset);
        offset += 4;
        for (const p of proofBytes) {
            p.copy(buffer, offset);
            offset += 32;
        }

        // Message hash (32 bytes)
        Buffer.from(messageHash.slice(2), 'hex').copy(buffer, offset);

        return buffer;
    }

    /**
     * Prove a message on Solana
     */
    async proveMessage(
        message: BaseMessage,
        outputRootPDA: PublicKey,
        proof: Hex[]
    ): Promise<string> {
        console.log(`\n📋 Proving message on Solana...`);
        console.log(`   Nonce: ${message.nonce}`);
        console.log(`   Sender: ${message.sender}`);
        console.log(`   Hash: ${message.messageHash.slice(0, 20)}...`);
        console.log(`   Proof elements: ${proof.length}`);

        const [bridgePDA] = deriveBridgePDA(this.programId);
        const [incomingMessagePDA] = deriveIncomingMessagePDA(this.programId, message.messageHash);

        console.log(`   Bridge PDA: ${bridgePDA.toBase58()}`);
        console.log(`   Message PDA: ${incomingMessagePDA.toBase58()}`);
        console.log(`   Output Root PDA: ${outputRootPDA.toBase58()}`);

        // Build instruction data
        const instructionData = this.buildProveMessageData(
            message.nonce,
            message.sender,
            message.data,
            proof,
            message.messageHash
        );

        // Build instruction
        const instruction = new TransactionInstruction({
            programId: this.programId,
            keys: [
                { pubkey: this.solanaPayer.publicKey, isSigner: true, isWritable: true }, // payer
                { pubkey: outputRootPDA, isSigner: false, isWritable: false }, // output_root
                { pubkey: incomingMessagePDA, isSigner: false, isWritable: true }, // message
                { pubkey: bridgePDA, isSigner: false, isWritable: false }, // bridge
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        // Add compute budget for complex proof verification
        const computeBudget = ComputeBudgetProgram.setComputeUnitLimit({
            units: 400000,
        });

        const transaction = new Transaction()
            .add(computeBudget)
            .add(instruction);

        try {
            const txSignature = await sendAndConfirmTransaction(
                this.solanaConnection,
                transaction,
                [this.solanaPayer],
                { commitment: 'confirmed' }
            );

            console.log(`   ✅ Message proven: ${txSignature}`);
            return txSignature;
        } catch (error: any) {
            if (error.message?.includes('already in use')) {
                console.log(`   ℹ️ Message already proven`);
                return 'already_proven';
            }
            throw error;
        }
    }

    /**
     * Check if a message has been proven on Solana
     */
    async isMessageProven(messageHash: Hex): Promise<boolean> {
        const [incomingMessagePDA] = deriveIncomingMessagePDA(this.programId, messageHash);

        try {
            const accountInfo = await this.solanaConnection.getAccountInfo(incomingMessagePDA);
            return accountInfo !== null && accountInfo.data.length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Full prove and relay flow for a message
     */
    async proveAndRelayMessage(nonce: bigint): Promise<{
        proven: boolean;
        txSignature: string | null;
    }> {
        console.log(`\n🔄 Processing message with nonce ${nonce}...`);

        // 1. Fetch message from Base
        const message = await this.fetchMessageFromBase(nonce);
        if (!message) {
            console.log(`   ❌ Message not found on Base`);
            return { proven: false, txSignature: null };
        }

        // 2. Check if already proven
        const alreadyProven = await this.isMessageProven(message.messageHash);
        if (alreadyProven) {
            console.log(`   ℹ️ Message already proven on Solana`);
            return { proven: true, txSignature: 'already_proven' };
        }

        // 3. Find output root
        const outputRoot = await this.findOutputRootForMessage(nonce);
        if (!outputRoot) {
            console.log(`   ⏳ No output root available yet. Oracle needs to register.`);
            return { proven: false, txSignature: null };
        }

        // 4. Generate MMR proof
        const proof = await this.generateMMRProof(nonce);
        console.log(`   📦 Generated proof with ${proof.proof.length} elements`);

        // 5. Prove on Solana
        const txSignature = await this.proveMessage(
            message,
            outputRoot.outputRootPDA,
            proof.proof
        );

        return { proven: true, txSignature };
    }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
    const nonceArg = process.argv[2];

    if (!solanaPrivateKey) {
        console.error('❌ Set SOLANA_PRIVATE_KEY environment variable');
        process.exit(1);
    }

    if (!nonceArg) {
        console.error('Usage: bun run src/base-to-solana-prover.ts <nonce>');
        process.exit(1);
    }

    const nonce = BigInt(nonceArg);
    const prover = new BaseToSolanaProver(TESTNET_CONFIG, solanaPrivateKey);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('        📬 Base → Solana Message Prover                         ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const result = await prover.proveAndRelayMessage(nonce);

    if (result.proven) {
        console.log(`\n✅ Message proven successfully!`);
        console.log(`   Transaction: ${result.txSignature}`);
    } else {
        console.log(`\n⚠️ Message not proven. Check output above for details.`);
    }
}

export { TESTNET_CONFIG as PROVER_TESTNET_CONFIG };

if (import.meta.main) {
    main().catch(console.error);
}
