use crate::consts::{FEE_CLAIMER_SEED, FEE_VAULT_SEED, POOL_CLAIMERS_SEED};
use crate::err::DbcSwapError;
use crate::global_state::PoolClaimers;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// -----------------------------------------------------------------------
// Fee vault: admin withdraws accumulated fees to any recipient
// -----------------------------------------------------------------------

/// Claimer-gated — any address listed in the pool's PoolClaimers account
/// can withdraw their BPS share of the per-pool fee vault balance.
///
/// The caller must be in `pool_claimers.claimer_addresses`. Their max
/// withdrawal is `vault_balance * claimer_bps / 10_000` for each token.
/// 
/// 
pub fn withdraw_from_fee_vault(
    ctx: Context<WithdrawFromFeeVault>,
    base_amount: u64,
    quote_amount: u64,
) -> Result<()> {
    let claimer_key = ctx.accounts.claimer.key();
    let pc = &ctx.accounts.pool_claimers;

    // Find the caller in the claimer list
    let claimer_index = pc
        .claimer_addresses
        .iter()
        .position(|addr| addr == &claimer_key)
        .ok_or(error!(DbcSwapError::ClaimerNotFound))?;

    let claimer_bps = pc.claimer_bps[claimer_index] as u64;

    // Reconstruct total fees = current vault balance + everything already withdrawn
    let base_vault_balance = ctx.accounts.base_fee_vault.amount;
    let quote_vault_balance = ctx.accounts.quote_fee_vault.amount;

    let total_claimed_base: u64 = pc.claimed_base.iter().sum();
    let total_claimed_quote: u64 = pc.claimed_quote.iter().sum();

    let total_base = base_vault_balance
        .checked_add(total_claimed_base)
        .unwrap_or(0);
    let total_quote = quote_vault_balance
        .checked_add(total_claimed_quote)
        .unwrap_or(0);

    // Claimer's entitlement from the total, minus what they've already withdrawn
    let entitlement_base = total_base
        .checked_mul(claimer_bps)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0);
    let entitlement_quote = total_quote
        .checked_mul(claimer_bps)
        .and_then(|v| v.checked_div(10_000))
        .unwrap_or(0);

    let already_claimed_base = pc.claimed_base[claimer_index];
    let already_claimed_quote = pc.claimed_quote[claimer_index];

    let max_base = entitlement_base.saturating_sub(already_claimed_base);
    let max_quote = entitlement_quote.saturating_sub(already_claimed_quote);

    let actual_base = base_amount.min(max_base);
    let actual_quote = quote_amount.min(max_quote);

    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    if actual_base > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_base_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.base_fee_vault.to_account_info(),
                    mint: ctx.accounts.base_mint.to_account_info(),
                    to: ctx.accounts.recipient_base_account.to_account_info(),
                    authority: ctx.accounts.fee_claimer.to_account_info(),
                },
                signer_seeds,
            ),
            actual_base,
            ctx.accounts.base_mint.decimals,
        )?;
    }

    if actual_quote > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_quote_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.quote_fee_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.recipient_quote_account.to_account_info(),
                    authority: ctx.accounts.fee_claimer.to_account_info(),
                },
                signer_seeds,
            ),
            actual_quote,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

    // Update per-claimer withdrawal tracking
    let pc = &mut ctx.accounts.pool_claimers;
    pc.claimed_base[claimer_index] = pc.claimed_base[claimer_index]
        .checked_add(actual_base)
        .unwrap();
    pc.claimed_quote[claimer_index] = pc.claimed_quote[claimer_index]
        .checked_add(actual_quote)
        .unwrap();

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFromFeeVault<'info> {
    /// The wallet claiming fees — must be in pool_claimers.claimer_addresses.
    pub claimer: Signer<'info>,

    /// CHECK: The DBC pool address — used only as a seed for vault + claimers PDAs.
    pub pool: UncheckedAccount<'info>,

    /// Per-pool claimers config — checked to authorize the caller.
    #[account(
        mut,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump = pool_claimers.bump,
        constraint = pool_claimers.pool == pool.key() @ DbcSwapError::Unauthorized,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    /// Per-pool PDA base fee vault (source)
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = fee_claimer,
        token::token_program = token_base_program,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// Per-pool PDA quote fee vault (source)
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = fee_claimer,
        token::token_program = token_quote_program,
    )]
    pub quote_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// Recipient token account for base tokens
    #[account(mut)]
    pub recipient_base_account: InterfaceAccount<'info, TokenAccount>,

    /// Recipient token account for quote tokens
    #[account(mut)]
    pub recipient_quote_account: InterfaceAccount<'info, TokenAccount>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    /// PDA signer — same as the feeClaimer registered in DBC config
    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}
