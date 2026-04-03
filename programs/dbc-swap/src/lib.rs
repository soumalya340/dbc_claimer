mod claimers_state;
mod consts;
mod damm_v2_endpoints;
mod dbc_endpoints;
mod distribute_fees;
mod err;
mod events;
mod global_state;
mod set_pool_claimers;
mod update_claimers_bps;

use crate::claimers_state::*;
use crate::damm_v2_endpoints::*;
use crate::dbc_endpoints::*;
use crate::global_state::PoolState;
use crate::set_pool_claimers::*;
use crate::update_claimers_bps::*;
use anchor_lang::prelude::*;
use damm_v2::cp_amm;
use distribute_fees::*;

declare_id!("2VgCjezWK4kHxoute1Jy986AXVPvSkwquPX5VBVwQMzV");

/// # DBC Swap Program
///
/// A pass-through wrapper around the Dynamic Bonding Curve (DBC) program that
/// adds a layer of fee management on top of standard DBC operations:
/// - Initialize virtual pools with Token2022
/// - Swap tokens via CPI into DBC
/// - Claim accumulated partner trading fees into PDA-owned vaults
/// - Withdraw fee shares to registered claimers (BPS-based splits)
#[program]
pub mod dbc_swap {
    use super::*;

    /// Sets (or replaces) the list of claimers and their BPS fee shares for
    /// a specific pool. Only callable by DEPLOYER_ADDRESS.
    /// Resets all claimed amounts to zero on each call.
    /// `pool_state` must be `Dbc` or `DammV2` — determines which fee path applies.
    pub fn set_pool_claimers<'info>(
        ctx: Context<'_, '_, '_, 'info, SetPoolClaimers<'info>>,
        claimer_addresses: Vec<Pubkey>,
        claimer_bps: Vec<u16>,
        pool_state: PoolState,
    ) -> Result<()> {
        set_pool_claimers::handle(ctx, claimer_addresses, claimer_bps, pool_state)
    }

    /// Admin-only — updates only the BPS shares of the existing claimer list
    /// for a pool. Claimer addresses and all claimed amount history are preserved.
    /// Use this to rebalance fee splits without disturbing historical records.
    pub fn update_claimers_bps(ctx: Context<UpdateClaimersBps>, new_bps: Vec<u16>) -> Result<()> {
        update_claimers_bps::handle(ctx, new_bps)
    }

    /// Permissionless — sweeps accrued partner trading fees from the DBC pool
    /// into this program's PDA-owned fee vaults.
    ///
    /// # Arguments
    /// * `max_amount_a` - Maximum base token amount to claim
    /// * `max_amount_b` - Maximum quote token amount to claim
    pub fn claim_partner_trading_fee<'info>(
        ctx: Context<'_, '_, '_, 'info, ClaimPartnerTradingFee<'info>>,
        max_amount_a: u64,
        max_amount_b: u64,
    ) -> Result<()> {
        claim_fees_in_dbc::handle(ctx, max_amount_a, max_amount_b)
    }

    /// Permissionless — claims position fees from the cp_amm pool into
    /// PDA-owned fee vaults. All registered claimers can then withdraw
    /// their BPS shares via `withdraw_from_fee_vault`.
    pub fn claim_position_fee<'info>(
        ctx: Context<'_, '_, '_, 'info, ClaimPositionFee<'info>>,
    ) -> Result<()> {
        claim_position_fee::handle(ctx)
    }

    /// Permissionless — distributes the entire current fee vault balance to all
    /// registered claimers proportionally by BPS in a single transaction.
    /// Designed for the DAMM v2 path. Remaining accounts must be passed as
    /// [claimer_0_base_ata, claimer_0_quote_ata, claimer_1_base_ata, ...].
    pub fn distribute_fees<'info>(
        ctx: Context<'_, '_, 'info, 'info, DistributeFees<'info>>,
    ) -> Result<()> {
        distribute_fees::handle(ctx)
    }

    /// Admin-only — removes liquidity from a cp_amm pool position.
    pub fn remove_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, RemoveLiquidity<'info>>,
        params: cp_amm::types::RemoveLiquidityParameters,
    ) -> Result<()> {
        remove_liquidity::handle(ctx, params)
    }

    /// Admin-only — removes ALL liquidity from a cp_amm pool position.
    pub fn remove_all_liquidity<'info>(
        ctx: Context<'_, '_, '_, 'info, RemoveAllLiquidity<'info>>,
        token_a_amount_threshold: u64,
        token_b_amount_threshold: u64,
    ) -> Result<()> {
        remove_all_liquidity::handle(ctx, token_a_amount_threshold, token_b_amount_threshold)
    }

    /// Admin-only — enables or disables a claimer for live `distribute_fees` payouts.
    pub fn set_claimer_enabled(ctx: Context<SetClaimerEnabled>, is_enabled: bool) -> Result<()> {
        set_claimer_enabled::handle(ctx, is_enabled)
    }

    /// Admin-only — transfers `pending_base` / `pending_quote` from fee vaults to
    /// the supplied destination ATAs (e.g. after a claimer was disabled).
    pub fn admin_sweep_claimer(ctx: Context<AdminSweepClaimer>) -> Result<()> {
        admin_sweep_claimer::handle(ctx)
    }
}
