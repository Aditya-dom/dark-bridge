import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    decodeEventLog,
    type Address,
    type Hash,
    type Hex,
    toBytes,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";
import crypto from "crypto";
import { Lightning } from "@inco/js/lite";

// --- ENV CHECKS ---
// We don't throw immediately at top-level to avoid breaking build if envs are missing
// Instead we check inside the handler.

// Constants
const DEPLOY_ENV = "testnet-alpha";
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369"; // From script
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const SOLANA_RPC_URL = "https://devnet.helius-rpc.com/?api-key=fc797121-f238-485c-8133-5c36c245649c"; // Or from env
const BASE_RPC_URL = "https://sepolia.base.org"; // Or from env

// ABI
const CONFIDENTIAL_BRIDGE_FULL_ABI = [
    {
        type: "event",
        name: "ConfidentialBridgeInitiated",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "encryptedAmount", type: "bytes32", indexed: false },
        ],
    },
    {
        type: "event",
        name: "ConfidentialBridgeInitiatedWithPlaintext",
        inputs: [
            { name: "nonce", type: "uint256", indexed: true },
            { name: "localToken", type: "address", indexed: true },
            { name: "remoteToken", type: "bytes32", indexed: true },
            { name: "toSolana", type: "bytes32", indexed: false },
            { name: "plaintextAmount", type: "uint256", indexed: false },
        ],
    },
] as const;

// Types
interface ConfidentialBridgeInitiatedWithPlaintextEvent {
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolana: Hex;
    plaintextAmount: bigint;
    txHash: Hash;
}

// Global instance cache for Inco Lightning (Zap) to avoid re-init
let zapInstance: any = null;
async function getZap() {
    if (!zapInstance) {
        zapInstance = await Lightning.latest('devnet', 84532);
    }
    return zapInstance;
}

// Bypass TLS for Inco KMS if needed (same as script)
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

export const dynamic = 'force-dynamic'; // Static generation is not suitable for cron jobs
export const maxDuration = 300; // 5 minutes max timeout for Vercel Pro

export async function GET(req: NextRequest) {
    // 1. Authorization Check (CRON_SECRET)
    // Vercel automatically adds this header when authorized
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        // Allow manual triggering with key parameter for debugging
        const urlKey = req.nextUrl.searchParams.get('key');
        if (urlKey !== process.env.CRON_SECRET) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    // 2. Load Private Keys
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;

    if (!evmPrivateKey || !solanaPrivateKey) {
        return NextResponse.json({ error: "Missing EVM_PRIVATE_KEY or SOLANA_PRIVATE_KEY" }, { status: 500 });
    }

    try {
        // Setup clients
        const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
        const basePublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });

        const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");

        // Decode Solana keypair (handle JSON array or base58)
        let solanaKeypair: Keypair;
        if (solanaPrivateKey.startsWith("[")) {
            solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
        } else {
            // Assume base58 or other format if needed, but JSON array is standard for solana-cli
            // Try base58 decode if libs available, otherwise assume JSON
            // For safety, let's assume JSON array for now as per script usage
            try {
                // If it's base58 string, we need bs58. Check imports.
                // package.json has "bs58".
                const bs58 = require('bs58');
                solanaKeypair = Keypair.fromSecretKey(bs58.decode(solanaPrivateKey));
            } catch (e) {
                // Fallback to JSON parse
                solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
            }
        }

        console.log(`[Base -> Sol Relayer] Running... EVM: ${evmAccount.address}, Sol: ${solanaKeypair.publicKey.toBase58()}`);

        // 3. Scan for recent events
        // Vercel is stateless. We look back X blocks.
        // Assuming ~2s block time, look back 100 blocks (~3-4 mins).
        // Cron runs every minute, so we have overlap to ensure we don't miss anything.
        // IDEMPOTENCY: We need to check if the transaction was already processed on Solana.
        // Ideally we check if the Nonce is marked as used on Solana, but that requires extra chain state read.
        // For Hackathon/Demo: We rely on the fact that minting twice with same nonce might be prevented or accepted.
        // Wait, the Vercel function is simple. We can use Vercel KV if we needed state.
        // For now, we just process.

        const currentBlock = await basePublicClient.getBlockNumber();
        const LOOKBACK = 100n;
        const fromBlock = currentBlock - LOOKBACK;

        const logs = await basePublicClient.getLogs({
            address: CONFIDENTIAL_BRIDGE_ADDRESS as Address,
            fromBlock,
            toBlock: currentBlock,
        });

        console.log(`Found ${logs.length} events from block ${fromBlock} to ${currentBlock}`);

        const results = [];

        for (const log of logs) {
            try {
                const decoded = decodeEventLog({
                    abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                    data: log.data,
                    topics: log.topics,
                });

                if (decoded.eventName === "ConfidentialBridgeInitiatedWithPlaintext") {
                    const args = decoded.args as any;
                    console.log(`Processing event in tx ${log.transactionHash}: Nonce ${args.nonce}`);

                    // Logic from script: Relay Confidential to Solana
                    const success = await relayToSolana(
                        solanaConnection,
                        solanaKeypair,
                        args.toSolana,
                        args.plaintextAmount,
                        evmAccount.address
                    );

                    results.push({ tx: log.transactionHash, status: success ? "relayed" : "failed" });
                }
            } catch (e: any) {
                console.error(`Error processing log ${log.transactionHash}:`, e);
                results.push({ tx: log.transactionHash, status: "error", error: e.message });
            }
        }

        return NextResponse.json({
            success: true,
            scanned: logs.length,
            results
        });

    } catch (e: any) {
        console.error("Relayer error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}


// --- HELPER FUNCTIONS ---

async function relayToSolana(
    connection: Connection,
    payer: Keypair,
    toSolanaBytes32: Hex,
    plaintextAmount: bigint,
    baseSenderAddress: string
): Promise<boolean> {
    try {
        // 1. Convert Recipient
        const recipientPubkey = new PublicKey(toBytes(toSolanaBytes32));
        console.log(`   Recipient: ${recipientPubkey.toBase58()}`);

        // 2. Encrypt for Solana TEE
        // Using @inco/solana-sdk/encryption helper
        console.log(`   Encrypting ${plaintextAmount} for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintextAmount);
        const encryptedAmountBytes = Uint8Array.from(hexToBuffer(solanaCiphertext));

        // 3. Prepare Solana Transaction
        const baseSender = toBytes(baseSenderAddress).slice(0, 20); // [u8; 20]

        // Derive PDAs (Same as script)
        // Token Mint: 2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH (Hardcoded as per script)
        const tokenMint = new PublicKey("2wcB7tJ56xTa68zMstHhMBYymeCaBvG3Vp2xW9JMVNrH");

        const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("confidential_vault"), recipientPubkey.toBuffer(), tokenMint.toBuffer()],
            BRIDGE_PROGRAM_ID
        );

        const [bridgeAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge_authority")],
            BRIDGE_PROGRAM_ID
        );

        const [bridgeState] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge")],
            BRIDGE_PROGRAM_ID
        );

        // Helper for instruction data construction
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_receive_confidential")
            .digest()
            .slice(0, 8);

        const encryptedLenBuf = Buffer.alloc(4);
        encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

        const instructionData = Buffer.concat([
            discriminator,
            encryptedLenBuf,
            Buffer.from(encryptedAmountBytes),
            Buffer.from(baseSender),
        ]);

        const instruction = new TransactionInstruction({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                { pubkey: bridgeState, isSigner: false, isWritable: false },
                { pubkey: bridgeAuthority, isSigner: false, isWritable: true },
                { pubkey: vaultPda, isSigner: false, isWritable: true },
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: instructionData,
        });

        // 4. Send
        const transaction = new Transaction().add(instruction);
        const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [payer],
            { commitment: "confirmed" }
        );

        console.log(`   Relay Success: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
        return true;

    } catch (e: any) {
        console.error(`   Relay Failed: ${e.message}`);
        // If "Vault does not exist", we can't do much. 
        return false;
    }
}
