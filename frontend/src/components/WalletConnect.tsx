'use client';

import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

export function WalletConnect() {
    // EVM Wallet (Base)
    const { address: evmAddress, isConnected: isEvmConnected } = useAccount();
    const { connect, connectors } = useConnect();
    const { disconnect: evmDisconnect } = useDisconnect();

    // Solana Wallet
    const { publicKey, connected: isSolanaConnected, disconnect: solanaDisconnect } = useWallet();

    const shortenAddress = (address: string) => {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    };

    return (
        <div className="space-y-3">
            {/* EVM Wallet */}
            <div className="flex items-center justify-between p-4 bg-dark-800/50 rounded-xl">
                <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                        <span>🔵</span>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-white">Base Wallet</p>
                        {isEvmConnected && evmAddress && (
                            <p className="text-xs text-dark-400">{shortenAddress(evmAddress)}</p>
                        )}
                    </div>
                </div>
                {isEvmConnected ? (
                    <button
                        onClick={() => evmDisconnect()}
                        className="text-sm text-red-400 hover:text-red-300 transition-colors"
                    >
                        Disconnect
                    </button>
                ) : (
                    <button
                        onClick={() => connect({ connector: connectors[0] })}
                        className="text-sm text-primary-400 hover:text-primary-300 transition-colors"
                    >
                        Connect
                    </button>
                )}
            </div>

            {/* Solana Wallet */}
            <div className="flex items-center justify-between p-4 bg-dark-800/50 rounded-xl">
                <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                        <span>☀️</span>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-white">Solana Wallet</p>
                        {isSolanaConnected && publicKey && (
                            <p className="text-xs text-dark-400">{shortenAddress(publicKey.toBase58())}</p>
                        )}
                    </div>
                </div>
                <div className="[&>button]:!bg-transparent [&>button]:!text-primary-400 [&>button]:hover:!text-primary-300 [&>button]:!text-sm [&>button]:!h-auto [&>button]:!p-0">
                    <WalletMultiButton />
                </div>
            </div>
        </div>
    );
}
