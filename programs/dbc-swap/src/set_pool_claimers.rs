use crate::consts::{ADMIN_ADDRESS, ANCHOR_DISCRIMINATOR_SIZE, MAX_CLAIMERS, POOL_CLAIMERS_SEED};
use crate::err::DbcSwapError;
use crate::events::PoolClaimersSet;
use crate::global_state::{PoolClaimers, PoolState};
use anchor_lang::prelude::*;

/// Deployer-only — sets (or replaces) the list of claimers and their
/// basis-point shares for a specific pool address.
///
/// The `pool_claimers` account uses `init_if_needed`, meaning this instruction
/// can be called multiple times to update the claimer list and BPS shares for
/// an existing pool. Each call fully overwrites the previous configuration and
/// resets all claimed amounts to zero.
///
/// Constraints:
///   • Caller must be ADMIN_ADDRESS
///   • claimer_addresses.len() == claimer_bps.len()
///   • len() <= MAX_CLAIMERS (5)
///   • No duplicate addresses — every address must appear exactly once
///   • sum(claimer_bps) MUST equal exactly 10_000 (100%) — partial splits are not allowed
///   • `pool_state` must be `DBC` or `DAMM_V2` — `NOT_INITIALIZED` is rejected
pub fn handle(
    ctx: Context<SetPoolClaimers>,
    claimer_addresses: Vec<Pubkey>,
    claimer_bps: Vec<u16>,
    pool_state: PoolState,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.deployer.key(),
        ADMIN_ADDRESS,
        DbcSwapError::Unauthorized
    );

    require!(
        pool_state == PoolState::Dbc || pool_state == PoolState::DammV2,
        DbcSwapError::InvalidPoolState
    );

    require!(
        claimer_addresses.len() == claimer_bps.len(),
        DbcSwapError::ClaimerLengthMismatch
    );

    require!(
        claimer_addresses.len() <= MAX_CLAIMERS,
        DbcSwapError::TooManyClaimers
    );

    for i in 0..claimer_addresses.len() {
        for j in (i + 1)..claimer_addresses.len() {
            require!(
                claimer_addresses[i] != claimer_addresses[j],
                DbcSwapError::DuplicateClaimerAddress
            );
        }
    }

    let total_bps: u32 = claimer_bps.iter().map(|&b| b as u32).sum();
    require!(total_bps == 10_000, DbcSwapError::InvalidTotalBps);

    let len = claimer_addresses.len();
    let pc = &mut ctx.accounts.pool_claimers;
    pc.pool = ctx.accounts.pool.key();
    pc.claimer_addresses = claimer_addresses;
    pc.claimer_bps = claimer_bps;
    pc.claimed_base = vec![0u64; len];
    pc.claimed_quote = vec![0u64; len];
    pc.bump = ctx.bumps.pool_claimers;
    pc.pool_state = pool_state;

    let now = Clock::get()?.unix_timestamp;
    emit!(PoolClaimersSet {
        pool: pc.pool,
        claimer_addresses: pc.claimer_addresses.clone(),
        claimer_bps: pc.claimer_bps.clone(),
        pool_state: pc.pool_state.clone(),
        timestamp: now,
    });

    Ok(())
}

/// Accounts for setting (or updating) the claimer list for a specific pool.
/// Only callable by ADMIN_ADDRESS.
#[derive(Accounts)]
pub struct SetPoolClaimers<'info> {
    #[account(
        mut,
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub deployer: Signer<'info>,

    /// CHECK: Used only as a seed for the PoolClaimers PDA; not validated structurally.
    pub pool: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = deployer,
        space = ANCHOR_DISCRIMINATOR_SIZE + PoolClaimers::INIT_SPACE,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    pub system_program: Program<'info, System>,
}
