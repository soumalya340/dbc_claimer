use crate::consts::{FEE_CLAIMER_SEED, FEE_VAULT_SEED, POOL_CLAIMERS_SEED};
use crate::events::PartnerFeesClaimed;
use crate::global_state::PoolClaimers;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use dbc::dynamic_bonding_curve;

// -----------------------------------------------------------------------
// Fee vault: sweep fees from DBC into PDA-owned vaults
// -----------------------------------------------------------------------

/// Permissionless — anyone can call this to pull accrued partner trading
/// fees from the DBC pool into this program's PDA-owned fee vaults.
///
/// Prerequisites:
///   • The DBC config must have been created with `feeClaimer` set to the
///     `fee_claimer` PDA of this program:
///       PublicKey.findProgramAddressSync([b"fee_claimer"], PROGRAM_ID)
///   • `base_fee_vault` and `quote_fee_vault` are created automatically on
///     first call (init_if_needed).
pub fn handle<'info>(
    ctx: Context<'_, '_, '_, 'info, ClaimPartnerTradingFee<'info>>,
    max_amount_a: u64,
    max_amount_b: u64,
) -> Result<()> {
    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    let cpi_accounts = dynamic_bonding_curve::cpi::accounts::ClaimTradingFee {
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        // fees land in the program's PDA-owned vaults, not an external wallet
        token_a_account: ctx.accounts.base_fee_vault.to_account_info(),
        token_b_account: ctx.accounts.quote_fee_vault.to_account_info(),
        base_vault: ctx.accounts.base_pool_vault.to_account_info(),
        quote_vault: ctx.accounts.quote_pool_vault.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        fee_claimer: ctx.accounts.fee_claimer.to_account_info(),
        token_base_program: ctx.accounts.token_base_program.to_account_info(),
        token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        program: ctx.accounts.dbc_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.dbc_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );

    dynamic_bonding_curve::cpi::claim_trading_fee(cpi_ctx, max_amount_a, max_amount_b)?;

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool_claimers.last_claimed = now;

    emit!(PartnerFeesClaimed {
        pool: ctx.accounts.pool.key(),
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPartnerTradingFee<'info> {
    /// CHECK: Pool authority PDA of the DBC program
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: DBC config — feeClaimer must equal the fee_claimer PDA below
    pub config: UncheckedAccount<'info>,

    /// CHECK: DBC pool state
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// Per-pool claimers config — last_claimed is stamped after each successful claim.
    #[account(
        mut,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump = pool_claimers.bump,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    /// Per-pool PDA-owned vault that accumulates base token fees.
    /// Created on first call (init_if_needed).
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = base_mint,
        token::authority = fee_claimer,
        token::token_program = token_base_program,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// Per-pool PDA-owned vault that accumulates quote token fees.
    #[account(
        init_if_needed,
        payer = payer,
        token::mint = quote_mint,
        token::authority = fee_claimer,
        token::token_program = token_quote_program,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), quote_mint.key().as_ref()],
        bump,
    )]
    pub quote_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Base token vault of the DBC pool (source of fees)
    #[account(mut)]
    pub base_pool_vault: UncheckedAccount<'info>,

    /// CHECK: Quote token vault of the DBC pool (source of fees)
    #[account(mut)]
    pub quote_pool_vault: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    /// PDA of this program — registered as feeClaimer in the DBC config.
    /// Derive off-chain:
    ///   PublicKey.findProgramAddressSync([Buffer.from("fee_claimer")], PROGRAM_ID)
    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,

    /// CHECK: Event authority PDA of the DBC program
    pub event_authority: UncheckedAccount<'info>,

    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,

    /// Pays rent for vault account creation on the first call.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
