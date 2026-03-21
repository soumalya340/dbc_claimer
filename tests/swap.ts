import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { wrapSol } from "./wsol";

const CLUSTER_URL = "http://localhost:8899";
const connection = new Connection(CLUSTER_URL, "confirmed");

// ─── types ───────────────────────────────────────────────────────────────────

export interface SwapResult {
  txSignature: string;
  amountIn: string;
  baseDelta: number;
  quoteDelta: number;
}

// ─── internal helpers ────────────────────────────────────────────────────────

async function ensureAta(
  connection: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);

  if (!(await connection.getAccountInfo(ata))) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        tokenProgram,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
  }

  return ata;
}

async function getUiBalance(
  connection: Connection,
  ata: PublicKey,
): Promise<number> {
  return connection
    .getTokenAccountBalance(ata)
    .then((r) => r.value.uiAmount ?? 0)
    .catch(() => 0);
}

// ─── exported swap function ──────────────────────────────────────────────────

/**
 * Swap tokens on a Meteora Dynamic Bonding Curve pool.
 *
 * @example
 * // Buy base tokens with 0.1 SOL
 * const result = await swap({
 *   clusterUrl: "http://localhost:8899",
 *   payer: myKeypair,
 *   poolAddress: "ABC...XYZ",
 *   amountIn: 0.1,
 *   swapBaseForQuote: false,
 * });
 *
 * @example
 * // Sell base tokens (1 000 units) for SOL
 * const result = await swap({
 *   clusterUrl: "http://localhost:8899",
 *   payer: myKeypair,
 *   poolAddress: "ABC...XYZ",
 *   amountIn: 1000,
 *   swapBaseForQuote: true,
 * });
 */
export async function swap(
  payer: Keypair,
  poolAddress: PublicKey,
  amountInRaw: number,
  swapBaseForQuote: boolean,
): Promise<SwapResult> {
  let referralTokenAccount = null;

  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const poolPk = new PublicKey(poolAddress);
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

  // ── 1. Pool + config state ─────────────────────────────────────────────────
  const virtualPoolState = await client.state.getPool(poolPk);
  const poolConfigState = await client.state.getPoolConfig(
    virtualPoolState.config,
  );

  const baseMint = virtualPoolState.baseMint as PublicKey;

  // Detect base token program from the mint's on-chain owner
  const baseMintInfo = await connection.getAccountInfo(baseMint);
  if (!baseMintInfo)
    throw new Error(`Base mint not found: ${baseMint.toBase58()}`);

  const isToken2022 =
    baseMintInfo.owner.toBase58() ===
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const baseTokenProgram = isToken2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  // ── 2. Convert amountIn to lamports / raw units ───────────────────────────
  const amountInBN = new BN(Math.round(amountInRaw * LAMPORTS_PER_SOL));

  // ── 3. Prepare ATAs ────────────────────────────────────────────────────────
  let wsolAta: PublicKey;

  if (swapBaseForQuote) {
    // Selling — just make sure the WSOL ATA exists to receive proceeds
    wsolAta = await ensureAta(
      connection,
      payer,
      payer.publicKey,
      WSOL,
      TOKEN_PROGRAM_ID,
    );
  } else {
    // Buying — wrap SOL first
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer),
      anchor.AnchorProvider.defaultOptions(),
    );
    wsolAta = await wrapSol(provider, payer, amountInRaw);
  }

  const baseAta = await ensureAta(
    connection,
    payer,
    payer.publicKey,
    baseMint,
    baseTokenProgram,
  );

  // ── 5. Record balances before ─────────────────────────────────────────────
  const baseBefore = await getUiBalance(connection, baseAta);
  const quoteBefore = await getUiBalance(connection, wsolAta);

  // ── 6. Execute swap ───────────────────────────────────────────────────────
  const swapTx = await client.pool.swap({
    owner: payer.publicKey,
    amountIn: amountInBN,
    minimumAmountOut: new BN(0),
    swapBaseForQuote,
    pool: poolPk,
    referralTokenAccount,
    payer: payer.publicKey,
  });

  const txSignature = await sendAndConfirmTransaction(
    connection,
    swapTx,
    [payer],
    { skipPreflight: false, commitment: "confirmed" },
  );

  // ── 7. Record balances after ──────────────────────────────────────────────
  const baseAfter = await getUiBalance(connection, baseAta);
  const quoteAfter = await getUiBalance(connection, wsolAta);

  return {
    txSignature,
    amountIn: amountInBN.toString(),
    baseDelta: baseAfter - baseBefore,
    quoteDelta: quoteAfter - quoteBefore,
  };
}
