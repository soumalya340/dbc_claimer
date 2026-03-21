# Lessons Learned: DBC → DAMM V2 Migration

## The Full Bug Journey (and how each was fixed)

---

### Bug 1: InvalidConfigAccount (Error 6024)

**What happened:**
The test used `cpAmm.getStaticConfigs()[0]` to pick a DAMM V2 config. This returns any _public_ config where `poolCreatorAuthority = default (all zeros)`. But the DBC migration program validates:

```rust
require!(
    damm_config.pool_creator_authority == const_pda::pool_authority::ID,
    PoolError::InvalidConfigAccount
);
```

It needs the config's `poolCreatorAuthority` to equal the **DBC program's own pool authority PDA** — a special address derived from `["pool_authority"]` seed + DBC program ID.

**Fix:**
Query mainnet for all cp-amm configs, filter by `poolCreatorAuthority == DBC pool authority PDA`:

```js
const dbcPoolAuthority = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
const allConfigs = await cpAmm.getAllConfigs();
const matching = allConfigs.filter(
  (c) => c.account.poolCreatorAuthority.toBase58() === dbcPoolAuthority,
);
```

Found these 7 configs on mainnet with the right authority:

- `DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u` (600 bps, Static)
- `2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq` (200 bps, Static)
- `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` (Dynamic config)
- `2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k` (30 bps, Static)
- `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD` (400 bps, Static)
- `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` (100 bps, Static)
- `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` (25 bps, Static)

**Rule for choosing which config to clone:**

- `migrationFeeOption: 0-5` (FixedBps) → use the Static config matching your fee (e.g. FixedBps400 → `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD`)
- `migrationFeeOption: 6` (Customizable) → must use the **Dynamic** config (`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`) because the migration CPI calls `InitializePoolWithDynamicConfig`

Add to `yarn start` with `--clone <configAccount>`.

---

### Bug 2: NotPermitToDoThisAction (Error 6022) — Pool stuck at PreBondingCurve

**What happened:**
After the swap, `migration_progress = 0` (PreBondingCurve). The migration requires `migration_progress == 2` (LockedVesting).

The pool state machine:

```
PreBondingCurve (0) → LockedVesting (2) → CreatedPool (3)   [no locked vesting]
PreBondingCurve (0) → PostBondingCurve (1) → LockedVesting (2) → CreatedPool (3)   [with locked vesting]
```

The curve only graduates (moves to LockedVesting) when `quote_reserve >= migration_quote_threshold`. With a 4% trading fee, 102 SOL input only puts ~98 SOL into the reserve — not enough to hit the 101 SOL threshold.

**Fix:** Increase swap amount. With fee `f`, you need: `amount_in > threshold / (1 - fee_rate)`

- 101 SOL / (1 - 0.04) ≈ 105.2 SOL minimum → use 110 SOL to be safe.

**Debug tip:** After swap, check pool state:

```ts
const poolState = await client.state.getPool(poolAddress);
console.log("Migration progress:", poolState.migrationProgress);
// 0=PreBonding, 1=PostBonding, 2=LockedVesting, 3=CreatedPool
```

---

### Bug 3: InsufficientLiquidity (Error 6033)

**What happened:**
The old `client.pool.swap()` (V1) uses ExactIn mode — if your input exceeds what the bonding curve can absorb, it fails. Sending 110 SOL when the curve only needs ~105 caused this.

**Fix:** Use `client.pool.swap2()` with `swapMode: 1` (PartialFill). It fills the curve up to its limit and refunds the leftover automatically.

```ts
// WRONG - V1 swap, no PartialFill support
await client.pool.swap({ amountIn, ... });

// CORRECT - V2 swap with PartialFill
await client.pool.swap2({ amountIn, swapMode: 1, minimumAmountOut: new BN(0), ... });
```

**Swap modes:**

- `0` = ExactIn — spends exactly amountIn, fails if curve can't absorb it
- `1` = PartialFill — spends up to amountIn, fills what it can, refunds rest
- `2` = ExactOut — specify how much output you want

---

### Bug 4: Insufficient lamports 0, need 2770080 — Flash Rent

**What happened:**
For `migrationFeeOption: 6` (Customizable), the DBC migration CPIs into cp-amm's `InitializePoolWithDynamicConfig`. The **pool authority PDA** is used as the payer for creating the new pool accounts. But it has 0 SOL.

**What is flash rent?**
Flash rent is a pattern where a PDA "borrows" SOL temporarily to pay for account creation:

```
1. Record pool_authority's SOL balance before
2. Create the pool (pool_authority spends SOL on rent)
3. Record pool_authority's SOL balance after
4. Calculate how much was spent = before - after
5. Transfer that amount FROM payer BACK TO pool_authority
```

The problem: step 2 fails immediately if pool_authority starts with 0 SOL — it can't spend what it doesn't have.

**Fix:** Manually fund the DBC pool authority PDA with 1 SOL before migration:

```ts
const dbcProgramId = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);
const [poolAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_authority")],
  dbcProgramId,
);
const fundTx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: poolAuthority,
    lamports: LAMPORTS_PER_SOL, // 1 SOL
  }),
);
await sendAndConfirmTransaction(connection, fundTx, [payer]);
```

---

## How to read config.json (Meteora's cp-amm configs)

```json
{
  "index": 0,
  "baseFeeValue": 2500000,      ← fee numerator: 2500000 / 1_000_000_000 = 25 bps = 0.25%
  "baseFee": {
    "cliffFeeNumerator": 2500000,
    "numberOfPeriod": 0,        ← 0 means flat fee, no decay schedule
    "reductionFactor": 0,
    "periodFrequency": 0,
    "feeSchedulerMode": 0       ← 0=FeeTimeSchedulerLinear
  },
  "collectFeeMode": 0,          ← 0=BothToken (fees in both tokens), 1=OnlyTokenB
  "dynamicFee": true,           ← true = Dynamic config (configType=1), false = Static (configType=0)
  "configAccount": "8CNy9..."   ← on-chain address to use / clone
}
```

**config.json does NOT show `poolCreatorAuthority`** — you have to query on-chain for that.

**Fee numerator → BPS conversion:**
`bps = cliffFeeNumerator * 10_000 / 1_000_000_000`

- 2500000 → 25 bps (0.25%)
- 3000000 → 30 bps (0.30%)
- 10000000 → 100 bps (1%)
- 40000000 → 400 bps (4%)

---

## Quick Reference: Migration Fee Options

| Value | Name         | Required DAMM V2 Config                                                               |
| ----- | ------------ | ------------------------------------------------------------------------------------- |
| 0     | FixedBps25   | Static, 25 bps                                                                        |
| 1     | FixedBps30   | Static, 30 bps                                                                        |
| 2     | FixedBps100  | Static, 100 bps                                                                       |
| 3     | FixedBps200  | Static, 200 bps                                                                       |
| 4     | FixedBps400  | Static, 400 bps                                                                       |
| 5     | FixedBps600  | Static, 600 bps                                                                       |
| 6     | Customizable | Dynamic config (`A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck`) + fund pool authority |

---

## Key Addresses

| Name                                                | Address                                        |
| --------------------------------------------------- | ---------------------------------------------- |
| DBC Program                                         | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`  |
| CPMM Program                                        | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`  |
| DBC Pool Authority PDA                              | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| Dynamic DAMM V2 Config (for Customizable migration) | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` |

---

## Localnet Setup Checklist

1. `yarn start` — starts validator with all required programs and accounts cloned
2. Verify `--clone` includes the right DAMM V2 config account for your migration fee option
3. Fund DBC pool authority PDA with 1 SOL before calling `migrateToDammV2` (Customizable only)
4. Use `swap2` with `swapMode: 1` (PartialFill) when swapping enough to graduate a pool
5. Swap amount must be `> threshold / (1 - fee_rate)` to actually fill the curve

What was the issue?
There were 4 separate problems, each fixed one by one:

Problem 1: Wrong DAMM V2 config account
You were using getStaticConfigs()[0] which returns any public config where poolCreatorAuthority = default (all zeros). But the DBC migration program checks that the config's poolCreatorAuthority must equal the DBC program's own pool authority PDA (FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM). So any random public config would always fail.

Problem 2: Swap didn't fill the bonding curve
You swapped 102 SOL but the pool needs quote_reserve >= 101 SOL — that's the SOL actually sitting in the vault after fees. With 4% fees, 102 SOL input only puts ~98 SOL in the vault. Not enough to trigger graduation.

Problem 3: Swap used ExactIn mode
The old swap() v1 rejects if your input exceeds available liquidity. Sending 110 SOL when the curve only needs ~105 caused InsufficientLiquidity. The fix was swap2() with PartialFill mode — it fills what it can and refunds the rest.

Problem 4: Pool authority had no SOL
For Customizable migration (option 6), the DBC program CPIs into the cp-amm to create a pool, and it uses the DBC pool authority PDA as the payer for account creation rent. But that PDA had 0 lamports. We had to manually send 1 SOL to it first.

2. How was it solved?
   Step Fix
   Wrong config Queried mainnet for configs with poolCreatorAuthority = DBC pool authority. Found A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck (Dynamic, configType=1, required for Customizable migration). Added it to --clone in yarn start.
   Swap amount Increased from 102 → 110 SOL
   Swap mode Changed client.pool.swap() → client.pool.swap2({ swapMode: 1 }) (PartialFill)
   Pool authority funding Added a SOL transfer to the DBC pool authority PDA before calling migrateToDammV2
3. How to read config.json to know which DAMM V2 config to use
   The config.json is Meteora's cp-amm (DAMM V2) configs from mainnet. Here's how to decode it:

{
"index": 0,
"baseFeeValue": 2500000, ← fee numerator (2500000 / 1_000_000_000 = 0.25% = 25 bps)
"baseFee": {
"cliffFeeNumerator": 2500000,
"numberOfPeriod": 0, ← 0 means flat fee, no schedule
"reductionFactor": 0,
"periodFrequency": 0,
"feeSchedulerMode": 0 ← 0=FeeTimeSchedulerLinear
},
"collectFeeMode": 0, ← 0=BothToken, 1=OnlyTokenB
"dynamicFee": true, ← whether dynamic fee is on
"configAccount": "8CNy9..." ← the on-chain address to clone/use
}
For your setup with migrationFeeOption: 6 (Customizable):

You need dynamicFee: true → means configType: 1 (Dynamic config)
You need the config to have poolCreatorAuthority = FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (not visible in config.json — you have to check on-chain)
The fee value in config.json doesn't matter for Customizable since DBC builds the fee from your migratedPoolFee settings
The one we ended up using (A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck) is NOT in your config.json — we found it by querying mainnet for all configs with the right poolCreatorAuthority.

4. What is flash rent?
   Think of it like a flash loan but for SOL rent.

On Solana, creating a new account costs SOL (rent). The migration needs to create a new DAMM V2 pool account, and it uses the DBC pool authority PDA as the payer. But that PDA has no money.

flash_rent works like this:

1. Record how much SOL pool_authority has right now
2. Do the CPI (create the pool — spends pool_authority's SOL on rent)
3. Record how much SOL pool_authority has now
4. The difference = what was spent on rent
5. Transfer that exact amount FROM payer TO pool_authority to reimburse it
   It's like borrowing money for a split second to pay for something, then immediately paying it back.

The bug: flash_rent records the SOL before and after the operation to calculate the refund. But if pool_authority starts with 0 SOL, step 2 fails immediately because it tries to spend SOL it doesn't have — before the refund logic even runs. So we had to pre-fund it with 1 SOL ourselves.
