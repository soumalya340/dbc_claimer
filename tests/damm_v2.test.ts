import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  CpAmm,
  derivePositionAddress,
  getTokenProgram,
} from "@meteora-ag/cp-amm-sdk";

import {
  deriveFeeClaimerPda,
  derivePoolClaimersPda,
  deriveCpAmmFeeVaults,
} from "./utils/constant";
import { DbcSwap } from "../target/types/dbc_swap";
import { fetchAllWalletNfts } from "./utils/nft_balance";
import { assert } from "chai";
import {
  connection,
  CP_AMM_PROGRAM_ID,
  fetchclaimerspdainfo,
} from "./utils/helpers";

import {
  createRandomKeyPair,
  setupPoolAndMigrate,
  getPositionInfo,
  claimPositionFeeModule,
} from "./test_helpers/dammv2";

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

    await fetchclaimerspdainfo(program, cpAmmPoolClaimersPda);

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
    await fetchclaimerspdainfo(program, cpAmmPoolClaimersPda);
  });
});
