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
  deriveClaimerStatePda,
  deriveClaimerPendingBaseVault,
  deriveClaimerPendingQuoteVault,
} from "./utils/constant";
import {
  connection,
  CP_AMM_PROGRAM_ID,
  fetchclaimerspdainfo,
  fetchClaimerState,
  distribute_fees,
  buildInitClaimersRemainingAccounts,
  buildDistributeFeesRemainingAccounts,
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

    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);

    const initRemainingAccounts = buildInitClaimersRemainingAccounts(
      dammV2Pool,
      [payer.publicKey],
      program.programId,
    );

    await program.methods
      .initializePoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTokenProgram,
        tokenQuoteProgram: quoteTokenProgram,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(initRemainingAccounts)
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

    const distributeRemainingAccounts = buildDistributeFeesRemainingAccounts(
      dammV2Pool,
      [payer.publicKey],
      poolState.tokenAMint,
      poolState.tokenBMint,
      baseTokenProgram,
      quoteTokenProgram,
      program.programId,
    );

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
      distributeRemainingAccounts,
    );

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

    const baseTokenProgram = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram = getTokenProgram(poolState.tokenBFlag);
    const claimers = [payer.publicKey, user2.publicKey, user3.publicKey];

    // Step 1: Set claimers payer=20%, user2=30%, user3=50%
    await program.methods
      .initializePoolClaimers(claimers, [2000, 3000, 5000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTokenProgram,
        tokenQuoteProgram: quoteTokenProgram,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          claimers,
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    // Step 1b: Verify initial PDA state
    const initialInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(initialInfo.claimerBps, [2000, 3000, 5000]);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);

    // Verify per-claimer state is initialized to zero
    for (const claimer of claimers) {
      const state = await fetchClaimerState(program, dammV2Pool, claimer);
      assert.strictEqual(state.claimedBase.toNumber(), 0);
      assert.strictEqual(state.claimedQuote.toNumber(), 0);
      assert.isTrue(state.isEnabled);
    }

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

    // Step 3: Create ATAs for all 3 claimers
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
      buildDistributeFeesRemainingAccounts(
        dammV2Pool,
        claimers,
        poolState.tokenAMint,
        poolState.tokenBMint,
        baseTokenProgram,
        quoteTokenProgram,
        program.programId,
      ),
    );

    // Step 4: Verify proportional payouts via ClaimerState
    const payerExpected = Math.floor((quoteAmount * 2000) / 10000);
    const user2Expected = Math.floor((quoteAmount * 3000) / 10000);
    const user3Expected = quoteAmount - payerExpected - user2Expected;

    const payerState1 = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    const user2State1 = await fetchClaimerState(
      program,
      dammV2Pool,
      user2.publicKey,
    );
    const user3State1 = await fetchClaimerState(
      program,
      dammV2Pool,
      user3.publicKey,
    );
    assert.strictEqual(payerState1.claimedQuote.toNumber(), payerExpected);
    assert.strictEqual(user2State1.claimedQuote.toNumber(), user2Expected);
    assert.strictEqual(user3State1.claimedQuote.toNumber(), user3Expected);

    // Step 4b: lastDistributed must be non-zero
    const pdaInfoRound1 = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.isAbove(pdaInfoRound1.lastDistributed.toNumber(), 0);

    // Step 5: Update claimers to payer=50%, user2=30%, user3=20%
    await program.methods
      .initializePoolClaimers(claimers, [5000, 3000, 2000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTokenProgram,
        tokenQuoteProgram: quoteTokenProgram,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          claimers,
          program.programId,
        ),
      )
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
      buildDistributeFeesRemainingAccounts(
        dammV2Pool,
        claimers,
        poolState.tokenAMint,
        poolState.tokenBMint,
        baseTokenProgram,
        quoteTokenProgram,
        program.programId,
      ),
    );

    // Step 8: Verify updated proportions via ClaimerState.
    // ClaimerState is cumulative; initializePoolClaimers does not reset existing state PDAs.
    const payerExpected2Round = Math.floor((quoteAmount2 * 5000) / 10000);
    const user2Expected2Round = Math.floor((quoteAmount2 * 3000) / 10000);
    const user3Expected2Round =
      quoteAmount2 - payerExpected2Round - user2Expected2Round;

    const payerExpected2 = payerExpected + payerExpected2Round;
    const user2Expected2 = user2Expected + user2Expected2Round;
    const user3Expected2 = user3Expected + user3Expected2Round;

    const payerState2 = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    const user2State2 = await fetchClaimerState(
      program,
      dammV2Pool,
      user2.publicKey,
    );
    const user3State2 = await fetchClaimerState(
      program,
      dammV2Pool,
      user3.publicKey,
    );
    assert.strictEqual(payerState2.claimedQuote.toNumber(), payerExpected2);
    assert.strictEqual(user2State2.claimedQuote.toNumber(), user2Expected2);
    assert.strictEqual(user3State2.claimedQuote.toNumber(), user3Expected2);

    // After step 7b distributeFees, the fee vault should be empty
    const vaultBalanceAfterRound2 =
      await provider.connection.getTokenAccountBalance(quoteFeeVault);
    assert.strictEqual(Number(vaultBalanceAfterRound2.value.amount), 0);

    // Update BPS to 50% / 50% / 0% — only BPS changes, ClaimerState history is untouched
    await program.methods
      .updateClaimersBps([5000, 5000, 0])
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        poolClaimers: cpAmmPoolClaimersPda,
      } as any)
      .signers([payer])
      .rpc();

    const pdaInfoAfterBpsUpdate = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(pdaInfoAfterBpsUpdate.claimerBps, [5000, 5000, 0]);

    // Past claimed amounts in ClaimerState are preserved — updateClaimersBps does NOT reset them
    const payerStateAfterBps = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    const user2StateAfterBps = await fetchClaimerState(
      program,
      dammV2Pool,
      user2.publicKey,
    );
    const user3StateAfterBps = await fetchClaimerState(
      program,
      dammV2Pool,
      user3.publicKey,
    );
    assert.strictEqual(
      payerStateAfterBps.claimedQuote.toNumber(),
      payerExpected2,
    );
    assert.strictEqual(
      user2StateAfterBps.claimedQuote.toNumber(),
      user2Expected2,
    );
    assert.strictEqual(
      user3StateAfterBps.claimedQuote.toNumber(),
      user3Expected2,
    );

    // Round 3: swap + claimPositionFee + distributeFees under the new 50/50/0 split.
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
      buildDistributeFeesRemainingAccounts(
        dammV2Pool,
        claimers,
        poolState.tokenAMint,
        poolState.tokenBMint,
        baseTokenProgram,
        quoteTokenProgram,
        program.programId,
      ),
    );

    // Delta = new cumulative claimed − previous cumulative claimed (preserved from round 2)
    const payerState3 = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    const user2State3 = await fetchClaimerState(
      program,
      dammV2Pool,
      user2.publicKey,
    );
    const user3State3 = await fetchClaimerState(
      program,
      dammV2Pool,
      user3.publicKey,
    );

    const payerRound3Delta =
      payerState3.claimedQuote.toNumber() - payerExpected2;
    const user2Round3Delta =
      user2State3.claimedQuote.toNumber() - user2Expected2;
    const user3Round3Delta =
      user3State3.claimedQuote.toNumber() - user3Expected2;

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

    const baseTokenProgram4 = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram4 = getTokenProgram(poolState.tokenBFlag);

    // Register admin as sole 100% claimer
    await program.methods
      .initializePoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTokenProgram4,
        tokenQuoteProgram: quoteTokenProgram4,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          [payer.publicKey],
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    // Assert initial PDA state
    const initialInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );

    assert.deepEqual(initialInfo.claimerBps, [10_000]);
    assert.strictEqual(initialInfo.lastDistributed.toNumber(), 0);
    assert.strictEqual(initialInfo.lastClaimed.toNumber(), 0);
    const payerStateInit4 = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    assert.strictEqual(payerStateInit4.claimedBase.toNumber(), 0);
    assert.strictEqual(payerStateInit4.claimedQuote.toNumber(), 0);

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
    console.log("Hello3");

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
    const payerBaseAta4 = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTokenProgram4,
    );
    const payerQuoteAta4 = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTokenProgram4,
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta4,
        payer.publicKey,
        poolState.tokenAMint,
        baseTokenProgram4,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta4,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram4,
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
      baseTokenProgram4,
      quoteTokenProgram4,
      buildDistributeFeesRemainingAccounts(
        dammV2Pool,
        [payer.publicKey],
        poolState.tokenAMint,
        poolState.tokenBMint,
        baseTokenProgram4,
        quoteTokenProgram4,
        program.programId,
      ),
    );

    // Assert: admin received exactly 100%
    const payerQuoteBalance = await provider.connection.getTokenAccountBalance(
      payerQuoteAta4,
    );
    assert.strictEqual(
      Number(payerQuoteBalance.value.amount),
      quoteAmount,
      `fee claimer must receive exactly 100% of fees (${quoteAmount} lamports) — not even 1 lamport less`,
    );

    // Confirm ClaimerState claimedQuote reflects the full amount
    const finalPayerState4 = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    assert.strictEqual(
      finalPayerState4.claimedQuote.toNumber(),
      quoteAmount,
      "ClaimerState claimedQuote must equal the exact fee vault amount",
    );

    console.log("Hello5");
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
      (await provider.connection.getTokenAccountBalance(payerBaseAta4)).value
        .amount,
    );
    const quoteBalanceBefore = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta4)).value
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
        tokenAAccount: payerBaseAta4,
        tokenBAccount: payerQuoteAta4,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram4,
        tokenBProgram: quoteTokenProgram4,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();

    // Admin received exactly the tokens that left the vault — no lamport lost
    const baseBalanceAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(payerBaseAta4)).value
        .amount,
    );
    const quoteBalanceAfterPartial = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta4)).value
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

    console.log("Hello9");

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
        tokenAAccount: payerBaseAta4,
        tokenBAccount: payerQuoteAta4,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram4,
        tokenBProgram: quoteTokenProgram4,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();

    const baseBalanceAfterFull = Number(
      (await provider.connection.getTokenAccountBalance(payerBaseAta4)).value
        .amount,
    );
    const quoteBalanceAfterFull = Number(
      (await provider.connection.getTokenAccountBalance(payerQuoteAta4)).value
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

    const baseTokenProgram5 = getTokenProgram(poolState.tokenAFlag);
    const quoteTokenProgram5 = getTokenProgram(poolState.tokenBFlag);

    // Step 1: Admin initializes poolClaimers PDA
    await program.methods
      .initializePoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTokenProgram5,
        tokenQuoteProgram: quoteTokenProgram5,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          [payer.publicKey],
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    const pdaInfo = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(pdaInfo.claimerBps, [10_000]);

    // Step 2: Non-admin tries to call initializePoolClaimers — must fail
    let threw = false;
    try {
      await program.methods
        .initializePoolClaimers([nonAdmin.publicKey], [10_000], { dammV2: {} })
        .accounts({
          deployer: nonAdmin.publicKey,
          pool: dammV2Pool,
          baseMint: poolState.tokenAMint,
          quoteMint: poolState.tokenBMint,
          poolClaimers: cpAmmPoolClaimersPda,
          tokenBaseProgram: baseTokenProgram5,
          tokenQuoteProgram: quoteTokenProgram5,
          systemProgram: SystemProgram.programId,
        } as any)
        .remainingAccounts(
          buildInitClaimersRemainingAccounts(
            dammV2Pool,
            [nonAdmin.publicKey],
            program.programId,
          ),
        )
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(
      threw,
      "non-admin must not be able to call initializePoolClaimers",
    );

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
    assert.isTrue(
      threw,
      "non-admin must not be able to call updateClaimersBps",
    );

    // Prepare ATAs for admin and non-admin
    const payerBaseAta5 = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTokenProgram5,
    );
    const payerQuoteAta5 = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTokenProgram5,
    );
    const nonAdminBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      nonAdmin.publicKey,
      false,
      baseTokenProgram5,
    );
    const nonAdminQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      nonAdmin.publicKey,
      false,
      quoteTokenProgram5,
    );

    const createAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta5,
        payer.publicKey,
        poolState.tokenAMint,
        baseTokenProgram5,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta5,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram5,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        nonAdminBaseAta,
        nonAdmin.publicKey,
        poolState.tokenAMint,
        baseTokenProgram5,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        nonAdminQuoteAta,
        nonAdmin.publicKey,
        poolState.tokenBMint,
        quoteTokenProgram5,
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
        tokenAAccount: payerBaseAta5,
        tokenBAccount: payerQuoteAta5,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram5,
        tokenBProgram: quoteTokenProgram5,
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
          tokenAProgram: baseTokenProgram5,
          tokenBProgram: quoteTokenProgram5,
          eventAuthority: cpAmmEventAuthority,
          cpAmmProgram: CP_AMM_PROGRAM_ID,
        } as any)
        .signers([nonAdmin])
        .rpc();
    } catch {
      threw = true;
    }
    assert.isTrue(threw, "non-admin must not be able to call removeLiquidity");

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
          tokenAProgram: baseTokenProgram5,
          tokenBProgram: quoteTokenProgram5,
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
        tokenAAccount: payerBaseAta5,
        tokenBAccount: payerQuoteAta5,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        positionNftAccount,
        feeClaimer: feeClaimerPda,
        tokenAProgram: baseTokenProgram5,
        tokenBProgram: quoteTokenProgram5,
        eventAuthority: cpAmmEventAuthority,
        cpAmmProgram: CP_AMM_PROGRAM_ID,
      } as any)
      .signers([payer])
      .rpc();
  });

  it("test6: disabled claimer → pending vaults; admin sweeps to arbitrary recipient", async () => {
    const payer = (provider.wallet as any).payer;

    // Step 1: Fresh pool via DBC (default migration path — enough quote for migration)
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

    const baseTp6 = getTokenProgram(poolState.tokenAFlag);
    const quoteTp6 = getTokenProgram(poolState.tokenBFlag);

    await program.methods
      .initializePoolClaimers([payer.publicKey], [10_000], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTp6,
        tokenQuoteProgram: quoteTp6,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          [payer.publicKey],
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

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

    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    const quoteVaultBefore = Number(
      (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
        .amount,
    );
    const baseVaultBefore = Number(
      (await provider.connection.getTokenAccountBalance(baseFeeVault)).value
        .amount,
    );

    assert.isTrue(
      quoteVaultBefore > 0 || baseVaultBefore > 0,
      "fee vaults should hold tokens after swap + claim_position_fee",
    );

    // Step 2: Admin disables the sole claimer — next distribute parks into pending vaults
    const claimerStatePda = deriveClaimerStatePda(
      dammV2Pool,
      payer.publicKey,
      program.programId,
    );

    await program.methods
      .setClaimerEnabled(false)
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: payer.publicKey,
        claimerState: claimerStatePda,
      } as any)
      .signers([payer])
      .rpc();

    const payerBaseAta6 = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      payer.publicKey,
      false,
      baseTp6,
    );
    const payerQuoteAta6 = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      payer.publicKey,
      false,
      quoteTp6,
    );

    const createAtaTx6 = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerBaseAta6,
        payer.publicKey,
        poolState.tokenAMint,
        baseTp6,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerQuoteAta6,
        payer.publicKey,
        poolState.tokenBMint,
        quoteTp6,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaTx6, [payer]);

    const distributeRem6 = buildDistributeFeesRemainingAccounts(
      dammV2Pool,
      [payer.publicKey],
      poolState.tokenAMint,
      poolState.tokenBMint,
      baseTp6,
      quoteTp6,
      program.programId,
    );

    // Step 3: Distribute — disabled claimer share goes to pending_* (not payer ATAs)
    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTp6,
      quoteTp6,
      distributeRem6,
    );

    // Step 4: Program fee vaults empty; pending vaults hold exact former balances
    const quoteVaultAfter = Number(
      (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
        .amount,
    );
    const baseVaultAfter = Number(
      (await provider.connection.getTokenAccountBalance(baseFeeVault)).value
        .amount,
    );

    assert.strictEqual(
      quoteVaultAfter,
      0,
      "quote fee vault must be exactly zero after distribute with disabled claimer",
    );
    assert.strictEqual(
      baseVaultAfter,
      0,
      "base fee vault must be exactly zero after distribute with disabled claimer",
    );

    const pendingQuotePda = deriveClaimerPendingQuoteVault(
      dammV2Pool,
      payer.publicKey,
      program.programId,
    );
    const pendingBasePda = deriveClaimerPendingBaseVault(
      dammV2Pool,
      payer.publicKey,
      program.programId,
    );

    const pendingQuoteAfter = Number(
      (await provider.connection.getTokenAccountBalance(pendingQuotePda)).value
        .amount,
    );
    const pendingBaseAfter = Number(
      (await provider.connection.getTokenAccountBalance(pendingBasePda)).value
        .amount,
    );

    assert.strictEqual(
      pendingQuoteAfter,
      quoteVaultBefore,
      "pending quote vault must equal pre-distribute quote fee vault balance",
    );
    assert.strictEqual(
      pendingBaseAfter,
      baseVaultBefore,
      "pending base vault must equal pre-distribute base fee vault balance",
    );

    // Step 5: Sweep to a random wallet (not the registered claimer)
    const sweepRecipient = await createRandomKeyPair(5);
    assert.notStrictEqual(
      sweepRecipient.publicKey.toBase58(),
      payer.publicKey.toBase58(),
      "sanity: sweep recipient must differ from claimer",
    );

    const destBaseAta = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      sweepRecipient.publicKey,
      false,
      baseTp6,
    );
    const destQuoteAta = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      sweepRecipient.publicKey,
      false,
      quoteTp6,
    );

    const createDestAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destBaseAta,
        sweepRecipient.publicKey,
        poolState.tokenAMint,
        baseTp6,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destQuoteAta,
        sweepRecipient.publicKey,
        poolState.tokenBMint,
        quoteTp6,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createDestAtaTx, [
      payer,
    ]);

    await program.methods
      .adminSweepClaimer()
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: payer.publicKey,
        claimerState: claimerStatePda,
        claimerPendingBaseVault: pendingBasePda,
        claimerPendingQuoteVault: pendingQuotePda,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        destinationBaseAta: destBaseAta,
        destinationQuoteAta: destQuoteAta,
        tokenBaseProgram: baseTp6,
        tokenQuoteProgram: quoteTp6,
      } as any)
      .signers([payer])
      .rpc();

    const destQuoteBal = Number(
      (await provider.connection.getTokenAccountBalance(destQuoteAta)).value
        .amount,
    );
    const destBaseBal = Number(
      (await provider.connection.getTokenAccountBalance(destBaseAta)).value
        .amount,
    );

    assert.strictEqual(destQuoteBal, quoteVaultBefore);
    assert.strictEqual(destBaseBal, baseVaultBefore);

    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(pendingQuotePda))
          .value.amount,
      ),
      0,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(pendingBasePda)).value
          .amount,
      ),
      0,
    );

    const stateAfter = await fetchClaimerState(
      program,
      dammV2Pool,
      payer.publicKey,
    );
    assert.isFalse(stateAfter.isEnabled);
  });

  it("test7: re-init claimer list succeeds; Alice & Bob pending vaults survive and admin_sweep still works", async () => {
    const payer = (provider.wallet as any).payer;

    const alice = await createRandomKeyPair(2);
    const bob = await createRandomKeyPair(2);
    const charlie = await createRandomKeyPair(2);
    const user1 = await createRandomKeyPair(2);
    const user2 = await createRandomKeyPair(2);

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

    const baseTp7 = getTokenProgram(poolState.tokenAFlag);
    const quoteTp7 = getTokenProgram(poolState.tokenBFlag);

    const claimersAbc = [alice.publicKey, bob.publicKey, charlie.publicKey];
    const bpsAbc = [3000, 3000, 4000] as const;

    await program.methods
      .initializePoolClaimers(claimersAbc, [...bpsAbc], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTp7,
        tokenQuoteProgram: quoteTp7,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          claimersAbc,
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    const stranger = await createRandomKeyPair(12);
    await claimPositionFeeModule(
      stranger,
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

    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    const quoteBalBefore = Number(
      (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
        .amount,
    );
    const baseBalBefore = Number(
      (await provider.connection.getTokenAccountBalance(baseFeeVault)).value
        .amount,
    );
    assert.isTrue(
      quoteBalBefore > 0 || baseBalBefore > 0,
      "fee vaults should be non-empty after claim",
    );

    // ATAs for distribute_fees remaining accounts (Charlie enabled path validates his ATAs)
    const createAtaAbc = new anchor.web3.Transaction().add(
      ...claimersAbc.flatMap((claimer) => [
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          getAssociatedTokenAddressSync(
            poolState.tokenAMint,
            claimer,
            false,
            baseTp7,
          ),
          claimer,
          poolState.tokenAMint,
          baseTp7,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          getAssociatedTokenAddressSync(
            poolState.tokenBMint,
            claimer,
            false,
            quoteTp7,
          ),
          claimer,
          poolState.tokenBMint,
          quoteTp7,
        ),
      ]),
    );
    await sendAndConfirmTransaction(provider.connection, createAtaAbc, [payer]);

    const aliceStatePda = deriveClaimerStatePda(
      dammV2Pool,
      alice.publicKey,
      program.programId,
    );
    const bobStatePda = deriveClaimerStatePda(
      dammV2Pool,
      bob.publicKey,
      program.programId,
    );

    await program.methods
      .setClaimerEnabled(false)
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: alice.publicKey,
        claimerState: aliceStatePda,
      } as any)
      .signers([payer])
      .rpc();

    await program.methods
      .setClaimerEnabled(false)
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: bob.publicKey,
        claimerState: bobStatePda,
      } as any)
      .signers([payer])
      .rpc();

    await distribute_fees(
      program,
      payer,
      dammV2Pool,
      cpAmmPoolClaimersPda,
      baseFeeVault,
      quoteFeeVault,
      poolState,
      feeClaimerPda,
      baseTp7,
      quoteTp7,
      buildDistributeFeesRemainingAccounts(
        dammV2Pool,
        claimersAbc,
        poolState.tokenAMint,
        poolState.tokenBMint,
        baseTp7,
        quoteTp7,
        program.programId,
      ),
    );

    const alicePendingBase = deriveClaimerPendingBaseVault(
      dammV2Pool,
      alice.publicKey,
      program.programId,
    );
    const alicePendingQuote = deriveClaimerPendingQuoteVault(
      dammV2Pool,
      alice.publicKey,
      program.programId,
    );
    const bobPendingBase = deriveClaimerPendingBaseVault(
      dammV2Pool,
      bob.publicKey,
      program.programId,
    );
    const bobPendingQuote = deriveClaimerPendingQuoteVault(
      dammV2Pool,
      bob.publicKey,
      program.programId,
    );

    const aliceQuotePending = Number(
      (await provider.connection.getTokenAccountBalance(alicePendingQuote))
        .value.amount,
    );
    const bobQuotePending = Number(
      (await provider.connection.getTokenAccountBalance(bobPendingQuote)).value
        .amount,
    );
    const aliceBasePending = Number(
      (await provider.connection.getTokenAccountBalance(alicePendingBase)).value
        .amount,
    );
    const bobBasePending = Number(
      (await provider.connection.getTokenAccountBalance(bobPendingBase)).value
        .amount,
    );

    const expAliceQuote = Math.floor((quoteBalBefore * bpsAbc[0]) / 10_000);
    const expBobQuote = Math.floor((quoteBalBefore * bpsAbc[1]) / 10_000);
    const expAliceBase = Math.floor((baseBalBefore * bpsAbc[0]) / 10_000);
    const expBobBase = Math.floor((baseBalBefore * bpsAbc[1]) / 10_000);

    assert.strictEqual(
      aliceQuotePending,
      expAliceQuote,
      "Alice pending quote should match her BPS share (disabled)",
    );
    assert.strictEqual(
      bobQuotePending,
      expBobQuote,
      "Bob pending quote should match his BPS share (disabled)",
    );
    assert.strictEqual(aliceBasePending, expAliceBase);
    assert.strictEqual(bobBasePending, expBobBase);

    const aliceStateAfterDist = await fetchClaimerState(
      program,
      dammV2Pool,
      alice.publicKey,
    );
    const bobStateAfterDist = await fetchClaimerState(
      program,
      dammV2Pool,
      bob.publicKey,
    );
    assert.strictEqual(
      aliceStateAfterDist.claimedQuote.toNumber(),
      0,
      "disabled claimer: claimed_quote stays 0; funds sit in pending vault",
    );
    assert.strictEqual(bobStateAfterDist.claimedQuote.toNumber(), 0);

    // Re-initialize: drop Alice & Bob, add user1 & user2, keep Charlie — must not throw
    const claimersUuc = [user1.publicKey, user2.publicKey, charlie.publicKey];
    const bpsUuc = [3400, 3300, 3300] as const;

    await program.methods
      .initializePoolClaimers(claimersUuc, [...bpsUuc], { dammV2: {} })
      .accounts({
        deployer: payer.publicKey,
        pool: dammV2Pool,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        poolClaimers: cpAmmPoolClaimersPda,
        tokenBaseProgram: baseTp7,
        tokenQuoteProgram: quoteTp7,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        buildInitClaimersRemainingAccounts(
          dammV2Pool,
          claimersUuc,
          program.programId,
        ),
      )
      .signers([payer])
      .rpc();

    const afterReinit = await fetchclaimerspdainfo(
      program,
      cpAmmPoolClaimersPda,
      false,
    );
    assert.deepEqual(
      afterReinit.claimerAddresses.map((k) => k.toBase58()),
      claimersUuc.map((k) => k.toBase58()),
    );
    assert.deepEqual(afterReinit.claimerBps, [...bpsUuc]);

    // Pending balances for Alice & Bob unchanged (not referenced by PoolClaimers anymore)
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(alicePendingQuote))
          .value.amount,
      ),
      expAliceQuote,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(bobPendingQuote))
          .value.amount,
      ),
      expBobQuote,
    );

    const sweepAliceRecipient = await createRandomKeyPair(2);
    const sweepBobRecipient = await createRandomKeyPair(2);

    const aliceDestBase = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      sweepAliceRecipient.publicKey,
      false,
      baseTp7,
    );
    const aliceDestQuote = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      sweepAliceRecipient.publicKey,
      false,
      quoteTp7,
    );
    const bobDestBase = getAssociatedTokenAddressSync(
      poolState.tokenAMint,
      sweepBobRecipient.publicKey,
      false,
      baseTp7,
    );
    const bobDestQuote = getAssociatedTokenAddressSync(
      poolState.tokenBMint,
      sweepBobRecipient.publicKey,
      false,
      quoteTp7,
    );

    const createSweepAtas = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        aliceDestBase,
        sweepAliceRecipient.publicKey,
        poolState.tokenAMint,
        baseTp7,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        aliceDestQuote,
        sweepAliceRecipient.publicKey,
        poolState.tokenBMint,
        quoteTp7,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        bobDestBase,
        sweepBobRecipient.publicKey,
        poolState.tokenAMint,
        baseTp7,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        bobDestQuote,
        sweepBobRecipient.publicKey,
        poolState.tokenBMint,
        quoteTp7,
      ),
    );
    await sendAndConfirmTransaction(provider.connection, createSweepAtas, [
      payer,
    ]);

    await program.methods
      .adminSweepClaimer()
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: alice.publicKey,
        claimerState: aliceStatePda,
        claimerPendingBaseVault: alicePendingBase,
        claimerPendingQuoteVault: alicePendingQuote,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        destinationBaseAta: aliceDestBase,
        destinationQuoteAta: aliceDestQuote,
        tokenBaseProgram: baseTp7,
        tokenQuoteProgram: quoteTp7,
      } as any)
      .signers([payer])
      .rpc();

    await program.methods
      .adminSweepClaimer()
      .accounts({
        admin: payer.publicKey,
        pool: dammV2Pool,
        claimer: bob.publicKey,
        claimerState: bobStatePda,
        claimerPendingBaseVault: bobPendingBase,
        claimerPendingQuoteVault: bobPendingQuote,
        baseMint: poolState.tokenAMint,
        quoteMint: poolState.tokenBMint,
        destinationBaseAta: bobDestBase,
        destinationQuoteAta: bobDestQuote,
        tokenBaseProgram: baseTp7,
        tokenQuoteProgram: quoteTp7,
      } as any)
      .signers([payer])
      .rpc();

    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(aliceDestQuote)).value
          .amount,
      ),
      expAliceQuote,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(aliceDestBase)).value
          .amount,
      ),
      expAliceBase,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(bobDestQuote)).value
          .amount,
      ),
      expBobQuote,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(bobDestBase)).value
          .amount,
      ),
      expBobBase,
    );

    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(alicePendingQuote))
          .value.amount,
      ),
      0,
    );
    assert.strictEqual(
      Number(
        (await provider.connection.getTokenAccountBalance(bobPendingQuote))
          .value.amount,
      ),
      0,
    );
  });
});
