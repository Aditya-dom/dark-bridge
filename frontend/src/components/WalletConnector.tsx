"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function WalletConnector() {
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
