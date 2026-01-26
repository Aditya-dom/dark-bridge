"use client";

import { WalletConnector } from "@/components/WalletConnector";
import { Faucet } from "@/components/Faucet";
import { BridgeForm } from "@/components/BridgeForm";
import { VaultBalance } from "@/components/VaultBalance";

export default function Home() {
    return (
        <main className="min-h-screen p-4 md:p-8">
            <div className="max-w-md mx-auto">
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                    <h1 className="text-xl font-bold">Privacy Bridge</h1>
                    <WalletConnector />
                </div>

                {/* Info */}
                <div className="mb-6 p-4 bg-neutral-900/50 rounded-lg border border-neutral-800 text-sm text-neutral-400">
                    <p>Cross-chain privacy bridge powered by Inco TEE</p>
                    <p className="mt-1">Base Sepolia ↔ Solana Devnet</p>
                </div>

                {/* Faucet */}
                <div className="mb-4">
                    <Faucet />
                </div>

                {/* Solana Vault Balance */}
                <div className="mb-4">
                    <VaultBalance />
                </div>

                {/* Bridge */}
                <div>
                    <BridgeForm />
                </div>

                {/* Footer */}
                <div className="mt-8 text-center text-xs text-neutral-600">
                    <p>ConfidentialBridge: 0x4CDE2...99e08</p>
                    <p>cDARK Token: 0x2e631...8c4d0b</p>
                </div>
            </div>
        </main>
    );
}
