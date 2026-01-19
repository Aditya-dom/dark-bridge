#!/usr/bin/env bun
/**
 * Privacy Relayer: Solana → Base
 * 
 * Monitors ConfidentialBridgeOutEvent on Solana and relays encrypted transfers to Base.
 * This is the privacy-preserving counterpart to auto-relayer.ts.
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts <SOLANA_TX_SIG>
 */

import {
    createSolanaRpc,
    getProgramDerivedAddress,
    type Address as SolanaAddress,
} from "@solana/kit";
import {
    createPublicClient,
    createWalletClient,
    http,
    toHex,
    type Address,
    type Hash,
    type Hex,
    parseAbi,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Connection, PublicKey } from "@solana/web3.js";

import { CONFIGS } from "@internal/constants";
import { getSolanaCliConfigKeypairSigner, getIdlConstant } from "@internal/sol";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses (v6 - DARK token with confidentialMintForDemo)
const CONFIDENTIAL_BRIDGE_ADDRESS = "0xfa1CBa0067D967bbD17eFd2Ab815B92AaB418A7f" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0xc4104aCBa7059c2f8FEFdf746a1c4b9B8a89Ec7D" as Address;

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// --- Viem Clients ---
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const baseWalletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function receiveFromSolanaForDemo(address localToken, address to, bytes encryptedAmount) external payable",
    "function receiveFromSolanaLegacy(address localToken, address to, bytes encryptedAmount) external payable",
    "function getIncoFee() external view returns (uint256)",
    "event ConfidentialBridgeReceived(uint256 indexed nonce, address indexed localToken, address indexed to, bytes32 encryptedAmount)",
]);

const CONFIDENTIAL_TOKEN_ABI = parseAbi([
    "function confidentialMint(address to, bytes encryptedAmount) external payable",
    "function confidentialMintForDemo(address to, uint256 plainAmount) external payable",
]);

console.log("=== Privacy Relayer (Solana → Base) ===");
console.log(`EVM Signer: ${evmAccount.address}`);
console.log(`Confidential Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
console.log(`Confidential Token: ${CONFIDENTIAL_TOKEN_ADDRESS}`);

// --- Event Parsing ---
interface ConfidentialBridgeOutEvent {
    vault: string;
    owner: string;
    destinationEvm: Uint8Array;
    encryptedAmountHandle: bigint;
}

/**
 * Parse ConfidentialBridgeOutEvent from Solana transaction logs.
 * 
 * Event structure (from instructions.rs):
 * - vault: Pubkey
 * - owner: Pubkey
 * - destination_evm: [u8; 20]
 * - encrypted_amount_handle: u128
 */
function parseConfidentialBridgeOutEvent(logs: string[]): ConfidentialBridgeOutEvent | null {
    // Anchor event discriminator for ConfidentialBridgeOutEvent
    // sha256("event:ConfidentialBridgeOutEvent")[0:8] = fee3f47c36edab41
    const EXPECTED_DISCRIMINATOR = Buffer.from("fee3f47c36edab41", "hex");
    
    // Look for Anchor event discriminator for ConfidentialBridgeOutEvent
    // Format: "Program data: <base64 encoded data>"
    for (const log of logs) {
        if (log.startsWith("Program data:")) {
            try {
                const base64Data = log.replace("Program data: ", "");
                const data = Buffer.from(base64Data, "base64");

                // Check event discriminator (first 8 bytes)
                const discriminator = data.subarray(0, 8);
                if (!discriminator.equals(EXPECTED_DISCRIMINATOR)) {
                    continue; // Not our event, skip
                }

                // Event discriminator (first 8 bytes) + payload
                // We need to match the event structure from Rust
                if (data.length >= 8 + 32 + 32 + 20 + 16) {
                    // Skip discriminator (8 bytes)
                    let offset = 8;

                    // vault: Pubkey (32 bytes)
                    const vault = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
                    offset += 32;

                    // owner: Pubkey (32 bytes)
                    const owner = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
                    offset += 32;

                    // destination_evm: [u8; 20]
                    const destinationEvm = data.subarray(offset, offset + 20);
                    offset += 20;

                    // encrypted_amount_handle: u128 (16 bytes, little endian)
                    const handleBytes = data.subarray(offset, offset + 16);
                    const encryptedAmountHandle = readU128LE(handleBytes);

                    return {
                        vault,
                        owner,
                        destinationEvm,
                        encryptedAmountHandle,
                    };
                }
            } catch (e) {
                // Not the event we're looking for
            }
        }
    }
    return null;
}

/**
 * Read a u128 little-endian from buffer.
 */
function readU128LE(buffer: Uint8Array): bigint {
    let result = BigInt(0);
    for (let i = 0; i < Math.min(16, buffer.length); i++) {
        result += BigInt(buffer[i] ?? 0) << BigInt(i * 8);
    }
    return result;
}

/**
 * Convert u128 handle to bytes32 for EVM.
 * Pads with zeros on the left to make 32 bytes.
 */
function handleToBytes32(handle: bigint): Hex {
    const hex = handle.toString(16).padStart(32, "0"); // 128 bits = 32 hex chars
    return ("0x" + hex.padStart(64, "0")) as Hex; // 256 bits = 64 hex chars
}

/**
 * Convert Euint128 handle to encrypted bytes for EVM.
 * For cross-chain, we create a "passthrough" ciphertext that encodes the handle directly.
 * 
 * NOTE: In production, this would need proper handle conversion between SVM and EVM.
 * For the hackathon demo, we send the raw handle bytes.
 */
function handleToEncryptedBytes(handle: bigint): Hex {
    // Convert u128 to 16 bytes (little-endian as stored in Solana)
    const buffer = Buffer.alloc(16);
    let remaining = handle;
    for (let i = 0; i < 16; i++) {
        buffer[i] = Number(remaining & BigInt(0xff));
        remaining >>= BigInt(8);
    }
    return toHex(buffer);
}

// Inco covalidator endpoint for attested decryption
const INCO_ATTESTED_DECRYPT_ENDPOINT = "https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/getDecryptAttested";

interface AttestedDecryptResult {
    handle: string;
    plaintext: bigint;
    signature: string;
}

/**
 * Request attested decryption from Inco covalidator.
 * 
 * This decrypts the Solana handle and returns:
 * - plaintext: The actual decrypted amount
 * - signature: Covalidator signature for on-chain verification
 * 
 * @param handle - The Euint128 handle from Solana (u128)
 * @param ownerAddress - The Solana wallet that owns the encrypted value
 * @param signMessage - Function to sign messages with the wallet
 */
async function requestAttestedDecrypt(
    handle: bigint,
    ownerAddress: string,
    signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<AttestedDecryptResult> {
    // Sign the handle to prove ownership
    const handleStr = handle.toString();
    const messageBytes = new TextEncoder().encode(handleStr);
    const signatureBytes = await signMessage(messageBytes);
    const callerSignature = Buffer.from(signatureBytes).toString('base64');
    
    console.log(`   Requesting attested decrypt for handle: ${handle}`);
    console.log(`   Owner: ${ownerAddress}`);
    
    const response = await fetch(INCO_ATTESTED_DECRYPT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            handle: handleStr,
            address: ownerAddress,
            signature: callerSignature,
        }),
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Attested decrypt failed: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.plaintext) {
        throw new Error("No plaintext in attested decrypt response");
    }
    
    return {
        handle: data.handle_value || handleStr,
        plaintext: BigInt(data.plaintext),
        signature: data.signature,
    };
}

/**
 * Alternative: Request attested decrypt without wallet signature (for testing).
 * This may work for handles that were created with "allow anyone" permissions.
 */
async function requestAttestedDecryptSimple(handle: bigint): Promise<AttestedDecryptResult | null> {
    console.log(`   Attempting simple attested decrypt for handle: ${handle}`);
    
    try {
        // Try fetching from the encryption API directly
        const response = await fetch(`https://grpc.solana-devnet.alpha.devnet.inco.org/crypto/decrypt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                handle: handle.toString(),
            }),
        });
        
        if (!response.ok) {
            console.log(`   Simple decrypt not available: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        return {
            handle: handle.toString(),
            plaintext: BigInt(data.plaintext || data.value || 0),
            signature: data.signature || "",
        };
    } catch (e) {
        console.log(`   Simple decrypt failed: ${e}`);
        return null;
    }
}

/**
 * Relay a confidential bridge message from Solana to Base.
 */
async function relayConfidentialToBase(txSignature: string): Promise<boolean> {
    console.log(`\n=== Processing Solana TX: ${txSignature} ===`);

    try {
        const connection = new Connection(config.solana.rpcUrl, "confirmed");

        // 1. Get transaction details
        const tx = await connection.getTransaction(txSignature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
            console.log("   ❌ Transaction not found");
            return false;
        }

        const logs = tx.meta?.logMessages || [];
        console.log(`   Found ${logs.length} log messages`);

        // 2. Parse ConfidentialBridgeOutEvent
        const event = parseConfidentialBridgeOutEvent(logs);

        if (!event) {
            console.log("   ❌ No ConfidentialBridgeOutEvent found");
            console.log("   Logs:", logs.slice(0, 10));
            return false;
        }

        console.log(`   ✅ Found confidential bridge event:`);
        console.log(`      Vault: ${event.vault}`);
        console.log(`      Owner: ${event.owner}`);
        console.log(`      Destination EVM: 0x${Buffer.from(event.destinationEvm).toString("hex")}`);
        console.log(`      Encrypted Handle: ${event.encryptedAmountHandle}`);

        // 3. Convert destination address
        const destinationAddress = ("0x" + Buffer.from(event.destinationEvm).toString("hex")) as Address;

        // 4. Get Inco fee on Base
        let incoFee: bigint;
        try {
            incoFee = await basePublicClient.readContract({
                address: CONFIDENTIAL_BRIDGE_ADDRESS,
                abi: CONFIDENTIAL_BRIDGE_ABI,
                functionName: "getIncoFee",
            });
        } catch {
            // Default fee
            incoFee = BigInt("100000000000000"); // 0.0001 ETH
        }
        console.log(`   Inco fee: ${incoFee} wei`);

        // 5. Try attested decrypt to get the actual plaintext amount
        let amountToMint: bigint;
        
        // First try simple decrypt (for testing)
        const decryptResult = await requestAttestedDecryptSimple(event.encryptedAmountHandle);
        
        if (decryptResult && decryptResult.plaintext > 0n) {
            console.log(`   ✅ Attested decrypt succeeded!`);
            console.log(`      Plaintext amount: ${decryptResult.plaintext}`);
            amountToMint = decryptResult.plaintext;
        } else {
            // Fallback to demo amount
            console.log(`   ⚠️ Attested decrypt not available, using demo amount`);
            console.log(`   (This is expected in dev - Inco handles are chain-specific)`);
            amountToMint = BigInt(5); // Demo fallback
        }
        
        console.log(`   Amount to mint: ${amountToMint} tokens`);
        console.log(`   (Original Solana handle: ${event.encryptedAmountHandle})`);

        // 6. Call confidentialMintForDemo on the token
        // This encrypts the plaintext on Base using Inco TEE
        console.log("   Minting on Base via confidentialMintForDemo...");

        const hash = await baseWalletClient.writeContract({
            address: CONFIDENTIAL_TOKEN_ADDRESS,
            abi: CONFIDENTIAL_TOKEN_ABI,
            functionName: "confidentialMintForDemo",
            args: [destinationAddress, amountToMint],
            value: incoFee,
        });

        console.log(`   ✅ Minted on Base: ${hash}`);

        // 7. Wait for confirmation
        const receipt = await basePublicClient.waitForTransactionReceipt({ hash });
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);

        return true;

    } catch (error: any) {
        console.error(`   ❌ Error: ${error.message}`);
        if (error.cause) {
            console.error(`   Cause: ${JSON.stringify(error.cause)}`);
        }
        return false;
    }
}

/**
 * Monitor mode - watch for new confidential bridge events on Solana.
 */
async function monitorMode() {
    console.log("\n=== Monitor Mode ===");
    console.log("Watching for ConfidentialBridgeOutEvent events on Solana...\n");

    const connection = new Connection(config.solana.rpcUrl, "confirmed");

    // Get the latest slot to start from
    let lastSlot = await connection.getSlot();
    console.log(`Starting from slot: ${lastSlot}`);

    // Poll for new transactions
    while (true) {
        try {
            const currentSlot = await connection.getSlot();

            if (currentSlot > lastSlot) {
                // Get signatures for the bridge program
                const signatures = await connection.getSignaturesForAddress(
                    BRIDGE_PROGRAM_ID,
                    { limit: 10 },
                    "confirmed"
                );

                // Process new signatures
                for (const sig of signatures) {
                    if (sig.slot > lastSlot) {
                        console.log(`\n[${new Date().toISOString()}] New TX: ${sig.signature}`);

                        // Check if it's a confidential bridge out event
                        const tx = await connection.getTransaction(sig.signature, {
                            commitment: "confirmed",
                            maxSupportedTransactionVersion: 0,
                        });

                        if (tx) {
                            const logs = tx.meta?.logMessages || [];
                            const event = parseConfidentialBridgeOutEvent(logs);

                            if (event) {
                                console.log("   📦 Confidential bridge event detected!");
                                await relayConfidentialToBase(sig.signature);
                            } else {
                                console.log("   ℹ️ Not a confidential bridge event");
                            }
                        }
                    }
                }

                lastSlot = currentSlot;
            }

            // Show heartbeat
            console.log(`[${new Date().toISOString()}] Slot: ${currentSlot}`);
            await new Promise((r) => setTimeout(r, 10000)); // 10 second polling

        } catch (error: any) {
            console.error(`Monitor error: ${error.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

/**
 * Demo mode - simulate a privacy bridge flow.
 */
async function demoMode() {
    console.log("\n=== Privacy Bridge Demo ===");
    console.log(`
This relayer monitors ConfidentialBridgeOutEvent on Solana and relays them to Base.

Flow:
1. User encrypts amount on Solana using @inco/solana-sdk
2. User calls bridge_confidential_out() on Solana bridge program
3. This burns encrypted tokens and emits ConfidentialBridgeOutEvent
4. Relayer picks up event and calls receiveFromSolana() on Base
5. Base ConfidentialBridge mints encrypted tokens to recipient

To test:
1. Initialize a confidential vault on Solana
2. Deposit tokens to get encrypted balance
3. Bridge out with encrypted amount
4. Run this relayer in monitor mode
`);

    console.log("\nDeployed Contract Addresses:");
    console.log(`  ConfidentialBridge (Base): ${CONFIDENTIAL_BRIDGE_ADDRESS}`);
    console.log(`  ConfidentialToken (Base): ${CONFIDENTIAL_TOKEN_ADDRESS}`);
    console.log(`  Bridge Program (Solana): ${BRIDGE_PROGRAM_ID.toBase58()}`);
    console.log(`  Inco Lightning (Solana): ${INCO_LIGHTNING_ID.toBase58()}`);
}

// --- Main ---
async function main() {
    const arg = process.argv[2];

    if (arg === "--monitor") {
        await monitorMode();
    } else if (arg === "--demo") {
        await demoMode();
    } else if (arg && arg.length > 50) {
        // Looks like a Solana transaction signature
        await relayConfidentialToBase(arg);
    } else {
        console.log("\nUsage:");
        console.log("  Monitor mode:     bun run src/privacy-relayer-sol-to-base.ts --monitor");
        console.log("  Process TX:       bun run src/privacy-relayer-sol-to-base.ts <SOLANA_TX_SIGNATURE>");
        console.log("  Demo info:        bun run src/privacy-relayer-sol-to-base.ts --demo");
    }
}

main().catch(console.error);
