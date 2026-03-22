## Safeguards

The program enforces three on-chain privileged keys, each with a distinct blast radius if compromised. `ADMIN_ADDRESS` and `LIQUIDITY_REMOVAL_AUTHORITY` are currently set to the same address but are defined as separate constants in `consts.rs` so they can be split into independent keys at any time. The program upgrade authority is a separate, independent keypair entirely outside this program's code.

### Program Upgrade Authority — Solana Deployer Key

Solana programs are **upgradeable by default**. The keypair that deployed the program is stored as the upgrade authority in the `BPFLoaderUpgradeable` program. Anyone who holds this keypair can call `solana program deploy` to replace the entire program binary with arbitrary code — instantly and silently, with no on-chain warning.

**If compromised:** an attacker can overwrite every instruction, every access control check, every BPS rule, and every PDA constraint in a single deployment. All funds held in fee vaults and LP positions become immediately drainable regardless of what the previous code enforced. This is a total loss scenario.

**This key has a higher blast radius than `ADMIN_ADDRESS` and `LIQUIDITY_REMOVAL_AUTHORITY` combined.** Those two keys operate within the rules the program enforces. The upgrade authority rewrites the rules.

**Operational requirements:**

- Never use this keypair for anything other than program deployments.
- Store it completely offline (hardware wallet or air-gapped machine), separate from all other keys.
- If ongoing upgrades are no longer needed, permanently revoke upgradeability:
  ```bash
  solana program set-upgrade-authority <PROGRAM_ID> --final
  ```
  After this command the program is immutable — even the holder of the original deployer keypair cannot change it.

### `ADMIN_ADDRESS` — Fee Distribution Control

Controls `set_pool_claimers` and `update_claimers_bps`.

**If compromised:** an attacker can reroute future fee payouts to addresses they control. They cannot directly drain fee vaults that have already been distributed, and they cannot touch liquidity in the DAMM v2 position. The damage is forward-looking: fees earned after the compromise land in the wrong hands until the address is rotated.

**Rotation:** change `ADMIN_ADDRESS` in `consts.rs`, redeploy the program. This is the address that must be treated with the highest operational care — think of it as nuclear launch codes. It should never exist as a hot wallet, never be on a networked machine, and access should require multiple humans in the loop.

Because `pool_claimers` uses `init_if_needed`, there is no risk of an attacker creating a duplicate or malformed account — calling `set_pool_claimers` twice on the same pool simply overwrites the config atomically.

### `LIQUIDITY_REMOVAL_AUTHORITY` — LP Position Control

Controls `remove_liquidity` and `remove_all_liquidity`.

**If compromised:** an attacker can drain any **unlocked** liquidity from the `fee_claimer`-owned DAMM v2 position into an account of their choice. The destination token accounts are passed as instruction arguments, so there is no on-chain restriction on where withdrawn tokens land.

**Current posture:** all production pools are deployed with 100% permanently locked liquidity, so even a full compromise of this key drains nothing today. However, if any future pool is deployed with unlocked liquidity, this key becomes a direct drain vector for that pool's LP tokens. Treat this key with the same operational security as `ADMIN_ADDRESS`.

**Rotation:** change `LIQUIDITY_REMOVAL_AUTHORITY` in `consts.rs` and redeploy.
