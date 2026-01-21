---
name: Inco Confidential Smart Contract Development
description: Guide for building privacy-preserving smart contracts using Inco Lightning on EVM (Solidity) and SVM (Solana/Rust)
---

# Inco Confidential Smart Contract Development

Inco is the confidentiality layer for blockchains that enables privacy-preserving smart contracts without modifying the underlying chain. This skill covers development for both **EVM (Solidity)** and **SVM (Solana/Rust)** platforms.

---

## Quick Reference

### EVM (Solidity)

**Import Statement:**
```solidity
import {e, ebool, euint256, eaddress, inco} from "@inco/lightning/src/Lib.sol";
```

**Contract Setup:**
```solidity
using e for *;
```

### SVM (Solana/Rust)

**Cargo.toml:**
```toml
[dependencies]
inco-lightning = { version = "0.1.4", features = ["cpi"] }
```

**Program ID:** `5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj`

---

## EVM Development Guide

### Encrypted Types

| Type | Description |
|------|-------------|
| `euint256` | Encrypted unsigned 256-bit integer |
| `ebool` | Encrypted boolean |
| `eaddress` | Encrypted address |

All e-types are `bytes32` handles pointing to encrypted data stored off-chain.

### Creating Encrypted Values

#### From Ciphertext (User Input)
```solidity
// Requires fee payment
function deposit(bytes memory ciphertext) external payable {
    require(msg.value >= inco.getFee(), "Fee not paid");
    euint256 value = ciphertext.newEuint256(msg.sender);
    // use value...
}
```

#### From Known Value (Trivial Encrypt)
```solidity
euint256 amount = uint256(1000).asEuint256();
ebool flag = true.asEbool();
eaddress addr = address(0x123).asEaddress();
```

### Operations

#### Arithmetic (return `euint256`)
- `e.add`, `e.sub`, `e.mul`, `e.div`, `e.rem`
- `e.and`, `e.or`, `e.xor`, `e.shr`, `e.shl`, `e.rotr`, `e.rotl`

#### Comparison (return `ebool`)
- `e.eq`, `e.ne`, `e.ge`, `e.gt`, `e.le`, `e.lt`

#### Other
- `e.min`, `e.max` → `euint256`
- `e.not` → `ebool`
- `e.select(condition, ifTrue, ifFalse)` → conditional selection
- `e.rand()`, `e.randBounded(max)` → random generation (requires fee)

### Access Control

**CRITICAL:** Always manage access after operations.

```solidity
// Allow address to decrypt
newBalance.allow(userAddress);

// Allow this contract to compute over the value
newBalance.allowThis();

// Check if address has access
bool hasAccess = msg.sender.isAllowed(handle);
```

### Fee Management

Operations requiring fees:
- `newEuint256()`, `newEbool()`, `newEaddress()` - 1 fee each
- `e.rand()`, `e.randBounded()` - 1 fee each

```solidity
// Get current fee
uint256 fee = inco.getFee();

// User pays
require(msg.value >= inco.getFee() * ciphertextCount, "Fee not paid");

// Or contract pays from balance
function depositFees() external payable {}
```

### Decryption Patterns

#### Attested Reveal (Public)
```solidity
// Mark for public decryption (IRREVERSIBLE)
e.reveal(handle);
```

#### Attested Decrypt (Private)
Requires user signature via JS SDK - see JavaScript section.

### Testing (Foundry)

```solidity
import {IncoTest} from "@inco/lightning/src/test/IncoTest.sol";

contract MyTest is IncoTest {
    function setUp() public override {
        super.setUp(); // Required!
    }

    function testSomething() public {
        // Create test values
        euint256 value = e.asEuint256(100);
        
        // Process operations
        processAllOperations();
        
        // Decrypt for assertions (test only)
        uint256 plain = getUint256Value(handle);
    }
}
```

### Complete EVM Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {euint256, ebool, e, inco} from "@inco/lightning/src/Lib.sol";

contract ConfidentialToken {
    using e for *;
    
    mapping(address => euint256) public balanceOf;
    
    constructor() {
        balanceOf[msg.sender] = uint256(1000 * 1e9).asEuint256();
    }
    
    function transfer(address to, bytes memory valueInput) external payable returns (ebool) {
        require(msg.value >= inco.getFee(), "Fee not paid");
        euint256 value = valueInput.newEuint256(msg.sender);
        return _transfer(to, value);
    }
    
    function _transfer(address to, euint256 value) internal returns (ebool success) {
        success = balanceOf[msg.sender].ge(value);
        euint256 transferredValue = success.select(value, uint256(0).asEuint256());
        
        euint256 senderBalance = balanceOf[msg.sender].sub(transferredValue);
        euint256 receiverBalance = balanceOf[to].add(transferredValue);
        
        balanceOf[msg.sender] = senderBalance;
        balanceOf[to] = receiverBalance;
        
        // Grant access
        senderBalance.allow(msg.sender);
        receiverBalance.allow(to);
        senderBalance.allowThis();
        receiverBalance.allowThis();
        success.allow(msg.sender);
    }
}
```

---

## SVM (Solana) Development Guide

### Encrypted Types

| Type | Description |
|------|-------------|
| `Euint128` | Handle to encrypted 128-bit integer |
| `Ebool` | Handle to encrypted boolean |

### Setup

```rust
use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::{Operation, Allow};
use inco_lightning::cpi::{e_add, e_sub, e_ge, e_select, new_euint128, allow};
use inco_lightning::types::{Euint128, Ebool};
use inco_lightning::ID as INCO_LIGHTNING_ID;
```

### Account Structure

```rust
#[derive(Accounts)]
pub struct MyInstruction<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}
```

### CPI Pattern

```rust
// Create CPI context
let cpi_ctx = CpiContext::new(
    ctx.accounts.inco_lightning_program.to_account_info(),
    Operation {
        signer: ctx.accounts.authority.to_account_info(),
    },
);

// Perform operation
let result: Euint128 = e_add(cpi_ctx, a, b, 0)?;
```

### Operations

#### Arithmetic
- `e_add`, `e_sub`, `e_mul`, `e_rem`

#### Comparison (return `Ebool`)
- `e_ge`, `e_gt`, `e_le`, `e_lt`, `e_eq`

#### Bitwise
- `e_and`, `e_or`, `e_not`, `e_shl`, `e_shr`

#### Control
- `e_select(ctx, condition, if_true, if_false, 0)` → conditional
- `e_rand(ctx, 0)` → random

### Input Functions

```rust
// From ciphertext
let encrypted: Euint128 = new_euint128(cpi_ctx, ciphertext_bytes, 0)?;

// From plaintext (trivial encrypt)
let encrypted: Euint128 = as_euint128(cpi_ctx, 100u128)?;
```

### Access Control

```rust
// Grant decryption access
let cpi_ctx = CpiContext::new(
    ctx.accounts.inco_lightning_program.to_account_info(),
    Allow {
        allowance_account: allowance_pda.to_account_info(),
        signer: ctx.accounts.authority.to_account_info(),
        allowed_address: user_address.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
    },
);
allow(cpi_ctx, handle.0, true, user_pubkey)?;
```

### Complete SVM Example

```rust
use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::{Operation, Allow};
use inco_lightning::cpi::{e_add, e_sub, e_ge, e_select, as_euint128, allow};
use inco_lightning::types::{Euint128, Ebool};
use inco_lightning::ID as INCO_LIGHTNING_ID;

#[program]
pub mod confidential_token {
    use super::*;

    pub fn transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, Transfer<'info>>,
        amount: Euint128,
    ) -> Result<()> {
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.authority.to_account_info();
        
        // Check balance
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let has_balance: Ebool = e_ge(cpi_ctx, ctx.accounts.source.balance, amount, 0)?;
        
        // Get zero for failed case
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let zero = as_euint128(cpi_ctx, 0)?;
        
        // Select actual amount
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let actual: Euint128 = e_select(cpi_ctx, has_balance, amount, zero, 0)?;
        
        // Update balances
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        ctx.accounts.source.balance = e_sub(cpi_ctx, ctx.accounts.source.balance, actual, 0)?;
        
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        ctx.accounts.dest.balance = e_add(cpi_ctx, ctx.accounts.dest.balance, actual, 0)?;
        
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest: Account<'info, TokenAccount>,
    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct TokenAccount {
    pub owner: Pubkey,
    pub balance: Euint128,
}
```

---

## JavaScript SDK

### Installation

```bash
npm install @inco/js
```

### Initialize

```typescript
import { Lightning, supportedChains, getViemChain } from '@inco/js';
import { createWalletClient, custom } from 'viem';

const zap = await Lightning.latest('testnet', supportedChains.baseSepolia);
const walletClient = createWalletClient({
    chain: getViemChain(supportedChains.baseSepolia),
    transport: custom(window.ethereum!)
});
```

### Encrypt Values

```typescript
import { handleTypes } from '@inco/js';

// Encrypt uint256
const ct = await zap.encrypt(42n, {
    accountAddress: walletClient.account.address,
    dappAddress: contractAddress,
    handleType: handleTypes.euint256,
});

// Encrypt bool
const ctBool = await zap.encrypt(true, {
    accountAddress: walletClient.account.address,
    dappAddress: contractAddress,
    handleType: handleTypes.ebool,
});

// Encrypt address (as euint160)
const ctAddr = await zap.encrypt(BigInt(address), {
    accountAddress: walletClient.account.address,
    dappAddress: contractAddress,
    handleType: handleTypes.euint160,
});
```

### Attested Decrypt

```typescript
const results = await zap.attestedDecrypt(
    walletClient,
    [handleHex]
);
const plaintext = results[0].plaintext.value;

// With attestation for on-chain verification
const { handle, plaintext, covalidatorSignatures } = results[0];
await contract.write.submitDecryption([
    { handle, value: plaintext.value },
    covalidatorSignatures,
]);
```

### Attested Reveal

```typescript
// For handles marked with e.reveal()
const results = await zap.attestedReveal([handleHex]);
const plaintext = results[0].plaintext;
```

### Attested Compute

```typescript
import { AttestedComputeSupportedOps } from '@inco/js/lite';

// Off-chain comparison
const result = await zap.attestedCompute(
    walletClient,
    handleHex,
    AttestedComputeSupportedOps.Ge,
    700n  // compare: handle >= 700
);
const passed = result.plaintext.value; // boolean
```

---

## Best Practices

### Security

1. **Always validate input access:**
   ```solidity
   require(msg.sender.isAllowed(value), "Unauthorized");
   ```

2. **Always call `allowThis()` after updating state:**
   ```solidity
   balance = balance.add(amount);
   balance.allowThis(); // Required for future operations!
   ```

3. **Verify handles in attestations:**
   ```solidity
   require(euint256.unwrap(storedHandle) == decryption.handle, "Handle mismatch");
   ```

4. **Use dynamic fees:**
   ```solidity
   require(msg.value >= inco.getFee() * count, "Insufficient fee");
   ```

### Information Leakage

Be aware that certain patterns leak information:
- List/array lengths are always public
- Transaction timing can reveal patterns
- Public price changes during confidential swaps reveal amounts

### Common Mistakes

1. **Forgetting `allowThis()`** - Contract can't use values in future transactions
2. **Not granting user access** - Users can't see their own data
3. **Hardcoding fees** - Fees may change over time
4. **Using `delegatecall`** - Delegated contract can decrypt your data

---

## Project Setup

### EVM (Foundry + Bun)

```bash
git clone https://github.com/Inco-fhevm/lightning-rod.git
cd lightning-rod
bun install
bun run test
docker compose down
```

### SVM (Anchor)

```bash
# Anchor.toml
[programs.devnet]
inco_lightning = "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
```

---

## Resources

- **Documentation:** https://docs.inco.org
- **EVM Template:** https://github.com/Inco-fhevm/lightning-rod
- **LLM-Friendly Docs:** https://docs.inco.org/llms.txt
