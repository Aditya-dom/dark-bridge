#!/usr/bin/env bun
/**
 * Privacy Relayer: Base → Solana
 * 
 * Monitors ConfidentialBridgeInitiated events on Base and relays encrypted transfers to Solana.
 * This is the privacy-preserving counterpart to auto-relayer-base-sol.ts.
 * 
 * Usage:
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor
 *   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH>
 */

import {
    createSolanaRpc,
    getProgramDerivedAddress,
    getU64Encoder,
    Endian,
    type Address as SolanaAddress,
    AccountRole,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
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
import { Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { CONFIGS } from "@internal/constants";
import { buildAndSendTransaction, getSolanaCliConfigKeypairSigner, getIdlConstant } from "@internal/sol";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed addresses (v5 - with setRemoteTokenForDemo)
const CONFIDENTIAL_BRIDGE_ADDRESS = "0x1C5d960F3757C59BEC347a536F4B811310B6f2aa" as Address;
const CONFIDENTIAL_TOKEN_ADDRESS = "0x2C492Fc664e54903A966d5D7f666556FF5BeF9F1" as Address;

// Bridge Program ID
const BRIDGE_PROGRAM_ID = new PublicKey("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");

// Inco Lightning Program ID
const INCO_LIGHTNING_ID = new PublicKey("5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj");

// --- Viem Client ---
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "event ConfidentialBridgeInitiated(uint256 indexed nonce, address indexed localToken, bytes32 indexed remoteToken, bytes32 toSolana, bytes32 encryptedAmount)",
]);

// Full ABI for decoding
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

console.log("=== Privacy Relayer (Base → Solana) ===");
console.log(`EVM Signer: ${evmAccount.address}`);
console.log(`Confidential Bridge: ${CONFIDENTIAL_BRIDGE_ADDRESS}`);

// --- Event Parsing ---
interface ConfidentialBridgeInitiatedEvent {
    nonce: bigint;
    localToken: Address;
    remoteToken: Hex;
    toSolana: Hex;
    encryptedAmount: Hex;
}

/**
 * Parse ConfidentialBridgeInitiated event from transaction receipt.
 */
function parseConfidentialBridgeInitiatedEvent(
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[]
): ConfidentialBridgeInitiatedEvent | null {
    for (const log of logs) {
        if (log.address.toLowerCase() === CONFIDENTIAL_BRIDGE_ADDRESS.toLowerCase()) {
            try {
                const decoded = decodeEventLog({
                    abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                    data: log.data,
                    topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
                });

                if (decoded.eventName === "ConfidentialBridgeInitiated") {
                    const args = decoded.args as any;
                    return {
                        nonce: args.nonce,
                        localToken: args.localToken,
                        remoteToken: args.remoteToken,
                        toSolana: args.toSolana,
                        encryptedAmount: args.encryptedAmount,
                    };
                }
            } catch (e) {
                // Not our event
            }
        }
    }
    return null;
}

/**
 * Convert bytes32 (solana pubkey) to Solana PublicKey.
 */
function bytes32ToPublicKey(bytes32: Hex): PublicKey {
    const bytes = toBytes(bytes32);
    return new PublicKey(bytes);
}

/**
 * Convert euint256 handle (bytes32) to Euint128 bytes for Solana.
 * Takes the lower 128 bits.
 */
function euint256ToEuint128Bytes(handle: Hex): Uint8Array {
    const bytes = toBytes(handle);
    // Take the lower 16 bytes (128 bits) - little endian on Solana
    // euint256 is 32 bytes, we take bytes [16:32] which are the lower bits in big-endian
    // But Solana uses little-endian, so we reverse
    const lower16 = bytes.slice(16, 32);
    return new Uint8Array(lower16.reverse());
}

/**
 * Relay a confidential bridge message from Base to Solana.
 */
async function relayConfidentialToSolana(txHash: string): Promise<boolean> {
    console.log(`\n=== Processing Base TX: ${txHash} ===`);

    try {
        // 1. Get transaction receipt
        const receipt = await basePublicClient.getTransactionReceipt({
            hash: txHash as Hash,
        });
        console.log(`   Block: ${receipt.blockNumber}`);

        // 2. Parse ConfidentialBridgeInitiated event
        const event = parseConfidentialBridgeInitiatedEvent(receipt.logs);

        if (!event) {
            console.log("   ❌ No ConfidentialBridgeInitiated event found");
            return false;
        }

        console.log(`   ✅ Found confidential bridge event:`);
        console.log(`      Nonce: ${event.nonce}`);
        console.log(`      Local Token: ${event.localToken}`);
        console.log(`      To Solana: ${event.toSolana}`);
        console.log(`      Encrypted Handle: ${event.encryptedAmount}`);

        // 3. Convert to Solana types
        const recipientPubkey = bytes32ToPublicKey(event.toSolana);
        const encryptedAmountBytes = euint256ToEuint128Bytes(event.encryptedAmount);
        const baseSender = toBytes(evmAccount.address).slice(0, 20);

        console.log(`   Recipient: ${recipientPubkey.toBase58()}`);
        console.log(`   Encrypted bytes: ${Buffer.from(encryptedAmountBytes).toString("hex")}`);

        // 4. Get Solana signer
        const rpc = createSolanaRpc(config.solana.rpcUrl);
        const payer = await getSolanaCliConfigKeypairSigner();
        console.log(`   Solana Payer: ${payer.address}`);

        // 5. Find the recipient's vault PDA
        // For the hackathon, we'll use the remoteToken as the Solana token mint
        // The remoteToken is bytes32 which encodes a 32-byte Solana pubkey
        const remoteTokenBytes = toBytes(event.remoteToken);
        const tokenMint = new PublicKey(remoteTokenBytes);
        console.log(`   Token Mint: ${tokenMint.toBase58()}`);

        const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("confidential_vault"),
                recipientPubkey.toBuffer(),
                tokenMint.toBuffer(),
            ],
            BRIDGE_PROGRAM_ID
        );
        console.log(`   Vault PDA: ${vaultPda.toBase58()}`);

        // 6. Find the bridge authority PDA
        const [bridgeAuthority, bridgeAuthBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge_authority")],
            BRIDGE_PROGRAM_ID
        );
        console.log(`   Bridge Authority: ${bridgeAuthority.toBase58()}`);

        // 7. Find the bridge state PDA
        const [bridgeState, bridgeBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("bridge")],
            BRIDGE_PROGRAM_ID
        );
        console.log(`   Bridge State: ${bridgeState.toBase58()}`);

        // 8. Check if vault exists
        const connection = new Connection(config.solana.rpcUrl, "confirmed");
        const vaultAccountInfo = await connection.getAccountInfo(vaultPda);
        
        if (!vaultAccountInfo) {
            console.log(`\n   ⚠️  Vault does not exist for recipient!`);
            console.log(`   The recipient needs to initialize a ConfidentialVault first.`);
            console.log(`   Vault PDA: ${vaultPda.toBase58()}`);
            console.log(`   Owner: ${recipientPubkey.toBase58()}`);
            console.log(`   Token Mint: ${tokenMint.toBase58()}`);
            console.log(`\n   To initialize, call initialize_confidential_vault on Solana.`);
            return false;
        }

        // 9. Build the relay_receive_confidential instruction
        // Anchor discriminator for "relay_receive_confidential" = sha256("global:relay_receive_confidential")[0:8]
        const crypto = await import("crypto");
        const discriminator = crypto.createHash("sha256")
            .update("global:relay_receive_confidential")
            .digest()
            .slice(0, 8);

        // Instruction data: discriminator + encrypted_amount (Vec<u8>) + base_sender ([u8; 20])
        // Vec<u8> in Borsh: 4-byte length (little endian) + data
        const encryptedLenBuf = Buffer.alloc(4);
        encryptedLenBuf.writeUInt32LE(encryptedAmountBytes.length, 0);
        
        const instructionData = Buffer.concat([
            discriminator,
            encryptedLenBuf,
            Buffer.from(encryptedAmountBytes),
            Buffer.from(baseSender),
        ]);

        console.log(`\n   📝 Building relay_receive_confidential instruction:`);
        console.log(`      Discriminator: ${discriminator.toString("hex")}`);
        console.log(`      Encrypted amount: ${encryptedAmountBytes.length} bytes`);
        console.log(`      Base sender: 0x${Buffer.from(baseSender).toString("hex")}`);

        // 10. Create instruction with accounts in order:
        // 1. relayer (signer, mutable)
        // 2. bridge (PDA)
        // 3. bridge_authority (PDA, mutable)
        // 4. vault (PDA, mutable)
        // 5. inco_lightning_program
        // 6. system_program
        const payerKeypair = Keypair.fromSecretKey(
            Uint8Array.from(JSON.parse(require("fs").readFileSync(
                require("os").homedir() + "/.config/solana/id.json", "utf-8"
            )))
        );

        const instruction = new TransactionInstruction({
            programId: BRIDGE_PROGRAM_ID,
            keys: [
                { pubkey: payerKeypair.publicKey, isSigner: true, isWritable: true },  // relayer
                { pubkey: bridgeState, isSigner: false, isWritable: false },            // bridge
                { pubkey: bridgeAuthority, isSigner: false, isWritable: true },         // bridge_authority
                { pubkey: vaultPda, isSigner: false, isWritable: true },                // vault
                { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },      // inco_lightning_program
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
            ],
            data: instructionData,
        });

        console.log(`\n   📤 Sending Solana transaction...`);

        // 11. Send transaction
        const { Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
        const tx = new Transaction().add(instruction);
        
        try {
            const signature = await sendAndConfirmTransaction(
                connection,
                tx,
                [payerKeypair],
                { commitment: "confirmed" }
            );
            
            console.log(`   ✅ Transaction confirmed!`);
            console.log(`   Signature: ${signature}`);
            console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
            return true;
        } catch (txError: any) {
            console.error(`   ❌ Transaction failed: ${txError.message}`);
            if (txError.logs) {
                console.error(`   Logs:`);
                txError.logs.forEach((log: string) => console.error(`      ${log}`));
            }
            return false;
        }

    } catch (error: any) {
        console.error(`   ❌ Error: ${error.message}`);
        if (error.cause) {
            console.error(`   Cause: ${JSON.stringify(error.cause)}`);
        }
        return false;
    }
}

/**
 * Monitor mode - watch for new confidential bridge events on Base.
 */
async function monitorMode() {
    console.log("\n=== Monitor Mode ===");
    console.log("Watching for ConfidentialBridgeInitiated events on Base...\n");

    let lastBlock = await basePublicClient.getBlockNumber();
    console.log(`Starting from block: ${lastBlock}`);

    while (true) {
        try {
            const currentBlock = await basePublicClient.getBlockNumber();

            if (currentBlock > lastBlock) {
                // Get logs for ConfidentialBridge
                const logs = await basePublicClient.getLogs({
                    address: CONFIDENTIAL_BRIDGE_ADDRESS,
                    fromBlock: lastBlock + 1n,
                    toBlock: currentBlock,
                });

                for (const log of logs) {
                    console.log(`\n[${new Date().toISOString()}] New event in TX: ${log.transactionHash}`);

                    // Try to parse as ConfidentialBridgeInitiated
                    try {
                        const decoded = decodeEventLog({
                            abi: CONFIDENTIAL_BRIDGE_FULL_ABI,
                            data: log.data,
                            topics: log.topics,
                        });

                        if (decoded.eventName === "ConfidentialBridgeInitiated") {
                            console.log("   📦 Confidential bridge event detected!");
                            await relayConfidentialToSolana(log.transactionHash!);
                        }
                    } catch {
                        console.log("   ℹ️ Other event type");
                    }
                }

                lastBlock = currentBlock;
            }

            console.log(`[${new Date().toISOString()}] Block: ${currentBlock}`);
            await new Promise((r) => setTimeout(r, 15000)); // 15 second polling (Base block time ~2s)

        } catch (error: any) {
            console.error(`Monitor error: ${error.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

/**
 * Demo mode - show what this relayer does.
 */
async function demoMode() {
    console.log("\n=== Privacy Bridge Demo (Base → Solana) ===");
    console.log(`
This relayer monitors ConfidentialBridgeInitiated events on Base and relays them to Solana.

Flow:
1. User encrypts amount on Base using @inco/js
2. User calls bridgePrivateToSolana() on Base ConfidentialBridge
3. This burns encrypted tokens and emits ConfidentialBridgeInitiated
4. Relayer picks up event and calls receive_confidential_in() on Solana
5. Solana bridge mints encrypted tokens to recipient's ConfidentialVault

Important Notes:
- euint256 (32 bytes) on EVM ↔ Euint128 (16 bytes) on SVM
- Handle conversion takes lower 128 bits
- Recipient must have initialized a ConfidentialVault on Solana

To test:
1. Get some test ETH on Base Sepolia
2. Bridge private tokens with ConfidentialBridge.bridgePrivateToSolana()
3. Run this relayer in monitor mode
4. Check recipient's vault on Solana
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
    } else if (arg && arg.startsWith("0x")) {
        await relayConfidentialToSolana(arg);
    } else {
        console.log("\nUsage:");
        console.log("  Monitor mode:     bun run src/privacy-relayer-base-to-sol.ts --monitor");
        console.log("  Process TX:       bun run src/privacy-relayer-base-to-sol.ts <BASE_TX_HASH>");
        console.log("  Demo info:        bun run src/privacy-relayer-base-to-sol.ts --demo");
    }
}

main().catch(console.error);
