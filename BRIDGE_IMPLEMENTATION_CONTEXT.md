# Dark Bridge Implementation Context

> This document captures the complete understanding of the Dark Bridge privacy-preserving bidirectional bridge between Base (EVM) and Solana (SVM) using Inco Lightning TEE.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Deployed Contracts & Addresses](#deployed-contracts--addresses)
3. [Encryption/Decryption (Per SKILL.md)](#encryptiondecryption-per-skillmd)
4. [Relayer System](#relayer-system)
5. [User Flows](#user-flows)
6. [Frontend Implementation](#frontend-implementation)
7. [API Reference](#api-reference)
8. [Running the Bridge](#running-the-bridge)
9. [Known Issues & Solutions](#known-issues--solutions)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DARK BRIDGE ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   BASE SEPOLIA (EVM)                    SOLANA DEVNET (SVM)                 │
│   ──────────────────                    ───────────────────                 │
│                                                                             │
│   ┌─────────────────────┐               ┌─────────────────────┐             │
│   │ ConfidentialBridge  │◄─────────────►│ Bridge Program      │             │
│   │ 0x4CDE2466...99e08  │   RELAYERS    │ EEMKRm1ANM...VWBz   │             │
│   └─────────────────────┘               └─────────────────────┘             │
│            │                                      │                         │
│            ▼                                      ▼                         │
│   ┌─────────────────────┐               ┌─────────────────────┐             │
│   │ cDARK Token         │               │ ConfidentialVault   │             │
│   │ 0x2e631aeb...8c4d0b │               │ (PDA per user)      │             │
│   │ (euint256 balances) │               │ (Euint128 balances) │             │
│   └─────────────────────┘               └─────────────────────┘             │
│            │                                      │                         │
│            └──────────────┬───────────────────────┘                         │
│                           ▼                                                 │
│                  ┌─────────────────┐                                        │
│                  │  INCO LIGHTNING │                                        │
│                  │  (TEE Network)  │                                        │
│                  │                 │                                        │
│                  │  Handles only   │                                        │
│                  │  on-chain -     │                                        │
│                  │  plaintext in   │                                        │
│                  │  TEE enclaves   │                                        │
│                  └─────────────────┘                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Handles** | Opaque references to encrypted values stored in Inco TEE (bytes32 on EVM, u128 on SVM) |
| **TEE** | Trusted Execution Environment - hardware enclaves where plaintext is processed |
| **ACL** | Access Control List - must call `allow()` after operations to grant decrypt permission |
| **Vault** | PDA account on Solana holding user's encrypted balance |
| **Pepper** | Inco deployment environment - MUST use `'devnet'` to match deployed contracts |

---

## Deployed Contracts & Addresses

### Base Sepolia (Chain ID: 84532)

| Contract | Address | Purpose |
|----------|---------|---------|
| **ConfidentialBridge** | `0x4CDE2466011d1c9600720567e8fb56c418c99e08` | Main bridge with privacy features |
| **cDARK Token** | `0x2e631aeb93acf0a00df33ca2b1b6af38be8c4d0b` | Confidential ERC20 with encrypted balances |
| **Bridge (non-private)** | `0x8e46419298a9620ea326113baf4019a23594bb11` | Standard bridge contract |

### Solana Devnet

| Account | Address | Purpose |
|---------|---------|---------|
| **Bridge Program** | `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9` | Main bridge program |
| **Inco Lightning** | `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj` | Inco TEE program for encrypted ops |
| **Bridge Authority PDA** | `k9XhdJyuGbmkSePFBzZ7eUjj9EmHANQL9YivYYL53rr` | Authority for bridge operations |

### Inco Configuration

| Setting | Value |
|---------|-------|
| **Pepper** | `devnet` (CRITICAL - must match deployed contracts) |
| **Chain ID** | `84532` (Base Sepolia) |
| **Executor (EVM)** | `0x4732520194584a04Cac0224e067658619F4086bD` |

---

## Encryption/Decryption (Per SKILL.md)

### EVM (Solidity) - Base Sepolia

```solidity
import {euint256, ebool, e, inco} from "@inco/lightning/src/Lib.sol";
using e for *;

// === Creating Encrypted Values ===

// From ciphertext (user input) - requires fee
euint256 amount = ciphertext.newEuint256(msg.sender);

// From plaintext (trivial encrypt)
euint256 amount = uint256(1000).asEuint256();

// === Operations ===

euint256 sum = a.add(b);           // Addition
euint256 diff = a.sub(b);          // Subtraction
ebool isGreater = a.ge(b);         // Comparison
euint256 result = cond.select(a, b); // Conditional (if/else)

// === Access Control (CRITICAL!) ===

newBalance.allow(userAddress);     // Grant decrypt permission
newBalance.allowThis();            // Allow contract to use in future

// === Fees ===

require(msg.value >= inco.getFee(), "Fee not paid");
```

### SVM (Rust) - Solana Devnet

```rust
use inco_lightning::cpi::{e_add, e_sub, e_ge, e_select, new_euint128, as_euint128, allow};
use inco_lightning::types::{Euint128, Ebool};

// === Creating Encrypted Values ===

// From ciphertext
let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer });
let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

// From plaintext
let zero: Euint128 = as_euint128(cpi_ctx, 0)?;

// === Operations ===

let sum: Euint128 = e_add(cpi_ctx, a, b, 0)?;
let has_balance: Ebool = e_ge(cpi_ctx, balance, amount, 0)?;
let actual: Euint128 = e_select(cpi_ctx, condition, if_true, if_false, 0)?;

// === Access Control ===

allow(cpi_ctx, new_balance.0, true, owner)?;
```

### TypeScript (Frontend)

```typescript
import { Lightning } from '@inco/js/lite';
import { handleTypes } from '@inco/js';

// Initialize - MUST use 'devnet' pepper
const zap = await Lightning.latest('devnet', 84532);

// Encrypt for Base
const ciphertext = await zap.encrypt(amount, {
    accountAddress: userAddress,
    dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
    handleType: handleTypes.euint256,
});

// Attested decrypt (user signs to prove ownership)
const results = await zap.attestedDecrypt(walletClient, [handleHex]);
const plaintext = results[0].plaintext.value;
```

---

## Relayer System

### Two Relayers Required

```
┌─────────────────────────────────────────────────────────────────┐
│                      RELAYER ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   privacy-relayer-base-to-sol.ts         privacy-relayer-sol-to-base.ts
│   ─────────────────────────────          ─────────────────────────────
│                                                                 │
│   Monitors: Base Sepolia                 Monitors: Solana Devnet│
│   Event: ConfidentialBridgeInitiated     Event: ConfidentialBridgeOutEvent
│   Polls: Every 15 seconds                Polls: Every 10 seconds│
│                                                                 │
│   Actions:                               Actions:               │
│   1. Parse event from TX logs            1. Parse event (discriminator)
│   2. Convert euint256 → Euint128         2. Extract handle (u128)
│   3. Derive vault PDA                    3. Attested decrypt OR demo
│   4. Call relay_receive_confidential     4. Call confidentialMintForDemo
│                                                                 │
│   Result: Mint to Solana vault           Result: Mint to EVM address
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Event Discriminators (Anchor)

```javascript
// sha256("event:<name>")[0:8]
ConfidentialBridgeOutEvent:    fee3f47c36edab41
RelayedPrivateBridgeOutEvent:  15abd4132a56e75c
ConfidentialBridgeInEvent:     e25515375c36dd82
PrivateBridgeOutEvent:         4da661412b74e66f
```

### Handle Conversion

```
EVM (euint256, 32 bytes) ←→ SVM (Euint128, 16 bytes)

Base → Solana: Take lower 128 bits, reverse for little-endian
  euint256: 0x00000000000000000000000000000000XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  Euint128: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX (reversed)

Solana → Base: Pad zeros on left
  Euint128: XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
  euint256: 0x00000000000000000000000000000000XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## User Flows

### Flow 1: Faucet (Get Test Tokens on Base)

```
User Action: Click "Get Tokens" in frontend
    │
    ▼
Frontend calls: cDARK.confidentialMintForDemo(userAddress, 100e18)
    │
    ▼
Contract: Creates encrypted handle via asEuint256(100e18)
    │
    ▼
Contract: Adds to user's encrypted balance
    │
    ▼
Result: User has 100 cDARK (encrypted) on Base
```

### Flow 2: Bridge Base → Solana

```
User Action: Enter amount, click "Bridge to Solana"
    │
    ▼
Frontend: Encrypt amount with Inco
    zap.encrypt(amount, { handleType: euint256 })
    │
    ▼
Frontend: Call bridgePrivateToSolana(token, solanaAddress, ciphertext)
    │
    ▼
Contract:
    1. newEuint256(ciphertext) → handle
    2. confidentialBurnFromHandle(sender, handle)
    3. emit ConfidentialBridgeInitiated(nonce, token, remoteToken, toSolana, handle)
    │
    ▼
Relayer (privacy-relayer-base-to-sol.ts):
    1. Detect event
    2. Convert handle: euint256 → Euint128
    3. Call relay_receive_confidential on Solana
    │
    ▼
Solana Bridge:
    1. new_euint128(ciphertext) → handle
    2. e_add(vault.balance, amount)
    3. allow(new_balance, owner)
    │
    ▼
Result: User's Solana vault has encrypted tokens
```

### Flow 3: Bridge Solana → Base

```
User Action: Call bridge_confidential_out on Solana (CLI/dApp)
    │
    ▼
Solana Bridge:
    1. new_euint128(ciphertext) → handle
    2. e_ge(balance, amount) → check sufficient
    3. e_sub(balance, actual_amount)
    4. emit ConfidentialBridgeOutEvent(vault, owner, destEvm, handle)
    │
    ▼
Relayer (privacy-relayer-sol-to-base.ts):
    1. Detect event (discriminator: fee3f47c36edab41)
    2. Try attested decrypt OR use demo fallback (5 tokens)
    3. Call confidentialMintForDemo on Base
    │
    ▼
Base Contract:
    1. asEuint256(amount) → handle
    2. Add to user's encrypted balance
    │
    ▼
Result: User's Base address has encrypted cDARK tokens
```

---

## Frontend Implementation

### File Structure

```
frontend/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout
│   │   ├── page.tsx            # Main page with components
│   │   └── providers.tsx       # Wagmi + Solana wallet providers
│   ├── components/
│   │   ├── WalletConnector.tsx # EVM + Solana wallet connection
│   │   ├── Faucet.tsx          # Mint test tokens
│   │   └── BridgeForm.tsx      # Bridge UI with direction toggle
│   └── lib/
│       ├── constants.ts        # Contract addresses, RPC URLs
│       ├── evm.ts              # Wagmi config
│       └── inco.ts             # Inco SDK wrapper (encrypt/decrypt)
```

### Key Constants (constants.ts)

```typescript
// Contract addresses (from base/deployments/base_sepolia.json)
export const CONFIDENTIAL_BRIDGE_ADDRESS = "0x4CDE2466011d1c9600720567e8fb56c418c99e08";
export const CONFIDENTIAL_TOKEN_ADDRESS = "0x2e631aeb93acf0a00df33ca2b1b6af38be8c4d0b";

// Solana
export const BRIDGE_PROGRAM_ID = "EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9";
export const SOLANA_RPC_URL = "https://api.devnet.solana.com";

// Inco - CRITICAL: Must be 'devnet'
export const INCO_PEPPER = "devnet";
export const BASE_CHAIN_ID = 84532;
```

### Inco Integration (inco.ts)

```typescript
import { Lightning } from "@inco/js/lite";
import { handleTypes } from "@inco/js";

let zapInstance = null;

export async function getZap() {
    if (!zapInstance) {
        // MUST use 'devnet' pepper to match deployed contracts
        zapInstance = await Lightning.latest(INCO_PEPPER, BASE_CHAIN_ID);
    }
    return zapInstance;
}

export async function encryptAmount(amount: bigint, accountAddress: string) {
    const zap = await getZap();
    const encrypted = await zap.encrypt(amount, {
        accountAddress,
        dappAddress: CONFIDENTIAL_BRIDGE_ADDRESS,
        handleType: handleTypes.euint256,
    });
    return `0x${Buffer.from(encrypted).toString("hex")}`;
}
```

---

## API Reference

### Base Contracts

#### ConfidentialBridge

```solidity
// Bridge tokens to Solana (user calls directly)
function bridgePrivateToSolana(
    address localToken,      // cDARK token address
    bytes32 toSolana,        // Recipient's Solana pubkey as bytes32
    bytes calldata encryptedAmount  // Inco ciphertext
) external payable;

// Get required Inco fee
function getIncoFee() external view returns (uint256);

// User nonce for signatures
function getUserNonce(address user) external view returns (uint256);
```

#### ConfidentialCrossChainERC20 (cDARK)

```solidity
// Mint tokens for testing (encrypts plaintext)
function confidentialMintForDemo(address to, uint256 plainAmount) external payable;

// Burn from handle (bridge calls this)
function confidentialBurnFromHandle(address from, euint256 amount) external;
```

### Solana Program

#### Instructions

```rust
// Initialize user's vault (required before receiving)
initialize_confidential_vault(owner, token_mint)

// Bridge out to Base
bridge_confidential_out(encrypted_amount, destination_evm)

// Relayer mints incoming tokens
relay_receive_confidential(encrypted_amount, base_sender)

// Grant decrypt permission on a handle
grant_handle_access(handle)
```

#### Events

```rust
// Emitted when bridging out
ConfidentialBridgeOutEvent {
    vault: Pubkey,
    owner: Pubkey,
    destination_evm: [u8; 20],
    encrypted_amount_handle: u128,
}

// Emitted when receiving
ConfidentialBridgeInEvent {
    vault: Pubkey,
    owner: Pubkey,
    base_sender: [u8; 20],
    encrypted_amount_handle: u128,
}
```

---

## Running the Bridge

### Prerequisites

```bash
# Install bun (required for @inco/js ESM compatibility)
curl -fsSL https://bun.sh/install | bash

# Ensure Solana CLI configured
solana config get  # Should show devnet

# Set EVM private key
export EVM_PRIVATE_KEY=0x...
```

### Start All Services (3 Terminals)

```bash
# Terminal 1: Frontend
cd frontend
npm install
npm run dev
# → http://localhost:3000

# Terminal 2: Base → Solana Relayer
cd scripts
bun install
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts --monitor

# Terminal 3: Solana → Base Relayer
cd scripts
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
```

### Manual Operations

```bash
# Process specific Base TX
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-base-to-sol.ts 0x<TX_HASH>

# Process specific Solana TX
EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts <SOLANA_SIG>

# Initialize Solana vault (required before receiving)
bun run cli sol bridge init-confidential-vault --deploy-env testnet-alpha
```

---

## Known Issues & Solutions

### Issue 1: @inco/js ESM Compatibility

**Problem:** Node.js fails with ESM module resolution errors

**Solution:** Use `bun` instead of `node`:
```bash
bun run src/script.ts  # Works
node src/script.ts     # Fails
```

### Issue 2: Wrong Pepper Causes Handle Mismatch

**Problem:** `ExternalHandleDoesNotMatchComputedHandle` error

**Solution:** Always use `'devnet'` pepper:
```typescript
// ✅ Correct
const zap = await Lightning.latest('devnet', 84532);

// ❌ Wrong - different executor address
const zap = await Lightning.latest('testnet', 84532);
```

### Issue 3: Vault Not Initialized

**Problem:** Relayer fails with "Vault does not exist"

**Solution:** User must initialize vault before receiving:
```bash
bun run cli sol bridge init-confidential-vault \
  --deploy-env testnet-alpha \
  --token-mint <MINT_ADDRESS>
```

### Issue 4: Attested Decrypt Fails (ACL)

**Problem:** "Address is not allowed to decrypt this handle"

**Solution:** Ensure `allow()` was called after the operation:
```rust
// In Solana program
allow(cpi_ctx, new_balance.0, true, vault.owner)?;
```

```solidity
// In EVM contract
newBalance.allow(userAddress);
```

### Issue 5: Inco Fee Not Paid

**Problem:** Transaction reverts with "Fee not paid"

**Solution:** Include fee in transaction value:
```typescript
const fee = await contract.read.getIncoFee();
await contract.write.bridgePrivateToSolana([...], { value: fee });
```

---

## Quick Reference

### Contract Addresses (Copy-Paste Ready)

```
Base Sepolia:
  ConfidentialBridge: 0x4CDE2466011d1c9600720567e8fb56c418c99e08
  cDARK Token:        0x2e631aeb93acf0a00df33ca2b1b6af38be8c4d0b

Solana Devnet:
  Bridge Program:     EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9
  Inco Lightning:     5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj
```

### Event Discriminators (Copy-Paste Ready)

```
ConfidentialBridgeOutEvent:    fee3f47c36edab41
RelayedPrivateBridgeOutEvent:  15abd4132a56e75c
ConfidentialBridgeInEvent:     e25515375c36dd82
```

### Inco Pepper

```
ALWAYS USE: 'devnet'
```

---

## Implementation Summary

### What's Been Built

| Component | File | Status |
|-----------|------|--------|
| **Frontend Constants** | `frontend/src/lib/constants.ts` | ✅ Correct addresses |
| **Faucet Component** | `frontend/src/components/Faucet.tsx` | ✅ Mints 100 cDARK |
| **Bridge Form** | `frontend/src/components/BridgeForm.tsx` | ✅ Base→Solana with Inco encryption |
| **Wallet Providers** | `frontend/src/app/providers.tsx` | ✅ Wagmi + Solana Wallet Adapter |
| **Inco SDK Wrapper** | `frontend/src/lib/inco.ts` | ✅ 'devnet' pepper |
| **Base→Solana Relayer** | `scripts/src/privacy-relayer-base-to-sol.ts` | ✅ Monitors & relays |
| **Solana→Base Relayer** | `scripts/src/privacy-relayer-sol-to-base.ts` | ✅ Monitors & relays |

### User Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                     COMPLETE USER FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Connect Wallets (Frontend)                                  │
│     └─ EVM (MetaMask) + Solana (Phantom)                        │
│                                                                 │
│  2. Get Faucet Tokens (Frontend)                                │
│     └─ Click "Get 100 cDARK" → Encrypted tokens on Base         │
│                                                                 │
│  3. Bridge Base → Solana (Frontend)                             │
│     ├─ Enter amount                                             │
│     ├─ Encrypt with Inco TEE                                    │
│     └─ Submit bridgePrivateToSolana()                           │
│                                                                 │
│  4. Relayer Picks Up (privacy-relayer-base-to-sol.ts)           │
│     ├─ Detects ConfidentialBridgeInitiated event                │
│     ├─ Converts euint256 → Euint128                             │
│     └─ Calls relay_receive_confidential on Solana               │
│                                                                 │
│  5. Tokens Arrive on Solana                                     │
│     └─ Encrypted balance in user's ConfidentialVault            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

*Last Updated: January 2026*
*Created during codebase analysis for E2E bridge implementation*
