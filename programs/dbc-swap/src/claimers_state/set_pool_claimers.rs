use crate::consts::{
    ADMIN_ADDRESS, ANCHOR_DISCRIMINATOR_SIZE, CLAIMER_STATE_SEED, MAX_CLAIMERS, POOL_CLAIMERS_SEED,
};
use crate::err::DbcSwapError;
use crate::events::PoolClaimersSet;
use crate::global_state::{ClaimerState, PoolClaimers, PoolState};
use anchor_lang::prelude::*;

/// Admin-only, one-time init per pool.
/// Remaining accounts: one SystemAccount slot per claimer in order,
/// each will be init'd as a ClaimerState PDA.
/// Seeds for each: [CLAIMER_STATE_SEED, pool.key(), claimer_address]
pub fn handle<'info>(
    ctx: Context<'_, '_, '_, 'info, SetPoolClaimers<'info>>,
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

    require!(
        ctx.remaining_accounts.len() == claimer_addresses.len(),
        DbcSwapError::ClaimerLengthMismatch
    );

    let pool_key = ctx.accounts.pool.key();
    let deployer_info = ctx.accounts.deployer.to_account_info();
    let system_program_info = ctx.accounts.system_program.to_account_info();
    let remaining_accounts = ctx.remaining_accounts;

    // Init each ClaimerState PDA via remaining_accounts
    for (i, claimer_addr) in claimer_addresses.iter().enumerate() {
        let account_info = remaining_accounts[i].clone();

        let (expected_pda, bump) = Pubkey::find_program_address(
            &[CLAIMER_STATE_SEED, pool_key.as_ref(), claimer_addr.as_ref()],
            ctx.program_id,
        );

        require!(
            account_info.key() == expected_pda,
            DbcSwapError::InvalidClaimerStatePda
        );

        // Allocate + assign
        let space = ANCHOR_DISCRIMINATOR_SIZE + ClaimerState::INIT_SPACE;
        let rent = Rent::get()?.minimum_balance(space);

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::create_account(
                deployer_info.key,
                &expected_pda,
                rent,
                space as u64,
                ctx.program_id,
            ),
            &[
                deployer_info.clone(),
                account_info.clone(),
                system_program_info.clone(),
            ],
            &[&[
                CLAIMER_STATE_SEED,
                pool_key.as_ref(),
                claimer_addr.as_ref(),
                &[bump],
            ]],
        )?;

        // Write discriminator + data
        let mut data = account_info.try_borrow_mut_data()?;
        data[..8].copy_from_slice(&ClaimerState::DISCRIMINATOR);

        let state = ClaimerState {
            pool: pool_key,
            claimer: *claimer_addr,
            is_enabled: true, // enabled by default
            pending_base: 0,
            pending_quote: 0,
            claimed_base: 0,
            claimed_quote: 0,
            bump,
        };

        let mut writer = &mut data[8..];
        state.serialize(&mut writer)?;
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
pub struct SetPoolClaimers<'info> {
    #[account(
        mut,
        address = ADMIN_ADDRESS @ DbcSwapError::Unauthorized,
    )]
    pub deployer: Signer<'info>,

    /// CHECK: seed only
    pub pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = deployer,
        space = ANCHOR_DISCRIMINATOR_SIZE + PoolClaimers::INIT_SPACE,
        seeds = [POOL_CLAIMERS_SEED, pool.key().as_ref()],
        bump,
    )]
    pub pool_claimers: Account<'info, PoolClaimers>,

    pub system_program: Program<'info, System>,
    // ClaimerState PDAs passed in remaining_accounts
}
