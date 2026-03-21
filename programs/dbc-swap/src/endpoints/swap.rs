use anchor_lang::prelude::*;
use dbc::dynamic_bonding_curve;

pub fn handle<'info>(
    ctx: Context<'_, '_, '_, 'info, Swap<'info>>,
    params: dynamic_bonding_curve::types::SwapParameters,
) -> Result<()> {
    let cpi_accounts = dynamic_bonding_curve::cpi::accounts::Swap {
        pool_authority: ctx.accounts.pool_authority.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        pool: ctx.accounts.pool.to_account_info(),
        input_token_account: ctx.accounts.input_token_account.to_account_info(),
        output_token_account: ctx.accounts.output_token_account.to_account_info(),
        base_vault: ctx.accounts.base_vault.to_account_info(),
        quote_vault: ctx.accounts.quote_vault.to_account_info(),
        base_mint: ctx.accounts.base_mint.to_account_info(),
        quote_mint: ctx.accounts.quote_mint.to_account_info(),
        payer: ctx.accounts.payer.to_account_info(),
        token_base_program: ctx.accounts.token_base_program.to_account_info(),
        token_quote_program: ctx.accounts.token_quote_program.to_account_info(),
        referral_token_account: ctx
            .accounts
            .referral_token_account
            .as_ref()
            .map(|a| a.to_account_info()),
        event_authority: ctx.accounts.event_authority.to_account_info(),
        program: ctx.accounts.dbc_program.to_account_info(),
    };

    let cpi_ctx = CpiContext::new(ctx.accounts.dbc_program.to_account_info(), cpi_accounts);

    dynamic_bonding_curve::cpi::swap(cpi_ctx, params)
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// CHECK: Pool authority PDA, validated by the target program
    pub pool_authority: UncheckedAccount<'info>,

    /// CHECK: Config account, validated by the target program
    pub config: UncheckedAccount<'info>,

    /// CHECK: Pool state account
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    /// CHECK: User's input token account
    #[account(mut)]
    pub input_token_account: UncheckedAccount<'info>,

    /// CHECK: User's output token account
    #[account(mut)]
    pub output_token_account: UncheckedAccount<'info>,

    /// CHECK: Base token vault for the pool
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: Quote token vault for the pool
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: Base token mint
    pub base_mint: UncheckedAccount<'info>,

    /// CHECK: Quote token mint
    pub quote_mint: UncheckedAccount<'info>,

    pub payer: Signer<'info>,

    /// CHECK: Token program for base mint
    pub token_base_program: UncheckedAccount<'info>,

    /// CHECK: Token program for quote mint
    pub token_quote_program: UncheckedAccount<'info>,

    /// CHECK: Optional referral token account
    #[account(mut)]
    pub referral_token_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Event authority PDA of the target program
    pub event_authority: UncheckedAccount<'info>,

    /// The dynamic bonding curve program to CPI into
    #[account(address = dynamic_bonding_curve::ID)]
    pub dbc_program: Program<'info, dynamic_bonding_curve::program::DynamicBondingCurve>,
}
