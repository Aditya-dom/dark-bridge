"use client";

import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export default function SolanaWalletButton() {
    return (
        <WalletMultiButton style={{
            backgroundColor: '#7c3aed',
            height: 'auto',
            padding: '8px 16px',
            fontSize: '14px',
            borderRadius: '6px'
        }} />
    );
}
