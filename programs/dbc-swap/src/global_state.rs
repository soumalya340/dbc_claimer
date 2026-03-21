use anchor_lang::prelude::*;

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
}
