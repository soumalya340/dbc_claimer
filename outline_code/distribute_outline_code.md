# Pseudocode Outline — dbc-custodian Program

---

## claimers_state/

### initialize_pool_claimers
```
INSTRUCTION: initialize_pool_claimers(claimer_addresses[], claimer_bps[], pool_state)
  AUTH: deployer must == ADMIN_ADDRESS

  VALIDATE:
    pool_state in { Dbc, DammV2 }
    claimer_addresses.len == claimer_bps.len
    claimer_addresses.len <= MAX_CLAIMERS
    no duplicate addresses in claimer_addresses
    sum(claimer_bps) == 10_000
    remaining_accounts.len == claimer_addresses.len * 3   // [state, base_vault, quote_vault] per claimer

  FOR each (claimer_addr, i):
    // --- ClaimerState PDA ---
    expected_state_pda = PDA[CLAIMER_STATE_SEED, pool, claimer_addr]
    assert remaining_accounts[i*3] == expected_state_pda
    create_account(expected_state_pda, space=ClaimerState::INIT_SPACE, owner=program)
    write ClaimerState { pool, claimer, is_enabled=true, claimed_base=0, claimed_quote=0, bump }

    // --- Pending base vault (token account) ---
    expected_base_vault = PDA[CLAIMER_PENDING_BASE_SEED, pool, claimer_addr]
    assert remaining_accounts[i*3+1] == expected_base_vault
    initialize_token_account(expected_base_vault, mint=base_mint, authority=claimer_state_pda)

    // --- Pending quote vault (token account) ---
    expected_quote_vault = PDA[CLAIMER_PENDING_QUOTE_SEED, pool, claimer_addr]
    assert remaining_accounts[i*3+2] == expected_quote_vault
    initialize_token_account(expected_quote_vault, mint=quote_mint, authority=claimer_state_pda)

  pool_claimers.{ pool, claimer_addresses, claimer_bps, bump, pool_state } = ...
  emit PoolClaimersSet { pool, claimer_addresses, claimer_bps, pool_state, timestamp }

ACCOUNTS:
  deployer (mut signer, == ADMIN_ADDRESS)
  pool (CHECK: seed only)
  base_mint, quote_mint
  pool_claimers (init, PDA[POOL_CLAIMERS_SEED, pool])
  token_base_program, token_quote_program, system_program
  remaining: [claimer_state_pda, pending_base_vault, pending_quote_vault] × N
```

---

### set_claimer_enabled
```
INSTRUCTION: set_claimer_enabled(is_enabled: bool)
  AUTH: admin must == ADMIN_ADDRESS

  claimer_state.is_enabled = is_enabled

ACCOUNTS:
  admin (signer, == ADMIN_ADDRESS)
  pool (CHECK: seed only)
  claimer (CHECK: seed only — whose toggle is flipped)
  claimer_state (mut, PDA[CLAIMER_STATE_SEED, pool, claimer], pool+claimer match)
```

---

### update_claimers_bps
```
INSTRUCTION: update_claimers_bps(new_bps[])
  AUTH: deployer must == ADMIN_ADDRESS

  VALIDATE:
    new_bps.len <= 5
    new_bps.len == pool_claimers.claimer_addresses.len   // must match existing count
    sum(new_bps) == 10_000

  pool_claimers.claimer_bps = new_bps   // addresses and claimed amounts unchanged

  emit ClaimersBpsUpdated { pool, new_bps, timestamp }

ACCOUNTS:
  deployer (mut signer, == ADMIN_ADDRESS)
  pool (CHECK: seed only)
  pool_claimers (mut, PDA[POOL_CLAIMERS_SEED, pool])
```

---

### admin_sweep_claimer
```
INSTRUCTION: admin_sweep_claimer()
  AUTH: admin must == ADMIN_ADDRESS

  pending_base  = claimer_pending_base_vault.amount
  pending_quote = claimer_pending_quote_vault.amount
  require pending_base > 0 OR pending_quote > 0

  signer = claimer_state PDA [CLAIMER_STATE_SEED, pool, claimer, bump]

  IF pending_base > 0:
    transfer_checked(pending_base_vault → destination_base_ata, authority=claimer_state)

  IF pending_quote > 0:
    transfer_checked(pending_quote_vault → destination_quote_ata, authority=claimer_state)

ACCOUNTS:
  admin (signer, == ADMIN_ADDRESS)
  pool, claimer (CHECK: seed only)
  claimer_state (PDA[CLAIMER_STATE_SEED, pool, claimer])
  claimer_pending_base_vault  (mut, PDA[CLAIMER_PENDING_BASE_SEED, pool, claimer])
  claimer_pending_quote_vault (mut, PDA[CLAIMER_PENDING_QUOTE_SEED, pool, claimer])
  base_mint, quote_mint
  destination_base_ata, destination_quote_ata (mut, any token account with correct mints)
  token_base_program, token_quote_program
```

---

## dbc_endpoints/

### claim_fees_in_dbc  (ClaimPartnerTradingFee)
```
INSTRUCTION: claim_fees_in_dbc(max_amount_a, max_amount_b)
  AUTH: permissionless — anyone can call

  signer = fee_claimer PDA [FEE_CLAIMER_SEED, bump]

  CPI → DBC program: claim_trading_fee(max_amount_a, max_amount_b)
    accounts:
      pool_authority, config, pool
      token_a_account  = base_fee_vault   (this program's PDA-owned vault, init_if_needed)
      token_b_account  = quote_fee_vault  (this program's PDA-owned vault, init_if_needed)
      base_vault, quote_vault  (DBC pool source vaults)
      base_mint, quote_mint
      fee_claimer  (PDA signer — must match feeClaimer in DBC config)

  pool_claimers.last_claimed = now
  emit PartnerFeesClaimed { pool, timestamp }

PREREQUISITE: DBC config.feeClaimer == PDA[fee_claimer_SEED] of this program

ACCOUNTS:
  pool_authority, config, pool (CHECK)
  pool_claimers (mut, PDA[POOL_CLAIMERS_SEED, pool])
  base_fee_vault  (init_if_needed, PDA[FEE_VAULT_SEED, pool, base_mint])
  quote_fee_vault (init_if_needed, PDA[FEE_VAULT_SEED, pool, quote_mint])
  base_pool_vault, quote_pool_vault (mut, CHECK — DBC pool vaults)
  base_mint, quote_mint
  fee_claimer (PDA[FEE_CLAIMER_SEED])
  token_base_program, token_quote_program
  event_authority (CHECK)
  dbc_program (== dynamic_bonding_curve::ID)
  payer (mut signer — pays rent for vault creation)
  system_program
```

---

## damm_v2_endpoints/

### claim_position_fee
```
INSTRUCTION: claim_position_fee()
  AUTH: permissionless — anyone can call

  signer = fee_claimer PDA [FEE_CLAIMER_SEED, bump]

  CPI → cp_amm program: claim_position_fee()
    accounts:
      pool_authority, pool, position
      token_a_account = base_fee_vault   (this program's PDA-owned vault, init_if_needed)
      token_b_account = quote_fee_vault  (this program's PDA-owned vault, init_if_needed)
      token_a_vault, token_b_vault  (cp_amm pool source vaults)
      token_a_mint, token_b_mint
      position_nft_account  (owned by fee_claimer PDA)
      owner = fee_claimer   (PDA signer)

  pool_claimers.last_claimed = now
  emit PositionFeeClaimed { pool, timestamp }

ACCOUNTS:
  pool_authority, pool (CHECK)
  pool_claimers (mut, PDA[POOL_CLAIMERS_SEED, pool])
  position (mut, CHECK)
  base_fee_vault  (init_if_needed, PDA[FEE_VAULT_SEED, pool, token_a_mint])
  quote_fee_vault (init_if_needed, PDA[FEE_VAULT_SEED, pool, token_b_mint])
  token_a_vault, token_b_vault (mut, CHECK)
  token_a_mint, token_b_mint
  position_nft_account (CHECK)
  token_a_program, token_b_program
  event_authority (CHECK)
  cp_amm_program (== cp_amm::ID)
  payer (mut signer — pays rent)
  fee_claimer (PDA[FEE_CLAIMER_SEED])
  system_program
```

---

### remove_liquidity
```
INSTRUCTION: remove_liquidity(params: RemoveLiquidityParameters)
  AUTH: admin must == LIQUIDITY_REMOVAL_AUTHORITY

  signer = fee_claimer PDA [FEE_CLAIMER_SEED, bump]

  CPI → cp_amm program: remove_liquidity(params)
    accounts:
      pool_authority, pool (mut), position (mut)
      token_a_account, token_b_account  (admin's token accounts — receive withdrawn tokens)
      token_a_vault, token_b_vault  (mut, cp_amm pool vaults)
      token_a_mint, token_b_mint
      position_nft_account (owned by fee_claimer PDA)
      owner = fee_claimer  (PDA signer)

  emit LiquidityRemoved { pool, admin, timestamp }

ACCOUNTS:
  admin (signer, == LIQUIDITY_REMOVAL_AUTHORITY)
  pool_authority (CHECK), pool (mut, CHECK), position (mut, CHECK)
  token_a_account (mut, authority=admin), token_b_account (mut, authority=admin)
  token_a_vault, token_b_vault (mut, CHECK)
  token_a_mint, token_b_mint (CHECK)
  position_nft_account (CHECK)
  fee_claimer (PDA[FEE_CLAIMER_SEED])
  token_a_program, token_b_program, event_authority (CHECK)
  cp_amm_program (== cp_amm::ID)
```

---

### remove_all_liquidity
```
INSTRUCTION: remove_all_liquidity(token_a_amount_threshold, token_b_amount_threshold)
  AUTH: admin must == LIQUIDITY_REMOVAL_AUTHORITY

  // Same shape as remove_liquidity but calls cp_amm::remove_all_liquidity
  // and accepts min-out thresholds instead of a params struct

  signer = fee_claimer PDA [FEE_CLAIMER_SEED, bump]

  CPI → cp_amm program: remove_all_liquidity(token_a_amount_threshold, token_b_amount_threshold)
    accounts: (identical set to remove_liquidity above)

  emit AllLiquidityRemoved { pool, admin, token_a_threshold, token_b_threshold, timestamp }

ACCOUNTS: (identical to remove_liquidity)
```

---

## distribute_fees.rs

```
INSTRUCTION: distribute_fees()
  AUTH: permissionless — any caller

  num_claimers = pool_claimers.claimer_addresses.len
  require remaining_accounts.len == num_claimers * 5
    // per claimer: [claimer_state_pda, pending_base_vault, pending_quote_vault,
    //               claimer_base_ata, claimer_quote_ata]

  base_vault_balance  = base_fee_vault.amount
  quote_vault_balance = quote_fee_vault.amount
  IF both == 0: return early (nothing to distribute)

  signer = fee_claimer PDA [FEE_CLAIMER_SEED, bump]

  base_distributed  = 0
  quote_distributed = 0

  FOR i in 0..num_claimers:
    claimer_addr = pool_claimers.claimer_addresses[i]
    bps          = pool_claimers.claimer_bps[i]

    state_info         = remaining_accounts[i*5]
    pending_base_info  = remaining_accounts[i*5+1]
    pending_quote_info = remaining_accounts[i*5+2]
    claimer_base_ata   = remaining_accounts[i*5+3]
    claimer_quote_ata  = remaining_accounts[i*5+4]

    // --- Validate PDAs ---
    assert state_info        == PDA[CLAIMER_STATE_SEED,         pool, claimer_addr]
    assert pending_base_info == PDA[CLAIMER_PENDING_BASE_SEED,  pool, claimer_addr]
    assert pending_quote_info== PDA[CLAIMER_PENDING_QUOTE_SEED, pool, claimer_addr]

    state = deserialize ClaimerState from state_info

    // --- Compute share ---
    IF i == last claimer:
      base_amount  = base_vault_balance  - base_distributed   // dust-free remainder
      quote_amount = quote_vault_balance - quote_distributed
    ELSE:
      base_amount  = base_vault_balance  * bps / 10_000
      quote_amount = quote_vault_balance * bps / 10_000

    IF state.is_enabled:
      // validate ATAs are the canonical associated token accounts
      assert claimer_base_ata  == ATA(claimer_addr, base_mint,  base_program)
      assert claimer_quote_ata == ATA(claimer_addr, quote_mint, quote_program)

      // transfer fee_vault → claimer ATA  (fee_claimer PDA signs)
      IF base_amount  > 0: transfer_checked(base_fee_vault  → claimer_base_ata,  base_amount)
                           state.claimed_base  += base_amount
                           base_distributed    += base_amount
      IF quote_amount > 0: transfer_checked(quote_fee_vault → claimer_quote_ata, quote_amount)
                           state.claimed_quote += quote_amount
                           quote_distributed   += quote_amount
    ELSE:
      // claimer disabled — park fees into their pending vaults
      IF base_amount  > 0: transfer_checked(base_fee_vault  → pending_base_vault,  base_amount)
                           base_distributed  += base_amount
      IF quote_amount > 0: transfer_checked(quote_fee_vault → pending_quote_vault, quote_amount)
                           quote_distributed += quote_amount

    state.exit(program_id)   // persist ClaimerState back on-chain

  pool_claimers.last_distributed = now
  emit FeesDistributedDammV2 { pool, total_base_distributed, total_quote_distributed, timestamp }

ACCOUNTS:
  caller (signer, permissionless)
  pool (CHECK: seed only)
  pool_claimers (mut, PDA[POOL_CLAIMERS_SEED, pool], pool must match)
  base_fee_vault  (mut, PDA[FEE_VAULT_SEED, pool, base_mint],  authority=fee_claimer)
  quote_fee_vault (mut, PDA[FEE_VAULT_SEED, pool, quote_mint], authority=fee_claimer)
  base_mint, quote_mint
  fee_claimer (PDA[FEE_CLAIMER_SEED])
  token_base_program, token_quote_program
  remaining: [claimer_state, pending_base_vault, pending_quote_vault,
              claimer_base_ata, claimer_quote_ata] × N
```
