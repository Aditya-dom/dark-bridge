use anchor_lang::prelude::*;
use inco_lightning::cpi::accounts::{Allow, Operation};
use inco_lightning::cpi::{allow, as_euint128, e_add, e_ge, e_select, e_sub, new_euint128};
use inco_lightning::types::{Ebool, Euint128};
use inco_lightning::ID as INCO_LIGHTNING_ID;

declare_id!("YOUR_PROGRAM_ID_HERE");

#[program]
pub mod confidential_token {
    use super::*;

    /// Initialize a new token account with zero balance
    pub fn initialize<'info>(
        ctx: Context<'_, '_, '_, 'info, Initialize<'info>>,
    ) -> Result<()> {
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.authority.to_account_info();

        // Create encrypted zero balance
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let zero_balance = as_euint128(cpi_ctx, 0)?;

        // Store in account
        ctx.accounts.token_account.owner = ctx.accounts.owner.key();
        ctx.accounts.token_account.balance = zero_balance;

        // Grant owner access to their balance
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
            allow(cpi_ctx, zero_balance.0, true, ctx.accounts.owner.key())?;
        }

        Ok(())
    }

    /// Deposit tokens from encrypted ciphertext
    pub fn deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, Deposit<'info>>,
        ciphertext: Vec<u8>,
    ) -> Result<()> {
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.authority.to_account_info();

        // Convert ciphertext to encrypted handle
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let amount: Euint128 = new_euint128(cpi_ctx, ciphertext, 0)?;

        // Add to existing balance
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let new_balance: Euint128 = e_add(cpi_ctx, ctx.accounts.token_account.balance, amount, 0)?;

        // Update state
        ctx.accounts.token_account.balance = new_balance;

        // Grant access to owner
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
            allow(cpi_ctx, new_balance.0, true, ctx.accounts.token_account.owner)?;
        }

        Ok(())
    }

    /// Transfer tokens between accounts confidentially
    /// 
    /// remaining_accounts layout:
    ///   [0] source_allowance_account (mut)
    ///   [1] source_owner_address (readonly)
    ///   [2] dest_allowance_account (mut)
    ///   [3] dest_owner_address (readonly)
    pub fn transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, Transfer<'info>>,
        amount: Euint128,
    ) -> Result<()> {
        let inco = ctx.accounts.inco_lightning_program.to_account_info();
        let signer = ctx.accounts.authority.to_account_info();

        let source_balance = ctx.accounts.source.balance;
        let dest_balance = ctx.accounts.destination.balance;

        // Check if source has sufficient balance (encrypted comparison)
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let has_sufficient: Ebool = e_ge(cpi_ctx, source_balance, amount, 0)?;

        // Create zero for failed transfer case
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let zero = as_euint128(cpi_ctx, 0)?;

        // Select actual transfer amount: if sufficient, use amount; else use 0
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let actual_amount: Euint128 = e_select(cpi_ctx, has_sufficient, amount, zero, 0)?;

        // Subtract from source
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let new_source_balance: Euint128 = e_sub(cpi_ctx, source_balance, actual_amount, 0)?;

        // Add to destination
        let cpi_ctx = CpiContext::new(inco.clone(), Operation { signer: signer.clone() });
        let new_dest_balance: Euint128 = e_add(cpi_ctx, dest_balance, actual_amount, 0)?;

        // Update balances
        ctx.accounts.source.balance = new_source_balance;
        ctx.accounts.destination.balance = new_dest_balance;

        // Grant access to source owner
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
            allow(cpi_ctx, new_source_balance.0, true, ctx.accounts.source.owner)?;
        }

        // Grant access to destination owner
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
            allow(cpi_ctx, new_dest_balance.0, true, ctx.accounts.destination.owner)?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The owner of the new token account
    /// CHECK: This is the intended owner
    pub owner: AccountInfo<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + TokenAccount::INIT_SPACE
    )]
    pub token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub source: Account<'info, TokenAccount>,

    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    /// CHECK: Inco Lightning program
    #[account(address = INCO_LIGHTNING_ID)]
    pub inco_lightning_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct TokenAccount {
    /// Owner who can transfer and view balance
    pub owner: Pubkey,
    /// Encrypted balance handle
    pub balance: Euint128,
}
