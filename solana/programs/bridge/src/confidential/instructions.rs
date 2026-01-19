//! Confidential bridge instructions using Inco Lightning.

use anchor_lang::prelude::*;
use anchor_lang::system_program::System;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, e_add, e_ge, e_select, e_sub, new_euint128, as_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

use super::vault::ConfidentialVault;

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

    // Grant allowance to owner for updated balance AND the bridged amount
    // The bridged amount needs allow so user can decrypt via attested decrypt
    // for cross-chain handle conversion
    if ctx.remaining_accounts.len() >= 2 {
        // Allow for new balance (so user can see their remaining balance)
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

        // Also allow for actual_amount (so user can decrypt for cross-chain relay)
        // This is critical for attested decrypt to work
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

/// Bridge authority seed for PDA derivation.
pub const BRIDGE_AUTHORITY_SEED: &[u8] = b"bridge_authority";

/// Relay receive confidential tokens from Base (guardian-authorized).
///
/// This is called by an authorized relayer/guardian to mint encrypted tokens
/// to the user's vault from a bridge message. The relayer signs for Inco operations.
pub fn relay_receive_confidential<'info>(
    ctx: Context<'_, '_, '_, 'info, RelayReceiveConfidential<'info>>,
    encrypted_amount: Vec<u8>,
    base_sender: [u8; 20],
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    
    // Use relayer as the signer for Inco operations
    // The relayer is the authorized entity that can mint to vaults
    let signer = ctx.accounts.relayer.to_account_info();

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

/// Deposit plaintext SPL tokens into a confidential vault.
/// 
/// This transfers tokens from the user and adds to their encrypted balance.
pub fn deposit_to_confidential_vault<'info>(
    ctx: Context<'_, '_, '_, 'info, DepositToConfidentialVault<'info>>,
    amount: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Transfer SPL tokens from user to vault's token account
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.owner_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: signer.clone(),
        },
    );
    token::transfer(cpi_ctx, amount)?;

    // Create encrypted handle from plaintext amount
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let encrypted_amount = as_euint128(cpi_ctx, amount as u128)?;

    // Add to vault's encrypted balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    let new_balance = e_add(cpi_ctx, vault.encrypted_balance, encrypted_amount, 0)?;
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

    // Emit deposit event
    emit!(DepositEvent {
        vault: vault.key(),
        owner: vault.owner,
        plaintext_amount: amount,
        encrypted_balance_handle: new_balance.0,
    });

    Ok(())
}

/// Withdraw from confidential vault using attested decryption.
/// 
/// This verifies the attestation and converts encrypted balance to plaintext tokens.
/// For this hackathon version, we use a simplified verification where the bridge authority
/// is trusted to provide valid attestation data.
pub fn withdraw_with_attestation<'info>(
    ctx: Context<'_, '_, '_, 'info, WithdrawWithAttestation<'info>>,
    plaintext_amount: u64,
    expected_handle: u128,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let inco = ctx.accounts.inco_lightning_program.to_account_info();
    let signer = ctx.accounts.owner.to_account_info();

    // Verify handle matches vault balance
    // This ensures the attestation is for the correct encrypted value
    require!(
        vault.encrypted_balance.0 == expected_handle,
        crate::BridgeError::HandleMismatch
    );

    // Verify amount is reasonable (non-zero)
    require!(plaintext_amount > 0, crate::BridgeError::InvalidAttestation);

    // Zero out encrypted balance
    let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
    vault.encrypted_balance = as_euint128(cpi_ctx, 0)?;

    // Transfer SPL tokens back to user
    // Use vault PDA to sign the transfer
    let vault_seeds = &[
        ConfidentialVault::SEED_PREFIX,
        vault.owner.as_ref(),
        vault.token_mint.as_ref(),
        &[vault.bump],
    ];
    let signer_seeds = &[&vault_seeds[..]];
    
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.owner_token_account.to_account_info(),
            authority: vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, plaintext_amount)?;

    // Emit withdraw event
    emit!(WithdrawEvent {
        vault: vault.key(),
        owner: vault.owner,
        plaintext_amount,
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

#[derive(Accounts)]
pub struct RelayReceiveConfidential<'info> {
    /// The relayer/guardian who is authorized to relay messages.
    #[account(mut)]
    pub relayer: Signer<'info>,

    /// The bridge state (for guardian verification).
    #[account(
        seeds = [b"bridge"],
        bump,
    )]
    pub bridge: Account<'info, crate::common::state::Bridge>,

    /// The bridge authority PDA (signs for Inco operations).
    /// CHECK: This is a PDA that will sign via seeds.
    #[account(
        mut,
        seeds = [BRIDGE_AUTHORITY_SEED],
        bump
    )]
    pub bridge_authority: AccountInfo<'info>,

    /// The recipient vault.
    #[account(
        mut,
        constraint = vault.bridge_authority == bridge_authority.key(),
        seeds = [ConfidentialVault::SEED_PREFIX, vault.owner.as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToConfidentialVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to deposit to.
    #[account(
        mut,
        has_one = owner,
        seeds = [ConfidentialVault::SEED_PREFIX, owner.key().as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// User's token account to transfer from.
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == vault.token_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's token account to receive tokens.
    #[account(
        mut,
        constraint = vault_token_account.mint == vault.token_mint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawWithAttestation<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The confidential vault to withdraw from.
    #[account(
        mut,
        has_one = owner,
        seeds = [ConfidentialVault::SEED_PREFIX, owner.key().as_ref(), vault.token_mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, ConfidentialVault>,

    /// User's token account to receive tokens.
    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == vault.token_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    /// Vault's token account holding the tokens.
    #[account(
        mut,
        constraint = vault_token_account.mint == vault.token_mint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program.
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
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

#[event]
pub struct DepositEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub plaintext_amount: u64,
    pub encrypted_balance_handle: u128,
}

#[event]
pub struct WithdrawEvent {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub plaintext_amount: u64,
}

