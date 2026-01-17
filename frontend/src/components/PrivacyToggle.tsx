'use client';

interface PrivacyToggleProps {
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
}

export function PrivacyToggle({ enabled, onToggle }: PrivacyToggleProps) {
    return (
        <button
            role="switch"
            aria-checked={enabled}
            onClick={() => onToggle(!enabled)}
            className={`privacy-toggle ${enabled ? 'enabled' : 'disabled'}`}
        >
            <span
                className={`block h-5 w-5 rounded-full bg-white shadow-lg transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
            />
        </button>
    );
}
