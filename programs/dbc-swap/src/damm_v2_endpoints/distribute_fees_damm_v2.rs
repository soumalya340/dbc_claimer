use crate::consts::{FEE_CLAIMER_SEED, FEE_VAULT_SEED, POOL_CLAIMERS_SEED};
use crate::err::DbcSwapError;
use crate::events::FeesDistributedDammV2;
use crate::global_state::PoolClaimers;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

/// Permissionless — anyone can call this to distribute the entire current
/// fee vault balance to all registered claimers according to their BPS shares.
///
/// Designed for the DAMM v2 path where fees trickle in daily.  A crank or
/// any random wallet can trigger this to push funds out immediately.
///
/// Remaining accounts must be passed in strict order:
///   [claimer_0_base_ata, claimer_0_quote_ata,
///    claimer_1_base_ata, claimer_1_quote_ata, ...]
///
/// Each ATA is validated on-chain by re-deriving from the claimer address,
/// the mint, and the token program.  Mismatches will error.
pub fn handle<'info>(ctx: Context<'_, '_, '_, 'info, DistributeFees<'info>>) -> Result<()> {
    let num_claimers = ctx.accounts.pool_claimers.claimer_addresses.len();

    // We need 2 ATAs per claimer (base + quote)
    require!(
        ctx.remaining_accounts.len() == num_claimers * 2,
        DbcSwapError::ClaimerLengthMismatch
    );

    let base_vault_balance = ctx.accounts.base_fee_vault.amount;
    let quote_vault_balance = ctx.accounts.quote_fee_vault.amount;

    // Nothing to distribute
    if base_vault_balance == 0 && quote_vault_balance == 0 {
        return Ok(());
    }

    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    let base_mint_key = ctx.accounts.base_mint.key();
    let quote_mint_key = ctx.accounts.quote_mint.key();
    let base_program_key = ctx.accounts.token_base_program.key();
    let quote_program_key = ctx.accounts.token_quote_program.key();
    let base_decimals = ctx.accounts.base_mint.decimals;
    let quote_decimals = ctx.accounts.quote_mint.decimals;

    // Clone read-only data so the immutable borrow on pool_claimers is fully
    // dropped before we mutate claimed_base / claimed_quote inside the loop.
    let claimer_addresses = ctx.accounts.pool_claimers.claimer_addresses.clone();
    let claimer_bps = ctx.accounts.pool_claimers.claimer_bps.clone();

    let mut base_distributed: u64 = 0;
    let mut quote_distributed: u64 = 0;

    for i in 0..num_claimers {
        let claimer_addr = claimer_addresses[i];
        let bps = claimer_bps[i] as u64;

        // --- Determine amounts (last claimer sweeps remainder) ---
        let base_amount = if i == num_claimers - 1 {
            base_vault_balance.saturating_sub(base_distributed)
        } else {
            base_vault_balance
                .checked_mul(bps)
                .and_then(|v| v.checked_div(10_000))
                .unwrap_or(0)
        };

        let quote_amount = if i == num_claimers - 1 {
            quote_vault_balance.saturating_sub(quote_distributed)
        } else {
            quote_vault_balance
                .checked_mul(bps)
                .and_then(|v| v.checked_div(10_000))
                .unwrap_or(0)
        };

        // --- Validate base ATA ---
        let claimer_base_ata_info = &ctx.remaining_accounts[i * 2];
        let expected_base_ata = get_associated_token_address_with_program_id(
            &claimer_addr,
            &base_mint_key,
            &base_program_key,
        );
        require!(
            claimer_base_ata_info.key() == expected_base_ata,
            DbcSwapError::InvalidClaimerAta
        );

        // --- Validate quote ATA ---
        let claimer_quote_ata_info = &ctx.remaining_accounts[i * 2 + 1];
        let expected_quote_ata = get_associated_token_address_with_program_id(
            &claimer_addr,
            &quote_mint_key,
            &quote_program_key,
        );
        require!(
            claimer_quote_ata_info.key() == expected_quote_ata,
            DbcSwapError::InvalidClaimerAta
        );

        // --- Transfer base ---
        if base_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_base_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.base_fee_vault.to_account_info(),
                        mint: ctx.accounts.base_mint.to_account_info(),
                        to: claimer_base_ata_info.to_account_info(),
                        authority: ctx.accounts.fee_claimer.to_account_info(),
                    },
                    signer_seeds,
                ),
                base_amount,
                base_decimals,
            )?;
            base_distributed = base_distributed.checked_add(base_amount).unwrap();
        }

        // --- Transfer quote ---
        if quote_amount > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_quote_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.quote_fee_vault.to_account_info(),
                        mint: ctx.accounts.quote_mint.to_account_info(),
                        to: claimer_quote_ata_info.to_account_info(),
                        authority: ctx.accounts.fee_claimer.to_account_info(),
                    },
                    signer_seeds,
                ),
                quote_amount,
                quote_decimals,
            )?;
            quote_distributed = quote_distributed.checked_add(quote_amount).unwrap();
        }

        // --- Update per-claimer running totals in PoolClaimers ---
        let pc = &mut ctx.accounts.pool_claimers;
        pc.claimed_base[i] = pc.claimed_base[i].checked_add(base_amount).unwrap();
        pc.claimed_quote[i] = pc.claimed_quote[i].checked_add(quote_amount).unwrap();
    }

    let now = Clock::get()?.unix_timestamp;
    ctx.accounts.pool_claimers.last_distributed = now;

    emit!(FeesDistributedDammV2 {
        pool: ctx.accounts.pool.key(),
        total_base_distributed: base_distributed,
        total_quote_distributed: quote_distributed,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    /// Anyone can crank this — no signer restriction.
    pub caller: Signer<'info>,

    /// CHECK: The DAMM v2 pool address — used only as a seed.
    pub pool: UncheckedAccount<'info>,

    /// Per-pool claimers config — read for addresses + BPS, mutated for totals.
    #[account(
        mut,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump = pool_claimers.bump,
        constraint = pool_claimers.pool == pool.key() @ DbcSwapError::Unauthorized,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    /// Per-pool PDA base fee vault (source of funds)
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = fee_claimer,
        token::token_program = token_base_program,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

    /// Per-pool PDA quote fee vault (source of funds)
    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), quote_mint.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = fee_claimer,
        token::token_program = token_quote_program,
    )]
    pub quote_fee_vault: InterfaceAccount<'info, TokenAccount>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    /// PDA signer for vault transfers
    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
}
