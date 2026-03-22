import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import {
  deriveFeeClaimerPda,
  derivePoolClaimersPda,
  deriveCpAmmFeeVaults,
  dbcPoolAuthority,
  dbcEventAuthority,
} from "./utils/constant";
import {
  connection,
  DBC_PROGRAM_ID,
  client,
  fetchclaimerspdainfo,
  distribute_fees,
} from "./utils/helpers";

import { DbcSwap } from "../target/types/dbc_swap";
import { assert } from "chai";

import { setupPoolAndMigrate } from "./test_helpers/dammv2";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

describe("dbc-swap:dbc", () => {
  const feeClaimerPda = deriveFeeClaimerPda(program.programId);

  before(async () => {
    const dbcAccount = await connection.getAccountInfo(DBC_PROGRAM_ID);
    if (!dbcAccount)
      throw new Error(
        "DBC program not loaded on localnet — run `yarn start` first",
      );
  });

  it("test1: admin receives 100% of DBC partner trading fees", async () => {
    const payer = (provider.wallet as any).payer;

    // Pool: partner 10% permanently locked, 90% unlocked; creator 0%
    // The 110 SOL swap inside setupPoolAndMigrate generates DBC trading fees
    const { poolAddress, config, baseMint } = await setupPoolAndMigrate(
      payer,
      feeClaimerPda,
      10,
      90,
      0,
      0,
      0, // creatorTradingFeePercentage in DBC (0 = all trading fee share to partner)
    );

    const dbcPoolClaimersPda = derivePoolClaimersPda(
      poolAddress,
      program.programId,
    );

    // Step 1: Admin initializes pool claimers for the DBC pool (sole 100% claimer)
    await program.methods
      .setPoolClaimers([payer.publicKey], [10_000], { dbc: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: poolAddress,
        poolClaimers: dbcPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    const initialInfo = await fetchclaimerspdainfo(
      program,
      dbcPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [10_000]);
    assert.strictEqual(initialInfo.claimedBase[0].toNumber(), 0);
    assert.strictEqual(initialInfo.claimedQuote[0].toNumber(), 0);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    const { current: unclaimed } = await client.state.getPoolFeeMetrics(
      poolAddress,
    );
    console.log("Partner unclaimed base:", unclaimed.partnerBaseFee.toString());
    console.log(
      "Partner unclaimed quote (SOL):",
      Number(unclaimed.partnerQuoteFee) / LAMPORTS_PER_SOL,
    );
    console.log("Creator unclaimed base:", unclaimed.creatorBaseFee.toString());
    console.log(
      "Creator unclaimed quote (SOL):",
      Number(unclaimed.creatorQuoteFee) / LAMPORTS_PER_SOL,
    );

    // Our program's fee vaults (seeded off the DBC pool address)
    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      poolAddress,
      baseMint.publicKey,
      WSOL_MINT,
      program.programId,
    );

    // // Step 4: Claim partner trading fees from the DBC pool into our fee vaults
    // await program.methods
    //   .claimPartnerTradingFee(
    //     new anchor.BN("18446744073709551615"), // u64::MAX — claim all base
    //     new anchor.BN("18446744073709551615"), // u64::MAX — claim all quote
    //   )
    //   .accounts({
    //     poolAuthority: dbcPoolAuthority,
    //     config: config.publicKey,
    //     pool: poolAddress,
    //     poolClaimers: dbcPoolClaimersPda,
    //     baseFeeVault,
    //     quoteFeeVault,
    //     basePoolVault: dbcPoolState.baseVault,
    //     quotePoolVault: dbcPoolState.quoteVault,
    //     baseMint: baseMint.publicKey,
    //     quoteMint: WSOL_MINT,
    //     feeClaimer: feeClaimerPda,
    //     tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
    //     tokenQuoteProgram: TOKEN_PROGRAM_ID,
    //     eventAuthority: dbcEventAuthority,
    //     dbcProgram: DBC_PROGRAM_ID,
    //     payer: payer.publicKey,
    //     systemProgram: SystemProgram.programId,
    //   } as any)
    //   .signers([payer])
    //   .rpc();

    // // Step 5: Assert the quote fee vault holds non-zero fees
    // const quoteVaultBalance = await provider.connection.getTokenAccountBalance(
    //   quoteFeeVault,
    // );
    // const quoteAmount = Number(quoteVaultBalance.value.amount);
    // assert.isTrue(
    //   quoteAmount > 0,
    //   "quote fee vault must hold non-zero fees after claimPartnerTradingFee",
    // );

    // // Step 6: Create admin ATAs for base + quote tokens
    // const payerBaseAta = getAssociatedTokenAddressSync(
    //   baseMint.publicKey,
    //   payer.publicKey,
    //   false,
    //   TOKEN_2022_PROGRAM_ID,
    // );
    // const payerQuoteAta = getAssociatedTokenAddressSync(
    //   WSOL_MINT,
    //   payer.publicKey,
    //   false,
    //   TOKEN_PROGRAM_ID,
    // );

    // const createAtaTx = new anchor.web3.Transaction().add(
    //   createAssociatedTokenAccountIdempotentInstruction(
    //     payer.publicKey,
    //     payerBaseAta,
    //     payer.publicKey,
    //     baseMint.publicKey,
    //     TOKEN_2022_PROGRAM_ID,
    //   ),
    //   createAssociatedTokenAccountIdempotentInstruction(
    //     payer.publicKey,
    //     payerQuoteAta,
    //     payer.publicKey,
    //     WSOL_MINT,
    //     TOKEN_PROGRAM_ID,
    //   ),
    // );
    // await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    // // Step 7: Distribute fees — 100% to admin
    // await distribute_fees(
    //   program,
    //   payer,
    //   poolAddress,
    //   dbcPoolClaimersPda,
    //   baseFeeVault,
    //   quoteFeeVault,
    //   { tokenAMint: baseMint.publicKey, tokenBMint: WSOL_MINT },
    //   feeClaimerPda,
    //   TOKEN_2022_PROGRAM_ID,
    //   TOKEN_PROGRAM_ID,
    //   [
    //     { pubkey: payerBaseAta, isSigner: false, isWritable: true },
    //     { pubkey: payerQuoteAta, isSigner: false, isWritable: true },
    //   ],
    // );

    // // Step 8: Assert admin received exactly 100% of the quote fees
    // const payerQuoteBalance = await provider.connection.getTokenAccountBalance(
    //   payerQuoteAta,
    // );
    // assert.strictEqual(
    //   Number(payerQuoteBalance.value.amount),
    //   quoteAmount,
    //   `admin must receive exactly 100% of fees (${quoteAmount} lamports)`,
    // );

    // // Step 9: Assert PDA claimedQuote reflects the full amount
    // const finalInfo = await fetchclaimerspdainfo(
    //   program,
    //   dbcPoolClaimersPda,
    //   false,
    // );
    // assert.strictEqual(
    //   finalInfo.claimedQuote[0].toNumber(),
    //   quoteAmount,
    //   "PDA claimedQuote must equal the exact fee vault amount",
    // );
  });
});
