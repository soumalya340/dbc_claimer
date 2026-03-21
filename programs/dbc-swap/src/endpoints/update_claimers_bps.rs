use crate::consts::{ADMIN_ADDRESS, POOL_CLAIMERS_SEED};
use crate::err::DbcSwapError;
use crate::global_state::PoolClaimers;
use anchor_lang::prelude::*;

/// Admin-only — updates only the BPS shares of the existing claimer list for
/// a pool, without touching claimer addresses or resetting claimed amounts.
///
/// Use this when you need to rebalance the fee split going forward (e.g. a
/// partner's share changes) while preserving the full historical claimed record.
/// If you also need to add/remove claimers, use `set_pool_claimers` instead
/// (note: that instruction resets all claimed amounts to zero).
///
/// Constraints:
///   • Caller must be ADMIN_ADDRESS
///   • `pool_claimers` account must already exist (initialized via `set_pool_claimers`)
///   • new_bps.len() must equal the existing number of claimers
///   • sum(new_bps) must equal exactly 10_000 (100%)
pub fn handle(ctx: Context<UpdateClaimersBps>, new_bps: Vec<u16>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.deployer.key(),
        ADMIN_ADDRESS,
        DbcSwapError::Unauthorized
    );

    let pc = &mut ctx.accounts.pool_claimers;

    require!(
        new_bps.len() == pc.claimer_addresses.len(),
        DbcSwapError::ClaimerLengthMismatch
    );

    let total_bps: u32 = new_bps.iter().map(|&b| b as u32).sum();
    require!(total_bps == 10_000, DbcSwapError::InvalidTotalBps);

    pc.claimer_bps = new_bps;

    Ok(())
}

/// Accounts for updating BPS shares on an existing pool claimers config.
/// Only callable by ADMIN_ADDRESS.
#[derive(Accounts)]
pub struct UpdateClaimersBps<'info> {
    #[account(
        mut,
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub deployer: Signer<'info>,

    /// CHECK: Used only as a seed to locate the PoolClaimers PDA.
    pub pool: UncheckedAccount<'info>,

    /// Must already be initialized via `set_pool_claimers`.
    /// Only `claimer_bps` is updated — addresses and claimed amounts are untouched.
    #[account(
        mut,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump = pool_claimers.bump,
        constraint = pool_claimers.pool == pool.key() @ DbcSwapError::Unauthorized,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,
}
