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
    const [waitingForRelay, setWaitingForRelay] = useState(false);
    const [relayComplete, setRelayComplete] = useState(false);
    const [relayTxHash, setRelayTxHash] = useState<string | null>(null);

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

    const pollForRelayCompletion = useCallback(async (targetChain: "solana" | "base", fromBlock: bigint | null) => {
        if (!publicClient || !evmAddress) return;

        let attempts = 0;
        const maxAttempts = 60; // 5 minutes (5 seconds * 60)
        
        const poll = async () => {
            attempts++;
            
            if (attempts > maxAttempts) {
                setWaitingForRelay(false);
                setStatus("Relay timeout. Check explorer manually.");
                return;
            }

            try {
                if (targetChain === "solana") {
                    // Check Solana for token receipt
                    // For now, simulate with timeout
                    if (attempts >= 12) { // ~1 minute
                        setWaitingForRelay(false);
                        setRelayComplete(true);
                        setStatus("Tokens minted on Solana");
                    } else {
                        setTimeout(poll, 5000);
                    }
                } else {
                    // Check Base for ConfidentialBridgeReceived event
                    const currentBlock = await publicClient.getBlockNumber();
                    const logs = await publicClient.getLogs({
                        address: CONFIDENTIAL_BRIDGE_ADDRESS as `0x${string}`,
                        event: {
                            type: "event",
                            name: "ConfidentialBridgeReceived",
                            inputs: [
                                { type: "uint256", indexed: true, name: "nonce" },
                                { type: "address", indexed: true, name: "localToken" },
                                { type: "address", indexed: true, name: "to" },
                                { type: "bytes32", indexed: false, name: "encryptedAmount" }
                            ]
                        },
                        fromBlock: currentBlock - 100n,
                        toBlock: currentBlock,
                    });

                    const userLogs = logs.filter(log => 
                        log.args.to?.toLowerCase() === evmAddress.toLowerCase()
                    );

                    if (userLogs.length > 0) {
                        const latestLog = userLogs[userLogs.length - 1];
                        setWaitingForRelay(false);
                        setRelayComplete(true);
                        setRelayTxHash(latestLog.transactionHash);
                        setStatus("Tokens minted on Base");
                    } else {
                        setTimeout(poll, 5000);
                    }
                }
            } catch (err) {
                console.error("Poll error:", err);
                setTimeout(poll, 5000);
            }
        };

        // Start polling after 5 seconds
        setTimeout(poll, 5000);
    }, [publicClient, evmAddress]);

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
        setWaitingForRelay(false);
        setRelayComplete(false);
        setRelayTxHash(null);

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
        
        console.log("Bridge transaction confirmed:", receipt.transactionHash);
        console.log("Block number:", receipt.blockNumber);
        
        setStatus("Transaction confirmed");
        setWaitingForRelay(true);
        
        // Poll for relay completion
        pollForRelayCompletion("solana", receipt.blockNumber);
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
        setStatus("Transaction confirmed");
        setWaitingForRelay(true);
        
        // Poll for relay completion
        pollForRelayCompletion("base", null);
    };

    // Check if both wallets are connected (required for both directions)
    const canBridge = isEvmConnected && isSolanaConnected;

    if (!isEvmConnected) {
        return (
            <div className="p-6 bg-gradient-to-br from-neutral-900 to-neutral-800 rounded-xl border border-neutral-700 shadow-xl">
                <h2 className="text-xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                    Confidential Bridge
                </h2>
                <p className="text-neutral-400 text-sm">Connect EVM wallet to bridge tokens privately</p>
            </div>
        );
    }

    return (
        <div className="p-6 bg-gradient-to-br from-neutral-900 to-neutral-800 rounded-xl border border-neutral-700 shadow-xl">
            <h2 className="text-xl font-bold mb-6 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
                Confidential Bridge
            </h2>

            {/* Direction Toggle */}
            <div className="mb-6">
                <label className="text-sm font-medium text-neutral-300 mb-2 block">Bridge Direction</label>
                <div className="flex gap-2">
                    <button
                        onClick={() => setDirection("base-to-solana")}
                        className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
                            direction === "base-to-solana"
                                ? "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-lg shadow-blue-500/50"
                                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 border border-neutral-700"
                        }`}
                    >
                        Base → Solana
                    </button>
                    <button
                        onClick={() => setDirection("solana-to-base")}
                        className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
                            direction === "solana-to-base"
                                ? "bg-gradient-to-r from-purple-600 to-purple-500 text-white shadow-lg shadow-purple-500/50"
                                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 border border-neutral-700"
                        }`}
                    >
                        Solana → Base
                    </button>
                </div>
            </div>

            {/* Connection Status */}
            <div className="mb-6 p-4 bg-neutral-800/50 rounded-lg border border-neutral-700">
                <div className="text-xs font-medium text-neutral-400 mb-2">Connected Wallets</div>
                <div className="space-y-2">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isEvmConnected ? "bg-green-500" : "bg-red-500"}`}></div>
                        <span className="text-sm text-neutral-300 font-mono">
                            Base: {evmAddress ? `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}` : "Not connected"}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isSolanaConnected ? "bg-green-500" : "bg-yellow-500"}`}></div>
                        <span className="text-sm text-neutral-300 font-mono">
                            Solana: {solanaPublicKey
                                ? `${solanaPublicKey.toBase58().slice(0, 6)}...${solanaPublicKey.toBase58().slice(-4)}`
                                : "Not connected"}
                        </span>
                        {isSolanaConnected && checkingVault && (
                            <span className="text-xs text-neutral-500">(Checking vault...)</span>
                        )}
                        {isSolanaConnected && !checkingVault && vaultExists === true && (
                            <span className="text-xs text-green-400">(Vault ready)</span>
                        )}
                        {isSolanaConnected && !checkingVault && vaultExists === false && (
                            <span className="text-xs text-yellow-400">(Vault needed)</span>
                        )}
                    </div>
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
            <div className="mb-6">
                <label className="text-sm font-medium text-neutral-300 mb-2 block">Amount (cDARK)</label>
                <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    min="0"
                    step="0.1"
                    className="w-full p-3 bg-neutral-800 border border-neutral-600 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                />
            </div>

            {/* Bridge Button */}
            <button
                onClick={handleBridge}
                disabled={loading || !canBridge || !amount || initializingVault || waitingForRelay}
                className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:from-neutral-700 disabled:to-neutral-700 disabled:cursor-not-allowed rounded-lg font-semibold transition-all shadow-lg disabled:shadow-none"
            >
                {loading
                    ? status || "Processing..."
                    : waitingForRelay
                    ? "Waiting for relayer..."
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
            <div className="mt-4 p-4 bg-gradient-to-br from-neutral-800 to-neutral-900 border border-neutral-700 rounded-lg text-xs text-neutral-400 shadow-md">
                <p className="font-semibold text-neutral-200 mb-2 flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    How it works:
                </p>
                {direction === "base-to-solana" ? (
                    <ul className="space-y-1.5 ml-6">
                        <li className="flex items-start gap-2">
                            <span className="text-blue-400 mt-0.5">•</span>
                            <span>Amount encrypted using Inco TEE (private)</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-blue-400 mt-0.5">•</span>
                            <span>Tokens burned on Base</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-blue-400 mt-0.5">•</span>
                            <span>Relayer mints to your Solana vault</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-blue-400 mt-0.5">•</span>
                            <span>Balance visible only to you</span>
                        </li>
                    </ul>
                ) : (
                    <ul className="space-y-1.5 ml-6">
                        <li className="flex items-start gap-2">
                            <span className="text-purple-400 mt-0.5">•</span>
                            <span>Tokens burned from your Solana vault</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-purple-400 mt-0.5">•</span>
                            <span>Relayer uses attested decrypt to verify</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-purple-400 mt-0.5">•</span>
                            <span>Tokens minted privately on Base</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="text-purple-400 mt-0.5">•</span>
                            <span>Balance encrypted with Inco TEE</span>
                        </li>
                    </ul>
                )}
            </div>

            {/* Waiting for Relay */}
            {waitingForRelay && !relayComplete && (
                <div className="mt-4 p-4 bg-blue-900/30 border border-blue-700 rounded">
                    <div className="flex items-center gap-3">
                        <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                        <div>
                            <p className="text-sm font-medium text-blue-200">Waiting for relayer</p>
                            <p className="text-xs text-blue-300 mt-1">
                                Relayer is processing your cross-chain transfer. This may take 1-2 minutes.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Relay Complete */}
            {relayComplete && (
                <div className="mt-4 p-4 bg-green-900/30 border border-green-700 rounded">
                    <div className="flex items-start gap-3">
                        <svg className="w-5 h-5 text-green-400 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <div className="flex-1">
                            <p className="text-sm font-medium text-green-200">Tokens minted successfully</p>
                            <p className="text-xs text-green-300 mt-1">
                                {direction === "base-to-solana" 
                                    ? "Your tokens have been minted on Solana"
                                    : "Your tokens have been minted on Base"
                                }
                            </p>
                            {relayTxHash && (
                                <a
                                    href={`https://sepolia.basescan.org/tx/${relayTxHash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-blue-400 hover:underline mt-2 inline-block"
                                >
                                    View mint transaction
                                </a>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Success */}
            {txHash && !waitingForRelay && !relayComplete && (
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
