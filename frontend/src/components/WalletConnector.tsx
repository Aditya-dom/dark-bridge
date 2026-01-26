"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function WalletConnector() {
    const { address, isConnected } = useAccount();
    const { connect, connectors } = useConnect();
    const { disconnect } = useDisconnect();
    const { publicKey: solanaPublicKey, connected: isSolanaConnected } = useWallet();

    return (
        <div className="flex flex-col gap-2">
            {/* EVM Wallet */}
            <div className="flex items-center gap-2">
                {isConnected && address ? (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-neutral-400">
                            EVM: {address.slice(0, 6)}...{address.slice(-4)}
                        </span>
                        <button
                            onClick={() => disconnect()}
                            className="px-2 py-1 text-xs bg-neutral-800 hover:bg-neutral-700 rounded transition-colors"
                        >
                            ×
                        </button>
                    </div>
                ) : (
                    <div className="flex gap-1">
                        {connectors.slice(0, 1).map((connector) => (
                            <button
                                key={connector.uid}
                                onClick={() => connect({ connector })}
                                className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded font-medium transition-colors"
                            >
                                Connect EVM
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Solana Wallet */}
            <div className="solana-wallet-container">
                <WalletMultiButton className="!bg-purple-600 !hover:bg-purple-500 !text-xs !py-1.5 !px-3 !h-auto !rounded" />
            </div>

            <style jsx global>{`
                .solana-wallet-container .wallet-adapter-button {
                    background-color: rgb(124, 58, 237) !important;
                    font-size: 0.75rem !important;
                    padding: 0.375rem 0.75rem !important;
                    height: auto !important;
                    border-radius: 0.25rem !important;
                }
                .solana-wallet-container .wallet-adapter-button:hover {
                    background-color: rgb(139, 92, 246) !important;
                }
            `}</style>
        </div>
    );
}
