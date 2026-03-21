use crate::consts::{FEE_CLAIMER_SEED, FEE_VAULT_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use damm_v2::cp_amm;

/// Permissionless — anyone can call to claim position fees from the cp_amm
/// pool into this program's PDA-owned fee vaults.
///
/// The fee_claimer PDA must own the position NFT. Claimed fees accumulate
/// in the per-pool fee vaults, from which registered claimers withdraw
/// their BPS shares via `withdraw_from_fee_vault`.
pub fn handle<'info>(ctx: Context<'_, '_, '_, 'info, ClaimPositionFee<'info>>) -> Result<()> {
    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    let cpi_accounts = cp_amm::cpi::accounts::ClaimPositionFee {
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        position: ctx.accounts.position.to_account_info(),
        token_a_account: ctx.accounts.base_fee_vault.to_account_info(),
        token_b_account: ctx.accounts.quote_fee_vault.to_account_info(),
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

    cp_amm::cpi::claim_position_fee(cpi_ctx)
}

#[derive(Accounts)]
pub struct ClaimPositionFee<'info> {
    /// CHECK: Pool authority of the cp_amm program
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: cp_amm pool state
    pub pool: UncheckedAccount<'info>,

    /// CHECK: cp_amm position state
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Per-pool PDA-owned vault that accumulates token A fees.
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = token_a_mint,
        token::authority = fee_claimer,
        token::token_program = token_a_program,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), token_a_mint.key().as_ref()],
        bump,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// Per-pool PDA-owned vault that accumulates token B fees.
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = token_b_mint,
        token::authority = fee_claimer,
        token::token_program = token_b_program,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), token_b_mint.key().as_ref()],
        bump,
    )]
    pub quote_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Token A vault of the cp_amm pool (source of fees)
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: Token B vault of the cp_amm pool (source of fees)
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    pub token_a_mint: InterfaceAccount<'info, Mint>,
    pub token_b_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Position NFT token account — must be owned by fee_claimer PDA
    pub position_nft_account: UncheckedAccount<'info>,

    /// PDA signer — acts as the position owner for the CPI.
    /// The position NFT must be held in a token account with this PDA as authority.
    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_a_program: Interface<'info, TokenInterface>,
    pub token_b_program: Interface<'info, TokenInterface>,

    /// CHECK: Event authority PDA of the cp_amm program
    pub event_authority: UncheckedAccount<'info>,

    #[account(address = cp_amm::ID)]
    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,

    /// Pays rent for vault account creation on the first call.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
