import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/Providers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
    title: 'Dark Bridge | Privacy-First Cross-Chain Bridge',
    description: 'Bridge tokens between Base and Solana with optional privacy using Inco Lightning FHE',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className="dark">
            <body className={inter.className}>
                <Providers>
                    <div className="min-h-screen">
                        {/* Header */}
                        <header className="fixed top-0 left-0 right-0 z-50 glass">
                            <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-primary-500 to-accent-pink flex items-center justify-center">
                                        <span className="text-xl">🌉</span>
                                    </div>
                                    <div>
                                        <h1 className="text-xl font-bold text-white">Dark Bridge</h1>
                                        <p className="text-xs text-dark-400">Base ⇄ Solana</p>
                                    </div>
                                </div>
                                <div id="wallet-connect" />
                            </div>
                        </header>

                        {/* Main Content */}
                        <main className="pt-24 pb-8">
                            {children}
                        </main>

                        {/* Footer */}
                        <footer className="fixed bottom-0 left-0 right-0 py-4 text-center text-dark-500 text-sm">
                            <p>Powered by Inco Lightning FHE • Base • Solana</p>
                        </footer>
                    </div>
                </Providers>
            </body>
        </html>
    );
}
