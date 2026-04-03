use crate::consts::{
    ADMIN_ADDRESS, CLAIMER_PENDING_BASE_SEED, CLAIMER_PENDING_QUOTE_SEED, CLAIMER_STATE_SEED,
};
use crate::err::DbcSwapError;
use crate::global_state::ClaimerState;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub fn handle(ctx: Context<AdminSweepClaimer>) -> Result<()> {
    let pending_base = ctx.accounts.claimer_pending_base_vault.amount;
    let pending_quote = ctx.accounts.claimer_pending_quote_vault.amount;

    require!(
        pending_base > 0 || pending_quote > 0,
        DbcSwapError::NothingToClaim
    );

    let pool_key = ctx.accounts.pool.key();
    let claimer_key = ctx.accounts.claimer.key();
    let state_bump = ctx.accounts.claimer_state.bump;

    let signer_seeds: &[&[&[u8]]] = &[&[
        CLAIMER_STATE_SEED,
        pool_key.as_ref(),
        claimer_key.as_ref(),
        &[state_bump],
    ]];

    if pending_base > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_base_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.claimer_pending_base_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.destination_base_ata.to_account_info(),
                    authority: ctx.accounts.claimer_state.to_account_info(),
                },
                signer_seeds,
            ),
            pending_base,
            ctx.accounts.base_mint.decimals,
        )?;
    }

    if pending_quote > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_quote_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.claimer_pending_quote_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.destination_quote_ata.to_account_info(),
                    authority: ctx.accounts.claimer_state.to_account_info(),
                },
                signer_seeds,
            ),
            pending_quote,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct AdminSweepClaimer<'info> {
    #[account(address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized)]
    pub admin: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    /// CHECK: seed only
    pub claimer: UncheckedAccount<'info>,

    #[account(
        seeds = [CLAIMER_STATE_SEED, pool.key().as_ref(), claimer.key().as_ref()],
        bump = claimer_state.bump,
        constraint = claimer_state.pool == pool.key() @ DbcSwapError::Unauthorized,
        constraint = claimer_state.claimer == claimer.key() @ DbcSwapError::Unauthorized,
    )]
    pub claimer_state: Account<'info, ClaimerState>,

    #[account(
        mut,
        seeds = [CLAIMER_PENDING_BASE_SEED, pool.key().as_ref(), claimer.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = claimer_state,
        token::token_program = token_base_program,
    )]
    pub claimer_pending_base_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [CLAIMER_PENDING_QUOTE_SEED, pool.key().as_ref(), claimer.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = claimer_state,
        token::token_program = token_quote_program,
    )]
    pub claimer_pending_quote_vault: InterfaceAccount<'info, TokenAccount>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = base_mint,
        token::token_program = token_base_program,
    )]
    pub destination_base_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::token_program = token_quote_program,
    )]
    pub destination_quote_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}
