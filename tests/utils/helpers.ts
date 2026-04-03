import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  deriveClaimerStatePda,
  deriveClaimerPendingBaseVault,
  deriveClaimerPendingQuoteVault,
} from "./constant";

export { DBC_PROGRAM_ID, CP_AMM_PROGRAM_ID, WSOL_MINT } from "./constant";

export { wrapSol } from "./wsol";

const CLUSTER_URL = "http://localhost:8899";
export const connection = new Connection(CLUSTER_URL, "confirmed");
export const client = new DynamicBondingCurveClient(connection, "confirmed");
export const cpAmm = new CpAmm(connection);


/** `poolClaimersPda` is the PoolClaimers account address (not the DAMM pool pubkey). */
export async function fetchclaimerspdainfo(
  program: any,
  poolClaimersPda: PublicKey,
  toPrint: boolean = true,
) {
  const poolClaimersAccount = await program.account.poolClaimers.fetch(
    poolClaimersPda,
  );

  if (toPrint)
    console.log(
      "PoolClaimers account info:",
      JSON.stringify(
        {
          pool: poolClaimersAccount.pool.toBase58(),
          poolState: JSON.stringify(poolClaimersAccount.poolState),
          claimerAddresses: poolClaimersAccount.claimerAddresses.map(
            (c: PublicKey) => c.toBase58(),
          ),
          claimerBps: poolClaimersAccount.claimerBps,
          lastClaimed: poolClaimersAccount.lastClaimed.toString(),
          lastDistributed: poolClaimersAccount.lastDistributed.toString(),
          bump: poolClaimersAccount.bump,
        },
        null,
        2,
      ),
    );

  return poolClaimersAccount;
}

/** Fetch a ClaimerState PDA for a given pool + claimer. */
export async function fetchClaimerState(
  program: any,
  pool: PublicKey,
  claimer: PublicKey,
) {
  const pda = deriveClaimerStatePda(pool, claimer, program.programId);
  return program.account.claimerState.fetch(pda);
}

/**
 * Build the remaining accounts array for `initializePoolClaimers`.
 * Per claimer: [claimer_state_pda, pending_base_vault, pending_quote_vault]
 */
export function buildInitClaimersRemainingAccounts(
  pool: PublicKey,
  claimers: PublicKey[],
  programId: PublicKey,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return claimers.flatMap((claimer) => [
    { pubkey: deriveClaimerStatePda(pool, claimer, programId), isSigner: false, isWritable: true },
    { pubkey: deriveClaimerPendingBaseVault(pool, claimer, programId), isSigner: false, isWritable: true },
    { pubkey: deriveClaimerPendingQuoteVault(pool, claimer, programId), isSigner: false, isWritable: true },
  ]);
}

/**
 * Build the remaining accounts array for `distributeFees`.
 * Per claimer (5 accounts): [claimer_state_pda, pending_base_vault, pending_quote_vault, claimer_base_ata, claimer_quote_ata]
 */
export function buildDistributeFeesRemainingAccounts(
  pool: PublicKey,
  claimers: PublicKey[],
  baseMint: PublicKey,
  quoteMint: PublicKey,
  baseTokenProgram: PublicKey,
  quoteTokenProgram: PublicKey,
  programId: PublicKey,
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  return claimers.flatMap((claimer) => {
    const claimerStatePda = deriveClaimerStatePda(pool, claimer, programId);
    const pendingBaseVault = deriveClaimerPendingBaseVault(pool, claimer, programId);
    const pendingQuoteVault = deriveClaimerPendingQuoteVault(pool, claimer, programId);
    const claimerBaseAta = getAssociatedTokenAddressSync(baseMint, claimer, false, baseTokenProgram);
    const claimerQuoteAta = getAssociatedTokenAddressSync(quoteMint, claimer, false, quoteTokenProgram);
    return [
      { pubkey: claimerStatePda, isSigner: false, isWritable: true },
      { pubkey: pendingBaseVault, isSigner: false, isWritable: true },
      { pubkey: pendingQuoteVault, isSigner: false, isWritable: true },
      { pubkey: claimerBaseAta, isSigner: false, isWritable: true },
      { pubkey: claimerQuoteAta, isSigner: false, isWritable: true },
    ];
  });
}

export async function distribute_fees(
  program: any,
  payer: Keypair,
  pool: PublicKey,
  poolClaimersPda: PublicKey,
  baseFeeVault: PublicKey,
  quoteFeeVault: PublicKey,
  poolState: any,
  feeClaimerPda: PublicKey,
  baseTokenProgram: PublicKey,
  quoteTokenProgram: PublicKey,
  remainingAccounts: {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[],
): Promise<{ signature: string; success: boolean }> {
  const sig = await program.methods
    .distributeFees()
    .accounts({
      caller: payer.publicKey,
      pool,
      poolClaimers: poolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      baseMint: poolState.tokenAMint,
      quoteMint: poolState.tokenBMint,
      feeClaimer: feeClaimerPda,
      tokenBaseProgram: baseTokenProgram,
      tokenQuoteProgram: quoteTokenProgram,
    } as any)
    .remainingAccounts(remainingAccounts)
    .signers([payer])
    .rpc();

  return { signature: sig, success: true };
}
