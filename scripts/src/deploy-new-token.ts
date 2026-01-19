#!/usr/bin/env bun
/**
 * Deploy New DARK Token
 * 
 * Deploys a fresh ConfidentialCrossChainERC20 with confidentialMintForDemo support
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatEther,
    type Address,
    type Hex,
    encodeDeployData,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// --- Configuration ---
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Use existing ConfidentialBridge
const CONFIDENTIAL_BRIDGE = "0x1C5d960F3757C59BEC347a536F4B811310B6f2aa" as Address;

// Solana vault PDA (where tokens go on Solana)
const SOLANA_VAULT = new PublicKey("Gui8LGdtRwLJL772q1YuVJyRCD8RFbUe6rHiZu6f8Goc");

// --- Clients ---
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const walletClient = createWalletClient({
    account: evmAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// Token ABI
const TOKEN_ABI = parseAbi([
    "constructor(address bridge)",
    "function setRemoteTokenForDemo(bytes32 remoteToken) external",
    "function confidentialMintForDemo(address to, uint256 amount) external payable",
    "function balanceOf(address account) external view returns (uint256)",
    "function remoteToken() external view returns (bytes32)",
    "function totalSupply() external view returns (uint256)",
]);

function pubkeyToBytes32(pubkey: PublicKey): Hex {
    const bytes = pubkey.toBytes();
    return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

async function main() {
    console.log("\n=== Deploy New DARK Token ===\n");
    console.log(`Deployer: ${evmAccount.address}`);

    // Check balance
    const balance = await publicClient.getBalance({ address: evmAccount.address });
    console.log(`Balance: ${formatEther(balance)} ETH`);

    // Read bytecode from forge artifact
    console.log("\n--- Step 1: Reading Contract Bytecode ---");
    const artifactPath = path.join(
        __dirname,
        "../../base/out/ConfidentialCrossChainERC20.sol/ConfidentialCrossChainERC20.json"
    );
    
    if (!fs.existsSync(artifactPath)) {
        console.error(`❌ Artifact not found at: ${artifactPath}`);
        console.log("Make sure to run 'forge build' in the base directory first");
        return;
    }
    
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
    const bytecode = artifact.bytecode.object as Hex;
    console.log(`Bytecode length: ${(bytecode.length - 2) / 2} bytes`);

    // Deploy
    console.log("\n--- Step 2: Deploying Token ---");
    console.log(`Bridge address: ${CONFIDENTIAL_BRIDGE}`);
    
    // Encode constructor call
    const deployData = encodeDeployData({
        abi: TOKEN_ABI,
        bytecode: bytecode,
        args: [CONFIDENTIAL_BRIDGE],
    });

    console.log("⏳ Sending deploy transaction...");
    const deployHash = await walletClient.sendTransaction({
        data: deployData,
    });
    console.log(`Tx: ${deployHash}`);
    console.log(`View: https://sepolia.basescan.org/tx/${deployHash}`);

    console.log("⏳ Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    
    if (receipt.status !== "success") {
        console.error("❌ Deploy failed!");
        return;
    }
    
    const tokenAddress = receipt.contractAddress as Address;
    console.log(`✅ Token deployed at: ${tokenAddress}`);

    // Set remote token
    console.log("\n--- Step 3: Set Remote Token ---");
    const remoteBytes = pubkeyToBytes32(SOLANA_VAULT);
    console.log(`Remote (Solana vault): ${remoteBytes}`);

    const setRemoteHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "setRemoteTokenForDemo",
        args: [remoteBytes],
    });
    console.log(`Tx: ${setRemoteHash}`);
    await publicClient.waitForTransactionReceipt({ hash: setRemoteHash });
    console.log("✅ Remote token set!");

    // Mint test tokens
    console.log("\n--- Step 4: Mint DARK Tokens ---");
    const mintAmount = 1000n;
    const incoFee = BigInt("100000000000000"); // 0.0001 ETH
    
    console.log(`Minting ${mintAmount} DARK tokens...`);
    const mintHash = await walletClient.writeContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "confidentialMintForDemo",
        args: [evmAccount.address, mintAmount],
        value: incoFee,
    });
    console.log(`Tx: ${mintHash}`);
    console.log(`View: https://sepolia.basescan.org/tx/${mintHash}`);
    
    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
    if (mintReceipt.status === "success") {
        console.log(`✅ Minted ${mintAmount} DARK tokens!`);
    } else {
        console.error("❌ Mint failed!");
    }

    // Verify
    console.log("\n--- Step 5: Verify ---");
    
    const remote = await publicClient.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "remoteToken",
    });
    console.log(`Remote token: ${remote}`);

    const balanceHandle = await publicClient.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "balanceOf",
        args: [evmAccount.address],
    });
    console.log(`Balance (encrypted handle): ${balanceHandle}`);

    console.log("\n=== Deployment Complete ===");
    console.log(`DARK Token: ${tokenAddress}`);
    console.log(`Bridge: ${CONFIDENTIAL_BRIDGE}`);
    console.log(`Solana Vault: ${SOLANA_VAULT.toBase58()}`);
    console.log(`\nYou have ${mintAmount} DARK tokens (encrypted) ready to bridge!`);
    
    console.log("\n📋 To bridge, update execute-real-tx.ts:");
    console.log(`const CONFIDENTIAL_TOKEN = "${tokenAddress}" as Address;`);
}

main().catch(console.error);
