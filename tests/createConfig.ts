// @ts-nocheck
import {
  PublicKey,
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  BaseFeeMode,
  DammV2BaseFeeMode,
  DynamicBondingCurveClient,
  buildCurve,
  getMigratedPoolMarketCapFeeSchedulerParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync } from "fs";
import { BN } from "bn.js";

export const CLUSTER_URL = "http://localhost:8899";
export const KEYPAIR_PATH = "/Users/soumalyapaul/.config/solana/id.json";

export function loadKeypair(filePath: string): Keypair {
  const raw = readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

const connection = new Connection(CLUSTER_URL, "confirmed");

export async function setupConfig(
  wallet: Keypair,
  config: Keypair,
  feeclaimer: PublicKey,
): Promise<void> {
  const client = new DynamicBondingCurveClient(connection, "confirmed");

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
          startingFeeBps: 100,
          endingFeeBps: 100,
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
      partnerPermanentLockedLiquidityPercentage: 40,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 60,
      creatorLiquidityPercentage: 0,
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
    migrationQuoteThreshold: 101, // 101 SOL  thresold  for graduation
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
}

// async function main() {
//   const wallet = loadKeypair(KEYPAIR_PATH);

//   console.log("Wallet:", wallet.publicKey.toBase58());

//   const config = Keypair.generate();
//   console.log("Generated config keypair:", config.publicKey.toBase58());

//   const balanceBefore = await connection.getBalance(wallet.publicKey);
//   console.log(`Balance: ${balanceBefore / LAMPORTS_PER_SOL} SOL`);

//   const configAddress = await setupConfig(wallet, config);

//   const balanceAfter = await connection.getBalance(wallet.publicKey);
//   console.log(`Cost: ${(balanceBefore - balanceAfter) / LAMPORTS_PER_SOL} SOL`);
// }

// main().catch(console.error);
