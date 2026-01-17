'use client';

type Chain = 'base' | 'solana';

interface ChainSelectorProps {
    selected: Chain;
    onChange: (chain: Chain) => void;
    disabled?: boolean;
}

const chains = {
    base: {
        name: 'Base',
        icon: '🔵',
        color: 'from-blue-500 to-blue-600',
    },
    solana: {
        name: 'Solana',
        icon: '☀️',
        color: 'from-purple-500 to-green-400',
    },
};

export function ChainSelector({ selected, onChange, disabled }: ChainSelectorProps) {
    const chain = chains[selected];

    return (
        <div className="relative">
            <select
                value={selected}
                onChange={(e) => onChange(e.target.value as Chain)}
                disabled={disabled}
                className="appearance-none bg-dark-800 border border-dark-600 rounded-xl px-4 py-3 pr-10 text-white font-medium cursor-pointer hover:border-dark-500 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <option value="base">🔵 Base</option>
                <option value="solana">☀️ Solana</option>
            </select>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg className="w-4 h-4 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </div>
        </div>
    );
}
