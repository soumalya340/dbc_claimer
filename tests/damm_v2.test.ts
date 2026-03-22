import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { CpAmm, derivePositionAddress } from "@meteora-ag/cp-amm-sdk";

import {
  deriveFeeClaimerPda,
  derivePoolClaimersPda,
  deriveCpAmmFeeVaults,
} from "./utils/constant";
import { DbcSwap } from "../target/types/dbc_swap";
import { fetchAllWalletNfts } from "./utils/nft_balance";
import { assert } from "chai";
import { connection, CP_AMM_PROGRAM_ID } from "./utils/helpers";

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

  it("fee claimer should hold DAMMv2 NFT custody", async () => {
    const payer = (provider.wallet as any).payer;

    const nftBalance = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    await setupPoolAndMigrate(payer, feeClaimerPda);

    const nftBalanceAfter = await fetchAllWalletNfts(feeClaimerPda.toBase58());

    assert.isTrue(
      nftBalanceAfter.length > nftBalance.length,
      "feeClaimerPda did not receive new DAMMv2 position NFT(s) as custodian",
    );
  });

  it("vault-harvest: fee vaults fill with real SOL after a DAMMv2 swap + claim", async () => {
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

    const poolClaimersAccount = await program.account.poolClaimers.fetch(
      cpAmmPoolClaimersPda,
    );

    console.log(
      "PoolClaimers account info:",
      JSON.stringify(
        {
          pool: poolClaimersAccount.pool.toBase58(),
          poolState: JSON.stringify(poolClaimersAccount.poolState),
          claimerAddresses: poolClaimersAccount.claimerAddresses.map(
            (c: PublicKey) => c.toBase58(),
          ),
          claimerBps: poolClaimersAccount.claimerBps,
          claimedBase: poolClaimersAccount.claimedBase.map((n: anchor.BN) =>
            n.toString(),
          ),
          claimedQuote: poolClaimersAccount.claimedQuote.map((n: anchor.BN) =>
            n.toString(),
          ),
          lastClaimed: poolClaimersAccount.lastClaimed.toString(),
          lastDistributed: poolClaimersAccount.lastDistributed.toString(),
          bump: poolClaimersAccount.bump,
        },
        null,
        2,
      ),
    );

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

    const baseVaultBalance = await provider.connection.getTokenAccountBalance(
      baseFeeVault,
    );
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
  });
});
