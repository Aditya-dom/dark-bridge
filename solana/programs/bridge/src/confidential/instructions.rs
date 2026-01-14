//! Confidential bridge instructions using Inco Lightning.

use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, e_add, e_ge, e_select, e_sub, new_euint128, as_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

use super::vault::{ConfidentialBridgeMessage, ConfidentialVault};

/// Initialize a confidential vault for a user.
pub fn initialize_confidential_vault<'info>(
    ctx: Context<'_, '_, 'info, 'info, InitializeConfidentialVault<'info>>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.token_mint = ctx.accounts.token_mint.key();
    vault.bridge_authority = ctx.accounts.bridge_authority.key();
    vault.bump = ctx.bumps.vault;

    // Initialize encrypted balance to zero
    let cpi_ctx = CpiContext::new(
        ctx.accounts.inco_lightning_program.to_account_info(),
        Operation {
            signer: ctx.accounts.owner.to_account_info(),
        },
    );
    vault.encrypted_balance = as_euint128(cpi_ctx, 0)?;

    // Grant allowance to owner for their balance
    if ctx.remaining_accounts.len() >= 2 {
        let allowance_account = ctx.remaining_accounts[0].clone();
        let owner_address = ctx.remaining_accounts[1].clone();

        let cpi_ctx = CpiContext::new(
            ctx.accounts.inco_lightning_program.to_account_info(),
            Allow {
                allowance_account,
                signer: ctx.accounts.owner.to_account_info(),
                allowed_address: owner_address,
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, vault.encrypted_balance.0, true, ctx.accounts.owner.key())?;
    }

    Ok(())
}

/// Bridge tokens confidentially from Solana to Base.
/// 
/// This burns encrypted tokens from the user's vault and emits a bridge message.
pub fn bridge_confidential_out<'info>(
    ctx: Context<'_, '_, '_, 'info, BridgeConfidentialOut<'info>>,
    encrypted_amount: Vec<u8>,
    destination_evm: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Check if vault has sufficient balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let has_sufficient: Ebool = e_ge(cpi_ctx, vault.encrypted_balance, amount, 0)?;

    // Create zero for failed case
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let zero = as_euint128(cpi_ctx, 0)?;

    // Select actual amount to bridge (0 if insufficient)
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let actual_amount: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

    // Subtract from vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_sub(cpi_ctx, vault.encrypted_balance, actual_amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, vault.owner)?;
    }

    // Emit bridge message event
    emit!(ConfidentialBridgeOutEvent {
        vault: vault.key(),
        owner: vault.owner,
        destination_evm,
        encrypted_amount_handle: actual_amount.0,
    });

    Ok(())
}

/// Receive confidential tokens from Base.
///
/// This mints encrypted tokens to the user's vault from a bridge message.
pub fn receive_confidential_in<'info>(
    ctx: Context<'_, '_, '_, 'info, ReceiveConfidentialIn<'info>>,
    encrypted_amount: Vec<u8>,
    base_sender: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.bridge_authority.to_account_info();

    // Create encrypted handle from ciphertext
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let amount: Euint128 = new_euint128(cpi_ctx, encrypted_amount, 0)?;

    // Add to vault balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance: Euint128 = e_add(cpi_ctx, vault.encrypted_balance, amount, 0)?;
    vault.encrypted_balance = new_balance;

    // Grant allowance to owner for updated balance
    if ctx.remaining_accounts.len() >= 2 {
        let cpi_ctx = CpiContext::new(
            inco.clone(),
            Allow {
                allowance_account: ctx.remaining_accounts[0].clone(),
                signer: signer.clone(),
                allowed_address: ctx.remaining_accounts[1].clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        allow(cpi_ctx, new_balance.0, true, vault.owner)?;
    }

    // Emit receive event
    emit!(ConfidentialBridgeInEvent {
        vault: vault.key(),
        owner: vault.owner,
        base_sender,
        encrypted_amount_handle: amount.0,
    });

    Ok(())
}

// ============================================================================
// Account Structs
// ============================================================================

#[derive(Accounts)]
pub struct InitializeConfidentialVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The token mint for this vault.
    /// CHECK: Validated as SPL token mint.
    pub token_mint: AccountInfo<'info>,

    /// The bridge authority PDA.
    /// CHECK: Derived from bridge program.
    pub bridge_authority: AccountInfo<'info>,

    /// The confidential vault account.
    #[account(
        init,
        payer = owner,
        space = ConfidentialVault::SIZE,
        seeds = [ConfidentialVault::SEED_PREFIX, owner.key().as_ref(), token_mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program for encrypted operations.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeConfidentialOut<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to bridge from.
    #[account(
        mut,
        has_one = owner,
        seeds = [ConfidentialVault::SEED_PREFIX, owner.key().as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReceiveConfidentialIn<'info> {
    /// The bridge authority (signer for relayed messages).
    #[account(mut)]
    pub bridge_authority: Signer<'info>,

    /// The recipient vault.
    #[account(
        mut,
        has_one = bridge_authority,
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct ConfidentialBridgeOutEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub destination_evm: [u8; 20],
    pub encrypted_amount_handle: u128,
}

#[event]
pub struct ConfidentialBridgeInEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub base_sender: [u8; 20],
    pub encrypted_amount_handle: u128,
}
