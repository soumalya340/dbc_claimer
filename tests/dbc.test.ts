import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
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
  fetchClaimerState,
  distribute_fees,
  buildInitClaimersRemainingAccounts,
  buildDistributeFeesRemainingAccounts,
} from "./utils/helpers";

import { DbcSwap } from "../target/types/dbc_swap";
import { assert } from "chai";

import {
  setupPoolAndMigrate,
  createRandomKeyPair,
} from "./test_helpers/dammv2";
import { swap } from "./utils/swap";
import { setupConfigAndPool } from "./utils/createConfigAndPool";

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
      .initializePoolClaimers([payer.publicKey], [10_000], { dbc: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: poolAddress,
        baseMint: baseMint.publicKey,
        quoteMint: WSOL_MINT,
        poolClaimers: dbcPoolClaimersPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          poolAddress,
          [payer.publicKey],
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    const initialInfo = await fetchclaimerspdainfo(
      program,
      dbcPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [10_000]);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    const payerClaimerState = await fetchClaimerState(
      program,
      poolAddress,
      payer.publicKey,
    );
    assert.strictEqual(payerClaimerState.claimedBase.toNumber(), 0);
    assert.strictEqual(payerClaimerState.claimedQuote.toNumber(), 0);

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

    // Step 3: Fetch DBC pool state to get the pool's token vaults
    const dbcPoolState = await client.state.getPool(poolAddress);

    // Step 4: Claim partner trading fees from the DBC pool into our fee vaults
    await program.methods
      .claimPartnerTradingFee(
        new anchor.BN("18446744073709551615"), // u64::MAX — claim all base
        new anchor.BN("18446744073709551615"), // u64::MAX — claim all quote
      )
      .accounts({
        poolAuthority: dbcPoolAuthority,
        config: config.publicKey,
        pool: poolAddress,
        poolClaimers: dbcPoolClaimersPda,
        baseFeeVault,
        quoteFeeVault,
        basePoolVault: dbcPoolState.baseVault,
        quotePoolVault: dbcPoolState.quoteVault,
        baseMint: baseMint.publicKey,
        quoteMint: WSOL_MINT,
        feeClaimer: feeClaimerPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        eventAuthority: dbcEventAuthority,
        dbcProgram: DBC_PROGRAM_ID,
        payer: payer.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    // Step 5: Assert the quote fee vault holds non-zero fees
    const quoteVaultBalance = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );
    console.log(
      "quoteVaultBalance after claimPartnerTradingFee (DBC): ",
      Number(quoteVaultBalance.value.amount) / LAMPORTS_PER_SOL,
    );
    const quoteAmount = Number(quoteVaultBalance.value.amount);
    console.log(
      "Quote Vault Balance After Claim: ",
      Number(quoteAmount) / LAMPORTS_PER_SOL,
    );

    assert.equal(
      quoteVaultBalance.value.amount,
      unclaimed.partnerQuoteFee.toString(),
      "Quote Vault Amount should exactly equal partner quote claimed into vault",
    );

    // Step 6: Create admin ATAs for base + quote tokens
    const payerBaseAta = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    const payerQuoteAta = getAssociatedTokenAddressSync(
      WSOL_MINT,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID,
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta,
        payer.publicKey,
        baseMint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta,
        payer.publicKey,
        WSOL_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    // Step 7: Distribute fees — 100% to admin
    const distributeRem1 = buildDistributeFeesRemainingAccounts(
      poolAddress,
      [payer.publicKey],
      baseMint.publicKey,
      WSOL_MINT,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      program.programId,
    );

    await distribute_fees(
      program,
      payer,
      poolAddress,
      dbcPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      { tokenAMint: baseMint.publicKey, tokenBMint: WSOL_MINT },
      feeClaimerPda,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      distributeRem1,
    );

    // Step 8: Assert admin received exactly 100% of the quote fees
    const payerQuoteBalance = await provider.connection.getTokenAccountBalance(
      payerQuoteAta,
    );
    console.log(
      "Admin Quote Balance After Distribution: ",
      Number(payerQuoteBalance.value.amount) / LAMPORTS_PER_SOL,
    );
    assert.strictEqual(
      Number(payerQuoteBalance.value.amount),
      quoteAmount,
      `Admin must receive exactly 100% of fees (${quoteAmount} lamports)`,
    );
  });

  it("test2: multi-claimer proportional distribution and BPS update", async () => {
    const payer = (provider.wallet as any).payer;

    // ── Setup ────────────────────────────────────────────────────────────────
    const user1 = await createRandomKeyPair(12); // permissionless caller for claims
    const user2 = await createRandomKeyPair(2);
    const user3 = await createRandomKeyPair(2);

    const config = Keypair.generate();
    const baseMint = Keypair.generate();

    // Use a very high migration threshold (10 000 SOL) so the pool stays active
    // for both swap rounds without triggering migration.
    const { poolAddress } = await setupConfigAndPool(
      payer,
      config,
      feeClaimerPda,
      10_000,
      baseMint,
      10, // partnerPermanentLockedLiquidityPercentage
      90, // partnerLiquidityPercentage
      0, // creatorPermanentLockedLiquidityPercentage
      0, // creatorLiquidityPercentage
      0, // creatorTradingFeePercentage — 100% of trading fees go to partner
    );

    const dbcPoolClaimersPda = derivePoolClaimersPda(
      poolAddress,
      program.programId,
    );

    const claimers = [payer.publicKey, user2.publicKey, user3.publicKey];

    // ── Step 1: Initialize pool claimers — admin 20%, user2 30%, user3 50% ──
    await program.methods
      .initializePoolClaimers(claimers, [2000, 3000, 5000], { dbc: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: poolAddress,
        baseMint: baseMint.publicKey,
        quoteMint: WSOL_MINT,
        poolClaimers: dbcPoolClaimersPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          poolAddress,
          claimers,
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    // ── Step 2: Verify initial PDA state ────────────────────────────────────
    const initialInfo = await fetchclaimerspdainfo(
      program,
      dbcPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [2000, 3000, 5000]);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    for (const c of claimers) {
      const s = await fetchClaimerState(program, poolAddress, c);
      assert.strictEqual(s.claimedBase.toNumber(), 0);
      assert.strictEqual(s.claimedQuote.toNumber(), 0);
    }

    // ── Step 3: Round-1 swap to generate DBC trading fees ───────────────────
    await swap(payer, poolAddress, 5, false);

    const { current: unclaimedRound1 } = await client.state.getPoolFeeMetrics(
      poolAddress,
    );
    console.log(
      "Round 1 partner quote fee (SOL):",
      Number(unclaimedRound1.partnerQuoteFee) / LAMPORTS_PER_SOL,
    );

    // ── Step 4: Derive fee vaults and DBC pool vaults ────────────────────────
    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      poolAddress,
      baseMint.publicKey,
      WSOL_MINT,
      program.programId,
    );
    const dbcPoolState = await client.state.getPool(poolAddress);

    // ── Step 5: Create ATAs for all 3 claimers ───────────────────────────────
    const baseATAs = claimers.map((c) =>
      getAssociatedTokenAddressSync(
        baseMint.publicKey,
        c,
        false,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    const quoteATAs = claimers.map((c) =>
      getAssociatedTokenAddressSync(WSOL_MINT, c, false, TOKEN_PROGRAM_ID),
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      ...claimers.flatMap((claimer, i) => [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          baseATAs[i],
          claimer,
          baseMint.publicKey,
          TOKEN_2022_PROGRAM_ID,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          quoteATAs[i],
          claimer,
          WSOL_MINT,
          TOKEN_PROGRAM_ID,
        ),
      ]),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    // ── Step 6: Claim partner trading fees (user1 is permissionless payer) ──
    await program.methods
      .claimPartnerTradingFee(
        new anchor.BN("18446744073709551615"), // u64::MAX
        new anchor.BN("18446744073709551615"), // u64::MAX
      )
      .accounts({
        poolAuthority: dbcPoolAuthority,
        config: config.publicKey,
        pool: poolAddress,
        poolClaimers: dbcPoolClaimersPda,
        baseFeeVault,
        quoteFeeVault,
        basePoolVault: dbcPoolState.baseVault,
        quotePoolVault: dbcPoolState.quoteVault,
        baseMint: baseMint.publicKey,
        quoteMint: WSOL_MINT,
        feeClaimer: feeClaimerPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        eventAuthority: dbcEventAuthority,
        dbcProgram: DBC_PROGRAM_ID,
        payer: user1.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user1])
      .rpc();

    const quoteVaultRound1 = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );
    const quoteAmount1 = Number(quoteVaultRound1.value.amount);
    console.log(
      "Round 1 vault balance (SOL):",
      quoteAmount1 / LAMPORTS_PER_SOL,
    );

    // ── Step 7: Distribute round-1 fees ─────────────────────────────────────
    const distributeRemR1 = buildDistributeFeesRemainingAccounts(
      poolAddress,
      claimers,
      baseMint.publicKey,
      WSOL_MINT,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      program.programId,
    );

    await distribute_fees(
      program,
      user1,
      poolAddress,
      dbcPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      { tokenAMint: baseMint.publicKey, tokenBMint: WSOL_MINT },
      feeClaimerPda,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      distributeRemR1,
    );

    // ── Step 8: Assert proportional payouts — 20% / 30% / 50% ──────────────
    const pdaRound1 = await fetchclaimerspdainfo(
      program,
      dbcPoolClaimersPda,
      false,
    );

    const payerExpected1 = Math.floor((quoteAmount1 * 2000) / 10_000);
    const user2Expected1 = Math.floor((quoteAmount1 * 3000) / 10_000);
    const user3Expected1 = quoteAmount1 - payerExpected1 - user2Expected1;

    const round1PayerState = await fetchClaimerState(
      program,
      poolAddress,
      payer.publicKey,
    );
    const round1User2State = await fetchClaimerState(
      program,
      poolAddress,
      user2.publicKey,
    );
    const round1User3State = await fetchClaimerState(
      program,
      poolAddress,
      user3.publicKey,
    );

    assert.strictEqual(round1PayerState.claimedQuote.toNumber(), payerExpected1);
    assert.strictEqual(round1User2State.claimedQuote.toNumber(), user2Expected1);
    assert.strictEqual(round1User3State.claimedQuote.toNumber(), user3Expected1);
    assert.isAbove(pdaRound1.lastDistributed.toNumber(), 0);
    assert.isAbove(pdaRound1.lastClaimed.toNumber(), 0);

    console.log(
      `Round 1 distribution (SOL) — admin: ${
        payerExpected1 / LAMPORTS_PER_SOL
      }, ` +
        `user2: ${user2Expected1 / LAMPORTS_PER_SOL}, user3: ${
          user3Expected1 / LAMPORTS_PER_SOL
        }`,
    );

    // ── Step 9: Update BPS to 50% / 50% / 0% ────────────────────────────────
    await program.methods
      .updateClaimersBps([5000, 5000, 0])
      .accounts({
        deployer: payer.publicKey,
        pool: poolAddress,
        poolClaimers: dbcPoolClaimersPda,
      } as any)
      .signers([payer])
      .rpc();

    const pdaAfterBpsUpdate = await fetchclaimerspdainfo(
      program,
      dbcPoolClaimersPda,
      false,
    );
    assert.deepEqual(pdaAfterBpsUpdate.claimerBps, [5000, 5000, 0]);
    // claimedQuote on ClaimerState is preserved (not reset by updateClaimersBps)
    const afterBpsPayer = await fetchClaimerState(
      program,
      poolAddress,
      payer.publicKey,
    );
    const afterBpsUser2 = await fetchClaimerState(
      program,
      poolAddress,
      user2.publicKey,
    );
    const afterBpsUser3 = await fetchClaimerState(
      program,
      poolAddress,
      user3.publicKey,
    );
    assert.strictEqual(afterBpsPayer.claimedQuote.toNumber(), payerExpected1);
    assert.strictEqual(afterBpsUser2.claimedQuote.toNumber(), user2Expected1);
    assert.strictEqual(afterBpsUser3.claimedQuote.toNumber(), user3Expected1);

    // ── Step 10: Round-2 swap to generate new DBC fees ───────────────────────
    await swap(user1, poolAddress, 5, false);

    // ── Step 11: Claim fees (user1 again) ───────────────────────────────────
    await program.methods
      .claimPartnerTradingFee(
        new anchor.BN("18446744073709551615"),
        new anchor.BN("18446744073709551615"),
      )
      .accounts({
        poolAuthority: dbcPoolAuthority,
        config: config.publicKey,
        pool: poolAddress,
        poolClaimers: dbcPoolClaimersPda,
        baseFeeVault,
        quoteFeeVault,
        basePoolVault: dbcPoolState.baseVault,
        quotePoolVault: dbcPoolState.quoteVault,
        baseMint: baseMint.publicKey,
        quoteMint: WSOL_MINT,
        feeClaimer: feeClaimerPda,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        eventAuthority: dbcEventAuthority,
        dbcProgram: DBC_PROGRAM_ID,
        payer: user1.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user1])
      .rpc();

    const quoteVaultRound2 = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );
    const quoteAmount2 = Number(quoteVaultRound2.value.amount);
    console.log(
      "Round 2 vault balance (SOL):",
      quoteAmount2 / LAMPORTS_PER_SOL,
    );

    // ── Step 12: Distribute round-2 fees ────────────────────────────────────
    await distribute_fees(
      program,
      user1,
      poolAddress,
      dbcPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      { tokenAMint: baseMint.publicKey, tokenBMint: WSOL_MINT },
      feeClaimerPda,
      TOKEN_2022_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      distributeRemR1,
    );

    // ── Step 13: Assert delta on claimedQuote reflects 50% / 50% / 0% ───────
    const round2PayerState = await fetchClaimerState(
      program,
      poolAddress,
      payer.publicKey,
    );
    const round2User2State = await fetchClaimerState(
      program,
      poolAddress,
      user2.publicKey,
    );
    const round2User3State = await fetchClaimerState(
      program,
      poolAddress,
      user3.publicKey,
    );

    const payerDelta =
      round2PayerState.claimedQuote.toNumber() - payerExpected1;
    const user2Delta =
      round2User2State.claimedQuote.toNumber() - user2Expected1;
    const user3Delta =
      round2User3State.claimedQuote.toNumber() - user3Expected1;

    const payerExpected2 = Math.floor((quoteAmount2 * 5000) / 10_000);
    const user2Expected2 = Math.floor((quoteAmount2 * 5000) / 10_000);
    const user3Expected2 = quoteAmount2 - payerExpected2 - user2Expected2;

    assert.strictEqual(payerDelta, payerExpected2);
    assert.strictEqual(user2Delta, user2Expected2);
    assert.strictEqual(user3Delta, user3Expected2);

    console.log(
      `Round 2 delta (SOL) — admin: ${payerDelta / LAMPORTS_PER_SOL}, ` +
        `user2: ${user2Delta / LAMPORTS_PER_SOL}, user3: ${
          user3Delta / LAMPORTS_PER_SOL
        }`,
    );
  });
});
