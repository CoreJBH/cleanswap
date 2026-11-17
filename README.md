# CLEANSWAP

A non-custodial **Lightning bitcoin ↔ USDT atomic swap** prototype — one HTML file, no framework,
no browser extension, no wallet vendor. The screen is deliberately minimal (two asset cards, one
input, one button); the protocol underneath is a Bitcoin-style SHA-256 hashlock that settles both
legs with the same 32-byte secret.

`v0.3` is about direction and calm. The home screen asks which side you are — **Send BTC** or
**Send USDT**, one tap on the switch between the two asset cards — and everything technical moved
out of sight. The gates did not: every step is still checked in the browser before the state
machine moves.

| Step | Gate | What has to be true |
| --- | --- | --- |
| 1 · Lock bitcoin | BOLT12 offer/invoice or BOLT11 hold invoice | decodes, its payment hash is exactly `H`, amount equals the swap, still inside its expiry window |
| 2 · Verify the USDT lock | escrow proof | `lock()` calldata, a lock JSON record or a Liquid lock URI decodes to the **same `H`**, **the same `T2`** and **the same USDT amount** (a bare tx hash is accepted only as an unverified reference) |
| 3 · Settle | preimage | 32-byte `R` with `SHA256(R) === H`, computed with WebCrypto; a wrong `R` is refused with the hash it actually produced |
| timeout | timelock | `T2` has passed, `R` was never revealed, both legs return to their owners |

A click alone never advances. Empty, malformed, mismatched or expired input is refused inline, and
the primary button stays marked not-ready until the gate is satisfied. Once a swap is open, the
amount and the direction are frozen: presets and the switch disappear until the swap is reset.

**Live app:** open `ln-usdt-swap.html` (the single-file build) or `dist/cleanswap.html`.

---

## Two directions, two modes

### Send BTC / Send USDT

The two asset cards double as the direction control: the pill switch between them flips the home
screen between *you send bitcoin* (the classic flow: create the swap, share the link, pay the
hold invoice, claim the USDT) and *you send USDT* (verify the counterparty's offer, lock the USDT
escrow, settle the Lightning leg with the revealed `R`).

### Practice escrow — both sides on one screen

Starting a swap generates `R` and `H = SHA256(R)`, a 40-block `T1` for the Lightning leg and a
one-hour `T2` for the token leg. From the Send-USDT side the app simulates the bitcoin
counterparty locally, so the whole swap — offer, escrow lock, reveal, settlement — walks through
the same gates with two or three taps and no invite link.

The three steps, each gated:

1. **Verify the offer.** The other side sends a BOLT12 offer (or invoice, or a BOLT11 hold
   invoice — one input, auto-detected, a small badge says which). The app decodes it and refuses
   anything whose payment hash is not `H` or whose amount does not match.
2. **Lock the USDT.** The escrow proof is pasted back and decoded field by field; a lock to any
   other hashlock, timelock or amount is refused.
3. **Settle.** The preimage `R` is revealed; `SHA256(R)` is checked against `H`, and one hash
   check settles both legs.

The escrow board shows both legs at once: the BTC and USDT lock states on a single rail, plus
`T1`/`T2` countdown bars that turn amber as the timelocks close. Settled swaps land as one-line
entries in a short history list.

A **share link** (`#s=1.<H>.<sats>.<units>.<T2>.<T1>`) still turns another tab or phone into the
USDT side: same hashlock, no preimage, and its own three steps.

### Wallet mode — a real offer and a real receipt

The simulated counterparty is replaced by a real one: paste the offer or invoice you were sent,
open it in BlueWallet / Wallet of Satoshi / Lexe / AQUA / Blockstream Green through the standard
`lightning:` deep link, and confirm the lock with the `payment_hash` your wallet shows for that
payment. A receipt for any other hash does not unlock the step.

The wallet connection is only that hand-off: with the offer in place the row offers **Open in
wallet** (the `lightning:` deep link to the installed wallet app), **Copy** (the same invoice as
text) and **QR** (the same invoice for another phone to scan). There is no WebLN and no browser
extension: the app never asks for a key, and nothing is paid without the wallet's own receipt.

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

### Lightning side: BOLT12 by default, BOLT11 fully accepted

One input reads anything: `lno1…` (BOLT12 offer), `lni1…` (BOLT12 invoice), `lnbc…`/`lntb…`
(BOLT11), with or without the `lightning:` prefix. A small badge says which format was detected.

* **BOLT12 encode** (`lno1…`) — the app mints offers for a swap: TLVs over bech32 without a
  checksum, amount in the HRP (msat), `offer_description`, `offer_absolute_expiry`, a node id and a
  64-byte signature slot. An offer cannot carry a `payment_hash` by itself, so the swap hashlock
  rides in a **custom type-80 TLV**; a minted invoice (`lni1…` shape) carries the standard
  `invoice_payment_hash` (type 168). The signature bytes are not verified by the app, and the log
  says so.
* **BOLT11 encode** (`lnbc…`) — hold invoices: bech32 checksum, 35-bit timestamp, `p`/`d`/`x`
  tagged fields, a 65-byte signature slot, `payment_hash = H`.
* **BOLT11 decode** — bech32 with checksum, tagged fields, `payment_hash` extraction; the gate
  compares it with `H` before any money moves.
* Wallet hand-off: `lightning:<offer|invoice>` deep link, one-tap copy, and a locally generated QR
  (own encoder, byte mode, EC level M — falling back to L for long requests — versions 1–13).

> Honest limit: a BOLT12 offer has **no `payment_hash` field of its own**. Offers minted here carry
> the hashlock in the custom type-80 TLV; a wallet-generated invoice for the same swap carries the
> standard one. Preimage matching is only exercised against a real payment hash.

### USDT side: AQUA / Liquid, with an EVM reference backend

AQUA does not expose hashlock scripts, so the prototype keeps the token leg at the level a wallet
can actually do: an amount-bearing `liquidnetwork:` request and the EVM HTLC above for anyone who
wants the lock enforced on-chain with the identical `H`. The escrow proof the gate accepts is
generated from that contract's ABI, so the calldata a person pastes is the calldata a wallet would
send.

---

## Repository layout

```
ln-usdt-swap.html            built single-file app (also dist/cleanswap.html)
build.py                     src/ -> single file; refuses to emit Hangul
src/
  index.template.html        screen markup (English UI, plain language)
  app.css                    dark-emerald theme, mobile-first, dual escrow board
  app.js                     state machine, gates, BOLT11/BOLT12 codecs, swap links, calldata
  qr.js                      dependency-free QR encoder (byte mode, 1-13, L/M/Q/H)
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
  headless.js                Playwright end-to-end suite (160 checks)
  contract-evm.py            contract behaviour on a real EVM + app calldata (26 checks)
  qr-crosscheck.py           QR matrices vs python-qrcode (64 fixed-mask matrices)
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
`<script type="text/plain">` block for integrity. The only network request is the optional BTC/USD
quote from `mempool.space` (labelled "offline" with a static demo rate when it fails). The build
also fails if any source file contains a Hangul character.

## Verification & test results

All suites pass on this tree:

| Suite | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` (Playwright, 390×844 / 360×780 / 1280×800) | Every gate refuses what it should and advances only on verified data: empty, malformed, mismatched-hash, wrong-amount, wrong-timelock, wrong-preimage and mismatched-receipt cases are all refused with the state unchanged; the real cases pass. Plus the Send BTC / Send USDT switch, the Send-USDT start with a locally simulated bitcoin side, frozen amount and direction after opening, real `crypto.subtle` SHA-256 against Node, `H = SHA256(R)`, `abi.encodePacked` swap ids, minted-offer round-trip, BIP-173 bech32 vectors, BOLT12 TLV decode, the refund path, wallet mode, the USDT side through a `#s=` link, no `window.ethereum`, no Hangul, zero horizontal overflow at three widths | **160/160 pass** |
| `test/contract-evm.py` (solc 0.8.26 + py-evm + eth-abi) | Real bytecode: faucet/approve, `lock` escrows and debits, swap record and `computeSwapId` agree, wrong preimage reverts, correct preimage pays the receiver, `Claimed` carries `R`, double claim reverts, refund before/after the timelock, `Refunded` emitted — and the UI's `lock()` calldata decodes to the swap fields with the right keccak selector | **26/26 pass** |
| `test/qr-crosscheck.py` | Every module of every mask (0–7) across eight payloads, including BOLT12 lengths at versions 12–13, matches `python-qrcode` exactly | **64/64 matrices equal** |
| `test/invoice-crosscheck.py` | Every invoice the app mints parses under an independent Python BOLT11 decoder: checksum, `payment_hash`, amount (including 1 sat and 250k sats), 35-bit timestamp, expiry tag, 65-byte signature slot, optional description, and a length that still fits a QR | **45/45 pass** |
| `test/verify-english.py` | `[\uac00-\ud7af]` count is 0 across every tracked text file, file name and commit message | **0 characters** |
| `solc` | `LightningUsdtHTLC` + `TestUSDT` compile with optimizer 200, no warnings | ✅ |

```bash
bash test/run-all.sh      # build + English + headless + EVM + QR + invoices
```

Screenshots of the idle, locked, settled, expired, USDT-side and desktop states are written to
`shots/v2-*.png` by the headless suite.

## Android wrapper

`android/` is a dependency-free `WebView` shell (package `com.jbitmstr.cleanswap`, `app_name =
CLEANSWAP`, `android:screenOrientation="user"`, `#07130d` status/nav bars, launcher icons generated
from `icon-clean-1.png`). Build it with `gradle assembleDebug` after staging `dist/cleanswap.html`
into `app/src/main/assets/index.html`.

The shell owns the wallet hand-off: `lightning:` and `bitcoin:` links (any scheme the WebView
cannot render) become an `ACTION_VIEW` intent, so **Open in wallet** opens the installed wallet
instead of failing with `net::ERR_UNKNOWN_URL_SCHEME`. A phone with no such app gets a toast
rather than a crash, and the manifest declares a `<queries>` entry for both schemes so Android
11+ package visibility does not hide the wallet.

GitHub Actions builds `cleanswap.apk` on every push to `main` and on `v*` tags
(`.github/workflows/apk.yml`); the same file is kept under `android/ci/build-apk.yml` for reference.
The APK is uploaded as a workflow artifact.

## Security notes and limitations

* This is a **prototype**. The practice escrow is a local simulator — it never touches a chain.
* Minted offers and invoices carry deterministic filler signatures; they parse, checksum and hash
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
