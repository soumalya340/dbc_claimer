# DAMM V2 — Test Suite

---

## Test 1: Fee Claimer Holds DAMMv2 NFT Custody

**Goal:** Confirm that after a pool is set up and migrated, the fee claimer PDA becomes the custodian of the DAMMv2 position NFT.

**Flow:**

1. Use the provider's payer (admin) wallet.
2. Snapshot the NFT balance of the fee claimer PDA before setup.
3. Call `setupPoolAndMigrate` — this creates the pool and migrates the position NFT custody to the fee claimer PDA.
4. Snapshot the NFT balance again after setup.
5. **Assert:** The NFT balance after must be greater than before — proving the fee claimer PDA received at least one new DAMMv2 position NFT.

---

## Test 2: Fee Vaults Fill with Real SOL After Swap + Claim

**Goal:** Prove that after a real swap happens and fees are claimed from the DAMMv2 position, the fee vault holds a non-zero balance — and that the registered claimer receives exactly that amount when fees are distributed.

**Flow:**

1. Set up the pool and migrate using the admin payer. Retrieve the second position NFT mint.
2. Derive the pool address and fetch on-chain pool state.
3. Register the admin payer as the **sole claimer at 100%** (10,000 BPS) via `setPoolClaimers`.
4. Verify the claimer PDA state is set correctly using `fetchclaimerspdainfo`.
5. Create a random stranger keypair (funded with 12 SOL) — this stranger will trigger the claim.
6. Call `claimPositionFeeModule` with the stranger as the signer. This does a swap to generate fees, then claims them from the DAMMv2 position into the fee vault.
7. **Assert:** The claim transaction succeeded.
8. Read the quote fee vault balance.
9. **Assert:** The quote fee vault holds a non-zero amount (real fees landed).
10. Create Associated Token Accounts (ATAs) for the admin payer for both base and quote tokens.
11. Call `distributeFees` — this pushes the vault balance out to registered claimers proportionally.
12. Read the admin payer's quote ATA balance after distribution.
13. **Assert:** The admin payer received exactly the full quote fee vault amount (100% share).

---

## Test 3: Admin-Set Claimers Receive Proportional Fees and Percentages Update Correctly

**Goal:** Verify that fee splits between multiple claimers are exactly proportional, that percentages can be updated, and that `updateClaimersBps` preserves historical claim data while `setPoolClaimers` resets it.

---

### Round 1 — Initial Split (20% / 30% / 50%)

1. Set up the pool and migrate using the admin payer.
2. Create **two random keypairs**: `user2` (funded 2 SOL) and `user3` (funded 2 SOL).
3. Register three claimers via `setPoolClaimers`:
   - **Payer (admin):** 20% (2000 BPS)
   - **User2:** 30% (3000 BPS)
   - **User3:** 50% (5000 BPS)
4. Fetch PDA state and **assert initial conditions:**
   - BPS array is `[2000, 3000, 5000]`.
   - All claimed amounts (base and quote) are zero.
   - `lastDistributed` and `lastClaimed` are both zero.
5. Call `claimPositionFeeModule` with payer as signer — this triggers a swap (to generate fees) and claims them into the fee vaults.
6. Create ATAs for all three claimers (base + quote token accounts).
7. Read the quote fee vault balance before distribution.
8. Call `distributeFees` to push vault funds out to all three claimers.
9. **Assert proportional payouts** (strict, exact amounts):
   - Payer received exactly 20% of the vault.
   - User2 received exactly 30% of the vault.
   - User3 received the remainder (50%).
10. **Assert:** `lastDistributed` and `lastClaimed` are both non-zero.

---

### Round 2 — Updated Split (50% / 30% / 20%) + Anyone Can Claim

11. Call `setPoolClaimers` again with updated BPS: **Payer 50%, User2 30%, User3 20%.** This resets historical claimed amounts.
12. Create a new random keypair `user1` (funded 101 SOL) — represents any random person.
13. `user1` calls `dammV2Swap` to generate new swap fees.
14. `user1` calls `claimPositionFee()` directly — **showcasing that anyone (not just an admin) can trigger the fee claim.**
15. Read the quote fee vault balance after this claim.
16. Call `distributeFees` to push the new vault balance out proportionally.
17. **Assert proportional payouts** under the new 50/30/20 split (strict, exact amounts):
    - Payer received exactly 50% of the vault.
    - User2 received exactly 30% of the vault.
    - User3 received the remainder (20%).

---

### Round 3 — BPS Update Without History Reset (50% / 50% / 0%)

18. **Assert** the fee vault is now empty (all distributed).
19. Call `updateClaimersBps` with `[5000, 5000, 0]` — changes split to **Payer 50%, User2 50%, User3 0%.**
20. **Assert** the BPS array is now `[5000, 5000, 0]`.
21. **Assert** the claimed amounts from Round 2 are still intact — `updateClaimersBps` does **not** reset history (unlike `setPoolClaimers`).
22. Create another random user (`user1Round3`), have them do a swap to generate fresh fees.
23. `user1Round3` calls `claimPositionFee()`.
24. Call `distributeFees` for the third round.
25. **Assert Round 3 deltas** (new earned minus previous cumulative):
    - Payer's new earnings are exactly 50% of Round 3 vault.
    - User2's new earnings are exactly 50% of Round 3 vault.
    - User3's new earnings are zero (0% BPS, though they may sweep any rounding remainder).

---

**Key Invariants Across All Tests:**

- No `console.log` statements anywhere in the test code.
- All fee splits are verified as exact integers (floor division, remainder to last claimer).
- `setPoolClaimers` resets claimed history; `updateClaimersBps` does not.
- Any wallet — even a randomly created one with no role — can call `claimPositionFee`.

## Test 4: Fee Claimer Captures 100% of Fees with Mixed Locked/Unlocked Liquidity

**Goal:** Prove that when a single admin is registered as the sole 100% claimer, they receive every lamport of fees — regardless of whether the pool's liquidity is split between permanently locked and unlocked portions.

**Constraints:** Only one user and signer throughout — the admin payer. No `console.log` statements.

**Flow:**

1. Set up the pool using `setupPoolAndMigrate` with the following liquidity split:
   - **Partner:** 10% permanently locked, 90% unlocked.
   - **Creator:** 0% permanently locked, 0% unlocked.
2. Derive the pool address, fetch on-chain pool state, and derive the pool claimers PDA.
3. Register the admin payer as the **sole claimer at 100%** (10,000 BPS) via `setPoolClaimers`.
4. Fetch PDA state via `fetchclaimerspdainfo` and **assert initial conditions:**
   - BPS array is `[10000]` — admin holds 100%.
   - Claimed base and claimed quote are both zero.
   - `lastDistributed` and `lastClaimed` are both zero.
5. Fetch position info via `getPositionInfo` and **assert liquidity structure:**
   - `unlocked` liquidity is greater than zero (the 90% unlocked portion exists).
   - `permanentlyLocked` liquidity is greater than zero (the 10% locked portion exists).
6. Call `claimPositionFeeModule` with the admin payer — this triggers a swap to generate fees, then claims them from the DAMMv2 position into the fee vault.
7. Read the quote fee vault balance. **Assert:** it is greater than zero (real fees landed).
8. Create Associated Token Accounts (ATAs) for the admin payer (base + quote).
9. Call `distributeFees` — pushes the entire vault balance to the sole 100% claimer.
10. Read the admin payer's quote ATA balance. **Assert (strict):** the payer received exactly the full vault amount — not even 1 lamport less.
11. Fetch the final PDA state via `fetchclaimerspdainfo`. **Assert:** `claimedQuote[0]` equals the exact fee vault amount.

---

### Part 2 — Partial Liquidity Removal (10% of Unlocked)

12. Read the current position info via `getPositionInfo` — capture the full `unlocked` liquidity amount.
13. Calculate exactly 10% of that unlocked liquidity amount.
14. Call `remove_liquidity` as admin, passing the 10% amount as the liquidity parameter. The admin's token A and token B destination accounts receive the withdrawn tokens.
15. Read the admin's token A and token B balances after removal.
16. **Assert (strict):** The admin received exactly 10% of the total unlocked liquidity — not even 1 lamport less or more.

---

### Part 3 — Remove All Remaining Liquidity + NFT Burn

17. Call `remove_all_liquidity` as admin with both token thresholds set to `0` (accept any amount). This drains the remaining 90% of unlocked liquidity from the position.
18. **Assert (strict):** The admin's token A and token B balances increased by exactly the remaining liquidity — all of it, nothing left behind.
19. **Assert:** The position NFT is no longer held by the fee claimer PDA — the NFT has been burned and the position account closed.
20. **Assert:** The fee claimer PDA's NFT balance decreased (the position NFT is gone).

## Test 5: Access Control — Only Admin Can Initialize Claimers, Update BPS, and Remove Liquidity

**Goal:** Verify that all privileged instructions (`setPoolClaimers`, `updateClaimersBps`, `removeLiquidity`, `removeAllLiquidity`) reject any caller that is not the designated admin address, while the admin can execute all of them successfully.

**Constraints:** Single non-admin random keypair used for all rejection checks. No `console.log` statements.

**Flow:**

1. Set up the pool using `setupPoolAndMigrate` with the following liquidity split:
   - **Partner:** 10% permanently locked, 90% unlocked.
   - **Creator:** 0% permanently locked, 0% unlocked.
2. Derive the pool address, fetch on-chain pool state, and derive the pool claimers PDA.
3. Create a `nonAdmin` random keypair (funded with 2 SOL).

---

### Claimer Initialization

4. **Admin** calls `setPoolClaimers` registering themselves as the sole 100% claimer.
5. **Assert:** The PDA is initialized with `claimerBps = [10000]`.
6. **Non-admin** calls `setPoolClaimers` — **must fail** (`Unauthorized` address constraint on `deployer`).
7. **Assert:** The transaction threw an error.

---

### BPS Update

8. **Admin** calls `updateClaimersBps` with `[10000]` (no change in split).
9. **Assert:** The PDA still reflects `claimerBps = [10000]`.
10. **Non-admin** calls `updateClaimersBps` — **must fail** (`Unauthorized` address constraint on `deployer`).
11. **Assert:** The transaction threw an error.

---

### Liquidity Removal

12. Create ATAs for both admin and non-admin (base + quote tokens) via idempotent ATA instructions, funded by admin.
13. Read the current `unlocked` liquidity from the position and compute 10% of it as `liquidityToRemove`.
14. **Admin** calls `removeLiquidity` with `liquidityToRemove` — **must succeed**.
15. **Non-admin** calls `removeLiquidity` using their own ATAs — **must fail** (`Unauthorized` address constraint on `admin`).
16. **Assert:** The transaction threw an error.
17. **Non-admin** calls `removeAllLiquidity` — **must fail** (`Unauthorized` address constraint on `admin`).
18. **Assert:** The transaction threw an error.
19. **Admin** calls `removeAllLiquidity` with both token thresholds set to `0` — **must succeed**. The unlocked liquidity is fully drained. The position NFT is not burned because 10% permanently locked liquidity remains.

# DBC — Test Suite

---

## Test 1: Admin Gets 100% of Trading Fees

**What we’re checking:** When someone trades in the DBC pool, fees pile up. This test confirms the admin can collect all of those fees and that every single lamport lands in their wallet.

**Setup:** Only the admin wallet is used. No other users.

**Steps:**

1. Create the pool (a 110 SOL trade happens automatically during setup, generating fees).
2. Register the admin as the only fee recipient (100% share).
3. **Check starting state:** no fees collected yet, everything at zero.
4. Pull all accumulated fees out of the DBC pool into the program’s holding vault.
5. **Check:** the holding vault actually has SOL in it (fees were real).
6. Pay out the vault to the admin.
7. **Check (exact):** admin received every lamport — nothing missing.
8. **Check:** the on-chain record shows admin’s collected total matches exactly.

---

## Test 2: Three-Way Fee Split, Percentage Changes, and History Preservation

**What we’re checking:** Three people share fees. The split can be changed mid-way. Changing the split doesn’t erase past earnings. Anyone (even a stranger) can trigger the fee collection.

**Setup note:** Pool is configured with a very high migration threshold (10,000 SOL) so it stays in its initial state through two rounds of trading — allowing us to run two separate fee cycles on the same pool.

---

### Round 1 — Split: 20% / 30% / 50%

1. Create three users (admin, user2, user3). Admin and user1 get funded for transactions.
2. Set up the pool and register the three fee recipients: **admin gets 20%, user2 gets 30%, user3 gets 50%**.
3. **Check starting state:** no fees collected, all balances at zero.
4. Do a 5 SOL trade to generate fees.
5. Create token wallets for all three users.
6. **user1** (a random stranger) triggers the fee collection — proves anyone can do this step, not just the admin.
7. Admin pays out the collected fees to all three.
8. **Check (exact):** each person received exactly their percentage — admin 20%, user2 30%, user3 the rest.
9. **Check:** timestamps show distribution happened.

---

### Change the Split — 50% / 50% / 0% (past earnings kept)

10. Admin updates the split: **admin 50%, user2 50%, user3 0%**.
11. **Check:** new percentages saved correctly.
12. **Check:** Round 1 earnings are still recorded — changing percentages does NOT wipe history.

---

### Round 2 — New fees under the updated split

13. Do another 5 SOL trade.
14. user1 collects fees again.
15. Admin pays out again.
16. **Check (exact):** the new earnings (Round 2 only) were split 50/50 between admin and user2. user3 gets nothing (0% share).

---

**Key rules this test enforces:**

- Anyone can trigger fee collection — it’s permissionless.
- Changing percentages (`updateClaimersBps`) keeps past earnings intact.
- All splits are exact integer math — no rounding errors allowed.
