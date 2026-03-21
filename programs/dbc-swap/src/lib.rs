mod consts;
mod endpoints;
mod err;
mod global_state;

use crate::endpoints::*;
use anchor_lang::prelude::*;
use damm_v2::cp_amm;
use dbc::dynamic_bonding_curve;

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
    pub fn set_pool_claimers(
        ctx: Context<SetPoolClaimers>,
        claimer_addresses: Vec<Pubkey>,
        claimer_bps: Vec<u16>,
    ) -> Result<()> {
        set_pool_claimers::handle(ctx, claimer_addresses, claimer_bps)
    }

    /// Admin-only — updates only the BPS shares of the existing claimer list
    /// for a pool. Claimer addresses and all claimed amount history are preserved.
    /// Use this to rebalance fee splits without disturbing historical records.
    pub fn update_claimers_bps(
        ctx: Context<UpdateClaimersBps>,
        new_bps: Vec<u16>,
    ) -> Result<()> {
        update_claimers_bps::handle(ctx, new_bps)
    }

    /// Creates a new virtual pool with a Token2022 base mint via CPI into DBC.
    pub fn initialize_virtual_pool_with_token2022<'info>(
        ctx: Context<'_, '_, '_, 'info, InitializeVirtualPoolWithToken2022<'info>>,
        params: dynamic_bonding_curve::types::InitializePoolParameters,
    ) -> Result<()> {
        create_pool::initialize_virtual_pool_with_token2022(ctx, params)
    }

    /// Executes a token swap via CPI into the DBC program.
    ///
    /// # Arguments
    /// * `params` - Swap parameters including amount, direction, and slippage
    pub fn swap<'info>(
        ctx: Context<'_, '_, '_, 'info, Swap<'info>>,
        params: dynamic_bonding_curve::types::SwapParameters,
    ) -> Result<()> {
        swap::handle(ctx, params)
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
        claim_partner_fees_in_dbc::handle(ctx, max_amount_a, max_amount_b)
    }

    /// Claimer-gated — withdraws a caller's BPS share of the per-pool fee
    /// vault balance. Caller must be listed in the pool's PoolClaimers account.
    ///
    /// # Arguments
    /// * `base_amount` - Base token amount to withdraw (capped by BPS share)
    /// * `quote_amount` - Quote token amount to withdraw (capped by BPS share)
    pub fn withdraw_from_fee_vault(
        ctx: Context<WithdrawFromFeeVault>,
        base_amount: u64,
        quote_amount: u64,
    ) -> Result<()> {
        withdraw_fees::withdraw_from_fee_vault(ctx, base_amount, quote_amount)
    }

    /// Permissionless — claims position fees from the cp_amm pool into
    /// PDA-owned fee vaults. All registered claimers can then withdraw
    /// their BPS shares via `withdraw_from_fee_vault`.
    pub fn claim_position_fee<'info>(
        ctx: Context<'_, '_, '_, 'info, ClaimPositionFee<'info>>,
    ) -> Result<()> {
        claim_position_fee::handle(ctx)
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
}
