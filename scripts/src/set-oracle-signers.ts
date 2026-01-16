#!/usr/bin/env bun
/**
 * Set Oracle Signers Script
 * 
 * Updates the Base oracle signer configuration on the Solana bridge program.
 * Must be run by the program's upgrade authority.
 */

import {
    getProgramDerivedAddress,
    address,
} from "@solana/kit";
import { toBytes } from "viem";

import { getSetOracleSignersInstruction, type BaseOracleConfig } from "@base/bridge/bridge";

import { logger } from "@internal/logger";
import {
    buildAndSendTransaction,
    getSolanaCliConfigKeypairSigner,
    getIdlConstant,
    getProgramDataAddress,
} from "@internal/sol";

const BRIDGE_PROGRAM_ID = address("EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9");
const NEW_ORACLE_SIGNER = "0xF8AF04bF0Ac151f2050436603d81Ba20f449028F";

async function main() {
    logger.info("--- Set Oracle Signers Script ---");

    // Get payer (must be upgrade authority)
    const payer = await getSolanaCliConfigKeypairSigner();
    logger.info(`Payer (Upgrade Authority): ${payer.address}`);

    // Derive bridge PDA
    const [bridgeAddress] = await getProgramDerivedAddress({
        programAddress: BRIDGE_PROGRAM_ID,
        seeds: [Buffer.from(getIdlConstant("BRIDGE_SEED"))],
    });
    logger.info(`Bridge: ${bridgeAddress}`);

    // Get program data address
    const programDataAddress = await getProgramDataAddress(BRIDGE_PROGRAM_ID);
    logger.info(`Program Data: ${programDataAddress}`);

    // Create oracle config with our signer
    const maxSignerCount = getIdlConstant("MAX_SIGNER_COUNT") as number;
    const signerBytes = toBytes(NEW_ORACLE_SIGNER);

    const signers: Uint8Array[] = [
        signerBytes,
        ...Array(maxSignerCount - 1).fill(new Uint8Array(20)),
    ];

    const baseOracleConfig: BaseOracleConfig = {
        threshold: 1,
        signerCount: 1,
        signers,
    };

    logger.info(`New Oracle Signer: ${NEW_ORACLE_SIGNER}`);
    logger.info(`Threshold: 1`);

    // Build instruction
    const ix = getSetOracleSignersInstruction(
        {
            upgradeAuthority: payer,
            bridge: bridgeAddress,
            programData: programDataAddress,
            program: BRIDGE_PROGRAM_ID,
            cfg: baseOracleConfig,
        },
        { programAddress: BRIDGE_PROGRAM_ID }
    );

    // Send transaction
    logger.info("Sending transaction...");
    const signature = await buildAndSendTransaction(
        { type: "rpc-url", value: "https://api.devnet.solana.com" },
        [ix],
        payer
    );

    logger.success("Oracle signers updated!");
    logger.success(`Signature: ${signature}`);
}

main().catch((error) => {
    logger.error("Failed:", error);
    process.exit(1);
});
