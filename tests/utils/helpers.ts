import { PublicKey, Connection } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

export { wrapSol } from "./wsol";
export { deriveAllPdas } from "./constant";

const CLUSTER_URL = "http://localhost:8899";
export const connection = new Connection(CLUSTER_URL, "confirmed");
export const client = new DynamicBondingCurveClient(connection, "confirmed");
export const cpAmm = new CpAmm(connection);

export const DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);

export const TOKEN_2022_PROGRAM_ID_PK = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
