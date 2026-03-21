import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { DbcSwap } from "../target/types/dbc_swap";
import { setupConfigAndPool } from "./utils/createConfigAndPool";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

describe("dbc-swap:atomic-create-and-swap", () => {
  it("Creates config, initializes virtual pool, and swaps in one tx", async () => {
    const user = provider.wallet;
    const payer = (user as any).payer;
    const config = Keypair.generate();
    console.log("Config:", config.publicKey.toBase58());

    const baseMint = Keypair.generate();
    const poolAddress = await setupConfigAndPool(
      payer,
      config,
      payer.publicKey,
      101,
      baseMint,
    );

    const quoteMint = new PublicKey(
      "So11111111111111111111111111111111111111112",
    );

    const dbcProgramId = new PublicKey(
      "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    );
    const token2022ProgramId = new PublicKey(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    );
    const tokenQuoteProgramId = new PublicKey(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );

    const aBuf = baseMint.publicKey.toBuffer();
    const bBuf = quoteMint.toBuffer();
    const cmp = Buffer.compare(aBuf, bBuf);
    const maxKey = cmp > 0 ? baseMint.publicKey : quoteMint;
    const minKey = cmp > 0 ? quoteMint : baseMint.publicKey;

    const [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        config.publicKey.toBuffer(),
        maxKey.toBuffer(),
        minKey.toBuffer(),
      ],
      dbcProgramId,
    );
    const [baseVaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_vault"),
        baseMint.publicKey.toBuffer(),
        poolPda.toBuffer(),
      ],
      dbcProgramId,
    );
    const [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), quoteMint.toBuffer(), poolPda.toBuffer()],
      dbcProgramId,
    );
    const [poolAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_authority")],
      dbcProgramId,
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      dbcProgramId,
    );

    const inputTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      payer.publicKey,
      false,
      tokenQuoteProgramId,
    );
    const outputTokenAccount = getAssociatedTokenAddressSync(
      baseMint.publicKey,
      payer.publicKey,
      false,
      token2022ProgramId,
    );

    const tx = new anchor.web3.Transaction();

    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));

    const inputAtaInfo = await provider.connection.getAccountInfo(
      inputTokenAccount,
    );
    if (!inputAtaInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          inputTokenAccount,
          payer.publicKey,
          quoteMint,
          tokenQuoteProgramId,
        ),
      );
    }

    const swapAmountSol = 0.01;
    const wrapAmount = Math.round(swapAmountSol * anchor.web3.LAMPORTS_PER_SOL);

    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: inputTokenAccount,
        lamports: wrapAmount,
      }),
    );
    tx.add(createSyncNativeInstruction(inputTokenAccount, tokenQuoteProgramId));

    const initIx = await program.methods
      .initializeVirtualPoolWithToken2022({
        name: "WrappedTest",
        symbol: "WT",
        uri: "",
      })
      .accounts({
        config: config.publicKey,
        poolAuthority,
        creator: payer.publicKey,
        baseMint: baseMint.publicKey,
        quoteMint,
        pool: poolPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        payer: payer.publicKey,
        tokenQuoteProgram: tokenQuoteProgramId,
        tokenProgram: token2022ProgramId,
        eventAuthority,
        program: dbcProgramId,
      } as any)
      .instruction();
    tx.add(initIx);

    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        outputTokenAccount,
        payer.publicKey,
        baseMint.publicKey,
        token2022ProgramId,
      ),
    );

    const swapIx = await program.methods
      .swap({
        amountIn: new anchor.BN(wrapAmount),
        minimumAmountOut: new anchor.BN(0),
      })
      .accounts({
        poolAuthority,
        config: config.publicKey,
        pool: poolPda,
        inputTokenAccount,
        outputTokenAccount,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        baseMint: baseMint.publicKey,
        quoteMint,
        payer: payer.publicKey,
        tokenBaseProgram: token2022ProgramId,
        tokenQuoteProgram: tokenQuoteProgramId,
        referralTokenAccount: null,
        eventAuthority,
        dbcProgram: dbcProgramId,
      } as any)
      .instruction();
    tx.add(swapIx);

    const sig = await provider.sendAndConfirm(tx, [payer, baseMint]);
    console.log("Atomic tx:", sig);

    const balance = await provider.connection.getTokenAccountBalance(
      outputTokenAccount,
    );
    console.log(`Output balance: ${balance.value.uiAmountString}`);
  }).timeout(120000);
});
