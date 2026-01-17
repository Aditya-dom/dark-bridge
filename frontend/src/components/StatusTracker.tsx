'use client';

import { useState } from 'react';

interface BridgeStatus {
    id: string;
    direction: 'base-to-solana' | 'solana-to-base';
    amount: string;
    status: 'pending' | 'proving' | 'relaying' | 'success' | 'failed';
    timestamp: number;
    txHash?: string;
}

// Mock data - in production this would come from an API or local storage
const mockStatuses: BridgeStatus[] = [
    {
        id: '1',
        direction: 'base-to-solana',
        amount: '0.1 ETH',
        status: 'success',
        timestamp: Date.now() - 3600000,
        txHash: '0xabc...',
    },
    {
        id: '2',
        direction: 'solana-to-base',
        amount: '50 SOL',
        status: 'pending',
        timestamp: Date.now() - 300000,
    },
];

const statusConfig = {
    pending: { label: 'Pending', color: 'text-yellow-400', dot: 'pending' },
    proving: { label: 'Proving', color: 'text-blue-400', dot: 'pending' },
    relaying: { label: 'Relaying', color: 'text-purple-400', dot: 'pending' },
    success: { label: 'Complete', color: 'text-green-400', dot: 'success' },
    failed: { label: 'Failed', color: 'text-red-400', dot: 'failed' },
};

export function StatusTracker() {
    const [statuses] = useState<BridgeStatus[]>(mockStatuses);

    if (statuses.length === 0) {
        return (
            <div className="text-center py-8">
                <p className="text-dark-400">No bridge transactions yet</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <h3 className="text-lg font-semibold text-white">Recent Transactions</h3>

            <div className="space-y-3">
                {statuses.map((status) => (
                    <div
                        key={status.id}
                        className="flex items-center justify-between p-4 bg-dark-800/50 rounded-xl"
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex flex-col items-center">
                                <span>{status.direction === 'base-to-solana' ? '🔵' : '☀️'}</span>
                                <span className="text-dark-500">↓</span>
                                <span>{status.direction === 'base-to-solana' ? '☀️' : '🔵'}</span>
                            </div>
                            <div>
                                <p className="text-sm font-medium text-white">{status.amount}</p>
                                <p className="text-xs text-dark-400">
                                    {new Date(status.timestamp).toLocaleTimeString()}
                                </p>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            <span className={`status-dot ${statusConfig[status.status].dot}`} />
                            <span className={`text-sm ${statusConfig[status.status].color}`}>
                                {statusConfig[status.status].label}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
