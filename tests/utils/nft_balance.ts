import { Connection, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata,
} from "@solana/spl-token";
import { Metaplex } from "@metaplex-foundation/js";
import { connection } from "./helpers";

async function getNftMetadata(
  connection: Connection,
  mintAddr: string,
  programId: PublicKey,
) {
  const metaplex = Metaplex.make(connection);
  const mint = new PublicKey(mintAddr);

  try {
    // CASE 1: Token-2022 (Native Metadata Extension)
    if (programId.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) {
      const meta = await getTokenMetadata(connection, mint);
      if (meta) {
        return { name: meta.name, symbol: meta.symbol, standard: "Token-2022" };
      }
    }

    const nft = await metaplex.nfts().findByMint({ mintAddress: mint });

    return {
      name: nft.name,
      symbol: nft.symbol,
      standard: "Legacy/Metaplex",
      uri: nft.uri, // The JSON link for the image/traits
    };
  } catch (e) {
    return { name: "Unknown", symbol: "???", error: "Metadata not found" };
  }
}

export async function fetchAllWalletNfts(walletAddress: string) {
  const owner = new PublicKey(walletAddress);

  // Fetch accounts from both programs
  const [legacy, t22] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    }),
    connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  ]);

  const allTokenAccounts = [...legacy.value, ...t22.value];

  const results = [];
  for (const account of allTokenAccounts) {
    const info = account.account.data.parsed.info;

    // Filter for NFTs (Amount 1, Decimals 0)
    if (info.tokenAmount.uiAmount === 1 && info.tokenAmount.decimals === 0) {
      const details = await getNftMetadata(
        connection,
        info.mint,
        TOKEN_2022_PROGRAM_ID,
      );
      results.push({
        mint: info.mint,
        ...details,
      });
    }
  }
  return results;
}
