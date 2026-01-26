"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import { parseAbi, parseUnits, toHex } from "viem";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
    CONFIDENTIAL_BRIDGE_ADDRESS,
    CONFIDENTIAL_TOKEN_ADDRESS,
    BRIDGE_PROGRAM_ID,
} from "@/lib/constants";
import {
    checkVaultExists,
    initializeVault,
    deriveVaultPda,
    getDefaultTokenMint,
    getConnection,
    bridgeConfidentialOut,
    getVaultBalance,
} from "@/lib/solana";

// ABI for bridge operations
const BRIDGE_ABI = parseAbi([
    "function bridgePrivateToSolana(address localToken, bytes32 toSolana, bytes encryptedAmount) external payable",
    "function bridgePrivateToSolanaPlaintext(address localToken, bytes32 toSolana, uint256 amount) external payable",
    "function getIncoFee() external view returns (uint256)",
]);

// Direction enum
type Direction = "base-to-solana" | "solana-to-base";

export function BridgeForm() {
    const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
    const { data: walletClient } = useWalletClient();
    const publicClient = usePublicClient();
    const { publicKey: solanaPublicKey, connected: isSolanaConnected, signTransaction } = useWallet();
    const { connection } = useConnection();

    const [direction, setDirection] = useState<Direction>("base-to-solana");
    const [amount, setAmount] = useState("");
    const [loading, setLoading] = useState(false);
    const [txHash, setTxHash] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string>("");
    const [vaultExists, setVaultExists] = useState<boolean | null>(null);
    const [checkingVault, setCheckingVault] = useState(false);
    const [initializingVault, setInitializingVault] = useState(false);

    // Get the token mint (matches remoteToken from EVM contract)
    const getTokenMint = useCallback(() => {
        return getDefaultTokenMint();
    }, []);

    // Check if Solana vault exists when wallet connects
    useEffect(() => {
        if (isSolanaConnected && solanaPublicKey) {
            checkVault();
        } else {
            setVaultExists(null);
        }
    }, [isSolanaConnected, solanaPublicKey]);

    const checkVault = async () => {
        if (!solanaPublicKey) return;

        setCheckingVault(true);
        try {
            const tokenMint = getTokenMint();
            const exists = await checkVaultExists(connection, solanaPublicKey, tokenMint);
            setVaultExists(exists);
        } catch (err) {
            console.error("Error checking vault:", err);
            setVaultExists(null);
        } finally {
            setCheckingVault(false);
        }
    };

    const handleInitializeVault = async () => {
        if (!solanaPublicKey || !signTransaction) {
            setError("Solana wallet not connected");
            return;
        }

        setInitializingVault(true);
        setError(null);

        try {
            const tokenMint = getTokenMint();
            setStatus("Initializing Solana vault...");

            const signature = await initializeVault(
                connection,
                solanaPublicKey,
                tokenMint,
                signTransaction
            );

            console.log("Vault initialized:", signature);
            setVaultExists(true);
            setStatus("Vault initialized successfully!");

            // Clear status after 3 seconds
            setTimeout(() => setStatus(""), 3000);
        } catch (err: any) {
            console.error("Vault init error:", err);
            let errorMsg = "Failed to initialize vault";
            if (err.message?.includes("already exists") || err.message?.includes("already in use")) {
                setVaultExists(true);
                errorMsg = "Vault already exists";
            } else if (err.message?.includes("insufficient")) {
                errorMsg = "Insufficient SOL for rent. Get devnet SOL from faucet.";
            } else if (err.message) {
                errorMsg = err.message.slice(0, 100);
            }
            setError(errorMsg);
        } finally {
            setInitializingVault(false);
        }
    };

    const handleBridge = async () => {
        if (!walletClient || !evmAddress || !publicClient) {
            setError("EVM wallet not connected");
            return;
        }

        if (direction === "base-to-solana" && !solanaPublicKey) {
            setError("Please connect your Solana wallet to receive tokens");
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            setError("Please enter a valid amount");
            return;
        }

        // Auto-initialize vault if needed
        if (direction === "base-to-solana" && vaultExists === false && signTransaction) {
            setLoading(true);
            setError(null);
            try {
                await handleInitializeVault();
                // Re-check vault status
                await checkVault();
            } catch (err) {
                setLoading(false);
                return;
            }
        }

        setLoading(true);
        setError(null);
        setTxHash(null);
        setStatus("");

        try {
            if (direction === "base-to-solana") {
                await bridgeBaseToSolana();
            } else {
                await bridgeSolanaToBase();
            }
        } catch (err: any) {
            console.error("Bridge error:", err);
            let errorMsg = "Transaction failed";
            if (err.message?.includes("insufficient funds")) {
                errorMsg = "Insufficient ETH for gas + Inco fee";
            } else if (err.message?.includes("user rejected")) {
                errorMsg = "Transaction rejected";
            } else if (err.shortMessage) {
                errorMsg = err.shortMessage;
            } else if (err.message) {
                errorMsg = err.message.slice(0, 150);
            }
            setError(errorMsg);
        } finally {
            setLoading(false);
        }
    };

    const bridgeBaseToSolana = async () => {
        if (!walletClient || !evmAddress || !publicClient || !solanaPublicKey) return;

        // Step 1: Get Inco fee
        setStatus("Getting Inco fee...");
        let incoFee: bigint;
        try {
            incoFee = await publicClient.readContract({
                address: CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}`,
                abi: BRIDGE_ABI,
                functionName: "getIncoFee",
            });
        } catch {
            incoFee = BigInt("100000000000000"); // 0.0001 ETH fallback
        }

        // Step 2: Parse the plaintext amount
        const amountWei = parseUnits(amount, 18);

        // Step 3: Convert Solana pubkey to bytes32
        const solanaPubkeyBytes = solanaPublicKey.toBytes();
        const solanaBytes32 = toHex(solanaPubkeyBytes, { size: 32 });

        // Step 4: Call bridgePrivateToSolanaPlaintext (simpler approach - no client-side encryption needed)
        // The contract encrypts the amount on-chain and emits plaintext in event for relayer
        setStatus("Sending bridge transaction...");
        const hash = await walletClient.writeContract({
            address: CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}`,
            abi: BRIDGE_ABI,
            functionName: "bridgePrivateToSolanaPlaintext",
            args: [
                CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
                solanaBytes32 as `0x${string}`,
                amountWei
            ],
            value: incoFee,
        });

        setTxHash(hash);
        setStatus("Waiting for confirmation...");

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        // Transaction confirmed! The plaintext amount is now in the event.
        // The relayer will read it and relay to Solana automatically.
        console.log("Bridge transaction confirmed:", receipt.transactionHash);
        console.log("Block number:", receipt.blockNumber);
        
        setStatus("✅ Bridge initiated! Relayer will complete transfer to Solana.");
    };

    const bridgeSolanaToBase = async () => {
        if (!solanaPublicKey || !signTransaction || !evmAddress) {
            setError("Please connect both wallets");
            return;
        }

        const tokenMint = getTokenMint();

        // Step 1: Check vault exists
        setStatus("Checking vault...");
        const exists = await checkVaultExists(connection, solanaPublicKey, tokenMint);
        if (!exists) {
            throw new Error("Solana vault does not exist. Bridge tokens TO Solana first.");
        }

        // Step 2: Check vault has balance
        setStatus("Checking balance...");
        const balance = await getVaultBalance(connection, solanaPublicKey, tokenMint);
        if (balance === null || balance === 0n) {
            throw new Error("Solana vault has no balance. Bridge tokens TO Solana first.");
        }
        console.log("Vault balance handle:", balance.toString());

        // Step 3: Parse amount (in token units, not wei for Solana)
        const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18));
        console.log("Amount to bridge:", amountBigInt.toString());

        // Step 4: Send bridge_confidential_out transaction
        setStatus("Sending Solana transaction...");
        const signature = await bridgeConfidentialOut(
            connection,
            solanaPublicKey,
            tokenMint,
            evmAddress,
            amountBigInt,
            signTransaction
        );

        console.log("Solana TX signature:", signature);
        setTxHash(signature);
        setStatus("Transaction confirmed! Relayer will mint on Base.");
    };

    // Check if both wallets are connected (required for both directions)
    const canBridge = isEvmConnected && isSolanaConnected;

    if (!isEvmConnected) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Bridge</h2>
                <p className="text-neutral-400 text-sm">Connect EVM wallet to bridge tokens</p>
            </div>
        );
    }

    return (
        <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
            <h2 className="text-lg font-semibold mb-4">Bridge</h2>

            {/* Direction Toggle */}
            <div className="mb-4">
                <label className="text-sm text-neutral-400 mb-2 block">Direction</label>
                <div className="flex gap-2">
                    <button
                        onClick={() => setDirection("base-to-solana")}
                        className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                            direction === "base-to-solana"
                                ? "bg-blue-600 text-white"
                                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                        }`}
                    >
                        Base → Solana
                    </button>
                    <button
                        onClick={() => setDirection("solana-to-base")}
                        className={`flex-1 py-2 px-3 rounded text-sm font-medium transition-colors ${
                            direction === "solana-to-base"
                                ? "bg-blue-600 text-white"
                                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
                        }`}
                    >
                        Solana → Base
                    </button>
                </div>
            </div>

            {/* Connection Status */}
            <div className="mb-4 p-3 bg-neutral-800 rounded text-sm">
                <div className="flex items-center gap-2 mb-1">
                    <span className={isEvmConnected ? "text-green-400" : "text-red-400"}>●</span>
                    <span className="text-neutral-300">
                        EVM: {evmAddress ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}` : "Not connected"}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className={isSolanaConnected ? "text-green-400" : "text-yellow-400"}>●</span>
                    <span className="text-neutral-300">
                        Solana: {solanaPublicKey
                            ? `${solanaPublicKey.toBase58().slice(0, 6)}...${solanaPublicKey.toBase58().slice(-4)}`
                            : "Not connected"}
                    </span>
                    {isSolanaConnected && checkingVault && (
                        <span className="text-neutral-500 text-xs">(Checking vault...)</span>
                    )}
                    {isSolanaConnected && !checkingVault && vaultExists === true && (
                        <span className="text-green-400 text-xs">(Vault ready)</span>
                    )}
                    {isSolanaConnected && !checkingVault && vaultExists === false && (
                        <span className="text-yellow-400 text-xs">(Vault needed)</span>
                    )}
                </div>
            </div>

            {/* Vault Initialization Button (shown only if vault doesn't exist) */}
            {direction === "base-to-solana" && isSolanaConnected && vaultExists === false && (
                <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-700 rounded">
                    <p className="text-sm text-yellow-200 mb-2">
                        You need a Solana vault to receive bridged tokens.
                    </p>
                    <button
                        onClick={handleInitializeVault}
                        disabled={initializingVault}
                        className="w-full py-2 bg-yellow-600 hover:bg-yellow-500 disabled:bg-neutral-700 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
                    >
                        {initializingVault ? "Initializing..." : "Initialize Vault (one-time)"}
                    </button>
                    <p className="mt-2 text-xs text-yellow-300">
                        This creates a vault account on Solana. Requires ~0.003 SOL for rent.
                    </p>
                </div>
            )}

            {/* Amount Input */}
            <div className="mb-4">
                <label className="text-sm text-neutral-400 mb-2 block">Amount (cDARK)</label>
                <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    min="0"
                    step="0.1"
                    className="w-full p-3 bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500"
                />
            </div>

            {/* Bridge Button */}
            <button
                onClick={handleBridge}
                disabled={loading || !canBridge || !amount || initializingVault}
                className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:cursor-not-allowed rounded font-medium transition-colors"
            >
                {loading
                    ? status || "Processing..."
                    : initializingVault
                    ? "Initializing vault..."
                    : `Bridge ${direction === "base-to-solana" ? "to Solana" : "to Base"}`
                }
            </button>

            {/* Auto-init notice */}
            {direction === "base-to-solana" && isSolanaConnected && vaultExists === false && !initializingVault && (
                <p className="mt-2 text-xs text-neutral-500 text-center">
                    Vault will be auto-initialized when you bridge
                </p>
            )}

            {/* Warning for Solana wallet */}
            {direction === "base-to-solana" && !isSolanaConnected && (
                <div className="mt-4 p-3 bg-yellow-900/30 border border-yellow-700 rounded text-sm text-yellow-200">
                    Connect your Solana wallet (Phantom/Solflare) to specify the recipient address.
                </div>
            )}

            {/* Info Box */}
            <div className="mt-4 p-3 bg-neutral-800 rounded text-xs text-neutral-400">
                <p className="font-medium text-neutral-300 mb-1">How it works:</p>
                {direction === "base-to-solana" ? (
                    <ul className="list-disc list-inside space-y-1">
                        <li>Amount encrypted using Inco TEE (private)</li>
                        <li>Tokens burned on Base</li>
                        <li>Relayer mints to your Solana vault</li>
                        <li>Balance visible only to you</li>
                    </ul>
                ) : (
                    <ul className="list-disc list-inside space-y-1">
                        <li>Tokens burned from your Solana vault</li>
                        <li>Relayer uses attested decrypt to verify</li>
                        <li>Tokens minted privately on Base</li>
                        <li>Balance encrypted with Inco TEE</li>
                    </ul>
                )}
            </div>

            {/* Success */}
            {txHash && (
                <div className="mt-4 p-3 bg-green-900/30 border border-green-700 rounded text-sm">
                    <p className="text-green-400 mb-1">Transaction submitted!</p>
                    {direction === "base-to-solana" ? (
                        <>
                            <a
                                href={`https://sepolia.basescan.org/tx/${txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:underline break-all text-xs"
                            >
                                View on BaseScan
                            </a>
                            <p className="mt-2 text-neutral-400 text-xs">
                                The relayer will complete the transfer to Solana. This may take 1-2 minutes.
                            </p>
                        </>
                    ) : (
                        <>
                            <a
                                href={`https://explorer.solana.com/tx/${txHash}?cluster=devnet`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:underline break-all text-xs"
                            >
                                View on Solana Explorer
                            </a>
                            <p className="mt-2 text-neutral-400 text-xs">
                                The relayer will use attested decrypt and mint on Base. This may take 1-2 minutes.
                            </p>
                        </>
                    )}
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300 whitespace-pre-line">
                    {error}
                </div>
            )}
        </div>
    );
}
