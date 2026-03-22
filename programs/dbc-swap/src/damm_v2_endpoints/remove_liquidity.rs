use crate::consts::{FEE_CLAIMER_SEED, LIQUIDITY_REMOVAL_AUTHORITY};
use crate::err::DbcSwapError;
use crate::events::LiquidityRemoved;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use damm_v2::cp_amm;

/// Admin-only — removes liquidity from a cp_amm pool position.
///
/// The fee_claimer PDA must own the position NFT. Withdrawn tokens
/// are sent to the provided destination accounts.
pub fn handle<'info>(
    ctx: Context<'_, '_, '_, 'info, RemoveLiquidity<'info>>,
    params: cp_amm::types::RemoveLiquidityParameters,
) -> Result<()> {
    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    let cpi_accounts = cp_amm::cpi::accounts::RemoveLiquidity {
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        position: ctx.accounts.position.to_account_info(),
        token_a_account: ctx.accounts.token_a_account.to_account_info(),
        token_b_account: ctx.accounts.token_b_account.to_account_info(),
        token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
        token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
        token_a_mint: ctx.accounts.token_a_mint.to_account_info(),
        token_b_mint: ctx.accounts.token_b_mint.to_account_info(),
        position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
        owner: ctx.accounts.fee_claimer.to_account_info(),
        token_a_program: ctx.accounts.token_a_program.to_account_info(),
        token_b_program: ctx.accounts.token_b_program.to_account_info(),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        program: ctx.accounts.cp_amm_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.cp_amm_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );

    cp_amm::cpi::remove_liquidity(cpi_ctx, params)?;

    emit!(LiquidityRemoved {
        pool: ctx.accounts.pool.key(),
        admin: ctx.accounts.admin.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(
        address = LIQUIDITY_REMOVAL_AUTHORITY @ DbcSwapError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// CHECK: Pool authority of the cp_amm program
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: cp_amm pool state
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: cp_amm position state
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Admin's token A account — withdrawn liquidity goes here
    #[account(mut, token::authority = admin)]
    pub token_a_account: InterfaceAccount<'info, TokenAccount>,

    /// Admin's token B account — withdrawn liquidity goes here
    #[account(mut, token::authority = admin)]
    pub token_b_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Token A vault of the cp_amm pool
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Token B vault of the cp_amm pool
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: Token A mint
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: Token B mint
    pub token_b_mint: UncheckedAccount<'info>,

    /// CHECK: Position NFT token account — owned by fee_claimer PDA
    pub position_nft_account: UncheckedAccount<'info>,

    /// PDA signer — acts as the position owner for the CPI
    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    /// CHECK: Token A program
    pub token_a_program: UncheckedAccount<'info>,

    /// CHECK: Token B program
    pub token_b_program: UncheckedAccount<'info>,

    /// CHECK: Event authority PDA of the cp_amm program
    pub event_authority: UncheckedAccount<'info>,

    #[account(address = cp_amm::ID)]
    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,
}
