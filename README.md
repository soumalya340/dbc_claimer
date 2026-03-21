## Running Tests

Installation:

```bash
solana-test-validator \
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
  tests/programs/dbc.so
```

Run all tests:

```bash
anchor test --skip-local-validator
```

Run a specific test file:

```bash
anchor test --skip-local-validator --run tests/claim_fees.test.ts
```

Or using the underlying ts-mocha command directly:

```bash
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/claim_fees.test.ts
```
