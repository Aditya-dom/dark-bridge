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

---

## Base → Solana Bridge Troubleshooting (January 2026)

This section documents the issues encountered and fixes implemented to get the Base→Solana bridge operational.

### Problem Summary

The Base→Solana bridge was not working due to several configuration and code issues:

1. **Oracle signer not authorized** on the Solana bridge program
2. **Double EIP-191 prefix bug** in the oracle signing code
3. **Wrong bridge contract address** in the oracle configuration
4. **Massive block gap** between Solana bridge state and current Base blocks

### Issue 1: Oracle Signer Not Authorized

**Symptom**: Oracle failed with `InsufficientBaseSignatures` error

**Root Cause**: The EVM address `0xF8AF04bF0Ac151f2050436603d81Ba20f449028F` (derived from the private key in `base/.env`) was not registered as an authorized oracle signer on the Solana bridge program.

**Solution**: Created `scripts/src/set-oracle-signers.ts` to call the `setOracleSigners` instruction:

```bash
cd scripts && bun run src/set-oracle-signers.ts
```

This requires the **program upgrade authority** (deployer) keypair to sign. The script:
- Derives the bridge PDA and program data address
- Builds a `BaseOracleConfig` with threshold=1 and the EVM signer address
- Sends the `setOracleSigners` instruction

**Key Transaction**: `5mzPig9YVKqkGjhpST8EJCmGKQAF5RcsRqi3Vs3pqVcZsgiW5kywSuR6bHeZEVszXxEmqryqaRffEHEzGyQ15pTG`

### Issue 2: Double EIP-191 Prefix Bug

**Symptom**: Oracle signatures were being rejected even after setting the correct signer

**Root Cause**: In `clients/ts/src/base-to-solana-oracle.ts`, the `signOutputRoot` function was:
1. Computing `messageHash` with EIP-191 prefix applied
2. Then calling `signMessage({ raw: messageHash })` which adds **another** EIP-191 prefix

This resulted in a double-prefixed message that didn't match what the Solana program expected.

**Solution**: Changed the signing flow to pass raw message bytes to `signMessage`:

```typescript
// Before (WRONG - double prefix):
const messageHash = computeOutputRootMessageHash(...); // Adds EIP-191 prefix
const signature = await account.signMessage({ message: { raw: messageHash } }); // Adds ANOTHER prefix!

// After (CORRECT - single prefix):
const rawMessage = buildRawMessageBytes(...); // NO prefix
const signature = await account.signMessage({ message: { raw: rawMessage } }); // Adds prefix ONCE
```

The Solana program at `register_output_root.rs:8` computes:
```rust
// message = keccak256("\x19Ethereum Signed Message:\n" || len || (output_root || base_block_number_be || total_leaf_count_be))
```

So viem's `signMessage` should receive the raw bytes (output_root || block_number || leaf_count), and it will add the prefix automatically.

### Issue 3: Wrong Bridge Contract Address

**Symptom**: Oracle was using a different bridge than the CLI tools

**Root Cause**: The oracle's `TESTNET_CONFIG` in `base-to-solana-oracle.ts` had:
```typescript
baseBridgeAddress: '0x2B3550823301752c95290ec6f8781E88F0Bac8c4'  // Wrong!
```

But the CLI's `testnet-alpha` config uses:
```typescript
bridgeContract: '0x8e46419298a9620ea326113baf4019a23594bb11'  // Correct!
```

**Solution**: Updated `TESTNET_CONFIG` to use the correct address:

```typescript
const TESTNET_CONFIG: OracleConfig = {
    baseBridgeAddress: '0x8e46419298a9620ea326113baf4019a23594bb11',
    // ... rest of config
};
```

### Issue 4: Block Number Gap

**Symptom**: `prove-message` failed with "Transaction not finalized yet: 4200 < 36409637"

**Root Cause**: The Solana bridge was initialized starting from block 0, but Base Sepolia was already at block 36+ million. The oracle syncs 300 blocks every 30 seconds, meaning it would take 1000+ hours to catch up.

**Solution**: Created `scripts/src/fast-forward-oracle.ts` to register output roots at any block number:

```bash
cd scripts && EVM_PRIVATE_KEY=0x... bun run src/fast-forward-oracle.ts
```

This script:
1. Gets the current Base block number
2. Reads the MMR root at a target aligned block
3. Signs the output root message
4. Calls `registerOutputRoot` on Solana at the target block

### Complete Command Reference

```bash
# 1. Set oracle signers (requires upgrade authority)
cd scripts && bun run src/set-oracle-signers.ts

# 2. Start the oracle service
cd clients/ts && \
  SOLANA_PRIVATE_KEY=$(cat ~/.config/solana/id.json) \
  EVM_PRIVATE_KEY=0x2526bbb0e6f0b2b5974fd974d7d26907e584d44c1de55876d2ef4b794fae97db \
  bun run src/base-to-solana-oracle.ts

# 3. Fast-forward to current block (for testing)
cd scripts && EVM_PRIVATE_KEY=0x... bun run src/fast-forward-oracle.ts

# 4. Create a Base transaction (example bridgeCall)
cast send 0x8e46419298a9620ea326113baf4019a23594bb11 \
  "bridgeCall((bytes32,bytes[],bytes)[])" \
  '[(0xc671a23760000000000000000000000000000000000000000000000000000000,[],0x00)]' \
  --rpc-url https://sepolia.base.org \
  --private-key 0x...

# 5. Prove message on Solana (from scripts/ directory!)
cd scripts && bun run cli sol bridge prove-message \
  --deploy-env testnet-alpha \
  --transaction-hash 0x<BASE_TX_HASH> \
  --payer-kp config

# 6. Relay message (automatically done if not using --skip-relay)
cd scripts && bun run cli sol bridge relay-message \
  --deploy-env testnet-alpha \
  --message-hash 0x<MESSAGE_HASH> \
  --payer-kp config
```

### Key Files Modified/Created

| File | Purpose |
|------|---------|
| `scripts/src/set-oracle-signers.ts` | Set authorized EVM signers on Solana bridge |
| `scripts/src/fast-forward-oracle.ts` | Jump oracle to current Base block |
| `clients/ts/src/base-to-solana-oracle.ts` | Fixed signing bug and bridge address |

### Verified End-to-End Flow

1. ✅ Oracle signer `0xF8AF04bF0Ac151f2050436603d81Ba20f449028F` authorized
2. ✅ Oracle registering output roots at 300-block intervals
3. ✅ Base transaction created at block 36409637
4. ✅ Prove-message succeeded: `4uiXn8sMRD5TBc6HQHGM9TN8VxRV8AVtsN5jG3caiAjMxfu8xhuYVNhbKMbxFxRfny5ToYNMdntFCxXKfXfBgEAp`
5. ⚠️ Relay failed due to dummy program ID (expected - test instruction was invalid)

### Architecture Insight: How the Bridge Works

```
┌─────────────────────────────────────────────────────────────────┐
│                     BASE → SOLANA FLOW                          │
│                                                                 │
│  1. User calls bridgeCall() or bridgeToken() on Base            │
│     └── MessageInitiated event emitted with MMR root + nonce    │
│                                                                 │
│  2. Oracle monitors Base, every 300 blocks:                     │
│     ├── Reads MMR root from Base bridge contract                │
│     ├── Signs (root || block_number || leaf_count) with EVM key │
│     └── Calls registerOutputRoot() on Solana bridge             │
│                                                                 │
│  3. User runs prove-message:                                    │
│     ├── Fetches Base tx receipt and MessageInitiated event      │
│     ├── Generates Merkle proof from Base bridge.generateProof() │
│     ├── Finds registered output root on Solana at >= tx block   │
│     └── Calls proveMessage() on Solana with proof               │
│                                                                 │
│  4. User runs relay-message:                                    │
│     ├── Fetches proven message account from Solana              │
│     └── Calls relayMessage() to execute the instruction(s)      │
└─────────────────────────────────────────────────────────────────┘
```

### Common Errors and Solutions

| Error | Cause | Fix |
|-------|-------|-----|
| `InsufficientBaseSignatures` | EVM signer not authorized | Run `set-oracle-signers.ts` |
| `Transaction not finalized yet` | Oracle hasn't synced to tx block | Wait for oracle or run `fast-forward-oracle.ts` |
| `Script not found "cli"` | Running from wrong directory | `cd scripts` first |
| `custom program error: #0` | Account already exists | Block already registered, skip ahead |
| `Unsupported program id` | Instruction targets invalid program | Use valid Solana program ID in bridgeCall |

