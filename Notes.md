| Function                                 | Signers                   | Key Accounts                               | Main Purpose               |
| ---------------------------------------- | ------------------------- | ------------------------------------------ | -------------------------- |
| `claim_creator_trading_fee`              | creator                   | pool_authority, pool, vaults               | Creator claims fees        |
| `claim_protocol_fee`                     | operator                  | config, pool, vaults                       | Protocol claims fees       |
| `claim_trading_fee`                      | fee_claimer               | config, pool, vaults                       | Claim trading fees         |
| `close_claim_fee_operator`               | admin                     | claim_fee_operator                         | Close operator account     |
| `create_claim_fee_operator`              | admin                     | operator                                   | Create operator            |
| `create_config`                          | payer                     | fee_claimer, leftover_receiver, quote_mint | Create pool config         |
| `create_locker`                          | payer                     | virtual_pool, escrow                       | Create vesting locker      |
| `create_partner_metadata`                | payer, fee_claimer        | partner_metadata                           | Partner metadata           |
| `create_virtual_pool_metadata`           | payer, creator            | virtual_pool_metadata                      | Pool metadata              |
| `creator_withdraw_surplus`               | creator                   | virtual_pool, vaults                       | Creator withdraws surplus  |
| `initialize_virtual_pool_with_spl_token` | creator, payer, base_mint | config, pool, vaults                       | Create SPL token pool      |
| `initialize_virtual_pool_with_token2022` | creator, payer, base_mint | config, pool, vaults                       | Create Token2022 pool      |
| `migrate_meteora_damm`                   | payer                     | virtual_pool, damm accounts                | Migrate to DAMM v1         |
| `migrate_meteora_damm_claim_lp_token`    | sender                    | migration_metadata, lp_mint                | Claim LP tokens            |
| `migrate_meteora_damm_lock_lp_token`     | -                         | migration_metadata, lock_escrow            | Lock LP tokens             |
| `migration_damm_v2`                      | payer                     | virtual_pool, damm v2 accounts             | Migrate to DAMM v2         |
| `migration_damm_v2_create_metadata`      | -                         | virtual_pool, metadata                     | Create v2 metadata         |
| `migration_meteora_damm_create_metadata` | payer                     | virtual_pool, metadata                     | Create v1 metadata         |
| `partner_withdraw_surplus`               | fee_claimer               | virtual_pool, vaults                       | Partner withdraws surplus  |
| `protocol_withdraw_surplus`              | -                         | virtual_pool, vaults                       | Protocol withdraws surplus |
| `swap`                                   | payer                     | pool, vaults, token accounts               | Execute swap               |
| `swap2`                                  | payer                     | pool, vaults, token accounts               | Execute swap v2            |
| `transfer_pool_creator`                  | creator                   | virtual_pool, new_creator                  | Transfer creator rights    |
| `withdraw_lamports_from_pool_authority`  | -                         | pool_authority, receiver                   | Withdraw SOL               |
| `withdraw_leftover`                      | -                         | virtual_pool, vaults                       | Withdraw leftover tokens   |
| `withdraw_migration_fee`                 | sender                    | virtual_pool, vaults                       | Withdraw migration fee     |

---

## **1. `swap`**

**Purpose**: Execute a token swap (TRADING BOT FUNCTION)

### Signers Required:

- ✅ `payer`

### Accounts Required:

| Account                  | Constraints                                           | Description                         |
| ------------------------ | ----------------------------------------------------- | ----------------------------------- |
| `pool_authority`         | Fixed: `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` | Pool authority PDA                  |
| `config`                 | Related to pool                                       | Config key                          |
| `pool`                   | Writable                                              | Pool account                        |
| `input_token_account`    | Writable                                              | User token account for input token  |
| `output_token_account`   | Writable                                              | User token account for output token |
| `base_vault`             | Writable, related to pool                             | Vault for base token                |
| `quote_vault`            | Writable, related to pool                             | Vault for quote token               |
| `base_mint`              |                                                       | Mint of base token                  |
| `quote_mint`             |                                                       | Mint of quote token                 |
| `payer`                  | **SIGNER**                                            | User performing the swap            |
| `token_base_program`     |                                                       | Token base program                  |
| `token_quote_program`    |                                                       | Token quote program                 |
| `referral_token_account` | Writable, **optional**                                | Referral token account              |
| `event_authority`        | PDA                                                   | Event authority                     |
| `program`                |                                                       | Self-reference                      |

### Parameters:

```json
{
  "params": {
    "amount_in": "u64", // Input amount
    "minimum_amount_out": "u64" // Minimum output (slippage protection)
  }
}
```

---

## **2. `initialize_virtual_pool_with_token2022`**

**Purpose**: Create Token-2022 pool (POOL CREATOR FUNCTION)

### Signers Required:

- ✅ `creator`
- ✅ `payer`
- ✅ `base_mint`

### Accounts Required:

| Account               | Constraints                                                | Description                                        |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `config`              |                                                            | Which config the pool belongs to                   |
| `pool_authority`      | Fixed: `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`      | Pool authority PDA                                 |
| `creator`             | **SIGNER**                                                 | Pool creator                                       |
| `base_mint`           | **SIGNER**, writable                                       | Unique token mint address, initialized in contract |
| `quote_mint`          | Related to config                                          | Quote token mint                                   |
| `pool`                | Writable                                                   | Pool state account                                 |
| `base_vault`          | Writable, PDA (seeds: `["token_vault", base_mint, pool]`)  | Token A vault                                      |
| `quote_vault`         | Writable, PDA (seeds: `["token_vault", quote_mint, pool]`) | Token quote vault                                  |
| `payer`               | **SIGNER**, writable                                       | Pays for account creation                          |
| `token_quote_program` |                                                            | Quote token program                                |
| `token_program`       | Fixed: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`       | **Token-2022 program**                             |
| `system_program`      | Fixed: `11111111111111111111111111111111`                  | System program                                     |
| `event_authority`     | PDA                                                        | Event authority                                    |
| `program`             |                                                            | Self-reference                                     |

### Parameters:

```json
{
  "params": {
    "name": "string", // Token name
    "symbol": "string", // Token symbol
    "uri": "string" // Metadata URI
  }
}
```

---

## **Fixed Addresses Used**

| Role               | Address                                        |
| ------------------ | ---------------------------------------------- |
| Pool Authority     | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| Token-2022 Program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`  |
| System Program     | `11111111111111111111111111111111`             |
