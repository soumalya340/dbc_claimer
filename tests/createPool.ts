// @ts-nocheck
import { PublicKey, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CLUSTER_URL, loadKeypair, KEYPAIR_PATH } from "./createConfig";

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const connection = new Connection(CLUSTER_URL, "confirmed");

export async function createPool(
  wallet: Keypair,
  configAddress: PublicKey,
  baseMint: Keypair,
  name: string,
  symbol: string,
  uri: string,
): Promise<PublicKey> {
  const anchorWallet = new Wallet(wallet);
  const client = new DynamicBondingCurveClient(connection, "confirmed", anchorWallet);

  const tx = await client.pool.createPool({
    config: configAddress,
    baseMint: baseMint.publicKey,
    quoteMint: WSOL_MINT,
    name,
    symbol,
    uri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [wallet, baseMint],
    {
      skipPreflight: true,
      maxRetries: 3,
    },
  );

  // Get the actual pool address
  const pools = await client.state.getPoolsByConfig(configAddress);

  if (pools.length === 0) {
    throw new Error("No pools found for this config");
  }

  const poolAddress = pools[0].publicKey;

  console.log("\n");
  console.log("✅ Pool created! Tx:", signature);
  console.log("\n");

  return poolAddress;
}
