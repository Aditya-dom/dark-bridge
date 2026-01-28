# Solana to Base Bridge Guide

This guide explains how to use the Solana → Base confidential bridge powered by Inco TEE (Trusted Execution Environment).

## Architecture Overview

The Solana to Base bridge uses **Inco Lightning TEE** for privacy-preserving cross-chain transfers:

```
┌──────────────────────────────────────────────────────────────┐
│                    User Flow (Solana → Base)                 │
└──────────────────────────────────────────────────────────────┘

1. User bridges tokens from Solana vault
   ├─ Encrypted amount burned from Solana vault
   ├─ ConfidentialBridgeOutEvent emitted with encrypted handle
   └─ Destination EVM address included in event

2. Relayer watches Solana events
   ├─ Polls Solana for ConfidentialBridgeOutEvent
   ├─ Extracts encrypted amount handle (u128)
   └─ Parses destination EVM address

3. Relayer processes via Inco TEE
   ├─ Converts Solana Euint128 handle to EVM format
   ├─ Encrypted handle passed to Base contract
   └─ No plaintext amount revealed on-chain

4. Base contract mints tokens
   ├─ receiveFromSolanaForDemo() called by relayer
   ├─ Confidential tokens minted to destination
   └─ ConfidentialBridgeReceived event emitted
```

## Components

### 1. Smart Contracts

#### Solana Program (Rust/Anchor)
- **Location:** `solana/programs/bridge/src/confidential/`
- **Key Functions:**
  - `initialize_confidential_vault` - Creates user's encrypted token vault
  - `bridge_confidential_out` - Burns tokens and emits bridge event
  - `receive_confidential_in` - Mints tokens from Base bridge

#### Base Contract (Solidity)
- **Location:** `base/src/ConfidentialBridge.sol`
- **Key Functions:**
  - `bridgePrivateToSolana()` - Base → Solana transfer
  - `receiveFromSolanaForDemo()` - Solana → Base transfer (demo mode)
  - Uses Inco Lightning TEE for encrypted amounts

### 2. Relayer Service

#### Solana to Base Relayer
- **Location:** `services/solana-to-base-relayer/`
- **What it does:**
  1. Watches for `ConfidentialBridgeOutEvent` on Solana
  2. Extracts encrypted amount handle (Euint128)
  3. Converts handle format from Solana to EVM
  4. Calls Base contract to mint tokens
  5. Pays Inco fee for encrypted operations

**Key Features:**
- ✅ Preserves privacy (no plaintext amounts revealed)
- ✅ TEE-based encryption (Inco Lightning)
- ✅ Automatic polling every 5 seconds
- ✅ Duplicate transaction prevention
- ✅ Comprehensive error handling

### 3. Frontend

- **Location:** `frontend/src/components/BridgeForm.tsx`
- **Features:**
  - Bidirectional bridge UI (Base ↔ Solana)
  - Wallet connection for both chains
  - Auto-initialization of Solana vaults
  - Real-time transaction status
  - Error handling and user feedback

## Setup Instructions

### Prerequisites

1. **Environment Variables:**
   ```bash
   # For Solana to Base Relayer
   export EVM_PRIVATE_KEY="0x..." # Private key with Base Sepolia ETH
   ```

2. **Node/Bun Dependencies:**
   ```bash
   cd services/solana-to-base-relayer
   bun install
   ```

3. **Solana Wallet:**
   - Install Phantom or Solflare wallet
   - Get devnet SOL from faucet: https://faucet.solana.com

4. **Base Wallet:**
   - MetaMask or similar EVM wallet
   - Get Base Sepolia ETH from faucet

### Running the Relayer

```bash
cd services/solana-to-base-relayer
bun run dev
```

**Expected Output:**
```
=======================================================
 🌉 Solana to Base Relayer (Inco TEE)
=======================================================
🔗 Bridge Contract: 0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF
🪙 Token Contract:  0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A
📡 Solana Program:  EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9
🤖 Relayer Address: 0x...
🌐 Solana RPC:      https://api.devnet.solana.com

Initializing Inco Lightning client...
✅ Inco client initialized
👀 Watching for ConfidentialBridgeOutEvent on Solana...
```

### Running the Frontend

```bash
cd frontend
bun install
bun run dev
```

Open http://localhost:3000

## User Guide

### Step 1: Connect Wallets

1. Click "Connect Wallet" for Base (MetaMask)
2. Click "Connect Wallet" for Solana (Phantom/Solflare)
3. Both wallets must be connected for bridging

### Step 2: Bridge Base → Solana (First Time)

Before bridging back from Solana, you need tokens in your Solana vault:

1. Select "Base → Solana" direction
2. Enter amount (e.g., 1.0 cDARK)
3. If vault doesn't exist, click "Initialize Vault" (one-time, costs ~0.003 SOL)
4. Click "Bridge to Solana"
5. Approve transaction in MetaMask
6. Wait 1-2 minutes for relayer to complete

**Expected Events:**
- ✅ Base: `ConfidentialBridgeInitiatedWithPlaintext` event
- ✅ Solana: Tokens minted to your vault
- ✅ Vault balance encrypted (only you can see it)

### Step 3: Bridge Solana → Base

Now you can bridge tokens back from Solana to Base:

1. Select "Solana → Base" direction
2. Enter amount (must be ≤ your vault balance)
3. Click "Bridge to Base"
4. Approve transaction in Phantom/Solflare
5. Wait 1-2 minutes for relayer to complete

**Expected Events:**
- ✅ Solana: `ConfidentialBridgeOutEvent` with encrypted handle
- ✅ Relayer: Watches event, extracts handle
- ✅ Base: Relayer calls `receiveFromSolanaForDemo()`
- ✅ Base: `ConfidentialBridgeReceived` event emitted
- ✅ Tokens minted to your Base address (encrypted)

### Step 4: Verify Balance

Check your confidential balance on Base:
```typescript
// Frontend already handles this via Inco SDK
// Balance is encrypted - only you can decrypt it
```

## Technical Details

### Encrypted Handle Format

**Solana (Euint128):**
- 16 bytes (128 bits)
- Little-endian encoding
- Stored in `Euint128.0` field

**EVM (euint256):**
- 32 bytes (256 bits)
- First 16 bytes: Solana handle
- Remaining 16 bytes: Zero-padded

**Conversion in Relayer:**
```typescript
// Convert u128 handle to bytes (16 bytes, little-endian)
const handleBytes = new Uint8Array(16);
const view = new DataView(handleBytes.buffer);
view.setBigUint64(0, encryptedHandle & 0xFFFFFFFFFFFFFFFFn, true);
view.setBigUint64(8, encryptedHandle >> 64n, true);

const encryptedAmountHex = toHex(handleBytes);
```

### Event Parsing

**ConfidentialBridgeOutEvent Structure:**
```rust
#[event]
pub struct ConfidentialBridgeOutEvent {
    pub vault: Pubkey,                    // 32 bytes
    pub owner: Pubkey,                    // 32 bytes
    pub destination_evm: [u8; 20],        // 20 bytes
    pub encrypted_amount_handle: u128,    // 16 bytes
}
```

**Parsing Logic:**
1. Find log with "Program data: " prefix
2. Decode base64 to binary
3. Skip first 8 bytes (Anchor discriminator)
4. Extract fields at correct offsets
5. Convert owner/vault to Solana addresses
6. Convert destination_evm to 0x... format
7. Parse u128 handle as little-endian BigInt

### Security Considerations

#### Privacy Guarantees
✅ **Amount Privacy:** Encrypted via Inco TEE, never revealed  
✅ **Sender Privacy:** Available via relayer mode (not in demo)  
✅ **Receiver Privacy:** Available via commitment/claim system  
✅ **Unlinkability:** No on-chain sender-receiver link  

#### Trust Assumptions
⚠️ **Relayer Trust:** Relayer must be honest (uses demo mode)  
⚠️ **TEE Trust:** Trust in Inco Lightning TEE security  
⚠️ **Bridge Contracts:** Contracts must be audited  

#### Production Readiness
- ⚠️ Currently using `receiveFromSolanaForDemo()` (no access control)
- ✅ Production should use `receiveFromSolana()` with nonce verification
- ✅ Production should use bridge validator signatures
- ✅ Production should implement full sender/receiver privacy

## Troubleshooting

### Relayer Issues

**"Transaction not found"**
- Wait for Solana finalization (~30 seconds)
- Check Solana Explorer for transaction status

**"Inco client not initialized"**
- Restart relayer
- Check network connectivity
- Verify Inco Lightning testnet is operational

**"Transaction reverted on Base"**
- Check relayer has sufficient ETH for gas + Inco fee
- Verify contract addresses are correct
- Check Inco fee hasn't changed

### Frontend Issues

**"Vault does not exist"**
- Click "Initialize Vault" button
- Make sure you have ~0.003 SOL for rent
- Check Solana wallet is connected

**"Insufficient balance"**
- Bridge tokens TO Solana first
- Check vault balance on Solana
- Verify you have enough tokens

**"Please connect both wallets"**
- Connect MetaMask for Base
- Connect Phantom/Solflare for Solana
- Refresh page if needed

### Common Errors

**"Fee not paid"**
- Increase gas limit
- Check you have enough ETH
- Current Inco fee: ~0.0001 ETH

**"Handle mismatch"**
- This is a security check
- Indicates potential attack
- Report if seen in production

**"Solana transaction failed"**
- Check vault exists
- Verify sufficient balance
- Check SOL for transaction fees

## Monitoring

### Relayer Logs

Watch for these key events:
```
✅ Bridge transaction detected     - Found Solana bridge TX
👤 Owner: ...                      - Sender address
🎯 Destination EVM: ...            - Base recipient
🔐 Encrypted Handle: ...           - TEE-encrypted amount
🔄 Relaying to Base...             - Starting relay
✅ RELAYED SUCCESSFULLY!           - Mint completed
```

### Transaction Explorers

**Solana:**
- Devnet: https://explorer.solana.com/?cluster=devnet
- Find your transaction by signature

**Base:**
- Sepolia: https://sepolia.basescan.org
- Find your transaction by hash

## Performance

**Typical Timings:**
- Solana transaction: ~0.5 seconds
- Relayer detection: 5-10 seconds (polling interval)
- Base transaction: ~2-3 seconds
- Total end-to-end: **1-2 minutes**

## Contract Addresses

**Base Sepolia:**
- Confidential Bridge: `0x73055cefc13AdD067D76d6390F08E9B6Cb5f2FdF`
- Confidential Token: `0xb605C1C8A1D8fA69bcE0F591952F21bB7ddb084A`

**Solana Devnet:**
- Bridge Program: `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9`
- Inco Lightning: `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj`

## Next Steps

### For Production

1. **Replace Demo Mode:**
   - Use `receiveFromSolana()` with nonce verification
   - Add bridge validator signatures
   - Implement access control

2. **Enhanced Privacy:**
   - Enable sender privacy (relayer-based submission)
   - Implement receiver privacy (commitment/claim)
   - Add batch processing for better privacy sets

3. **Monitoring:**
   - Add metrics and alerting
   - Track success/failure rates
   - Monitor relayer balance

4. **Security:**
   - Audit smart contracts
   - Penetration testing
   - Bug bounty program

## Resources

- **Inco Documentation:** https://docs.inco.org
- **TEE Architecture:** See `TEE_ARCHITECTURE.md`
- **Skill Guide:** See `.agent/skills/inco/SKILL.md`
- **Bridge Context:** See `BRIDGE_IMPLEMENTATION_CONTEXT.md`

## Support

For issues or questions:
1. Check this guide's Troubleshooting section
2. Review contract source code
3. Check Inco Discord/docs
4. Review transaction logs in explorers
