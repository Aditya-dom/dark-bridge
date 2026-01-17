import { BridgeForm } from '@/components/BridgeForm';
import { StatusTracker } from '@/components/StatusTracker';

export default function Home() {
    return (
        <div className="max-w-2xl mx-auto px-4">
            {/* Hero */}
            <div className="text-center mb-12">
                <h2 className="text-4xl font-bold bg-gradient-to-r from-primary-400 via-accent-purple to-accent-pink bg-clip-text text-transparent mb-4">
                    Private Cross-Chain Bridge
                </h2>
                <p className="text-dark-400 text-lg">
                    Bridge tokens between Base and Solana with optional FHE encryption
                </p>
            </div>

            {/* Bridge Card */}
            <div className="glass rounded-2xl p-6 card-hover mb-8">
                <BridgeForm />
            </div>

            {/* Status Tracker */}
            <div className="glass rounded-2xl p-6">
                <StatusTracker />
            </div>
        </div>
    );
}
