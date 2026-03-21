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
}
