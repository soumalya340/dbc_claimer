import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";

import { deriveFeeClaimerPda } from "./utils/constant";
import { DbcSwap } from "../target/types/dbc_swap";
import { setupConfigAndPool } from "./utils/createConfigAndPool";
import { fetchAllWalletNfts } from "./utils/nft_balance";
import { swap } from "./utils/swap";

import { assert } from "chai";
import { client, connection } from "./utils/helpers";

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

    // Need enough SOL to fill quote_reserve past 101 SOL threshold after fees (4% trading fee)
    // 101 / 0.96 ≈ 105.2 SOL minimum, using 110 to be safe
    await swap(payer, poolAddress, 110, false);

    // Verify pool state after swap
    const poolState = await client.state.getPool(poolAddress);
    console.log("Migration progress after swap:", poolState.migrationProgress);
    // 0 = PreBondingCurve, 1 = PostBondingCurve, 2 = LockedVesting, 3 = CreatedPool

    const cpAmmProgramId = new PublicKey(
      "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    );
    const cpAmmAccount = await connection.getAccountInfo(cpAmmProgramId);
    if (!cpAmmAccount) {
      throw new Error(
        "CP-AMM program not loaded on localnet — run `yarn start` first",
      );
    } else {
      console.log("CPMM program does exists ");
    }

    // This config has poolCreatorAuthority = DBC pool authority PDA (FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM)
    // Cloned from mainnet via `yarn start`. Required for DBC migration validation.
    // Dynamic config (configType=1) with DBC pool authority. Required for Customizable migration
    // which uses InitializePoolWithDynamicConfig CPI.
    const dammConfig = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

    // Fund the DBC pool authority PDA with SOL for flash rent during migration
    // The migration CPI uses pool_authority as payer to create DAMM V2 pool accounts
    const dbcProgramId = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
    const [poolAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      dbcProgramId,
    );
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: poolAuthority,
        lamports: anchor.web3.LAMPORTS_PER_SOL, // 1 SOL for flash rent
      }),
    );
    await sendAndConfirmTransaction(connection, fundTx, [payer]);
    console.log("Funded pool authority PDA with 1 SOL for flash rent");

    const tx = await client.migration.migrateToDammV2({
      payer: payer.publicKey,
      virtualPool: poolAddress,
      dammConfig,
    });

    const sig = await sendAndConfirmTransaction(connection, tx.transaction, [
      payer,
      tx.firstPositionNftKeypair,
      tx.secondPositionNftKeypair,
    ]);

    console.log("Migrate to DAMM V2 tx:", sig);

    const nftBalanceAfter = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    console.log("NFT balance after (fee claimer):", nftBalanceAfter);
    // assert.isTrue(nftBalanceAfter.length > nftBalance.length);
  });
});
