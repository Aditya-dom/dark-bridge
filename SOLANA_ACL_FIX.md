# Solana Bridge ACL Fix: 4 Remaining Accounts for Attested Decrypt

## Problem

The Solana privacy bridge was failing to grant `allow()` permissions on the **bridged amount handle**, preventing attested decryption for cross-chain relaying. This caused the relayer to fail when trying to decrypt the amount for minting on Base.

### Root Cause

The `bridge_confidential_out` and `bridge_confidential_out_plaintext` instructions create **two encrypted handles** during execution:

1. **`new_balance`**: The user's remaining vault balance after bridging
2. **`actual_amount`**: The amount being bridged (after e_select for balance check)

The Solana program code (instructions.rs) had logic to grant `allow()` on **both** handles, but **only if** `ctx.remaining_accounts.len() >= 4`:

```rust
// Grant allowance for new_balance (lines 91-102)
if ctx.remaining_accounts.len() >= 2 {
    allow(cpi_ctx, new_balance.0, true, vault.owner)?;

    // Grant allowance for actual_amount (lines 168-179)
    if ctx.remaining_accounts.len() >= 4 {
        allow(cpi_ctx, actual_amount.0, true, vault.owner)?;  // ❌ This was being skipped!
    }
}
```

However, the **frontend TypeScript code** was only passing the 4 base accounts with **zero remaining accounts**, causing the second `allow()` call to be skipped.

## Solution

### 1. Frontend Client Fix ([frontend/src/lib/solana.ts](frontend/src/lib/solana.ts))

Updated `buildBridgeConfidentialOutInstruction()` to **always pass 4 remaining accounts**:

```typescript
// Derive workspace PDAs for Inco allowance records
const allowancePda0 = deriveIncoAllowancePda(vaultPda, 0); // For new_balance
const allowancePda1 = deriveIncoAllowancePda(vaultPda, 1); // For actual_amount

return new TransactionInstruction({
    programId: BRIDGE_PROGRAM_ID,
    keys: [
        // Base accounts (4)
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: vaultPda, isSigner: false, isWritable: true },
        { pubkey: INCO_LIGHTNING_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },

        // ✅ NEW: Remaining accounts for Inco allow() CPIs (4)
        // [0-1]: For new_balance handle
        { pubkey: allowancePda0, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },

        // [2-3]: For actual_amount handle (critical for attested decrypt!)
        { pubkey: allowancePda1, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
    ],
    data: instructionData,
});
```

**Key Changes:**
- Added `deriveIncoAllowancePda()` helper to derive workspace PDAs for Inco allowance records
- Now passes **8 total accounts** (4 base + 4 remaining) instead of just 4
- The 4 remaining accounts enable **both** `allow()` CPI calls in the Solana program

### 2. Solana Program Enhancement ([solana/programs/bridge/src/confidential/instructions.rs](solana/programs/bridge/src/confidential/instructions.rs))

Updated `bridge_confidential_out_plaintext()` to also grant allowance on `actual_amount` when 4 remaining accounts are provided:

```rust
// Grant allowance to owner for updated balance
if ctx.remaining_accounts.len() >= 2 {
    allow(cpi_ctx, new_balance.0, true, vault.owner)?;

    // ✅ NEW: Also allow for actual_amount (enables attested decrypt)
    if ctx.remaining_accounts.len() >= 4 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[2].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[3].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, actual_amount.0, true, vault.owner)?;
    }
}
```

**Benefits:**
- Users can now verify bridged amounts via attested decrypt (even in plaintext mode)
- Enables debugging and audit trails
- Consistent with the non-plaintext version (`bridge_confidential_out`)

## Why This Matters

### Before (Broken)

```
User bridges on Solana
  ↓
Program creates handles:
  - new_balance: ✅ allow() granted → user can decrypt their balance
  - actual_amount: ❌ NO allow() → attested decrypt fails!
  ↓
Relayer tries to decrypt bridged amount → ERROR: "Address is not allowed to decrypt this handle"
  ↓
Relayer falls back to demo amount (5 tokens) ❌
```

### After (Fixed)

```
User bridges on Solana
  ↓
Program creates handles:
  - new_balance: ✅ allow() granted → user can decrypt their balance
  - actual_amount: ✅ allow() granted → user can decrypt bridged amount
  ↓
Relayer decrypts actual bridged amount via attested decrypt → SUCCESS ✅
  ↓
Relayer mints real amount on Base (not demo amount) ✅
```

## Remaining Accounts Structure

For `bridge_confidential_out` / `bridge_confidential_out_plaintext`:

| Index | Account | Purpose |
|-------|---------|---------|
| **Base Accounts** | | |
| 0 | owner (signer) | Transaction signer |
| 1 | vault (mut) | User's confidential vault |
| 2 | inco_lightning_program | Inco TEE program |
| 3 | system_program | System program |
| **Remaining Accounts** | | |
| 4 (0) | allowance_pda_0 (mut) | Allowance record for new_balance |
| 5 (1) | owner | Allowed address for new_balance |
| 6 (2) | allowance_pda_1 (mut) | Allowance record for actual_amount ✅ |
| 7 (3) | owner | Allowed address for actual_amount ✅ |

## Testing

After this fix:

1. **Build and redeploy** the Solana program:
   ```bash
   cd solana
   bun run program:build devnet-alpha
   bun run program:deploy devnet-alpha
   ```

2. **Test the privacy bridge flow**:
   ```bash
   cd scripts
   EVM_PRIVATE_KEY=0x... bun run src/privacy-relayer-sol-to-base.ts --monitor
   ```

3. **Bridge tokens from frontend**:
   - The relayer should now successfully decrypt the real bridged amount
   - No more "demo fallback amount" warnings

## References

- Solana Program: [solana/programs/bridge/src/confidential/instructions.rs](solana/programs/bridge/src/confidential/instructions.rs) (lines 90-115)
- Frontend Client: [frontend/src/lib/solana.ts](frontend/src/lib/solana.ts) (lines 212-290)
- Related Issue: [CLAUDE.md](CLAUDE.md) "Known Issue: Solana→Base Attested Decrypt ACL"
