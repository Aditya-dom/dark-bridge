#!/usr/bin/env bun
/**
 * Privacy Relayer Server: Base ↔ Solana
 * 
 * HTTP server that handles bidirectional cross-chain bridging:
 * 
 * BASE → SOLANA:
 * 1. User bridges on Base → encrypted handle emitted on-chain
 * 2. Frontend sends known plaintext amount to POST /relay
 * 3. Relayer re-encrypts for Solana TEE and relays to Solana program
 * 
 * SOLANA → BASE:
 * 1. User bridges on Solana → encrypted handle emitted on-chain
 * 2. Frontend calls Solana attested decrypt to get plaintext
 * 3. Frontend sends plaintext to POST /relay-to-base
 * 4. Relayer re-encrypts for EVM (Inco) and calls faucetMint
 * 
 * TRUST MODEL:
 * The relayer sees the plaintext amount during cross-chain re-encryption.
 * This is architecturally necessary — Inco FHE handles cannot transfer between
 * EVM and Solana without decrypt → re-encrypt. For production, this relayer
 * should run inside a TEE (e.g., AWS Nitro Enclaves, Intel SGX) so even the
 * operator cannot read the plaintext from memory.
 * 
 * PRIVACY GUARANTEES:
 * - On-chain: All amounts are encrypted (euint256 on EVM, Euint128 on Solana)
 * - From public observers: No one can see amounts, balances, or vault owners
 * - Total supply: Fully encrypted (no e.reveal)
 * - From the relayer: The relayer learns plaintext amounts (unavoidable for now)
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-server.ts
 */

// Bypass TLS certificate verification for Inco KMS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from 'bun';
import {
    createPublicClient,
    createWalletClient,
    http,
    toBytes,
    type Address,
    type Hash,
    type Hex,
    parseAbi,
    decodeEventLog,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { CONFIGS } from "@internal/constants";
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner, getSolanaWeb3Keypair } from "@internal/sol";

// Inco SDKs
import { Lightning } from "@inco/js/lite";
import { encryptValue } from "@inco/solana-sdk/encryption";
import { hexToBuffer } from "@inco/solana-sdk/utils";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const PORT = parseInt(process.env.PORT || "3001");
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY or PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Contract addresses
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x85d2b2C0195990bf11250C8e109D97169b9eD2F6" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0x7e25DcFa8E53a29Ae2C2fAF18cdbCBDF2d898138" as Address;

// Solana Program IDs
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// Viem Clients
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const evmWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Inco Lightning instance
let zapInstance: any = null;
async function getZap() {
    if (!zapInstance) {
        zapInstance = await Lightning.latest('devnet', 84532);
    }
    return zapInstance;
}

// --- Storage for decrypt authorizations ---
interface DecryptAuthorization {
    handle: Hex;
    userAddress: Address;
    signature: Hex;
    eip712Domain: any;
    timestamp: number;
    txHash: Hex;
    processed: boolean;
}

const authorizations = new Map<string, DecryptAuthorization>();

// --- Bridge Event Tracking ---
interface BridgeEvent {
    txHash: Hex;
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolana: Hex;
    encryptedAmount: Hex; // This is the handle
    timestamp: number;
    processed: boolean;
}

const pendingBridgeEvents = new Map<string, BridgeEvent>();

// --- ABIs ---
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
] as const;

// --- Helper Functions ---
function bytes32ToPublicKey(bytes32: Hex): PublicKey {
    const bytes = toBytes(bytes32);
    return new PublicKey(bytes);
}

// --- HTTP Server ---
const app = new Hono();

// Enable CORS for frontend
app.use('/*', cors({
    origin: ['http://localhost:3000', 'http://localhost:3001', '*'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
}));

// Health check
app.get('/health', (c) => {
    return c.json({ 
        status: 'ok', 
        relayer: evmAccount.address,
        bridge: CONFIDENTIAL_BRIDGE_ADDRESS,
        pendingEvents: pendingBridgeEvents.size,
        authorizations: authorizations.size,
    });
});

/**
 * POST /relay
 * 
 * Frontend sends the decrypted plaintext amount (user already called attestedDecrypt)
 * along with bridge details. Relayer re-encrypts for Solana TEE and relays.
 * 
 * Body: {
 *   baseTxHash: "0x...",
 *   plaintextAmount: "1000000000000000000",  // string bigint
 *   toSolana: "0x...",    // bytes32 Solana pubkey
 *   localToken: "0x...",  // EVM token address
 * }
 */
app.post('/relay', async (c) => {
    try {
        const body = await c.req.json();
        const { baseTxHash, plaintextAmount, toSolana, localToken } = body;

        if (!baseTxHash || !plaintextAmount || !toSolana) {
            return c.json({ error: 'Missing required fields: baseTxHash, plaintextAmount, toSolana' }, 400);
        }

        console.log(`\n📥 Received relay request from frontend:`);
        console.log(`   Base TX: ${baseTxHash}`);
        console.log(`   Plaintext Amount: ${plaintextAmount}`);
        console.log(`   To Solana: ${toSolana}`);

        // Check if already processed
        const existingEvent = Array.from(pendingBridgeEvents.values())
            .find(e => e.txHash.toLowerCase() === baseTxHash.toLowerCase());
        if (existingEvent?.processed) {
            console.log(`   ⚠️ Already processed, skipping`);
            return c.json({ success: true, message: 'Already relayed', alreadyProcessed: true });
        }

        // Re-encrypt the plaintext for Solana TEE
        console.log(`   📥 Re-encrypting for Solana TEE...`);
        const plaintext = BigInt(plaintextAmount);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);
        console.log(`   ✅ Solana ciphertext: ${ciphertextBytes.length} bytes`);

        // Build the bridge event from the request
        const bridgeEvent: BridgeEvent = {
            txHash: baseTxHash as Hex,
            nonce: 0n,
            localToken: (localToken || CONFIDENTIAL_TOKEN_ADDRESS) as Address,
            remoteToken: '0x0' as Hex,
            toSolana: toSolana as Hex,
            encryptedAmount: '0x0' as Hex,
            timestamp: Date.now(),
            processed: false,
        };

        // Relay to Solana
        const success = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

        if (success) {
            bridgeEvent.processed = true;
            pendingBridgeEvents.set(baseTxHash, bridgeEvent);
            console.log(`   ✅ Successfully relayed to Solana!`);
            return c.json({ success: true, message: 'Relayed to Solana' });
        } else {
            return c.json({ error: 'Failed to relay to Solana' }, 500);
        }
    } catch (error: any) {
        console.error('Error in /relay:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /relay-to-base
 * 
 * Frontend sends the decrypted plaintext amount (user already called Solana attested decrypt)
 * along with bridge details. Relayer re-encrypts for EVM using Inco zap.encrypt() and calls
 * faucetMint on the token contract.
 * 
 * Body: {
 *   solanaTxHash: "...",
 *   plaintextAmount: "1000000000000000000",  // string bigint
 *   destinationEvm: "0x...",    // EVM address to mint to
 *   localToken: "0x...",        // EVM token address
 * }
 */
app.post('/relay-to-base', async (c) => {
    try {
        const body = await c.req.json();
        const { solanaTxHash, plaintextAmount, destinationEvm, localToken } = body;

        if (!solanaTxHash || !plaintextAmount || !destinationEvm) {
            return c.json({ error: 'Missing required fields: solanaTxHash, plaintextAmount, destinationEvm' }, 400);
        }

        const tokenAddress = (localToken || CONFIDENTIAL_TOKEN_ADDRESS) as `0x${string}`;
        const destination = destinationEvm as `0x${string}`;
        const amount = BigInt(plaintextAmount);

        console.log(`\n📥 Received relay-to-base request:`);
        console.log(`   Solana TX: ${solanaTxHash}`);
        console.log(`   Plaintext Amount: ${plaintextAmount} (${Number(amount) / 1e18} tokens)`);
        console.log(`   Destination EVM: ${destination}`);
        console.log(`   Token: ${tokenAddress}`);

        // Step 1: Encrypt the plaintext for EVM using Inco zap.encrypt()
        console.log(`   🔐 Encrypting for EVM via Inco...`);
        const { supportedChains, handleTypes } = await import("@inco/js");
        const zap = await getZap();

        const ciphertext = await zap.encrypt(amount, {
            accountAddress: evmAccount.address,
            dappAddress: tokenAddress,
            handleType: handleTypes.euint256,
        });

        console.log(`   ✅ EVM ciphertext ready (${ciphertext.length} bytes)`);

        // Step 2: Get Inco fee
        let incoFee: bigint;
        try {
            incoFee = await basePublicClient.readContract({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                abi: parseAbi(["function getIncoFee() view returns (uint256)"]),
                functionName: "getIncoFee",
            });
        } catch {
            // Default fee
            incoFee = BigInt("1000000000000000"); // 0.001 ETH
        }
        console.log(`   💰 Inco fee: ${incoFee} wei`);

        // Step 3: Call faucetMint on the token contract
        // faucetMint is publicly callable and accepts Inco-encrypted ciphertext
        console.log(`   📤 Calling faucetMint on ${tokenAddress}...`);
        
        const FAUCET_MINT_ABI = parseAbi([
            "function faucetMint(address to, bytes encryptedAmount) external payable",
        ]);

        const hash = await evmWalletClient.writeContract({
            address: tokenAddress,
            abi: FAUCET_MINT_ABI,
            functionName: "faucetMint",
            args: [destination, ciphertext],
            value: incoFee,
        });

        console.log(`   ⏳ TX sent: ${hash}`);
        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });

        if (receipt.status === "success") {
            console.log(`   ✅ Minted on Base! TX: ${hash}`);
            console.log(`   📍 Block: ${receipt.blockNumber}`);
            return c.json({ success: true, txHash: hash, message: 'Minted on Base' });
        } else {
            console.log(`   ❌ Transaction reverted`);
            return c.json({ error: 'Mint transaction reverted' }, 500);
        }
    } catch (error: any) {
        console.error('Error in /relay-to-base:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * POST /authorize
 * 
 * DEPRECATED — Use /relay instead.
 * Frontend submits decrypt authorization after user signs.
 * Body: {
 *   handle: "0x...",
 *   userAddress: "0x...",
 *   signature: "0x...",
 *   eip712Domain: { ... },
 *   txHash: "0x..."
 * }
 */
app.post('/authorize', async (c) => {
    try {
        const body = await c.req.json();
        const { handle, userAddress, signature, eip712Domain, txHash } = body;

        if (!handle || !userAddress || !signature || !txHash) {
            return c.json({ error: 'Missing required fields' }, 400);
        }

        console.log(`📥 Received decrypt authorization:`);
        console.log(`   Handle: ${handle}`);
        console.log(`   User: ${userAddress}`);
        console.log(`   TX: ${txHash}`);

        // Store the authorization
        const auth: DecryptAuthorization = {
            handle: handle as Hex,
            userAddress: userAddress as Address,
            signature: signature as Hex,
            eip712Domain,
            timestamp: Date.now(),
            txHash: txHash as Hex,
            processed: false,
        };

        authorizations.set(handle, auth);

        // Check if we have a pending bridge event for this handle
        const bridgeEvent = Array.from(pendingBridgeEvents.values())
            .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

        if (bridgeEvent) {
            console.log(`   ✅ Found matching bridge event! Processing...`);
            // Process immediately
            processAuthorization(handle).catch(console.error);
        } else {
            console.log(`   ⏳ No matching bridge event yet, waiting...`);
        }

        return c.json({ 
            success: true, 
            message: 'Authorization received',
            handle,
        });
    } catch (error: any) {
        console.error('Error in /authorize:', error);
        return c.json({ error: error.message }, 500);
    }
});

/**
 * GET /status/:handle
 * 
 * Check the status of a bridge/authorization
 */
app.get('/status/:handle', (c) => {
    const handle = c.req.param('handle') as Hex;
    
    const auth = authorizations.get(handle);
    const bridgeEvent = Array.from(pendingBridgeEvents.values())
        .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

    return c.json({
        handle,
        hasAuthorization: !!auth,
        authProcessed: auth?.processed || false,
        hasBridgeEvent: !!bridgeEvent,
        bridgeProcessed: bridgeEvent?.processed || false,
    });
});

/**
 * GET /pending
 * 
 * List pending bridge events awaiting authorization
 */
app.get('/pending', (c) => {
    const pending = Array.from(pendingBridgeEvents.values())
        .filter(e => !e.processed)
        .map(e => ({
            txHash: e.txHash,
            handle: e.encryptedAmount,
            toSolana: e.toSolana,
            timestamp: e.timestamp,
        }));

    return c.json({ pending });
});

// --- Process Authorization ---
async function processAuthorization(handle: string): Promise<boolean> {
    const auth = authorizations.get(handle);
    if (!auth || auth.processed) {
        console.log(`   No authorization or already processed for ${handle}`);
        return false;
    }

    const bridgeEvent = Array.from(pendingBridgeEvents.values())
        .find(e => e.encryptedAmount.toLowerCase() === handle.toLowerCase());

    if (!bridgeEvent) {
        console.log(`   No bridge event found for ${handle}`);
        return false;
    }

    console.log(`\n🔄 Processing authorization for ${handle}...`);

    try {
        // Step 1: Use the user's signature to decrypt via Inco
        const zap = await getZap();
        
        console.log(`   📤 Requesting attested decrypt with user's signature...`);
        
        // The Inco SDK needs to use the pre-signed authorization
        // We need to call the lower-level API directly with the signature
        const decryptResults = await zap.attestedDecryptWithSignature(
            auth.userAddress,
            [auth.handle],
            auth.signature,
            auth.eip712Domain
        );

        if (!decryptResults || decryptResults.length === 0) {
            throw new Error('No decrypt results');
        }

        let plaintext: bigint;
        const result = decryptResults[0];
        if (typeof result === 'bigint') {
            plaintext = result;
        } else if (result?.plaintext?.value) {
            plaintext = BigInt(result.plaintext.value);
        } else {
            plaintext = BigInt(result);
        }

        console.log(`   ✅ Decrypted: ${plaintext} (${Number(plaintext) / 1e18} tokens)`);

        // Step 2: Re-encrypt for Solana
        console.log(`   📥 Re-encrypting for Solana TEE...`);
        const solanaCiphertext = await encryptValue(plaintext);
        const ciphertextBytes = hexToBuffer(solanaCiphertext);

        console.log(`   ✅ Solana ciphertext: ${ciphertextBytes.length} bytes`);

        // Step 3: Relay to Solana
        const success = await relayToSolana(bridgeEvent, new Uint8Array(ciphertextBytes));

        if (success) {
            auth.processed = true;
            bridgeEvent.processed = true;
            console.log(`   ✅ Successfully relayed to Solana!`);
        }

        return success;
    } catch (error: any) {
        console.error(`   ❌ Failed to process:`, error.message);
        
        if (error.message?.includes('attestedDecryptWithSignature')) {
            console.error(`   ❌ Inco SDK doesn't support pre-signed auth yet.`);
            console.error(`   Cannot relay without real amount.`);
        }
        
        return false;
    }
}

/**
 * Send the relay transaction to Solana
 */
async function relayToSolana(bridgeEvent: BridgeEvent, encryptedAmountBytes: Uint8Array): Promise<boolean> {
    try {
        const recipientPubkey = bytes32ToPublicKey(bridgeEvent.toSolana);
        // Use the known Solana token mint (not from remoteToken which may be 0x0 for /relay calls)
        const SOLANA_TOKEN_MINT = new PublicKey("3JWs353tgpFRVxb6Ubi85hDm5eBsbGrJFmVqNS8t6V3V");
        const tokenMint = SOLANA_TOKEN_MINT;
        
        console.log(`   🚀 Relaying to Solana:`);
        console.log(`      Recipient: ${recipientPubkey.toBase58()}`);
        console.log(`      Token Mint: ${tokenMint.toBase58()}`);

        // Find PDAs
        // Hash owner with keccak256 for privacy-preserving PDA (matches Rust program)
        const { keccak256: keccak256Hash } = await import("viem");
        const ownerHash = Buffer.from(keccak256Hash(new Uint8Array(recipientPubkey.toBuffer())).slice(2), "hex");

        const [vaultPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("confidential_vault"),
                ownerHash,
                tokenMint.toBuffer(),
            ],
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

        // Check vault exists
        const connection = new Connection(config.solana.rpcUrl, "confirmed");
        const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
        
        if (!vaultAccountInfo) {
            console.log(`   ⚠️ Vault doesn't exist for recipient ${recipientPubkey.toBase58()}`);
            console.log(`   Vault PDA: ${vaultPda.toBase58()}`);
            console.log(`   The recipient must initialize a ConfidentialVault first.`);
            return false;
        }

        // Build relay_receive_confidential instruction
        const crypto = await import("crypto");
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_receive_confidential")
            .digest()
            .slice(0, 8);

        const encryptedLenBuf = Buffer.alloc(4);
        encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);

        const baseSender = toBytes(evmAccount.address).slice(0, 20);

        const instructionData = Buffer.concat([
            discriminator,
            encryptedLenBuf,
            Buffer.from(encryptedAmountBytes),
            Buffer.from(baseSender),
        ]);

        console.log(`   📦 Instruction data: ${instructionData.length} bytes`);

        // Get Solana keypair for signing
        const payerKeypair = getSolanaWeb3Keypair();
        console.log(`   🔑 Using Solana payer: ${payerKeypair.publicKey.toBase58()}`);

        const { Transaction, sendAndConfirmTransaction, TransactionInstruction: TxIx } = await import("@solana/web3.js");

        const instruction = new TxIx({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },   // relayer
                { pubkey: bridgeState, isSigner: false, isWritable: false },             // bridge
                { pubkey: bridgeAuthority, isSigner: false, isWritable: true },          // bridge_authority
                { pubkey: recipientPubkey, isSigner: false, isWritable: false },         // owner
                { pubkey: vaultPda, isSigner: false, isWritable: true },                 // vault
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },       // inco_lightning_program
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        console.log(`   🚀 Sending Solana transaction...`);
        const tx = new Transaction().add(instruction);
        const signature = await sendAndConfirmTransaction(
            connection,
            tx,
            [payerKeypair],
            { commitment: "confirmed" }
        );

        console.log(`   ✅ Solana TX confirmed: ${signature}`);
        console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

        bridgeEvent.processed = true;
        return true;

    } catch (error: any) {
        console.error(`   ❌ Relay failed:`, error.message);
        if (error.logs) {
            console.error(`   Logs:`);
            error.logs.forEach((log: string) => console.error(`      ${log}`));
        }
        return false;
    }
}

// --- Event Monitoring ---
async function monitorBridgeEvents() {
    console.log(`\n📡 Starting event monitor...`);
    
    let lastBlock = await basePublicClient.getBlockNumber() - BigInt(10);
    
    setInterval(async () => {
        try {
            const currentBlock = await basePublicClient.getBlockNumber();
            
            if (currentBlock <= lastBlock) return;
            
            const logs = await basePublicClient.getLogs({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                fromBlock: lastBlock + BigInt(1),
                toBlock: currentBlock,
            });

            for (const log of logs) {
                try {
                    const decoded = decodeEventLog({
                        abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                        data: log.data,
                        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
                    });

                    if (decoded.eventName === "ConfidentialBridgeInitiated") {
                        const args = decoded.args as any;
                        const handle = args.encryptedAmount as Hex;

                        console.log(`\n📨 New bridge event in TX: ${log.transactionHash}`);
                        console.log(`   Handle: ${handle}`);
                        console.log(`   To: ${bytes32ToPublicKey(args.toSolana).toBase58()}`);

                        const bridgeEvent: BridgeEvent = {
                            txHash: log.transactionHash as Hex,
                            nonce: args.nonce,
                            localToken: args.localToken,
                            remoteToken: args.remoteToken,
                            toSolana: args.toSolana,
                            encryptedAmount: handle,
                            timestamp: Date.now(),
                            processed: false,
                        };

                        pendingBridgeEvents.set(log.transactionHash!, bridgeEvent);

                        // Check if we already have authorization for this handle
                        if (authorizations.has(handle)) {
                            console.log(`   ✅ Authorization already received! Processing...`);
                            processAuthorization(handle).catch(console.error);
                        } else {
                            console.log(`   ⏳ Waiting for user's decrypt authorization...`);
                        }
                    }
                } catch (e) {
                    // Not our event
                }
            }

            lastBlock = currentBlock;
        } catch (error: any) {
            console.error('Monitor error:', error.message);
        }
    }, 5000); // Poll every 5 seconds
}

// --- Start Server ---
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          Privacy Relayer Server (Base ↔ Solana)              ║
╠═══════════════════════════════════════════════════════════════╣
║  Relayer:  ${evmAccount.address}  ║
║  Bridge:   ${CONFIDENTIAL_BRIDGE_ADDRESS}  ║
║  Port:     ${PORT}                                              ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Start event monitoring
monitorBridgeEvents();

// Start HTTP server
console.log(`🌐 Starting HTTP server on port ${PORT}...`);
serve({
    fetch: app.fetch,
    port: PORT,
});

console.log(`✅ Server running at http://localhost:${PORT}`);
console.log(`
Endpoints:
  GET  /health          - Server status
  POST /relay           - Submit decrypted plaintext for Solana relay (Base → Solana)
  POST /relay-to-base   - Submit decrypted plaintext for Base minting (Solana → Base)
  POST /authorize       - (deprecated) Submit decrypt authorization
  GET  /status/:handle  - Check authorization status
  GET  /pending         - List pending bridge events
`);
