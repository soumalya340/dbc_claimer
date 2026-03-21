use anchor_lang::prelude::*;
use dbc::dynamic_bonding_curve;

// -----------------------------------------------------------------------
// Existing: pool init & swap (pass-through CPI)
// -----------------------------------------------------------------------

pub fn initialize_virtual_pool_with_token2022<'info>(
    ctx: Context<'_, '_, '_, 'info, InitializeVirtualPoolWithToken2022<'info>>,
    params: dynamic_bonding_curve::types::InitializePoolParameters,
) -> Result<()> {
    let cpi_accounts = dynamic_bonding_curve::cpi::accounts::InitializeVirtualPoolWithToken2022 {
        config: ctx.accounts.config.to_account_info(),
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        creator: ctx.accounts.creator.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        base_vault: ctx.accounts.base_vault.to_account_info(),
        quote_vault: ctx.accounts.quote_vault.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        system_program: ctx.accounts.system_program.to_account_info(),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        program: ctx.accounts.dbc_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(ctx.accounts.dbc_program.to_account_info(), cpi_accounts);

    dynamic_bonding_curve::cpi::initialize_virtual_pool_with_token2022(cpi_ctx, params)
}

#[derive(Accounts)]
pub struct InitializeVirtualPoolWithToken2022<'info> {
    /// CHECK: Validated by the dynamic bonding curve program
    pub config: UncheckedAccount<'info>,

    /// CHECK: Fixed-address PDA, validated by the target program
    pub pool_authority: UncheckedAccount<'info>,

    pub creator: Signer<'info>,

    /// CHECK: Token mint, initialized by the target program (must sign to authorize creation)
    #[account(mut)]
    pub base_mint: Signer<'info>,

    /// CHECK: Validated by the target program
    pub quote_mint: UncheckedAccount<'info>,

    /// CHECK: Pool state, initialized by the target program
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: PDA token vault, initialized by the target program
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: PDA token vault, initialized by the target program
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Token program for quote mint, validated by the target program
    pub token_quote_program: UncheckedAccount<'info>,

    /// CHECK: Token2022 program, validated by the target program
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Event authority PDA of the target program
    pub event_authority: UncheckedAccount<'info>,

    /// The dynamic bonding curve program to CPI into
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
}
