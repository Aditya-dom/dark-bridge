# DarkBridge

<div align="center">
  <img src="frontend/public/logo.png" alt="DarkBridge Logo" width="120" />
  <h3>Private Cross-Chain Bridge utilizing Inco TEEs</h3>
</div>

DarkBridge is a privacy-preserving cross-chain bridge connecting **Base** (EVM) and **Solana** (SVM). It leverages **Inco Network's Trusted Execution Environment (TEE)** to facilitate encrypted token transfers, ensuring transaction amounts and balances remain confidential on-chain.

## Features

* **Privacy First**: Transaction amounts are encrypted end-to-end using Inco's FHE (Fully Homomorphic Encryption) stack.
* **Cross-Chain**: Bridge assets seamlessly between Base and Solana.
* **Serverless Architecture**: Relayers are hosted as Next.js API Routes on Vercel, eliminating the need for external servers.
* **Mobile Responsive**: A modern, responsive UI optimized for all devices.
* **Fast & Secure**: Powered by Hyperlane for messaging and Inco for privacy.

## Project Structure

* **`frontend/`**: Next.js application containing the UI and Vercel-hosted relayers.
  * `src/app/docs/`: Detailed user guide and documentation.
  * `src/app/api/cron/`: Auto-relayer API routes.
* **`clients/`**: TypeScript clients for interacting with the bridge contracts.
* **`base/`**: Solidity contracts for the Base side (ConfidentialBridge, ConfidentialToken).
* **`solana/`**: Rust programs for the Solana side (ConfidentialVault, Bridge).

## Getting Started

### Prerequisites

* Node.js & npm/bun
* EVM Wallet (MateMask, Coinbase Wallet)
* Solana Wallet (Phantom, Backpack)

### Running Locally

1. **Install Dependencies**:

    ```bash
    cd frontend
    npm install
    ```

2. **Environment Setup**:
    Create `.env.local` in `frontend/` with your keys for local relayer testing (optional):

    ```env
    EVM_PRIVATE_KEY=0x...
    SOLANA_PRIVATE_KEY=[...]
    CRON_SECRET=test
    ```

3. **Start Development Server**:

    ```bash
    npm run dev
    ```

    Visit `http://localhost:3000` to use the bridge.

## Hosting on Vercel

The entire infrastructure is designed to be hosted on Vercel.

1. **Deploy**: Connect your repo to Vercel.
2. **Configure Config**: Add `EVM_PRIVATE_KEY`, `SOLANA_PRIVATE_KEY`, and `CRON_SECRET` to Vercel Environment Variables.
3. **Automation**: The relayers will automatically run every minute via Vercel Cron.

**See [HOSTING_GUIDE.md](HOSTING_GUIDE.md) for detailed deployment instructions.**

## Documentation

Comprehensive usage documentation is available within the app at `/docs` or via the "Docs" link in the menu.

* **Faucet**: Validated drip for testnet tokens.
* **Vault Init**: One-time setup for private Solana accounts.
* **Bridging**: Step-by-step transfer guide.
* **Balance Check**: Attested decryption to view private balances.
