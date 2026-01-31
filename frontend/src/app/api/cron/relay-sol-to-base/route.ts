import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    type Address,
    type Hex,
    toHex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import crypto from "crypto";

// --- ENV & CONSTANTS ---
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const DEPLOY_ENV = "testnet-alpha";
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xD705858A979a4ab42e7a2e43e8CcC726Dbd87369" as Address; // Updated one
const CONFIDENTIAL_TOKEN_ADDRESS = "0xFBAD5A940d89e504C5f8C9e0fC3A976A82334565" as Address; // Updated one

const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");
const SOLANA_RPC_URL = "https://api.devnet.solana.com";
const BASE_RPC_URL = "https://sepolia.base.org";

const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function confidentialMint(address to, bytes encryptedAmount) external payable",
    "function confidentialMintForDemo(address to, uint256 plainAmount) external payable",
]);

const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function getIncoFee() external view returns (uint256)",
]);

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// --- HANDLER ---
export async function GET(req: NextRequest) {
    // 1. Auth check
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        const urlKey = req.nextUrl.searchParams.get('key');
        if (urlKey !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Load Keys
    const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!evmPrivateKey || !solanaPrivateKey) {
        return NextResponse.json({ error: "Missing PRIVATE_KEYs" }, { status: 500 });
    }

    try {
        // Setup Params
        const evmAccount = privateKeyToAccount(evmPrivateKey as `0x${string}`);
        const baseWalletClient = createWalletClient({
            account: evmAccount,
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });
        const basePublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(BASE_RPC_URL),
        });

        const solanaConnection = new Connection(SOLANA_RPC_URL, "confirmed");
        let solanaKeypair: Keypair;
        try {
            const bs58 = require('bs58');
            solanaKeypair = Keypair.fromSecretKey(bs58.decode(solanaPrivateKey));
        } catch {
            solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(solanaPrivateKey)));
        }

        console.log(`[Sol -> Base Relayer] Running... EVM: ${evmAccount.address}`);

        // 3. Poll recent Solana Signatures
        // We look at the last 20 signatures for the bridge program to keep it light
        const signatures = await solanaConnection.getSignaturesForAddress(
            BRIDGE_PROGRAM_ID,
            { limit: 20 },
            "confirmed"
        );

        console.log(`Found ${signatures.length} recent signatures on Solana`);
        const results = [];

        for (const sig of signatures) {
            if (sig.err) continue;

            const tx = await solanaConnection.getTransaction(sig.signature, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta?.logMessages) continue;

            const logs = tx.meta.logMessages;

            // Parse Events
            const plaintextEvent = parseConfidentialBridgeOutPlaintextEvent(logs);
            const regularEvent = !plaintextEvent ? parseConfidentialBridgeOutEvent(logs) : null;
            const privateEvent = !plaintextEvent && !regularEvent ? parseRelayedPrivateBridgeOutEvent(logs) : null;

            if (!plaintextEvent && !regularEvent && !privateEvent) continue;

            // Check if we need to relay
            // How to check if already relayed?
            // On Base, we can't easily query "nonce processed" without a mapping.
            // But Vercel cron runs every minute. 
            // We could check the timestamp of the Solana TX. If it's too old (> 2 mins), skip it.
            if (tx.blockTime) {
                const now = Math.floor(Date.now() / 1000);
                if (now - tx.blockTime > 300) { // Skip if older than 5 mins
                    continue;
                }
            }

            console.log(`Processing Solana TX: ${sig.signature}`);

            // Extract Details
            let destinationAddress: Address;
            let amountToMint: bigint = 5n; // Default fallback

            // 4. Determine Amount
            if (plaintextEvent) {
                console.log("   Found Plaintext Event");
                destinationAddress = ("0x" + Buffer.from(plaintextEvent.destinationEvm).toString("hex")) as Address;
                amountToMint = plaintextEvent.plaintextAmount;
            } else if (regularEvent) {
                console.log("   Found Encrypted Event");
                destinationAddress = ("0x" + Buffer.from(regularEvent.destinationEvm).toString("hex")) as Address;
                // Try decrypt if we are owner (relayer)
                // Or use fallback
                // For now, simpler to use fallback for hackathon unless we implement the full SDK decrypt here
                // But wait, the script implements `requestAttestedDecryptSimple`. logic.
                // We can try the simple decrypt fetch.
                const decrypted = await requestAttestedDecryptSimple(regularEvent.encryptedAmountHandle);
                if (decrypted && decrypted.plaintext > 0n) {
                    amountToMint = decrypted.plaintext;
                    console.log(`   Decrypted: ${amountToMint}`);
                }
            } else if (privateEvent) {
                console.log("   Found Private Event");
                destinationAddress = ("0x" + Buffer.from(privateEvent.destinationEvm).toString("hex")) as Address;
                // Sender private -> fallback
            } else {
                continue;
            }

            // 5. Mint on Base
            // Get Fee
            let incoFee = 100000000000000n; // 0.0001 ETH
            try {
                incoFee = await basePublicClient.readContract({
                    address: CONFIDENTIAL_BRIDGE_ADDRESS,
                    abi: CONFIDENTIAL_BRIDGE_ABI,
                    functionName: "getIncoFee",
                });
            } catch { }

            // Send TX
            try {
                const hash = await baseWalletClient.writeContract({
                    address: CONFIDENTIAL_TOKEN_ADDRESS,
                    abi: CONFIDENTIAL_TOKEN_ABI,
                    functionName: "confidentialMintForDemo",
                    args: [destinationAddress, amountToMint],
                    value: incoFee,
                });
                console.log(`   Minted on Base: ${hash}`);
                results.push({ tx: sig.signature, status: "relayed", hash });
            } catch (err: any) {
                if (err.message.includes("nonce")) {
                    // likely nonce issue or already minted?
                    // actually "already minted" checks are hard without contract support
                }
                console.error(`   Mint Error: ${err.message}`);
                results.push({ tx: sig.signature, status: "error", error: err.message });
            }
        }

        return NextResponse.json({ success: true, results });

    } catch (e: any) {
        console.error("Relayer Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}


// --- PARSING HELPERS ---

interface BridgeOutEvent {
    vault?: string;
    owner?: string;
    destinationEvm: Uint8Array;
    encryptedAmountHandle: bigint;
    plaintextAmount?: bigint;
}

function parseConfidentialBridgeOutPlaintextEvent(logs: string[]): BridgeOutEvent & { plaintextAmount: bigint } | null {
    // Discriminator calculation omitted for brevity, using hardcoded known or re-impl
    // Actually we need to implement it correctly.
    // Discriminator: sha256("event:ConfidentialBridgeOutPlaintextEvent")[0:8]
    // We can compute it "live"
    const EXPECTED_DISCRIMINATOR = computeAnchorEventDiscriminator("ConfidentialBridgeOutPlaintextEvent");

    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    if (data.length >= 8 + 32 + 32 + 20 + 16 + 16) {
                        let offset = 8;
                        // skip vault (32), owner (32)
                        offset += 64;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        offset += 16;
                        const plaintextBytes = data.subarray(offset, offset + 16);
                        const plaintextAmount = readU128LE(plaintextBytes);
                        return { destinationEvm, encryptedAmountHandle, plaintextAmount };
                    }
                }
            } catch { }
        }
    }
    return null;
}

function parseConfidentialBridgeOutEvent(logs: string[]): BridgeOutEvent | null {
    const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex"); // Known discriminator from script
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    // 8 + 32 + 32 + 20 + 16
                    if (data.length >= 108) {
                        let offset = 8 + 64;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        return { destinationEvm, encryptedAmountHandle };
                    }
                }
            } catch { }
        }
    }
    return null;
}

function parseRelayedPrivateBridgeOutEvent(logs: string[]): BridgeOutEvent | null {
    const EXPECTED_DISCRIMINATOR = computeAnchorEventDiscriminator("RelayedPrivateBridgeOutEvent");
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const data = Buffer.from(log.replace("Program data: ", ""), "base64");
                if (data.subarray(0, 8).equals(EXPECTED_DISCRIMINATOR)) {
                    // 8 + 20 + 16
                    if (data.length >= 44) {
                        let offset = 8;
                        const destinationEvm = data.subarray(offset, offset + 20);
                        offset += 20;
                        const handleBytes = data.subarray(offset, offset + 16);
                        const encryptedAmountHandle = readU128LE(handleBytes);
                        return { destinationEvm, encryptedAmountHandle };
                    }
                }
            } catch { }
        }
    }
    return null;
}


// --- UTILS ---

function computeAnchorEventDiscriminator(eventName: string): Buffer {
    const hash = crypto.createHash("sha256");
    hash.update(`event:${eventName}`);
    return Buffer.from(hash.digest().subarray(0, 8));
}

function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

// Simple decrypt via API
async function requestAttestedDecryptSimple(handle: bigint) {
    try {
        const response = await fetch(`https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/decrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: handle.toString() }),
        });
        if (response.ok) {
            const data = await response.json();
            return {
                handle: handle.toString(),
                plaintext: BigInt(data.plaintext || data.value || 0),
            };
        }
    } catch { }
    return null;
}
