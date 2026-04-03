import { PublicKey } from "@solana/web3.js";

export const DBC_PROGRAM_ID = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
);
export const CP_AMM_PROGRAM_ID = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
);
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

export function deriveCpAmmFeeVaults(
  pool: PublicKey, //  Pool can be DBC or DAMMv2
  tokenAMint: PublicKey,
  tokenBMint: PublicKey,
  programId: PublicKey,
): { baseFeeVault: PublicKey; quoteFeeVault: PublicKey } {
  const [baseFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), pool.toBuffer(), tokenAMint.toBuffer()],
    programId,
  );
  const [quoteFeeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault"), pool.toBuffer(), tokenBMint.toBuffer()],
    programId,
  );
  return { baseFeeVault, quoteFeeVault };
}

export function deriveCpAmmEventAuthority(
  cpAmmProgramId: PublicKey,
): PublicKey {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    cpAmmProgramId,
  );
  return eventAuthority;
}

export function derivePoolClaimersPda(
  cpAmmPool: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_claimers"), cpAmmPool.toBuffer()],
    programId,
  );
  return pda;
}

export function deriveFeeClaimerPda(programId: PublicKey): PublicKey {
  const [feeClaimerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_claimer")],
    programId,
  );
  return feeClaimerPda;
}

// Step 2: Derive DBC-specific PDAs
export const [dbcPoolAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("pool_authority")],
  DBC_PROGRAM_ID,
);
export const [dbcEventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  DBC_PROGRAM_ID,
);

export function deriveClaimerStatePda(
  pool: PublicKey,
  claimer: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claimer_state"), pool.toBuffer(), claimer.toBuffer()],
    programId,
  );
  return pda;
}

export function deriveClaimerPendingBaseVault(
  pool: PublicKey,
  claimer: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claimer_pending_base"), pool.toBuffer(), claimer.toBuffer()],
    programId,
  );
  return pda;
}

export function deriveClaimerPendingQuoteVault(
  pool: PublicKey,
  claimer: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claimer_pending_quote"), pool.toBuffer(), claimer.toBuffer()],
    programId,
  );
  return pda;
}

export function deriveAllPdas(
  programId: PublicKey,
  dbcProgramId: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  configPk: PublicKey,
) {
  const [feeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config")],
    programId,
  );

  const cmp = Buffer.compare(baseMint.toBuffer(), quoteMint.toBuffer());
  const maxKey = cmp > 0 ? baseMint : quoteMint;
  const minKey = cmp > 0 ? quoteMint : baseMint;

  const [poolPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      configPk.toBuffer(),
      maxKey.toBuffer(),
      minKey.toBuffer(),
    ],
    dbcProgramId,
  );

  // Seeds must match on-chain: [FEE_VAULT_SEED, pool, mint]
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

  return {
    feeConfigPda,
    poolPda,
    baseVaultPda,
    quoteVaultPda,
    poolAuthority,
  };
}
