use anchor_lang::prelude::*;

/// Which AMM protocol this pool belongs to.
/// `NotInitialized` is the zero-value default — any account that has not yet
/// had `set_pool_claimers` called on it will read as `NotInitialized`.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, PartialEq, Default)]
pub enum PoolState {
    #[default]
    NotInitialized,
    Dbc,
    DammV2,
}

/// Per-pool claimers config — stores up to MAX_CLAIMERS wallets and their
/// respective fee-share in basis points (10000 = 100%).
/// PDA: [POOL_CLAIMERS_SEED, pool_address]
#[account]
#[derive(InitSpace)]
pub struct PoolClaimers {
    pub pool: Pubkey,
    #[max_len(5)]
    pub claimer_addresses: Vec<Pubkey>,
    #[max_len(5)]
    pub claimer_bps: Vec<u16>,
    #[max_len(5)]
    pub claimed_base: Vec<u64>,
    #[max_len(5)]
    pub claimed_quote: Vec<u64>,
    pub bump: u8,
    /// Which AMM this pool is associated with.
    pub pool_state: PoolState,
    /// Unix timestamp (seconds) of the last time fees were claimed or distributed.
    pub last_claimed: i64,
    /// Unix timestamp (seconds) of the last time fees were distributed.
    pub last_distributed: i64,
}
