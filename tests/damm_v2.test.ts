import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  CpAmm,
  derivePositionAddress,
  derivePoolAuthority,
  derivePositionNftAccount,
  getTokenProgram,
} from "@meteora-ag/cp-amm-sdk";

import { fetchAllWalletNfts } from "./utils/nft_balance";

import {
  deriveFeeClaimerPda,
  derivePoolClaimersPda,
  deriveCpAmmFeeVaults,
  deriveCpAmmEventAuthority,
} from "./utils/constant";
import {
  connection,
  CP_AMM_PROGRAM_ID,
  fetchclaimerspdainfo,
  distribute_fees,
} from "./utils/helpers";

import { DbcSwap } from "../target/types/dbc_swap";
import { assert } from "chai";

import {
  createRandomKeyPair,
  setupPoolAndMigrate,
  getPositionInfo,
  claimPositionFeeModule,
} from "./test_helpers/dammv2";
import { dammV2Swap } from "./utils/damm_v2_swap";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

describe("dbc-swap:damm-v2", () => {
  const feeClaimerPda = deriveFeeClaimerPda(program.programId);

  before(async () => {
    const cpAmmAccount = await connection.getAccountInfo(CP_AMM_PROGRAM_ID);
    if (!cpAmmAccount)
      throw new Error(
        "CP-AMM program not loaded on localnet — run `yarn start` first",
      );
  });

  it("test1: fee claimer should hold DAMMv2 NFT custody", async () => {
    const payer = (provider.wallet as any).payer;

    const nftBalance = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    await setupPoolAndMigrate(payer, feeClaimerPda);

    const nftBalanceAfter = await fetchAllWalletNfts(feeClaimerPda.toBase58());

    assert.isTrue(
      nftBalanceAfter.length > nftBalance.length,
      "feeClaimerPda did not receive new DAMMv2 position NFT(s) as custodian",
    );
  });

  it("test2: fee vaults fill with real SOL after a DAMMv2 swap + claim", async () => {
    const payer = (provider.wallet as any).payer;
    const { secondPositionNftMint } = await setupPoolAndMigrate(
      payer,
      feeClaimerPda,
    );

    // secondPositionNftMint is the position whose authority is transferred to fee_claimer
    const cpAmm = new CpAmm(connection);
    const position = derivePositionAddress(secondPositionNftMint);
    const positionState = await cpAmm.fetchPositionState(position);
    const dammV2Pool = positionState.pool;
    const poolState = await cpAmm.fetchPoolState(dammV2Pool);

    const cpAmmPoolClaimersPda = derivePoolClaimersPda(
      dammV2Pool,
      program.programId,
    );

    await program.methods
      .setPoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    await fetchclaimerspdainfo(program, cpAmmPoolClaimersPda, false);

    const stranger = await createRandomKeyPair(12);

    const { feeTokenA, feeTokenB } = await getPositionInfo(
      secondPositionNftMint,
    );
    console.log("FeeTokenB before swap:", feeTokenB.toString());

    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    const { signature, success } = await claimPositionFeeModule(
      stranger,
      dammV2Pool,
      poolState,
      1,
      position,
      secondPositionNftMint,
      cpAmmPoolClaimersPda,
      program,
      feeClaimerPda,
    );

    assert.isTrue(success, "claim_position_fee did not succeed");

    const quoteVaultBalance = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );

    console.log(
      "quote_fee_vault balance after claim:",
      quoteVaultBalance.value.uiAmountString,
    );

    const quoteAmount = Number(quoteVaultBalance.value.amount);

    assert.isTrue(
      quoteAmount > 0 || quoteAmount === feeTokenB.toNumber(),
      "quote_fee_vault balance after claim is not equal to the fee token B amount",
    );

    // --- distribute_fees: push vault balances to registered claimers ---
    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);

    const payerBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTokenProgram,
    );
    const payerQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTokenProgram,
    );

    // Idempotently create both ATAs so the transfer can land
    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta,
        payer.publicKey,
        poolState.tokenAMint,
        baseTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    await program.methods
      .distributeFees()
      .accounts({
        caller: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        baseFeeVault,
        quoteFeeVault,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        feeClaimer: feeClaimerPda,
        tokenBaseProgram: baseTokenProgram,
        tokenQuoteProgram: quoteTokenProgram,
      } as any)
      .remainingAccounts([
        { pubkey: payerBaseAta, isSigner: false, isWritable: true },
        { pubkey: payerQuoteAta, isSigner: false, isWritable: true },
      ])
      .signers([payer])
      .rpc();

    const claimerQuoteBalance =
      await provider.connection.getTokenAccountBalance(payerQuoteAta);
    const claimerQuoteAmount = Number(claimerQuoteBalance.value.amount);

    assert.strictEqual(
      claimerQuoteAmount,
      quoteAmount,
      `Claimer quote balance (${claimerQuoteAmount}) should equal quoteFeeVaultBalance (${quoteAmount})`,
    );
  });

  it("test3: admin-set claimers receive proportional fees and percentages update correctly", async () => {
    const payer = (provider.wallet as any).payer;

    const { secondPositionNftMint } = await setupPoolAndMigrate(
      payer,
      feeClaimerPda,
    );

    const cpAmm = new CpAmm(connection);
    const position = derivePositionAddress(secondPositionNftMint);
    const positionState = await cpAmm.fetchPositionState(position);
    const dammV2Pool = positionState.pool;
    const poolState = await cpAmm.fetchPoolState(dammV2Pool);

    const cpAmmPoolClaimersPda = derivePoolClaimersPda(
      dammV2Pool,
      program.programId,
    );

    const user2 = await createRandomKeyPair(2);
    const user3 = await createRandomKeyPair(2);

    // Step 1: Set claimers payer=20%, user2=30%, user3=50%
    await program.methods
      .setPoolClaimers(
        [payer.publicKey, user2.publicKey, user3.publicKey],
        [2000, 3000, 5000],
        { dammV2: {} },
      )
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    // Step 1b: Verify initial PDA state
    const initialInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [2000, 3000, 5000]);
    assert.deepEqual(
      initialInfo.claimedBase.map((n: anchor.BN) => n.toNumber()),
      [0, 0, 0],
    );
    assert.deepEqual(
      initialInfo.claimedQuote.map((n: anchor.BN) => n.toNumber()),
      [0, 0, 0],
    );
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    // Step 2: Swap + claimPositionFee via module
    await claimPositionFeeModule(
      payer,
      dammV2Pool,
      poolState,
      1,
      position,
      secondPositionNftMint,
      cpAmmPoolClaimersPda,
      program,
      feeClaimerPda,
      false,
    );

    // Step 3: Create ATAs for all 3 claimers and distribute fees
    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);

    const claimers = [payer.publicKey, user2.publicKey, user3.publicKey];
    const baseATAs = claimers.map((c) =>
      getAssociatedTokenAddressSync(
        poolState.tokenAMint,
        c,
        false,
        baseTokenProgram,
      ),
    );
    const quoteATAs = claimers.map((c) =>
      getAssociatedTokenAddressSync(
        poolState.tokenBMint,
        c,
        false,
        quoteTokenProgram,
      ),
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      ...claimers.flatMap((claimer, i) => [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          baseATAs[i],
          claimer,
          poolState.tokenAMint,
          baseTokenProgram,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          quoteATAs[i],
          claimer,
          poolState.tokenBMint,
          quoteTokenProgram,
        ),
      ]),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    const quoteVaultBalanceBefore =
      await provider.connection.getTokenAccountBalance(quoteFeeVault);
    const quoteAmount = Number(quoteVaultBalanceBefore.value.amount);

    const remainingAccounts = claimers.flatMap((_, i) => [
      { pubkey: baseATAs[i], isSigner: false, isWritable: true },
      { pubkey: quoteATAs[i], isSigner: false, isWritable: true },
    ]);

    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTokenProgram,
      quoteTokenProgram,
      remainingAccounts,
    );

    // Step 4: Verify proportional payouts
    const pdaInfoRound1 = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );

    const payerExpected = Math.floor((quoteAmount * 2000) / 10000);
    const user2Expected = Math.floor((quoteAmount * 3000) / 10000);
    const user3Expected = quoteAmount - payerExpected - user2Expected;

    assert.strictEqual(pdaInfoRound1.claimedQuote[0].toNumber(), payerExpected);
    assert.strictEqual(pdaInfoRound1.claimedQuote[1].toNumber(), user2Expected);
    assert.strictEqual(pdaInfoRound1.claimedQuote[2].toNumber(), user3Expected);

    // Step 4b: lastDistributed and lastClaimed must be non-zero
    assert.isAbove(pdaInfoRound1.lastDistributed.toNumber(), 0);
    assert.isAbove(pdaInfoRound1.lastClaimed.toNumber(), 0);

    // Step 5: Update claimers to payer=50%, user2=30%, user3=20%
    await program.methods
      .setPoolClaimers(
        [payer.publicKey, user2.publicKey, user3.publicKey],
        [5000, 3000, 2000],
        { dammV2: {} },
      )
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    // Step 6: Random user1 does a swap
    const user1 = await createRandomKeyPair(101);
    await dammV2Swap(user1, dammV2Pool, poolState, 100, false);

    // Step 7: user1 calls claimPositionFee() directly to show anyone can call
    const cpAmmPoolAuthority = derivePoolAuthority();
    const positionNftAccount = derivePositionNftAccount(secondPositionNftMint);
    const cpAmmEventAuthority = deriveCpAmmEventAuthority(CP_AMM_PROGRAM_ID);

    await program.methods
      .claimPositionFee()
      .accounts({
        poolAuthority: cpAmmPoolAuthority,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        position,
        baseFeeVault,
        quoteFeeVault,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        tokenAProgram: getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: getTokenProgram(poolState.tokenBFlag),
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
        payer: user1.publicKey,
        feeClaimer: feeClaimerPda,
      } as any)
      .signers([user1])
      .rpc();

    // Step 7b: Distribute fees (second round)
    const quoteVaultBalanceRound2 =
      await provider.connection.getTokenAccountBalance(quoteFeeVault);
    const quoteAmount2 = Number(quoteVaultBalanceRound2.value.amount);

    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTokenProgram,
      quoteTokenProgram,
      remainingAccounts,
    );

    // Step 8: Verify updated proportions (claimedQuote reset when setPoolClaimers was re-called)
    const pdaInfoRound2 = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );

    const payerExpected2 = Math.floor((quoteAmount2 * 5000) / 10000);
    const user2Expected2 = Math.floor((quoteAmount2 * 3000) / 10000);
    const user3Expected2 = quoteAmount2 - payerExpected2 - user2Expected2;

    assert.strictEqual(
      pdaInfoRound2.claimedQuote[0].toNumber(),
      payerExpected2,
    );
    assert.strictEqual(
      pdaInfoRound2.claimedQuote[1].toNumber(),
      user2Expected2,
    );
    assert.strictEqual(
      pdaInfoRound2.claimedQuote[2].toNumber(),
      user3Expected2,
    );

    // Showcase: update_claimers_bps preserves past claimed history (unlike setPoolClaimers)
    // After step 7b distributeFees, the fee vault should be empty
    const vaultBalanceAfterRound2 =
      await provider.connection.getTokenAccountBalance(quoteFeeVault);
    assert.strictEqual(Number(vaultBalanceAfterRound2.value.amount), 0);

    // Update BPS to 50% / 50% / 0% — only BPS changes, claimed history is untouched
    await program.methods
      .updateClaimersBps([5000, 5000, 0])
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
      } as any)
      .signers([payer])
      .rpc();

    // BPS is updated, but claimedQuote still reflects round-2 historical amounts
    const pdaInfoAfterBpsUpdate = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );

    assert.deepEqual(pdaInfoAfterBpsUpdate.claimerBps, [5000, 5000, 0]);

    // Past claimed amounts are preserved — update_claimers_bps does NOT reset them
    assert.strictEqual(
      pdaInfoAfterBpsUpdate.claimedQuote[0].toNumber(),
      payerExpected2,
    );
    assert.strictEqual(
      pdaInfoAfterBpsUpdate.claimedQuote[1].toNumber(),
      user2Expected2,
    );
    assert.strictEqual(
      pdaInfoAfterBpsUpdate.claimedQuote[2].toNumber(),
      user3Expected2,
    );

    // Round 3: swap + claimPositionFee + distributeFees under the new 50/50/0 split.
    // The DELTA between new and old claimedQuote must equal exactly the new BPS percentages.
    const user1Round3 = await createRandomKeyPair(12);
    await dammV2Swap(user1Round3, dammV2Pool, poolState, 1, false);

    await program.methods
      .claimPositionFee()
      .accounts({
        poolAuthority: derivePoolAuthority(),
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        position,
        baseFeeVault,
        quoteFeeVault,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount: derivePositionNftAccount(secondPositionNftMint),
        tokenAProgram: getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: getTokenProgram(poolState.tokenBFlag),
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
        payer: user1Round3.publicKey,
        feeClaimer: feeClaimerPda,
      } as any)
      .signers([user1Round3])
      .rpc();

    const quoteVaultRound3 = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );
    const quoteAmount3 = Number(quoteVaultRound3.value.amount);

    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTokenProgram,
      quoteTokenProgram,
      remainingAccounts,
    );

    const pdaInfoRound3 = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );

    // Delta = new cumulative claimed − previous cumulative claimed (preserved from round 2)
    const payerRound3Delta =
      pdaInfoRound3.claimedQuote[0].toNumber() - payerExpected2;
    const user2Round3Delta =
      pdaInfoRound3.claimedQuote[1].toNumber() - user2Expected2;
    const user3Round3Delta =
      pdaInfoRound3.claimedQuote[2].toNumber() - user3Expected2;

    // Expected distribution under 50/50/0 — last claimer (user3, 0%) sweeps remainder
    const payerExpected3 = Math.floor((quoteAmount3 * 5000) / 10000);
    const user2Expected3 = Math.floor((quoteAmount3 * 5000) / 10000);
    const user3Expected3 = quoteAmount3 - payerExpected3 - user2Expected3;

    assert.strictEqual(payerRound3Delta, payerExpected3);
    assert.strictEqual(user2Round3Delta, user2Expected3);
    assert.strictEqual(user3Round3Delta, user3Expected3);
  });

  it("test4: fee claimer captures 100% of fees with mixed locked/unlocked liquidity", async () => {
    const payer = (provider.wallet as any).payer;

    // Pool: partner 10% permanently locked, 90% unlocked; creator 0%
    // Creator is 0%, so only firstPositionNftMint is created on-chain
    const { firstPositionNftMint } = await setupPoolAndMigrate(
      payer,
      feeClaimerPda,
      10,
      90,
      0,
      0,
    );

    const cpAmm = new CpAmm(connection);
    const position = derivePositionAddress(firstPositionNftMint);
    const positionState = await cpAmm.fetchPositionState(position);
    const dammV2Pool = positionState.pool;
    const poolState = await cpAmm.fetchPoolState(dammV2Pool);

    const cpAmmPoolClaimersPda = derivePoolClaimersPda(
      dammV2Pool,
      program.programId,
    );

    // Register admin as sole 100% claimer
    await program.methods
      .setPoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    // Assert initial PDA state
    const initialInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [10_000]);
    assert.strictEqual(initialInfo.claimedBase[0].toNumber(), 0);
    assert.strictEqual(initialInfo.claimedQuote[0].toNumber(), 0);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    // Assert position has both unlocked (90%) and permanently locked (10%) liquidity
    const { unlocked, permLocked } = await getPositionInfo(
      firstPositionNftMint,
    );
    assert.isTrue(unlocked.gtn(0), "position should have unlocked liquidity");
    assert.isTrue(
      permLocked.gtn(0),
      "position should have permanently locked liquidity",
    );

    // Swap to generate fees, then claim into fee vault
    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    await claimPositionFeeModule(
      payer,
      dammV2Pool,
      poolState,
      1,
      position,
      firstPositionNftMint,
      cpAmmPoolClaimersPda,
      program,
      feeClaimerPda,
      false,
    );

    // Read exact vault balance before distribution
    const quoteVaultBalance = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );
    const quoteAmount = Number(quoteVaultBalance.value.amount);
    assert.isTrue(
      quoteAmount > 0,
      "fee vault must hold non-zero fees after swap + claim",
    );

    // Create admin payer ATAs
    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);

    const payerBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTokenProgram,
    );
    const payerQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTokenProgram,
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta,
        payer.publicKey,
        poolState.tokenAMint,
        baseTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    // Distribute fees — 100% to admin payer
    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTokenProgram,
      quoteTokenProgram,
      [
        { pubkey: payerBaseAta, isSigner: false, isWritable: true },
        { pubkey: payerQuoteAta, isSigner: false, isWritable: true },
      ],
    );

    // Assert: admin received exactly 100% — not even 1 lamport less
    const payerQuoteBalance = await provider.connection.getTokenAccountBalance(
      payerQuoteAta,
    );
    assert.strictEqual(
      Number(payerQuoteBalance.value.amount),
      quoteAmount,
      `fee claimer must receive exactly 100% of fees (${quoteAmount} lamports) — not even 1 lamport less`,
    );

    // Confirm PDA claimedQuote reflects the full amount
    const finalInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.strictEqual(
      finalInfo.claimedQuote[0].toNumber(),
      quoteAmount,
      "PDA claimedQuote must equal the exact fee vault amount",
    );

    // --- Part 2: Remove 10% of unlocked liquidity ---

    const cpAmmEventAuthority = deriveCpAmmEventAuthority(CP_AMM_PROGRAM_ID);
    const positionNftAccount = derivePositionNftAccount(firstPositionNftMint);
    const cpAmmPoolAuthority = derivePoolAuthority();

    // Compute 10% of unlocked liquidity as the removal delta
    const { unlocked: unlockedBefore } = await getPositionInfo(
      firstPositionNftMint,
    );
    const liquidityToRemove = unlockedBefore.divn(10);

    // Snapshot vault and admin balances before removal
    const vaultABalBefore = Number(
      (await provider.connection.getTokenAccountBalance(poolState.tokenAVault))
        .value.amount,
    );
    const vaultBBalBefore = Number(
      (await provider.connection.getTokenAccountBalance(poolState.tokenBVault))
        .value.amount,
    );
    const baseBalanceBefore = Number(
      (await provider.connection.getTokenAccountBalance(payerBaseAta)).value
        .amount,
    );
    const quoteBalanceBefore = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta)).value
        .amount,
    );

    await program.methods
      .removeLiquidity({
        liquidityDelta: liquidityToRemove,
        tokenAAmountThreshold: new anchor.BN(0),
        tokenBAmountThreshold: new anchor.BN(0),
      })
      .accounts({
        admin: payer.publicKey,
        poolAuthority: cpAmmPoolAuthority,
        pool: dammV2Pool,
        position,
        tokenAAccount: payerBaseAta,
        tokenBAccount: payerQuoteAta,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram,
        tokenBProgram: quoteTokenProgram,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();

    // Admin received exactly the tokens that left the vault — no lamport lost
    const baseBalanceAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(payerBaseAta)).value
        .amount,
    );
    const quoteBalanceAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta)).value
        .amount,
    );
    const vaultABalAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(poolState.tokenAVault))
        .value.amount,
    );
    const vaultBBalAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(poolState.tokenBVault))
        .value.amount,
    );
    const adminReceivedA = baseBalanceAfterPartial - baseBalanceBefore;
    const adminReceivedB = quoteBalanceAfterPartial - quoteBalanceBefore;
    assert.isAbove(
      adminReceivedA,
      0,
      "admin must receive token A from partial removal",
    );
    assert.isAbove(
      adminReceivedB,
      0,
      "admin must receive token B from partial removal",
    );
    const vaultADecrease = vaultABalBefore - vaultABalAfterPartial;
    const vaultBDecrease = vaultBBalBefore - vaultBBalAfterPartial;
    // Allow up to 64 lamports for protocol rounding/fees on removal
    assert.isAtMost(
      vaultADecrease - adminReceivedA,
      64,
      `token A received (${adminReceivedA}) must be within 64 lamports of vault A decrease (${vaultADecrease})`,
    );
    assert.isAtMost(
      vaultBDecrease - adminReceivedB,
      64,
      `token B received (${adminReceivedB}) must be within 64 lamports of vault B decrease (${vaultBDecrease})`,
    );

    // Carry forward for Part 3 comparison
    const baseBalanceBeforeFull = baseBalanceAfterPartial;
    const quoteBalanceBeforeFull = quoteBalanceAfterPartial;

    assert.isAbove(
      quoteBalanceAfterPartial,
      quoteBalanceBefore,
      "admin token B balance must increase after partial removal",
    );

    // --- Part 3: Remove all remaining liquidity + NFT burned ---

    const nftCountBefore = (await fetchAllWalletNfts(feeClaimerPda.toBase58()))
      .length;

    await program.methods
      .removeAllLiquidity(new anchor.BN(0), new anchor.BN(0))
      .accounts({
        admin: payer.publicKey,
        poolAuthority: cpAmmPoolAuthority,
        pool: dammV2Pool,
        position,
        tokenAAccount: payerBaseAta,
        tokenBAccount: payerQuoteAta,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram,
        tokenBProgram: quoteTokenProgram,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();

    const baseBalanceAfterFull = Number(
      (await provider.connection.getTokenAccountBalance(payerBaseAta)).value
        .amount,
    );
    const quoteBalanceAfterFull = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta)).value
        .amount,
    );
    assert.isAbove(
      baseBalanceAfterFull,
      baseBalanceBeforeFull,
      "admin token A balance must increase after full removal",
    );
    assert.isAbove(
      quoteBalanceAfterFull,
      quoteBalanceBeforeFull,
      "admin token B balance must increase after full removal",
    );

    // Position has permanently locked liquidity (10%), so the NFT is NOT burned —
    // it remains as custody for the locked portion. Count must stay the same.
    const nftCountAfter = (await fetchAllWalletNfts(feeClaimerPda.toBase58()))
      .length;
    assert.strictEqual(
      nftCountAfter,
      nftCountBefore,
      "fee claimer PDA NFT count must stay the same after removeAllLiquidity (position has permanently locked liquidity)",
    );
  });

  it("test5: access control — only admin can initialize claimers, update bps, and remove liquidity", async () => {
    const payer = (provider.wallet as any).payer;

    // Pool: partner 10% permanently locked, 90% unlocked; creator 0%
    const { firstPositionNftMint } = await setupPoolAndMigrate(
      payer,
      feeClaimerPda,
      10,
      90,
      0,
      0,
    );

    const cpAmm = new CpAmm(connection);
    const position = derivePositionAddress(firstPositionNftMint);
    const positionState = await cpAmm.fetchPositionState(position);
    const dammV2Pool = positionState.pool;
    const poolState = await cpAmm.fetchPoolState(dammV2Pool);

    const cpAmmPoolClaimersPda = derivePoolClaimersPda(
      dammV2Pool,
      program.programId,
    );

    const nonAdmin = await createRandomKeyPair(2);

    // Step 1: Admin initializes poolClaimers PDA
    await program.methods
      .setPoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([payer])
      .rpc();

    const pdaInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(pdaInfo.claimerBps, [10_000]);

    // Step 2: Non-admin tries to call setPoolClaimers — must fail
    let threw = false;
    try {
      await program.methods
        .setPoolClaimers([nonAdmin.publicKey], [10_000], { dammV2: {} })
        .accounts({
          deployer: nonAdmin.publicKey,
          pool: dammV2Pool,
          poolClaimers: cpAmmPoolClaimersPda,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "non-admin must not be able to call setPoolClaimers");

    // Step 3: Admin updates BPS
    await program.methods
      .updateClaimersBps([10_000])
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
      } as any)
      .signers([payer])
      .rpc();

    const pdaInfoAfterBps = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(pdaInfoAfterBps.claimerBps, [10_000]);

    // Step 4: Non-admin tries to call updateClaimersBps — must fail
    threw = false;
    try {
      await program.methods
        .updateClaimersBps([10_000])
        .accounts({
          deployer: nonAdmin.publicKey,
          pool: dammV2Pool,
          poolClaimers: cpAmmPoolClaimersPda,
        } as any)
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "non-admin must not be able to call updateClaimersBps");

    // Prepare ATAs for admin and non-admin
    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);

    const payerBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTokenProgram,
    );
    const payerQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTokenProgram,
    );
    const nonAdminBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      nonAdmin.publicKey,
      false,
      baseTokenProgram,
    );
    const nonAdminQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      nonAdmin.publicKey,
      false,
      quoteTokenProgram,
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta,
        payer.publicKey,
        poolState.tokenAMint,
        baseTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        nonAdminBaseAta,
        nonAdmin.publicKey,
        poolState.tokenAMint,
        baseTokenProgram,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        nonAdminQuoteAta,
        nonAdmin.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx, [payer]);

    const cpAmmEventAuthority = deriveCpAmmEventAuthority(CP_AMM_PROGRAM_ID);
    const positionNftAccount = derivePositionNftAccount(firstPositionNftMint);
    const cpAmmPoolAuthority = derivePoolAuthority();

    const { unlocked: unlockedBefore } = await getPositionInfo(
      firstPositionNftMint,
    );
    const liquidityToRemove = unlockedBefore.divn(10);

    // Step 5: Admin removes partial liquidity
    await program.methods
      .removeLiquidity({
        liquidityDelta: liquidityToRemove,
        tokenAAmountThreshold: new anchor.BN(0),
        tokenBAmountThreshold: new anchor.BN(0),
      })
      .accounts({
        admin: payer.publicKey,
        poolAuthority: cpAmmPoolAuthority,
        pool: dammV2Pool,
        position,
        tokenAAccount: payerBaseAta,
        tokenBAccount: payerQuoteAta,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram,
        tokenBProgram: quoteTokenProgram,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();

    // Step 6: Non-admin tries to remove partial liquidity — must fail
    threw = false;
    try {
      await program.methods
        .removeLiquidity({
          liquidityDelta: liquidityToRemove,
          tokenAAmountThreshold: new anchor.BN(0),
          tokenBAmountThreshold: new anchor.BN(0),
        })
        .accounts({
          admin: nonAdmin.publicKey,
          poolAuthority: cpAmmPoolAuthority,
          pool: dammV2Pool,
          position,
          tokenAAccount: nonAdminBaseAta,
          tokenBAccount: nonAdminQuoteAta,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          positionNftAccount,
          feeClaimer: feeClaimerPda,
          tokenAProgram: baseTokenProgram,
          tokenBProgram: quoteTokenProgram,
          eventAuthority: cpAmmEventAuthority,
          cpAmmProgram: CP_AMM_PROGRAM_ID,
        } as any)
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(
      threw,
      "non-admin must not be able to call removeLiquidity",
    );

    // Step 7: Non-admin tries to remove all liquidity — must fail
    threw = false;
    try {
      await program.methods
        .removeAllLiquidity(new anchor.BN(0), new anchor.BN(0))
        .accounts({
          admin: nonAdmin.publicKey,
          poolAuthority: cpAmmPoolAuthority,
          pool: dammV2Pool,
          position,
          tokenAAccount: nonAdminBaseAta,
          tokenBAccount: nonAdminQuoteAta,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          positionNftAccount,
          feeClaimer: feeClaimerPda,
          tokenAProgram: baseTokenProgram,
          tokenBProgram: quoteTokenProgram,
          eventAuthority: cpAmmEventAuthority,
          cpAmmProgram: CP_AMM_PROGRAM_ID,
        } as any)
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(
      threw,
      "non-admin must not be able to call removeAllLiquidity",
    );

    // Step 8: Admin removes all remaining liquidity
    await program.methods
      .removeAllLiquidity(new anchor.BN(0), new anchor.BN(0))
      .accounts({
        admin: payer.publicKey,
        poolAuthority: cpAmmPoolAuthority,
        pool: dammV2Pool,
        position,
        tokenAAccount: payerBaseAta,
        tokenBAccount: payerQuoteAta,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram,
        tokenBProgram: quoteTokenProgram,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();
  });
});
