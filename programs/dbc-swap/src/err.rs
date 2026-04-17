use anchor_lang::prelude::*;

#[error_code]
pub enum DbcSwapError {
    #[msg("Unauthorized: caller is not the admin")]
    Unauthorized,
    #[msg("claimer_addresses and claimer_bps must have the same length")]
    ClaimerLengthMismatch,
    #[msg("Number of claimers exceeds the maximum of 5")]
    TooManyClaimers,
    #[msg("Total basis points must sum to 10000")]
    InvalidTotalBps,
    #[msg("Caller is not in the pool's claimer list")]
    ClaimerNotFound,
    #[msg("Not proper ATA")]
    InvalidClaimerAta,
    #[msg("Duplicate claimer address — each address must appear exactly once")]
    DuplicateClaimerAddress,
    #[msg("pool_state must be Dbc or DammV2 — NotInitialized is not allowed")]
    InvalidPoolState,
    #[msg("Invalid ClaimerState PDA -- when creating claimer states")]
    InvalidClaimerStatePda,
    #[msg("Nothing to claim -- when claiming fees from the parked pool vault")]
    NothingToClaim,
}
