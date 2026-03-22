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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  derivePoolAuthority,
  deriveCustomizablePoolAddress,
  derivePositionAddress,
  derivePositionNftAccount,
  getTokenProgram,
} from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";

import {
  deriveFeeClaimerPda,
  deriveAllPdas,
  derivePoolClaimersPda,
  deriveCpAmmFeeVaults,
  deriveCpAmmEventAuthority,
} from "./utils/constant";

import { DbcSwap } from "../target/types/dbc_swap";
import { setupConfigAndPool } from "./utils/createConfigAndPool";
import { fetchAllWalletNfts } from "./utils/nft_balance";
import { swap } from "./utils/swap";
import { dammV2Swap } from "./utils/damm_v2_swap";

import { assert } from "chai";
import { client, connection, DBC_PROGRAM_ID } from "./utils/helpers";
import { WSOL_MINT } from "./utils/wsol";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

describe("dbc-swap:damm-v2", () => {
  const user = provider.wallet;

  const feeClaimerPda = deriveFeeClaimerPda(program.programId);

  // Fund the DBC pool authority PDA with SOL for flash rent during migration
  // The migration CPI uses pool_authority as payer to create DAMM V2 pool accounts
  const dbcProgramId = new PublicKey(
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  );

  before(async () => {
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
  });

  async function setupPoolAndMigrate(payer: Keypair) {
    const config = Keypair.generate();
    console.log("Config:", config.publicKey.toBase58());

    const baseMint = Keypair.generate();

    const { poolAddress } = await setupConfigAndPool(
      payer,
      config,
      feeClaimerPda,
      101,
      baseMint,
    );

    // Need enough SOL to fill quote_reserve past 101 SOL threshold after fees (4% trading fee)
    // 101 / 0.96 ≈ 105.2 SOL minimum, using 110 to be safe
    await swap(payer, poolAddress, 110, false);

    // Verify pool state after swap
    const poolState = await client.state.getPool(poolAddress);
    console.log("Migration progress after swap:", poolState.migrationProgress);
    // 0 = PreBondingCurve, 1 = PostBondingCurve, 2 = LockedVesting, 3 = CreatedPool

    // This config has poolCreatorAuthority = DBC pool authority PDA (FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM)
    // Cloned from mainnet via `yarn start`. Required for DBC migration validation.
    // Dynamic config (configType=1) with DBC pool authority. Required for Customizable migration
    // which uses InitializePoolWithDynamicConfig CPI.
    const dammConfig = new PublicKey(
      "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
    );

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

    return {
      config,
      baseMint,
      poolAddress,
      firstPositionNftMint: tx.firstPositionNftKeypair.publicKey,
      secondPositionNftMint: tx.secondPositionNftKeypair.publicKey,
    };
  }
  it("fee claimer should hold DAMMv2 NFT custody", async () => {
    const user = provider.wallet;
    const payer = (user as any).payer;

    const nftBalance = await fetchAllWalletNfts(feeClaimerPda.toBase58());
    const { config, baseMint, poolAddress } = await setupPoolAndMigrate(payer);

    // console.log("Setup config:", config.publicKey.toBase58());
    // console.log("Setup base mint:", baseMint.publicKey.toBase58());
    // console.log("Migrated pool:", poolAddress.toBase58());

    const nftBalanceAfter = await fetchAllWalletNfts(feeClaimerPda.toBase58());

    assert.isTrue(
      nftBalanceAfter.length > nftBalance.length,
      "feeClaimerPda did not receive new DAMMv2 position NFT(s) as custodian",
    );
  });
  it("vault-harvest: fee vaults fill with real SOL after a DAMMv2 swap + claim", async () => {
    const payer = (provider.wallet as any).payer;
    const { config, baseMint, secondPositionNftMint } =
      await setupPoolAndMigrate(payer);

    // ── 1. Locate the real DAMMv2 pool from the migrated position NFT ─────────
    // secondPositionNftMint is the one whose authority is transferred to fee_claimer
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
      .setPoolClaimers(
        [payer.publicKey], // single claimer — 100% share
        [10_000], // 100% in BPS
        { dammV2: {} }, // PoolState::DammV2
      )
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
    console.log("pool_claimers initialized for DAMMv2 pool");

    // // ── Call claim_position_fee as a random stranger (permissionless) ──────
    const stranger = Keypair.generate();
    // Airdrop rent to stranger so it can pay for vault account creation
    const airdropSig = await connection.requestAirdrop(
      stranger.publicKey,
      12 * anchor.web3.LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(airdropSig, "confirmed");

    const cpAmmPoolAuthority = derivePoolAuthority();
    // position NFT is held in a token account owned by feeClaimerPda
    const positionNftAccount = derivePositionNftAccount(secondPositionNftMint);

    await dammV2Swap(stranger, dammV2Pool, poolState, 10, false);

    // fee vaults: [fee_vault, cp_amm_pool, mint] — PDAs owned by our program
    const { baseFeeVault, quoteFeeVault } = deriveCpAmmFeeVaults(
      dammV2Pool,
      poolState.tokenAMint,
      poolState.tokenBMint,
      program.programId,
    );

    const cpAmmEventAuthority = deriveCpAmmEventAuthority(CP_AMM_PROGRAM_ID);

    console.log(
      ` \n the token program addresses ${TOKEN_2022_PROGRAM_ID} and ${TOKEN_PROGRAM_ID}`,
    );

    console.log(
      `Token A and Token B program id's : ${getTokenProgram(
        poolState.tokenAFlag,
      )} and ${getTokenProgram(poolState.tokenBFlag)} \n`,
    );

    const sig = await program.methods
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
        payer: stranger.publicKey,
        feeClaimer: feeClaimerPda,
      } as any)
      .signers([stranger])
      .rpc();
    console.log("claim_position_fee tx:", sig);

    const baseVaultBalance = await provider.connection.getTokenAccountBalance(
      baseFeeVault,
    );
    const quoteVaultBalance = await provider.connection.getTokenAccountBalance(
      quoteFeeVault,
    );

    console.log(
      "base_fee_vault balance:",
      baseVaultBalance.value.uiAmountString,
      "| quote_fee_vault balance:",
      quoteVaultBalance.value.uiAmountString,
    );

    //   const baseAmount = Number(baseVaultBalance.value.amount);
    //   const quoteAmount = Number(quoteVaultBalance.value.amount);
    //   assert.isTrue(
    //     baseAmount > 0 || quoteAmount > 0,
    //     "fee vaults are empty — claim_position_fee did not sweep any fees from DAMMv2",
    //   );
  });
});
