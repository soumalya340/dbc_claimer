use anchor_lang::prelude::Pubkey;
pub const ADMIN_ADDRESS: Pubkey =
    anchor_lang::solana_program::pubkey!("cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF");

pub const LIQUIDITY_REMOVAL_AUTHORITY: Pubkey =
    anchor_lang::solana_program::pubkey!("cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF");

pub const ANCHOR_DISCRIMINATOR_SIZE: usize = 8;

/// Global singleton PDA — the "robot wallet" that signs all CPIs.
/// It owns position NFTs (DAMM v2) and is registered as feeClaimer (DBC).
/// Only one exists per program. Seeds: [b"fee_claimer"]
pub const FEE_CLAIMER_SEED: &[u8] = b"fee_claimer";

/// Per-pool, per-token holding account where fees sit before distribution.
/// Two per pool (one base, one quote). Seeds: [b"fee_vault", pool, mint]
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";

/// Per-pool config — who gets paid and what percentage.
/// Stores up to 5 claimer wallets, their BPS splits, and running totals.
/// Seeds: [b"pool_claimers", pool]
pub const POOL_CLAIMERS_SEED: &[u8] = b"pool_claimers";

pub const MAX_CLAIMERS: usize = 5;
