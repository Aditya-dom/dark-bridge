/**
 * Solana → Base Bridge Component
 * 
 * UI for bridging DARK tokens from Solana to Base with privacy.
 */

'use client';

import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useSolanaToBaseBridge, type BridgeStep } from '@/hooks/useSolanaToBaseBridge';

// DARK token mint on Solana
const DARK_TOKEN_MINT = new PublicKey('GXo4sG2pUdJXx8HGaGb1BashYpr9h8XFbNMsm57ffv6Z');

const STEP_DESCRIPTIONS: Record<BridgeStep, string> = {
    idle: 'Ready to bridge',
    burning: '🔥 Burning tokens on Solana...',
    decrypting: '🔐 Sign to decrypt amount (check your Solana wallet)',
    minting: '✨ Minting on Base...',
    complete: '✅ Bridge complete!',
    error: '❌ Error occurred',
};

export function SolanaToBaseBridge() {
    const [amount, setAmount] = useState('');
    const { state, bridge, reset, isConnected } = useSolanaToBaseBridge();
    
    const handleBridge = async () => {
        if (!amount) return;
        
        const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e18));
        await bridge(amountBigInt, DARK_TOKEN_MINT);
    };
    
    return (
        <div className="max-w-md mx-auto p-6 bg-gray-900 rounded-xl shadow-lg">
            <h2 className="text-2xl font-bold text-white mb-6">
                🌉 Solana → Base Bridge
            </h2>
            
            {/* Connection Status */}
            <div className="mb-4">
                <span className={`inline-block px-3 py-1 rounded-full text-sm ${
                    isConnected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                    {isConnected ? '✓ Wallets Connected' : '✗ Connect Both Wallets'}
                </span>
            </div>
            
            {/* Amount Input */}
            <div className="mb-6">
                <label className="block text-gray-400 text-sm mb-2">
                    Amount (DARK)
                </label>
                <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    disabled={state.step !== 'idle'}
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
                />
            </div>
            
            {/* Status Display */}
            <div className="mb-6 p-4 bg-gray-800 rounded-lg">
                <div className="text-gray-300 text-sm">
                    {STEP_DESCRIPTIONS[state.step]}
                </div>
                
                {state.step === 'decrypting' && (
                    <div className="mt-3 text-yellow-400 text-xs">
                        ⚠️ Your Solana wallet will ask you to sign a message.
                        This proves you own the encrypted tokens.
                    </div>
                )}
                
                {state.error && (
                    <div className="mt-2 text-red-400 text-sm">
                        {state.error}
                    </div>
                )}
                
                {state.plaintext !== undefined && (
                    <div className="mt-2 text-green-400 text-sm">
                        Decrypted amount: {state.plaintext.toString()} wei
                    </div>
                )}
            </div>
            
            {/* Transaction Links */}
            {(state.solanaTxHash || state.baseTxHash) && (
                <div className="mb-6 space-y-2">
                    {state.solanaTxHash && (
                        <a
                            href={`https://explorer.solana.com/tx/${state.solanaTxHash}?cluster=devnet`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-purple-400 text-sm hover:underline"
                        >
                            📋 Solana TX: {state.solanaTxHash.slice(0, 20)}...
                        </a>
                    )}
                    {state.baseTxHash && (
                        <a
                            href={`https://sepolia.basescan.org/tx/${state.baseTxHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-purple-400 text-sm hover:underline"
                        >
                            📋 Base TX: {state.baseTxHash.slice(0, 20)}...
                        </a>
                    )}
                </div>
            )}
            
            {/* Action Buttons */}
            <div className="flex gap-3">
                {state.step === 'idle' ? (
                    <button
                        onClick={handleBridge}
                        disabled={!isConnected || !amount}
                        className="flex-1 px-6 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition"
                    >
                        🚀 Bridge to Base
                    </button>
                ) : state.step === 'complete' || state.step === 'error' ? (
                    <button
                        onClick={reset}
                        className="flex-1 px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg transition"
                    >
                        ↻ Start Over
                    </button>
                ) : (
                    <button
                        disabled
                        className="flex-1 px-6 py-3 bg-gray-700 text-gray-400 font-semibold rounded-lg cursor-wait"
                    >
                        <span className="animate-pulse">Processing...</span>
                    </button>
                )}
            </div>
            
            {/* How It Works */}
            <div className="mt-8 p-4 bg-gray-800/50 rounded-lg">
                <h3 className="text-white font-semibold mb-3">🔒 How Privacy Works</h3>
                <ol className="text-gray-400 text-sm space-y-2">
                    <li>1. Your tokens are burned on Solana (encrypted amount)</li>
                    <li>2. You sign a message to decrypt the amount privately</li>
                    <li>3. Tokens are minted on Base (re-encrypted)</li>
                    <li className="text-purple-400">
                        ✨ Amount is never visible on-chain!
                    </li>
                </ol>
            </div>
        </div>
    );
}
