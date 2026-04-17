## migrateToDammV2

Migrates the Dynamic Bonding Curve pool to DAMM V2.
Function
async migrateToDammV2(params: MigrateToDammV2Params): Promise<Transaction>
Parameters

```js
interface MigrateToDammV2Params {
    payer: PublicKey // The payer of the transaction
    virtualPool: PublicKey // The virtual pool address
    dammConfig: PublicKey // The damm graduation fee config address
}
```

Returns
A transaction that can be signed and sent to the network.
Example

````js
const transaction = await client.migration.migrateToDammV2({
    payer: new PublicKey('boss1234567890abcdefghijklmnopqrstuvwxyz'),
    virtualPool: new PublicKey('abcdefghijklmnopqrstuvwxyz1234567890'),
    dammConfig: new PublicKey('7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd'),
})
```

````


solana program dump -u mainnet-beta \
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  tests/programs/cpmm.so


solana program show --buffers --keypair ~/.config/solana/id.json -u mainnet