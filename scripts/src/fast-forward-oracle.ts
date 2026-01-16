#!/usr/bin/env bun
/**
 * Fast-forward Oracle - Register output root at a high block number
 * 
 * This script jumps the oracle to near the current Base block number
 * by registering an output root at a block that's after the test transaction.
 */

import { address } from "@solana/kit";
import { toBytes, keccak256, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
    buildAndSendTransaction,
    getSolanaCliConfigKeypairSigner,
} from "@internal/sol";

import { logger } from "@internal/logger";

// Constants
const BRIDGE_PROGRAM_ID = address("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const BASE_BRIDGE = "0x8e46419298a9620ea326113baf4019a23594bb11" as const;
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || "0x2526bbb0e6f0b2b5974fd974d7d26907e584d44c1de55876d2ef4b794fae97db";

// ABI for getting MMR root
const BRIDGE_ABI = [
    { type: "function", inputs: [], name: "getRoot", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view" },
    { type: "function", inputs: [], name: "getNextNonce", outputs: [{ name: "", type: "uint64" }], stateMutability: "view" },
] as const;


async function main() {
    logger.info("=== Fast-forward Oracle ===");

    const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
    const solanaPayer = await getSolanaCliConfigKeypairSigner();

    logger.info(`EVM Signer: ${evmAccount.address}`);
    logger.info(`Solana Payer: ${solanaPayer.address}`);

    // Create Base client
    const baseClient = createPublicClient({
        chain: baseSepolia,
        transport: http("https://sepolia.base.org"),
    });

    // Get current Base block
    const currentBlock = await baseClient.getBlockNumber();
    logger.info(`Current Base Block: ${currentBlock}`);

    // Target block (must be divisible by 300)
    // Force to 36409800 to cover our test tx at block 36409637
    const targetBlock = 36409800n;
    logger.info(`Target Block (aligned): ${targetBlock}`);

    // Get MMR root and nonce at target block
    const mmrRoot = await baseClient.readContract({
        address: BASE_BRIDGE,
        abi: BRIDGE_ABI,
        functionName: "getRoot",
        blockNumber: targetBlock,
    }) as `0x${string}`;

    const totalLeafCount = await baseClient.readContract({
        address: BASE_BRIDGE,
        abi: BRIDGE_ABI,
        functionName: "getNextNonce",
        blockNumber: targetBlock,
    }) as bigint;

    logger.info(`MMR Root: ${mmrRoot}`);
    logger.info(`Total Leaves: ${totalLeafCount}`);

    // Build raw message for signing
    const blockNumberBE = Buffer.alloc(8);
    blockNumberBE.writeBigUInt64BE(targetBlock);

    const leafCountBE = Buffer.alloc(8);
    leafCountBE.writeBigUInt64BE(totalLeafCount);

    const rawMessage = Buffer.concat([
        Buffer.from(mmrRoot.slice(2), 'hex'),
        blockNumberBE,
        leafCountBE,
    ]);

    // Sign with EIP-191 prefix
    const signature = await evmAccount.signMessage({
        message: { raw: rawMessage },
    });

    logger.info(`Signature: ${signature.slice(0, 20)}...`);

    // Build and send Solana transaction
    const { getProgramDerivedAddress } = await import("@solana/kit");

    const [bridgeAddress] = await getProgramDerivedAddress({
        programAddress: BRIDGE_PROGRAM_ID,
        seeds: [Buffer.from("bridge")],
    });

    const blockBytes = Buffer.alloc(8);
    blockBytes.writeBigUInt64LE(targetBlock);

    const [outputRootAddress] = await getProgramDerivedAddress({
        programAddress: BRIDGE_PROGRAM_ID,
        seeds: [Buffer.from("output_root"), blockBytes],
    });

    // Import instruction builder
    const { getRegisterOutputRootInstruction } = await import("@base/bridge/bridge");
    const { SYSTEM_PROGRAM_ADDRESS } = await import("@solana-program/system");

    const partnerConfigAddress = address("S1GN4jus9XzKVVnoHqfkjo1GN8bX46gjXZQwsdGBPHE");

    const ix = getRegisterOutputRootInstruction(
        {
            payer: solanaPayer,
            root: outputRootAddress,
            bridge: bridgeAddress,
            partnerConfig: partnerConfigAddress,
            systemProgram: SYSTEM_PROGRAM_ADDRESS,
            outputRoot: toBytes(mmrRoot),
            baseBlockNumber: targetBlock,
            totalLeafCount: totalLeafCount,
            signatures: [signature].map(s => new Uint8Array(Buffer.from(s.slice(2), 'hex'))),
        },
        { programAddress: BRIDGE_PROGRAM_ID }
    );

    logger.info("Sending transaction...");
    const txSig = await buildAndSendTransaction(
        { type: "rpc-url", value: "https://api.devnet.solana.com" },
        [ix],
        solanaPayer
    );

    logger.success(`Transaction confirmed: ${txSig}`);
    logger.info(`Bridge synced to block ${targetBlock}!`);
}

main().catch((error) => {
    logger.error("Failed:", error);
    process.exit(1);
});
