use crate::consts::{ADMIN_ADDRESS, CLAIMER_STATE_SEED};
use crate::err::DbcSwapError;
use crate::global_state::ClaimerState;
use anchor_lang::prelude::*;

pub fn handle(ctx: Context<SetClaimerEnabled>, is_enabled: bool) -> Result<()> {
    ctx.accounts.claimer_state.is_enabled = is_enabled;
    Ok(())
}

#[derive(Accounts)]
pub struct SetClaimerEnabled<'info> {
    #[account(
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    /// CHECK: seed only — the claimer whose toggle we're flipping
    pub claimer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CLAIMER_STATE_SEED, pool.key().as_ref(), claimer.key().as_ref()],
        bump = claimer_state.bump,
        constraint = claimer_state.pool == pool.key() @ DbcSwapError::Unauthorized,
        constraint = claimer_state.claimer == claimer.key() @ DbcSwapError::Unauthorized,
    )]
    pub claimer_state: Account<'info, ClaimerState>,
}
