# Deployment Instructions for Solana to Base Bridge Fix

## Problem Fixed

The frontend was trying to send plaintext amount as ciphertext to the `bridge_confidential_out` instruction, causing deserialization errors. We've added a new instruction `bridge_confidential_out_plaintext` that accepts plaintext amounts and uses trivial encryption (`as_euint128`) on-chain.

## Changes Made

### 1. Solana Program (Rust)
**File:** `solana/programs/bridge/src/confidential/instructions.rs`

Added new function:
```rust
pub fn bridge_confidential_out_plaintext<'info>(
    ctx: Context<'_, '_, '_, 'info, BridgeConfidentialOut<'info>>,
    plaintext_amount: u128,
    destination_evm: [u8; 20],
) -> Result<()>
```

This function:
- Takes plaintext `u128` amount instead of `Vec<u8>` ciphertext
- Uses `as_euint128()` for trivial encryption on-chain
- Same security guarantees as the original function
- Easier to call from JavaScript (no Inco SDK encryption needed)

### 2. Frontend (TypeScript)
**File:** `frontend/src/lib/solana.ts`

Updated `buildBridgeConfidentialOutInstruction`:
- Changed discriminator to `"bridge_confidential_out_plaintext"`
- Removed `Vec<u8>` length prefix
- Sends plaintext amount as 16-byte little-endian `u128`
- Simplified instruction data format

## Deployment Steps

### Step 1: Rebuild Solana Program

```bash
cd solana
anchor build
```

**Expected output:**
```
Compiling bridge v0.1.0 (/Users/gaurav/Downloads/bridge-main/solana)
...
Finished release [optimized] target(s) in XX.XXs
```

### Step 2: Get Program ID

```bash
solana address -k target/deploy/bridge-keypair.json
```

**Should be:** `EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9`

If different, update in:
- `solana/Anchor.toml`
- `frontend/src/lib/constants.ts`
- `services/*/src/index.ts`

### Step 3: Deploy to Devnet

```bash
anchor deploy --provider.cluster devnet
```

**Expected output:**
```
Deploying cluster: https://api.devnet.solana.com
Upgrade authority: YOUR_WALLET_PUBKEY
Deploying program "bridge"...
Program Id: EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9
Deploy success
```

### Step 4: Verify Deployment

```bash
solana program show EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9 --url devnet
```

**Check:**
- Program is deployed
- Upgrade authority matches your wallet
- Data length is reasonable

### Step 5: Restart Frontend

```bash
cd ../frontend
# Clear Next.js cache
rm -rf .next
bun run dev
```

### Step 6: Test Bridge Flow

1. **Connect wallets** (Base + Solana)
2. **Bridge Base → Solana** (1.0 cDARK)
   - Initializes vault if needed
   - Wait for relayer to complete
3. **Verify vault balance**
   - Should show encrypted balance handle
4. **Bridge Solana → Base** (0.5 cDARK)
   - Should now work without deserialization error!
   - Wait for relayer to mint on Base

## Troubleshooting Deployment

### Error: "Insufficient funds"

```bash
# Check SOL balance
solana balance --url devnet

# Get devnet SOL
solana airdrop 2 --url devnet
```

### Error: "Program is not upgradeable"

The program might be immutable. Check:
```bash
solana program show EEMKRm1ANMBZHS6yEi67bKVuZDPhztQHVWBzoFnoVbh9 --url devnet
```

If no upgrade authority, you need to deploy as a new program:
```bash
# Generate new keypair
solana-keygen new -o target/deploy/bridge-new-keypair.json

# Update Anchor.toml with new address
# Then deploy
anchor deploy --provider.cluster devnet
```

### Error: "Anchor build failed"

```bash
# Clean and rebuild
cargo clean
anchor build
```

### Frontend still shows old error

```bash
# Clear browser cache
# Hard refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)

# Clear Next.js cache
cd frontend
rm -rf .next node_modules/.cache
bun run dev
```

## Verification Checklist

After deployment, verify:

- [ ] Solana program deployed successfully
- [ ] Program ID matches in all config files
- [ ] Frontend builds without errors
- [ ] Can initialize Solana vault
- [ ] Can bridge Base → Solana (deposits work)
- [ ] Can bridge Solana → Base (NO deserialization error)
- [ ] Relayer picks up events correctly
- [ ] Tokens minted on Base successfully

## Technical Details

### Instruction Data Format

**Before (broken):**
```
[8 bytes discriminator]
[4 bytes Vec<u8> length]
[16 bytes encrypted_amount]  ← Not real ciphertext!
[20 bytes destination_evm]
```

**After (fixed):**
```
[8 bytes discriminator]
[16 bytes plaintext_amount as u128 LE]
[20 bytes destination_evm]
```

### Why This Works

1. **Trivial Encryption:** Inco's `as_euint128()` converts plaintext to encrypted handle on-chain
2. **Same Security:** Once encrypted via `as_euint128()`, it's protected by Inco TEE
3. **No Client SDK Needed:** No need for @inco/solana-sdk (which has ESM issues)
4. **Simpler UX:** Users just input plaintext amounts

### Security Considerations

- ✅ Amount is encrypted on-chain via Inco TEE
- ✅ Only encrypted handle is stored/emitted
- ⚠️ Plaintext amount visible in transaction logs (before encryption)
- ✅ Final balance and cross-chain transfer use encrypted handles

For maximum privacy, the original `bridge_confidential_out` with client-side encryption would be ideal, but requires proper Solana SDK support.

## Alternative: Use Existing Function

If you cannot redeploy, an alternative is to use the existing encrypted balance handle directly, but this requires more complex logic on the frontend to work with existing handles rather than amounts.

## Next Steps

After successful deployment:

1. **Update documentation** with new program ID (if changed)
2. **Test thoroughly** on devnet
3. **Run relayer** to complete cross-chain flow
4. **Monitor events** for successful bridging
5. **Consider audit** before mainnet deployment

## Support

If you encounter issues:
1. Check Solana program logs: `solana logs --url devnet`
2. Check frontend console for errors
3. Verify all addresses match in config files
4. Review `SOLANA_TO_BASE_GUIDE.md` for troubleshooting
