import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  getTokenProgram,
  getUnClaimLpFee,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

import {
  deriveCpAmmFeeVaults,
  deriveCpAmmEventAuthority,
} from "../utils/constant";
import { setupConfigAndPool } from "../utils/createConfigAndPool";
import { swap } from "../utils/swap";
import { dammV2Swap } from "../utils/damm_v2_swap";
import { connection, client, DBC_PROGRAM_ID } from "../utils/helpers";
import type { DbcSwap } from "../../target/types/dbc_swap";

export async function createRandomKeyPair(amount: number): Promise<Keypair> {
  const randomKeypair = Keypair.generate();
  const airdropSig = await connection.requestAirdrop(
    randomKeypair.publicKey,
    amount * anchor.web3.LAMPORTS_PER_SOL,
  );
  await connection.confirmTransaction(airdropSig, "confirmed");
  return randomKeypair;
}

export async function setupPoolAndMigrate(
  payer: Keypair,
  feeClaimerPda: PublicKey,
  partnerPermanentLockedLiquidityPercentage_args: number = 40,
  partnerLiquidityPercentage_args: number = 0,
  creatorPermanentLockedLiquidityPercentage_args: number = 60,
  creatorLiquidityPercentage_args: number = 0,
  creatorTradingFeeInsideDbc: number = 50,
) {
  const config = Keypair.generate();

  const baseMint = Keypair.generate();

  const { poolAddress } = await setupConfigAndPool(
    payer,
    config,
    feeClaimerPda,
    101,
    baseMint,
    partnerPermanentLockedLiquidityPercentage_args,
    partnerLiquidityPercentage_args,
    creatorPermanentLockedLiquidityPercentage_args,
    creatorLiquidityPercentage_args,
    creatorTradingFeeInsideDbc,
  );

  // Need enough SOL to fill quote_reserve past 101 SOL threshold after fees (4% trading fee)
  // 101 / 0.96 ≈ 105.2 SOL minimum, using 110 to be safe
  await swap(payer, poolAddress, 110, false);

  const dammConfig = new PublicKey(
    "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
  );

  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    DBC_PROGRAM_ID,
  );
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: poolAuthority,
      lamports: anchor.web3.LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(connection, fundTx, [payer]);

  const tx = await client.migration.migrateToDammV2({
    payer: payer.publicKey,
    virtualPool: poolAddress,
    dammConfig,
  });

  await sendAndConfirmTransaction(connection, tx.transaction, [
    payer,
    tx.firstPositionNftKeypair,
    tx.secondPositionNftKeypair,
  ]);

  return {
    config,
    baseMint,
    poolAddress,
    firstPositionNftMint: tx.firstPositionNftKeypair.publicKey,
    secondPositionNftMint: tx.secondPositionNftKeypair.publicKey,
  };
}

export async function getPositionInfo(positionNftMint: PublicKey): Promise<{
  unlocked: BN;
  permLocked: BN;
  feeTokenA: BN;
  feeTokenB: BN;
}> {
  const cpAmm = new CpAmm(connection);
  const position = derivePositionAddress(positionNftMint);
  const s = await cpAmm.fetchPositionState(position);
  const poolState = await cpAmm.fetchPoolState(s.pool);

  const unlocked = s.unlockedLiquidity as unknown as BN;
  const permLocked = s.permanentLockedLiquidity as unknown as BN;

  const { feeTokenA, feeTokenB } = getUnClaimLpFee(poolState, s);

  return { unlocked, permLocked, feeTokenA, feeTokenB };
}

export async function claimPositionFeeModule(
  payer: Keypair,
  dammV2Pool: PublicKey,
  poolState: any,
  amount: number,
  position: PublicKey,
  positionNftMint: PublicKey,
  poolClaimersPda: PublicKey,
  program: Program<DbcSwap>,
  feeClaimerPda: PublicKey,
  toPrintPositionDetails: boolean = true,
): Promise<{ signature: string; success: boolean }> {
  const cpAmmPoolAuthority = derivePoolAuthority();
  const positionNftAccount = derivePositionNftAccount(positionNftMint);

  await dammV2Swap(payer, dammV2Pool, poolState, amount, false);

  if (toPrintPositionDetails) {
    const { feeTokenB } = await getPositionInfo(positionNftMint);
    console.log("FeeTokenB:", feeTokenB.toString());
  }

  const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
    dammV2Pool,
    poolState.tokenAMint,
    poolState.tokenBMint,
    program.programId,
  );

  const cpAmmEventAuthority = deriveCpAmmEventAuthority(CP_AMM_PROGRAM_ID);

  const sig = await program.methods
    .claimPositionFee()
    .accounts({
      poolAuthority: cpAmmPoolAuthority,
      pool: dammV2Pool,
      poolClaimers: poolClaimersPda,
      position,
      baseFeeVault,
      quoteFeeVault,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      positionNftAccount,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      eventAuthority: cpAmmEventAuthority,
      cpAmmProgram: CP_AMM_PROGRAM_ID,
      payer: payer.publicKey,
      feeClaimer: feeClaimerPda,
    } as any)
    .signers([payer])
    .rpc();

  return { signature: sig, success: true };
}
