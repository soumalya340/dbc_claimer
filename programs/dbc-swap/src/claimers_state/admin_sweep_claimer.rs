use crate::consts::{ADMIN_ADDRESS, CLAIMER_STATE_SEED, FEE_CLAIMER_SEED, FEE_VAULT_SEED};
use crate::err::DbcSwapError;
use crate::global_state::ClaimerState;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub fn handle(ctx: Context<AdminSweepClaimer>) -> Result<()> {
    let pending_base = ctx.accounts.claimer_state.pending_base;
    let pending_quote = ctx.accounts.claimer_state.pending_quote;

    require!(
        pending_base > 0 || pending_quote > 0,
        DbcSwapError::NothingToClaim
    );

    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    if pending_base > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_base_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.base_fee_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.destination_base_ata.to_account_info(),
                    authority: ctx.accounts.fee_claimer.to_account_info(),
                },
                signer_seeds,
            ),
            pending_base,
            ctx.accounts.base_mint.decimals,
        )?;
        ctx.accounts.claimer_state.pending_base = 0;
    }

    if pending_quote > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_quote_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.quote_fee_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.destination_quote_ata.to_account_info(),
                    authority: ctx.accounts.fee_claimer.to_account_info(),
                },
                signer_seeds,
            ),
            pending_quote,
            ctx.accounts.quote_mint.decimals,
        )?;
        ctx.accounts.claimer_state.pending_quote = 0;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct AdminSweepClaimer<'info> {
    #[account(
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    /// CHECK: seed only
    pub claimer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CLAIMER_STATE_SEED, pool.key().as_ref(), claimer.key().as_ref()],
        bump = claimer_state.bump,
        constraint = claimer_state.pool == pool.key() @ DbcSwapError::Unauthorized,
        constraint = claimer_state.claimer == claimer.key() @ DbcSwapError::Unauthorized,
    )]
    pub claimer_state: Account<'info, ClaimerState>,

    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = fee_claimer,
        token::token_program = token_base_program,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = fee_claimer,
        token::token_program = token_quote_program,
    )]
    pub quote_fee_vault: InterfaceAccount<'info, TokenAccount>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    /// Destination for base tokens — can be any valid ATA (admin's, another claimer's, etc.)
    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = token_base_program,
    )]
    pub destination_base_ata: InterfaceAccount<'info, TokenAccount>,

    /// Destination for quote tokens
    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_quote_program,
    )]
    pub destination_quote_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}
