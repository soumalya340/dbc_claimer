import { PublicKey } from "@solana/web3.js";

export function deriveFeeClaimerPda(programId: PublicKey): PublicKey {
  const [feeClaimerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_claimer")],
    programId,
  );
  return feeClaimerPda;
}

export function deriveAllPdas(
  programId: PublicKey,
  dbcProgramId: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  configPk: PublicKey,
) {
  const [feeClaimerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_claimer")],
    programId,
  );
  const [feeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config")],
    programId,
  );

  const cmp = Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer());
  const maxKey = cmp > 0 ? baseMint : quoteMint;
  const minKey = cmp > 0 ? quoteMint : baseMint;

  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), configPk.toBuffer(), maxKey.toBuffer(), minKey.toBuffer()],
    dbcProgramId,
  );

  // Seeds must match on-chain: [FEE_VAULT_SEED, pool, mint]
  const [baseFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), poolPda.toBuffer(), baseMint.toBuffer()],
    programId,
  );
  const [quoteFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), poolPda.toBuffer(), quoteMint.toBuffer()],
    programId,
  );
  const [baseVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), baseMint.toBuffer(), poolPda.toBuffer()],
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

  const [poolClaimersPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_claimers"), poolPda.toBuffer()],
    programId,
  );

  return {
    feeClaimerPda,
    feeConfigPda,
    baseFeeVault,
    quoteFeeVault,
    poolPda,
    baseVaultPda,
    quoteVaultPda,
    poolAuthority,
    eventAuthority,
    poolClaimersPda,
  };
}
