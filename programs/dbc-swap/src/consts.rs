use anchor_lang::prelude::Pubkey;
pub const ADMIN_ADDRESS: Pubkey =
    anchor_lang::solana_program::pubkey!("cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF");

pub const ANCHOR_DISCRIMINATOR_SIZE: usize = 8;

pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const POOL_CLAIMERS_SEED: &[u8] = b"pool_claimers";
pub const MAX_CLAIMERS: usize = 5;
