# CLEANSWAP

A lightweight, non-custodial **Lightning BTC ↔ USDT atomic swap** prototype — one HTML file, no
framework, no extension, no wallet vendor. The screen is deliberately plain (two cards, one button,
Toss-like); the protocol underneath is a Bitcoin-style SHA-256 hashlock that settles both legs with
the same 32-byte secret.

The whole point is to make a hash-timelock-contract swap feel like tapping through a payment app:

1. **교환 시작하기** — the maker generates a 32-byte preimage `R` and publishes `H = SHA256(R)`.
2. **1. 내 비트코인 잠그기 / 2. 상대 USDT 잠금 확인** — the Lightning leg and the token leg lock
   against the same `H`, with the Lightning timelock strictly longer than the token timelock.
3. **3. 동시 교환 완료!** — revealing `R` pays the token leg and, in the same breath, hands the
   Lightning leg its preimage.
4. If nobody settles, **시간 초과 환불 테스트** walks the timelock and refunds.

Built-in **Practice Sandbox**: the full four-step state machine runs locally in seconds with real
WebCrypto SHA-256, a real state machine and a real reveal check — no chain, no funds, nothing to
install. Wallet hand-off (standard `lightning:` deep links, QR, clipboard) is optional and works
with BlueWallet, Wallet of Satoshi, Lexe, AQUA and Blockstream Green as ordinary URI consumers.

**Live app:** open `/ln-usdt-swap.html` (the single-file build) or `dist/cleanswap.html`.

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

### Lightning side: BOLT11 and BOLT12

Both are parsed in the browser, with no dependency:

* **BOLT11** (`lnbc…`, `lntb…`, `lnbcrt…`) — bech32 with checksum, 35-bit timestamp, tagged fields,
  signature slot. The app extracts `payment_hash` and compares it with `H`, which is what makes a
  cross-chain HTLC swap verifiable before any money moves.
* **BOLT12 offer** (`lno1…`, the Lexe offer shape) — bech32 *without* checksum over a TLV stream;
  `offer_description`, `offer_amount`, `offer_absolute_expiry`, `node_id` and friends are decoded
  and shown with their TLV numbers.
* Wallet hand-off: `lightning:<invoice|offer>` deep link, one-tap copy, and a locally generated QR
  (own encoder, byte mode, EC level M, versions 1–10).

> Honest limit: a BOLT12 offer has **no `payment_hash`**, so preimage matching is only established
> with a BOLT11 invoice. BOLT12 is used here as the Lexe offer endpoint / sandbox flow, not as the
> HTLC leg.

### USDT side: AQUA / Liquid, with an EVM reference backend

AQUA does not expose hashlock scripts, so the prototype keeps the token leg at the level a wallet
can actually do: a Liquid address, an amount-bearing `liquidnetwork:` request, a QR and copy — plus
the EVM HTLC above for anyone who wants the lock enforced on-chain with the identical `H`.

---

## Repository layout

```
ln-usdt-swap.html            built single-file app (also dist/cleanswap.html)
build.py                     src/ → single file, inlines CSS/JS/contract/icons
src/
  index.template.html        screen markup (Korean UI, plain language)
  app.css                    dark-emerald theme, mobile-first
  app.js                     state machine, BOLT11/BOLT12, swap ids, calldata, QR wiring
  qr.js                      dependency-free QR encoder (byte mode, 1–10, L/M/Q/H)
contracts/
  LightningUsdtHTLC.sol      sha256 hashlock, ERC-20 escrow, timelock refund
  TestUSDT.sol               6-decimal faucet token
tools/
  gen-invoice.py             builds the BOLT11 / BOLT12 samples embedded in the app
  make-icons.py              favicon + touch icon from icon-clean-1.png
  make-launcher-icons.py     Android launcher icons
  qr-check.js                dumps QR matrices for cross-checking
  shots-extra.js             desktop/drawer screenshots
test/
  headless.js                Playwright end-to-end suite (64 checks)
  contract-evm.py            contract behaviour on a real EVM (py-evm), 23 checks
  qr-crosscheck.py           QR matrices vs python-qrcode
  run-all.sh                 everything above with the right env
android/                     minimal WebView wrapper (com.jbitmstr.cleanswap)
```

---

## Build

```bash
python3 build.py                     # → ../ln-usdt-swap.html and dist/cleanswap.html
```

The output is one self-contained file: inline CSS/JS, inline base64 icons, the Solidity source in
a `<script type="text/plain">` block for the in-app viewer. The only network request is the optional
BTC/USD quote from `mempool.space` (labelled “offline” with a static demo rate when it fails).

## Verification & test results

All suites pass on this tree:

| Suite | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` (Playwright, 390×844 / 360×780 / 1280×800) | No page/console errors, real `crypto.subtle` SHA-256 equals Node's, `H = SHA256(R)` at offer time, BOLT11 `payment_hash` round-trip, tampered invoice rejected, BOLT12 TLV decode (description / node_id / expiry), BIP-173 bech32 vectors, full lock → claim → settled flow, timelock → refund flow, preimage hidden until settlement, `lightning:` href follows the decoded request, QR renders, zero horizontal overflow at three widths | **64/64 pass** |
| `test/contract-evm.py` (solc 0.8.26 + py-evm) | Real bytecode: faucet/approve, `lock` escrows and debits, swap record and `computeSwapId` agree, wrong preimage reverts, correct preimage pays the receiver and empties escrow, `Claimed` carries `R`, double claim reverts, refund refused before timelock, claim refused after it, refund makes the sender whole, `Refunded` emitted | **23/23 pass** |
| `test/qr-crosscheck.py` | Every module of every mask (0–7) across five payload lengths matches `python-qrcode` exactly | **40/40 matrices equal** |
| `solc` | `LightningUsdtHTLC` + `TestUSDT` compile with optimizer 200, no warnings | ✅ |

```bash
bash test/run-all.sh      # headless + contract + QR cross-check
```

## Android wrapper

`android/` is a dependency-free `WebView` shell (package `com.jbitmstr.cleanswap`, `app_name =
CLEANSWAP`, `android:screenOrientation="user"`, `#040e09` status/nav bars, launcher icons generated
from `icon-clean-1.png`). Build it with `gradle assembleDebug` after staging `dist/cleanswap.html`
into `app/src/main/assets/index.html`.

GitHub Actions cannot be pushed by this repository's automation, so the workflow ships as
`android/ci/build-apk.yml`: copy it to `.github/workflows/build-apk.yml` and the next push builds
`cleanswap.apk` as a downloadable artifact.

## Security notes and limitations

* This is a **prototype**. The practice sandbox is a local simulator — it never touches a chain.
* The contract is minimal by design and has **not been audited**. Do not escrow real value with it.
* One swap per hashlock; `claim` is permissionless but pays only the receiver fixed at lock time,
  so front-running a reveal gains nothing.
* Timelock asymmetry is the safety margin: the Lightning leg must outlive the token leg
  (`T1 > T2`), otherwise the preimage could be revealed after the token side was refunded.
* AQUA/Liquid has no hashlock script, so the token leg is a wallet-level hand-off in this build.
* The UI text is Korean; the code and contract comments are English.

## Contributors

- [@JBITmstr](https://github.com/JBITmstr)
- Gilbert ([Pickle](https://pickle.com))

## License

MIT for the code in this repository. The CLEANSWAP name and icon belong to the project owner.
