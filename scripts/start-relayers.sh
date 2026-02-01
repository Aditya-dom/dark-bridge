#!/bin/bash
# Start both relayers in parallel

echo "🚀 Starting Privacy Relayers..."

# Start Base → Solana relayer in background
bun run src/privacy-relayer-base-to-sol.ts --monitor &
BASE_TO_SOL_PID=$!

# Start Solana → Base relayer in background
bun run src/privacy-relayer-sol-to-base.ts --monitor &
SOL_TO_BASE_PID=$!

echo "✅ Base → Solana relayer started (PID: $BASE_TO_SOL_PID)"
echo "✅ Solana → Base relayer started (PID: $SOL_TO_BASE_PID)"

# Wait for both processes
wait $BASE_TO_SOL_PID $SOL_TO_BASE_PID
