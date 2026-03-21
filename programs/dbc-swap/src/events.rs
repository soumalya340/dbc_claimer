use crate::global_state::PoolState;
use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// Admin / config events
// ---------------------------------------------------------------------------

/// Emitted when the full claimer list for a pool is set or replaced.
#[event]
pub struct PoolClaimersSet {
    pub pool: Pubkey,
    pub claimer_addresses: Vec<Pubkey>,
    pub claimer_bps: Vec<u16>,
    pub pool_state: PoolState,
    pub timestamp: i64,
}

/// Emitted when only the BPS shares are updated without touching addresses.
#[event]
pub struct ClaimersBpsUpdated {
    pub pool: Pubkey,
    pub new_bps: Vec<u16>,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// DBC path events
// ---------------------------------------------------------------------------

/// Emitted when partner trading fees are swept from the DBC pool into vaults.
#[event]
pub struct PartnerFeesClaimed {
    pub pool: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a single claimer withdraws their BPS share from the DBC fee vault.
#[event]
pub struct FeesDistributedDbc {
    pub pool: Pubkey,
    pub claimer: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub timestamp: i64,
}

// ---------------------------------------------------------------------------
// DAMM v2 path events
// ---------------------------------------------------------------------------

/// Emitted when position fees are claimed from the cp_amm pool into vaults.
#[event]
pub struct PositionFeeClaimed {
    pub pool: Pubkey,
    pub timestamp: i64,
}

/// Emitted when the full vault balance is pushed out to all claimers at once.
#[event]
pub struct FeesDistributedDammV2 {
    pub pool: Pubkey,
    pub total_base_distributed: u64,
    pub total_quote_distributed: u64,
    pub timestamp: i64,
}

/// Emitted when a partial liquidity removal is executed on a cp_amm position.
#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub timestamp: i64,
}

/// Emitted when all liquidity is removed from a cp_amm position.
#[event]
pub struct AllLiquidityRemoved {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub token_a_threshold: u64,
    pub token_b_threshold: u64,
    pub timestamp: i64,
}
