import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";

import { deriveFeeClaimerPda } from "./constant";
import { DbcSwap } from "../target/types/dbc_swap";
import { setupConfigAndPool } from "./createConfigAndPool";
import { fetchAllWalletNfts } from "./nft_balance";
import { swap } from "./swap";
import { assert } from "chai";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

describe("dbc-swap:atomic-create-and-swap", () => {
  const user = provider.wallet;

  it("Dammv2 test cases", async () => {
    const user = provider.wallet;
    const payer = (user as any).payer;
    const config = Keypair.generate();
    console.log("Config:", config.publicKey.toBase58());

    const baseMint = Keypair.generate();

    const feeClaimerPda = deriveFeeClaimerPda(program.programId);

    const { poolAddress } = await setupConfigAndPool(
      payer,
      config,
      feeClaimerPda,
      101,
      baseMint,
    );

    const nftBalance = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    console.log("NFT balance before (fee claimer):", nftBalance);

    await swap(payer, poolAddress, 102, false);

    const nftBalanceAfter = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    console.log("NFT balance after (fee claimer):", nftBalanceAfter);
    // assert.isTrue(nftBalanceAfter.length > nftBalance.length);
  });
});
