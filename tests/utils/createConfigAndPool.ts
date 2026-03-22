// @ts-nocheck
import {
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  BaseFeeMode,
  DammV2BaseFeeMode,
  buildCurve,
  getMigratedPoolMarketCapFeeSchedulerParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, client } from "./helpers";
import { readFileSync } from "fs";
import { BN } from "bn.js";

export const KEYPAIR_PATH = "/Users/soumalyapaul/.config/solana/id.json";

export function loadKeypair(filePath: string): Keypair {
  const raw = readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export async function setupConfigAndPool(
  wallet: Keypair,
  config: Keypair,
  feeclaimer: PublicKey,
  thresold: number,
  baseMint: Keypair,
  partnerPermanentLockedLiquidityPercentage_args: number = 40,
  partnerLiquidityPercentage_args: number = 0,
  creatorPermanentLockedLiquidityPercentage_args: number = 60,
  creatorLiquidityPercentage_args: number = 0,
  name: string = "Test",
  symbol: string = "TEST",
  uri: string = "",
  toPrintTransaction: boolean = false,
): Promise<{ poolAddress: PublicKey }> {
  // Starting fee of the pre-migration DBC pool — used as the starting point for the DAMMv2 fee scheduler
  const preMigrationEndingFeeBps = 500; // 5% — becomes the starting fee in DAMMv2 after migration
  // Target fee after the DAMMv2 market-cap scheduler completes all periods
  const postMigrationEndingFeeBps = 1; // 0.01% — final resting fee in DAMMv2
  // How the DAMMv2 fee decays: linearly as market cap grows across sqrtPrice steps
  const dammV2BaseFeeMode = DammV2BaseFeeMode.FeeTimeSchedulerLinear;

  // Precomputes the on-chain scheduler params (periodFrequency, reductionFactor) from human-readable inputs
  const migratedPoolMarketCapFeeSchedulerParams =
    getMigratedPoolMarketCapFeeSchedulerParams(
      preMigrationEndingFeeBps, // starting fee bps in DAMMv2 (500 = 5%)
      postMigrationEndingFeeBps, // ending fee bps in DAMMv2 (1 = 0.01%)
      dammV2BaseFeeMode,
      10, // numberOfPeriod — 10 steps to decay from 5% → 0.01%
      500, // sqrtPriceStepBps — each period triggered by a 5% sqrt-price move up
      86400 * 30, // schedulerExpirationDuration — scheduler expires after 30 days regardless
    );

  const curveConfig = buildCurve({
    token: {
      tokenType: 1, // Token2022
      tokenBaseDecimal: 9,
      tokenQuoteDecimal: 9,
      tokenUpdateAuthority: 1, // Immutable
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    // ─── PRE-MIGRATION DBC POOL FEE CONFIG ───────────────────────────────────
    fee: {
      baseFeeParams: {
        // FeeSchedulerExponential: fee can decay exponentially over time/slots.
        // With numberOfPeriod=0 & totalDuration=0 below, it acts as a flat fee.
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 400, // 4% fee at pool launch
          endingFeeBps: 400, // 4% — same as start, so fee is constant (no decay)
          numberOfPeriod: 0, // 0 periods = no scheduler steps, fee is flat
          totalDuration: 0, // 0 duration = scheduler never runs
        },
      },
      // No volatility-based dynamic fee surcharge on top of base fee
      dynamicFeeEnabled: false,
      // DBC-pool-specific collectFeeMode — controls ONLY this pre-migration pool's fee token.
      // 0 = CollectFeeMode.QuoteToken → DBC pool fees collected in SOL (quote token).
      // 1 = CollectFeeMode.OutputToken → fee token follows swap direction:
      //   buying base → fee in base token; selling base → fee in quote (SOL).
      collectFeeMode: 0,
      // 50% of the protocol trading fees are routed to the pool creator; 50% to partner
      creatorTradingFeePercentage: 50,
      // No upfront SOL fee required to create a pool under this config
      poolCreationFee: 0,
      // First swap uses the minimum possible fee — reduces sandwich/snipe risk at launch
      enableFirstSwapWithMinFee: true,
    },
    // ─── MIGRATION CONFIG ─────────────────────────────────────────────────────
    migration: {
      migrationOption: 1, // MigrationOption.MET_DAMM_V2 — migrate to DAMMv2
      migrationFeeOption: 6, // MigrationFeeOption.Customizable — use migratedPoolFee below
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }, // no one-time migration fee
      // ─── DAMMv2 POOL FEE CONFIG (post-migration) ────────────────────────────
      migratedPoolFee: {
        // DAMMv2-specific collectFeeMode — independent from the DBC pool's collectFeeMode (line 75).
        // 0 = CollectFeeMode.QuoteToken → DAMMv2 fees collected in SOL (quote token).
        // Each pool (DBC and DAMMv2) has its own collectFeeMode; changing one does NOT affect the other.
        collectFeeMode: 0,
        // 0 = DammV2DynamicFeeMode.Disabled — no volatility surcharge in DAMMv2
        dynamicFee: 0,
        // Starting pool fee in DAMMv2 immediately after migration (4%)
        // The market-cap scheduler will decay this down to endingBaseFeeBps over time
        poolFeeBps: 400,
        // DammV2BaseFeeMode.FeeTimeSchedulerLinear — fee decays linearly
        // as market cap grows (sqrt price moves up in steps of sqrtPriceStepBps)
        baseFeeMode: dammV2BaseFeeMode,
        marketCapFeeSchedulerParams: {
          // How many market-cap growth steps until fee reaches endingBaseFeeBps
          numberOfPeriod:
            migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
          // Each step is triggered when sqrt price rises by this many bps (5%)
          sqrtPriceStepBps:
            migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
          // Hard expiry: scheduler stops after 30 days even if periods aren't completed
          schedulerExpirationDuration:
            migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
          // Final fee bps once all periods complete or scheduler expires (0.01%)
          endingBaseFeeBps: postMigrationEndingFeeBps,
        },
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage:
        partnerPermanentLockedLiquidityPercentage_args,
      partnerLiquidityPercentage: partnerLiquidityPercentage_args,
      creatorPermanentLockedLiquidityPercentage:
        creatorPermanentLockedLiquidityPercentage_args,
      creatorLiquidityPercentage: creatorLiquidityPercentage_args,
      partnerLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
      creatorLiquidityVestingInfoParams: {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        totalDuration: 0,
      },
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: 1,
    percentageSupplyOnMigration: 20, // 20% of the total supply on migration to DAMMv2
    migrationQuoteThreshold: thresold, // 101 SOL  thresold  for graduation
  });

  const tx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: feeclaimer,
    leftoverReceiver: feeclaimer,
    payer: wallet.publicKey,
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
    ...curveConfig,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet, config],
    {
      skipPreflight: true,
      maxRetries: 3,
    },
  );
  if (toPrintTransaction) console.log("✅ Config created! Tx:", signature);

  const poolTx = await client.pool.createPool({
    config: config.publicKey,
    baseMint: baseMint.publicKey,
    quoteMint: new PublicKey("So11111111111111111111111111111111111111112"),
    name,
    symbol,
    uri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
  });

  const { blockhash: poolBlockhash } = await connection.getLatestBlockhash(
    "confirmed",
  );
  poolTx.feePayer = wallet.publicKey;
  poolTx.recentBlockhash = poolBlockhash;

  const poolSignature = await sendAndConfirmTransaction(
    connection,
    poolTx,
    [wallet, baseMint],
    {
      skipPreflight: true,
      maxRetries: 3,
    },
  );

  // Get the actual pool address
  const pools = await client.state.getPoolsByConfig(config.publicKey);

  if (pools.length === 0) {
    throw new Error("No pools found for this config");
  }

  const poolAddress = pools[0].publicKey;

  if (toPrintTransaction) console.log("✅ Pool created! Tx:", poolSignature);

  return { poolAddress };
}
