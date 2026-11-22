/* CleanSwap v0.6.12 — Lightning bitcoin <-> USDT atomic swap in one file.

   The screen stays out of the way: two amount cards, one plain sentence and
   one big button per step, the way a payment app reads. No symbol names, no
   hashes and no raw hex are ever shown; practice mode needs no pasting at all.
   Underneath, every step is still gated on data a real swap would need, and
   the gate runs here, in the browser:

     step 1  a Lightning invoice that states its payment hash (a BOLT11 hold
             invoice, or a BOLT12 invoice with the same field): that hash is H
     step 2  the counterparty's escrow lock, decoded and matched against H, T2
             and the USDT amount (lock() calldata, JSON record, Liquid lock URI
             or a lock transaction hash)
     step 3  the 32-byte preimage R, accepted only when SHA256(R) === H

   Wallet mode does not call a swap complete on anything the phone believes by
   itself. The USDT leg is a real HTLC on Arbitrum: the page reads the escrow
   contract over JSON-RPC (`swaps(id)`, `eth_getTransactionReceipt`,
   `eth_blockNumber`) and the swap only closes when that contract says the USDT
   is locked for these terms and then claimed. `I paid` starts the watch; it
   never finishes the swap.

   Only an invoice that states its own payment hash is accepted. A BOLT12 offer
   (`lno1...`) carries no payment hash: the invoice it later produces gets a
   fresh random hash from the payee's node, so no offer can pin the hash this
   swap locks to. Pasting an offer is refused with a sentence that says so, and
   the partner is asked for a hold invoice instead. The TLV bytes of an offer
   are never hashed into H.

   A BOLT12 invoice (`lni1...`) is read and its fields are checked, but it is
   not taken: its signature is a Schnorr signature over a merkle root of its
   TLVs, this page verifies BOLT11 signatures only, and terms nobody verified
   are not terms to lock money behind. The refusal is a sentence that names
   the way out - an ordinary Lightning invoice, which the page does check. An
   invoice that states no creation time (164) or no expiry (166) is refused at
   the decoder, so no path can read one as an invoice that never ends.

   A BOLT11 invoice may carry several route hints (`r`) and fallback addresses
   (`f`): a wallet with private channels sends one per channel, and Phoenix,
   Breez and Zeus all do, so those two repeat and every one of them is read,
   while a field that states a single term (the hash, the amount, the expiry,
   the payee) still may appear only once. An EVM address written in mixed case
   has to spell itself the way EIP-55 says, or it is not the address it was
   copied from. And a lock funded by a smart contract wallet is read from the
   escrow's own Locked event - the address the escrow saw as its sender - not
   from the key that relayed the transaction. Two nodes that write the same
   receipt in different shapes are one answer: the quorum compares the fields
   the money depends on, not their JSON spelling.

   A swap id is the terms plus the address that funds the escrow, so a code
   from the other side is checked before anything is adopted from it: the chain
   is never switched and an escrow address is never written over by a code, and
   a code that arrives from another app while this screen holds terms of its own
   is held with a sentence and two buttons until the person says which swap this
   is. The escrow window has a floor, a ceiling, and two deadlines that have to
   fall in this order: the window closes first, and the bitcoin payment it is
   paid against runs past it - the invoice's own final delta (`c`) plus an hour
   of room - so the sats can never come back while the USDT is still claimable.

   The USDT address is an Arbitrum one (`0x` + 40 hex). A TRON `T` address is
   still decoded so a pasted one gets a straight answer, but Wallet mode says
   plainly that this app moves USDT on Arbitrum.

   Practice mode runs both sides on one screen (invoice mint, escrow lock,
   claim) with real WebCrypto, real bech32 and real ABI encoding, against an
   in-page stand-in for the escrow contract that speaks the same records. The
   practice partner is simulated, so no code is pasted; the same checks that
   judge a real receipt judge the rehearsal. v0.5.1: the rehearsal walks the
   same screens in the same order as a real swap - Approve, the waiting screen
   with I paid, then the escrow read that closes it - because the mode differs
   in only two things: Sample beside the two inputs, and a stand-in escrow
   instead of a deployed one (so nothing is written to Recent).

   Wallet mode swaps the simulated partner for a real invoice, a real Arbitrum
   escrow and the values the other side sends back. Signing stays outside the
   app: an EIP-1193 wallet (`window.ethereum`) sends the call when the page is
   opened inside one, and otherwise the call is copied or opened as an
   `ethereum:` link, and the transaction hash is pasted back. The app holds no
   key and never asks for one.

   v0.6.11 keeps a real swap through the one thing that used to end it - the
   page being killed while an external wallet is in front. The terms of a
   running swap are put away in one localStorage key (never the secret) and
   read back at boot, so the phone opens on its own swap instead of an empty
   form. The rate a swap is priced with comes from two public quotes at once
   and is used only when they agree; the token a wallet swap counts in has to
   be one the chain has read; and the shipped page leaves one entry on the
   window (`acceptCode`) where the test build leaves the whole handle.

   v0.6.12 gives the quote a shelf life, and the mode switch its line. A price
   is a market, and a market moves: a quote is good for ninety seconds, and the
   taps that would spend it - Approve, the lock, a code handed to the other
   side - read both sources again first when it is older than that, so the USDT
   amount that gets locked is the one the fresh pair prices. And a rehearsal's
   terms are not a real swap's: switching from Practice to Wallet clears the
   window, pinned hash, funding address and amount a Practice code put on
   screen, before a resumed swap writes its own back.

   The source is one script built out of src/modules/, one file per
   responsibility (core, storage, chain, wallet, crypto, swap, gate, render,
   actions, price, ui, boot, and the bridge), spliced into this wrapper by
   build.py. Nothing above changes because of that: the artifact is still a
   single HTML file with one inline script and the same hash-pinned CSP. */

(function () {
  'use strict';

/*__MODULES__*/
})();
