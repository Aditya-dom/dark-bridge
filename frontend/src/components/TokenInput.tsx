'use client';

interface TokenInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
}

export function TokenInput({ value, onChange, placeholder = '0.0', disabled }: TokenInputProps) {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        // Allow only numbers and decimals
        if (val === '' || /^\d*\.?\d*$/.test(val)) {
            onChange(val);
        }
    };

    return (
        <div className="flex-1 relative">
            <input
                type="text"
                value={value}
                onChange={handleChange}
                placeholder={placeholder}
                disabled={disabled}
                className="input-dark text-xl font-semibold"
            />
            <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-primary-400 hover:text-primary-300 transition-colors"
                onClick={() => onChange('100')} // Mock max
            >
                MAX
            </button>
        </div>
    );
}
