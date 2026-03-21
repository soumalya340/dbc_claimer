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
): Promise<{ poolAddress: PublicKey }> {
  const preMigrationEndingFeeBps = 500;
  const postMigrationEndingFeeBps = 1;
  const dammV2BaseFeeMode = DammV2BaseFeeMode.FeeTimeSchedulerLinear;

  const migratedPoolMarketCapFeeSchedulerParams =
    getMigratedPoolMarketCapFeeSchedulerParams(
      preMigrationEndingFeeBps,
      postMigrationEndingFeeBps,
      dammV2BaseFeeMode,
      10, // numberOfPeriod
      500, // sqrtPriceStepBps (5%)
      86400 * 30, // 30 days
    );

  const curveConfig = buildCurve({
    token: {
      tokenType: 1,
      tokenBaseDecimal: 9,
      tokenQuoteDecimal: 9,
      tokenUpdateAuthority: 1,
      totalTokenSupply: 1_000_000_000,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: 400,
          endingFeeBps: 400,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0,
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: 1,
      migrationFeeOption: 6,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: 400,
        baseFeeMode: dammV2BaseFeeMode,
        marketCapFeeSchedulerParams: {
          numberOfPeriod:
            migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
          sqrtPriceStepBps:
            migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
          schedulerExpirationDuration:
            migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
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

  console.log("\n");
  console.log("✅ Config created! Tx:", signature);
  console.log("Config address:", config.publicKey.toBase58());
  console.log("\n");

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

  console.log("\n");
  console.log("✅ Pool created! Tx:", poolSignature);
  console.log("\n");

  const threshold = await client.state.getPoolMigrationQuoteThreshold(
    poolAddress,
  );
  console.log(`The migration threshold is ${Number(threshold) / LAMPORTS_PER_SOL} SOL`);

  return { poolAddress };
}
