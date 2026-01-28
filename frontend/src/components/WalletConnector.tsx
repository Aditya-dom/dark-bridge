"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import dynamic from "next/dynamic";
import { useContext } from "react";
import { WalletContext } from "@solana/wallet-adapter-react";

// Dynamically import Solana wallet button to avoid SSR issues
const SolanaWalletButton = dynamic(
    async () => {
        const { WalletMultiButton } = await import("@solana/wallet-adapter-react-ui");
        return () => <WalletMultiButton className="!bg-purple-600 !hover:bg-purple-500 !text-xs !py-1.5 !px-3 !h-auto !rounded" />;
    },
    { ssr: false }
);

export function WalletConnector() {
    const walletContext = useContext(WalletContext);
    
    return (
        <div className="flex flex-col gap-3">
            {/* EVM Wallet - RainbowKit */}
            <div className="evm-wallet-container">
                <ConnectButton
                    accountStatus="address"
                    chainStatus="icon"
                    showBalance={false}
                />
            </div>

            {/* Solana Wallet */}
            <div className="solana-wallet-container">
                {walletContext ? <SolanaWalletButton /> : null}
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