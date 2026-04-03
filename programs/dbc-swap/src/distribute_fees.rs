use crate::consts::{CLAIMER_STATE_SEED, FEE_CLAIMER_SEED, FEE_VAULT_SEED, POOL_CLAIMERS_SEED};
use crate::err::DbcSwapError;
use crate::events::FeesDistributedDammV2;
use crate::global_state::{ClaimerState, PoolClaimers};
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub fn handle<'info>(ctx: Context<'_, '_, 'info, 'info, DistributeFees<'info>>) -> Result<()> {
    let num_claimers = ctx.accounts.pool_claimers.claimer_addresses.len();

    // 3 accounts per claimer: state_pda + base_ata + quote_ata
    require!(
        ctx.remaining_accounts.len() == num_claimers * 3,
        DbcSwapError::ClaimerLengthMismatch
    );

    let base_vault_balance = ctx.accounts.base_fee_vault.amount;
    let quote_vault_balance = ctx.accounts.quote_fee_vault.amount;

    if base_vault_balance == 0 && quote_vault_balance == 0 {
        return Ok(());
    }

    let bump = ctx.bumps.fee_claimer;
    let signer_seeds: &[&[&[u8]]] = &[&[FEE_CLAIMER_SEED, &[bump]]];

    let pool_key = ctx.accounts.pool.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let quote_mint_key = ctx.accounts.quote_mint.key();
    let base_program_key = ctx.accounts.token_base_program.key();
    let quote_program_key = ctx.accounts.token_quote_program.key();
    let base_decimals = ctx.accounts.base_mint.decimals;
    let quote_decimals = ctx.accounts.quote_mint.decimals;

    let claimer_addresses = ctx.accounts.pool_claimers.claimer_addresses.clone();
    let claimer_bps = ctx.accounts.pool_claimers.claimer_bps.clone();

    let mut base_distributed: u64 = 0;
    let mut quote_distributed: u64 = 0;

    for i in 0..num_claimers {
        let claimer_addr = claimer_addresses[i];
        let bps = claimer_bps[i] as u64;

        // --- Validate ClaimerState PDA ---
        let state_account_info = &ctx.remaining_accounts[i * 3];
        let (expected_state_pda, _) = Pubkey::find_program_address(
            &[CLAIMER_STATE_SEED, pool_key.as_ref(), claimer_addr.as_ref()],
            ctx.program_id,
        );
        require!(
            state_account_info.key() == expected_state_pda,
            DbcSwapError::InvalidClaimerStatePda
        );

        // Deserialize ClaimerState
        let mut state: Account<ClaimerState> = Account::try_from(state_account_info)?;

        // --- Compute this claimer's share ---
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

        if state.is_enabled {
            // --- Validate ATAs ---
            let claimer_base_ata_info = &ctx.remaining_accounts[i * 3 + 1];
            let expected_base_ata = get_associated_token_address_with_program_id(
                &claimer_addr,
                &base_mint_key,
                &base_program_key,
            );
            require!(
                claimer_base_ata_info.key() == expected_base_ata,
                DbcSwapError::InvalidClaimerAta
            );

            let claimer_quote_ata_info = &ctx.remaining_accounts[i * 3 + 2];
            let expected_quote_ata = get_associated_token_address_with_program_id(
                &claimer_addr,
                &quote_mint_key,
                &quote_program_key,
            );
            require!(
                claimer_quote_ata_info.key() == expected_quote_ata,
                DbcSwapError::InvalidClaimerAta
            );

            // Sweep any previously parked pending amounts in the same pass
            let total_base = base_amount
                .checked_add(state.pending_base)
                .unwrap_or(base_amount);
            let total_quote = quote_amount
                .checked_add(state.pending_quote)
                .unwrap_or(quote_amount);

            if total_base > 0 {
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
                    total_base,
                    base_decimals,
                )?;
                state.claimed_base = state.claimed_base.checked_add(total_base).unwrap();
                state.pending_base = 0;
                base_distributed = base_distributed.checked_add(base_amount).unwrap();
            }

            if total_quote > 0 {
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
                    total_quote,
                    quote_decimals,
                )?;
                state.claimed_quote = state.claimed_quote.checked_add(total_quote).unwrap();
                state.pending_quote = 0;
                quote_distributed = quote_distributed.checked_add(quote_amount).unwrap();
            }
        } else {
            // Disabled — park funds in ClaimerState, no vault transfer
            state.pending_base = state.pending_base.checked_add(base_amount).unwrap();
            state.pending_quote = state.pending_quote.checked_add(quote_amount).unwrap();
            // Still count toward distributed so last-claimer math stays consistent
            base_distributed = base_distributed.checked_add(base_amount).unwrap();
            quote_distributed = quote_distributed.checked_add(quote_amount).unwrap();
        }

        // Persist ClaimerState changes
        state.exit(ctx.program_id)?;
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
    pub caller: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump = pool_claimers.bump,
        constraint = pool_claimers.pool == pool.key() @ DbcSwapError::Unauthorized,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    #[account(
        mut,
        seeds = [FEE_VAULT_SEED, pool.key().as_ref(), base_mint.key().as_ref()],
        bump,
        token::mint = base_mint,
        token::authority = fee_claimer,
        token::token_program = token_base_program,
    )]
    pub base_fee_vault: InterfaceAccount<'info, TokenAccount>,

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

    #[account(
        seeds = [FEE_CLAIMER_SEED],
        bump,
    )]
    pub fee_claimer: SystemAccount<'info>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    // ClaimerState PDAs + ATAs in remaining_accounts [state, base_ata, quote_ata] per claimer
}
