#!/usr/bin/env bun
/**
 * Automatic Base → Solana Relayer
 * 
 * Combines: Oracle sync + Prove message + Relay message
 * 
 * Usage: 
 *   EVM_PRIVATE_KEY=0x... bun run src/auto-relayer-base-sol.ts <BASE_TX_HASH>
 *   EVM_PRIVATE_KEY=0x... bun run src/auto-relayer-base-sol.ts --monitor
 */

import { z } from "zod";
import {
    Endian,
    getProgramDerivedAddress,
    getU64Encoder,
    createSolanaRpc,
    type Address as SolanaAddress,
    AccountRole,
    type AccountMeta,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
    createPublicClient,
    http,
    toBytes,
    keccak256,
    type Address,
    type Hash,
    type Hex,
    parseAbiItem,
    encodeAbiParameters,
} from "viem";
import { baseSepolia } from "viem/chains";
import { decodeEventLog } from "viem/utils";
import { privateKeyToAccount } from "viem/accounts";

import { fetchBridge, getProveMessageInstruction, getRelayMessageInstruction, fetchIncomingMessage } from "@base/bridge/bridge";
import { logger } from "@internal/logger";
import {
    buildAndSendTransaction,
    getSolanaCliConfigKeypairSigner,
    getIdlConstant,
} from "@internal/sol";
import { CONFIGS, type Config } from "@internal/constants";
import { BRIDGE_ABI } from "@internal/base/abi";

const DEPLOY_ENV = "testnet-alpha" as const;
const config = CONFIGS[DEPLOY_ENV];

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
const basePublicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

console.log("=== Dark Bridge Auto-Relayer (Base → Solana) ===");
console.log(`EVM Signer: ${evmAccount.address}`);

// MessageInitiated event signature for scanning
const MESSAGE_INITIATED_EVENT_SIG = "MessageInitiated";

/**
 * Full Base→Solana relay flow
 */
async function relayBaseToSolana(txHash: string): Promise<boolean> {
    console.log(`\n=== Processing Base TX: ${txHash} ===`);

    try {
        const rpc = createSolanaRpc(config.solana.rpcUrl);
        const payer = await getSolanaCliConfigKeypairSigner();
        console.log(`Solana Payer: ${payer.address}`);

        // 1. Get Bridge state
        const [bridgeAddress] = await getProgramDerivedAddress({
            programAddress: config.solana.bridgeProgram,
            seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
        });

        const accountRpc = rpc as Parameters<typeof fetchBridge>[0];
        const bridge = await fetchBridge(accountRpc, bridgeAddress);
        const baseBlockNumber = bridge.data.baseBlockNumber;
        console.log(`   Bridge base block: ${baseBlockNumber}`);

        // 2. Get tx receipt and extract event
        const txReceipt = await basePublicClient.getTransactionReceipt({
            hash: txHash as Hash,
        });
        console.log(`   TX block: ${txReceipt.blockNumber}`);

        // Check if we need to update oracle
        if (baseBlockNumber < txReceipt.blockNumber) {
            console.log(`   ⚠️  Oracle needs to sync to block ${txReceipt.blockNumber}+`);
            console.log(`   Running oracle sync...`);
            await syncOracle(rpc, bridgeAddress, payer);

            // Re-fetch bridge state
            const updatedBridge = await fetchBridge(accountRpc, bridgeAddress);
            console.log(`   Updated base block: ${updatedBridge.data.baseBlockNumber}`);

            if (updatedBridge.data.baseBlockNumber < txReceipt.blockNumber) {
                console.log(`   ❌ Oracle still behind. Try again later.`);
                return false;
            }
        }

        // 3. Extract MessageInitiated event
        const events = txReceipt.logs
            .map((log) => {
                try {
                    const decoded = decodeEventLog({
                        abi: BRIDGE_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    return decoded.eventName === "MessageInitiated" ? decoded.args : null;
                } catch { return null; }
            })
            .filter((e) => e !== null);

        if (events.length === 0) {
            console.log("   ❌ No MessageInitiated events found");
            return false;
        }

        const event = events[0]!;
        console.log(`   Message hash: ${event.messageHash}`);
        console.log(`   Nonce: ${event.message.nonce}`);

        // 4. Derive message PDA
        const [messageAddress] = await getProgramDerivedAddress({
            programAddress: config.solana.bridgeProgram,
            seeds: [
                Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
                toBytes(event.messageHash),
            ],
        });
        console.log(`   Message PDA: ${messageAddress}`);

        // 5. Check if already proven/relayed
        let isProven = false;
        let isRelayed = false;
        try {
            const msgAccount = await fetchIncomingMessage(accountRpc, messageAddress);
            isProven = true;
            isRelayed = msgAccount.data.executed;
        } catch { }

        // 6. Prove if needed
        if (!isProven) {
            console.log("   Proving message...");
            await proveMessage(rpc, payer, bridgeAddress, txHash as Hash, baseBlockNumber, event);
            console.log("   ✅ Proved!");
        } else {
            console.log("   Already proven");
        }

        // 7. Relay if needed
        if (!isRelayed) {
            console.log("   Relaying message...");
            await relayMessage(rpc, payer, bridgeAddress, messageAddress, event);
            console.log("   ✅ Relayed!");
        } else {
            console.log("   Already relayed");
        }

        return true;

    } catch (error: any) {
        console.error(`   Error: ${error.message}`);
        return false;
    }
}

/**
 * Sync the oracle output root
 */
async function syncOracle(rpc: any, bridgeAddress: SolanaAddress, payer: any) {
    const currentBlock = await basePublicClient.getBlockNumber();
    console.log(`   Syncing oracle to block ${currentBlock}...`);

    // Get root from Base
    const root = await basePublicClient.readContract({
        address: config.base.bridgeContract as Address,
        abi: [{ type: "function", inputs: [], name: "getRoot", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view" }],
        functionName: "getRoot",
    });

    const nonce = await basePublicClient.readContract({
        address: config.base.bridgeContract as Address,
        abi: [{ type: "function", inputs: [], name: "getNextNonce", outputs: [{ name: "", type: "uint64" }], stateMutability: "view" }],
        functionName: "getNextNonce",
    });

    console.log(`   MMR Root: ${root}`);
    console.log(`   Leaf count: ${nonce}`);

    // Sign the output root
    const outputRoot = keccak256(
        encodeAbiParameters(
            [{ type: "uint64" }, { type: "bytes32" }, { type: "uint32" }],
            [currentBlock, root as Hex, Number(nonce)]
        )
    );

    const signature = await evmAccount.signMessage({ message: { raw: toBytes(outputRoot) } });
    const sigBytes = toBytes(signature);

    // Get output root PDA
    const [outputRootAddress] = await getProgramDerivedAddress({
        programAddress: config.solana.bridgeProgram,
        seeds: [
            Buffer.from(getIdlConstant("OUTPUT_ROOT_SEED")),
            getU64Encoder({ endian: Endian.Little }).encode(currentBlock),
        ],
    });

    // This would call register_output_root - for now using CLI
    console.log(`   Oracle sync requires register_output_root instruction`);
    console.log(`   Run: bun run src/fast-forward-oracle.ts`);
}

/**
 * Prove a message on Solana
 */
async function proveMessage(
    rpc: any,
    payer: any,
    bridgeAddress: SolanaAddress,
    txHash: Hash,
    baseBlockNumber: bigint,
    event: any
) {
    const [outputRootAddress] = await getProgramDerivedAddress({
        programAddress: config.solana.bridgeProgram,
        seeds: [
            Buffer.from(getIdlConstant("OUTPUT_ROOT_SEED")),
            getU64Encoder({ endian: Endian.Little }).encode(baseBlockNumber),
        ],
    });

    const [messageAddress] = await getProgramDerivedAddress({
        programAddress: config.solana.bridgeProgram,
        seeds: [
            Buffer.from(getIdlConstant("INCOMING_MESSAGE_SEED")),
            toBytes(event.messageHash),
        ],
    });

    // Generate proof from Base
    const rawProof = await basePublicClient.readContract({
        address: config.base.bridgeContract as Address,
        abi: BRIDGE_ABI,
        functionName: "generateProof",
        args: [event.message.nonce],
        blockNumber: baseBlockNumber,
    });

    const ix = getProveMessageInstruction(
        {
            payer,
            outputRoot: outputRootAddress,
            message: messageAddress,
            bridge: bridgeAddress,
            systemProgram: SYSTEM_PROGRAM_ADDRESS,
            nonce: event.message.nonce,
            sender: toBytes(event.message.sender),
            data: toBytes(event.message.data),
            proof: (rawProof as string[]).map((e: string) => toBytes(e)),
            messageHash: toBytes(event.messageHash),
        },
        { programAddress: config.solana.bridgeProgram }
    );

    const signature = await buildAndSendTransaction(
        { type: "deploy-env", value: DEPLOY_ENV },
        [ix],
        payer
    );
    console.log(`   Prove TX: ${signature}`);
}

/**
 * Relay a proven message on Solana
 */
async function relayMessage(
    rpc: any,
    payer: any,
    bridgeAddress: SolanaAddress,
    messageAddress: SolanaAddress,
    event: any
) {
    const accountRpc = rpc as Parameters<typeof fetchIncomingMessage>[0];
    const msgAccount = await fetchIncomingMessage(accountRpc, messageAddress);

    // Build remaining accounts for the call
    const remainingAccounts: AccountMeta[] = [];

    // For Call messages, add the target program
    if (msgAccount.data.message.__kind === "Call") {
        const ixs = msgAccount.data.message.fields[0];
        if (ixs && ixs.length > 0) {
            for (const ix of ixs) {
                remainingAccounts.push({
                    address: ix.to as SolanaAddress,
                    role: AccountRole.WRITABLE,
                });
            }
        }
    }

    const ix = getRelayMessageInstruction(
        {
            message: messageAddress,
            bridge: bridgeAddress,
        },
        { programAddress: config.solana.bridgeProgram }
    );

    // Add remaining accounts if any
    if (remainingAccounts.length > 0) {
        (ix as any).accounts = [...(ix as any).accounts, ...remainingAccounts];
    }

    const signature = await buildAndSendTransaction(
        { type: "deploy-env", value: DEPLOY_ENV },
        [ix],
        payer
    );
    console.log(`   Relay TX: ${signature}`);
}

/**
 * Monitor mode - watch for new messages
 */
async function monitorMode() {
    console.log("\n=== Monitor Mode ===");
    console.log("Watching for new MessageInitiated events on Base...\n");

    let lastBlock = await basePublicClient.getBlockNumber();

    while (true) {
        const currentBlock = await basePublicClient.getBlockNumber();

        if (currentBlock > lastBlock) {
            // Scan for events
            try {
                const logs = await basePublicClient.getLogs({
                    address: config.base.bridgeContract as Address,
                    fromBlock: lastBlock + 1n,
                    toBlock: currentBlock,
                });

                if (logs.length > 0) {
                    console.log(`Found ${logs.length} new message(s)`);
                    for (const log of logs) {
                        if (log.transactionHash) {
                            await relayBaseToSolana(log.transactionHash);
                        }
                    }
                }
            } catch (e: any) {
                console.error(`Scan error: ${e.message}`);
            }

            lastBlock = currentBlock;
        }

        console.log(`[${new Date().toISOString()}] Block: ${currentBlock}`);
        await new Promise(r => setTimeout(r, 30000));
    }
}

// Main
async function main() {
    const arg = process.argv[2];

    if (arg === "--monitor") {
        await monitorMode();
    } else if (arg && arg.startsWith("0x")) {
        await relayBaseToSolana(arg);
    } else {
        console.log("\nUsage:");
        console.log("  Process specific TX:  bun run src/auto-relayer-base-sol.ts <BASE_TX_HASH>");
        console.log("  Monitor mode:         bun run src/auto-relayer-base-sol.ts --monitor");
    }
}

main().catch(console.error);
