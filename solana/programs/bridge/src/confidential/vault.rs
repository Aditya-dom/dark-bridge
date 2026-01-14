//! Confidential vault account for storing encrypted token balances.

use anchor_lang::prelude::*;
use inco_lightning::types::Euint128;

/// Confidential vault that holds encrypted token balances.
///
/// This account stores an encrypted balance using Inco's Euint128 type,
/// which is a 128-bit handle to encrypted data stored off-chain by the covalidator.
#[account]
pub struct ConfidentialVault {
    /// The owner of this vault (can authorize transfers out).
    pub owner: Pubkey,

    /// The SPL token mint this vault tracks.
    pub token_mint: Pubkey,

    /// Encrypted balance handle (Euint128).
    /// This is a reference to the encrypted value stored off-chain.
    pub encrypted_balance: Euint128,

    /// Authority that can bridge tokens (the bridge program).
    pub bridge_authority: Pubkey,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl ConfidentialVault {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"confidential_vault";

    /// Account size in bytes.
    pub const SIZE: usize = 8 + // discriminator
        32 + // owner
        32 + // token_mint
        16 + // encrypted_balance (Euint128 is u128 = 16 bytes)
        32 + // bridge_authority
        1;   // bump

    /// Derive the vault PDA for a given owner and mint.
    pub fn derive_pda(owner: &Pubkey, token_mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[Self::SEED_PREFIX, owner.as_ref(), token_mint.as_ref()],
            program_id,
        )
    }
}

/// Account for tracking confidential bridge messages.
#[account]
pub struct ConfidentialBridgeMessage {
    /// Unique nonce for this message.
    pub nonce: u64,

    /// The EVM address of the sender on Base.
    pub base_sender: [u8; 20],

    /// The Solana recipient pubkey.
    pub solana_recipient: Pubkey,

    /// Encrypted amount handle.
    pub encrypted_amount: Euint128,

    /// Whether this message has been processed.
    pub processed: bool,

    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl ConfidentialBridgeMessage {
    /// Seed prefix for PDA derivation.
    pub const SEED_PREFIX: &'static [u8] = b"conf_bridge_msg";

    /// Account size in bytes.
    pub const SIZE: usize = 8 + // discriminator
        8 +  // nonce
        20 + // base_sender
        32 + // solana_recipient
        16 + // encrypted_amount
        1 +  // processed
        1;   // bump
}
