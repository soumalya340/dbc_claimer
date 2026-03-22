// import * as anchor from "@coral-xyz/anchor";
// import { Program } from "@coral-xyz/anchor";
// import {
//   Keypair,
//   Connection,
//   PublicKey,
//   LAMPORTS_PER_SOL,
//   SystemProgram,
// } from "@solana/web3.js";
// import {
//   getAssociatedTokenAddressSync,
//   createAssociatedTokenAccountInstruction,
//   TOKEN_2022_PROGRAM_ID,
// } from "@solana/spl-token";
// import {
//   DynamicBondingCurveClient,
//   getCurrentPoint,
// } from "@meteora-ag/dynamic-bonding-curve-sdk";

// import { DbcSwap } from "../target/types/dbc_swap";
// import { setupConfigAndPool } from "./utils/createConfigAndPool";
// import { wrapSol } from "./utils/wsol";
// import { assert } from "chai";
// import { deriveAllPdas } from "./utils/constant";

// describe("claim_partner_trading_fee", () => {
//   const provider = anchor.AnchorProvider.env();
//   anchor.setProvider(provider);

//   const program = anchor.workspace.dbcSwap as Program<DbcSwap>;

//   // ─── well-known constants ──────────────────────────────────────────────────
//   const DBC_PROGRAM_ID = new PublicKey(
//     "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
//   );
//   const TOKEN_2022_PROGRAM_ID_PK = new PublicKey(
//     "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
//   );
//   const SPL_TOKEN_PROGRAM_ID = new PublicKey(
//     "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
//   );
//   const WSOL_MINT = new PublicKey(
//     "So11111111111111111111111111111111111111112",
//   );
//   const U64_MAX = new anchor.BN("18446744073709551615");
//   const LOCAL_RPC = "http://localhost:8899";

//   // ─── shared state set up once in before() ─────────────────────────────────
//   let payer: Keypair;
//   let baseMint: Keypair;
//   let config: Keypair;

//   // DBC PDAs
//   let poolPda: PublicKey;
//   let baseVaultPda: PublicKey;
//   let quoteVaultPda: PublicKey;
//   let poolAuthority: PublicKey;
//   let eventAuthority: PublicKey;

//   // dbc-swap program PDAs
//   let feeClaimerPda: PublicKey;
//   let feeConfigPda: PublicKey;
//   let baseFeeVault: PublicKey;
//   let quoteFeeVault: PublicKey;
//   let poolClaimersPda: PublicKey;
//   const amountToSwap = 5;

//   // ─── helpers ──────────────────────────────────────────────────────────────

//   /** Executes a quote → base swap via Meteora DBC SDK (swapQuote + swap) */
//   async function doSwap(swapAmountSol: number) {
//     const connection = new Connection(LOCAL_RPC, "confirmed");
//     const client = new DynamicBondingCurveClient(connection, "confirmed");

//     const amountIn = new anchor.BN(
//       Math.round(swapAmountSol * LAMPORTS_PER_SOL),
//     );

//     // ── 1. wrap SOL → WSOL ATA ──
//     await wrapSol(provider, payer, swapAmountSol);

//     // ── 2. create base-token output ATA if needed ──
//     const outputTokenAccount = getAssociatedTokenAddressSync(
//       baseMint.publicKey,
//       payer.publicKey,
//       false,
//       TOKEN_2022_PROGRAM_ID_PK,
//     );
//     if (!(await provider.connection.getAccountInfo(outputTokenAccount))) {
//       await provider.sendAndConfirm(
//         new anchor.web3.Transaction().add(
//           createAssociatedTokenAccountInstruction(
//             payer.publicKey,
//             outputTokenAccount,
//             payer.publicKey,
//             baseMint.publicKey,
//             TOKEN_2022_PROGRAM_ID_PK,
//           ),
//         ),
//         [payer],
//       );
//     }

//     // ── 3. get quote for minimumAmountOut ──
//     const virtualPoolState = await client.state.getPool(poolPda);
//     const poolConfigState = await client.state.getPoolConfig(
//       virtualPoolState.config,
//     );
//     const currentPoint = await getCurrentPoint(
//       connection,
//       poolConfigState.activationType,
//     );

//     const quote = client.pool.swapQuote({
//       virtualPool: virtualPoolState,
//       config: poolConfigState,
//       swapBaseForQuote: false, // quote (SOL) → base
//       amountIn,
//       slippageBps: 50,
//       hasReferral: false,
//       currentPoint,
//       eligibleForFirstSwapWithMinFee: false,
//     });

//     console.log(
//       `  ↔ Quote: ${swapAmountSol} SOL → min ${quote.minimumAmountOut.toString()} base`,
//     );

//     // ── 4. execute swap via Meteora SDK ──
//     const swapTx = await client.pool.swap({
//       owner: payer.publicKey,
//       amountIn,
//       minimumAmountOut: quote.minimumAmountOut,
//       swapBaseForQuote: false,
//       pool: poolPda,
//       referralTokenAccount: null,
//       payer: payer.publicKey,
//     });

//     await provider.sendAndConfirm(swapTx, [payer]);
//     console.log(`  ↔ Swap executed: ${swapAmountSol} SOL → base tokens`);
//   }

//   /** Airdrop SOL to a keypair on localnet */
//   async function airdrop(recipient: PublicKey, sol: number) {
//     const sig = await provider.connection.requestAirdrop(
//       recipient,
//       sol * LAMPORTS_PER_SOL,
//     );
//     await provider.connection.confirmTransaction(sig, "confirmed");
//   }

//   /** Create ATAs for a wallet (WSOL via SPL Token, base via Token2022) */
//   async function ensureRecipientAtas(
//     owner: PublicKey,
//     payerKp: Keypair,
//   ): Promise<{ quoteAta: PublicKey; baseAta: PublicKey }> {
//     const quoteAta = getAssociatedTokenAddressSync(
//       WSOL_MINT,
//       owner,
//       false,
//       SPL_TOKEN_PROGRAM_ID,
//     );
//     const baseAta = getAssociatedTokenAddressSync(
//       baseMint.publicKey,
//       owner,
//       false,
//       TOKEN_2022_PROGRAM_ID_PK,
//     );

//     const tx = new anchor.web3.Transaction();
//     if (!(await provider.connection.getAccountInfo(quoteAta))) {
//       tx.add(
//         createAssociatedTokenAccountInstruction(
//           payerKp.publicKey,
//           quoteAta,
//           owner,
//           WSOL_MINT,
//           SPL_TOKEN_PROGRAM_ID,
//         ),
//       );
//     }
//     if (!(await provider.connection.getAccountInfo(baseAta))) {
//       tx.add(
//         createAssociatedTokenAccountInstruction(
//           payerKp.publicKey,
//           baseAta,
//           owner,
//           baseMint.publicKey,
//           TOKEN_2022_PROGRAM_ID_PK,
//         ),
//       );
//     }
//     if (tx.instructions.length > 0) {
//       await provider.sendAndConfirm(tx, [payerKp]);
//     }
//     return { quoteAta, baseAta };
//   }

//   // ─── before: one-time environment setup ───────────────────────────────────

//   before(
//     "create config (PDA feeClaimer), pool, and generate initial fees",
//     async () => {
//       payer = (provider.wallet as any).payer;
//       baseMint = Keypair.generate();
//       config = Keypair.generate();

//       const pdas = deriveAllPdas(
//         program.programId,
//         DBC_PROGRAM_ID,
//         baseMint.publicKey,
//         WSOL_MINT,
//         config.publicKey,
//       );

//       feeClaimerPda = pdas.feeClaimerPda;
//       feeConfigPda = pdas.feeConfigPda;
//       baseFeeVault = pdas.baseFeeVault;
//       quoteFeeVault = pdas.quoteFeeVault;
//       poolPda = pdas.poolPda;
//       baseVaultPda = pdas.baseVaultPda;
//       quoteVaultPda = pdas.quoteVaultPda;
//       poolAuthority = pdas.poolAuthority;
//       eventAuthority = pdas.eventAuthority;
//       poolClaimersPda = pdas.poolClaimersPda;

//       // ── 1. create DBC config with PDA as feeClaimer ──
//       await setupConfigAndPool(payer, config, feeClaimerPda, 101, baseMint);

//       // ── 2. create pool ──
//       const { poolAddress } = await setupConfigAndPool(
//         payer,
//         config,
//         feeClaimerPda,
//         101,
//         baseMint,
//       );
//       console.log("  ✅ Pool created:", poolAddress.toBase58());

//       // ── 3. do an initial swap to accumulate fees ──
//       await doSwap(amountToSwap);
//     },
//   );

//   // ─── Test 1 ──────────────────────────────────────────────────────────────
//   it("deployer claims partner trading fees and receives full amount", async () => {
//     // 1. Record vault balance before (may not exist yet)
//     const quoteBefore = await provider.connection.getAccountInfo(quoteFeeVault);
//     const vaultBalanceBefore = quoteBefore
//       ? (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
//           .uiAmount ?? 0
//       : 0;

//     // 2. Sweep fees from DBC pool into fee vaults
//     await (program as any).methods
//       .claimPartnerTradingFee(U64_MAX, U64_MAX)
//       .accounts({
//         poolAuthority,
//         config: config.publicKey,
//         pool: poolPda,
//         baseFeeVault,
//         quoteFeeVault,
//         basePoolVault: baseVaultPda,
//         quotePoolVault: quoteVaultPda,
//         baseMint: baseMint.publicKey,
//         quoteMint: WSOL_MINT,
//         feeClaimer: feeClaimerPda,
//         tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//         tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//         eventAuthority,
//         dbcProgram: DBC_PROGRAM_ID,
//         payer: payer.publicKey,
//         systemProgram: SystemProgram.programId,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 3. Assert fee vault created and has funds
//     const vaultAccount = await provider.connection.getAccountInfo(
//       quoteFeeVault,
//     );
//     assert.ok(
//       vaultAccount !== null,
//       "quote fee vault should have been created",
//     );

//     const vaultBalanceAfterClaim =
//       (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
//         .uiAmount ?? 0;
//     assert.isAbove(
//       vaultBalanceAfterClaim,
//       vaultBalanceBefore,
//       "quote fee vault balance should increase after claiming fees",
//     );
//     console.log(
//       `  quote fee vault after claim: ${vaultBalanceAfterClaim} WSOL`,
//     );

//     // 4. Set deployer as sole claimer at 100%
//     await (program as any).methods
//       .setPoolClaimers([payer.publicKey], [10_000])
//       .accounts({
//         deployer: payer.publicKey,
//         pool: poolPda,
//         poolClaimers: poolClaimersPda,
//         systemProgram: SystemProgram.programId,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 5. Create recipient ATAs
//     const { quoteAta: recipientQuoteAta, baseAta: recipientBaseAta } =
//       await ensureRecipientAtas(payer.publicKey, payer);

//     // 6. Record balances before withdrawal
//     const recipientBefore =
//       (await provider.connection.getTokenAccountBalance(recipientQuoteAta))
//         .value.uiAmount ?? 0;
//     const withdrawAmount = (
//       await provider.connection.getTokenAccountBalance(quoteFeeVault)
//     ).value.amount;

//     // 7. Withdraw full vault balance — deployer gets 100%
//     await (program as any).methods
//       .withdrawFromFeeVault(new anchor.BN(0), new anchor.BN(withdrawAmount))
//       .accounts({
//         claimer: payer.publicKey,
//         pool: poolPda,
//         poolClaimers: poolClaimersPda,
//         baseFeeVault,
//         quoteFeeVault,
//         recipientBaseAccount: recipientBaseAta,
//         recipientQuoteAccount: recipientQuoteAta,
//         baseMint: baseMint.publicKey,
//         quoteMint: WSOL_MINT,
//         feeClaimer: feeClaimerPda,
//         tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//         tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 8. Assert vault drained
//     const vaultAfterWithdraw =
//       (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
//         .uiAmount ?? 0;
//     assert.equal(
//       vaultAfterWithdraw,
//       0,
//       "vault should be empty after full withdrawal",
//     );

//     // 9. Assert recipient received everything
//     const recipientAfter =
//       (await provider.connection.getTokenAccountBalance(recipientQuoteAta))
//         .value.uiAmount ?? 0;
//     assert.isAbove(
//       recipientAfter,
//       recipientBefore,
//       "recipient balance should increase after withdrawal",
//     );

//     console.log(
//       `  ✅ Deployer withdrew full fees: recipient ${recipientBefore} → ${recipientAfter} WSOL`,
//     );
//   });

//   // ─── Test 2 ──────────────────────────────────────────────────────────────
//   it("splits fees among 4 claimers: 20%, 30%, 40%, 10%", async () => {
//     // Generate 3 additional claimers
//     const claimer2 = Keypair.generate();
//     const claimer3 = Keypair.generate();
//     const claimer4 = Keypair.generate();

//     // Airdrop SOL for tx fees
//     await airdrop(claimer2.publicKey, 2);
//     await airdrop(claimer3.publicKey, 2);
//     await airdrop(claimer4.publicKey, 2);

//     // 1. Accumulate fresh fees with another swap
//     await doSwap(amountToSwap);

//     // 2. Sweep fees into vaults
//     await (program as any).methods
//       .claimPartnerTradingFee(U64_MAX, U64_MAX)
//       .accounts({
//         poolAuthority,
//         config: config.publicKey,
//         pool: poolPda,
//         baseFeeVault,
//         quoteFeeVault,
//         basePoolVault: baseVaultPda,
//         quotePoolVault: quoteVaultPda,
//         baseMint: baseMint.publicKey,
//         quoteMint: WSOL_MINT,
//         feeClaimer: feeClaimerPda,
//         tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//         tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//         eventAuthority,
//         dbcProgram: DBC_PROGRAM_ID,
//         payer: payer.publicKey,
//         systemProgram: SystemProgram.programId,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 3. Set 4 claimers: payer=20%, claimer2=30%, claimer3=40%, claimer4=10%
//     const claimerAddresses = [
//       payer.publicKey,
//       claimer2.publicKey,
//       claimer3.publicKey,
//       claimer4.publicKey,
//     ];
//     const claimerBps = [2_000, 3_000, 4_000, 1_000];

//     await (program as any).methods
//       .setPoolClaimers(claimerAddresses, claimerBps)
//       .accounts({
//         deployer: payer.publicKey,
//         pool: poolPda,
//         poolClaimers: poolClaimersPda,
//         systemProgram: SystemProgram.programId,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 4. Record total vault balance (raw lamports for precision)
//     const totalQuoteRaw = BigInt(
//       (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
//         .amount,
//     );
//     console.log(`  Total quote fees in vault: ${totalQuoteRaw} lamports`);

//     // 5. Each claimer withdraws their share
//     const claimers = [
//       { kp: payer, bps: 2_000 },
//       { kp: claimer2, bps: 3_000 },
//       { kp: claimer3, bps: 4_000 },
//       { kp: claimer4, bps: 1_000 },
//     ];

//     // Create ATAs for all claimers (payer pays for creation)
//     const claimerAtas: { quoteAta: PublicKey; baseAta: PublicKey }[] = [];
//     for (const c of claimers) {
//       const atas = await ensureRecipientAtas(c.kp.publicKey, payer);
//       claimerAtas.push(atas);
//     }

//     // Record balances before withdrawals
//     const quoteBalancesBefore: bigint[] = [];
//     for (const ata of claimerAtas) {
//       const bal = BigInt(
//         (await provider.connection.getTokenAccountBalance(ata.quoteAta)).value
//           .amount,
//       );
//       quoteBalancesBefore.push(bal);
//     }

//     // Each claimer withdraws their max share (request U64_MAX to get clamped to max)
//     for (let i = 0; i < claimers.length; i++) {
//       const c = claimers[i];
//       await (program as any).methods
//         .withdrawFromFeeVault(U64_MAX, U64_MAX)
//         .accounts({
//           claimer: c.kp.publicKey,
//           pool: poolPda,
//           poolClaimers: poolClaimersPda,
//           baseFeeVault,
//           quoteFeeVault,
//           recipientBaseAccount: claimerAtas[i].baseAta,
//           recipientQuoteAccount: claimerAtas[i].quoteAta,
//           baseMint: baseMint.publicKey,
//           quoteMint: WSOL_MINT,
//           feeClaimer: feeClaimerPda,
//           tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//           tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//         } as any)
//         .signers([c.kp])
//         .rpc();
//     }

//     // 6. Verify each claimer received their exact BPS share of the total.
//     // The contract now tracks per-claimer withdrawals, so each claimer gets
//     // exactly totalFees * bps / 10_000 regardless of withdrawal order.
//     let totalExpected = BigInt(0);
//     for (let i = 0; i < claimers.length; i++) {
//       const balAfter = BigInt(
//         (
//           await provider.connection.getTokenAccountBalance(
//             claimerAtas[i].quoteAta,
//           )
//         ).value.amount,
//       );
//       const received = balAfter - quoteBalancesBefore[i];
//       const expectedShare =
//         (totalQuoteRaw * BigInt(claimers[i].bps)) / BigInt(10_000);

//       console.log(
//         `  Claimer ${i} (${claimers[i].bps} bps): received=${received}, expected=${expectedShare}`,
//       );

//       assert.equal(
//         received.toString(),
//         expectedShare.toString(),
//         `Claimer ${i} should receive exactly ${
//           claimers[i].bps / 100
//         }% of vault fees`,
//       );
//       totalExpected += expectedShare;
//     }

//     // 7. Vault should hold only integer-division rounding dust
//     const vaultRemaining = BigInt(
//       (await provider.connection.getTokenAccountBalance(quoteFeeVault)).value
//         .amount,
//     );
//     const expectedDust = totalQuoteRaw - totalExpected;
//     console.log(
//       `  Vault remaining after all withdrawals: ${vaultRemaining} (expected dust: ${expectedDust})`,
//     );
//     assert.equal(
//       vaultRemaining.toString(),
//       expectedDust.toString(),
//       "vault remainder should be only integer-division rounding dust",
//     );
//   });

//   // ─── Test 3 ──────────────────────────────────────────────────────────────
//   it("non-claimer cannot withdraw — ClaimerNotFound error", async () => {
//     // 1. Accumulate fees
//     await doSwap(amountToSwap);
//     await (program as any).methods
//       .claimPartnerTradingFee(U64_MAX, U64_MAX)
//       .accounts({
//         poolAuthority,
//         config: config.publicKey,
//         pool: poolPda,
//         baseFeeVault,
//         quoteFeeVault,
//         basePoolVault: baseVaultPda,
//         quotePoolVault: quoteVaultPda,
//         baseMint: baseMint.publicKey,
//         quoteMint: WSOL_MINT,
//         feeClaimer: feeClaimerPda,
//         tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//         tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//         eventAuthority,
//         dbcProgram: DBC_PROGRAM_ID,
//         payer: payer.publicKey,
//         systemProgram: SystemProgram.programId,
//       } as any)
//       .signers([payer])
//       .rpc();

//     // 2. Generate imposter keypair and fund it
//     const imposter = Keypair.generate();
//     await airdrop(imposter.publicKey, 2);

//     // 3. Create ATAs for imposter
//     const { quoteAta: imposterQuoteAta, baseAta: imposterBaseAta } =
//       await ensureRecipientAtas(imposter.publicKey, payer);

//     // 4. Attempt withdrawal as non-claimer — should fail
//     try {
//       await (program as any).methods
//         .withdrawFromFeeVault(U64_MAX, U64_MAX)
//         .accounts({
//           claimer: imposter.publicKey,
//           pool: poolPda,
//           poolClaimers: poolClaimersPda,
//           baseFeeVault,
//           quoteFeeVault,
//           recipientBaseAccount: imposterBaseAta,
//           recipientQuoteAccount: imposterQuoteAta,
//           baseMint: baseMint.publicKey,
//           quoteMint: WSOL_MINT,
//           feeClaimer: feeClaimerPda,
//           tokenBaseProgram: TOKEN_2022_PROGRAM_ID_PK,
//           tokenQuoteProgram: SPL_TOKEN_PROGRAM_ID,
//         } as any)
//         .signers([imposter])
//         .rpc();

//       assert.fail("Expected transaction to fail with ClaimerNotFound");
//     } catch (err: any) {
//       // Error code 6004 = ClaimerNotFound
//       assert.include(
//         JSON.stringify(err),
//         "6004",
//         "should fail with ClaimerNotFound (error code 6004)",
//       );
//       console.log("  ✅ Non-claimer correctly rejected with ClaimerNotFound");
//     }
//   });

//   // ─── Test 4 ──────────────────────────────────────────────────────────────
//   it("setPoolClaimers rejects BPS that don't sum to 10,000 — InvalidTotalBps", async () => {
//     const dummy1 = Keypair.generate();
//     const dummy2 = Keypair.generate();
//     const dummy3 = Keypair.generate();

//     // BPS: 2000 + 3000 + 4000 + 500 = 9500 ≠ 10000
//     try {
//       await (program as any).methods
//         .setPoolClaimers(
//           [
//             payer.publicKey,
//             dummy1.publicKey,
//             dummy2.publicKey,
//             dummy3.publicKey,
//           ],
//           [2_000, 3_000, 4_000, 500],
//         )
//         .accounts({
//           deployer: payer.publicKey,
//           pool: poolPda,
//           poolClaimers: poolClaimersPda,
//           systemProgram: SystemProgram.programId,
//         } as any)
//         .signers([payer])
//         .rpc();

//       assert.fail("Expected transaction to fail with InvalidTotalBps");
//     } catch (err: any) {
//       // Error code 6003 = InvalidTotalBps
//       assert.include(
//         JSON.stringify(err),
//         "6003",
//         "should fail with InvalidTotalBps (error code 6003)",
//       );
//       console.log(
//         "  ✅ Invalid BPS sum correctly rejected with InvalidTotalBps",
//       );
//     }
//   });
// });
