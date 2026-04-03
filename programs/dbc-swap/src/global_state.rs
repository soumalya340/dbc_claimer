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
    pub bump: u8,
    pub pool_state: PoolState,
    pub last_claimed: i64,
    pub last_distributed: i64,
}

// global_state.rs (add alongside PoolClaimers)

#[account]
#[derive(InitSpace)]
pub struct ClaimerState {
    pub pool: Pubkey,
    pub claimer: Pubkey,
    pub is_enabled: bool,
    pub pending_base: u64,
    pub pending_quote: u64,
    pub claimed_base: u64,
    pub claimed_quote: u64,
    pub bump: u8,
}
