## DBC Swap

`dbc-swap` is an Anchor program that acts as a custody and distribution layer for token launch funds.
It integrates with both:

- DBC (`dynamic_bonding_curve`)
- DAMM v2 (`cp_amm`)

The goal is to make launch operations and post-launch fee handling easier for platforms and companies running launches.

## What Problem This Solves

When a coin launches, fees and treasury flows often need to be split across multiple parties (platform, referrals, partners, or internal teams).
Instead of manually collecting and distributing funds, this contract:

- holds claimable funds in program-owned vaults (custodian behavior),
- tracks who can claim per pool,
- splits distributions by configured BPS shares,
- and enables cleaner payouts to referral and partner addresses.

## How It Works

At a high level:

- DBC path: create pool and swap through CPI, then claim partner trading fees into this program's vaults.
- DAMM v2 path: claim position fees (and manage liquidity when needed), then move claimable value into the same vault distribution model.
- Distribution path: registered claimers withdraw their proportional share from the vault based on BPS configuration.

This design helps centralize fee accounting while still allowing transparent, rule-based payouts.

## PDA Seeds

The program derives three types of on-chain accounts using fixed seeds defined in `consts.rs`.
All PDAs are owned by this program — no external wallet can sign for them.

### `fee_claimer` — `b"fee_claimer"`

Derivation: `[b"fee_claimer"]`

A single global PDA that acts as the program's identity/signer. It is:

- registered as the `feeClaimer` in the DBC config at pool creation time,
- the position owner in DAMM v2 (cp_amm),
- used as the CPI signer when claiming fees from DBC/DAMM and when transferring funds out of vaults.

Derive off-chain: `PublicKey.findProgramAddressSync([Buffer.from("fee_claimer")], PROGRAM_ID)`

### `fee_vault` — `b"fee_vault"`

Derivation: `[b"fee_vault", pool_address, mint_address]`

A token account PDA created per pool per token (one for base, one for quote).
Claimed fees from DBC/DAMM land here first. Registered claimers then withdraw their BPS share from this vault.

Derive off-chain:

```ts
PublicKey.findProgramAddressSync(
  [Buffer.from("fee_vault"), pool.toBuffer(), mint.toBuffer()],
  PROGRAM_ID,
);
```

### `pool_claimers` — `b"pool_claimers"`

Derivation: `[b"pool_claimers", pool_address]`

A config account PDA created per pool. Stores:

- up to 5 claimer wallet addresses,
- each claimer's BPS share (must total 10,000),
- running totals of how much each claimer has already withdrawn (used to enforce entitlement caps).

Derive off-chain:

```ts
PublicKey.findProgramAddressSync(
  [Buffer.from("pool_claimers"), pool.toBuffer()],
  PROGRAM_ID,
);
```

## Claimer Configuration Rules

Before any fees can be distributed for a pool, the admin must call `set_pool_claimers` to register the payout list.

Rules enforced on-chain:

- BPS shares across all claimers **must sum to exactly 10,000** (i.e. 100%). Partial splits are rejected.
- Maximum **5 claimers** per pool.
- The number of addresses and BPS values passed must match in length.
- Only `ADMIN_ADDRESS` can call this instruction.

This instruction uses `init_if_needed`, meaning it can be called again to fully replace the claimer list for a pool. Each call **fully overwrites** the previous configuration and **resets all claimed amounts to zero** for that pool.

Example split (all values must add up to 10,000):
| Party | BPS | Percentage |
|-----------|-------|------------|
| Platform | 7000 | 70% |
| Referral | 2000 | 20% |
| Partner | 1000 | 10% |

### Updating BPS Shares — `update_claimers_bps`

If you only need to change the **fee split percentages** without touching the claimer list or historical records, use `update_claimers_bps` instead.

Differences from `set_pool_claimers`:
| | `set_pool_claimers` | `update_claimers_bps` |
|---|---|---|
| Updates claimer addresses | yes | no |
| Updates BPS shares | yes | yes |
| Resets claimed amounts | yes (to zero) | no (preserved) |
| Creates account if missing | yes (`init_if_needed`) | no (must already exist) |

Rules enforced:

- New BPS array length must match the existing number of claimers.
- New BPS values must still sum to exactly 10,000.
- Only `ADMIN_ADDRESS` can call this.

## Instruction Reference

### Admin-Only Instructions — `ADMIN_ADDRESS`

These require the transaction to be signed by `ADMIN_ADDRESS` (`cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF`).

| Instruction           | Path          | Description                                                                                     |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `set_pool_claimers`   | DBC / DAMM v2 | Register or replace the claimer list and BPS shares for a pool. Resets claimed amounts to zero. |
| `update_claimers_bps` | DBC / DAMM v2 | Update BPS shares only, preserving claimer addresses and claimed history.                       |

### Admin-Only Instructions — `LIQUIDITY_REMOVAL_AUTHORITY`

These require the transaction to be signed by `LIQUIDITY_REMOVAL_AUTHORITY` (`cyaibXfQvCC4qKDYNguU4mXryhKjSkszPWkd56KFkrF`).

| Instruction            | Path    | Description                                                                           |
| ---------------------- | ------- | ------------------------------------------------------------------------------------- |
| `remove_liquidity`     | DAMM v2 | Remove a specified amount of liquidity from a cp_amm position owned by `fee_claimer`. |
| `remove_all_liquidity` | DAMM v2 | Remove all liquidity from a cp_amm position owned by `fee_claimer`.                   |

### Permissionless Instructions

Anyone can call these — no signer restriction beyond paying transaction fees.

| Instruction                 | Path    | Description                                                                         |
| --------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `claim_partner_trading_fee` | DBC     | Sweep accrued partner trading fees from a DBC pool into this program's fee vaults.  |
| `claim_position_fee`        | DAMM v2 | Claim position fees from cp_amm into PDA-owned fee vaults.                          |
| `distribute_fees`           | DAMM v2 | Push the entire fee vault balance to all registered claimers proportionally by BPS. |

### Summary Table

| Key                           | Controls                              | Compromise Impact                                        | Severity                         |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| Program upgrade authority     | Entire program bytecode               | All funds drainable; every rule overwritten              | **Catastrophic**                 |
| `ADMIN_ADDRESS`               | Fee split configuration               | Future fees rerouted; existing vault balances safe       | Critical                         |
| `LIQUIDITY_REMOVAL_AUTHORITY` | LP position withdrawals               | Unlocked liquidity drained to attacker wallet            | Critical (if unlocked LP exists) |
| `fee_claimer` PDA             | CPI signer for all on-chain transfers | Not a keypair — derived by the program; cannot be stolen | N/A                              |

## Running Tests

Installation:

```bash
solana-test-validator \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  tests/programs/dbc.so
```

Run all tests:

```bash
anchor test --skip-local-validator
```

Run a specific test file:

```bash
anchor test --skip-local-validator --run tests/claim_fees.test.ts
```

Or using the underlying ts-mocha command directly:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/claim_fees.test.ts
```
