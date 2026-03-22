import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { type PoolState, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { cpAmm, connection } from "./helpers";

export async function dammV2Swap(
  payer: Keypair,
  pool: PublicKey,
  // Full on-chain pool state — caller fetches once and passes in to avoid extra RPC calls
  poolState: PoolState,
  amountIn: number,
  swapBaseForQuote: boolean,
): Promise<string> {
  const lamportsIn = new BN(amountIn * LAMPORTS_PER_SOL);

  const inputTokenMint = swapBaseForQuote
    ? poolState.tokenAMint // selling base
    : poolState.tokenBMint; // selling quote (SOL)

  const outputTokenMint = swapBaseForQuote
    ? poolState.tokenBMint // receiving quote
    : poolState.tokenAMint; // receiving base

  const swapTx = await cpAmm.swap({
    payer: payer.publicKey,
    pool,
    inputTokenMint,
    outputTokenMint,
    amountIn: lamportsIn,
    minimumAmountOut: new BN(0),
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    referralTokenAccount: null,
  });

  const txSignature = await sendAndConfirmTransaction(
    connection,
    swapTx,
    [payer],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log("DAMMv2 swap tx:", txSignature);
  return txSignature;
}
