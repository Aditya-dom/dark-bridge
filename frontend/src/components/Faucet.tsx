"use client";

import { useState, useEffect } from "react";
import { useAccount, usePublicClient, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseAbi } from "viem";
import { baseSepolia } from "wagmi/chains";
import { CONFIDENTIAL_TOKEN_ADDRESS } from "@/lib/constants";

const TOKEN_ABI = parseAbi([
    "function confidentialMintForDemo(address to, uint256 plainAmount) external payable",
]);

export function Faucet() {
    const { address, isConnected, isConnecting } = useAccount();
    const chainId = useChainId();
    const { switchChain } = useSwitchChain();
    const publicClient = usePublicClient();

    // Use wagmi's useWriteContract hook instead of walletClient
    const { writeContract, data: hash, isPending, error: writeError, reset } = useWriteContract();
    const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

    const [error, setError] = useState<string | null>(null);
    const [mounted, setMounted] = useState(false);

    // Handle hydration
    useEffect(() => {
        setMounted(true);
    }, []);

    // Handle write errors
    useEffect(() => {
        if (writeError) {
            console.error("Faucet writeError:", writeError);
            console.error("Full message:", writeError.message);
            console.error("Cause:", (writeError as any).cause);

            let errorMsg = "Transaction failed";
            if (writeError.message?.includes("user rejected") || writeError.message?.includes("User rejected")) {
                errorMsg = "Transaction rejected by user";
            } else if ((writeError as any).shortMessage) {
                errorMsg = (writeError as any).shortMessage;
            } else if (writeError.message) {
                // Show more of the error for debugging
                errorMsg = writeError.message.slice(0, 300);
            }
            setError(errorMsg);
        }
    }, [writeError]);

    // Check if on correct chain
    const isWrongChain = isConnected && chainId !== baseSepolia.id;

    // Can mint when connected and on correct chain
    const canMint = mounted &&
                    isConnected &&
                    !!address &&
                    !isPending &&
                    !isConfirming &&
                    !isWrongChain;

    const handleSwitchChain = async () => {
        try {
            await switchChain({ chainId: baseSepolia.id });
        } catch (err) {
            console.error("Failed to switch chain:", err);
            setError("Failed to switch chain. Please switch manually in your wallet.");
        }
    };

    const handleMint = () => {
        if (!address) {
            setError("Wallet not ready. Please try again.");
            return;
        }

        setError(null);
        reset(); // Reset any previous errors

        // Inco fee for encryption (0.001 ETH should cover it)
        const incoFee = BigInt("1000000000000000"); // 0.001 ETH

        // Mint 100 tokens (with 18 decimals)
        const mintAmount = BigInt(100) * BigInt(10 ** 18);

        console.log("Minting to:", address);
        console.log("Token contract:", CONFIDENTIAL_TOKEN_ADDRESS);
        console.log("Amount:", mintAmount.toString());

        writeContract({
            address: CONFIDENTIAL_TOKEN_ADDRESS as `0x${string}`,
            abi: TOKEN_ABI,
            functionName: "confidentialMintForDemo",
            args: [address, mintAmount],
            value: incoFee,
            chainId: baseSepolia.id, // Force Base Sepolia
        });
    };

    // SSR fallback
    if (!mounted) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Faucet</h2>
                <p className="text-neutral-400 text-sm">Loading...</p>
            </div>
        );
    }

    // Not connected state
    if (!isConnected) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Faucet</h2>
                <p className="text-neutral-400 text-sm">Connect EVM wallet to get test tokens</p>
            </div>
        );
    }

    // Wrong chain state
    if (isWrongChain) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-4">Faucet</h2>
                <p className="text-sm text-yellow-400 mb-4">
                    Please switch to Base Sepolia network
                </p>
                <button
                    onClick={handleSwitchChain}
                    className="w-full py-2.5 bg-yellow-600 hover:bg-yellow-500 rounded font-medium transition-colors"
                >
                    Switch to Base Sepolia
                </button>
            </div>
        );
    }

    return (
        <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
            <h2 className="text-lg font-semibold mb-4">Faucet</h2>
            <p className="text-sm text-neutral-400 mb-4">
                Get 100 cDARK tokens for testing the privacy bridge
            </p>

            <button
                onClick={handleMint}
                disabled={!canMint}
                className="w-full py-2.5 bg-green-600 hover:bg-green-500 disabled:bg-neutral-700 disabled:cursor-not-allowed rounded font-medium transition-colors"
            >
                {isConnecting
                    ? "Connecting..."
                    : isPending
                    ? "Confirm in wallet..."
                    : isConfirming
                    ? "Minting..."
                    : "Get 100 cDARK"
                }
            </button>

            <p className="mt-3 text-xs text-neutral-500">
                Requires ~0.001 ETH for gas + Inco fee
            </p>

            {isSuccess && hash && (
                <div className="mt-4 p-3 bg-green-900/30 border border-green-800 rounded text-sm">
                    <p className="text-green-400 mb-1">Tokens minted!</p>
                    <a
                        href={`https://sepolia.basescan.org/tx/${hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline break-all text-xs"
                    >
                        View on BaseScan
                    </a>
                </div>
            )}

            {error && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-300">
                    {error}
                </div>
            )}
        </div>
    );
}
