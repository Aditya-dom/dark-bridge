'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import {
    ConnectionProvider,
    WalletProvider as SolanaWalletProvider
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import { useMemo, useState } from 'react';

// Import Solana wallet UI styles
import '@solana/wallet-adapter-react-ui/styles.css';

// Wagmi config for Base
const wagmiConfig = createConfig({
    chains: [baseSepolia],
    transports: {
        [baseSepolia.id]: http('https://sepolia.base.org'),
    },
});

// Query client for react-query
const queryClient = new QueryClient();

// Solana RPC endpoint
const SOLANA_RPC = 'https://api.devnet.solana.com';

export function Providers({ children }: { children: React.ReactNode }) {
    // Solana wallet adapters
    const wallets = useMemo(() => [
        new PhantomWalletAdapter(),
    ], []);

    return (
        <WagmiProvider config={wagmiConfig}>
            <QueryClientProvider client={queryClient}>
                <ConnectionProvider endpoint={SOLANA_RPC}>
                    <SolanaWalletProvider wallets={wallets} autoConnect>
                        <WalletModalProvider>
                            {children}
                        </WalletModalProvider>
                    </SolanaWalletProvider>
                </ConnectionProvider>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
