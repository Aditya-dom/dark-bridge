"use client";

import { useState } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import { parseAbi } from "viem";
import { CONFIDENTIAL_TOKEN_ADDRESS } from "@/lib/constants";

const TOKEN_ABI = parseAbi([
    "function confidentialMintForDemo(address to, uint256 plainAmount) external payable",
    "function name() external view returns (string)",
    "function symbol() external view returns (string)",
]);

export function Faucet() {
    const { address, isConnected } = useAccount();
    const { data: walletClient } = useWalletClient();
    const publicClient = usePublicClient();
    const [loading, setLoading] = useState(false);
    const [txHash, setTxHash] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleMint = async () => {
        if (!walletClient || !address || !publicClient) return;

        setLoading(true);
        setError(null);
        setTxHash(null);

        try {
            const hash = await walletClient.writeContract({
                address: CONFIDENTIAL_TOKEN_ADDRESS,
                abi: TOKEN_ABI,
                functionName: "confidentialMintForDemo",
                args: [address, BigInt(100 * 10 ** 18)],
                value: BigInt(0),
            });

            setTxHash(hash);

            await publicClient.waitForTransactionReceipt({ hash });
        } catch (err) {
            setError(err instanceof Error ? err.message : "Transaction failed");
        } finally {
            setLoading(false);
        }
    };

    if (!isConnected) {
        return (
            <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
                <h2 className="text-lg font-semibold mb-2">Faucet</h2>
                <p className="text-neutral-400">Connect wallet to get test tokens</p>
            </div>
        );
    }

    return (
        <div className="p-6 bg-neutral-900 rounded-lg border border-neutral-800">
            <h2 className="text-lg font-semibold mb-4">Faucet</h2>
            <p className="text-sm text-neutral-400 mb-4">
                Get 100 PRIV tokens for testing
            </p>

            <button
                onClick={handleMint}
                disabled={loading}
                className="w-full py-2 bg-green-600 hover:bg-green-500 disabled:bg-neutral-700 disabled:cursor-not-allowed rounded font-medium transition-colors"
            >
                {loading ? "Minting..." : "Get Tokens"}
            </button>

            {txHash && (
                <div className="mt-4 p-3 bg-neutral-800 rounded text-sm">
                    <p className="text-green-400 mb-1">Transaction submitted</p>
                    <a
                        href={`https://sepolia.basescan.org/tx/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline break-all"
                    >
                        {txHash.slice(0, 20)}...
                    </a>
                </div>
            )}

            {error && (
                <div className="mt-4 p-3 bg-red-900/50 rounded text-sm text-red-300">
                    {error}
                </div>
            )}
        </div>
    );
}
