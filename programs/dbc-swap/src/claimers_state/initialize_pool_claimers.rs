use crate::consts::{
    ADMIN_ADDRESS, ANCHOR_DISCRIMINATOR_SIZE, CLAIMER_PENDING_BASE_SEED,
    CLAIMER_PENDING_QUOTE_SEED, CLAIMER_STATE_SEED, MAX_CLAIMERS, POOL_CLAIMERS_SEED,
};
use crate::err::DbcSwapError;
use crate::events::PoolClaimersSet;
use crate::global_state::{ClaimerState, PoolClaimers, PoolState};
use anchor_lang::prelude::*;
use anchor_spl::token::spl_token::solana_program::program_pack::Pack;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{Mint, TokenInterface};

/// Remaining accounts per claimer (in order):
///   [claimer_state_pda, claimer_pending_base_vault, claimer_pending_quote_vault]
pub fn handle<'info>(
    ctx: Context<'_, '_, '_, 'info, InitializePoolClaimers<'info>>,
    claimer_addresses: Vec<Pubkey>,
    claimer_bps: Vec<u16>,
    pool_state: PoolState,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.deployer.key(),
        ADMIN_ADDRESS,
        DbcSwapError::Unauthorized
    );
    require!(
        pool_state == PoolState::Dbc || pool_state == PoolState::DammV2,
        DbcSwapError::InvalidPoolState
    );
    require!(
        claimer_addresses.len() == claimer_bps.len(),
        DbcSwapError::ClaimerLengthMismatch
    );
    require!(
        claimer_addresses.len() <= MAX_CLAIMERS,
        DbcSwapError::TooManyClaimers
    );
    for i in 0..claimer_addresses.len() {
        for j in (i + 1)..claimer_addresses.len() {
            require!(
                claimer_addresses[i] != claimer_addresses[j],
                DbcSwapError::DuplicateClaimerAddress
            );
        }
    }
    let total_bps: u32 = claimer_bps.iter().map(|&b| b as u32).sum();
    require!(total_bps == 10_000, DbcSwapError::InvalidTotalBps);

    // 3 remaining accounts per claimer
    require!(
        ctx.remaining_accounts.len() == claimer_addresses.len() * 3,
        DbcSwapError::ClaimerLengthMismatch
    );
    let pool_key = ctx.accounts.pool.key();
    let base_mint_key = ctx.accounts.base_mint.key();
    let quote_mint_key = ctx.accounts.quote_mint.key();

    // Extract AccountInfos before the loop to avoid lifetime conflicts arising
    // from mixing ctx.accounts (invariant Signer<'info>) with ctx.remaining_accounts
    // inside a single invoke_signed slice.
    let deployer_info = ctx.accounts.deployer.to_account_info();
    let system_program_info = ctx.accounts.system_program.to_account_info();
    let base_mint_info = ctx.accounts.base_mint.to_account_info();
    let quote_mint_info = ctx.accounts.quote_mint.to_account_info();
    let token_base_program_key = ctx.accounts.token_base_program.key();
    let token_quote_program_key = ctx.accounts.token_quote_program.key();
    let token_base_program_info = ctx.accounts.token_base_program.to_account_info();
    let token_quote_program_info = ctx.accounts.token_quote_program.to_account_info();

    let token_account_size = anchor_spl::token::spl_token::state::Account::LEN;
    let token_account_rent = Rent::get()?.minimum_balance(token_account_size);

    for (i, claimer_addr) in claimer_addresses.iter().enumerate() {
        let state_info = &ctx.remaining_accounts[i * 3];
        let pending_base_info = &ctx.remaining_accounts[i * 3 + 1];
        let pending_quote_info = &ctx.remaining_accounts[i * 3 + 2];

        // --- Init ClaimerState ---
        let (expected_state_pda, state_bump) = Pubkey::find_program_address(
            &[CLAIMER_STATE_SEED, pool_key.as_ref(), claimer_addr.as_ref()],
            ctx.program_id,
        );
        require!(
            state_info.key() == expected_state_pda,
            DbcSwapError::InvalidClaimerStatePda
        );

        if state_info.lamports() == 0 {
            let state_space = ANCHOR_DISCRIMINATOR_SIZE + ClaimerState::INIT_SPACE;
            let state_rent = Rent::get()?.minimum_balance(state_space);

            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    ctx.accounts.deployer.key,
                    &expected_state_pda,
                    state_rent,
                    state_space as u64,
                    ctx.program_id,
                ),
                &[
                    deployer_info.clone(),
                    state_info.clone(),
                    system_program_info.clone(),
                ],
                &[&[
                    CLAIMER_STATE_SEED,
                    pool_key.as_ref(),
                    claimer_addr.as_ref(),
                    &[state_bump],
                ]],
            )?;

            let mut data = state_info.try_borrow_mut_data()?;
            data[..8].copy_from_slice(&ClaimerState::DISCRIMINATOR);
            let state = ClaimerState {
                pool: pool_key,
                claimer: *claimer_addr,
                is_enabled: true,
                claimed_base: 0,
                claimed_quote: 0,
                bump: state_bump,
            };
            state.serialize(&mut &mut data[8..])?;
            drop(data);
        }

        // --- Init claimer_pending_base_vault ---
        let (expected_base_vault, base_vault_bump) = Pubkey::find_program_address(
            &[
                CLAIMER_PENDING_BASE_SEED,
                pool_key.as_ref(),
                claimer_addr.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            pending_base_info.key() == expected_base_vault,
            DbcSwapError::InvalidClaimerStatePda
        );

        if pending_base_info.lamports() == 0 {
            // Step 1: allocate the token account on-chain
            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    ctx.accounts.deployer.key,
                    &expected_base_vault,
                    token_account_rent,
                    token_account_size as u64,
                    &token_base_program_key,
                ),
                &[
                    deployer_info.clone(),
                    pending_base_info.clone(),
                    system_program_info.clone(),
                ],
                &[&[
                    CLAIMER_PENDING_BASE_SEED,
                    pool_key.as_ref(),
                    claimer_addr.as_ref(),
                    &[base_vault_bump],
                ]],
            )?;

            // Step 2: initialize the token account fields (mint, authority)
            anchor_lang::solana_program::program::invoke_signed(
                &spl_token_2022::instruction::initialize_account3(
                    &token_base_program_key,
                    &expected_base_vault,
                    &base_mint_key,
                    &expected_state_pda,
                )?,
                &[
                    pending_base_info.clone(),
                    base_mint_info.clone(),
                    token_base_program_info.clone(),
                ],
                &[&[
                    CLAIMER_PENDING_BASE_SEED,
                    pool_key.as_ref(),
                    claimer_addr.as_ref(),
                    &[base_vault_bump],
                ]],
            )?;
        }

        // --- Init claimer_pending_quote_vault ---
        let (expected_quote_vault, quote_vault_bump) = Pubkey::find_program_address(
            &[
                CLAIMER_PENDING_QUOTE_SEED,
                pool_key.as_ref(),
                claimer_addr.as_ref(),
            ],
            ctx.program_id,
        );
        require!(
            pending_quote_info.key() == expected_quote_vault,
            DbcSwapError::InvalidClaimerStatePda
        );

        if pending_quote_info.lamports() == 0 {
            // Step 1: allocate the token account on-chain
            anchor_lang::solana_program::program::invoke_signed(
                &anchor_lang::solana_program::system_instruction::create_account(
                    ctx.accounts.deployer.key,
                    &expected_quote_vault,
                    token_account_rent,
                    token_account_size as u64,
                    &token_quote_program_key,
                ),
                &[
                    deployer_info.clone(),
                    pending_quote_info.clone(),
                    system_program_info.clone(),
                ],
                &[&[
                    CLAIMER_PENDING_QUOTE_SEED,
                    pool_key.as_ref(),
                    claimer_addr.as_ref(),
                    &[quote_vault_bump],
                ]],
            )?;

            // Step 2: initialize the token account fields (mint, authority)
            anchor_lang::solana_program::program::invoke_signed(
                &spl_token_2022::instruction::initialize_account3(
                    &token_quote_program_key,
                    &expected_quote_vault,
                    &quote_mint_key,
                    &expected_state_pda,
                )?,
                &[
                    pending_quote_info.clone(),
                    quote_mint_info.clone(),
                    token_quote_program_info.clone(),
                ],
                &[&[
                    CLAIMER_PENDING_QUOTE_SEED,
                    pool_key.as_ref(),
                    claimer_addr.as_ref(),
                    &[quote_vault_bump],
                ]],
            )?;
        }
    }
    let pc = &mut ctx.accounts.pool_claimers;
    pc.pool = pool_key;
    pc.claimer_addresses = claimer_addresses.clone();
    pc.claimer_bps = claimer_bps.clone();
    pc.bump = ctx.bumps.pool_claimers;
    pc.pool_state = pool_state.clone();

    let now = Clock::get()?.unix_timestamp;
    emit!(PoolClaimersSet {
        pool: pc.pool,
        claimer_addresses,
        claimer_bps,
        pool_state,
        timestamp: now,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct InitializePoolClaimers<'info> {
    #[account(
        mut,
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub deployer: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub quote_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = deployer,
        space = ANCHOR_DISCRIMINATOR_SIZE + PoolClaimers::INIT_SPACE,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    pub token_base_program: Interface<'info, TokenInterface>,
    pub token_quote_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining: [claimer_state_pda, pending_base_vault, pending_quote_vault] per claimer
}
