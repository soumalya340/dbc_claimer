//

    // console.log(
    //   "claim_position_fee called by stranger:",
    //   stranger.publicKey.toBase58(),
    // );

    // // ── 6. Check fee vault balances — must have accumulated fees ──────────────
    // const [baseVaultBalance, quoteVaultBalance] = await Promise.all([
    //   connection.getTokenAccountBalance(baseFeeVault),
    //   connection.getTokenAccountBalance(quoteFeeVault),
    // ]);

    // console.log(
    //   "base_fee_vault balance:",
    //   baseVaultBalance.value.uiAmountString,
    //   "| quote_fee_vault balance:",
    //   quoteVaultBalance.value.uiAmountString,
    // );

    // const baseAmount = Number(baseVaultBalance.value.amount);
    // const quoteAmount = Number(quoteVaultBalance.value.amount);
    // assert.isTrue(
    //   baseAmount > 0 || quoteAmount > 0,
    //   "fee vaults are empty — claim_position_fee did not sweep any fees from DAMMv2",
    // );
