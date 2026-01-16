# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a bidirectional bridge between Base and Solana that enables:

- Cross-chain token transfers (SOL, SPL tokens, ERC20s, ETH)
- Arbitrary cross-chain message passing
- Wrapped token deployment on both chains
- **Privacy-preserving transfers via Inco Lightning FHE**

The bridge consists of two main components:

1. **Base contracts** (Solidity/Foundry) - handles Base-side operations
2. **Solana program** (Rust/Anchor) - handles Solana-side operations

## Development Commands

### Base Contracts (Foundry)

```bash
cd base

# Build contracts
forge build

# Run tests
forge test

# Run fork tests against Base Sepolia
forge test --fork-url https://sepolia.base.org -vvv

# Test coverage
make coverage

# Install dependencies
make deps

# Deploy to testnet
make deploy

# Create wrapped tokens
make create-wrapped-sol
make create-wrapped-spl
```

### Solana Program

```bash
cd solana

# Install dependencies
bun install

# Build program for specific environment
bun run program:build devnet-alpha
bun run program:build devnet-prod

# Deploy program
bun run program:deploy devnet-alpha

# Generate IDL and client
bun run generate:idl devnet-alpha
bun run generate:client

# Initialize bridge
bun run tx:initialize devnet-alpha

# Bridge operations
bun run tx:bridge-sol devnet-alpha
bun run tx:bridge-spl devnet-alpha
bun run tx:wrap-token devnet-alpha
```

### TypeScript Client

```bash
cd clients/ts

# Install dependencies
npm install

# Generate test ciphertexts (requires bun due to @inco/js ESM issues)
bun run src/generate-test-ciphertexts.ts
```

## Architecture

### Base Side

- **Bridge.sol**: Main contract receiving calls from Solana and managing message execution
- **Twin.sol**: Execution contract for each Solana sender pubkey  
- **CrossChainERC20.sol**: Mintable/burnable ERC20 for cross-chain transfers
- **CrossChainERC20Factory.sol**: Factory for deploying wrapped tokens
- **ConfidentialBridge.sol**: Privacy-preserving bridge using Inco Lightning FHE
- **ConfidentialCrossChainERC20.sol**: FHE-enabled ERC20 with encrypted balances

### Solana Side

- **Bridge State**: Central account with configuration and message nonces
- **OutgoingMessage**: Messages sent from Solana to Base
- **IncomingMessage**: Messages sent from Base to Solana
- **Vaults**: Lock SPL tokens and native SOL during bridging
- **ConfidentialVault**: FHE-enabled vault for private balances

### Bridge Flow

1. **Base → Solana**: Initiate on Base, wait ~15 minutes for root posting, then prove + finalize on Solana
2. **Solana → Base**: Direct execution after message creation

### Privacy Flow (Inco Lightning)

1. User encrypts amount using `@inco/js` SDK
2. Encrypted ciphertext passed to `bridgePrivateToSolana()`
3. Bridge stores expected handle and nonce for verification
4. On receive, handle is verified to prevent substitution attacks
5. `receiveFromSolana(nonce, token, recipient, encryptedAmount)` mints to recipient

### Bidirectional Bridge Client (Added in 6d71c93)

A unified client (`BidirectionalBridge`) manages operations across both chains:

- **State Monitoring**: `getState()` provides real-time sync status (Base blocks/MMR vs Solana registered roots).
- **Visual Dashboard**: `printStatus()` displays bridge balances, message counts, and oracle sync latency.
- **Operations**:
  - `startOracle()`: Runs the oracle service to register Base output roots.
  - `proveMessage()`: Proves and relays Base messages to Solana.
  - `relayToBase()`: Relays Solana messages to Base.

## Environment Setup

### Base Contracts

- Uses Foundry with forge
- Requires `testnet-admin` wallet account for deployments
- Environment variables in `base/Makefile` for contract addresses
- Inco Lightning available on Base Sepolia at precompile addresses

### Solana Program  

- Uses Anchor framework with Rust
- Requires keypair files in `keypairs/` directory
- Two environments: devnet-alpha and devnet-prod

## Testing Strategy

### Unit Tests

- **Base**: Use `forge test` for Solidity unit tests
- **Solana**: Rust unit tests within the program

### Fork Tests

Fork tests run against Base Sepolia with real Inco Lightning infrastructure:

```bash
cd base

# Basic fork tests (fast, ~30s)
forge test --match-contract ConfidentialBridgeForkTest --fork-url https://sepolia.base.org -v

# E2E fork tests (requires real Inco ciphertexts)
forge test --match-contract ConfidentialBridgeE2EForkTest --fork-url https://sepolia.base.org -vv

# Handle verification security tests
forge test --match-contract ConfidentialBridgeHandleVerificationTest --fork-url https://sepolia.base.org -vv
```

### Test Files

- `ConfidentialBridge.Fork.t.sol` - Basic deployment and configuration tests
- `ConfidentialBridge.E2E.Fork.t.sol` - End-to-end privacy scenarios
- `ConfidentialBridge.HandleVerification.t.sol` - Handle verification security tests

### Test Setup Requirements

Tests using Inco FHE operations require:

1. **Contract funding** - Contracts need ETH to pay Inco fees
2. **Real ciphertexts** - Mock ciphertexts will be rejected by Inco precompiles
3. **DEPLOYED_BRIDGE funding** - When using `vm.prank()`, ensure the pranked address has ETH

Example test setup:

```solidity
// Fund contracts with ETH to pay Inco fees
vm.deal(address(confidentialBridge), 50 ether);
vm.deal(address(confidentialToken), 50 ether);
vm.deal(DEPLOYED_BRIDGE, 50 ether); // For prank calls
```

## Known Issues

### @inco/js ESM Package Bug ✅ RESOLVED

The `@inco/js` package (v0.8.0-devnet) has **broken ESM exports** when used with Node.js:

- Missing `types_pb` module in ESM resolution
- Named exports fail: `"does not provide an export named 'Lightning'"`
- Affects: `@inco/js/lite`, `@inco/js/encryption` subpaths

**Resolution:** Use **bun** instead of Node.js

```bash
# Install bun (one-time)
curl -fsSL https://bun.sh/install | bash
source ~/.zshrc

# Run scripts with bun (works perfectly!)
bun run src/demo-private-bridge.ts
```

**Why this works:** Bun has better ESM module resolution that handles the package's subpath exports correctly.

**Additional fix needed:** The `Lightning.latest()` method returns a Promise, so it must be awaited:

```typescript
// ❌ Wrong (what was causing "encrypt is not a function")
this.baseZap = Lightning.latest(config.incoEnvironment, chainId);

// ✅ Correct (await the Promise)
this.baseZap = await Lightning.latest(config.incoEnvironment, chainId);
```

### ConfidentialCrossChainERC20 Initialization

The implementation contract has `_disableInitializers()` in its constructor. This means:

- **Do NOT call `initialize()` on deployed implementation contracts**
- Tests should skip initialization or use a proxy pattern
- Will get `InvalidInitialization()` error if you try to initialize

### Inco Fork Test Limitation

When running fork tests with mock encrypted amounts:

- The mock bytes (`_mockEncryptedAmount()`) will be **rejected** by real Inco precompiles
- Tests will revert at `newEuint256()` call to Inco covalidator
- Solutions: Use real ciphertexts from `@inco/js`, mock the precompile, or skip Inco-dependent tests

## Key Files to Understand

### Core Contracts

- `base/src/Bridge.sol` - Core Base bridge logic
- `base/src/ConfidentialBridge.sol` - Privacy-preserving bridge
- `base/src/ConfidentialCrossChainERC20.sol` - FHE-enabled ERC20
- `solana/programs/bridge/src/lib.rs` - Solana program entry point  

### Deployment & Scripts

- `base/script/Deploy.s.sol` - Base deployment script
- `solana/scripts/onchain/` - Solana transaction examples

### Testing

- `base/test/ConfidentialBridge.Fork.t.sol` - Fork test suite
- `base/test/ConfidentialBridge.HandleVerification.t.sol` - Security tests

### TypeScript SDK

- `clients/ts/src/privacy-client.ts` - Privacy bridge client using Inco
- `clients/ts/src/bidirectional-bridge.ts` - Unified bridge client & oracle
- `clients/ts/src/generate-test-ciphertexts.ts` - Test ciphertext generator

## Inco Lightning Integration

### EVM (Base)

```solidity
import {euint256, ebool, e, inco} from "@inco/lightning/Lib.sol";

// Get Inco fee
uint256 fee = inco.getFee();

// Create encrypted value from ciphertext
euint256 encrypted = e.newEuint256{value: fee}(ciphertext, msg.sender);

// Arithmetic on encrypted values
euint256 sum = e.add(a, b);

// Comparison
ebool isGreater = e.ge(a, b);

// Access control
e.allow(handle, user);
```

### SVM (Solana)

Uses CPI to Inco Lightning program for FHE operations. See `clients/ts/src/privacy-client.ts` for encryption examples.
