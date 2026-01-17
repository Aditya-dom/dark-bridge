'use client';

import { useState } from 'react';
import { ChainSelector } from './ChainSelector';
import { TokenInput } from './TokenInput';
import { PrivacyToggle } from './PrivacyToggle';
import { WalletConnect } from './WalletConnect';

type Chain = 'base' | 'solana';

export function BridgeForm() {
    const [fromChain, setFromChain] = useState<Chain>('base');
    const [toChain, setToChain] = useState<Chain>('solana');
    const [amount, setAmount] = useState('');
    const [isPrivate, setIsPrivate] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const handleSwapChains = () => {
        setFromChain(toChain);
        setToChain(fromChain);
    };

    const handleBridge = async () => {
        setIsLoading(true);
        try {
            // Bridge logic will go here
            console.log('Bridging...', { fromChain, toChain, amount, isPrivate });
            await new Promise(r => setTimeout(r, 2000)); // Simulate
        } catch (error) {
            console.error('Bridge failed:', error);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* From Chain */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-dark-300">From</label>
                <div className="flex gap-4">
                    <ChainSelector
                        selected={fromChain}
                        onChange={setFromChain}
                        disabled={isLoading}
                    />
                    <TokenInput
                        value={amount}
                        onChange={setAmount}
                        placeholder="0.0"
                        disabled={isLoading}
                    />
                </div>
            </div>

            {/* Swap Button */}
            <div className="flex justify-center">
                <button
                    onClick={handleSwapChains}
                    disabled={isLoading}
                    className="p-3 rounded-xl bg-dark-700 hover:bg-dark-600 transition-colors disabled:opacity-50"
                >
                    <svg className="w-5 h-5 text-dark-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                </button>
            </div>

            {/* To Chain */}
            <div className="space-y-2">
                <label className="text-sm font-medium text-dark-300">To</label>
                <div className="flex gap-4">
                    <ChainSelector
                        selected={toChain}
                        onChange={setToChain}
                        disabled={isLoading}
                    />
                    <div className="flex-1 bg-dark-800 rounded-xl px-4 py-3 text-dark-400">
                        {amount || '0.0'}
                    </div>
                </div>
            </div>

            {/* Privacy Toggle */}
            <div className="flex items-center justify-between py-4 px-4 bg-dark-800/50 rounded-xl">
                <div className="flex items-center gap-3">
                    <span className="text-lg">🔒</span>
                    <div>
                        <p className="text-sm font-medium text-white">Private Transfer</p>
                        <p className="text-xs text-dark-400">Encrypt amount with Inco FHE</p>
                    </div>
                </div>
                <PrivacyToggle enabled={isPrivate} onToggle={setIsPrivate} />
            </div>

            {/* Wallet Connect */}
            <WalletConnect />

            {/* Bridge Button */}
            <button
                onClick={handleBridge}
                disabled={isLoading || !amount}
                className="w-full btn-glow"
            >
                {isLoading ? (
                    <span className="flex items-center justify-center gap-2">
                        <span className="spinner" />
                        Bridging...
                    </span>
                ) : (
                    `Bridge ${amount || '0'} ${isPrivate ? '(Private)' : ''}`
                )}
            </button>

            {/* Info */}
            {isPrivate && (
                <div className="flex items-start gap-2 p-4 bg-primary-500/10 rounded-xl border border-primary-500/20">
                    <span className="text-primary-400">ℹ️</span>
                    <p className="text-sm text-primary-300">
                        Private transfers use Inco Lightning FHE to encrypt your transfer amount.
                        Only you and the recipient can see the actual value.
                    </p>
                </div>
            )}
        </div>
    );
}
