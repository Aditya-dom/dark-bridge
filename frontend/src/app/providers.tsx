"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/evm";
import { useState, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SOLANA_RPC_URL } from "@/lib/constants";

// Required CSS for wallet adapter modal
import "@solana/wallet-adapter-react-ui/styles.css";

export function Providers({ children }: { children: React.ReactNode }) {
    const [queryClient] = useState(() => new QueryClient());

    // Solana wallets - use empty array to rely on wallet-standard auto-detection
    // This avoids pulling in problematic WalletConnect dependencies
    const wallets = useMemo(() => [], []);

    return (
        <ConnectionProvider endpoint={SOLANA_RPC_URL}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <WagmiProvider config={wagmiConfig}>
                        <QueryClientProvider client={queryClient}>
                            {children}
                        </QueryClientProvider>
                    </WagmiProvider>
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}
