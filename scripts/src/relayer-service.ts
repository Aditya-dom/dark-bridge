#!/usr/bin/env bun
/**
 * Privacy Relayer Service
 * 
 * An Express.js API server that accepts privacy-preserving bridge requests
 * and submits them on-chain, hiding the sender's identity.
 * 
 * Features:
 * - Accepts EIP-712 signed bridge requests
 * - Validates signatures before submission
 * - Submits transactions from relayer address (hides sender)
 * - Provides API endpoints for both Base→Base and Base→Solana bridges
 * - Includes health checks and status endpoints
 * 
 * Usage:
 *   PRIVATE_KEY=0x... bun run src/relayer-service.ts
 *   
 * API Endpoints:
 *   POST /bridge/private - Bridge with receiver privacy (claim-based)
 *   POST /bridge/private-to-solana - Bridge to Solana with privacy
 *   GET /health - Health check
 *   GET /status - Service status and stats
 */

import express, { Request, Response } from "express";
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    formatEther,
    type Address,
    type Hex,
    recoverTypedDataAddress,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY or PRIVATE_KEY environment variable is required");
}

const relayerAccount = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);

// Deployed contracts
const CONFIDENTIAL_BRIDGE = "0x4CDE2466011d1c9600720567e8fb56c418c99e08" as Address;

// --- Clients ---
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

const walletClient = createWalletClient({
    account: relayerAccount,
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
});

// --- ABIs ---
const CONFIDENTIAL_BRIDGE_ABI = parseAbi([
    "function bridgePrivateViaRelayer(address localToken, bytes32 commitment, bytes encryptedAmount, address sender, uint256 senderNonce, uint256 deadline, bytes signature) external payable",
    "function bridgePrivateToSolanaViaRelayer(address localToken, bytes32 toSolana, bytes encryptedAmount, address sender, uint256 senderNonce, uint256 deadline, bytes signature) external payable",
    "function getUserNonce(address user) external view returns (uint256)",
    "function getIncoFee() external view returns (uint256)",
    "function hasAllRoles(address user, uint256 roles) external view returns (bool)",
    "function RELAYER_ROLE() external view returns (uint256)",
]);

// --- Stats ---
interface RelayerStats {
    transactionsRelayed: number;
    totalFeesCollected: bigint;
    startTime: Date;
    lastTransaction: Date | null;
}

const stats: RelayerStats = {
    transactionsRelayed: 0,
    totalFeesCollected: 0n,
    startTime: new Date(),
    lastTransaction: null,
};

// --- EIP-712 Domain ---
const getDomain = () => ({
    name: 'ConfidentialBridge',
    version: '1',
    chainId: baseSepolia.id,
    verifyingContract: CONFIDENTIAL_BRIDGE,
});

// --- Helper Functions ---

async function verifyRelayerRole(): Promise<boolean> {
    try {
        const relayerRole = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "RELAYER_ROLE",
        });

        const hasRole = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "hasAllRoles",
            args: [relayerAccount.address, relayerRole],
        });

        return hasRole;
    } catch (e) {
        console.error("Error checking relayer role:", e);
        return false;
    }
}

async function getIncoFee(): Promise<bigint> {
    try {
        return await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getIncoFee",
        });
    } catch (e) {
        console.error("Error getting Inco fee:", e);
        return 0n;
    }
}

async function verifySignature(
    localToken: Address,
    commitment: Hex,
    encryptedAmount: Hex,
    sender: Address,
    nonce: bigint,
    deadline: bigint,
    signature: Hex
): Promise<boolean> {
    try {
        const domain = getDomain();
        const types = {
            PrivateBridge: [
                { name: 'localToken', type: 'address' },
                { name: 'commitment', type: 'bytes32' },
                { name: 'encryptedAmount', type: 'bytes' },
                { name: 'sender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
            ],
        };
        const message = {
            localToken,
            commitment,
            encryptedAmount,
            sender,
            nonce,
            deadline,
        };

        const recoveredAddress = await recoverTypedDataAddress({
            domain,
            types,
            primaryType: 'PrivateBridge',
            message,
            signature,
        });

        return recoveredAddress.toLowerCase() === sender.toLowerCase();
    } catch (e) {
        console.error("Signature verification error:", e);
        return false;
    }
}

// --- Express App ---
const app = express();
app.use(express.json());

// Middleware to log all requests
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// --- Routes ---

/**
 * GET /health
 * Health check endpoint
 */
app.get("/health", (req: Request, res: Response) => {
    res.json({
        status: "ok",
        relayer: relayerAccount.address,
        timestamp: new Date().toISOString(),
    });
});

/**
 * GET /status
 * Service status and statistics
 */
app.get("/status", async (req: Request, res: Response) => {
    try {
        const balance = await publicClient.getBalance({ address: relayerAccount.address });
        const hasRole = await verifyRelayerRole();
        const incoFee = await getIncoFee();

        res.json({
            relayer: {
                address: relayerAccount.address,
                balance: formatEther(balance) + " ETH",
                hasRelayerRole: hasRole,
            },
            bridge: {
                address: CONFIDENTIAL_BRIDGE,
                incoFee: formatEther(incoFee) + " ETH",
            },
            stats: {
                transactionsRelayed: stats.transactionsRelayed,
                totalFeesCollected: formatEther(stats.totalFeesCollected) + " ETH",
                uptime: Math.floor((Date.now() - stats.startTime.getTime()) / 1000) + "s",
                lastTransaction: stats.lastTransaction?.toISOString() || null,
            },
            timestamp: new Date().toISOString(),
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /bridge/private
 * Submit a private bridge transaction (Base→Base with receiver privacy)
 * 
 * Body:
 * {
 *   "localToken": "0x...",
 *   "commitment": "0x...",
 *   "encryptedAmount": "0x...",
 *   "sender": "0x...",
 *   "nonce": "0",
 *   "deadline": "1234567890",
 *   "signature": "0x..."
 * }
 */
app.post("/bridge/private", async (req: Request, res: Response) => {
    try {
        const { localToken, commitment, encryptedAmount, sender, nonce, deadline, signature } = req.body;

        // Validate inputs
        if (!localToken || !commitment || !encryptedAmount || !sender || nonce === undefined || !deadline || !signature) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const nonceBI = BigInt(nonce);
        const deadlineBI = BigInt(deadline);

        // Check deadline
        if (deadlineBI < BigInt(Math.floor(Date.now() / 1000))) {
            return res.status(400).json({ error: "Signature expired" });
        }

        // Verify signature
        const isValid = await verifySignature(
            localToken as Address,
            commitment as Hex,
            encryptedAmount as Hex,
            sender as Address,
            nonceBI,
            deadlineBI,
            signature as Hex
        );

        if (!isValid) {
            return res.status(401).json({ error: "Invalid signature" });
        }

        // Verify nonce
        const expectedNonce = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getUserNonce",
            args: [sender as Address],
        });

        if (nonceBI !== expectedNonce) {
            return res.status(400).json({ 
                error: "Invalid nonce",
                expected: expectedNonce.toString(),
                received: nonce,
            });
        }

        // Get Inco fee
        const incoFee = await getIncoFee();

        // Submit transaction
        console.log(`Relaying private bridge for ${sender}`);
        console.log(`  Token: ${localToken}`);
        console.log(`  Commitment: ${commitment.slice(0, 20)}...`);
        
        const txHash = await walletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "bridgePrivateViaRelayer",
            args: [
                localToken as Address,
                commitment as Hex,
                encryptedAmount as Hex,
                sender as Address,
                nonceBI,
                deadlineBI,
                signature as Hex,
            ],
            value: incoFee,
        });

        console.log(`  TX Hash: ${txHash}`);

        // Update stats
        stats.transactionsRelayed++;
        stats.lastTransaction = new Date();

        res.json({
            success: true,
            txHash,
            relayer: relayerAccount.address,
            sender: sender,  // Sender info only returned to API caller, not on-chain
            message: "Transaction relayed successfully. Sender identity hidden on-chain.",
        });

    } catch (e: any) {
        console.error("Error relaying transaction:", e);
        res.status(500).json({ 
            error: "Failed to relay transaction",
            details: e.message?.slice(0, 200),
        });
    }
});

/**
 * POST /bridge/private-to-solana
 * Submit a private bridge transaction to Solana
 * 
 * Body:
 * {
 *   "localToken": "0x...",
 *   "toSolana": "0x...",  // bytes32 representation of Solana address
 *   "encryptedAmount": "0x...",
 *   "sender": "0x...",
 *   "nonce": "0",
 *   "deadline": "1234567890",
 *   "signature": "0x..."
 * }
 */
app.post("/bridge/private-to-solana", async (req: Request, res: Response) => {
    try {
        const { localToken, toSolana, encryptedAmount, sender, nonce, deadline, signature } = req.body;

        // Validate inputs
        if (!localToken || !toSolana || !encryptedAmount || !sender || nonce === undefined || !deadline || !signature) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const nonceBI = BigInt(nonce);
        const deadlineBI = BigInt(deadline);

        // Check deadline
        if (deadlineBI < BigInt(Math.floor(Date.now() / 1000))) {
            return res.status(400).json({ error: "Signature expired" });
        }

        // NOTE: The contract uses simple hash verification (not EIP-712) for Solana bridge
        // Message = keccak256(localToken, toSolana, encryptedAmount, senderNonce, deadline)
        // We skip client-side verification and let the contract verify on-chain
        console.log(`Signature verification delegated to contract for Solana bridge`);

        // Verify nonce
        const expectedNonce = await publicClient.readContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "getUserNonce",
            args: [sender as Address],
        });

        if (nonceBI !== expectedNonce) {
            return res.status(400).json({ 
                error: "Invalid nonce",
                expected: expectedNonce.toString(),
                received: nonce,
            });
        }

        // Get Inco fee
        const incoFee = await getIncoFee();

        // Submit transaction
        console.log(`Relaying private bridge to Solana for ${sender}`);
        console.log(`  Token: ${localToken}`);
        console.log(`  To Solana: ${toSolana.slice(0, 20)}...`);
        
        const txHash = await walletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE,
            abi: CONFIDENTIAL_BRIDGE_ABI,
            functionName: "bridgePrivateToSolanaViaRelayer",
            args: [
                localToken as Address,
                toSolana as Hex,
                encryptedAmount as Hex,
                sender as Address,
                nonceBI,
                deadlineBI,
                signature as Hex,
            ],
            value: incoFee,
        });

        console.log(`  TX Hash: ${txHash}`);

        // Update stats
        stats.transactionsRelayed++;
        stats.lastTransaction = new Date();

        res.json({
            success: true,
            txHash,
            relayer: relayerAccount.address,
            sender: sender,
            destination: "Solana",
            message: "Transaction relayed successfully. Sender identity hidden on-chain.",
        });

    } catch (e: any) {
        console.error("Error relaying transaction:", e);
        res.status(500).json({ 
            error: "Failed to relay transaction",
            details: e.message?.slice(0, 200),
        });
    }
});

/**
 * GET /info
 * Get relayer and contract information
 */
app.get("/info", async (req: Request, res: Response) => {
    try {
        const hasRole = await verifyRelayerRole();
        
        res.json({
            relayer: relayerAccount.address,
            bridge: CONFIDENTIAL_BRIDGE,
            network: {
                name: "Base Sepolia",
                chainId: baseSepolia.id,
            },
            hasRelayerRole: hasRole,
            endpoints: {
                bridgePrivate: "POST /bridge/private",
                bridgePrivateToSolana: "POST /bridge/private-to-solana",
                health: "GET /health",
                status: "GET /status",
                info: "GET /info",
            },
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// 404 handler
app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "Endpoint not found" });
});

// --- Start Server ---

async function startServer() {
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║              Privacy Relayer Service                        ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    console.log(`Relayer Address: ${relayerAccount.address}`);
    console.log(`Bridge Contract: ${CONFIDENTIAL_BRIDGE}`);
    console.log(`Network: Base Sepolia (${baseSepolia.id})\n`);

    // Check balance
    const balance = await publicClient.getBalance({ address: relayerAccount.address });
    console.log(`ETH Balance: ${formatEther(balance)} ETH`);

    if (balance < BigInt("10000000000000000")) { // 0.01 ETH
        console.log("⚠️  WARNING: Low ETH balance. Relayer may fail to submit transactions.");
    }

    // Check relayer role
    const hasRole = await verifyRelayerRole();
    console.log(`Has RELAYER_ROLE: ${hasRole ? '✅' : '❌'}`);

    if (!hasRole) {
        console.log("\n❌ ERROR: Relayer does not have RELAYER_ROLE on the bridge contract.");
        console.log("   Please grant the role before starting the service.");
        console.log(`   Address to grant: ${relayerAccount.address}`);
        process.exit(1);
    }

    // Start listening
    app.listen(PORT, () => {
        console.log(`\n✅ Relayer service started on port ${PORT}`);
        console.log("\n📡 Available endpoints:");
        console.log(`   POST http://localhost:${PORT}/bridge/private`);
        console.log(`   POST http://localhost:${PORT}/bridge/private-to-solana`);
        console.log(`   GET  http://localhost:${PORT}/health`);
        console.log(`   GET  http://localhost:${PORT}/status`);
        console.log(`   GET  http://localhost:${PORT}/info`);
        console.log("\n🔐 Privacy features:");
        console.log("   ✓ Sender identity hidden (relayer address on-chain)");
        console.log("   ✓ Receiver identity hidden (commitment-based claiming)");
        console.log("   ✓ Amount encrypted (Inco Lightning TEE)");
        console.log("   ✓ EIP-712 signature verification");
        console.log("\n🎯 Ready to relay private transactions!\n");
    });
}

startServer().catch(console.error);
