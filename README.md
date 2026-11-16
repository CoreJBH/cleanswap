# CLEANSWAP

A non-custodial **Lightning bitcoin ↔ USDT atomic swap** prototype — one HTML file, no framework,
no browser extension, no wallet vendor. The screen is deliberately plain (two escrow cards, one
button); the protocol underneath is a Bitcoin-style SHA-256 hashlock that settles both legs with the
same 32-byte secret.

`v0.2` is about the button telling the truth. Every step is gated on data a real swap would need,
checked in the browser before the state machine moves:

| Step | Gate | What has to be true |
| --- | --- | --- |
| 1 · Lock bitcoin | BOLT11 hold invoice | decodes, `payment_hash` is exactly `H`, amount equals the swap, network `bc`, still inside its expiry window |
| 2 · Verify the USDT lock | escrow proof | `lock()` calldata, a lock JSON record or a Liquid lock URI decodes to the **same `H`**, **the same `T2`** and **the same USDT amount** (a bare tx hash is accepted only as an unverified reference) |
| 3 · Settle | preimage | 32-byte `R` with `SHA256(R) === H`, computed with WebCrypto; a wrong `R` is refused with the hash it actually produced |
| timeout | timelock | `T2` has passed, `R` was never revealed, both legs return to their owners |

A click alone never advances. Empty, malformed, mismatched or expired input is refused inline, in
the step panel and in the event log, and the primary button stays marked not-ready until the gate is
satisfied.

**Live app:** open `ln-usdt-swap.html` (the single-file build) or `dist/cleanswap.html`.

---

## Two ways to run it

### Practice escrow — both sides on one screen

Creating a swap generates `R` and `H = SHA256(R)`, a 40-block `T1` for the Lightning leg and a
one-hour `T2` for the token leg. Then the same screen plays both parties in order:

1. **The USDT side mints a hold invoice.** The app builds a real BOLT11 invoice — bech32 checksum,
   35-bit timestamp, `p`/`x` tagged fields, a 65-byte signature slot — with `payment_hash = H`,
   which the payer could not have chosen.
2. **You paste it back and pay.** The invoice is decoded and refused unless its hash is `H` and its
   amount matches. *Use invoice* fills the field, *Try a mismatched one* shows the refusal.
3. **The USDT side locks the escrow.** The app generates real `lock()` calldata bound to `H`, `T2`
   and the amount. Paste it back: it is decoded field by field, and a lock to any other hashlock,
   timelock or amount is refused.
4. **You reveal `R`.** `SHA256(R)` is checked against `H`; the escrow pays out and the HTLC learns
   its preimage in the same step.

The escrow board shows both legs at once: the BTC and USDT lock states on a single rail, plus live
`T1`/`T2` countdown bars that turn amber and then red as the timelocks close.

A **share link** (`#s=1.<H>.<sats>.<units>.<T2>.<T1>`) turns another tab or phone into the USDT
side: same hashlock, no preimage, and its own three steps — mint the hold invoice, lock the escrow,
then settle the Lightning leg once the claim publishes `R`. Two tabs are enough to walk a swap
end to end by hand, carrying the invoice, the calldata and the preimage between them.

### Wallet mode — a real invoice and a real receipt

The simulated counterparty is replaced by a real one: paste the hold invoice you were sent, open it
in BlueWallet / Wallet of Satoshi / Lexe / AQUA / Blockstream Green through the standard
`lightning:` deep link, and confirm the lock with the `payment_hash` your wallet shows for that
payment. A receipt for any other hash does not unlock the step. With WebLN available the app pays
through the wallet and checks the returned preimage against `H` itself.

---

## Cryptographic & contract architecture

### Hashlock: `sha256`, never `keccak256`

Bitcoin scripts enforce `OP_SHA256`; a Lightning HTLC's `payment_hash` is the SHA-256 of the
preimage (`BOLT 4`). The token leg therefore locks against the *same primitive*:

```solidity
bytes32 computed = sha256(abi.encodePacked(preimage));
if (computed != s.hashlock) revert HashlockMismatch(s.hashlock, computed);
```

`abi.encodePacked(bytes32)` is exactly the 32 raw bytes, so the EVM hashlock and the Lightning
`payment_hash` are interchangeable. A `keccak256` hashlock would be dead weight here — no Lightning
node can pay against it.

### `contracts/LightningUsdtHTLC.sol`

Clean, minimal, gas-conscious (`^0.8.20`, custom errors, packed struct, checks-effects-interactions,
no owner, no proxy, no fees).

| Function | Purpose |
| --- | --- |
| `lock(bytes32 hashlock, uint256 timelock, address receiver, address token, uint256 amount) → bytes32 swapId` | Pulls `amount` of `token` into escrow via `transferFrom`, emits `Locked` |
| `claim(bytes32 swapId, bytes32 preimage)` | Verifies `sha256(preimage) == hashlock`, pays `receiver`, emits `Claimed(swapId, preimage)` — **the reveal makes the Lightning leg settle** |
| `refund(bytes32 swapId)` | After `block.timestamp >= timelock`, returns the tokens to `sender` |
| `getSwap`, `canClaim`, `canRefund`, `hashPreimage`, `computeSwapId` | Read-only helpers for wallets, tests and UIs |

`swapId = sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock))` — one swap
per secret, so the two legs cannot drift apart. Reverts: `ZeroAmount`, `ZeroAddress`,
`TimelockTooSoon` (`MIN_TIMELOCK_DELTA = 5 minutes`), `SwapExists`, `SwapUnknown`,
`AlreadySettled`, `HashlockMismatch`, `TimelockExpired`, `TimelockNotExpired`, `TransferFailed`.
Events: `Locked`, `Claimed`, `Refunded`.

`contracts/TestUSDT.sol` is a throwaway 6-decimal ERC-20 with `faucet()` (10,000 USDT/hour) for
Arbitrum Sepolia or any EVM testnet.

### Lightning side: BOLT11 hold invoices, and BOLT12 offers

Both are parsed in the browser with no dependency, and BOLT11 can be **minted** there too:

* **BOLT11 encode** (`lnbc…`) — amount in the human-readable part, 35-bit timestamp, `p`
  (payment hash), `d` (description, dropped when it would push the string past a QR), `x` (expiry)
  and the 104-word signature slot. The signature bytes are deterministic filler derived from the
  payment hash: every minted invoice is a structurally valid hold invoice and says in the log that
  it is not signed by a node.
* **BOLT11 decode** (`lnbc…`, `lntb…`, `lnbcrt…`) — bech32 with checksum, tagged fields, `payment_hash`
  extraction; the gate compares it with `H` before any money moves.
* **BOLT12 offer** (`lno1…`, the Lexe offer shape) — bech32 *without* checksum over a TLV stream;
  `offer_description`, `offer_amount`, `offer_absolute_expiry`, `node_id` and friends are decoded
  and shown with their TLV numbers.
* Wallet hand-off: `lightning:<invoice|offer>` deep link, one-tap copy, and a locally generated QR
  (own encoder, byte mode, EC level M — falling back to L for long requests — versions 1–10).

> Honest limit: a BOLT12 offer has **no `payment_hash`**, so preimage matching is only established
> with a BOLT11 invoice. BOLT12 is used here as the Lexe offer endpoint / sandbox flow, not as the
> HTLC leg.

### USDT side: AQUA / Liquid, with an EVM reference backend

AQUA does not expose hashlock scripts, so the prototype keeps the token leg at the level a wallet
can actually do: a Liquid address, an amount-bearing `liquidnetwork:` request, a QR and copy — plus
the EVM HTLC above for anyone who wants the lock enforced on-chain with the identical `H`. The
escrow proof the gate accepts is generated from that contract's ABI, so the calldata a person
pastes is the calldata a wallet would send.

---

## Repository layout

```
ln-usdt-swap.html            built single-file app (also dist/cleanswap.html)
build.py                     src/ -> single file; refuses to emit Hangul
src/
  index.template.html        screen markup (English UI, plain language)
  app.css                    dark-emerald theme, mobile-first, dual escrow board
  app.js                     state machine, gates, BOLT11 codec, swap links, calldata
  qr.js                      dependency-free QR encoder (byte mode, 1-10, L/M/Q/H)
contracts/
  LightningUsdtHTLC.sol      sha256 hashlock, ERC-20 escrow, timelock refund
  TestUSDT.sol               6-decimal faucet token
tools/
  gen-invoice.py             builds the BOLT11 / BOLT12 samples embedded in the app
  mint-invoices.js           asks the built app to mint invoices for cross-checking
  make-icons.py              favicon + touch icon from icon-clean-1.png
  make-launcher-icons.py     Android launcher icons
  qr-check.js                dumps QR matrices for cross-checking
  shots-extra.js             drawer / desktop inspection screenshots
test/
  headless.js                Playwright end-to-end suite (132 checks)
  contract-evm.py            contract behaviour on a real EVM + app calldata (26 checks)
  qr-crosscheck.py           QR matrices vs python-qrcode (48 fixed-mask matrices)
  invoice-crosscheck.py      minted invoices vs an independent BOLT11 decoder (45 checks)
  verify-english.py          Hangul must be 0 in every text file, path and commit
  run-all.sh                 everything above with the right env
android/                     minimal WebView wrapper (com.jbitmstr.cleanswap)
```

---

## Build

```bash
python3 build.py                     # -> ../ln-usdt-swap.html and dist/cleanswap.html
```

The output is one self-contained file: inline CSS/JS, inline base64 icons, the Solidity source in a
`<script type="text/plain">` block for the in-app viewer. The only network request is the optional
BTC/USD quote from `mempool.space` (labelled “offline” with a static demo rate when it fails). The
build also fails if any source file contains a Hangul character.

## Verification & test results

All suites pass on this tree:

| Suite | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` (Playwright, 390×844 / 360×780 / 1280×800) | Every gate refuses what it should and advances only on verified data: empty, malformed, mismatched-hash, wrong-amount, wrong-timelock, wrong-preimage and mismatched-receipt cases are all refused with the state unchanged; the real cases pass. Plus real `crypto.subtle` SHA-256 against Node, `H = SHA256(R)`, `abi.encodePacked` swap ids, minted-invoice round-trip, BIP-173 bech32 vectors, BOLT12 TLV decode, the refund path, wallet mode, the USDT side through a `#s=` link, no `window.ethereum`, no Hangul, zero horizontal overflow at three widths | **132/132 pass** |
| `test/contract-evm.py` (solc 0.8.26 + py-evm + eth-abi) | Real bytecode: faucet/approve, `lock` escrows and debits, swap record and `computeSwapId` agree, wrong preimage reverts, correct preimage pays the receiver, `Claimed` carries `R`, double claim reverts, refund before/after the timelock, `Refunded` emitted — and the UI's `lock()` calldata decodes to the swap fields with the right keccak selector | **26/26 pass** |
| `test/qr-crosscheck.py` | Every module of every mask (0–7) across six payloads, including a full-length invoice at level L, matches `python-qrcode` exactly | **48/48 matrices equal** |
| `test/invoice-crosscheck.py` | Every invoice the app mints parses under an independent Python BOLT11 decoder: checksum, `payment_hash`, amount (including 1 sat and 250k sats), 35-bit timestamp, expiry tag, 65-byte signature slot, optional description, and a length that still fits a QR | **45/45 pass** |
| `test/verify-english.py` | `[\uac00-\ud7af]` count is 0 across every tracked text file, file name and commit message | **0 characters** |
| `solc` | `LightningUsdtHTLC` + `TestUSDT` compile with optimizer 200, no warnings | ✅ |

```bash
bash test/run-all.sh      # build + English + headless + EVM + QR + invoices
```

Screenshots of the locked, settled, expired, USDT-side and desktop states are written to
`shots/v2-*.png` by the headless suite.

## Android wrapper

`android/` is a dependency-free `WebView` shell (package `com.jbitmstr.cleanswap`, `app_name =
CLEANSWAP`, `android:screenOrientation="user"`, `#040e09` status/nav bars, launcher icons generated
from `icon-clean-1.png`). Build it with `gradle assembleDebug` after staging `dist/cleanswap.html`
into `app/src/main/assets/index.html`.

GitHub Actions builds `cleanswap.apk` on every push to `main` and on `v*` tags
(`.github/workflows/apk.yml`); the same file is kept under `android/ci/build-apk.yml` for reference.
The APK is uploaded as a workflow artifact.

## Security notes and limitations

* This is a **prototype**. The practice escrow is a local simulator — it never touches a chain.
* Minted hold invoices carry a deterministic filler signature; they parse, checksum and hash
  correctly, but no node will route them. They exist so the gate can be exercised honestly.
* The contract is minimal by design and has **not been audited**. Do not escrow real value with it.
* One swap per hashlock; `claim` is permissionless but pays only the receiver fixed at lock time,
  so front-running a reveal gains nothing.
* Timelock asymmetry is the safety margin: the Lightning leg must outlive the token leg
  (`T1 > T2`), otherwise the preimage could be revealed after the token side was refunded.
* AQUA/Liquid has no hashlock script, so the token leg is a wallet-level hand-off in this build.
* A swap lives in the page: reloading it forgets the secret. Nothing is written to storage.
* The UI, code, tests and commit messages are English only, and `test/verify-english.py` enforces it.

## Contributors

- [@JBITmstr](https://github.com/JBITmstr)
- Gilbert ([Pickle](https://pickle.com))

## License

MIT for the code in this repository. The CLEANSWAP name and icon belong to the project owner.
