import { PublicKey, Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import * as anchor from "@coral-xyz/anchor";

export { wrapSol } from "./wsol";
export { deriveAllPdas } from "./constant";

const CLUSTER_URL = "http://localhost:8899";
export const connection = new Connection(CLUSTER_URL, "confirmed");
export const client = new DynamicBondingCurveClient(connection, "confirmed");
export const cpAmm = new CpAmm(connection);

export const DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);

export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
export const CP_AMM_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
);

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
          claimedBase: poolClaimersAccount.claimedBase.map((n: anchor.BN) =>
            n.toString(),
          ),
          claimedQuote: poolClaimersAccount.claimedQuote.map((n: anchor.BN) =>
            n.toString(),
          ),
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
