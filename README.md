<p align="center">
  <img src="docs/icon.png" width="118" alt="CLEANSWAP">
</p>

<h1 align="center">CLEANSWAP</h1>

<p align="center"><b>Swap bitcoin for USDT — or USDT for bitcoin — with both sides locked before anything moves.</b></p>

<p align="center">
  <img alt="dependencies 0" src="https://img.shields.io/badge/dependencies-0-0f9d6e">
  <img alt="single file build" src="https://img.shields.io/badge/build-single%20file%20HTML-0f9d6e">
  <img alt="solc 0.8.26" src="https://img.shields.io/badge/contract-solc%200.8.26-0f9d6e">
  <img alt="tests passing" src="https://img.shields.io/badge/tests-317%20passing-0f9d6e">
  <img alt="android 0.4.3" src="https://img.shields.io/badge/android-0.4.3-0f9d6e">
  <img alt="english only" src="https://img.shields.io/badge/UI-English%20only-0f9d6e">
</p>

<p align="center">
  <img src="docs/preview.png" alt="CLEANSWAP on a phone: ready, both sides locked, completed" width="100%">
</p>

CLEANSWAP is a non-custodial **Lightning bitcoin <-> USDT atomic swap** prototype: one HTML file, no
framework, no browser extension, no wallet vendor, no custodian. Three steps - **1 the Lightning
invoice, 2 the USDT address, 3 Approve** - and underneath them a Bitcoin-style SHA-256 hashlock that
settles both legs with the same 32-byte secret.

`v0.4.3` is the version that fits on one screen, never leaves the phone when it can, and does not
call a swap finished until you say the money has left your wallet.

## What `v0.4.3` does

* **Three steps, and the same three in both modes.** `1 Partner's Lightning invoice` (an `lnbc...`
  invoice or an `lno1...` offer the other side wants paid) -> `2 Your USDT address` (the `0x...` or
  `T...` that receives the USDT) -> `3 Approve`. Practice and Wallet build the same screen from the
  same markup, the same field in the same place, the same numbers; a rehearsal cannot teach a
  different flow than the real thing.
* **The direction reverses the steps.** One tap on the switch between the cards and the order swaps:
  sending USDT, `1 Partner's USDT address` comes before `2 Your Lightning invoice`, and the invoice
  row stops offering `Open in wallet` and offers `Copy` instead, because now the invoice is yours to
  hand over rather than one to pay.
* **`Sample` in Practice, and nowhere else.** Beside step 1 and step 2 there is one small button that
  fills what the other side (or your own wallet) would supply: a real `lnbc...` invoice minted on the
  device for this amount, and a valid `0x` address. Wallet mode hides both buttons and takes only
  what you paste. A practice swap is never written to **Recent**; a real one is.
* **`Approve` is the whole swap in Practice.** One tap verifies the two inputs, binds them to one
  hashlock, builds the escrow's `lock()` call from that same hash, settles both legs at once and
  shows a small receipt: what you sent, what you got, the address. If a check fails the button stays
  inert and the sentence says what is wrong - a tap alone never moves money.
* **In Wallet, `Approve` waits for the payment.** The tap checks the same things, but it ends on
  **Waiting for payment**, not on a receipt: the invoice to pay (or, sending USDT, the address) with
  `Open in wallet`, `Copy` and `QR`, and below it `I paid` and `<- Back`. Only `I paid` closes the
  swap and shows the receipt, because until then nothing has been paid and calling the swap complete
  would be a lie. Practice still settles on the one tap - a rehearsal moves nothing.
* **A BOLT12 offer is a payment target, not a rejection.** Pasting `lno1...` - the offers Lexe and
  other BOLT12 wallets hand out - is accepted: `Open in wallet` becomes `lightning:lno1...`, the QR
  carries it, and it keeps working through the waiting screen. An offer has no `payment_hash` of its
  own, so the swap binds to the offer itself (see below). Random text that only looks like bech32 is
  still refused.
* **TRON USDT addresses work.** Step 2 takes an EVM address (`0x` + 40 hex) or a TRC-20 one (`T` +
  33 base58 characters), and the TRON form is verified with its real Base58Check SHA-256 checksum: a
  mistyped, truncated or wrong-checksum address is refused instead of being paid.
* **The terms leave as a code, not as a web address.** `Share code` copies
  `cleanswap:...` (base64url JSON: both amounts, the window, and - once known - the hashlock and the
  USDT address). It is not a link: no host, no path, no file, no name, nothing taken from
  `location.href`, so a message app, a printed QR and *any* camera app can carry it. `Use code` on
  the other phone takes the other side of those terms: the direction flips, the amounts and the
  window are adopted, the USDT address is filled in, and an invoice that hashes to something else is
  refused (`That invoice is for a different swap.`). The app also registers the `cleanswap:` scheme,
  so a code handed over by another app opens CLEANSWAP on it.
* **The QR never hides under the Approve bar.** Opening a QR scrolls it clear of the fixed bar (see
  `qr 360x780` in the test suite); the page reserves the bar's height at the bottom.
* **`<- Back` from the finished swap** returns to the filled-in form, so the terms can be reviewed
  without retyping them; `Done` starts a clean swap.

## The three steps

| Step | On screen | What is checked before `Approve` moves |
| --- | --- | --- |
| 1 | the Lightning invoice or offer - `Open in wallet`, `QR` (Wallet), `Sample` (Practice) | bech32 checksum, `payment_hash` present (or a well-formed `lno1...` offer, which binds the swap to itself), amount equal to the swap (an amountless invoice or offer is allowed), not expired, `bc` network, and - when a code arrived first - a hash equal to the one that code pinned |
| 2 | the USDT address - `Sample` (Practice) | an EVM `0x` address with exactly 40 hex characters, or a TRON `T` address of 34 base58 characters whose double-SHA-256 Base58Check checksum holds; not the zero address of either chain |
| 3 | `Approve` | the two are bound: the invoice's `payment_hash` (or the offer's own hash) becomes the swap's `H`, `lock(H, T2, yourAddress, USDT, amount)` is the escrow leg, and `swapId = sha256(abi.encodePacked(H, sender, receiver, token, amount, timelock))` is what both sides settle on |

Anything refused is named in plain English and never in jargon, and the hidden log keeps the decoded
fields for a support question.

## Wallet mode - a real hand-off

Practice replaces the counterparty with a simulator; **Wallet** replaces it with a real one, in the
same three steps:

| Step | Wallet mode | Practice mode |
| --- | --- | --- |
| 1 | you paste the invoice the other side made, or your own when you are the one being paid - an `lno1...` offer works the same way; `Open in wallet` is the standard `lightning:` deep link into BlueWallet / Wallet of Satoshi / Lexe / AQUA / Blockstream Green | `Sample` mints a `lnbc...` invoice for this amount and pastes it for you |
| 2 | you paste your (or your partner's) `0x...` or `T...` address | `Sample` fills a valid `0x` address |
| 3 | `Approve`, then `I paid` once the wallet shows the payment gone | `Approve` - nothing opens, nothing is paid, and Recent stays empty |

There is no WebLN, no browser extension and no key request - the app never signs anything, and
nothing is paid except in your own wallet.

**A real wallet invoice binds the swap.** Wallets do not know about this app, so the invoice they
issue carries *their* `payment_hash`. That hash *is* the swap: it becomes `H`, and the USDT `lock()`
the escrow uses is built from the same `H`. One hashlock, both legs. What is *not* accepted: an
invoice whose bech32 checksum does not hold, one that has expired, one for a different amount
(`That invoice is for 25,000 sats, not 50,000.`), or an invoice on a hash that the shared code
already fixed.

**Waiting is part of the flow.** After `Approve` the screen shows what to pay and where, and stays
there until `I paid`. `<- Back` returns to the filled form without settling anything.

<p align="center">
  <img src="docs/paying.png" width="360" alt="CLEANSWAP in Wallet mode: waiting for the payment, with I paid">
</p>

Completed real swaps land as one-line entries under **Recent** (`+32.15 USDT`, `+50,000 sats`).

<p align="center">
  <img src="docs/wallet.png" width="360" alt="CLEANSWAP wallet mode: invoice, address, approve">
</p>

## Both directions

One tap on the switch between the two cards flips the whole screen: *you send bitcoin* (step 1 is
the partner's invoice, step 2 is your USDT address) or *you send USDT* (step 1 is the partner's
USDT address, step 2 is your invoice). The amounts travel in the `cleanswap:` code, so the two
phones agree on the numbers and the window before either one approves.

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

One reader takes anything: `lno1…` (BOLT12 offer), `lni1…` (BOLT12 invoice), `lnbc…`/`lntb…`
(BOLT11), with or without the `lightning:` prefix.

* **BOLT12 encode** (`lno1…`) — the app mints offers for a swap: TLVs over bech32 without a
  checksum, amount in the HRP (msat), `offer_description`, `offer_absolute_expiry`, a node id and a
  64-byte signature slot. An offer cannot carry a `payment_hash` by itself, so the swap hashlock
  rides in a **custom type-80 TLV**; a minted invoice (`lni1…` shape) carries the standard
  `invoice_payment_hash` (type 168). The signature bytes are not verified by the app, and the
  hidden log says so.
* **BOLT11 encode** (`lnbc…`) — hold invoices: bech32 checksum, 35-bit timestamp, `p`/`d`/`x`
  tagged fields, a 65-byte signature slot, `payment_hash = H`.
* **BOLT11 decode** — bech32 with checksum, tagged fields, `payment_hash` extraction; the gate
  compares it with `H` before any money moves.
* Wallet hand-off: `lightning:<offer|invoice>` deep link, one-tap copy, and a locally generated QR
  (own encoder, byte mode, EC level M — falling back to L for long requests — versions 1–13).

> Honest limit: a BOLT12 offer has **no `payment_hash` field of its own**, so a swap paid through
> an offer has nothing in the offer to lock the USDT leg to. Offers minted here therefore carry the
> swap hashlock in the custom type-80 TLV and keep it; an offer from someone else's wallet (Lexe,
> say) binds the swap to the offer string itself - `H = SHA-256` of the offer's TLV bytes - which is
> deterministic, identical on both phones, and travels in the `cleanswap:` code. A wallet-generated
> invoice for the same swap carries the standard `invoice_payment_hash`, and Wallet mode adopts that
> instead. Garbage, truncation and text that only resembles an offer are refused at the gate.

### USDT side: two addresses in, the same escrow

Step 2 accepts either form a USDT holder actually pastes: an EVM address (`0x` + 40 hex) or a TRON
TRC-20 address (`T` + 33 base58 characters). The TRON form is decoded from base58 and checked
against its four-byte double-SHA-256 Base58Check checksum (the synchronous SHA-256 in `src/app.js`
exists for exactly this, because an address check cannot wait on a promise), and its prefix byte must
be `0x41`; a wrong character, a wrong length or a bad checksum is refused.

The token leg itself is unchanged: AQUA/Liquid and TRON are wallet-level hand-offs, and the EVM HTLC
above is the reference for anyone who wants the lock enforced on-chain with the identical `H`. The
escrow the gate checks is generated from that contract's ABI, so the calldata a partner sends is the
calldata a wallet would send. For a TRON address the app builds no EVM calldata and says so in the
log rather than pretending.

### What the screen deliberately hides

The verification did not get weaker, it moved out of sight. The hidden event log (`#log`) still
records every decoded field, hash comparison and refusal for a support question, and the practice
sandbox still builds real bech32 offers, real ABI-encoded locks and a real SHA-256 preimage — the
same decoders that check a wallet's invoice check the simulated one.

---

## Repository layout

```
ln-usdt-swap.html            built single-file app (also dist/cleanswap.html)
build.py                     src/ -> single file (+ the APK asset); refuses to emit Hangul
src/
  index.template.html        screen markup: two cards, three steps, one Approve bar
  app.css                    light payment-app theme, fixed action bar, mobile-first
  app.js                     three-step screen, invoice/address gates, swap code, BOLT11/12, calldata
  qr.js                      dependency-free QR encoder (byte mode, 1-13, L/M/Q/H)
contracts/
  LightningUsdtHTLC.sol      sha256 hashlock, ERC-20 escrow, timelock refund
  TestUSDT.sol               6-decimal faucet token
docs/
  icon.png                   app icon for this page and the launcher
  preview.png                ready / both locked / completed, from the built app
  wallet.png                 wallet mode hand-off
tools/
  gen-invoice.py             builds the BOLT11 / BOLT12 samples embedded in the app
  mint-invoices.js           asks the built app to mint invoices for cross-checking
  make-icons.py              favicon + touch icon from icon-clean-1.png
  make-launcher-icons.py     Android launcher icons
  qr-check.js                dumps QR matrices for cross-checking
  docshots.js                regenerates docs/preview.png and docs/wallet.png
test/
  headless.js                Playwright end-to-end suite (182 checks)
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
python3 build.py     # -> ../ln-usdt-swap.html, dist/cleanswap.html and the APK asset
```

The output is one self-contained file: inline CSS/JS, inline base64 icons, the Solidity source in a
`<script type="text/plain">` block for integrity. The only network request is the optional BTC/USD
quote from `mempool.space` (the rate line says "offline" and the shipped demo rate is used when it
fails). The build also fails if any source file contains a Hangul character.

## Verification & test results

All suites pass on this tree:

| Suite | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` (Playwright, 360x780 / 390x844 / 1280x800) | The three steps and their numbers, the same screen in Practice and Wallet with `Sample` only in Practice, the flip that reverses the steps and swaps `Open in wallet` for `Copy`, invoice refusals (broken checksum, expired, other amount, a hash that is not this swap's), a `lno1...` offer accepted both at the gate and on the screen with its `lightning:` hand-off and QR, address refusals and acceptances on both chains (short, zero, empty, EVM lower-casing, two real TRC-20 addresses, a bad TRON checksum, a wrong length, a lower-cased TRON address), the Wallet wait (`Approve` moves to Waiting for payment, nothing is in Recent, `I paid` produces the receipt, `<- Back` unsettles nothing), `Approve` staying inert with a field left empty, the `cleanswap:` code (shape, round trip, no path or host in it, QR equal in substance, two phones settling on the same hashlock *and* the same swap id), the QR clearing the Approve bar at 360x780, the waiting screen fitting that width, the action bar never covering the last line, no technical word or Hangul on screen, and zero horizontal overflow at three widths | **182/182 pass** |
| `test/contract-evm.py` (solc 0.8.26 + py-evm + eth-abi) | Real bytecode: faucet/approve, `lock` escrows and debits, swap record and `computeSwapId` agree, wrong preimage reverts, correct preimage pays the receiver, `Claimed` carries `R`, double claim reverts, refund before/after the timelock, `Refunded` emitted — and the UI's `lock()` calldata decodes to the swap fields with the right keccak selector | **26/26 pass** |
| `test/qr-crosscheck.py` | Every module of every mask (0–7) across eight payloads, including BOLT12 lengths at versions 12–13, matches `python-qrcode` exactly | **64/64 matrices equal** |
| `test/invoice-crosscheck.py` | Every invoice the app mints parses under an independent Python BOLT11 decoder: checksum, `payment_hash`, amount (including 1 sat and 250k sats), 35-bit timestamp, expiry tag, 65-byte signature slot, optional description, and a length that still fits a QR | **45/45 pass** |
| `test/verify-english.py` | `[\uac00-\ud7af]` count is 0 across every tracked text file, file name and commit message | **0 characters** |
| `solc` | `LightningUsdtHTLC` + `TestUSDT` compile with optimizer 200, no warnings | pass |

```bash
bash test/run-all.sh      # build + English + headless + EVM + QR + invoices
```

Screenshots of the form, the filled form, the blocked form, both directions, the finished swaps, the
waiting screen (invoice, offer and USDT-side), the code QR, the 360x780 QR and the desktop view are
written to `shots/v43-*.png` by the headless suite.

## Android wrapper

`android/` is a dependency-free `WebView` shell (package `com.jbitmstr.cleanswap`, `app_name =
CLEANSWAP`, `versionName 0.4.3`, `versionCode 6`, `android:screenOrientation="user"`, `#f2f4f7`
status/nav bars, launcher icons generated from `icon-clean-1.png`). Build it with `gradle
assembleDebug` after staging `dist/cleanswap.html` into `app/src/main/assets/index.html`
(`build.py` writes that copy too).

The shell owns the wallet hand-off: `lightning:` and `bitcoin:` links (any scheme the WebView
cannot render) become an `ACTION_VIEW` intent, so **Open in wallet** opens the installed wallet
instead of failing with `net::ERR_UNKNOWN_URL_SCHEME`. A phone with no such app gets a toast
rather than a crash, and the manifest declares a `<queries>` entry for both schemes so Android
11+ package visibility does not hide the wallet.

The shell also receives the off-line code: an `android:scheme="cleanswap"` intent filter
(`VIEW` / `DEFAULT` / `BROWSABLE`) means a camera app, a scanner or a message app that hands the code
over opens CLEANSWAP on it, and `MainActivity` delivers it to the page once it has loaded
(`onNewIntent` for a running app). The page is still loaded from `file:///android_asset/index.html`;
that address never appears in anything the app shares.

GitHub Actions builds `cleanswap.apk` on every push to `main` and on `v*` tags
(`.github/workflows/apk.yml`); the same file is kept under `android/ci/build-apk.yml` for reference.
The APK is uploaded as a workflow artifact.

## Security notes and limitations

* This is a **prototype**. The practice sandbox is a local simulator — it never touches a chain.
* `I paid` is the payer's word, not an observation: the app holds no node and no chain access, so it
  cannot see whether the payment landed. The button exists so the screen never claims a swap the
  money has not paid for; a production build would watch the invoice or the lock instead.
* A TRON address is verified as a Base58Check address, not as a USDT-funded account; the token leg
  on TRON is a wallet hand-off, exactly like AQUA/Liquid.
* Minted offers and invoices carry deterministic filler signatures; they parse, checksum and hash
  correctly, but no node will route them. They exist so the gate can be exercised honestly.
* The contract is minimal by design and has **not been audited**. Do not escrow real value with it.
* One swap per hashlock; `claim` is permissionless but pays only the receiver fixed at lock time,
  so front-running a reveal gains nothing.
* Timelock asymmetry is the safety margin: the Lightning leg must outlive the token leg
  (`T1 > T2`), otherwise the preimage could be revealed after the token side was refunded.
* AQUA/Liquid has no hashlock script, so the token leg is a wallet-level hand-off in this build.
* A `cleanswap:` code carries terms only: the two amounts, the window, and - if they were already
  known - the hashlock and the USDT address. It is not a web address, has no host, and is never
  built from the page's own URL, so sharing one exposes no account, no file path and no name.
* A swap lives in the page: reloading it forgets it. Nothing but the optional practice sample is
  written anywhere, and nothing is written to storage.
* The UI, code, tests and commit messages are English only, and `test/verify-english.py` enforces it.

## Contributors

- [@JBITmstr](https://github.com/JBITmstr)
- Gilbert ([Pickle](https://pickle.com))

## License

MIT for the code in this repository. The CLEANSWAP name and icon belong to the project owner.
