# WalletConnect and NWC: taking the paste out of a mobile swap

**Status: design for the next milestone. Nothing in this document is in the app
yet.** There are no buttons, no placeholders and no hidden wiring for either
protocol in the current build; the screen keeps the shape it has until a session
can be opened, a call can be sent and a receipt can be read end to end. This file
is the plan that work will be judged against.

## The problem it removes

A swap on a phone today is three hand-offs:

1. **The USDT leg.** When the page is opened inside a wallet's browser
   (`window.ethereum`), `Approve` asks that wallet to sign. Opened anywhere else
   - a browser tab, the installed CleanSwap APK - the same tap has to be carried
   out by hand: copy the `approve` and `lock` calldata (or tap an `ethereum:`
   EIP-681 link), then paste the transaction hash back so the page can read the
   receipt and learn which address funded the escrow.
2. **The claim and the refund.** The same, in the other direction, with a 32-byte
   secret that has to reach a wallet app.
3. **The Lightning leg.** The invoice is pasted or scanned into a wallet, and the
   payment happens there; the page never learns when it was paid except that the
   person says so and the escrow is read.

Two protocols close most of that gap on mobile: **WalletConnect v2** for the EVM
side and **Nostr Wallet Connect (NWC, NIP-47)** for the Lightning side. Both are
"the wallet stays where it is, and the page asks it to do one thing". Neither
gives the page a key, and neither may weaken a check the page already makes.

## WalletConnect v2 (EIP-1193 over the relay)

### What it is used for

Sending the three calls the page already builds - `approve`, `lock`, `claim`,
`refund` - and nothing else. The page keeps building them itself
(`approveCalldata`, `lockCalldata`, `claimCalldata`, `refundCalldata`); the
session only carries the bytes to a wallet that signs them.

### Shape of the integration

* **Client.** `@walletconnect/sign-client` (or the newer `WalletKit` dapp API),
  built once into a single dependency-free IIFE and inlined by `build.py` the
  way `src/qr.js` already is (`src/vendor/wc-client.js`, `/*__WCVENDOR__*/`).
  The page stays one HTML file with one inline script and the hash-pinned CSP.
  A prebuilt bundle is pinned by version and by SHA-256 in a build check, because
  a vendored file is the one place a dependency could arrive unreviewed.
* **Project id.** The relay (`wss://relay.walletconnect.com`) authenticates a
  project id. That id is not a secret, but it is not the app's to borrow either:
  the milestone starts with a project registered for CleanSwap, and the build
  refuses to emit a page with a placeholder id. A self-hosted relay stays
  possible on the same protocol.
* **Pairing.** `sign-client.pair(uri)` with a `wc:...@2?relay-protocol=irn&symKey=...`
  URI, shown as a QR by the page's own encoder - **if it fits**. A WC URI is
  roughly 300-400 bytes; the encoder's ceiling is 340 bytes at level L (version
  13), so the long form gets the copy button and an `Open in wallet` deep link
  instead of a QR that would not scan. Both are measured in a test, not guessed.
* **Session.** `session_request` → the person approves in the wallet →
  `session_namespace` gives `eip155:421614` or `eip155:4211` with the accounts
  the wallet chose. The page reads `eth_chainId` before every send and refuses
  to send when it is not the chain Setup is set to - the same rule
  `assertChain()` already applies to an in-page wallet.
* **Sending.** `eth_sendTransaction` with `{ from, to, data, value: '0x0' }`,
  exactly the object `walletSend()` already builds. The receipt is then read by
  the page's own JSON-RPC quorum, never by the wallet: a wallet that lies about
  a receipt cannot make a swap settle.
* **Session lifetime.** In memory only. A `wc:` session topic is a bearer
  capability for that account's signing, and the page's storage rule is that
  nothing worth stealing is written to `localStorage`. A killed page therefore
  loses the session - and keeps the swap, because the recovery record
  (`cleanswap.swap.v1`) holds the terms, not the session. Re-pairing is one QR.
* **Refusals.** A rejected request, an expired session (proposal timeout 300 s),
  a wallet on another chain, a wallet account that is not the one the swap was
  approved from, a relay that is down: each maps to an existing sentence
  (`walletFail()`) rather than a new one.

### Where the code goes

* `src/modules/walletconnect.js` - session, pairing URI, request/response, the
  adapter that implements `provider()`'s three methods (`request`,
  `eth_chainId`, `eth_requestAccounts`) over the relay.
* `src/modules/wallet.js` - unchanged call sites: `runLock()`, `doClaim()`,
  `doRefund()`, `waitReceipt()` keep calling `walletSend()`; the provider is
  chosen at the top (`window.ethereum` first, then a live WC session, then the
  copy/paste path).
* `src/index.template.html` - one pairing row, and it appears only when a
  session is not live. **No button that does nothing.**

### What it must not do

* No new name on `window`. The bridge stays `{ acceptCode }` in a shipped page.
* No session key, no topic, no account in `localStorage`.
* No sending through a session whose chain or account does not match the swap.
* No reading of the escrow through the wallet: the quorum is the page's.

### Tests

* A mock relay (a WebSocket server on `127.0.0.1`, spoken to with the same
  envelope the relay uses) drives a session end to end; the `data` field of
  `eth_sendTransaction` is compared byte for byte with `lockCalldata()`.
* A request sent while the wallet reports `0x1` (mainnet) for a Sepolia swap is
  refused before it leaves, and the swap stays where it was.
* A session that is dropped mid-swap leaves the swap recoverable: the record is
  still there, the phase is unchanged, and re-pairing resumes.
* The pairing URI's length is asserted against the QR ceiling, so the copy path
  is chosen on a measurement.
* The vendored bundle's SHA-256 is asserted by the build.

## NWC (NIP-47) for the Lightning leg

### What it is used for

* **Paying the invoice** (`pay_invoice`): the side that sends bitcoin stops
  opening another wallet and pasting an invoice, and the page learns the payment
  succeeded from the wallet service rather than from a tap.
* **Making the invoice** (`make_invoice`) is *not* enough for this swap: the
  swap's hashlock is the invoice's payment hash, and an ordinary `make_invoice`
  lets the wallet pick that hash - so the USDT could be locked to a hash the
  payee never has to reveal. A hold invoice is what fixes that, and hold invoices
  are **not** in NIP-47's base method set.

### Hold invoices: the honest shape

Some implementations expose a hold extension to NIP-47
(`make_hold_invoice`, `settle_hold_invoice`, `cancel_hold_invoice`): LND-based
wallets, Alby Hub, CLN through its hold-invoice plugin, LNbits. The design is:

1. `get_info` reads the wallet service's `methods` list at pairing time.
2. If it includes the hold extension, the app can *offer* "your wallet makes the
   hold invoice". The invoice it returns still goes through `decodeBolt11()` and
   the whole gate: signature, amount, expiry, `c` tag, window order. A wallet
   service's invoice is not trusted because it came from a wallet service.
3. If it does not, nothing changes: the invoice is pasted from the partner, as
   today. **No half-support, no silent fallback to a non-hold invoice.**

The preimage never travels over NWC. The side that holds it keeps it in the page
and uses it for the `claim` on the escrow; `settle_hold_invoice` only takes the
preimage once the USDT is in the escrow and read as locked, which is the order
the swap already enforces.

### Shape of the integration

* **Connection.** `nostr+walletconnect://<wallet-pubkey>?relay=wss://...&secret=<hex>`
  pasted or scanned once. The `secret` is a spending credential for that wallet,
  so it lives in memory for the session and is never written to `localStorage` -
  not by the swap record, not by Setup. A restart re-pairs; that is the price of
  not keeping a wallet key on disk.
* **Messages.** kind `23194` request / `23195` response, encrypted end to end.
  NIP-44 (versioned, ChaCha20 + HMAC-SHA256 over an ECDH shared secret) is the
  default; NIP-04 (AES-256-CBC) is accepted from older services and answered in
  kind. The page already carries secp256k1 (`SECP`) for BOLT11 signatures, and
  WebCrypto has HMAC and AES, so neither needs a dependency: the primitives are
  added to `src/modules/crypto.js` with test vectors from the NIPs, next to the
  BOLT11 vectors.
* **Relays.** `connect-src wss:` and the relay host go into the CSP; more than
  one relay is allowed by the URI, and the first that answers is used.
* **Timeouts.** A `pay_invoice` response can take 30 seconds; the gate's clock
  rules (`PAY_MARGIN`, `SYNC`) still decide whether paying is safe at all, on the
  tap, before the request is sent.
* **Where the code goes.** `src/modules/nwc.js` (connection, request/response,
  NIP-44/NIP-04), `src/modules/relay.js` (a minimal Nostr client over WebSocket:
  `REQ`/`EVENT`, one subscription per request), `src/modules/crypto.js`
  (ChaCha20, HMAC key derivation).

### What it must not do

* No secret in storage; no NWC URI in a swap code or on the window.
* No payment the gate has not approved - the tap still runs `paid()`'s checks
  first.
* No invoice accepted because a wallet made it: the same signature, hash, amount
  and window checks apply.
* No hold invoice when the wallet service cannot make one; the paste path stays.

### Tests

* A mock wallet service (a second WebSocket server, the same envelope) answers
  `pay_invoice`; the request's invoice is compared with the one on the screen.
* A hold-invoice flow: `make_hold_invoice` → the returned invoice passes
  `decodeBolt11()` and the gate, and its payment hash is the one the swap locks.
* A wallet service without the hold extension: only the paste path is offered,
  and no request of the hold kind is sent.
* NIP-44 and NIP-04 round-trip vectors, and a decryption failure that is a
  refusal, not a silent empty invoice.
* The NWC secret is asserted absent from `localStorage` after a session.

## Android shell

Two schemes join the hand-off allowlist and the manifest's `<queries>`:
`wc:` (pairing deep link) and `nostr+walletconnect:` (a wallet's connection
string). The shell's page origin is unchanged, and the WebSocket traffic is the
page's own - the shell stays a shell. The pairing QR is drawn by the page's
encoder, so nothing new reaches the shell.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| 1 | WC session, read-only | A session pairs, `eth_chainId` is read, `wallet_switchEthereumChain` asks for the swap's chain, nothing is sent |
| 2 | WC sends the USDT leg | `lock`/`claim`/`refund` go out through the session; the receipt is read by the quorum; the paste path still works |
| 3 | NWC pays the invoice | `pay_invoice` over a live session; `paid()`'s checks run on the tap first |
| 4 | NWC hold invoices | Offered only where `get_info` lists the extension; the invoice still passes `decodeBolt11()` |
| 5 | Shell and docs | `wc:` and `nostr+walletconnect:` in the allowlist, the CSP carrying `wss:`, the README updated with what is supported |

Each milestone keeps the existing paths working. A phone whose wallet speaks
none of this swaps exactly as it does today.
