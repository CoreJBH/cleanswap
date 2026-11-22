<p align="center">
  <img src="docs/icon.png" width="118" alt="CleanSwap">
</p>

<h1 align="center">CleanSwap</h1>

<p align="center"><b>Swap bitcoin for USDT — or USDT for bitcoin — with both sides locked before anything moves.</b></p>

<p align="center">
  <img alt="dependencies 0" src="https://img.shields.io/badge/dependencies-0-0f9d6e">
  <img alt="single file build" src="https://img.shields.io/badge/build-single%20file%20HTML-0f9d6e">
  <img alt="solc 0.8.26" src="https://img.shields.io/badge/contract-solc%200.8.26-0f9d6e">
  <img alt="tests passing" src="https://img.shields.io/badge/tests-592%20passing-0f9d6e">
  <img alt="arbitrum" src="https://img.shields.io/badge/chain-Arbitrum%20Sepolia%20%2F%20One-0f9d6e">
  <img alt="android 0.6.11" src="https://img.shields.io/badge/android-0.6.11-0f9d6e">
  <img alt="english only" src="https://img.shields.io/badge/UI-English%20only-0f9d6e">
</p>

<p align="center">
  <img src="docs/preview.png" alt="CleanSwap on a phone: ready, both sides locked, completed" width="100%">
</p>

CleanSwap is a non-custodial **Lightning bitcoin <-> USDT atomic swap**: one HTML file, no framework,
no wallet vendor, no custodian. Three steps - **1 the Lightning invoice, 2 the USDT address,
3 Approve** - and underneath them a Bitcoin-style SHA-256 hashlock that settles both legs with the
same 32-byte secret.

`v0.5.0` is the version that reads the chain. The USDT leg is a real HTLC on **Arbitrum** - the
`CleanSwapHTLC` contract, default network **Arbitrum Sepolia**, switchable to **Arbitrum One** - and
the app no longer believes the phone: the escrow is read over public JSON-RPC, and the swap only
closes when the contract says the USDT is locked for these terms and then claimed.

`v0.5.1` makes **Practice walk that same road**: `Approve` no longer jumps to a finished swap. A
rehearsal parks on the same **Waiting for payment** screen, with the same invoice hand-off, the same
`Check chain` and `I paid`, and closes only when the stand-in escrow says the USDT was claimed. The
two modes differ in exactly two things: `Sample` beside the two inputs, and a stand-in escrow on the
phone instead of a deployed one (so a rehearsal is never written to Recent).

`v0.6.0` is the security pass, from a code review that found the protocol could be talked out of
its own terms. Every item in that review is closed:

* **A code cannot change the setup.** A `cleanswap:` code is a stranger's text: it may state the
  terms, the chain and the escrow it is meant for, but it never switches the network and never
  writes an escrow address. A code naming an escrow this app does not publish, or one that differs
  from the escrow already set here, is refused whole, with the reason on the screen and a
  `SECURITY` line in the log.
* **A Lightning offer is refused.** An `lno1...` offer has no payment hash, and the invoice a wallet
  gets for it carries one of its own, so a swap bound to the offer's bytes would lock the USDT to a
  hash no payment ever moves. Pasting an offer now says so and asks for a hold invoice.
* **The swap id includes the address that funds the escrow.** `sha256(hashlock, sender, receiver,
  token, amount, timelock)`: a third party who copies the terms cannot lock them first and burn the
  id by refunding, because their own address gives the same terms a different id.
* **The window has a floor, a ceiling and a margin.** A code may not leave less than 30 minutes or
  more than 7 days; the contract refuses a timelock past `MAX_TIMELOCK_DELTA` (7 days) as well as
  one inside `MIN_TIMELOCK_DELTA`; and the Lightning invoice has to stay payable at least an hour
  past the window, so paying into the last minutes of the escrow cannot hand the sats over with
  nothing left to claim. A record past its timelock reads as **window closed**, not as locked.
* **The escrow is cross-checked.** Two or more endpoints are asked the same question and the
  answer is believed only when two agree; a single lying node disagrees with the other and the
  screen says the endpoints do not agree instead of showing a lock that is not there.
* **Token movement is checked, not assumed.** `SafeERC20`-style calls that accept tokens returning
  no bool, and a balance-delta check that refuses a transfer which moves less than the agreed
  amount (`FeeUSDT` in the test suite proves it) - the escrow can never hold less than it promises.
* **Paying bitcoin needs a wallet that hands back the payment secret.** The btc2u screen says it
  before the button, because that secret is how the payer claims the USDT if the partner goes quiet.
* **The Android shell is tighter.** `cleanswap:` intents are quoted with `JSONObject.quote` (newlines
  and separators included), and the page is served from the app's own virtual `https` origin instead
  of `file://`, so universal file access is off and the chain reads still work.
* **A dark forest theme.** Obsidian green (`#08100E` to `#0D1C18`, with a soft mint glow at the top),
  mint-emerald accents (`#50D2C1` / `#2DD4BF` / `#10B981`) on the one button that matters, hairline
  borders in `#1A332D`, and text at `#F0FDF9` / `#9CAEA8`. The Android shell's status bar, navigation
  bar and window background follow it, so nothing flashes white on launch.

`v0.6.1` closes the second review, the one that went after what the first pass left standing:

* **A BOLT11 invoice with no `x` tag expires after an hour.** The standard says so (`3600` seconds
  after the timestamp); reading a missing tag as "never expires" was a way past the window check,
  because an invoice that never ends can never end before the escrow window does.
* **The escrow has a reentrancy guard, and refuses a lock nobody could claim.** `lock`, `claim` and
  `refund` carry `nonReentrant`: a token is a stranger's contract, and one that calls back during a
  transfer must not enter a second time. A zero `hashlock` (sha256 never returns zero, so such a
  swap could only ever be refunded) and `receiver == address(this)` (the tokens would be paid back
  into the escrow) are refused at the door. `ReentrantUSDT` in the test suite proves both the
  refusal and that the guard is released when the call ends.
* **A code cannot land on a running swap.** `applyCode` refuses in every phase but `idle`: the terms
  of the next swap cannot be loaded over a swap whose money has already moved.
* **A lock code is parsed as data.** Its query string is built on `Object.create(null)`, needs a
  `key=value` shape, keeps the first of two same keys, and a malformed `%` escape drops that one
  field instead of throwing out of the decoder. The QR's caption is set with `textContent` -
  nothing from a payload is ever pasted into `innerHTML` (v0.6.2 stopped parsing the encoder's SVG
  as a document at all and builds it element by element).
* **One endpoint is not a cross-check.** When `rpcQuorum()` falls back to a single endpoint, a quiet amber
  line under the chain row says one node answers, so nothing is cross-checked, and asks for a second
  RPC endpoint. A receipt and a transaction (`waitReceipt`, `loadTx`) are read by the same quorum as
  the escrow itself, and hex answers are compared in one case.
* **The page carries a Content-Security-Policy.** `default-src 'none'`, its own inline script and
  style as the only code allowed, `data:` images, and `connect-src` limited to the chain endpoints
  (`https:`, or a node on this machine).
* **The Android shell is tighter again.** Safe Browsing is left on, a navigation is handed to another
  app only for `lightning:`, `bitcoin:`, `ethereum:` and `https:` (anything else is refused with a
  toast), `data:` and `blob:` are no longer treated as the app's own document, and the release build
  is shrunk and obfuscated with `proguard-rules.pro` keeping the shell's entry points.
* **One APK workflow, not two.** The duplicate `.github/workflows/build-apk.yml` - a broken copy
  that failed on every push - is gone; `.github/workflows/apk.yml` is the one that builds.

`v0.6.2` closes the third pass, which went after the parts the first two took on trust:

* **The payee's signature on a BOLT11 invoice is checked.** An invoice is a promise by the holder of
  a key, and this page now recovers that key from the 65-byte signature and verifies it - in the
  page, with no dependency and no network, because the app has to work off-line. An invoice that
  names its payee in an `n` tag is verified against that key and must be low-S, as the standard says;
  otherwise the key comes back out of the signature (high-S accepted for recovery, as the standard
  also says). The rehearsal's own sample invoices are signed the same way, by a practice key that
  holds nothing and belongs to no node. Checked against the BOLT #11 test vectors, and against an
  independent verifier (secp256k1 recovery in Python + OpenSSL's ECDSA) in `test/invoice-crosscheck.py`.
* **An invoice that states no amount is refused.** "Any amount" cannot be matched to the sats on the
  screen, so the escrow id would have nothing to compare; and an amount finer than a satoshi is not
  an amount this app can lock.
* **One field, one meaning.** A BOLT11 tag may appear once and a BOLT12 TLV once (blinded paths
  excepted): two payment hashes or two expiries would let the reader and the writer disagree about
  what was signed. Both are refused by name.
* **Amounts are compared as integers.** Sats, token units, msat and timelocks are parsed and
  compared as `BigInt`, so 2^53+1 and 2^53 are not the same amount, and a code's amounts travel as
  decimal strings so nothing is rounded on the way in. A value too large for a number is refused
  instead of being read as a nearby one.
* **The window is measured by the chain's clock.** The escrow's timelock is the chain's, not the
  phone's: `eth_getBlockByNumber('latest')` gives the head's timestamp, the later of the two clocks
  is used, and `I paid` re-reads it before it starts watching. Moving the phone's clock cannot open
  a window that has closed, or leave one open that the chain says is closing.
* **A USDT address from a code is never written into the field on the side that receives it.** A
  code is a stranger's text, and an address in it could be the stranger's own; the receiving side
  is shown the address and has to tap **Use it**. On the side that sends the USDT the address in a
  code is the partner's own destination, and that one is filled in.
* **Hex that cannot be read is an error.** `fromHex()` refuses an odd length or a character outside
  hex instead of padding it to a zero byte, so nothing signs or locks on bytes nobody wrote. The
  `approve` an `I approve` step sends now reads the current allowance through the same quorum as the
  escrow, and when a non-zero, too-small allowance is there it is reset to zero first and the exact
  amount approved after it - one transaction each, each waited for.
* **The QR is built element by element.** `document.createElementNS` draws the modules straight from
  the encoder's grid; the encoder's SVG string is never parsed, so no payload can become a node.
* **The Content-Security-Policy names hashes instead of `'unsafe-inline'`.** `build.py` computes the
  SHA-256 of every inline script and style block it writes and puts those hashes in the policy, so
  the code that is in the file runs and a block added afterwards does not.
* **The Android shell keeps the swap off other screens and hands out less.** `FLAG_SECURE` (no
  screenshots, no recents thumbnail), the WebView cache off and cleared with the screen, exactly one
  document served from the APK (`https`, the app's own host, `/index.html`), `https:` hand-offs
  narrowed to a named host list (`remix.ethereum.org`, `arbiscan.io`, `sepolia.arbiscan.io`,
  `mempool.space`), and `android:usesCleartextTraffic="false"` in the manifest - with the cleartext
  rule now written as a network security config that allows plain HTTP to the loopback names only.

`v0.6.3` closes the fourth pass, the one about what the app believes when something is merely
present:

* **A block height is not a question for the quorum.** Arbitrum makes a block every ~250 ms, so two
  honest nodes are almost always a block or two apart; asking them to agree on the head called a
  working chain broken, the probe said the chain did not answer, and Approve refused to start a swap.
  The head is now read from every configured endpoint and the highest answer stands - a stale head
  is a stricter answer, not a disagreement - while `eth_getCode` (whether the escrow exists at all)
  keeps the cross-check.
* **One escrow, one token, one endpoint list per network.** They are stored per network and read
  back with the network that owns them: switching to One and back brings each set back, and a
  mainnet escrow address is never read while Sepolia is selected (nor a private endpoint asked
  about the other chain). The block height, its timestamp and the last escrow record are cleared on
  every switch, because they are true of one chain only. The setting is stored as
  `{net, nets: {testnet, mainnet}}`; a first-version setup that named no network is read as the one
  it was written under.
* **A BOLT12 invoice is refused, with the reason.** `lni1` carries a Schnorr signature over a merkle
  root of its own TLVs, and this page verifies BOLT11 signatures only - taking one would mean
  locking money behind terms nobody checked. The refusal says so in plain words and asks for an
  ordinary Lightning invoice, which the page does check. The decoder also requires the invoice's
  creation time (TLV 164) and expiry (166), so a missing 164 can never read as an invoice that never
  ends and slip past the window checks.
* **The app's own host is a page only under https.** A navigation to that host under any other
  scheme is refused instead of being kept in the WebView, and `MIXED_CONTENT_NEVER_ALLOW` is set
  explicitly: the one document the shell serves cannot be joined by anything fetched over plain
  http.
* **Nothing of a swap goes into the instance state.** `saveState`/`restoreState` are gone; a
  recreated screen starts from the form instead of reading back an invoice, a USDT address or a
  running swap from a Bundle the system may keep for a long time.
* **A release APK is signed with the release key, or it is not built.** `signingConfigs.release`
  reads `CLEANSWAP_KEYSTORE`, `CLEANSWAP_KEYSTORE_PASSWORD`, `CLEANSWAP_KEY_ALIAS` and
  `CLEANSWAP_KEY_PASSWORD` from the environment or from `android/keystore.properties`, and a task
  that packages a release stops with a message naming what is missing rather than producing an APK
  signed with a debug key - which installs, but can never update a released one. Debug builds, lint
  and the tests never touch it.
* **The tracked CI workflow builds that signed release.** `android/ci/build-apk.yml` had
  `working-directory:android` (a YAML value that needed its space), built `assembleDebug`, and
  collected the debug APK; it now writes the keystore from `CLEANSWAP_KEYSTORE_BASE64`, assembles
  `release`, collects the signed file and checks its certificate before uploading it.

`v0.6.4` is the pass that asks what arrives in another shape:

* **Two route hints are not two invoices.** BOLT11 lets `r` (route hint) and `f` (fallback address)
  repeat - Phoenix, Breez and Zeus all send several - so the decoder accumulates those two and reads
  every hint hop by hop, while a field that states one term (`p`, `h`, `n`, `x`, `d`, `c`) still may
  appear only once, and two of them are still refused by name.
* **The quorum compares what the money depends on.** Two honest nodes return the same receipt with
  its keys in another order, with Arbitrum's own fields (`l1BlockNumber`, `gasUsedForL1`) and with
  `0x01` where the other node wrote `0x1`; comparing raw JSON called that a disagreement, and a swap
  stopped on a chain that was working. A receipt is now compared by its status, its block, its
  sender and receiver and its logs' address/topics/data, a transaction by its hash, from, to, value
  and input, and a call's answer as the bytes it is. A shape the page does not recognise is still
  compared whole, so nothing becomes a match merely by being unexpected.
* **The `Locked` event names the address that funded the escrow.** With a smart contract wallet (a
  Safe, an account-abstraction wallet) `msg.sender` is the contract, while `tx.from` is only the key
  or bundler that relayed the transaction - so the swap id was built from an address that never
  funded anything and the escrow was never found. The sender is now read from the escrow's own
  `Locked` event (`topics[2]`), and only an event that carries this swap's terms, token, amount and
  window is accepted; a receipt that carries no log at all falls back to the transaction's sender.
* **An address is checked against its own spelling.** A `0x` address written in mixed case has to
  match EIP-55 - keccak-256 over its lower-case hex, with the capitals where the digest says so - so
  one replaced or mistyped character is refused with a plain sentence instead of being locked money
  against. All-lower and all-upper addresses are still accepted, as the standard allows, and the
  same check covers the USDT address, the escrow and the token in Setup.
* **USDT from another wallet is two calls, and the screen offers both.** The token has to allow the
  escrow the amount before the lock can pull it, so a wallet outside the page now gets an `approve`
  call (copyable, and as an EIP-681 `ethereum:` link) beside the lock call, in the order the token
  needs them. EIP-681 `bytes32` parameters carry their `0x` prefix like the address and `uint256`
  ones do.
* **No code is made before the rate is known.** `Share code` and `QR` refuse while the BTC/USD
  quote has not arrived, instead of writing `u:"0"` into a code the other phone would have to
  refuse.

`v0.6.5` is the pass that asks what a stranger's terms are worth, and what an address is:

* **A lock read back without a code no longer shows a chain error.** On the side that sends
  bitcoin, the swap terms normally arrive in the partner's `cleanswap:` code. Reading the partner's
  lock transaction back before any code was loaded used to read the escrow with a missing window,
  throw inside `BigInt(null)`, and put up a chain-connection error that had nothing to do with the
  chain. The terms are now read back out of the lock itself: the escrow's own `Locked` event names
  the window, a plain wallet's lock call states it in its calldata, and the hashlock and receiver
  the fit check just verified against the screen's invoice and address carry into the swap. A lock
  against a different hash is refused by name, and when nothing on chain says what the terms are,
  the screen says the swap code is missing - not that the chain is down.
* **A code far off the market is said out loud.** The rate is the one term a stranger wrote that
  the money follows, so when a code is read its implied price (token units per whole bitcoin) is
  compared with the live BTC/USD quote, and a code sitting more than 10% off says so on the screen
  while it is still only terms - the swap still runs, because a partner may quote their own spread,
  but nobody pays without knowing. A warning is never computed against the fallback quote, which is
  a guess the page made, not a price.
* **An address with code is not yet the escrow.** The probe used to stop at "some code is there",
  which any contract passes. It now asks the escrow's own view function: `swaps(id)` on an id nobody
  locked reads back as eight zeroed words on the real contract, and anything else - a revert, a
  short answer, some other shape - is some other contract wearing the address, refused on the chain
  line as `not the swap contract` and by `Approve` before anything is signed. A disagreement between
  endpoints on that reading is not a verdict about the contract; the reading below refuses the swap
  on it instead.
* **Plain HTTP reaches this phone only.** The shell refused cleartext everywhere, which also shut
  out a private RPC node on the device itself. A network security config now allows cleartext to
  the loopback names only (`localhost`, `127.0.0.1`, no subdomains, no wildcard) and keeps
  `cleartextTrafficPermitted="false"` for every other host, so the escrow and the quote stay
  https-only while a local node can still be pointed at in Setup.
* **The release CI note says what a secret alone does not do.** `android/ci/build-apk.yml` states
  that adding the four signing secrets is not enough on its own: the automation cannot write
  `.github/workflows/`, so the file still has to be pasted there by hand before a push builds a
  signed release APK.

`v0.6.6` is the state pass, from a sixth review: four ways a swap could be built out of something
that does not belong to it.

* **A tap is one operation.** `Approve` reads the chain before it opens a swap, and a second tap in
  that gap used to read the terms again and start a second swap on the same money; the wallet path
  had the same hole for the approval and the lock, and a claim could be sent twice. Every tap that
  can move money now marks its operation in flight and refuses the next one before anything is
  built or sent: the second tap says so on screen, and nothing else happens.
* **Back leaves the last swap behind.** Back keeps the terms on the form - that is what it is for -
  but the window a code set, the hash it pinned, the address the escrow saw and the transaction
  that locked it belonged to the swap that just ended. Carried into the next one they would pin a
  hash nobody will pay, approve against a window that is half gone, or build the next swap's id
  from the last one's funder. Back clears all four, so the next swap starts from its own terms.
* **Zero is not an amount.** The USDT figure comes from the BTC/USD quote, and before the quote
  lands it is unknown, not zero. `Approve` now refuses with "the rate has not loaded", so a tap in
  the first seconds cannot lock 0 USDT while the bitcoin leg still leaves.
* **Two endpoints that disagree are not an escrow that is ready.** When the probe's `swaps(id)`
  reading came back as a disagreement between endpoints, it was shown as `escrow ready` with a
  live dot, while the reading below refused the swap. The disagreement is now a state of its own:
  the chain line says `endpoints disagree`, the setup panel says the escrow is not read as ready,
  and `Approve` names it and approves nothing.

`v0.6.7` is the seventh review, and it is about things being counted and read exactly once - one
URL counted once, one chain read at the moment of signing, one swap leaving nothing behind, one
secret that never leaves the page.

* **The same RPC URL typed twice is one endpoint.** Setup takes several endpoints as a cross-check:
  the escrow is believed only when two of them answer the same thing. But the list was counted as
  typed, so one URL entered twice - padded with a space, a trailing slash, or spelled in another
  case - answered twice, and one node could stand in for two and decide what the escrow says. The
  list is now deduplicated on the trimmed, lower-cased address with the trailing slash dropped;
  one node is one answer, and the screen still says when a reading was not cross-checked.
* **The chain is read again at the moment of signing.** Asking a wallet to switch networks and
  signing are two moments, and a person can change networks in between: the same calldata on
  another chain is a call to whatever contract holds that address there. Every wallet send now
  reads `eth_chainId` immediately before `eth_sendTransaction` - the approval, and the lock again
  on its own - and a wallet that has moved refuses the send with a sentence that says to switch
  back, instead of locking the USDT on the wrong chain.
* **An approve that never started a swap leaves nothing of itself behind.** Approve puts the terms
  together in steps - the window, then the invoice, the address, the amount - and a refusal in the
  middle used to leave half of it: a window with nothing locked under it, an amount with no
  invoice, a hash no invoice names. The tap's own terms are now dropped on refusal, so the next
  tap builds from what it finds; the terms a code brought stay, and a tap that is only waiting for
  the partner to lock keeps the terms both sides are converging on.
* **A stale gate answer never paints over newer input.** The gate reads the chain, so its answer
  comes home after the keystroke that asked for it; a validation that was still on the chain when
  newer input arrived could return and overwrite the gate with the older invoice's verdict. Each
  read now carries a generation token, and the stale one is dropped.
* **The window the page shares with its host no longer carries the payment secret.** The page
  exposes a verification surface for the host shell and the suites; the state is shared as a view
  that answers everything the suites watch - except `secret`, the 32 bytes that open the escrow
  leg, which the page holds and the window never sees.
* **The escrow refuses a token that is not a token, and says why.** `lock` now refuses an address
  with no code (`TokenHasNoCode`), and a rebasing token that shrinks a balance between the escrow's
  two reads is refused with `BalanceShrank` - its own error, instead of the subtraction's
  arithmetic panic. (The escrow already deployed on Arbitrum Sepolia keeps its old bytecode; these
  gates exist in every deployment made from this source.)

`v0.6.8` is the eighth review, and it is about a price that arrives late and the terms it quietly
decided - what a code is worth when the quote lands after it, and what may be locked while there is
no quote at all.

* **A code read before the quote is checked again when the quote lands.** The code in the address bar
  is applied at boot, and the price arrives a moment later; the 10% check against the market then had
  nothing to compare against, so a code quoting its own spread was loaded with no warning at all. The
  amounts a code put on screen are kept, and the check runs again the moment a live quote arrives -
  on the screen and in the log - before anything can be paid.
* **No live quote, no wallet swap.** When the price feed did not answer, the USDT amount came from
  `FALLBACK_PRICE`, a guess this page made, and a wallet swap would have locked real USDT at that
  guess. `Approve`, the lock screen's wallet send and the lock call itself now refuse while the price
  is the offline guess, say why, and read the price again; Practice, which rehearses on a stand-in
  escrow, keeps running.
* **A flip and a new amount are new swaps.** Switching the direction or tapping another sats preset
  kept the code's window, the hash it pinned and the address that funds the escrow, so the next swap
  would have been locked under a window chosen for the other direction, against a hash this side is
  not paying. Both taps now clear the code's terms - and the address the code wrote into the field -
  and the log says so.
* **Every poll of a running swap reads the chain's clock.** A chain-time reading is only good for 45
  seconds, so a swap that ran longer quietly measured its window against the phone's clock. Each poll
  now asks the chain for its time before it reads the escrow, and the window closes when the chain
  says it does.
* **A test-chain swap may be paid with a test-chain invoice.** The invoice's network prefix was fixed
  to mainnet, so a phone set to Sepolia refused the `lntb` invoice its partner could actually pay
  there. A Sepolia escrow now takes `lnbc` and `lntb` (and `bcrt`), while an Arbitrum One escrow -
  real USDT - takes a mainnet invoice only and says why when handed a testnet one.
* **The escrow pulls the token before it writes the swap.** `lock()` wrote `swaps[swapId]` and then
  moved the token; a token that calls back mid-transfer now finds no record under the id it is
  funding, so the stored record can never describe money that has not arrived. Recompiled, and the
  py-evm suite proves it from inside the transfer. (The escrow deployed on Arbitrum Sepolia keeps its
  old bytecode until it is redeployed; the ordering is in every deployment made from this source.)

`v0.6.9` is the ninth review, and it is about two places where the page took a name for an answer -
whatever address was typed as the token, and a payment secret left over from the swap before - plus
a test that was reading a workflow file the runner never ran.

* **A token is asked two questions before Setup keeps it.** Any address is an address; a token is an
  address with code and a count of decimals. Setup used to take whatever was typed, while every
  amount in the page is written in millionths - so a seven-decimal token would have moved a tenth of
  what the screen said. Save now asks the chain whether code lives at that address and what
  `decimals()` answers, and refuses a token with no code, one that does not answer the question, or
  one that counts in anything but six, naming the count it got. A chain that does not answer is not
  a verdict: the setup is kept, marked unread, and the panel says so until Check can read it.
* **A token stored before this page asked is read again with the chain.** A setup saved by an older
  build is still on a phone, so every probe - the one a network switch runs, and Check - reads the
  token beside the escrow and marks a six-decimal answer as the only one a wallet swap may count in.
  Approve refuses a setup whose token came back wrong, with the sentence saying to set the right one.
* **A finished swap keeps no secret.** `settleByChain()` and `backToForm()` ended a swap but left the
  payment secret in the page and in the claim field, so the next swap's screen still held the last
  one's preimage. Both now clear the state and the field - as a refund and a reset already did - so
  the only secret on the phone is the one the running swap's own wallet showed.
* **The shell test reads the workflow GitHub runs.** `test/android-shell.py` checked
  `android/ci/build-apk.yml`, a copy kept in the tree because a push cannot write `.github/workflows/`
  - so it proved things about a file no runner ran, while the live workflow built a debug APK. The
  test now reads `.github/workflows/apk.yml`, states which variant that file packages, refuses a
  debug workflow that claims a release signature, and checks the signed-release workflow kept ready
  at `android/ci/apk-release.yml` (release variant, keystore gate, `apksigner` check, the same
  triggers). The release build type also says `isDebuggable = false` out loud beside its minify and
  shrink flags instead of leaving it to the default.

`v0.6.10` is the tenth review, and it is about **which deadline comes first**. Two timelocks hold one
swap - the bitcoin payment and the USDT escrow - and only one order of them is safe.

* **The payment has to outlive the escrow, and the invoice says for how long.** A BOLT11 invoice
  states the final delta its payee's node keeps the incoming payment (`c`, `min_final_cltv_expiry`;
  18 blocks when the tag is absent). The escrow window has to close before that payment does, with
  an hour left for the side settling with the revealed secret - otherwise the sats can come back
  while the USDT is still claimable, and one secret collects both legs. `windowProblem` now refuses
  such an invoice with a sentence that names both spans, and `I paid` reads the same question again
  on the tap. The `c` tag and the route hints are decoded with the rest of the terms, and a sample
  invoice can state them the way a real one does.
* **A code from another app asks before it replaces anything.** A `cleanswap:` code arriving from a
  scanner, a message or the camera used to write its terms, its direction and its USDT address
  straight over the screen. Now a code that would replace what is there waits with one sentence and
  two buttons (`Load the code` / `Keep this one`), and nothing moves until one is pressed. A screen
  with nothing on it still takes a code directly, so a link tapped on a fresh screen is one tap.
* **The clock is what the endpoints agree on.** The chain clock used to be the highest head any
  configured node gave, so one node an hour - or a decade - ahead could close a window that an
  honest chain had open. It is now the median of the answers that agree with each other within five
  minutes, a lone answer is not a majority, and a head more than a day from this phone's clock is a
  mistake rather than a clock. With one endpoint configured, that endpoint is still its own answer,
  as it is for the escrow.
* **A claim holds its tap until the transaction answers.** `doClaim()` and `doRefund()` built the
  call and then let the operation lock go, so a second tap could send a second claim while the
  first was still in the wallet. Both now return the wallet's promise: the lock is released when the
  receipt lands, not when the call was built. Back also clears the hash, the agreed USDT amount and
  the funding address a code named, and the mode switch is **refused** while a real swap is running
  - a rehearsal can be left behind, locked USDT cannot.
* **The shell serves one document and nothing else.** Any path on the app's own host that is not
  `/index.html` is answered with an empty `404` inside that origin instead of falling through to
  the network, and the page counts as ready - the moment a pending code is handed over - only when
  `APP_URL` itself has finished. `MIN_TIMELOCK_DELTA` in the escrow is now **30 minutes**, the same
  floor the app puts on a window (`T2_MIN`), so no window that reaches a wallet is one the contract
  refuses at the door; the bytecode beside the source was recompiled and the py-evm suite proves
  the floor.
* **The two calls that close a swap also open in a wallet.** A swap that sends the USDT keeps
  `Share code` and `QR` on screen while the USDT sits in the escrow - the partner still needs those
  terms - and the `claim` and `refund` calls are offered as EIP-681 `ethereum:` links beside the
  copy buttons when no wallet lives in the page, so a phone with a wallet app can finish the swap
  without a desktop.

`v0.6.11` is the completeness pass: a swap that survives the page being killed, a window that
carries nothing but the one entry the shell needs, a rate no single API can decide, and a source
tree in modules instead of one 4,746-line file.

* **A swap outlives the page.** An external wallet is another app: the phone switches to it, and
  while it is in front Android may kill this WebView. The terms of a running swap - its id, hash,
  window, amount, addresses and transaction hashes - are now put away in one `localStorage` key
  (`cleanswap.swap.v1`) before a wallet can take the app away, and read back at boot: the page opens
  in Wallet mode on the same swap, with the fields filled and the chain read once, so a claim or a
  refund that landed meanwhile closes it. **The payment secret is never written** - it is not part
  of the terms, it is the money - so a recovered page can read the escrow and refund, but it cannot
  claim with a secret it does not have. A record is removed the moment its swap settles, refunds,
  goes Back or resets, is not acted on for another network or another escrow, and is dropped after
  30 days. A practice swap is never written: its escrow died with the page.
* **The window carries one entry.** The shipped page (`dist/`, the APK, the download) exposes
  `window.CLEANSWAP = { acceptCode }` and nothing else - no state object to read a swap out of, no
  action to drive a claim with. The verification handle moved to a test build (`build.py --test`,
  `build/cleanswap.test.html`), which is not shipped and not staged into the APK; the build is the
  same page with one different module (`bridge-test.js` instead of `bridge-prod.js`), so what is
  tested is what ships minus the handle.
* **A price is two quotes.** The BTC/USD rate now comes from `mempool.space` and Coinbase at the
  same time: two answers within 2% are one live rate (the mean of the two), one answer is a real
  quote the rate line marks as not cross-checked (and a wallet swap may still use it), two answers
  further apart are **not a rate** - the screen shows none and a wallet swap is refused with its own
  sentence - and no answer at all leaves the offline guess that no real USDT is locked against.
* **The gate waits for the token the chain counted.** `validateNow()` now approves a wallet swap
  only when `tokenState === 'ok'`. "Not read yet" and "the chain did not answer" were silence, and
  silence was being read as a yes; a tap that finds the token unread reads it once and then asks the
  gate again, so a fresh page still approves in one tap - but only on a token the chain confirmed.
* **A lock with no event names no funder.** `loadTx()` no longer falls back to the transaction's
  own sender when a receipt carries no `Locked` event: `tx.from` is the key or bundler that relayed
  the call, not the address the escrow saw, so a lock is read from the escrow's event and from
  nothing else. A receipt without it is refused with the sentence it already had.
* **One file, built from modules.** `src/app.js` was 4,746 lines; it is now the header and the
  wrapper, and the app is thirteen modules under `src/modules/` by responsibility - core, storage,
  chain, wallet, crypto, swap, gate, render, actions, price, ui, boot, bridge. `build.py` inlines
  them in order inside one closure, so the artifact is still a single HTML file with one inline
  script and the same hash-pinned CSP.
* **The workflow builds a signed release, pinned.** There is one APK workflow, and it assembles
  `release` - no `assembleDebug` anywhere - writes the keystore from
  `CLEANSWAP_KEYSTORE_BASE64` and stops before any APK exists when that is missing, checks the
  certificate with `apksigner`, and runs every action from a full commit SHA with the release it
  came from beside it. The app's automation has no `workflows` permission, so the file GitHub reads
  can only be replaced by hand: the maintained copy is `android/ci/apk-release.yml`, identical to
  the one meant for `.github/workflows/apk.yml`, and the shell test says out loud when the two
  differ.
* **The next milestone is designed, not faked.** `docs/walletconnect-nwc.md` sets out WalletConnect
  v2 (EIP-1193) for the USDT leg and NWC (NIP-47) for the Lightning leg - session shape, pairing,
  what is stored, what is refused, why a hold invoice is the only invoice NWC may make, and the
  tests each milestone owes. **No button for either is in the app yet**: the screen keeps its shape
  until a session works end to end.

`versionCode 20`, `versionName 0.6.11`.

## What it does

* **The same three steps as ever.** `1 Partner's Lightning invoice` (a hold invoice that states its
  payment hash) -> `2 Your USDT address` (the `0x...` that receives the
  USDT on Arbitrum) -> `3 Approve`. Practice and Wallet build the same screen from the same markup;
  a rehearsal cannot teach a different flow than the real thing. The direction flip still reverses
  the steps, `Sample` still exists in Practice and nowhere else.
* **The chain is the referee, and it is asked twice.** The escrow is read with
  `eth_call swaps(swapId)` against Arbitrum's public endpoints (`sepolia-rollup.arbitrum.io/rpc`
  and `arbitrum-sepolia-rpc.publicnode.com` for Sepolia, `arb1.arbitrum.io/rpc` and
  `arbitrum-one-rpc.publicnode.com` for One), with `eth_blockNumber` and `eth_getCode` as the check
  that the endpoint and the contract are really there before anything is approved, and
  `eth_getTransactionReceipt` for a transaction a wallet sent. With two or more endpoints, a state
  that money depends on is believed only when two of them answer the same thing.
* **The swap id is the terms plus the funding address.** `swapId = sha256(abi.encodePacked(hashlock,
  sender, receiver, token, amount, timelock))`. The side that funds the escrow knows the id from its
  own wallet; the other side gets the address from the funding side's code, or from the lock
  transaction itself (its `Locked` event names the sender, so a smart contract wallet is read as
  the address that funded it). A record found under the id is compared
  field by field - hashlock, sender, receiver, token, amount, timelock - before it is believed.
* **The verdict comes in plain English.** `swaps(id)` returns the whole record; the app compares it
  against the terms on screen (hashlock, receiver, token, amount, timelock) and says one of: nothing
  locked yet / holds your X USDT until the swap closes or the window ends / paid out / sent back /
  not the agreed swap. A record that disagrees with the terms on screen is refused, not guessed
  about.
* **Nothing completes on a tap - in either mode.** In Wallet mode `Approve` is refused outright
  while the USDT is not in the escrow; once the chain says `locked`, the screen waits for the
  bitcoin payment; `I paid` starts a watch on the escrow (12 s poll) and **nothing** - not
  `I paid`, not `Check chain`, not a reload - closes the swap before the contract says `claimed`.
  A refunded record closes it as refunded, and the receipt says so. Practice runs the same
  sequence: `Approve` -> **Waiting for payment** -> `I paid` -> the same reading -> **Swap
  complete**, against the stand-in escrow, at rehearsal speed (a lock and a claim land a moment
  after the tap rather than waiting for a partner).
* **Signing stays in your wallet.** The app holds no key and never asks for one. With a wallet in
  the page (`window.ethereum`, EIP-1193 - an injected browser wallet) the approve/lock/claim/refund
  calls are sent from it, the USDT allowance is checked and an `approve` is requested only when it
  is short. Without one, the exact call (`to`, `data`, `chainId`) is copied as text for another
  wallet app, or opened as an **EIP-681** `ethereum:...` link, and the transaction hash is pasted
  back - the app reads the receipt itself and still judges only what the escrow says.
* **Setup is one panel, used once.** The chain line at the top (Arbitrum Sepolia / Arbitrum One)
  opens it: the escrow contract address, the USDT token address, optional RPC endpoints
  (comma-separated; more than one means a cross-check). With no contract set, the panel offers the
  deploy hand-off: **Copy bytecode** (solc 0.8.26 creation code, embedded in the page) and **Open
  Remix**. The setup survives in `localStorage` under one key, one escrow, token and endpoint list
  for each network, and nothing but this panel ever writes it.
* **Only a signed, priced invoice with a payment hash is accepted.** A BOLT11 hold invoice
  (`lnbc...`) that carries the standard `payment_hash` field and a signature the page verifies; its
  amount has to be stated (see `v0.6.2`). A BOLT12 invoice (`lni1...`) is decoded and refused, because
  its Schnorr signature is not one this page verifies (see `v0.6.3`); a BOLT12 offer (`lno1...`) is
  refused with a sentence and an explanation, because the invoice it produces gets a hash of its own
  (see below).
* **The terms leave as a code, not as a web address.** `Share code` copies `cleanswap:...`
  (base64url JSON: both amounts, the window, the hashlock, the USDT address, and in Wallet mode the
  chain, the escrow and the address that funds it - still under the 340-byte QR budget, because the
  hashes and addresses inside are packed as bytes). No host, no path, no name, nothing taken from
  `location.href`.
* **`<- Back` from a running or finished swap** returns to the filled-in form; a swap nobody paid
  is not quietly settled by leaving it.

## The three steps

| Step | On screen | What is checked before `Approve` moves |
| --- | --- | --- |
| 1 | the Lightning invoice - `Open in wallet`, `Copy`, `QR` in both modes, `Sample` in Practice only | bech32 checksum, a `payment_hash` present and stated once (an offer is refused: it has none), the payee's signature verified, an amount stated and equal to the swap, not expired, `bc` network, an expiry at least an hour past the escrow window, and - when a code arrived first - a hash equal to the one that code pinned |
| 2 | the USDT address | an Arbitrum `0x` address with exactly 40 hex characters, not the zero address, and a mixed-case one has to match its EIP-55 spelling (all-lower and all-upper pass). In Wallet mode a TRON `T` address is decoded and checked, then refused with the reason: this swap pays on Arbitrum |
| 3 | `Approve` | the two are bound to one `H`, the window is neither too short nor too long, and in Wallet mode the chain is asked before anything else happens: endpoints alive and agreeing, contract deployed, escrow state for `swapId` |

Anything refused is named in plain English and never in jargon, and the hidden log keeps the decoded
fields for a support question.

## Wallet mode - the real escrow

<p align="center">
  <img src="docs/wallet.png" width="360" alt="CleanSwap wallet mode: invoice, address, approve">
</p>

A swap in Wallet mode runs on the chain, and every step that touches USDT has the contract behind it:

1. **You send bitcoin** (`btc2u`): the *partner* locks the USDT first. `Approve` reads the escrow;
   nothing there (or a record for different terms) stops the swap with a sentence. Once the chain
   says `locked`, the screen becomes **Waiting for payment**: the invoice, `Open in wallet` /
   `Copy` / `QR`, and `I paid` below.
2. **`I paid` starts the watch.** The screen changes to **Paid, waiting for the USDT** and polls the
   escrow every 12 s. When your partner reveals the secret R in a `claim`, the record flips to
   `claimed` and the swap closes - on the chain's word, not yours. `Check chain` reads it sooner;
   `Paste tx` takes a transaction hash instead.
3. **You send USDT** (`u2b`): `Approve` builds the `lock()` call from the terms on screen. With a
   wallet in the page, the allowance is checked first and the approve + lock are sent from it;
   without one, `Copy call` / the `ethereum:` link carry the call to another wallet and `Paste tx`
   brings the hash back. The app reads the receipt, then the record: only `locked` moves the swap
   to waiting, only `claimed` completes it.
4. **The window runs out**: the refund button appears for your side of the escrow, and a record
   that says `refunded` closes the swap as **Swap closed**, with the receipt saying the USDT went
   back.

<p align="center">
  <img src="docs/paying.png" width="360" alt="CleanSwap in Wallet mode: waiting for the payment, escrow state underneath">
</p>

Completed swaps land as one-line entries under **Recent**, and the receipt names the chain it
settled on (`Arbitrum Sepolia · paid on chain`).

**Practice mode** runs the identical screen, gates and readings against an in-page stand-in for the
escrow: the same `swaps(id)` record shape, the same classifier, the same sentences, the same
**Waiting for payment** / `I paid` / **Paid, waiting for the USDT** screens. The chain line at the
top names Arbitrum Sepolia and the stand-in escrow, so nothing has to be deployed to rehearse. The
receipt says `Practice · simulated`. A rehearsal is never written to Recent.

---

## On-chain architecture (Arbitrum Sepolia / Arbitrum One)

```
   bitcoin leg (Lightning)                    USDT leg (Arbitrum)
   -------------------------                  -------------------------
   invoice, payment_hash H          <------>  CleanSwapHTLC.lock(H, T2, receiver, token, amount)
   paid by the BTC payer                      swapId = sha256(H ‖ sender ‖ receiver ‖ token ‖ amount ‖ T2)
            |                                          |
            |  the same 32-byte secret R               |  claimed: swapId, R
            v                                          v
   whoever holds R settles both         CleanSwapHTLC.claim(swapId, R): sha256(R)==H,
   (reveal R in the claim)              USDT transferFrom escrow to receiver, Claimed(R)

   timeout path:            CleanSwapHTLC.refund(swapId) after T2 - tokens back to the sender
   app's view of it all:    eth_call swaps(swapId) - 8 words: hashlock, amount, timelock,
                            token, sender, receiver, claimed, refunded
```

* **The swap id is computed off the terms and the funding address.** Both phones compute
  `sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock))`. The funding side
  knows `sender` from its wallet and puts it in its code; the other side learns it from that code or
  from the lock transaction. The `sender` is what stops a third party from locking the same terms
  first and refunding them later: with a different sender they get a different id, and the real lock
  is unaffected.
* **Arbitrum parameters.** Sepolia test chain id `421614` (`0x66eee`), One mainnet chain id
  `42161` (`0xa4b1`). Both are offered in Setup, Sepolia by default; the mainnet token is the
  6-decimal USDT at `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` (the app also reads `decimals()`
  semantics at 6 and shows the USDT amount the way a wallet does).
* **Public endpoints, cross-checked.** Sepolia: `sepolia-rollup.arbitrum.io/rpc` and
  `arbitrum-sepolia-rpc.publicnode.com`. One: `arb1.arbitrum.io/rpc` and
  `arbitrum-one-rpc.publicnode.com`. Endpoints typed in Setup replace them all - a person who runs
  their own node did not ask for a public one to be asked instead, and one endpoint is its own
  answer. With more than one, `swaps(id)`, `eth_blockNumber` and `eth_getCode` are asked of all of
  them and believed only when two agree; otherwise the screen says the endpoints disagree and
  nothing is approved. A failed request walks to the next endpoint for the calls that are not part
  of that cross-check.
* **No key ever enters the app.** EIP-1193 injection (`window.ethereum`) sends what the page cannot
  sign; everything else is a copy/link/paste hand-off. The app reads, computes and judges; the
  wallet signs.
* **`contracts/CleanSwapHTLC.sol`** - `^0.8.26`, custom errors, packed struct, one slot of
  booleans, checks-effects-interactions, no owner, no fees, no proxy. `lock` pulls the token via a
  checked `transferFrom`, `claim` reveals R and pays the receiver, `refund` returns to the sender
  after `timelock`; `swaps(swapId)` is the public getter the app reads; `computeSwapId(...)` mirrors
  the app's own packed SHA-256. Token movement goes through `_safeTransfer`/`_safeTransferFrom`:
  a token that returns no bool is accepted, and any transfer whose actual balance movement is not
  the agreed amount reverts (`TransferAmountMismatch`). Events: `Locked`, `Claimed` (with R in the
  clear), `Refunded`. `contracts/TestUSDT.sol` is a throwaway 6-decimal ERC-20 with `faucet()` for
  Sepolia, beside `FeeUSDT` (1% on every transfer) and `QuietUSDT` (returns no bool) for the tests.
* **Timelock bounds are the safety margin**: the contract refuses a timelock closer than
  `MIN_TIMELOCK_DELTA` (5 minutes) so a refund cannot race a claim, and one further than
  `MAX_TIMELOCK_DELTA` (7 days) so the funding side's money cannot be parked for a season. The app
  applies the same floor and ceiling before it lets anyone approve, and refuses an invoice that does
  not stay payable at least an hour past the window.

### Lightning side: a payment hash or nothing

One reader parses everything - `lno1…` (BOLT12 offer), `lni1…` (BOLT12 invoice), `lnbc…`/`lntb…`
(BOLT11), with or without the `lightning:` prefix - and the swap gate accepts only a string that
states its own payment hash.

* **BOLT11 encode** (`lnbc…`) — hold invoices: bech32 checksum, 35-bit timestamp, `p`/`d`/`x`
  tagged fields, a 65-byte signature slot, `payment_hash = H`, and an expiry that has to outlive the
  escrow window.
* **BOLT12 invoices** (`lni1…`) are decoded - `invoice_payment_hash` (TLV 168), amount (170),
  creation time (164), expiry (166) - and then **refused**: their Schnorr signature is not one this
  page verifies, so the refusal asks for an ordinary Lightning invoice, which is. The app's own
  type-80 tag is reported separately and is never mistaken for the payment hash. An invoice with no
  creation time or no expiry is refused at the decoder rather than read as one that never ends.
* **BOLT12 offers** (`lno1…`) are recognised and **refused**. An offer cannot carry a payment hash,
  and the invoice a wallet gets for it is built by the payee's node with a fresh random hash, so
  hashing the offer's own bytes would lock the USDT to a hash no Lightning payment ever moves. The
  refusal says what to ask for instead: a hold invoice made for this swap.
* Wallet hand-off: `lightning:<invoice>` deep link, one-tap copy, and a locally generated QR
  (own encoder, byte mode, EC level M — falling back to L for long requests — versions 1–13).

> Honest limit: invoices the app mints carry deterministic filler signatures; they parse, checksum
> and hash correctly, but no node will route them. They exist to exercise the gate and the screen.

### What the screen deliberately hides

The verification did not get weaker, it moved out of sight. The hidden event log (`#log`) records
every decoded field, hash comparison and refusal for a support question. Addresses, hashes and
selectors appear only where the person swapping needs none of them: the Setup panel (deploy), the
copied call (wallet hand-off) and the log.

---

## Repository layout

```
ln-usdt-swap.html            built single-file app (also dist/cleanswap.html)
build.py                     src/ -> single file (+ the APK asset); refuses to emit Hangul;
                             compiles the escrow and embeds its creation bytecode
src/
  index.template.html        screen markup: two cards, three steps, one Approve bar, the setup panel
  app.css                    dark forest theme (obsidian green, mint accents), fixed action bar, mobile-first
  app.js                     the header and the wrapper: the modules below are spliced in here
  modules/
    core.js                  constants, the state object, hashing (sha256, keccak, secp256k1 helpers),
                             formatting, the on-screen log
    storage.js               the setup per network, and the swap record a killed page picks up again
    chain.js                 the swap id, endpoints, the quorum, the chain clock, escrow ABI and reads
    wallet.js                an EIP-1193 wallet, the calls it sends, claim, refund, a pasted receipt
    crypto.js                secp256k1, bech32, the BOLT11 / BOLT12 codecs
    swap.js                  escrow calldata, the swap code, the inputs it is read from
    gate.js                  the one gate a tap has to pass
    render.js                the three-step screen and the gate under it
    actions.js               what a tap does, the rehearsal escrow, codes arriving, the QR
    price.js                 the BTC/USD quote, cross-checked between two public APIs
    ui.js                    the setup panel, the event wiring and the ACT table
    boot.js                  wiring the page and starting it
    bridge-prod.js           the shipped window handle: acceptCode, and nothing else
    bridge-test.js           the test build's handle (build.py --test; never in a shipped page)
  qr.js                      dependency-free QR encoder (byte mode, 1-13, L/M/Q/H)
contracts/
  CleanSwapHTLC.sol          sha256 hashlock, ERC-20 escrow, timelock refund, swaps(id) getter
  CleanSwapHTLC.bin          creation bytecode, checked against the source by the build and the tests
  TestUSDT.sol               6-decimal faucet token, plus FeeUSDT, QuietUSDT and ReentrantUSDT for the escrow tests
docs/                        icon and screens, and the WalletConnect / NWC design for the next
                             milestone (walletconnect-nwc.md)
tools/                       invoice minting, icons, QR and doc-shot helpers
test/
  headless.js                Playwright end-to-end suite, with a mock JSON-RPC endpoint on 127.0.0.1
  contract-evm.py            contract behaviour on py-evm + the page's ABI against eth_abi
  qr-crosscheck.py           QR matrices vs python-qrcode (64 fixed-mask matrices)
  invoice-crosscheck.py      minted invoices vs an independent BOLT11 decoder + secp256k1/OpenSSL
  android-shell.py           the shell's own promises: FLAG_SECURE, no cache, no instance state,
                             one https document, mixed content off, release signing fail-closed
  verify-english.py          Hangul must be 0 in every text file, path and commit
  run-all.sh                 everything above with the right env
android/                     WebView wrapper (com.jbitmstr.cleanswap, v0.6.10, versionCode 19)
```

## Build

```bash
python3 build.py           # -> ../ln-usdt-swap.html, dist/cleanswap.html and the APK asset
python3 build.py --test    # -> build/cleanswap.test.html, the same page with the test handle
```

The app is built from `src/modules/` in the order listed in `build.py`, spliced into `src/app.js`
and inlined into one self-contained file. solc 0.8.26 (`.tools/solc-*` or `$SOLC`) compiles the
escrow; its creation bytecode is embedded in the page for the Setup panel's deploy hand-off, and
`contracts/CleanSwapHTLC.bin` is checked against the same source. Network use: the two BTC/USD
quotes (`mempool.space` and Coinbase), and the Arbitrum JSON-RPC reads of the escrow. The build
fails if any source file contains a Hangul character, and the production build refuses to emit a
page with the test handle in it. The test build is the only artifact that carries
`window.CLEANSWAP`'s state and actions; it is not in `dist/` and not staged into the APK.

## Verification & test results

All suites pass on this tree:

| Suite | What it proves | Result |
| --- | --- | --- |
| `test/headless.js` (Playwright + a mock Arbitrum JSON-RPC endpoint on 127.0.0.1) | The three steps in both modes, the flip, invoice and address refusals, BOLT12 offers refused (never bound to a made-up hash), the `cleanswap:` code round trip (chain, escrow and funding address included, still QR-sized), a code that tries to write an escrow, another chain, a 5-minute or 8-day window, or a token amount above 2^53 refused with the setup untouched, a code refused while a swap is running, a code's USDT address offered but not written into the receiving side's field, Practice walking the same road, and the whole wallet flow against real `eth_call` responses: nothing locked -> Approve refused; `locked` -> the payment starts; `I paid` -> watching, no receipt; the chain's own clock past the window -> paying refused; endpoint down -> nothing completes and the line says why; record for another amount -> refused; `claimed` -> the swap completes and the receipt names the chain; the USDT side: the lock call (copy / EIP-681 / ABI shape), an old allowance reset to zero before the exact one, a pasted tx hash read back through `eth_getTransactionReceipt`, a wrong secret refused before any wallet sees it, and a `refunded` record closing the swap as refunded. Plus the review items: BOLT #11's own invoices (a real signature recovered to the spec's key, a duplicate field and an unrecoverable signature refused, an amountless invoice refused, high-S accepted for recovery), a QR drawn element by element whose caption stays text, and a Content-Security-Policy that names the hashes of its own code and refuses a block added afterwards. And the fourth pass: the head read from every endpoint with the highest standing (two nodes nine blocks apart still answer), one escrow, token and endpoint list per network with nothing carried across a switch, and a BOLT12 invoice refused with its creation time and expiry still decoded - and refused at the decoder when either is missing. Plus v0.6.4: a signed invoice with two route hints and two fallback addresses read hop by hop and accepted by the gate, keccak-256 against the known digest and the four addresses EIP-55 prints (a wrong capital refused, all-lower and all-upper kept), two endpoints where one writes every receipt in another shape agreeing through a real lock while a different status, a different log or an unknown shape still disagree, and a lock funded by a smart contract wallet - by a pasted transaction and by a wallet in the page - whose funding address comes from the escrow's Locked event and never from `tx.from`. Plus v0.6.5: a lock read back with no swap code on the phone - the window taken from the escrow's Locked event or the lock call's own calldata, the hash and receiver carried in from the screen they were verified against, a lock against another hash refused, and a lock with nothing knowable told apart from a chain failure by saying the swap code is missing; a code 33% off the live quote warned about while it is still only terms with a code at the market loading silent; an address that answers but is not the escrow refused by name through the probe and through Approve, and reading ready again once it answers like the escrow. Plus v0.6.6: two taps on Approve in one turn of the event loop refused with one set of terms read and one swap started; a tap with no quote refused as "the rate has not loaded" instead of locking 0 USDT, and the same terms ready once the quote is there; Back clearing the last window, the pinned hash, the funder and the lock transaction, so the next invoice is not refused against the swap before and the next swap gets a window of its own; a claim tapped twice sending one claim; and two endpoints that disagree about the escrow left not-ready on the chain line, in the setup panel and on Approve. Plus v0.6.7: the same RPC URL typed twice (padded, re-cased, trailing slash) counted once as one endpoint so one node cannot stand in for two while a second, different endpoint still counts; a wallet that moves to another network between the switch and the signature refused before the approval and again before the lock, with nothing sent and a sentence saying to switch back; an approve refused before the swap leaving no window, hash, amount, invoice or address behind (a tap that is only waiting for the partner's lock keeping the terms both sides converge on); a validation still on the chain when newer input arrives never painting over the newer gate; the payment secret absent from the window by name, by key and by JSON; and the secret the page itself holds after a refused claim still absent from the window. Plus v0.6.8: a code in the address bar taken at boot while the price is still loading, and its check against the market run again the moment a live quote arrives (the warning arrives late, never absent); a wallet swap refused while the price is the offline guess - Approve, the lock screen's wallet send and the lock itself, with no wallet call made - while Practice keeps rehearsing, and the same terms ready once the quote is in; a direction flip and a new sats preset clearing the last code's window, pinned hash, funding address, agreed amount and the address it wrote into the field, with the amount this side picked kept; every poll of a running swap reading the chain's clock again and the poll stopping when the swap is no longer paying; a `lntb` invoice accepted beside a Sepolia escrow and refused by name beside an Arbitrum One one, where a mainnet invoice is what is taken. Plus v0.6.9: a token that counts in eight decimals refused at Save with the count named and nothing of it stored, an address with no code at all refused as a token, a six-decimal token read, accepted and stored, a chain that does not answer keeping the setup but marking the token unread on the panel, a setup stored before this page asked for decimals caught when the next probe reads the token, and the page asking the token for its decimals; a settle and Back each leaving neither the page nor the claim field holding the swap's secret. Plus v0.6.10: the invoice's `c` tag read as the payee's final delta (18 blocks when absent), a six-block invoice refused against a two-hour window with the sentence naming both spans and an ordinary one passing the same window, the `I paid` tap refusing a window the payment cannot outlive, a route hint read hop by hop without being mistaken for the payee's deadline; a code from another app held with a sentence and two buttons, the address and terms on the screen unchanged until `Load the code`, `Keep this one` leaving everything as it was, and a code on an empty screen still taken in one step; a clock read as the median of three endpoints with one of them a decade ahead, that node dropped when it is the only one, and the window it would have closed left open; the terms still shareable while the USDT is locked (with `Use code` gone), the mode switch refused during a real swap, the claim and refund offered as EIP-681 links with the right id and secret, Back clearing the pinned hash, agreed amount and funding address, and a claim's operation lock held until the receipt lands so a refund tapped mid-flight sends nothing. Plus v0.6.11: the shipped page leaving one entry on
the window (`acceptCode`) with no state, no action and no test handle, and that entry still putting a
code on the screen, while the test build is the one that carries the handle; two price quotes that
agree read as one live rate (the mean), one answer read as a quote the line marks as not
cross-checked, two answers 26% apart read as no rate with a tap refused by its own sentence, and
neither answering leaving the guess no wallet swap is priced by; `validateNow()` approving only a
token the chain counted (`ok`), refusing "not read" and "did not answer" by name, and a tap reading
an unread token once before the gate judges it; and a swap put away before a wallet can take the app
away - the record holding the terms and no secret, the page coming back in Wallet mode on the same
swap with its fields filled, the lock it then takes written into the record, a settled swap leaving
nothing behind, Back leaving nothing behind, and a stale record (40 days) or one for another escrow
not acted on | **592/592 pass** |
| `test/contract-evm.py` (solc 0.8.26 + py-evm + eth-abi) | Real bytecode: `lock` escrows and debits, `swaps(id)` returns the 8-word record and eight zero words for an unknown id, `claim` with the right preimage pays the receiver and emits R, double claim reverts, refund before/after the timelock, `computeSwapId` = the id `lock` used (and a different id for another sender), `MIN_TIMELOCK_DELTA` at 30 minutes refusing a timelock one second under it and `MAX_TIMELOCK_DELTA` refusing an 8-day one, a fee-on-transfer token refused and a token that returns no bool accepted, a zero hashlock and a receiver that is the escrow itself refused, a token that re-enters `lock` mid-transfer refused with nothing escrowed (and the same token accepted when its call-back is harmless), an address with no code refused as a token by name (`TokenHasNoCode`) and with its own error rather than a panic, a rebasing token that shrinks the escrow's balance between the two reads refused (`BalanceShrank`) with the escrow's pre-existing balance left whole and no arithmetic panic in the revert data, a token that looks at the escrow from inside its own `transferFrom` finding the swap record still empty and the record there once the money has arrived (`lock` pulls before it writes) - and every selector the page sends equals keccak of the contract signature, the committed bytecode matches the source, and the mock endpoint's answer equals what `eth_abi` encodes for the same record | **58/58 pass** |
| `test/qr-crosscheck.py` | Every module of every mask (0–7) across eight payloads matches `python-qrcode` | **64/64 matrices equal** |
| `test/invoice-crosscheck.py` | Every invoice the app mints parses under an independent Python BOLT11 decoder, its signature is recovered and verified by OpenSSL (`cryptography`), all of them are signed by the one practice key, and the BOLT #11 vectors recover to the spec's key with the signed preimage equal to the hash the spec prints | **79/79 pass** |
| `test/android-shell.py` | `FLAG_SECURE`, no WebView cache and a cleared one, no `saveState`/`restoreState`, one document served (`https`, the app host, `/index.html`, with any other path answered `404` inside that origin and the page ready only for `APP_URL`), the app host only as an https page, `MIXED_CONTENT_NEVER_ALLOW`, an `https` hand-off allowlist with no wildcard, `usesCleartextTraffic="false"` with a network security config that allows plain HTTP to the loopback names only, a release build type that is minified, shrunk and not debuggable and stops without the four signing values, the APK workflow this repository maintains (`android/ci/apk-release.yml`: release variant, no `assembleDebug` anywhere, the keystore gate that stops before any APK exists, the `apksigner` check, every action pinned to a full commit SHA with its release beside it, the same triggers), and whether the file GitHub actually reads is the same file - said out loud when it is not, because the app's automation cannot write workflows | **45/45 pass** |
| `test/verify-english.py` | Hangul count is 0 across every tracked text file, file name and commit message | **0 characters** |

```bash
bash test/run-all.sh      # build + English + headless + shell + EVM + QR + invoices
```

Screenshots of the form, the wallet flow (waiting, paid, settled, refunded), the setup panel, the
blocked form, the lock hand-off and the code QR are written to `shots/v5*-*.png` by the headless
suite.

## Deploying the escrow (once per network)

1. Wallet mode -> the chain line -> **Setup**.
2. Pick the network. **Copy bytecode**, open **Remix**, paste it as one file with the `// SPDX`
   line removed (or paste `contracts/CleanSwapHTLC.sol` from this repository and compile with
   solc 0.8.26), deploy with your wallet - Sepolia for a rehearsal.
3. Copy the deployed address, and the token address (deploy `TestUSDT.sol` on Sepolia and tap its
   `faucet()`; on One it is USDT's own contract), into Setup and **Save**.
4. `Check` reads the chain and tells you the escrow reads like the swap contract. Everything else
   stays on the phone; the other phone learns the address from a `cleanswap:` code.

Each network keeps its own escrow, token and endpoint list: switching the network in Setup shows
that network's set, and nothing typed for one is read while the other is selected.

## Android wrapper

`android/` is a dependency-free `WebView` shell (package `com.jbitmstr.cleanswap`, `versionName
0.6.11`, `versionCode 20`). The shell owns the hand-offs the WebView cannot: `lightning:`, `bitcoin:`
and `ethereum:` links (the EIP-681 call) become an `ACTION_VIEW` intent, so **Open in wallet**
and the escrow call open the installed wallet instead of failing with
`net::ERR_UNKNOWN_URL_SCHEME`; a phone with no such app gets a toast rather than a crash, and the
manifest declares a `<queries>` entry for all three schemes so Android 11+ package visibility does
not hide them. The scheme list is an allowlist - `lightning:`, `bitcoin:`, `ethereum:` and `https:`
and nothing else - so a link the page never needs cannot reach an app on the phone. The page is
served to the WebView from the app's own virtual origin (`https://appassets.androidplatform.net`,
answered by the shell from `assets/index.html`), not from `file://`, so file access and universal
file access are both off while the chain reads and the quote work as ordinary CORS requests, and
`data:`/`blob:` documents are not treated as the app's own page. Safe Browsing stays on. `cleanswap:`
intents are quoted with `JSONObject.quote`, and a code handed over by another app opens CleanSwap on
it. A release build is minified and shrunk by R8 with `proguard-rules.pro` keeping the shell's entry
points.

GitHub Actions builds `cleanswap.apk` on every push to `main` and on `v*` tags, and what it builds
is the **signed release** - never a debug APK. The workflow this repository maintains is
`android/ci/apk-release.yml`: it assembles `release`, writes the keystore from
`CLEANSWAP_KEYSTORE_BASE64` and stops before any APK exists when the secret or a password is
missing, collects the APK from `outputs/apk/release`, checks its certificate with `apksigner`, and
uploads it as a workflow artifact. Every action it runs is pinned to a full commit SHA, with the
release that SHA came from written beside it, so a moved tag cannot change what a run executes.

GitHub reads `.github/workflows/apk.yml`, and the app's automation has no `workflows` permission -
a push that touches that path is refused by GitHub. So the file under `.github/workflows/` has to be
replaced by hand with `android/ci/apk-release.yml` (the two are otherwise identical, and the shell
test says out loud when they differ). Until that paste happens, the workflow GitHub runs is whatever
that file last said; after it, every push builds the signed release.

### Signing a release

A release APK is signed with a long-lived key: a debug signature would install, but it could never
update an installed release, and each CI runner would make a different one. The four values come
from the environment, or from `android/keystore.properties` (git-ignored) for a local build:

```properties
CLEANSWAP_KEYSTORE=keystore/cleanswap-release.jks
CLEANSWAP_KEYSTORE_PASSWORD=…
CLEANSWAP_KEY_ALIAS=cleanswap
CLEANSWAP_KEY_PASSWORD=…
```

```bash
cd android
export CLEANSWAP_KEYSTORE_PASSWORD=… CLEANSWAP_KEY_ALIAS=cleanswap CLEANSWAP_KEY_PASSWORD=…
CLEANSWAP_KEYSTORE=keystore/cleanswap-release.jks gradle assembleRelease
```

When any of the four is missing, `assembleRelease`, `bundleRelease` and `installRelease` stop before
any APK exists and say which one is missing - a build signed with a debug key would install once and
never update. `assembleDebug`, lint and the tests need no key. In CI the key is
`CLEANSWAP_KEYSTORE_BASE64` (base64 of the .jks) plus the three passwords as repository secrets;
`android/ci/apk-release.yml` writes it to a temporary file, assembles the release, and checks the
certificate with `apksigner` before uploading. The four secrets and the workflow file are both
needed: secrets alone leave a run with no keystore, and the file alone leaves a run that builds
nothing.

## Security notes and limitations

* This is a **prototype**. The contract is minimal by design and **has not been audited**; do not
  escrow real value with it. On Arbitrum One, real USDT is real money.
* The app reads the chain and builds calls; it never signs. Anything it says is settled on-chain is
  read from the contract, and everything else it says is a sentence, not a receipt.
* The read path is the page's own JSON-RPC client against public endpoints (or the ones you set).
  With two or more endpoints the state is read by quorum, so one lying node is caught by the
  disagreement, and so are receipts and transactions. With a single endpoint that node is trusted by
  definition: a line under the chain row says one node answers and nothing is cross-checked, so the
  screen never claims a check that did not happen. Run your own node for real value.
* The escrow guards `lock`, `claim` and `refund` against re-entry, and refuses a zero hashlock or a
  receiver that is the escrow itself. It is still not audited.
* The page runs under its own Content-Security-Policy: the inline script and style are allowed by
  SHA-256 hash (no `'unsafe-inline'`), no frame or script from another origin, `data:` images only,
  and connections only to the chain endpoints. A code, an invoice or a lock code is a stranger's
  text and is parsed as data - never as markup (the QR is drawn with `createElementNS`, its caption
  set as text).
* A `cleanswap:` code carries terms only. It is not a web address, has no host, and is never built
  from the page's own URL - and it never changes the setup: the chain and the escrow in a code are
  requirements that must already match, not settings that get written.
* A swap lives in the page: reloading it forgets it, and the Android shell keeps nothing of it in
  the instance state either. The Setup panel is the only thing kept, in one `localStorage` key -
  with one escrow, token and endpoint list per network.
* A BOLT11 invoice's signature is checked, but a BOLT11 invoice names no payee unless it carries an
  `n` tag: without one, the key is recovered from the signature, which proves the invoice was not
  edited, not who made it. The `n` tag, when present, is verified against and must be low-S.
* A BOLT12 invoice (`lni1`) is **not** accepted: its signature is a Schnorr signature over a merkle
  root of its TLVs, and this page has no verifier for it, so it refuses one rather than take terms
  on trust. The refusal asks for an ordinary Lightning invoice.
* Practice invoices are signed with a key that ships in the page: they are real BOLT11 strings and
  they verify, but no node holds that key and no one can pay them. They are rehearsal material, and
  the screen never asks anyone to pay one outside Practice.
* The UI, code, tests and commit messages are English only, and `test/verify-english.py` enforces it.

## Contributors

- [@JBITmstr](https://github.com/JBITmstr)
- Gilbert ([Pickle](https://pickle.com))

## License

MIT for the code in this repository. The CleanSwap name and icon belong to the project owner.
