import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";

export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

/**
 * Wraps native SOL into a WSOL ATA for the given owner.
 * Creates the ATA if it doesn't exist, transfers lamports into it,
 * then calls the SPL Token "sync native" instruction (opcode 17).
 *
 * @param provider   - Anchor provider (used for connection + sendAndConfirm)
 * @param payer      - Keypair paying for fees and supplying the SOL
 * @param amountSol  - Amount of SOL to wrap (in SOL, not lamports)
 * @returns          - The WSOL ATA public key
 */
export async function wrapSol(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  amountSol: number,
): Promise<PublicKey> {
  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction();

  // Create the WSOL ATA if it doesn't already exist
  const ataInfo = await provider.connection.getAccountInfo(wsolAta);
  if (!ataInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        wsolAta,
        payer.publicKey,
        WSOL_MINT,
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  // Transfer lamports into the ATA
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wsolAta,
      lamports,
    }),
  );

  // Sync native: tells the SPL Token program to update the token balance
  // to match the lamport balance (opcode 17 = SyncNative)
  tx.add(
    new TransactionInstruction({
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      programId: TOKEN_PROGRAM_ID,
      data: Buffer.from([17]),
    }),
  );

  await provider.sendAndConfirm(tx, [payer]);
  console.log(
    `Wrapped ${amountSol} SOL → WSOL ATA: ${wsolAta.toBase58()}`,
  );

  return wsolAta;
}
