/* CleanSwap v0.6.4 — Lightning bitcoin <-> USDT atomic swap in one file.

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
   is never switched and an escrow address is never written over by a code.
   The escrow window has a floor and a ceiling, and the Lightning invoice has to
   outlive the window by an hour, so a short or endless window cannot race the
   payer.

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
   key and never asks for one. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* keccak256(signature) selectors — verified against solc 0.8.26 --hashes */
  var SEL = {
    lock: '91644b2b', claim: '84cc9dfb', refund: '7249fbb6',
    swaps: 'eb84e7f2', balance: '70a08231', approve: '095ea7b3', allowance: 'dd62ed3e',
    decimals: '313ce567'
  };
  /* An id nobody ever locked. The escrow answers it with the whole record,
     zeroed - eight words, not an error - which is exactly how the probe
     below tells the escrow from any other contract. */
  var ZERO_ID = '0x' + '0'.repeat(64);

  /* Arbitrum, both ends of it. The test chain is the default: an escrow on a
     test chain is the only place a swap can be rehearsed with no money on it.
     The public endpoints are what the page talks to; `arb1.arbitrum.org` was
     the documented mainnet endpoint but did not answer on 2026-11-17, so the
     list carries the ones that did, and a private endpoint can replace them
     all in Setup. */
  var CHAINS = {
    testnet: {
      id: 'testnet', label: 'Arbitrum Sepolia', place: 'Sepolia test chain',
      chainId: 421614, chainHex: '0x66eee',
      rpc: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'],
      explorer: 'https://sepolia.arbiscan.io',
      token: '',                       /* put TestUSDT here after deploying it */
      escrows: []                      /* the escrows this app publishes for the chain */
    },
    mainnet: {
      id: 'mainnet', label: 'Arbitrum One', place: 'Arbitrum One',
      chainId: 42161, chainHex: '0xa4b1',
      rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
      explorer: 'https://arbiscan.io',
      token: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',  /* USDT, 6 decimals */
      escrows: []                      /* none published yet: a code may not add one */
    }
  };
  var DECIMALS = 6;
  /* What a practice run draws on, so nothing on a rehearsal screen is anybody's
     real wallet. */
  var EVM = {
    btcSide: '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',   /* receives the USDT */
    usdtSide: '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761',  /* locks the USDT */
    htlc: '0x9d1f4c7a2b8e6035f4a7c1d9028be35f7a6c4d18',      /* practice escrow */
    token: '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097'      /* practice USDT */
  };
  var SETTINGS_KEY = 'cleanswap.setup.v1';
  /* The escrow's creation bytecode, compiled by build.py from
     contracts/CleanSwapHTLC.sol with solc 0.8.26. It is what the Setup panel
     hands over to a deploy, so a swap can exist before any escrow does. */
  var BYTECODE = '/*__BYTECODE__*/';
  var FALLBACK_PRICE = 90000;
  var QR_MAX = 340;                 /* bytes at level L, version 13 (the encoder's ceiling) */
  var QR_M = 269;                   /* bytes at level M, version 12 */
  /* The bitcoin network the Lightning leg pays on, as a BOLT11 prefix. A sample
     invoice is written on mainnet, which is the invoice a rehearsal stands in
     for; what may be accepted is decided by the chain below (see invNetOk). */
  var NET = 'bc';                   /* invoice network prefix a sample is made on */
  /* A practice address, so the rehearsal has somewhere to send USDT. */
  var DEMO_ADDR = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
  var T2_SPAN = 7200;               /* USDT escrow window a new code asks for, seconds */
  var T2_MIN = 1800;                /* the shortest window a code may leave, seconds */
  var T2_MAX = 7 * 24 * 3600;       /* mirrors MAX_TIMELOCK_DELTA in the contract */
  var T1_MARGIN = 3600;             /* the invoice has to outlive the window by this much */
  var PAY_MARGIN = 600;             /* stop paying once this little of the window is left */
  var T1_BLOCKS = 40;               /* ~6h40m of bitcoin blocks */
  var BLOCK_SECS = 600;

  var S = {
    mode: 'practice',               /* practice | wallet */
    direction: 'btc2u',             /* what leaves this phone: btc2u sends BTC, u2b sends USDT */
    phase: 'idle',                  /* idle | locking | paying | paid | settled | refunded */
    net: 'testnet',                 /* testnet (Arbitrum Sepolia) | mainnet (Arbitrum One) */
    /* One escrow, one token and one endpoint list per network: the three
       fields below are the ones the selected network owns, and setups keeps
       the other network's while it is not selected. */
    setups: {
      testnet: { contract: '', token: '', rpc: '' },
      mainnet: { contract: '', token: '', rpc: '' }
    },
    contract: '',                   /* the escrow contract on that chain */
    token: '',                      /* the USDT token on that chain */
    rpc: '',                        /* private endpoint(s), comma-separated, when set */
    quorum: 'idle',                 /* idle | ok | single | disagree */
    block: null,                    /* latest block read from the chain */
    blockTs: null,                  /* that block's timestamp, the chain's clock */
    blockTsAt: 0, blockTsFail: 0,   /* when it was read, when a read last failed */
    rpcState: 'idle',               /* idle | ok | unclear | nocon | nohtlc | bad */
    chain: null,                    /* the last reading: {state, why, rec} */
    chainAt: 0, simRec: null,       /* the practice stand-in for that record */
    txPending: null,                /* a call built and waiting for a wallet */
    lockTx: '',                     /* the transaction that put the USDT in escrow */
    claimTx: '',                    /* the transaction that took it out */
    secret: '',                     /* the payment secret, when this side has it */
    busy: false,                    /* a chain read is in flight */
    op: '',                         /* a tap's operation is in flight: approve, lock, claim, refund */
    sending: false,                 /* this page has a wallet call of its own in flight */
    note: '',                       /* what the last refusal said, on the waiting screen */
    watch: 0,                       /* the polling timer while a swap runs */
    sats: 50000,
    price: null, pstate: 'loading',
    units: null,                    /* agreed USDT amount, micro-units */
    H: null, id: null,
    t1: null, t2: null,
    sim: 0, h0: 923452,             /* the practice clock and its block height */
    inv: '', invDec: null,          /* the Lightning invoice on the screen */
    basis: null,                    /* how the bitcoin leg is paid: a hold invoice */
    addr: '',                       /* the USDT address on the screen */
    me: '',                         /* the wallet account this side signs with */
    locker: '',                     /* the address that funds the escrow (from a code) */
    funder: '',                     /* the address the escrow itself says funded it (from its Locked event) */
    expectH: null,                  /* hashlock pinned by a code from the other side */
    codeWarn: '',                   /* what a refused code said, kept on screen */
    codeAddr: '',                   /* a USDT address a code named, offered not taken */
    codeAddrFilled: '',             /* an address a code wrote into the field itself */
    codeTerms: null,                /* the amounts a code put on screen: {units, sats} */
    codeRateWarn: false,            /* whether the sentence on screen is the rate warning */
    tokenState: '',                 /* '' (not read) | ok | unread | wrong: what the chain said
                                       about the token set in Setup */
    log: [],
    qrInv: '',                      /* the payload whose QR is on screen */
    gate: null
  };

  /* ------------------------------------------------------------- helpers -- */
  function hexOf(u8) {
    var s = '', i;
    for (i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return s;
  }
  /* Hex that cannot be read is an error, never a zero byte: a padded or
     silently zeroed field would sign or lock on bytes nobody wrote. */
  function fromHex(h) {
    var clean = String(h == null ? '' : h).replace(/^0x/i, ''), out, i;
    if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('not hex');
    if (clean.length % 2) throw new Error('hex with an odd length');
    out = new Uint8Array(clean.length / 2);
    for (i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  function catBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  /* A number taken out of a message is only a number if it survived as one:
     2^53 is where a JS Number stops counting single units, so anything above
     it is refused rather than quietly rounded. */
  var SAFE = 9007199254740991n;
  function toNum(v, what) {
    var b = BigInt(v);
    if (b > SAFE || b < -SAFE) throw new Error((what || 'value') + ' is out of range');
    return Number(b);
  }
  function rndHex(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return hexOf(b);
  }
  function sha256Hex(input) {
    var clean = String(input).replace(/^0x/i, '');
    if (!/^([0-9a-fA-F]{2})+$/.test(clean)) return Promise.reject(new Error('not hex'));
    if (!crypto.subtle) return Promise.reject(new Error('WebCrypto unavailable'));
    return crypto.subtle.digest('SHA-256', fromHex(clean)).then(function (d) { return hexOf(new Uint8Array(d)); });
  }

  /* ------------------------------------- sha256 inside the same tick -----
     WebCrypto answers with a promise, but an address check has to answer where
     the gate that paints the screen needs it, synchronously. Base58Check (the
     TRON address below) needs two passes over 21 bytes, so here is the plain
     SHA-256. The swap hash itself still goes through WebCrypto above. */
  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256Bytes(input) {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var len = input.length, total = Math.ceil((len + 9) / 64) * 64, i, j, off;
    var msg = new Uint8Array(total);
    msg.set(input, 0);
    msg[len] = 0x80;
    var hi = Math.floor(len / 536870912), lo = (len * 8) >>> 0;
    msg[total - 8] = (hi >>> 24) & 255; msg[total - 7] = (hi >>> 16) & 255;
    msg[total - 6] = (hi >>> 8) & 255; msg[total - 5] = hi & 255;
    msg[total - 4] = (lo >>> 24) & 255; msg[total - 3] = (lo >>> 16) & 255;
    msg[total - 2] = (lo >>> 8) & 255; msg[total - 1] = lo & 255;
    var w = new Int32Array(64);
    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) {
        j = off + i * 4;
        w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
      }
      for (i = 16; i < 64; i++) {
        w[i] = (w[i - 16] + (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) +
          w[i - 7] + (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7, t1, t2;
      for (i = 0; i < 64; i++) {
        t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    var out = new Uint8Array(32), v = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (i = 0; i < 8; i++) {
      out[i * 4] = (v[i] >>> 24) & 255; out[i * 4 + 1] = (v[i] >>> 16) & 255;
      out[i * 4 + 2] = (v[i] >>> 8) & 255; out[i * 4 + 3] = v[i] & 255;
    }
    return out;
  }

  /* ------------------------------------------------ keccak-256, for EVM ---
     An EVM address carries its own spelling: EIP-55 capitalises the letters
     whose nibble in keccak-256 of the lower-case hex is 8 or more, so one
     mistyped character shows up as a wrong capital. The page also needs
     keccak for the escrow's `Locked` event, whose topic is the hash of its
     signature. Both have to work with no dependency and no network, so the
     permutation is here: Keccak-f[1600], rate 136 bytes, and Ethereum's
     original 0x01 padding (not SHA-3's 0x06). Checked against the known
     digest of the empty string and against eth_utils.keccak in the tests. */
  var KECCAK = (function () {
    var MASK = (1n << 64n) - 1n;
    var RC = [
      '0x0000000000000001', '0x0000000000008082', '0x800000000000808a', '0x8000000080008000',
      '0x000000000000808b', '0x0000000080000001', '0x8000000080008081', '0x8000000000008009',
      '0x000000000000008a', '0x0000000000000088', '0x0000000080008009', '0x000000008000000a',
      '0x000000008000808b', '0x800000000000008b', '0x8000000000008089', '0x8000000000008003',
      '0x8000000000008002', '0x8000000000000080', '0x000000000000800a', '0x800000008000000a',
      '0x8000000080008081', '0x8000000000008080', '0x0000000080000001', '0x8000000080008008'
    ].map(function (x) { return BigInt(x); });
    /* rotations, by lane x + 5y */
    var ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39,
      41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
    function rotl(x, n) {
      var k = BigInt(n % 64);
      return k === 0n ? x : (((x << k) | (x >> (64n - k))) & MASK);
    }
    function permute(s) {
      var C = new Array(5), B = new Array(25), round, x, y, d;
      for (round = 0; round < 24; round++) {
        for (x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
        for (x = 0; x < 5; x++) {
          d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
          for (y = 0; y < 25; y += 5) s[x + y] = (s[x + y] ^ d) & MASK;
        }
        for (x = 0; x < 5; x++) {
          for (y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
        }
        for (x = 0; x < 5; x++) {
          for (y = 0; y < 5; y++) {
            s[x + 5 * y] = (B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y])) & MASK;
          }
        }
        s[0] = (s[0] ^ RC[round]) & MASK;
      }
    }
    function digest(bytes) {
      var rate = 136, s = new Array(25), i, j, off, lane, pad;
      for (i = 0; i < 25; i++) s[i] = 0n;
      pad = rate - (bytes.length % rate);
      var msg = new Uint8Array(bytes.length + pad);
      msg.set(bytes, 0);
      msg[bytes.length] ^= 0x01;
      msg[msg.length - 1] ^= 0x80;
      for (off = 0; off < msg.length; off += rate) {
        for (i = 0; i < rate / 8; i++) {
          lane = 0n;
          for (j = 0; j < 8; j++) lane |= BigInt(msg[off + i * 8 + j]) << BigInt(8 * j);
          s[i] ^= lane;
        }
        permute(s);
      }
      var out = new Uint8Array(32);
      for (i = 0; i < 4; i++) {
        for (j = 0; j < 8; j++) out[i * 8 + j] = Number((s[i] >> BigInt(8 * j)) & 255n);
      }
      return out;
    }
    return { digest: digest, hex: function (bytes) { return hexOf(digest(bytes)); } };
  })();

  /* EIP-55: the canonical spelling of an address. All-lower and all-upper are
     accepted as written - that is the standard's own allowance, and how most
     nodes and tools print one - while a mixed-case address has to be this
     spelling exactly, so a replaced or mistyped character is refused instead
     of being locked money against. */
  function eip55(a) {
    var body = String(a == null ? '' : a).replace(/^0x/i, '').toLowerCase(), i, nib, out = '';
    if (!/^[0-9a-f]{40}$/.test(body)) return null;
    var h = KECCAK.hex(utf8(body));
    for (i = 0; i < 40; i++) {
      nib = parseInt(h.charAt(i), 16);
      out += nib >= 8 ? body.charAt(i).toUpperCase() : body.charAt(i);
    }
    return '0x' + out;
  }
  function checksumOk(a) {
    var s = String(a == null ? '' : a), body, canon;
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
    body = s.slice(2);
    if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
    canon = eip55(body);
    return canon != null && canon.slice(2) === body;
  }

  /* ------------------------------------------------------------ base58 --- */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Bytes(s) {
    var n = 0n, i, v, zeros = 0, hex, body = [];
    for (i = 0; i < s.length; i++) {
      v = B58.indexOf(s.charAt(i));
      if (v < 0) throw new Error('not base58');
      n = n * 58n + BigInt(v);
    }
    while (zeros < s.length && s.charAt(zeros) === '1') zeros++;
    hex = n === 0n ? '' : n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    for (i = 0; i < hex.length; i += 2) body.push(parseInt(hex.substr(i, 2), 16));
    var out = new Uint8Array(zeros + body.length);
    out.set(body, zeros);
    return out;
  }

  /* TRON's TRC-20 USDT addresses are what a wallet shows: 'T' plus 33 base58
     characters, which decode to 0x41 + the 20 address bytes + a four-byte
     double-SHA-256 checksum. The checksum is checked for real, so a mistyped or
     truncated address is refused instead of being sent USDT that never lands. */
  function tronAddressBytes(a) {
    var s = String(a == null ? '' : a).trim();
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(s)) return null;
    var raw;
    try { raw = base58Bytes(s); } catch (e) { return null; }
    if (raw.length !== 25 || raw[0] !== 0x41) return null;
    var sum = sha256Bytes(sha256Bytes(raw.subarray(0, 21)));
    for (var i = 0; i < 4; i++) if (sum[i] !== raw[21 + i]) return null;
    return new Uint8Array(raw.subarray(1, 21));
  }
  function short(h, n) {
    n = n || 6;
    var s = String(h || '');
    return s.length > n * 2 + 6 ? s.slice(0, n + 2) + '…' + s.slice(-4) : (s || '—');
  }
  function normHex(x) { return String(x == null ? '' : x).trim().replace(/^0x/i, '').replace(/\s+/g, '').toLowerCase(); }
  function nowSec() { return Math.floor(Date.now() / 1000) + S.sim; }
  /* The Lightning leg follows the chain this app is set to. A Sepolia escrow
     is play USDT, so it can sit beside a testnet invoice (`lntb`) or a real
     one; an escrow on Arbitrum One pays real USDT and only a real mainnet
     invoice may buy it - testnet sats are worth nothing and would take real
     USDT for them. A phone set to a test chain that refused `lntb` would
     refuse the only invoice its partner can actually pay there. */
  function invNetOk(net) {
    if (net === NET) return true;
    return S.net !== 'mainnet' && (net === 'tb' || net === 'bcrt');
  }

  function curHeight() { return S.h0 + Math.floor(S.sim / BLOCK_SECS); }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function usdtOf() { return S.units != null ? S.units / 1e6 : (S.price ? S.sats / 1e8 * S.price : 0); }
  function usdtTxt() {
    var v = usdtOf();
    return v ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  }
  function usdtUnits() {
    if (S.units != null) return S.units;
    return S.price ? Math.round(S.sats / 1e8 * S.price * 1e6) : 0;
  }
  /* Micro-units as money reads, done in BigInt so a large token amount is not
     rounded on its way to the screen. */
  function unitsTxt(v) {
    var b = BigInt(v), neg = b < 0n;
    if (neg) b = -b;
    var whole = (b / 1000000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var frac = (b % 1000000n).toString().padStart(6, '0').slice(0, 2);
    return (neg ? '-' : '') + whole + '.' + frac;
  }
  /* Two amounts are the same amount only if their digits are: a comparison
     that goes through a float would call 2^53+1 and 2^53 equal. */
  function sameAmount(a, b) {
    try { return BigInt(String(a == null ? '' : a).trim()) === BigInt(String(b == null ? '' : b).trim()); }
    catch (e) { return false; }
  }
  function clock(t) {
    var d = new Date((t || nowSec()) * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function spanTxt(s) {
    if (s <= 0) return 'expired';
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
    if (h) return h + 'h ' + ('0' + m).slice(-2) + 'm';
    return ('0' + m).slice(-2) + ':' + ('0' + sec).slice(-2);
  }
  function priceNow() {
    if (!S.t2) return '—';
    return spanTxt(S.t2 - effNow());
  }
  /* A 0x address is 40 hex characters, and when it is written in mixed case
     its capitals are checked against EIP-55: an all-lower or all-upper address
     is accepted as written, a mixed-case one has to spell itself the way the
     standard says, so a replaced character cannot pass for the address it was
     copied from. */
  function isAddr(a) { return checksumOk(a); }
  /* The 20 bytes an address stands for, whichever chain it came from, so the
     packed swap id reads the same for an EVM and a TRON address. */
  function addr20(a) {
    var tron = tronAddressBytes(a);
    return tron || fromHex(String(a || '').replace(/^0x/i, ''));
  }
  function isZeroBytes(b) {
    for (var i = 0; i < b.length; i++) if (b[i]) return false;
    return true;
  }
  function chainOf(a) {
    if (isAddr(a)) return 'evm';
    if (tronAddressBytes(a)) return 'tron';
    return '';
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }
  function copy(text, what) {
    if (!text || text === '—') { toast('Nothing to copy yet'); return; }
    var done = function () { toast((what || 'Copied')); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function log(kind, text, cls) {
    S.log.unshift({ t: clock(), kind: kind, text: text, cls: cls || '' });
    if (S.log.length > 60) S.log.pop();
  }
  /* Only real swaps are remembered: a practice run leaves no record behind. */
  function historyEntry(title, detail, cls) {
    if (S.mode !== 'wallet') return;
    var box = $('histList'), it = document.createElement('div');
    it.className = 'hist-item' + (cls ? ' ' + cls : '');
    var a = document.createElement('span'); a.textContent = title;
    var b = document.createElement('b'); b.textContent = detail;
    it.appendChild(a); it.appendChild(b);
    box.insertBefore(it, box.firstChild);
    while (box.children.length > 8) box.removeChild(box.lastChild);
    $('history').hidden = false;
    var he = $('histEmpty');
    if (he) he.hidden = true;
  }

  /* ------------------------------------------------ sha256 swap identity -- */
  function writeU256(buf, off, val) {
    var b = BigInt(val), i;
    for (i = 0; i < 32; i++) buf[off + 31 - i] = Number((b >> BigInt(8 * i)) & 255n);
  }
  /* mirrors computeSwapId() in the contract:
     sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock)).
     The sender — the address that funds the escrow — is in it, so a third party
     who copies the terms cannot lock them first and burn the id by refunding:
     their own address gives the same terms a different id. The side that does
     not fund the escrow learns that address from the other side's code (or
     from its lock transaction) and then computes the same id off-line. */
  function computeSwapId(hashlock, sender, receiver, token, amount, timelock) {
    var buf = new Uint8Array(156);
    buf.set(fromHex(hashlock), 0);
    buf.set(addr20(sender), 32);
    buf.set(addr20(receiver), 52);
    buf.set(fromHex(token), 72);
    writeU256(buf, 92, amount);
    writeU256(buf, 124, timelock);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) { return '0x' + hexOf(new Uint8Array(d)); });
  }

  /* Who funds the USDT escrow: this side when it sends USDT, the other side
     when it receives it. A rehearsal funds it from its stand-in address. The
     escrow's own Locked event wins over anything this side worked out: with a
     smart contract wallet the funding address is the contract the escrow saw,
     not the key that sent the transaction. */
  function lockerNow() {
    if (S.mode === 'practice') return EVM.usdtSide;
    if (isAddr(S.funder)) return String(S.funder).toLowerCase();
    return S.direction === 'u2b' ? String(S.me || '') : String(S.locker || '');
  }

  /* The wallet account this side signs with, asked for once. Wallets answer
     `eth_accounts` silently after a connection and prompt only when there is
     none; a refusal leaves the address unknown and the swap unreadable. */
  function ensureMe() {
    if (S.me) return Promise.resolve(true);
    var p = provider();
    if (S.mode !== 'wallet' || !p) return Promise.resolve(false);
    return p.request({ method: 'eth_accounts' }).then(function (a) {
      if (a && a[0]) { S.me = String(a[0]); return true; }
      return p.request({ method: 'eth_requestAccounts' }).then(function (b) {
        if (b && b[0]) { S.me = String(b[0]); return true; }
        return false;
      }, function () { return false; });
    }, function () { return false; });
  }

  /* ------------------------------------------------------------ the chain --
     Wallet mode's USDT leg is a real HTLC on Arbitrum. Everything the screen
     says about it comes from here: one JSON-RPC client, the escrow ABI, and
     the reading of `swaps(id)`. Nothing in this section believes the phone;
     the chain is the only thing that can say USDT moved. */
  function curChain() { return CHAINS[S.net] || CHAINS.testnet; }
  /* https, and http only for a node on this device: a local node speaks plain
     http, and anything further away has no business being typed in here. */
  function isEndpoint(u) {
    var t = String(u || '');
    return /^https:\/\/[^\s]+$/i.test(t) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(t);
  }
  /* Setup takes one endpoint or several, separated by commas or spaces. More
     than one is a cross-check: the escrow is only believed when two of them
     answer the same thing.

     The list is deduplicated before it is used, because the cross-check counts
     answers, not strings: the same URL typed twice - padded with a space, a
     trailing slash, or spelled in another case - is still one node, and two
     answers from one node would let that node alone decide what the escrow
     says. The comparison is on the trimmed, lower-cased address with a
     trailing slash dropped, which is the same endpoint however it is spelled;
     the spelling the person typed is what the list keeps, so the calls and the
     wallet's chain setup still go to the address as it was written. */
  function endpointKey(u) {
    return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
  }
  function endpointList(raw) {
    var parts = String(raw == null ? '' : raw).split(/[\s,]+/), out = [], seen = {}, i, k;
    for (i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      k = endpointKey(parts[i]);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(parts[i]);
    }
    return out;
  }
  function endpointsOk(raw) {
    var list = endpointList(raw);
    for (var i = 0; i < list.length; i++) if (!isEndpoint(list[i])) return false;
    return true;
  }
  /* An escrow the app publishes for this chain. A code may point at one of
     these on its own; any other address has to be typed in Setup by the person
     who deploys it. */
  function isOfficialEscrow(net, addr) {
    var list = (CHAINS[net] && CHAINS[net].escrows) || [], a = String(addr || '').toLowerCase();
    for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === a) return true;
    return false;
  }
  function tokenNow() { return S.mode === 'practice' ? EVM.token : (S.token || curChain().token); }
  function escrowNow() { return S.mode === 'practice' ? EVM.htlc : S.contract; }

  /* A token is only a token when the chain says two things about it: that code
     lives at that address, and that the code counts in the decimals this page
     counts in. Every amount here is written in millionths, so a token that
     counts in another unit would turn the amount the person agreed into a
     different amount of money - a seven-decimal token would move a tenth of
     what the screen said. The escrow itself refuses a token with no code; this
     is the same question asked where the token is typed, before any swap is
     priced against it. */
  function decimalsOf(res) {
    var s = String(res == null ? '' : res);
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return null;
    var h = s.slice(2);
    if (!/^0{56}/.test(h)) return null;        /* wider than 32 bits: not a decimals count */
    return parseInt(h.slice(56), 16);
  }
  function tokenVerdict(addr, list) {
    var opt = { list: list, quiet: true };
    return rpcQuorum('eth_getCode', [addr, 'latest'], opt).then(function (code) {
      if (!code || /^0x0*$/.test(String(code))) return { ok: false, why: 'nocontract' };
      return rpcQuorum('eth_call', [{ to: addr, data: '0x' + SEL.decimals }, 'latest'], opt)
        .then(function (res) {
          var d = decimalsOf(res);
          if (d == null) return { ok: false, why: 'nodecimals' };
          if (d !== DECIMALS) return { ok: false, why: 'decimals', decimals: d };
          return { ok: true, decimals: d };
        }, function (e) { return { ok: false, why: 'unread', disagree: !!(e && e.disagree) }; });
    }, function (e) { return { ok: false, why: 'unread', disagree: !!(e && e.disagree) }; });
  }
  function tokenWhy(v) {
    if (v.why === 'nocontract') return 'There is no token contract at that address on ' + curChain().label + '.';
    if (v.why === 'nodecimals') return 'That address answers, but it does not say how many decimals its token has, so it is not the token this swap counts in.';
    if (v.why === 'decimals') return 'That token counts in ' + v.decimals + ' decimals, and this swap moves a token that counts in ' + DECIMALS + '.';
    if (v.disagree) return 'The endpoints do not agree about that token, so it was not accepted.';
    return 'The chain did not answer, so the token could not be read.';
  }

  /* The setup is the one thing worth remembering between launches: a contract
     address typed once is a contract address forever - on the chain it was
     typed for. Two networks mean two escrows, two tokens and two endpoint
     lists, and what was typed on one is never read while the other is
     selected: a mainnet escrow address does not become a testnet one, and a
     private endpoint for one chain is not asked about the other. */
  function blankSetup() { return { contract: '', token: '', rpc: '' }; }
  function cleanSetup(one) {
    one = one || blankSetup();
    return {
      contract: isAddr(one.contract) ? String(one.contract).toLowerCase() : '',
      token: isAddr(one.token) ? String(one.token).toLowerCase() : '',
      rpc: endpointsOk(one.rpc) ? String(one.rpc) : ''
    };
  }
  function loadSetup() {
    try {
      var raw = window.localStorage && localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var j = JSON.parse(raw) || {}, net;
      if (j.net === 'testnet' || j.net === 'mainnet') S.net = j.net;
      S.setups = { testnet: blankSetup(), mainnet: blankSetup() };
      if (j.nets) {
        for (net in S.setups) if (j.nets[net]) S.setups[net] = cleanSetup(j.nets[net]);
      } else {
        /* The first spelling kept one setup with no network attached to it.
           It was written while one network was selected, so it belongs to
           that one and to no other. */
        S.setups[S.net] = cleanSetup(j);
      }
      applySetup();
    } catch (e) { /* a browser without storage simply forgets the setup */ }
  }
  /* The three fields the screen and the chain calls read are always the ones
     the selected network owns. */
  function applySetup() {
    var one = (S.setups && S.setups[S.net]) || blankSetup();
    S.contract = one.contract;
    S.token = one.token;
    S.rpc = one.rpc;
  }
  /* What is on screen is put away under the network it was typed for. */
  function keepSetup() {
    if (!S.setups) S.setups = { testnet: blankSetup(), mainnet: blankSetup() };
    S.setups[S.net] = cleanSetup({ contract: S.contract, token: S.token, rpc: S.rpc });
  }
  function saveSetup() {
    keepSetup();
    try {
      if (window.localStorage) localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        net: S.net, nets: S.setups
      }));
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ json-rpc -- */
  var rpcId = 0;
  /* Endpoints typed in Setup are the only ones used: a person who runs their
     own node did not ask for a public one to be asked instead. With nothing
     typed, the chain's own endpoints answer. */
  function endpoints() {
    var custom = endpointList(S.rpc);
    if (custom.length) return custom;
    return curChain().rpc.slice();
  }
  function rpcOne(url, method, params) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    var body = { jsonrpc: '2.0', id: ++rpcId, method: method, params: params || [] };
    return fetch(url, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || typeof j !== 'object') throw new Error('bad reply');
      if (j.error) { var e = new Error(j.error.message || 'call failed'); e.chain = true; throw e; }
      return j.result;
    }).catch(function (e) { clearTimeout(timer); throw e; });
  }
  /* One query, walked down the endpoint list: a public endpoint that is down or
     rate-limiting earns the next one, never a decision that the escrow is
     empty and never a swap called done. An answer from the chain (a revert)
     stops the walk: asking a second node the same question cannot change it. */
  function rpc(method, params) { return rpcWalk(endpoints(), method, params); }
  /* The same walk over a list that was just typed rather than the one already in
     effect: Setup has to read the chain it is about to save, and the endpoints it
     is about to save with it. */
  function rpcWalk(list, method, params) {
    list = list && list.length ? list : endpoints();
    var i = 0, last = null;
    function step() {
      if (i >= list.length) return Promise.reject(last || new Error('no endpoint'));
      var url = list[i++];
      return rpcOne(url, method, params).catch(function (e) {
        if (e && e.chain) return Promise.reject(e);
        last = e;
        return step();
      });
    }
    return step();
  }
  /* What two nodes have to agree on, written one way.

     Two honest nodes answer the same question in different shapes: the same
     receipt comes back with its keys in another order, with Arbitrum's own
     extra fields (l1BlockNumber, gasUsedForL1), or with a quantity as 0x01
     where the other wrote 0x1. Comparing raw JSON called that a disagreement,
     and a swap stopped on a chain that was working. So a receipt is compared
     by the parts the money depends on - its status, its block, who it came
     from and went to, and its logs' address, topics and data - and a
     transaction by its hash, from, to, value and input. A call's answer is
     compared as the bytes it is. Anything the page does not recognise is
     compared whole and normalized, never reduced to "agrees": an unknown
     shape must not pass as a match. */
  var QUORUM_QTY = {
    blocknumber: 1, status: 1, value: 1, nonce: 1, gas: 1, gasused: 1,
    cumulativegasused: 1, effectivegasprice: 1, gasprice: 1, transactionindex: 1,
    type: 1, chainid: 1, timestamp: 1, l1blocknumber: 1
  };
  function canonHex(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
  function canonQty(x) {
    var s = canonHex(x);
    if (/^0x[0-9a-f]+$/.test(s)) {
      try { return '0x' + BigInt(s).toString(16); } catch (e) { return s; }
    }
    if (/^\d+$/.test(s)) {
      try { return '0x' + BigInt(s).toString(16); } catch (e) { return s; }
    }
    return s;
  }
  function canonValue(v) {
    var out, keys, i, k;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return /^0x/i.test(v) ? canonHex(v) : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      out = [];
      for (i = 0; i < v.length; i++) out.push(canonValue(v[i]));
      return out;
    }
    if (typeof v !== 'object') return String(v);
    keys = Object.keys(v).sort(); out = {};
    for (i = 0; i < keys.length; i++) {
      k = keys[i].toLowerCase();
      out[k] = QUORUM_QTY[k] ? canonQty(v[keys[i]]) : canonValue(v[keys[i]]);
    }
    return out;
  }
  function canonLog(l) {
    if (!l || typeof l !== 'object') return canonValue(l);
    return {
      address: canonHex(l.address),
      topics: (Array.isArray(l.topics) ? l.topics : []).map(canonHex),
      data: canonHex(l.data)
    };
  }
  function quorumKey(v) {
    var o, keys, i, out;
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.logs)) {
      out = {
        status: canonQty(v.status), blockNumber: canonQty(v.blockNumber),
        from: canonHex(v.from), to: canonHex(v.to),
        contractAddress: canonHex(v.contractAddress),
        hash: canonHex(v.transactionHash || v.hash),
        logs: v.logs.map(canonLog)
      };
      return 'receipt:' + JSON.stringify(out);
    }
    if (v && typeof v === 'object' && !Array.isArray(v) &&
      (v.hash != null || v.transactionHash != null) &&
      ('from' in v || 'to' in v)) {
      out = {
        hash: canonHex(v.hash || v.transactionHash), from: canonHex(v.from),
        to: canonHex(v.to), value: canonQty(v.value),
        input: canonHex(v.input != null ? v.input : v.data),
        blockNumber: canonQty(v.blockNumber)
      };
      return 'tx:' + JSON.stringify(out);
    }
    return 'raw:' + JSON.stringify(canonValue(v));
  }

  /* A state the money depends on is asked of every configured endpoint at once
     and believed only when two of them answer the same thing. One lying node
     cannot then show a lock that is not there: it disagrees with the other, and
     the page says so instead of trusting either. A single endpoint is its own
     answer — that is what a private node is for. */
  function rpcQuorum(method, params, opt) {
    opt = opt || {};
    var list = opt.list && opt.list.length ? opt.list : endpoints();
    if (list.length < 2) {
      /* One endpoint is its own answer - that is what a private node is for -
         but the reading was not cross-checked, and the screen says so instead
         of letting a single node's word pass for a verified one. A quiet read
         (Setup asking about a token it has not saved yet) leaves the line alone. */
      if (!opt.quiet && S.mode !== 'practice') { S.quorum = 'single'; renderChain(); }
      return rpcWalk(list, method, params);
    }
    return Promise.all(list.map(function (url) {
      return rpcOne(url, method, params).then(
        function (v) { return { ok: true, key: quorumKey(v), v: v }; },
        function (e) { return { ok: false, e: e }; });
    })).then(function (all) {
      var seen = {}, best = null;
      all.forEach(function (r) {
        if (!r.ok) return;
        seen[r.key] = (seen[r.key] || 0) + 1;
        if (!best || seen[r.key] > seen[best.key]) best = r;
      });
      if (best && seen[best.key] >= 2) { if (!opt.quiet) S.quorum = 'ok'; return best.v; }
      if (!opt.quiet) S.quorum = (best ? 'disagree' : 'down');
      var e = new Error('the endpoints do not agree');
      e.disagree = true;
      throw e;
    });
  }

  /* ------------------------------------------------------ the chain clock --
     A timelock is measured by the chain, not by a phone whose clock anyone can
     move. The latest block's timestamp is read beside the escrow, and the later
     of the two clocks is what the window checks use: setting the phone back can
     only make the app more careful, never let it pay into a closing window.
     One reading serves 45 seconds so a screen full of checks is one request, and
     a failed read falls back to the phone's clock after a short pause instead of
     asking again on every keystroke. */
  var BLOCK_TS_TTL = 45000;
  var BLOCK_TS_RETRY = 15000;
  function effNow() {
    var local = nowSec();
    if (S.mode === 'practice') return local;
    var fresh = S.blockTs && (Date.now() - S.blockTsAt) < BLOCK_TS_TTL;
    return fresh && S.blockTs > local ? S.blockTs : local;
  }
  /* Every configured endpoint is asked and the latest answer wins: a node that
     is behind the others cannot make the window look longer than it is. This is
     not the escrow itself, so it does not go through the quorum path - a stale
     head is a stricter answer, not a disagreement to report. */
  function chainTimeOnce() {
    var list = endpoints();
    return Promise.all(list.map(function (url) {
      return rpcOne(url, 'eth_getBlockByNumber', ['latest', false]).then(function (b) {
        var t = parseInt(String(b && b.timestamp), 16);
        return isFinite(t) && t > 0 ? t : null;
      }, function () { return null; });
    })).then(function (all) {
      var best = null;
      all.forEach(function (t) { if (t && (!best || t > best)) best = t; });
      return best;
    }, function () { return null; });
  }
  function syncChainTime(force) {
    /* A rehearsal has no chain, and wallet mode without an escrow has no window
       to measure: neither should send a request just because a field changed. */
    if (S.mode !== 'wallet' || !isAddr(S.contract)) return Promise.resolve(nowSec());
    if (!force && Date.now() - S.blockTsAt < BLOCK_TS_TTL) return Promise.resolve(effNow());
    if (!force && Date.now() - S.blockTsFail < BLOCK_TS_RETRY) return Promise.resolve(effNow());
    return chainTimeOnce().then(function (t) {
      if (t) { S.blockTs = t; S.blockTsAt = Date.now(); }
      else S.blockTsFail = Date.now();
      return effNow();
    }, function () { S.blockTsFail = Date.now(); return effNow(); });
  }

  /* ------------------------------------------------------- escrow ABI ----- */
  function pad64(hex) { return ('0'.repeat(64) + hex).slice(-64); }
  function encU256(v) { return pad64(BigInt(v).toString(16)); }
  function encAddr(a) { return pad64(String(a).toLowerCase().replace(/^0x/, '')); }
  function encB32(h) { return pad64(normHex(h)); }
  function abiWords(hex) {
    var h = normHex(hex), out = [], i;
    if (!h.length || h.length % 64) return out;
    for (i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
    return out;
  }
  function wordNum(w) { return BigInt('0x' + (w || '0')).toString(); }
  function wordAddr(w) { return '0x' + String(w || '').slice(24); }
  function wordBool(w) { return !/^0+$/.test(String(w || '')); }
  function wordB32(w) { return '0x' + String(w || ''); }

  /* The escrow's Locked event, as the chain writes it: topics[0] is the hash of
     the signature, topics[1] the swap id, topics[2] the address that funded the
     escrow and topics[3] the receiver; the token, the amount, the hashlock and
     the timelock follow in the data. */
  var LOCKED_TOPIC = '0x' + KECCAK.hex(utf8('Locked(bytes32,address,address,address,uint256,bytes32,uint256)'));
  function lockedSender(t) {
    var w = String(t == null ? '' : t).replace(/^0x/i, '');
    if (w.length !== 64) return '';
    var a = '0x' + w.slice(24).toLowerCase();
    return isAddr(a) ? a : '';
  }
  /* The Locked event of this swap, out of a receipt. A smart contract wallet
     (a Safe, an account-abstraction wallet) is the msg.sender of the lock, so
     the address the escrow recorded is the one the swap id is built with - not
     `tx.from`, which is whatever key or bundler relayed the transaction. */
  function readLockedLog(rc) {
    var logs = rc && rc.logs, esc = String(S.contract || '').toLowerCase(), i, l, t, w, sender;
    if (!logs || !logs.length || !isAddr(S.contract)) return null;
    for (i = logs.length - 1; i >= 0; i--) {
      l = logs[i];
      if (!l || String(l.address || '').toLowerCase() !== esc) continue;
      t = l.topics || [];
      if (String(t[0] || '').toLowerCase() !== LOCKED_TOPIC) continue;
      w = abiWords(l.data);
      if (w.length < 4) continue;
      sender = lockedSender(t[2]);
      if (!sender) continue;
      return {
        swapId: String(t[1] || '').toLowerCase(),
        sender: sender,
        receiver: lockedSender(t[3]),
        token: wordAddr(w[0]).toLowerCase(),
        amount: wordNum(w[1]),
        hashlock: wordB32(w[2]).toLowerCase(),
        timelock: wordNum(w[3])
      };
    }
    return null;
  }
  /* A Locked event is about this swap only when the escrow wrote this swap's
     terms in it. Without that check, a transaction that locked something else
     would hand the page an address to build the wrong swap id from. A term the
     screen does not know yet (a form not filled in) is not compared; a term it
     does know has to match, and the escrow read after this decides the rest. */
  function termsOnScreen() {
    var inv = { ok: false }, ad, H = S.H;
    if (!H) {
      try { inv = readInvoice(pasted()); } catch (e) { inv = { ok: false }; }
      if (inv.ok) H = inv.H;
    }
    ad = S.addr ? { ok: true, address: S.addr } : readAddress(addrIn());
    return {
      H: H || null,
      addr: ad && ad.ok ? String(ad.address) : '',
      units: usdtUnits(),
      t2: S.t2
    };
  }
  function lockedLogFits(ev) {
    if (!ev) return false;
    var t = termsOnScreen(), token = String(tokenNow()).toLowerCase();
    if (t.H && normHex(ev.hashlock) !== normHex(t.H)) return false;
    if (isAddr(t.addr) && String(ev.receiver).toLowerCase() !== t.addr.toLowerCase()) return false;
    if (isAddr(token) && ev.token !== token) return false;
    if (Number(t.units) > 0 && !sameAmount(ev.amount, t.units)) return false;
    if (t.t2 && !sameAmount(ev.timelock, t.t2)) return false;
    return true;
  }

  /* The calls, in the shapes the contract declares them. */
  function lockCalldata(o) {
    return '0x' + SEL.lock + encB32(o.hashlock) + encU256(o.timelock) +
      encAddr(o.receiver) + encAddr(o.token) + encU256(o.amount);
  }
  function claimCalldata(swapId, preimage) { return '0x' + SEL.claim + encB32(swapId) + encB32(preimage); }
  function refundCalldata(swapId) { return '0x' + SEL.refund + encB32(swapId); }
  function swapsCalldata(swapId) { return '0x' + SEL.swaps + encB32(swapId); }
  function approveCalldata(spender, amount) { return '0x' + SEL.approve + encAddr(spender) + encU256(amount); }

  /* `swaps(id)` returns the whole struct as a tuple of eight values. */
  function decodeSwap(hex) {
    var w = abiWords(hex);
    if (w.length < 8) return null;
    return {
      hashlock: wordB32(w[0]),
      amount: wordNum(w[1]),
      timelock: wordNum(w[2]),
      token: wordAddr(w[3]),
      sender: wordAddr(w[4]),
      receiver: wordAddr(w[5]),
      claimed: wordBool(w[6]),
      refunded: wordBool(w[7])
    };
  }

  function decodeLockCalldata(hex) {
    var h = normHex(hex);
    if (h.length !== 8 + 5 * 64) return null;
    var w = [], i;
    for (i = 0; i < 5; i++) w.push(h.slice(8 + i * 64, 8 + (i + 1) * 64));
    return {
      kind: 'calldata',
      selector: h.slice(0, 8),
      hashlock: '0x' + w[0],
      timelock: BigInt('0x' + w[1]).toString(),
      receiver: '0x' + w[2].slice(24),
      token: '0x' + w[3].slice(24),
      amount: BigInt('0x' + w[4]).toString()
    };
  }

  function swapIdNow() {
    var who = lockerNow();
    if (!isAddr(who)) return Promise.reject(new Error('the escrow side is not known yet'));
    /* The id is the terms plus the funding address. Terms that never arrived
       (no swap code, no lock read back yet) mean there is no id to compute,
       and refusing here says so instead of handing a null into the bytes
       below and calling it a chain error. */
    if (!S.H || !S.t2) return Promise.reject(new Error('the swap terms are not complete yet'));
    return computeSwapId(S.H, who, S.addr, tokenNow(), S.units != null ? S.units : usdtUnits(), S.t2);
  }

  /* ------------------------------------------------------ reading it ------ */
  function termsNow() {
    return {
      hashlock: String(S.H || ''),
      sender: String(lockerNow() || ''),
      receiver: String(S.addr || ''),
      token: String(tokenNow() || ''),
      amount: String(S.units != null ? S.units : usdtUnits()),
      timelock: String(S.t2 || 0)
    };
  }

  /* What the escrow says about this swap, judged against the terms on screen.
     The id is derived from those terms, so a record found under it already
     shares them - they are compared again anyway, because a reading that only
     agrees with itself is not evidence. */
  function classify(rec) {
    if (!rec || !rec.sender || /^0x0+$/.test(rec.sender)) return { state: 'none', rec: rec };
    var t = termsNow(), why = '';
    if (normHex(rec.hashlock) !== normHex(t.hashlock)) why = 'hash';
    else if (String(rec.receiver).toLowerCase() !== t.receiver.toLowerCase()) why = 'receiver';
    else if (String(rec.token).toLowerCase() !== t.token.toLowerCase()) why = 'token';
    else if (!sameAmount(rec.amount, t.amount)) why = 'amount';
    else if (!sameAmount(rec.timelock, t.timelock)) why = 'tl';
    else if (t.sender && String(rec.sender).toLowerCase() !== t.sender.toLowerCase()) why = 'sender';
    if (why) return { state: 'mismatch', why: why, rec: rec };
    if (rec.claimed) return { state: 'claimed', rec: rec };
    if (rec.refunded) return { state: 'refunded', rec: rec };
    /* A record past its timelock can no longer be claimed: paying now would
       hand the sats over with nothing left to claim. */
    if (Number(rec.timelock) <= effNow()) return { state: 'closed', rec: rec };
    return { state: 'locked', rec: rec };
  }

  /* Plain sentences: what the chain says, without a symbol name in sight. */
  function chainSay(c) {
    var x = usdtTxt() + ' USDT';
    switch (c && c.state) {
      case 'locked': return 'The escrow holds your ' + x + ' until the swap closes or the window ends.';
      case 'closed': return 'The escrow window has closed, so the ' + x + ' can only go back to the side that locked it.';
      case 'claimed': return 'The escrow paid out the ' + x + '.';
      case 'refunded': return 'The escrow sent the ' + x + ' back to the side that locked it.';
      case 'mismatch':
        if (c.why === 'amount') return 'The escrow holds a different amount, so this is not the agreed swap.';
        if (c.why === 'receiver') return 'The escrow pays a different address, so it is not this swap.';
        if (c.why === 'tl') return 'The escrow ends at a different time, so it is not the agreed swap.';
        if (c.why === 'sender') return 'The escrow was funded from a different address, so it is not this swap.';
        return 'The escrow record does not match these terms.';
      case 'error': return c.disagree
        ? 'The endpoints do not agree on what the escrow holds, so nothing is trusted.'
        : 'The chain could not be reached just now.';
      default: return 'The ' + x + ' is not in the escrow yet.';
    }
  }

  function simRead() {
    var r = S.simRec;
    if (!r) return null;
    return {
      hashlock: r.hashlock, amount: String(r.amount), timelock: String(r.timelock),
      token: r.token, sender: r.sender, receiver: r.receiver,
      claimed: !!r.claimed, refunded: !!r.refunded
    };
  }

  /* One reading of the escrow for the terms on screen. Practice answers from
     the stand-in record; Wallet asks the chain. Either way the verdict comes
     from classify(), so the rehearsal and the real thing are judged alike. */
  function chainRead() {
    if (S.mode === 'practice') return Promise.resolve(simRead());
    if (!isAddr(S.contract)) return Promise.reject(new Error('no escrow contract set'));
    /* The side that funds the escrow has not told the app its address yet: by
       definition nothing of this side's is in the escrow, and the address is
       learned when the wallet signs or the lock transaction comes back. */
    if (!isAddr(lockerNow())) return Promise.resolve(null);
    /* Without the window there is no id to read under: a null reading, which
       the screen treats as nothing to say, never a chain error dressed as
       one. loadTx() fills the window from the lock before it asks here. */
    if (!S.t2) return Promise.resolve(null);
    return swapIdNow().then(function (id) { return rpcQuorum('eth_call', [{ to: S.contract, data: swapsCalldata(id) }, 'latest']); })
      .then(decodeSwap);
  }

  function refreshChain() {
    if (!S.H || (S.mode === 'wallet' && !isAddr(S.contract))) {
      S.chain = null;
      renderChain();
      return Promise.resolve(null);
    }
    var want = normHex(termsNow().hashlock);
    S.busy = true;
    if (S.mode === 'practice') S.block = curHeight();
    renderChain();
    return chainRead().then(function (rec) {
      S.busy = false;
      if (want !== normHex(termsNow().hashlock)) { renderChain(); return null; }   /* terms moved on */
      S.chain = classify(rec);
      S.rpcState = 'ok';
      S.chainAt = Date.now();
      renderChain();
      return S.chain;
    }, function (e) {
      S.busy = false;
      S.rpcState = 'bad';
      S.chain = { state: 'error', why: String((e && e.message) || e), disagree: !!(e && e.disagree) };
      renderChain();
      return S.chain;
    });
  }

  /* The head of the chain, read the way the chain's clock is: every configured
     endpoint is asked and the highest answer stands. A block number is a
     liveness reading, not a state the money depends on, so it is not a
     question for the quorum: Arbitrum makes a block every ~250ms, which means
     two honest nodes are almost always a block or two apart, and a quorum on
     the height would call a working chain broken and refuse the swap. */
  function headNumber() {
    var list = endpoints();
    return Promise.all(list.map(function (url) {
      return rpcOne(url, 'eth_blockNumber', []).then(function (bn) {
        var n = parseInt(String(bn), 16);
        return isFinite(n) && n > 0 ? n : null;
      }, function () { return null; });
    })).then(function (all) {
      var best = null;
      all.forEach(function (n) { if (n && (!best || n > best)) best = n; });
      if (best == null) throw new Error('no endpoint answered');
      return best;
    });
  }

  /* Does the chain answer, and is the escrow really the escrow? Code at an
     address is not yet an answer: any contract has code, and a token or a
     mimic wears an address just as well. The escrow is known by its own
     reading - `swaps(id)` returns the whole record, eight words, and for an
     id nobody locked it is zeroed fields rather than a revert. A screen that
     points at something else says so before any money is asked for. */
  function chainProbe() {
    /* A rehearsal has a stand-in escrow on the phone, so it already answers. */
    if (S.mode === 'practice') {
      S.busy = false;
      S.rpcState = 'ok';
      S.block = curHeight();
      renderChain();
      return Promise.resolve('ok');
    }
    if (S.mode !== 'wallet') return Promise.resolve(null);
    if (!isAddr(S.contract)) { S.rpcState = 'idle'; S.block = null; renderChain(); return Promise.resolve(null); }
    S.busy = true;
    renderChain();
    return headNumber().then(function (n) {
      S.block = n;
      /* Whether code exists at the escrow address is a state the money
         depends on, so it keeps the cross-check. */
      return rpcQuorum('eth_getCode', [S.contract, 'latest']);
    }).then(function (code) {
      var empty = !code || /^0x0*$/.test(String(code));
      if (empty) return null;
      /* Code is not the escrow; the escrow's view function is. An unknown
         swap reads back as eight zeroed words on the real contract. Anything
         else - a revert, a short answer, a different shape - is some other
         contract wearing the address, and the screen refuses it by name. */
      return rpcQuorum('eth_call', [{ to: S.contract, data: swapsCalldata(ZERO_ID) }, 'latest'])
        .then(function (res) { return decodeSwap(res) ? 'htlc' : 'other'; },
              function (e) { return (e && e.disagree) ? 'unclear' : 'other'; });
    }).then(function (verdict) {
      S.busy = false;
      if (verdict === null) {
        S.rpcState = 'nocon';
        log('SETUP', 'no contract answers at the escrow address', 'c-err');
      } else if (verdict === 'other') {
        S.rpcState = 'nohtlc';
        log('SETUP', 'the address answers, but not the way the swap contract answers', 'c-err');
      } else if (verdict === 'unclear') {
        /* A disagreement between the endpoints is not a verdict about the
           contract, and it is not a yes either: nothing that depends on this
           address is read as ready until they agree again. */
        S.rpcState = 'unclear';
        log('SETUP', 'the endpoints disagree about the escrow, so nothing is read as ready', 'c-err');
      } else {
        S.rpcState = 'ok';
      }
      /* The token is asked about on the same pass: a setup stored before this
         page read decimals is still on a phone, and a token that turned out to
         count in another unit has to be named before an amount is built from
         it. A chain that does not answer marks the token unread, not wrong. */
      var tokenRead = Promise.resolve();
      if (isAddr(tokenNow())) {
        tokenRead = tokenVerdict(tokenNow()).then(function (r) {
          S.tokenState = r.ok ? 'ok' : (r.why === 'unread' ? 'unread' : 'wrong');
          if (S.tokenState === 'wrong') log('SETUP', tokenWhy(r), 'c-err');
        }, function () { S.tokenState = 'unread'; });
      }
      return tokenRead.then(function () {
        paintSetup();
        renderChain();
        return S.rpcState;
      });
    }, function (e) {
      S.busy = false;
      S.rpcState = 'bad';
      renderChain();
      log('NET', 'the chain did not answer: ' + short(String((e && e.message) || e), 12), 'c-err');
      return S.rpcState;
    });
  }

  /* --------------------------------------------------- wallets that sign -- */
  function provider() {
    var eth = window.ethereum;
    return eth && typeof eth.request === 'function' ? eth : null;
  }
  function ensureChain(p) {
    return p.request({ method: 'eth_chainId' }).then(function (id) {
      if (String(id || '').toLowerCase() === curChain().chainHex) return true;
      return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: curChain().chainHex }] })
        .then(function () { return true; }, function () {
          return p.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: curChain().chainHex,
            chainName: curChain().label,
            rpcUrls: endpoints(),
            blockExplorerUrls: [curChain().explorer],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
          }] }).then(function () { return true; });
        });
    });
  }
  /* The chain a transaction lands on is the chain the wallet is on at the
     moment it signs, not the one it was on when it was asked to switch. Between
     the switch request and the signature a person can change networks in the
     wallet, and the same calldata on another chain is a call to whatever
     contract holds that address there. So the chain is read again immediately
     before every send, and a mismatch refuses the send instead of signing on
     the wrong chain. */
  function assertChain(p) {
    return p.request({ method: 'eth_chainId' }).then(function (id) {
      if (String(id || '').toLowerCase() === curChain().chainHex) return true;
      var e = new Error('the wallet is on another network now');
      e.chainSwitched = true;
      throw e;
    });
  }
  function walletSend(to, data) {
    var p = provider();
    if (!p) return Promise.reject(new Error('no wallet in this page'));
    /* Real USDT is never locked against a guessed price: without a live quote
       the wallet is not asked to sign anything. */
    if (quoteMissing()) return Promise.reject(rateError());
    /* A wallet call this page made is not made a second time while the first
       is still on its way: two claims of one escrow are one claim, and a
       wallet asked twice can charge twice. */
    if (S.sending) return Promise.reject(new Error('that call is already in flight'));
    S.sending = true;
    return ensureChain(p)
      .then(function () { return p.request({ method: 'eth_requestAccounts' }); })
      .then(function (accts) {
        var from = accts && accts[0];
        if (!from) throw new Error('the wallet shared no account');
        S.me = String(from);
        return assertChain(p).then(function () {
          return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: to, data: data, value: '0x0' }] });
        });
      })
      .then(function (h) { S.sending = false; return h; }, function (e) { S.sending = false; throw e; });
  }
  /* A transaction is only real once the chain has it: the receipt is what the
     app waits for, and the escrow reading after it is what the app believes. */
  function waitReceipt(hash) {
    var tries = 0;
    return new Promise(function (resolve, reject) {
      function again(e) {
        if (++tries > 45) return reject(e || new Error('the transaction is not mined yet'));
        setTimeout(poll, 3000);
      }
      function poll() {
        /* A receipt decides whether money moved, so it is read the way the
           escrow is: every endpoint is asked, and two answers have to agree.
           One node that has the block while another has not yet is not a
           disagreement to act on - the question is simply asked again. */
        rpcQuorum('eth_getTransactionReceipt', [hash]).then(function (rc) {
          if (rc && rc.blockNumber) {
            if (String(rc.status).toLowerCase() === '0x0') return reject(new Error('the transaction failed on chain'));
            return resolve(rc);
          }
          again();
        }, function (e) {
          if (e && e.disagree) return again();
          again(e);
        });
      }
      poll();
    });
  }

  /* ---------------------------------------------------- wallet actions --- */
  function busy(on) { S.busy = !!on; render(); }

  /* One tap, one operation. A slow phone, or a finger that lands twice, must
     not put two locks on the same USDT or two claims on the same escrow: the
     second tap is refused here, before anything is built or sent, and the
     first one decides what happens next. */
  function opStart(kind) {
    if (S.op) return false;
    S.op = kind;
    return true;
  }
  function opEnd() { S.op = ''; }
  function opWait() { toast('One moment: the last tap is still on its way.'); }

  function lockCall() {
    return { to: escrowNow(), data: lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: tokenNow(), amount: usdtUnits() }) };
  }
  function approveCall() { return { to: tokenNow(), data: approveCalldata(S.contract, usdtUnits()) }; }

  /* What a person carries to another wallet app when there is no wallet in the
     page: the call, typed out, so nothing has to be trusted to a link. */
  function callPacket(call, what) {
    return JSON.stringify({
      what: what, network: curChain().label, chainId: curChain().chainId,
      to: call.to, value: '0', data: call.data
    }, null, 2);
  }
  /* An EIP-681 link for the same call, for wallets that take one. */
  function callLink(call, fn, params) {
    var q = params && params.length ? '?' + params.join('&') : '';
    return 'ethereum:' + call.to + '@' + curChain().chainId + '/' + fn + q;
  }

  function blockChain(c) {
    var msg = chainSay(c);
    log('BLOCK', msg, 'c-err');
    S.note = msg;
    render();
    // the sentence a person reads is #say on the form, #payLine on a running swap
    if (S.phase === 'idle') {
      var say = $('say');
      say.textContent = msg;
      say.className = 'say err';
      $('stateTxt').textContent = 'Not ready';
      $('stateTxt').dataset.on = '0';
    }
    toast(msg);
  }

  /* The Approve tap, in both modes. Nothing moves on the tap itself: the USDT
     has to be in the escrow before the bitcoin leg is worth starting - this
     side locks it, or the other side already did. */
  function startSwap() {
    if (S.mode === 'wallet' && !isAddr(S.contract)) { openSetup(); log('BLOCK', 'no escrow contract is set for this chain', 'c-err'); toast('Set the escrow contract first'); return; }
    busy(true);
    return chainProbe().then(function () {
      if (S.rpcState === 'nocon') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'nothing answers at the escrow address', 'c-err');
        openSetup();
        toast('No contract answers at that address');
        return null;
      }
      if (S.rpcState === 'nohtlc') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'that address is not the swap contract, so nothing is approved', 'c-err');
        openSetup();
        toast('That address is not the swap contract');
        return null;
      }
      if (S.rpcState === 'bad') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'the chain did not answer, so nothing is approved', 'c-err');
        toast('The chain did not answer. Nothing was approved.');
        return null;
      }
      if (S.rpcState === 'unclear') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'the endpoints disagree about the escrow, so nothing is approved', 'c-err');
        toast('The two endpoints disagree about the escrow. Nothing was approved.');
        return null;
      }
      simSeed();
      return refreshChain();
    }).then(function (c) {
      if (!c) { render(); return; }
      busy(false);
      var st = c.state;
      if (st === 'claimed') { settleByChain(c); return; }
      if (st === 'refunded') { wentBack(c); return; }
      if (st === 'error') { blockChain(c); dropSwapTerms(); return; }
      if (S.direction === 'btc2u') {
        if (st === 'locked') { beginPaying(c); return; }
        /* 'none' is not a refusal: the partner has not locked yet, and the
           terms are what both sides are converging on. They stay, so the next
           tap reads the same escrow the first one described. */
        blockChain(c);
        return;
      }
      if (st === 'locked' || st === 'closed') { lockedMine(c); return; }   /* already locked: pick it up from here */
      if (st === 'mismatch') { blockChain(c); dropSwapTerms(); return; }
      beginLocking();
    });
  }

  function beginPaying(c) {
    S.phase = 'paying';
    S.note = '';
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
    log('PAY', S.direction === 'btc2u'
      ? 'waiting for the sats to leave the wallet'
      : 'waiting for the USDT to be taken');
    render();
    refreshGate();
    toast('The USDT is locked. Pay, then tap I paid');
  }

  function beginLocking() {
    if (quoteMissing()) { refuseRate(); return; }
    S.phase = 'locking';
    S.note = '';
    var p = provider();
    log('LOCK', 'one call puts ' + usdtTxt() + ' USDT in the escrow');
    render();
    if (S.mode === 'practice') { simLock(); return; }   /* no wallet here: the stand-in signs for it */
    if (!p) { toast('Copy the call into your wallet, then paste the transaction'); return; }
    runLock(p);
  }

  function runLock(p) {
    /* The approvals and the lock are one operation with a wallet: a second tap
       while the first is still being sent would ask for them all again. */
    if (S.sending) { opWait(); return; }
    /* Last line before real USDT moves: a swap whose amount came from the
       offline guess is not sent to a wallet at all. */
    if (quoteMissing()) { walletFail(rateError()); return; }
    S.sending = true;
    var amount = BigInt(usdtUnits());
    /* An approval is a transaction too: the next step only exists once it is
       mined, and a token that already allows this escrow something treats a
       second non-zero approval as a refusal, so a stale allowance is cleared to
       zero first and the new one is then exact. */
    function approveTo(v, why) {
      log('APPROVE', why);
      /* The chain is read once more here, because the approval was asked for
         some time after the switch: a wallet moved to another network in
         between would put the allowance on that chain's contract instead. */
      return assertChain(p).then(function () {
        return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: tokenNow(), data: approveCalldata(S.contract, v), value: '0x0' }] });
      }).then(function (h) {
        if (!h) throw new Error('the wallet sent nothing');
        return waitReceipt(h);
      });
    }
    busy(true);
    ensureChain(p)
      .then(function () { return p.request({ method: 'eth_requestAccounts' }); })
      .then(function (accts) {
        S.me = accts && accts[0] ? String(accts[0]) : '';
        if (!S.me) throw new Error('the wallet shared no account');
        /* The switch was requested a moment ago; the wallet is read again
           before anything is asked of it, so a person who changed networks in
           that moment is stopped before an approval goes out. */
        return assertChain(p).then(function () {
          /* What the token already allows is a state the money depends on, so it
             is read the way the escrow is: every endpoint, and two answers that
             agree before either is believed. */
          return rpcQuorum('eth_call', [{ to: tokenNow(), data: '0x' + SEL.allowance + encAddr(S.me) + encAddr(S.contract) }, 'latest']);
        });
      })
      .then(function (raw) {
        var w = abiWords(raw);
        var have = w.length ? BigInt('0x' + w[0]) : 0n;
        if (have >= amount) return null;
        if (have > 0n) {
          return approveTo(0, 'an old allowance is reset to nothing first, so the next one is exact')
            .then(function () { return approveTo(amount, 'the wallet is asked to allow ' + usdtTxt() + ' USDT'); });
        }
        return approveTo(amount, 'the wallet is asked to allow ' + usdtTxt() + ' USDT');
      })
      .then(function () {
        log('LOCK', 'the wallet is asked for the lock');
        /* The last look before the money moves: between the approval and this
           call the wallet can be switched to another network, and the same
           lock calldata there is a lock on that chain's contract at this
           chain's escrow address - or on nothing. */
        return assertChain(p).then(function () {
          return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: S.contract, data: lockCall().data, value: '0x0' }] });
        });
      })
      .then(function (h) {
        if (!h) throw new Error('the wallet sent nothing');
        S.lockTx = String(h);
        log('TX', 'lock sent');
        busy(true);
        return waitReceipt(h);
      })
      .then(function (rc) {
        /* The escrow's Locked event names the address it saw as its sender.
           When that is not the account the wallet handed this page (a smart
           contract wallet, a relayer), the event is the address that funded
           the swap, and the id is built from it. */
        var ev = readLockedLog(rc);
        if (ev && lockedLogFits(ev)) {
          S.funder = ev.sender;
          if (normHex(ev.sender) !== normHex(S.me)) {
            log('LOCK', 'the escrow was funded from ' + short(ev.sender, 6) + ', read from its Locked event');
          }
        }
        busy(false);
        return refreshChain();
      })
      .then(function (c) { S.sending = false; lockedMine(c); })
      .catch(function (e) { S.sending = false; busy(false); walletFail(e); });
  }

  function walletFail(e) {
    var m = String((e && e.message) || e || '');
    var say = (e && e.chainSwitched) ? 'Your wallet moved to another network, so nothing was sent. Switch it back to ' +
        curChain().label + ', then tap again.'
      : /denied|rejected|cancel/i.test(m) ? 'Nothing was sent: the wallet was not confirmed.'
      : /insufficient|balance|allowance/i.test(m) ? 'That wallet does not hold enough USDT for this swap.'
        : (e && e.noQuote) ? 'The live BTC price has not arrived, so nothing was locked: a swap is not priced by a guess.'
        : /already in flight/i.test(m) ? 'That call is already on its way, so nothing was sent twice.'
          : 'The wallet did not finish, so nothing has moved.';
    log('ERR', say, 'c-err');
    render();
    toast(say);
  }

  /* This side's own lock is in: the USDT is escrowed and the swap is now the
     other side's move. */
  function lockedMine(c) {
    if (c && c.state === 'claimed') { settleByChain(c); return; }
    if (c && c.state === 'refunded') { wentBack(c); return; }
    if (!c || (c.state !== 'locked' && c.state !== 'closed')) { blockChain(c); return; }
    S.phase = 'paid';
    S.note = c.state === 'closed' ? 'The escrow window has closed. The USDT can be taken back.' : '';
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT until ' + clock(S.t2) + ' local');
    render();
    refreshGate();
    startWatch();
    toast('Your USDT is locked');
  }

  function wentBack(c) {
    S.phase = 'refunded';
    stopWatch();
    log('REFUND', 'the escrow sent the ' + usdtTxt() + ' USDT back', 'c-err');
    render();
    refreshGate();
  }

  /* The payment secret is the one value that opens the bitcoin leg. It lives
     in this page only while the swap it belongs to is running: a swap that
     settled, a refund, Back, or a reset leaves neither the state nor the field
     holding it, so the next swap cannot be claimed with the last one's. */
  function clearSecret() {
    S.secret = '';
    var s = $('secretIn'); if (s) { s.value = ''; }
  }

  /* Settled means the escrow said so. Nothing else reaches this function. */
  function settleByChain(c) {
    if (!c || c.state !== 'claimed') { blockChain(c); return; }
    S.phase = 'settled';
    S.claimTx = '';
    /* The swap this secret opened is over: neither the page nor the field
       keeps it for the next one. */
    clearSecret();
    swapIdNow().then(function (id) { S.id = id; }, function () { /* terms gone */ });
    log('CLAIM', 'the escrow paid out ' + usdtTxt() + ' USDT');
    log('SETTLE', 'both legs closed on the same secret, verified on chain');
    if (S.mode === 'wallet') {
      historyEntry('Swap', S.direction === 'btc2u' ? '+' + usdtTxt() + ' USDT' : '+' + fmt(S.sats) + ' sats', 'plus');
    }
    stopWatch();
    render();
    refreshGate();
    toast('Swap complete');
  }

  /* One poll of a running swap: the chain's clock first, then the escrow. A
     window is measured against the chain, and that reading is only good for 45
     seconds; without asking again here, a swap that runs longer than a minute
     would quietly measure its window against the phone's own clock, and a
     phone whose clock is off would see the window close early or late. */
  function watchOnce() {
    if (S.phase !== 'paid') { stopWatch(); return Promise.resolve(null); }
    return syncChainTime(true).then(function () { return refreshChain(); }).then(function (c) {
      if (!c) return c;
      if (c.state === 'claimed') settleByChain(c);
      else if (c.state === 'refunded') wentBack(c);
      return c;
    });
  }
  function startWatch() {
    stopWatch();
    var every = S.mode === 'practice' ? 1200 : 12000;
    S.watch = setInterval(watchOnce, every);
    simClaim();
  }
  function stopWatch() {
    if (S.watch) { clearInterval(S.watch); S.watch = 0; }
  }

  /* ------------------------------------------------------ claim / refund -- */
  /* The secret is checked here before it is offered to the chain:
     SHA-256 of what was pasted has to be the hash this swap was locked with,
     so a typo cannot burn a transaction. */
  function doClaim() {
    var pre = normHex(S.secret);
    if (!/^[0-9a-f]{64}$/.test(pre)) { toast('Paste the 32-byte payment secret'); return; }
    /* One claim at a time: the secret is hashed, the escrow is read and a
       wallet is asked, and a second tap in the middle of that would ask for
       the whole thing again. */
    if (!opStart('claim')) { opWait(); return; }
    busy(true);
    sha256Hex(pre).then(function (h) {
      busy(false);
      if (normHex(h) !== normHex(S.H)) {
        log('BLOCK', 'that secret is not the one this swap was locked with', 'c-err');
        render();
        toast('That secret does not open this swap');
        return;
      }
      /* The stand-in escrow takes the same secret and the same reading closes
         the swap, so a rehearsal cannot be claimed with a wrong secret. */
      if (S.mode === 'practice') {
        if (!S.simRec) { blockChain({ state: 'none' }); return; }
        S.simRec.claimed = true;
        return refreshChain().then(function (c) {
          if (c && c.state === 'claimed') settleByChain(c); else blockChain(c);
        });
      }
      return swapIdNow().then(function (id) {
        var call = { to: escrowNow(), data: claimCalldata(id, '0x' + pre) };
        S.txPending = { kind: 'claim', call: call };
        var p = provider();
        if (!p) { render(); copy(callPacket(call, 'claim'), 'Claim call copied'); return; }
        busy(true);
        walletSend(call.to, call.data)
          .then(function (h) { if (!h) throw new Error('the wallet sent nothing'); busy(true); return waitReceipt(h); })
          .then(function () { busy(false); return refreshChain(); })
          .then(function (c) { if (c && c.state === 'claimed') settleByChain(c); else blockChain(c); })
          .catch(function (e) { busy(false); walletFail(e); });
      });
    }, function () { busy(false); toast('That secret cannot be read'); })
      .then(opEnd, function () { opEnd(); busy(false); });
  }

  function doRefund() {
    /* One refund at a time, for the same reason as one claim. */
    if (!opStart('refund')) { opWait(); return; }
    busy(true);
    swapIdNow().then(function (id) {
      var call = { to: escrowNow(), data: refundCalldata(id) };
      S.txPending = { kind: 'refund', call: call };
      busy(false);
      if (S.mode === 'practice') {
        if (S.simRec) S.simRec.refunded = true;
        refreshChain().then(function (c) { if (c && c.state === 'refunded') wentBack(c); else blockChain(c); });
        return;
      }
      var p = provider();
      if (!p) { render(); copy(callPacket(call, 'refund'), 'Refund call copied'); return; }
      busy(true);
      walletSend(call.to, call.data)
        .then(function (h) { if (!h) throw new Error('the wallet sent nothing'); busy(true); return waitReceipt(h); })
        .then(function () { busy(false); return refreshChain(); })
        .then(function (c) {
          if (c && c.state === 'refunded') wentBack(c);
          else blockChain(c);
        })
        .catch(function (e) { busy(false); walletFail(e); });
    }, function () { busy(false); toast('These terms are not readable yet'); })
      .then(opEnd, function () { opEnd(); busy(false); });
  }

  /* A transaction hash pasted back from a wallet that cannot be reached from
     the page: the receipt is the proof, and the reading after it decides. */
  function loadTx(hash) {
    var h = String(hash || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) { toast('Paste the transaction hash'); return; }
    busy(true);
    var waited = S.mode === 'practice' ? simReceipt() : waitReceipt(h);
    waited.then(function (rc) {
      busy(false);
      /* The id names the address that funded the escrow. The side that does
         not fund it learns that address from the lock transaction itself,
         after checking that the escrow recorded this swap's terms. */
      if (S.mode !== 'wallet' || isAddr(lockerNow())) return null;
      /* The escrow's own Locked event is the address it saw as msg.sender. A
         smart contract wallet (a Safe, an account-abstraction wallet) is that
         sender, while the transaction's `from` is only the key or bundler that
         relayed it - so the event is read first, and only a receipt with no
         log at all falls back to the transaction's sender. */
      var ev = readLockedLog(rc);
      if (ev) {
        if (!lockedLogFits(ev)) {
          log('BLOCK', 'that transaction locked different terms, so its address is not this swap\u2019s', 'c-err');
          render();
          toast('That transaction is not the lock for this swap');
          return null;
        }
        S.funder = ev.sender;
        log('LOCK', 'the escrow was funded from ' + short(ev.sender, 6) + ', read from its Locked event');
        /* The event is also where the terms come back when no swap code ever
           reached this phone: the window's end is written in it, and the
           hashlock and receiver the fit check just verified against this
           screen's invoice and address can be carried into the swap, so the
           escrow can be read at all. A side without them used to be shown a
           chain error that was really a missing code. */
        var t = termsOnScreen();
        if (!S.H && t.H) S.H = t.H;
        if (!S.addr && isAddr(t.addr)) S.addr = t.addr;
        if (!S.t2 && Number(ev.timelock) > 0) {
          S.t2 = Number(ev.timelock);
          if (!S.t1) S.t1 = curHeight() + T1_BLOCKS;
          log('CODE', 'no swap code was loaded, so the window came from the escrow\u2019s own event: ends ' + clock(S.t2));
        }
        return null;
      }
      if (rc && rc.logs && rc.logs.length) {
        log('BLOCK', 'that transaction carries no lock for this swap', 'c-err');
        render();
        toast('That transaction is not the lock for this swap');
        return null;
      }
      /* A receipt that carries no logs cannot say who sent the lock. For a
         wallet that signs for itself the transaction's own sender is the
         funding address, and the escrow read after this decides either way. */
      return rpcQuorum('eth_getTransactionByHash', [h]).then(function (tx) {
        var to = tx && tx.to ? String(tx.to).toLowerCase() : '';
        var input = tx && tx.input ? String(tx.input).toLowerCase() : '';
        if (!tx || !isAddr(tx.from) || to !== String(S.contract || '').toLowerCase() ||
          input.slice(0, 10) !== ('0x' + SEL.lock).toLowerCase()) return null;
        S.funder = String(tx.from).toLowerCase();
        log('LOCK', 'the escrow was funded from ' + short(tx.from, 6) + ', read from the transaction');
        /* A plain wallet's lock call states the terms itself - the same
           calldata the escrow reads. The window comes from there when the
           code never did, and the hashlock has to be the one this screen's
           invoice names: a lock against another hash is not this swap. */
        var dec = decodeLockCalldata(tx.input);
        if (dec) {
          var t = termsOnScreen();
          if (t.H && normHex(dec.hashlock) !== normHex(t.H)) {
            log('BLOCK', 'that transaction locks a different hash, so it is not this swap\u2019s lock', 'c-err');
            toast('That transaction is not the lock for this swap');
            S.funder = '';
            return null;
          }
          if (!S.H && t.H) S.H = t.H;
          if (!S.addr && isAddr(dec.receiver) && isAddr(t.addr) &&
            String(dec.receiver).toLowerCase() === t.addr.toLowerCase()) S.addr = t.addr;
          if (!S.t2 && Number(dec.timelock) > 0) {
            S.t2 = Number(dec.timelock);
            if (!S.t1) S.t1 = curHeight() + T1_BLOCKS;
            log('CODE', 'no swap code was loaded, so the window came from the lock call itself: ends ' + clock(S.t2));
          }
        }
        return null;
      }, function () { return null; });
    }).then(function () {
      /* The escrow is read with the terms, and without them there is no id
         to read under. Say what is missing instead of showing a chain
         connection error that would only send the person looking at the
         wrong thing. */
      if (!S.t2) {
        var msg = 'The terms are incomplete: load the swap code from your partner first.';
        log('CODE', 'the escrow cannot be read without the terms a swap code carries', 'c-err');
        S.note = msg;
        render();
        toast(msg);
        return null;
      }
      return refreshChain();
    }).then(function (c) {
      if (!c) return;
      if (S.phase === 'locking') { lockedMine(c); return; }
      if (c.state === 'claimed') settleByChain(c);
      else if (c.state === 'refunded') wentBack(c);
      else if (c.state === 'locked') { render(); toast('The escrow has it'); }
      else blockChain(c);
    }, function (e) {
      busy(false);
      log('ERR', 'that transaction is not on chain yet', 'c-err');
      render();
      toast('That transaction is not on chain yet');
    });
  }

  /* --------------------------------------------------------- secp256k1 -------
     A BOLT11 invoice is a signed promise by whoever holds the payee's key, and
     a payer is meant to check that before the sats leave. The page carries no
     dependencies and runs off-line, so the curve arithmetic lives here: point
     addition in Jacobian coordinates, ECDSA recovery (an invoice names its
     payee in an `n` tag only sometimes, so the key usually has to come back
     out of the signature), ECDSA verification, and deterministic signing
     (RFC 6979) for the rehearsal's own sample invoices - they have to be the
     same shape as a real one to be read by the same code.

     Checked against the BOLT #11 test vectors (test/bolt11-vectors.json) and,
     for what the app signs itself, against an independent verifier in
     test/invoice-crosscheck.py. */
  var SECP = (function () {
    var P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
    var N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    var GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
    var GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
    var G = { x: GX, y: GY, z: 1n };
    var HALF = N >> 1n;
    var INF = { x: 0n, y: 1n, z: 0n };

    function mod(a, m) { var r = a % m; return r < 0n ? r + m : r; }
    function powm(b, e, m) {
      var r = 1n, base = mod(b, m);
      while (e > 0n) { if (e & 1n) r = r * base % m; base = base * base % m; e >>= 1n; }
      return r;
    }
    function inv(a, m) {
      var t = 0n, nt = 1n, r = m, nr = mod(a, m), q, tmp;
      if (nr === 0n) throw new Error('not invertible');
      while (nr !== 0n) {
        q = r / nr; tmp = t - q * nt; t = nt; nt = tmp;
        tmp = r - q * nr; r = nr; nr = tmp;
      }
      if (r !== 1n) throw new Error('not invertible');
      return mod(t, m);
    }
    function dbl(p) {
      if (p.z === 0n || p.y === 0n) return INF;
      var A = p.x * p.x % P, B = p.y * p.y % P, C = B * B % P;
      var t = (p.x + B) % P;
      var D = mod(2n * (mod(t * t - A - C, P)), P);
      var E = 3n * A % P, F = E * E % P;
      var x = mod(F - 2n * D, P);
      var y = mod(E * mod(D - x, P) - 8n * C, P);
      return { x: x, y: y, z: 2n * p.y % P * p.z % P };
    }
    function add(p, q) {
      if (p.z === 0n) return q;
      if (q.z === 0n) return p;
      var z1z1 = p.z * p.z % P, z2z2 = q.z * q.z % P;
      var u1 = p.x * z2z2 % P, u2 = q.x * z1z1 % P;
      var s1 = p.y * q.z % P * z2z2 % P, s2 = q.y * p.z % P * z1z1 % P;
      if (u1 === u2) return s1 === s2 ? dbl(p) : INF;
      var h = mod(u2 - u1, P), i = 4n * h % P * h % P, j = h * i % P;
      var r = 2n * mod(s2 - s1, P), v = u1 * i % P;
      var x = mod(r * r - j - 2n * v, P);
      var y = mod(r * mod(v - x, P) - 2n * s1 % P * j % P, P);
      var z = mod((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2, P) * h % P;
      return { x: x, y: y, z: z };
    }
    function mul(k, p) {
      var e = k, r = INF, base = p;
      while (e > 0n) { if (e & 1n) r = add(r, base); base = dbl(base); e >>= 1n; }
      return r;
    }
    function affine(p) {
      if (!p || p.z === 0n) return null;
      var zi = inv(p.z, P), zi2 = zi * zi % P;
      return { x: p.x * zi2 % P, y: p.y * zi2 % P * zi % P };
    }
    function onCurve(x, y) { return mod(y * y - (x * x % P * x % P + 7n), P) === 0n; }
    function toBig(bytes) {
      var v = 0n, i;
      for (i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
      return v;
    }
    function to32(v) {
      var out = new Uint8Array(32), i, x = mod(v, 1n << 256n);
      for (i = 31; i >= 0; i--) { out[i] = Number(x & 255n); x >>= 8n; }
      return out;
    }
    function sigParts(sigHex) {
      var h = normHex(sigHex);
      if (h.length !== 130) throw new Error('a signature is 65 bytes');
      var b = fromHex(h);
      return { r: toBig(b.subarray(0, 32)), s: toBig(b.subarray(32, 64)), rec: b[64] };
    }
    /* A public key, compressed (02/03 + x) or whole (x + y). */
    function pointOf(pubHex) {
      var h = normHex(pubHex), b, x, y, y2;
      if (h.length === 66) {
        b = fromHex(h);
        if (b[0] !== 2 && b[0] !== 3) return null;
        x = toBig(b.subarray(1));
        if (x >= P) return null;
        y2 = mod(x * x % P * x % P + 7n, P);
        y = powm(y2, (P + 1n) / 4n, P);
        if (mod(y * y - y2, P) !== 0n) return null;
        if ((y & 1n) !== (b[0] === 3 ? 1n : 0n)) y = P - y;
        return { x: x, y: y, z: 1n };
      }
      if (h.length === 130) {
        b = fromHex(h);
        x = toBig(b.subarray(0, 32)); y = toBig(b.subarray(32, 64));
        return onCurve(x, y) ? { x: x, y: y, z: 1n } : null;
      }
      return null;
    }
    function compress(pt) {
      var x = hexOf(to32(pt.x));
      return ((pt.y & 1n) ? '03' : '02') + x;
    }
    function hashBig(hashHex) { return toBig(fromHex(normHex(hashHex))); }

    /* ECDSA verify; lowS is what BOLT requires when the invoice names its key. */
    function verify(hashHex, sigHex, pubHex, lowS) {
      var p = pointOf(pubHex), sg;
      if (!p) return false;
      try { sg = sigParts(sigHex); } catch (e) { return false; }
      if (sg.r <= 0n || sg.r >= N || sg.s <= 0n || sg.s >= N) return false;
      if (lowS && sg.s > HALF) return false;
      var z = hashBig(hashHex), w = inv(sg.s, N);
      var pt = affine(add(mul(mod(z * w, N), G), mul(mod(sg.r * w, N), p)));
      return !!pt && mod(pt.x, N) === sg.r;
    }

    /* The payee's key, recovered from the signature itself. */
    function recover(hashHex, sigHex) {
      var sg;
      try { sg = sigParts(sigHex); } catch (e) { return null; }
      if (sg.rec > 3 || sg.r <= 0n || sg.r >= N || sg.s <= 0n || sg.s >= N) return null;
      var x = sg.r + (sg.rec >= 2 ? N : 0n);
      if (x >= P) return null;
      var y2 = mod(x * x % P * x % P + 7n, P);
      var y = powm(y2, (P + 1n) / 4n, P);
      if (mod(y * y - y2, P) !== 0n) return null;
      if ((y & 1n) !== (sg.rec & 1 ? 1n : 0n)) y = P - y;
      var z = hashBig(hashHex), ri = inv(sg.r, N);
      var Q = affine(add(mul(mod(sg.s * ri, N), { x: x, y: y, z: 1n }), mul(mod(-z * ri, N), G)));
      return Q && onCurve(Q.x, Q.y) ? Q : null;
    }

    function hmac(key, msg) {
      var k = new Uint8Array(64), i, ip = new Uint8Array(64), op = new Uint8Array(64);
      k.set(key.length > 64 ? sha256Bytes(key) : key);
      for (i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
      var inner = catBytes(ip, msg), outer = catBytes(op, sha256Bytes(inner));
      return sha256Bytes(outer);
    }
    /* RFC 6979: the nonce is a function of the key and the message, so the same
       invoice terms always sign to the same string. */
    function nonce(d, hash) {
      var x = to32(d), h1 = to32(mod(toBig(hash), N));
      var K = new Uint8Array(32), V = new Uint8Array(32).fill(1), i;
      K = hmac(K, catBytes(catBytes(V, new Uint8Array([0])), catBytes(x, h1)));
      V = hmac(K, V);
      K = hmac(K, catBytes(catBytes(V, new Uint8Array([1])), catBytes(x, h1)));
      V = hmac(K, V);
      for (i = 0; i < 1000; i++) {
        V = hmac(K, V);
        var k = toBig(V);
        if (k > 0n && k < N) return k;
        K = hmac(K, catBytes(V, new Uint8Array([0])));
        V = hmac(K, V);
      }
      throw new Error('no nonce');
    }
    /* A 65-byte signature: r, s, and the recovery byte, low-S as the standard
       asks, so a verifier that only accepts low-S reads it too. */
    function sign(hashHex, privHex) {
      var d = toBig(fromHex(normHex(privHex)));
      if (d <= 0n || d >= N) throw new Error('bad key');
      var hash = fromHex(normHex(hashHex)), z = toBig(hash);
      var k = nonce(d, hash), R = affine(mul(k, G));
      if (!R) throw new Error('bad nonce');
      var r = mod(R.x, N);
      if (r === 0n) throw new Error('bad nonce');
      var s = mod(inv(k, N) * mod(z + r * d, N), N);
      if (s === 0n) throw new Error('bad nonce');
      var rec = (R.y & 1n ? 1 : 0) | (R.x >= N ? 2 : 0);
      if (s > HALF) { s = N - s; rec = rec ^ 1; }
      return hexOf(catBytes(catBytes(to32(r), to32(s)), new Uint8Array([rec])));
    }

    return { verify: verify, recover: recover, sign: sign, compress: compress, pointOf: pointOf };
  })();
  /* The rehearsal's invoices are signed with this key and no other: it holds
     nothing, belongs to no node, and exists so a sample invoice is a real
     BOLT11 rather than a string shaped like one. */
  var PRACTICE_KEY = '2f1c8bd6a4e0793d5c1b8a6f47e293d0c5b8f17a26d4e9038b7c15fa6d2e4093';

  /* ------------------------------------------------------ bech32 / BOLT11 -- */
  var B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function polymod(values) {
    var chk = 1, i, j, b;
    for (i = 0; i < values.length; i++) {
      b = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[i];
      for (j = 0; j < 5; j++) if ((b >>> j) & 1) chk ^= GEN[j];
    }
    return chk >>> 0;
  }
  function hrpExpand(hrp) {
    var out = [], i;
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }
  function bech32Words(str) {
    var s = String(str).replace(/\s+/g, '').replace(/\+/g, ''), words = [], i, v;
    if (!s) throw new Error('empty string');
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
    s = s.toLowerCase();
    var pos = s.lastIndexOf('1');
    if (pos < 1 || pos + 1 >= s.length) throw new Error('missing separator');
    var hrp = s.slice(0, pos), data = s.slice(pos + 1);
    for (i = 0; i < data.length; i++) {
      v = B32.indexOf(data.charAt(i));
      if (v < 0) throw new Error('invalid character "' + data.charAt(i) + '"');
      words.push(v);
    }
    return { hrp: hrp, words: words };
  }
  /* BOLT11: bech32 with a 6-word checksum, no 90-character limit. */
  function bech32Decode(str) {
    var r = bech32Words(str);
    if (r.words.length < 6) throw new Error('too short');
    var body = r.words.slice(0, -6);
    if (polymod(hrpExpand(r.hrp).concat(r.words)) !== 1) throw new Error('bech32 checksum failed');
    return { hrp: r.hrp, words: body };
  }
  function wordsToBytes(words) {
    var acc = 0, bits = 0, out = [], i;
    for (i = 0; i < words.length; i++) {
      acc = (acc << 5) | words[i]; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  /* bech32 carries 5-bit groups: whatever is left of the last group must be
     zero, or the string is not the canonical encoding of those bytes. */
  function paddingClean(byteLen, words) {
    var bits = words.length * 5 - byteLen * 8;
    if (bits <= 0) return true;
    return (words[words.length - 1] & ((1 << bits) - 1)) === 0;
  }
  /* The 5-bit groups as bytes with the last group zero-padded, which is the
     byte string BOLT11 signs (the payload groups do not have to end on a byte
     boundary). */
  function wordsToBytesPad(words) {
    var acc = 0, bits = 0, out = [], i;
    for (i = 0; i < words.length; i++) {
      acc = (acc << 5) | words[i]; bits += 5;
      while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); }
    }
    if (bits > 0) out.push((acc << (8 - bits)) & 255);
    return new Uint8Array(out);
  }
  /* A big-endian integer held in bytes, as a BOLT11 field carries its fees. */
  function beNum(u8) {
    var v = 0n, i;
    for (i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]);
    return toNum(v, 'field');
  }
  function bytesToWords(bytes) {
    var acc = 0, bits = 0, out = [], i;
    for (i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
    }
    if (bits) out.push((acc << (5 - bits)) & 31);
    return out;
  }
  /* Tagged integers are big-endian; a 35-bit timestamp and an expiry are read
     as BigInt and only become a Number once they are known to fit one. */
  function wordsToInt(words) {
    var n = 0n, i;
    for (i = 0; i < words.length; i++) n = n * 32n + BigInt(words[i] | 0);
    return n;
  }
  function intWords(n, len) {
    var v = BigInt(n), out = [], i;
    for (i = len - 1; i >= 0; i--) out.push(Number((v >> BigInt(5 * i)) & 31n));
    return out;
  }
  /* minimal base-32 digits, no zero padding: tagged fields are big-endian
     integers, and a padded word would scale the value by 16 */
  function intToVec(n) {
    var v = BigInt(n), out = [];
    if (v === 0n) return [0];
    while (v > 0n) { out.unshift(Number(v & 31n)); v >>= 5n; }
    return out;
  }
  function utf8(str) {
    if (window.TextEncoder) return new TextEncoder().encode(String(str));
    return new Uint8Array(unescape(encodeURIComponent(String(str))).split('').map(function (c) { return c.charCodeAt(0); }));
  }
  function decodeBolt11(raw) {
    var inv = String(raw).trim().replace(/^lightning:/i, '');
    if (!/^ln[a-z]+/i.test(inv)) throw new Error('not a BOLT11 invoice');
    var dec = bech32Decode(inv), hrp = dec.hrp, words = dec.words;
    var m = hrp.match(/^ln([a-z]+?)(\d+)?([munp]?)$/);
    if (!m) throw new Error('unrecognised human-readable part "' + hrp + '"');
    if (words.length < 7 + 104) throw new Error('invoice body too short');
    /* The amount is a decimal in the human-readable part: 1m = 1e-3 BTC and so
       on. It is scaled in BigInt, so an invoice is never read as an amount it
       does not state, and one finer than a satoshi is refused. */
    var AMT = { '': 0, m: 3, u: 6, n: 9, p: 12 };
    var sats = null;
    if (m[2]) {
      var scaled = BigInt(m[2]) * 100000000n, div = 10n ** BigInt(AMT[m[3] || '']);
      if (scaled % div !== 0n) throw new Error('the amount is finer than a satoshi');
      sats = toNum(scaled / div, 'amount');
    }
    var ts = toNum(wordsToInt(words.slice(0, 7)), 'timestamp');
    var body = words.slice(7, words.length - 104), fields = {}, i = 0, type, len, ch;
    /* A tag that states one term may appear once. Two payment hashes, or two
       expiries, would let a reader and a writer disagree about which one the
       signature covers. Route hints (`r`) and fallback addresses (`f`) are
       lists by nature: a wallet with several private channels sends a hint per
       channel, and Phoenix, Breez and Zeus all do - so those two accumulate,
       and every hint is read rather than the whole invoice refused. */
    var LIST_TAGS = { r: 1, f: 1 };
    while (i + 3 <= body.length) {
      type = body[i];
      len = (body[i + 1] << 5) | body[i + 2];
      if (i + 3 + len > body.length) throw new Error('truncated field');
      /* BOLT 11: the type is a 5-bit number written as the bech32 character at
         that position (`p` is 1, `d` is 13, `x` is 6) - not the letter's place
         in the alphabet. */
      ch = B32.charAt(type);
      if (type >= 1 && type <= 26 && ch) {
        if (fields[ch]) {
          if (!LIST_TAGS[ch]) throw new Error('the invoice carries two "' + ch + '" fields');
          fields[ch].push(body.slice(i + 3, i + 3 + len));
        } else {
          fields[ch] = [body.slice(i + 3, i + 3 + len)];
        }
      }
      i += 3 + len;
    }
    /* Every route hint, hop by hop: a node id, the short channel id, the base
       fee, the proportional fee and the delta. Nothing is decided from them
       here; an invoice that carries them is simply not refused for it. */
    var routeHints = [], fallbacks = [];
    (fields.r || []).forEach(function (f) {
      var b = wordsToBytes(f), j;
      for (j = 0; j + 51 <= b.length; j += 51) {
        routeHints.push({
          nodeId: hexOf(b.subarray(j, j + 33)),
          shortChannelId: hexOf(b.subarray(j + 33, j + 41)),
          baseMsat: beNum(b.subarray(j + 41, j + 45)),
          ppm: beNum(b.subarray(j + 45, j + 49)),
          cltv: beNum(b.subarray(j + 49, j + 51))
        });
      }
    });
    /* A fallback address is a 5-bit version and the address itself; more than
       one is allowed, and each is kept as it was written. */
    (fields.f || []).forEach(function (f) {
      if (!f.length) return;
      fallbacks.push({ version: f[0], program: hexOf(wordsToBytes(f.slice(1))) });
    });
    var ph = fields.p && fields.p[0];
    /* BOLT 11: an invoice with no `x` field expires 3600 seconds after its
       timestamp. Reading a missing tag as "never expires" would hand the
       escrow-window check an invoice that outlives every window, so the
       standard default is what a missing tag means here too. */
    var expiry = fields.x && fields.x[0] ? toNum(wordsToInt(fields.x[0]), 'expiry') : 3600;
    var desc = null;
    if (fields.d && fields.d[0]) {
      try { desc = new TextDecoder('utf-8', { fatal: true }).decode(wordsToBytes(fields.d[0])); }
      catch (e) { throw new Error('the description is not text'); }
    }

    /* The signature: 65 bytes over SHA-256(hrp + the data words), the last 104
       words. The payee is named in an `n` tag only sometimes; otherwise the
       key comes back out of the signature, which is how a payer checks that
       the invoice was not edited or invented. */
    var sigHex = hexOf(wordsToBytesPad(words.slice(words.length - 104)));
    var pre = catBytes(utf8(hrp), wordsToBytesPad(words.slice(0, words.length - 104)));
    var msg = hexOf(sha256Bytes(pre));
    var named = fields.n && fields.n[0] && fields.n[0].length === 53 ? hexOf(wordsToBytes(fields.n[0])) : null;
    var node = named;
    if (named) {
      if (!SECP.pointOf(named)) throw new Error('the invoice names a key that is not on the curve');
      if (!SECP.verify(msg, sigHex, named, true)) throw new Error('the signature does not match the key the invoice names');
    } else {
      var pt = SECP.recover(msg, sigHex);
      if (!pt) throw new Error('the signature cannot be recovered');
      node = SECP.compress(pt);
      if (!SECP.verify(msg, sigHex, node, false)) throw new Error('the signature does not verify');
    }
    /* An invoice with no amount asks the payer to choose one: nothing here can
       bind a swap to it, so it is refused rather than read as "any amount".
       Read last, so a broken signature or a doubled field is what it says it is
       - an invoice is judged field by field before its amount matters. */
    if (sats == null || sats <= 0) throw new Error('the invoice states no amount');

    return {
      kind: 'bolt11',
      network: m[1],
      sats: sats,
      paymentHash: ph && ph.length === 52 ? '0x' + hexOf(wordsToBytes(ph)) : null,
      timestamp: ts,
      expiry: expiry,
      expiresAt: ts + expiry,
      description: desc,
      nodeId: node,
      signed: true,
      routeHints: routeHints,
      fallbacks: fallbacks,
      tags: Object.keys(fields).sort().join('')
    };
  }

  /* BOLT11 encoder — a hold invoice whose payment_hash the payer cannot choose.

     Field order follows the spec: 35-bit timestamp, then tagged fields, then a
     65-byte signature slot (104 words, exactly). The slot is a real secp256k1
     signature by the practice key over SHA-256(hrp + the data words), so a
     sample invoice passes the same check a partner's real invoice has to pass
     - the key belongs to no node and signs nothing anyone can pay. */
  function amountPart(sats) {
    if (!sats) return '';
    if (sats % 100 === 0) return (sats / 100) + 'u';   /* 1u = 100 sats */
    return (sats * 10) + 'n';                          /* 1n = 0.1 sats */
  }
  function tagField(ch, words) {
    var type = B32.indexOf(ch);
    if (type < 1) throw new Error('bad invoice tag "' + ch + '"');
    return [type, words.length >> 5, words.length & 31].concat(words);
  }
  function bech32Checksum(hrp, words) {
    var p = polymod(hrpExpand(hrp).concat(words).concat([0, 0, 0, 0, 0, 0])) ^ 1, out = [], i;
    for (i = 0; i < 6; i++) out.push((p >>> (5 * (5 - i))) & 31);
    return out;
  }
  function assembleBech32(hrp, body) {
    var data = body.concat(bech32Checksum(hrp, body)), out = hrp + '1', i;
    for (i = 0; i < data.length; i++) out += B32.charAt(data[i]);
    return out;
  }
  /* BOLT12 strings carry no checksum: the words are the TLVs, verbatim. */
  function assembleRaw(hrp, words) {
    var out = hrp + '1', i;
    for (i = 0; i < words.length; i++) out += B32.charAt(words[i]);
    return out;
  }
  function mintInvoice(o) {
    var net = o.network || NET;
    var hrp = 'ln' + net + amountPart(o.sats);
    var ts = o.timestamp || nowSec();
    var x = o.expiry == null ? T2_SPAN : o.expiry;
    var seed = fromHex(o.paymentHash);
    function build(desc, expiry) {
      var body = intWords(ts, 7).concat(tagField('p', bytesToWords(seed)));
      if (desc) body = body.concat(tagField('d', bytesToWords(utf8(desc))));
      if (expiry != null) body = body.concat(tagField('x', intToVec(expiry)));
      var msg = hexOf(sha256Bytes(catBytes(utf8(hrp), wordsToBytesPad(body))));
      var sig = bytesToWords(fromHex(SECP.sign(msg, PRACTICE_KEY)));
      return assembleBech32(hrp, body.concat(sig));
    }
    var out = build(null, o.noExpiry ? null : x);
    if (o.description) {
      var withDesc = build(o.description, o.noExpiry ? null : x);
      if (withDesc.length <= QR_M) out = withDesc;
    }
    return out;
  }

  /* ------------------------------------------------- BOLT12 offers/invoices --
     TLVs over bech32 without a checksum. An invoice carries the standard
     invoice_payment_hash (168); an offer cannot carry one at all. Offers are
     still decoded so one can be recognised and explained, but a swap never
     binds to an offer. The type-80 TLV is this app's own tag and is reported
     separately - it is never mistaken for the payment hash. */
  function readBigSize(u8, i) {
    if (i >= u8.length) return null;
    var b = u8[i], v, j;
    if (b < 0xfd) return { value: b, next: i + 1 };
    if (b === 0xfd) {
      if (i + 2 >= u8.length) throw new Error('truncated BigSize');
      return { value: (u8[i + 1] << 8) | u8[i + 2], next: i + 3 };
    }
    if (b === 0xfe) {
      if (i + 4 >= u8.length) throw new Error('truncated BigSize');
      return { value: (u8[i + 1] * 0x1000000) + (u8[i + 2] << 16) + (u8[i + 3] << 8) + u8[i + 4], next: i + 5 };
    }
    if (i + 8 >= u8.length) throw new Error('truncated BigSize');
    v = 0n;
    for (j = 1; j <= 8; j++) v = (v << 8n) | BigInt(u8[i + j]);
    return { value: toNum(v, 'length'), next: i + 9 };
  }
  var OFFER_TYPES = {
    2: 'offer_chains', 4: 'offer_metadata', 6: 'offer_currency', 8: 'offer_amount',
    10: 'offer_description', 12: 'offer_features', 14: 'offer_absolute_expiry',
    16: 'offer_paths', 18: 'offer_issuer', 20: 'offer_quantity_max',
    22: 'node_id', 80: 'signature'
  };
  /* type 80 is this app's own tag for a hashlock carried on an offer string. */
  var SWAP_HASH_TYPE = 80;
  /* Blinded paths arrive as one TLV per path, so 16 (offer_paths) and 160
     (invoice_paths) may repeat; every other field appears once, and a second
     copy of one would let a reader and a writer see different terms. */
  var REPEATABLE_TLV = { 16: 1, 160: 1 };
  function decodeSwapOffer(raw) {
    var o = String(raw).trim().replace(/^lightning:/i, '');
    if (!/^ln[io]1/i.test(o)) throw new Error('not a BOLT12 string');
    var r = bech32Words(o), bytes = wordsToBytes(r.words), fields = {}, order = [], i = 0, t, l;
    if (!paddingClean(bytes.length, r.words)) throw new Error('not a clean BOLT12 string');
    while (i < bytes.length) {
      t = readBigSize(bytes, i);
      if (!t) break;
      i = t.next;
      l = readBigSize(bytes, i);
      if (!l) break;
      i = l.next;
      if (i + l.value > bytes.length) throw new Error('truncated TLV');
      if (fields[t.value] !== undefined && !REPEATABLE_TLV[t.value]) {
        throw new Error('two "' + t.value + '" fields');
      }
      fields[t.value] = bytes.slice(i, i + l.value);
      order.push(t.value);
      i += l.value;
    }
    var dec = new TextDecoder();
    /* Amounts and times are read as BigInt and only become a Number when they
       fit one: a u64 millisatoshi amount does not fit 2^53. */
    function beUint(u8) {
      var v = 0n, j;
      for (j = 0; j < u8.length; j++) v = (v << 8n) | BigInt(u8[j]);
      return v;
    }
    function num(type) { return fields[type] == null ? null : toNum(beUint(fields[type]), 'field ' + type); }
    function msat(type) { return fields[type] == null ? null : toNum(beUint(fields[type]) / 1000n, 'amount'); }
    function txt(type) { return fields[type] ? dec.decode(fields[type]) : null; }
    var form = /^lni1/i.test(o) ? 'invoice' : 'offer';
    /* An invoice states when it was made (164) and how long it stays payable
       (166), and both are required by the format. A reader that treated a
       missing 164 as "no expiry" would let a stale invoice past every window
       check, so a missing or wrongly sized one is refused here instead of
       being read as an invoice that never ends. */
    if (form === 'invoice') {
      if (!fields[164] || fields[164].length !== 8) throw new Error('an invoice with no creation time');
      if (!fields[166] || fields[166].length !== 8) throw new Error('an invoice with no expiry');
    }
    /* Random text that happens to sit inside the bech32 alphabet still has to
       look like an offer before it is worth anything: a node id, offer chains
       or blinded paths, and a real 64-byte signature when one is present. */
    if (form === 'offer') {
      if (fields[240] && fields[240].length !== 64) throw new Error('bad signature field');
      var node = fields[22], chains = fields[2], paths = fields[16];
      if (!(node && node.length === 33) && !(chains && chains.length && chains.length % 32 === 0) &&
        !(paths && paths.length)) throw new Error('no offer identity');
    }
    var hash = fields[SWAP_HASH_TYPE];
    return {
      kind: 'bolt12',
      form: form,
      hrp: r.hrp,
      network: r.hrp.length > 3 ? r.hrp.slice(3) : 'bitcoin',
      /* only the standard invoice field counts as a payment hash; an invoice
         that also carries type 80 does not get to choose a different one */
      paymentHash: form === 'invoice' && fields[168] && fields[168].length === 32 ? '0x' + hexOf(fields[168]) : null,
      hashlockTag: hash && hash.length === 32 ? '0x' + hexOf(hash) : null,
      sats: fields[170] ? msat(170) : (fields[8] && !fields[6] ? msat(8) : null),
      amount: num(8),
      currency: txt(6),
      description: txt(10),
      issuer: txt(18),
      /* An invoice's expiry is the moment it was made plus how long it stays
         payable, both read as BigInt; an offer states an absolute one (14)
         and states no moment of creation. */
      absoluteExpiry: form === 'invoice'
        ? toNum(beUint(fields[164]) + beUint(fields[166]), 'expiry')
        : (fields[14] ? toNum(beUint(fields[14]), 'expiry') : null),
      createdAt: num(164),
      relativeExpiry: num(166),
      nodeId: fields[22] ? hexOf(fields[22]) : (fields[160] && fields[160].length === 33 ? hexOf(fields[160]).slice(2) : null),
      quantityMax: num(20),
      payload: bytes,
      types: order.sort(function (a, b) { return a - b; }).map(function (x) {
        return x + (OFFER_TYPES[x] ? ' ' + OFFER_TYPES[x] : '');
      })
    };
  }
  /* Mint a BOLT12 offer for a swap: amount in the HRP (msat), the swap
     hashlock in the type-80 TLV, a description, an absolute expiry, a node id
     and a 64-byte signature slot (not verified by the app, said in the log). */
  function mintOffer(o) {
    var sats = o.sats, msat = sats * 1000;
    var hash = fromHex(o.paymentHash);
    function bigsize(n) {
      if (n < 0xfd) return [n];
      if (n <= 0xffff) return [0xfd, n >> 8, n & 255];
      return [0xfe, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    }
    function tlv(type, val) { return bigsize(type).concat(bigsize(val.length), Array.prototype.slice.call(val)); }
    function u64(n) { var out = []; for (var k = 7; k >= 0; k--) out.push(Number((BigInt(n) >> BigInt(8 * k)) & 255n)); return out; }
    var tlvs = [].concat(
      tlv(8, u64(msat)),
      tlv(10, Array.prototype.slice.call(utf8(o.description || 'CleanSwap swap offer'))),
      tlv(14, u64((o.timestamp || nowSec()) + (o.expiry == null ? T2_SPAN : o.expiry))),
      tlv(22, Array.prototype.slice.call(fromHex(o.nodeId || '02d40d722b8fa32f8c588757c481462b27dadfece667ea0c662daa0e6d8a8b595e'))),
      tlv(80, Array.prototype.slice.call(hash)),
      tlv(240, new Array(64).fill(0))
    );
    return assembleRaw('lno', bytesToWords(new Uint8Array(tlvs)));
  }

  /* ---------------------------------------------------------- calldata --- */
  /* Only an EVM address has a lock() call here: a TRON address is a wallet-level
     hand-off, so the app does not pretend to build calldata for it. */
  function escrowProof() {
    if (!isAddr(S.addr)) return '';
    return lockCalldata({
      hashlock: S.H, timelock: S.t2, receiver: S.addr,
      token: tokenNow(), amount: usdtUnits()
    });
  }
  /* The escrow half of the swap, as the contract call the page would send:
     lock(H, T2, the USDT receiver, the token, the amount). */
  function nextCalldata() {
    if (!S.H || !S.addr || !S.t2 || !isAddr(S.addr)) return '';
    return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: tokenNow(), amount: usdtUnits() });
  }

  /* ------------------------------------------------------- swap code -----
     The other side needs the same terms: who sends what, how much, and how
     long the window lasts - plus, once it is known, the swap's hashlock and
     the USDT address. That is all a code carries. It is `cleanswap:` plus
     base64url JSON: no host, no file path, no name, and nothing is ever built
     out of location.href, so a message app, a printed QR and any camera app
     can carry it to the other phone. */
  var CODE_PREFIX = 'cleanswap:';
  var B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /* Binary fields inside the JSON code are base64url with a leading `~` (a
     character neither hex, base58 nor base64url uses), so the wallet code - a
     hash, three addresses and the terms - still fits a version-13 QR. A field
     without the marker is read exactly as earlier versions wrote it. */
  function b64field(hex) {
    var h = normHex(hex), bytes = [], i;
    for (i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    return '~' + b64urlEncode(String.fromCharCode.apply(null, bytes));
  }
  function unB64field(v) {
    var s = String(v || '');
    if (s.charAt(0) !== '~') return '';
    var raw = b64urlDecode(s.slice(1)), hex = '';
    for (var i = 0; i < raw.length; i++) hex += ('0' + raw.charCodeAt(i).toString(16)).slice(-2);
    return hex;
  }

  function b64urlEncode(str) {
    var s = String(str), out = '', i, a, b, c;
    for (i = 0; i < s.length; i += 3) {
      a = s.charCodeAt(i) & 255;
      b = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : -1;
      c = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : -1;
      out += B64URL.charAt(a >> 2);
      out += B64URL.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
      if (b < 0) break;
      out += B64URL.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
      if (c < 0) break;
      out += B64URL.charAt(c & 63);
    }
    return out;
  }

  function b64urlDecode(str) {
    var s = String(str).replace(/=+$/, ''), out = '', i, v, buf = 0, bits = 0;
    for (i = 0; i < s.length; i++) {
      v = B64URL.indexOf(s.charAt(i));
      if (v < 0) throw new Error('bad swap code character');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); }
    }
    return out;
  }

  function opposite(dir) { return dir === 'btc2u' ? 'u2b' : 'btc2u'; }

  /* How far a code's own price sits from the live market, or null when there
     is nothing to compare yet. A code implies a price: it offers so many
     token units for so many sats, and units and sats together are USDT per
     whole bitcoin. Only a quote that actually arrived is believed - the
     fallback one is a guess this page made, and warning against a guess
     would be worse than silence. The rate in a code is the one term a
     stranger wrote that the money follows, so a price far off the market is
     said out loud when the code is read, not after anything has moved. */
  var RATE_WARN = 0.10;             /* warn when a code sits more than 10% off the live quote */
  function rateGap(units, sats) {
    var u = Number(units), st = Number(sats);
    if (!(u > 0) || !(st > 0)) return null;
    if (!isFinite(S.price) || !(S.price > 0) || S.pstate !== 'live') return null;
    var codePrice = u * 100 / st;   /* USDT per whole bitcoin */
    return { gap: Math.abs(codePrice - S.price) / S.price, codePrice: codePrice };
  }

  /* The sentence a code's own price earns when it sits far from the live quote,
     or '' when it does not. One function, so the check reads the same whether
     the code arrives before the quote or the quote arrives after the code. */
  function rateWarnText(units, sats) {
    var rg = rateGap(units, sats);
    if (!rg || !(rg.gap > RATE_WARN)) return '';
    return 'Careful: this code prices 1 BTC at about ' + fmt(Math.round(rg.codePrice)) +
      ' USDT, which is ' + Math.round(rg.gap * 100) + '% away from the market rate. Check the terms with your partner before paying.';
  }

  /* A code is read the moment it arrives, and the quote arrives when it
     arrives. On a cold start the code in the address bar can be applied while
     the quote is still loading, and the check above then had nothing to compare
     against - so the terms a code put on screen are kept here, and the same
     check runs again the instant a live quote lands. A code loaded before the
     rate is still warned about before anything is paid. */
  function recheckCodeRate() {
    if (!S.codeTerms) return;
    var was = S.codeRateWarn;
    var txt = rateWarnText(S.codeTerms.units, S.codeTerms.sats);
    S.codeRateWarn = !!txt;
    if (txt) {
      if (was) return;                 /* the same warning is already on screen */
      S.codeWarn = txt;
      renderCodeWarn();
      var rg = rateGap(S.codeTerms.units, S.codeTerms.sats);
      log('SECURITY', 'a code loaded before the quote prices 1 BTC at ' + fmt(Math.round(rg.codePrice)) +
        ' USDT; the live quote says ' + fmt(Math.round(S.price)) + ' (' + Math.round(rg.gap * 100) + '% off)', 'c-err');
      return;
    }
    /* Only a warning this check wrote is withdrawn: a refusal the code earned
       belongs to whatever refused it, not to the rate. */
    if (was) { S.codeWarn = ''; renderCodeWarn(); }
  }

  /* A wallet swap locks real USDT, and the amount it locks is the one the live
     quote prices. When that quote did not arrive, the figure comes from
     FALLBACK_PRICE - this page's own guess at the market - and a lock built on
     a guess hands the other side an amount nobody quoted. Practice rehearses on
     a stand-in escrow and keeps running; a wallet swap waits for a quote. */
  function quoteMissing() {
    return S.mode === 'wallet' && S.pstate !== 'live';
  }
  function rateError() {
    var e = new Error('no live price, so nothing is locked at a guess');
    e.noQuote = true;
    return e;
  }
  /* A tap with no live quote says so and asks for the quote again: the page
     reads the price once at boot, and a phone that was offline then must not
     be left with a guess for the rest of the session. */
  function refuseRate() {
    log('BLOCK', 'a wallet swap was refused while the price was the offline guess', 'c-err');
    toast('The live BTC price has not arrived, so a swap would lock USDT at a guessed amount. Nothing was sent: reading the price again now.');
    render();
    loadRate();
  }

  /* A code states what the sender of the code does; the phone that reads it
     takes the other side, so the same code reads correctly from both ends. A
     code is only made when it carries real terms: a rate that has not loaded
     yet would write `u:"0"`, which the other phone must then refuse, and a
     refusal is a worse answer than a moment's wait. */
  function swapCode() {
    if (!(Number(usdtUnits()) > 0)) {
      throw new Error('The rate has not loaded yet, so a code now would say zero USDT. Try again in a moment.');
    }
    if (!(Number(S.sats) > 0)) throw new Error('A code needs an amount to swap.');
    if (!S.t2) { S.t2 = nowSec() + T2_SPAN; S.t1 = curHeight() + T1_BLOCKS; }
    /* Amounts and times travel as decimal text: JSON numbers are doubles, and a
       token amount above 2^53 would be rounded by the encoder before the other
       phone ever reads it. */
    var body = { v: 1, d: S.direction, s: String(S.sats), u: String(usdtUnits()), t2: String(S.t2) };
    /* A wallet code also names the chain and the escrow, which is what the QR
       budget is spent on; the bitcoin block height it used to carry is the one
       field nobody reads on the other side. */
    if (!(S.mode === 'wallet' && isAddr(S.contract))) body.t1 = String(S.t1);
    var inv = readInvoice(pasted());
    if (inv.ok) body.h = b64field(normHex(inv.H));
    var ad = readAddress(addrIn());
    if (ad.ok) body.a = ad.chain === 'evm' ? b64field(ad.address) : ad.address;
    /* A wallet swap is only the same swap on the same chain and in the same
       escrow, so the code carries both - one letter for the chain, the
       contract address as it is. */
    if (S.mode === 'wallet' && isAddr(S.contract)) {
      body.n = S.net === 'mainnet' ? 'm' : 't';
      body.c = b64field(S.contract);
    }
    /* The swap id includes the address that funds the escrow. When this side
       funds it, the code says which address that will be (once the wallet has
       told the app); a code that leaves it out only means the other side has to
       learn it from the lock transaction instead. */
    var who = lockerNow();
    if (isAddr(who)) body.l = b64field(who);
    return CODE_PREFIX + b64urlEncode(JSON.stringify(body));
  }

  /* A code's amounts are decimal text and are parsed in BigInt; a value that
     does not fit a Number is refused, never rounded into a neighbour. A code
     written by an older version carries JSON numbers, and one that survived
     JSON as an integer is read the same way. */
  function codeBig(v) {
    if (typeof v === 'string') return /^\d+$/.test(v) ? BigInt(v) : null;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
    return null;
  }
  function readCodeBody(json) {
    if (!json || Number(json.v) !== 1) return null;
    var satsB = codeBig(json.s), unitsB = codeBig(json.u), t2B = codeBig(json.t2);
    var t1B = codeBig(json.t1 == null ? 0 : json.t1);
    if (satsB == null || unitsB == null || t2B == null || t1B == null) return null;
    if (satsB <= 0n || unitsB <= 0n || t2B <= 0n) return null;
    /* 21 million BTC is the most sats that can exist; a token amount that does
       not fit a Number could not be locked on this screen anyway. */
    if (satsB > 2100000000000000n || unitsB > SAFE || t2B > SAFE || t1B > SAFE) return null;
    var hRaw = String(json.h || ''), aRaw = String(json.a || '');
    var cRaw = String(json.c || ''), lRaw = String(json.l || '');
    var h = hRaw.charAt(0) === '~' ? unB64field(hRaw) : normHex(hRaw);
    var a = aRaw.charAt(0) === '~' ? '0x' + unB64field(aRaw) : aRaw;
    var c = cRaw.charAt(0) === '~' ? '0x' + unB64field(cRaw) : cRaw;
    var l = lRaw.charAt(0) === '~' ? '0x' + unB64field(lRaw) : lRaw;
    return {
      direction: json.d === 'u2b' ? 'u2b' : 'btc2u',
      sats: Number(satsB), units: Number(unitsB), t2: Number(t2B), t1: Number(t1B),
      H: /^([0-9a-f]{2}){32}$/.test(h) ? '0x' + h : null,
      address: chainOf(a) ? a : null,
      net: json.n === 'm' ? 'mainnet' : (json.n === 't' ? 'testnet' : null),
      contract: isAddr(c) ? c.toLowerCase() : null,
      locker: isAddr(l) ? String(l).toLowerCase() : null
    };
  }

  /* Reads a code out of whatever a person pasted around it: a message, a
     note, the text a camera app read from the QR. */
  function parseSwapCode(text) {
    var t = String(text == null ? '' : text), i = t.toLowerCase().indexOf(CODE_PREFIX);
    if (i < 0) return null;
    var m = /^[0-9A-Za-z_-]+={0,2}/.exec(t.slice(i + CODE_PREFIX.length));
    if (!m) return null;
    try { return readCodeBody(JSON.parse(b64urlDecode(m[0]))); } catch (e) { return null; }
  }

  /* Codes from before 0.4.2 were a page address with #s=... . They still open
     the same terms; nothing this app makes now has that shape. */
  function parseLegacyLink(text) {
    var m = /(?:^|[#&?])s=([0-9A-Za-z._-]+)/.exec(String(text || ''));
    if (!m) return null;
    var p = m[1].split('.');
    if (p.length < 5 || p[0] !== '1') return null;
    if (!/^[0-9a-f]{64}$/i.test(p[1])) return null;
    var satsB = codeBig(p[2]), unitsB = codeBig(p[3]), t2B = codeBig(p[4]);
    var t1B = codeBig(p[5] == null ? 0 : p[5]);
    if (satsB == null || unitsB == null || t2B == null || t1B == null) return null;
    if (satsB <= 0n || unitsB <= 0n || t2B <= 0n || unitsB > SAFE) return null;
    return {
      direction: 'btc2u', sats: Number(satsB), units: Number(unitsB),
      t2: Number(t2B), t1: Number(t1B),
      H: '0x' + p[1].toLowerCase(), address: null
    };
  }

  function parseSwapLink(text) { return parseSwapCode(text) || parseLegacyLink(text); }

  /* ------------------------------------------------------------ inputs --- */
  function bad(code, msg) { return { ok: false, code: code, msg: msg }; }
  function good(msg, extra) {
    var r = { ok: true, code: 'ok', msg: msg };
    if (extra) { for (var k in extra) r[k] = extra[k]; }
    return r;
  }
  function invIn() { return $('invIn'); }
  function addrEl() { return $('addrIn'); }
  function pasted() { var el = invIn(); return String(el ? el.value : '').trim(); }
  function addrIn() { var el = addrEl(); return String(el ? el.value : '').trim(); }

  /* Decoding an invoice verifies a signature, and the screen asks for the same
     invoice several times per keystroke; the last answer is kept. */
  var invMemo = { raw: null, dec: null, err: null };
  function parseLightning(raw) {
    var t = String(raw || '').trim().replace(/^lightning:/i, '');
    if (!t) return null;
    if (invMemo.raw === t) {
      if (invMemo.err) throw invMemo.err;
      return invMemo.dec;
    }
    try {
      var d = /^ln[io]1/i.test(t) ? decodeSwapOffer(t) : decodeBolt11(t);
      invMemo = { raw: t, dec: d, err: null };
      return d;
    } catch (e) {
      invMemo = { raw: t, dec: null, err: e };
      throw e;
    }
  }

  /* The Lightning half of the swap. Its payment hash IS the swap: the same H
     locks the USDT escrow, so whoever settles one leg settles both.

     Only an invoice that states its own payment hash is accepted. A BOLT12
     offer (`lno1...`) does not: the invoice a wallet gets for it is built by
     the payee's node with a fresh random hash, so hashing the offer's own bytes
     would tie the escrow to a hash no Lightning payment ever moves. Offers are
     refused with a sentence rather than bound to something that only looks like
     a hash. A BOLT12 invoice is refused for the same kind of reason below: its
     signature is not one this page can check. */
  /* A BOLT12 invoice is signed by its payee's node over a merkle root of its
     own TLVs. This page has no verifier for that signature, and an invoice
     taken on trust would be terms nobody checked, so the app says so and asks
     for the kind it can check. The sentence stays plain: no format names. */
  var BOLT12_INVOICE_REFUSED = 'This app cannot check the signature on that kind of invoice, so it does not ' +
    'take one. Ask your partner for an ordinary Lightning invoice made for this swap.';
  function readInvoice(raw) {
    var t = String(raw || '').trim();
    if (!t) return bad('empty', 'Paste the invoice for this swap.');
    var d;
    try { d = parseLightning(t); } catch (e) {
      var why = String((e && e.message) || '');
      /* An invoice whose creation time or expiry is missing is not read as one
         that never ends: the sentence is the same refusal as an invoice this
         app cannot check at all. */
      if (/creation time|no expiry/.test(why)) return bad('bolt12', BOLT12_INVOICE_REFUSED);
      /* A signature that does not check out is a different sentence from a
         string that is not an invoice at all: one may have been edited on the
         way here, and the answer is to ask for a fresh invoice. */
      if (/signature|recover/.test(why)) {
        return bad('signature', 'That invoice does not check out, so it may have been changed. Ask your partner for a new one.');
      }
      if (/states no amount|finer than a satoshi/.test(why)) {
        return bad('amount', 'That invoice does not state an amount, so it cannot be the one for this swap. Ask for one made for ' + fmt(S.sats) + ' sats.');
      }
      return bad('format', 'That invoice cannot be read. Paste the whole thing.');
    }
    if (!d) return bad('format', 'That invoice cannot be read. Paste the whole thing.');
    if (d.kind === 'bolt12' && d.form === 'offer') {
      return bad('offer', 'An offer cannot hold a swap: the invoice your wallet gets for it carries its own payment hash. Ask your partner for a hold invoice made for this swap.');
    }
    if (d.kind === 'bolt12' && d.form === 'invoice') return bad('bolt12', BOLT12_INVOICE_REFUSED);
    /* An invoice that names no amount asks the payer to pick one, so it cannot
       be tied to the sats on this screen: the escrow id would have nothing to
       match. */
    if (d.sats == null || !(Number(d.sats) > 0)) {
      return bad('amount', 'That invoice does not state an amount, so it cannot be the one for this swap. Ask for one made for ' + fmt(S.sats) + ' sats.');
    }
    var H = d.paymentHash ? '0x' + normHex(d.paymentHash) : null;
    if (!H) return bad('hash', 'That invoice carries no payment hash to lock on.');
    if (S.expectH && normHex(H) !== normHex(S.expectH)) {
      return bad('mismatch', 'That invoice is for a different swap. Ask for the one made from this code.');
    }
    if (Number(d.sats) !== Number(S.sats)) {
      return bad('amount', 'That invoice is for ' + fmt(d.sats) + ' sats, not ' + fmt(S.sats) + '.');
    }
    var exp = invoiceExpiry(d);
    if (exp != null && effNow() > exp) return bad('expired', 'That invoice has expired. Ask for a new one.');
    if (d.kind === 'bolt11' && !invNetOk(d.network)) {
      return bad('network', S.net === 'mainnet'
        ? 'That invoice is for Bitcoin\u2019s test network, and this swap pays real USDT on Arbitrum One. Ask your partner for a mainnet invoice.'
        : 'That invoice is for another bitcoin network.');
    }
    var w = windowProblem(d, S.t2);
    if (w) return bad('window', w);
    return good('Invoice ready.', { dec: d, H: H, basis: 'invoice' });
  }

  /* When the Lightning invoice stops being payable, in unix seconds; null when
     the invoice never expires (a BOLT11 with no expiry tag). */
  function invoiceExpiry(d) {
    if (!d) return null;
    if (d.absoluteExpiry != null) return Number(d.absoluteExpiry);
    if (d.expiresAt != null) return Number(d.expiresAt);
    return null;
  }

  /* The escrow window has a floor, a ceiling, and has to close before the
     invoice does. A partner who names a window five minutes out is betting that
     the sats land after it; a window years out leaves the funding side's money
     stuck. Both are refused before anything can be approved. */
  function windowProblem(dec, t2, now) {
    if (!t2) return '';
    var left = Number(t2) - (now == null ? effNow() : Number(now));
    if (!(left > 0)) return 'Those terms have run out. Ask for a new code.';
    if (left < T2_MIN) return 'Those terms close too soon to pay and claim. Ask for a new code.';
    if (left > T2_MAX) return 'Those terms would lock the money for too long. Ask for a new code.';
    var exp = invoiceExpiry(dec);
    if (exp != null && exp < Number(t2) + T1_MARGIN) {
      return 'That invoice ends before the escrow window closes. Ask for one that stays payable at least an hour longer.';
    }
    return '';
  }

  /* The USDT half: where the USDT lands. Two forms of USDT are what people
     actually paste, the EVM tokens (`0x` + 40 hex) and TRON's TRC-20 (`T` + 33
     base58 characters, checked with its real Base58Check checksum). */
  function readAddress(raw) {
    var a = String(raw || '').trim();
    if (!a) return bad('empty', 'Add the USDT address for this swap.');
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
      if (!checksumOk(a)) {
        return bad('checksum', 'That 0x address has a mistyped character: its capitals do not spell it the way an address spells itself. Copy it again from your wallet.');
      }
      if (/^0x0{40}$/i.test(a)) return bad('format', 'That address cannot receive anything. Use your own wallet address.');
      return good('Address ready.', { address: a.toLowerCase(), chain: 'evm' });
    }
    if (a.charAt(0) === 'T' || a.charAt(0) === 't') {
      var payload = tronAddressBytes(a);
      if (!payload) {
        return bad('format', 'That T address is not valid. A TRON address is 34 characters and has no 0, O, I or l in it.');
      }
      if (isZeroBytes(payload)) return bad('format', 'That address cannot receive anything. Use your own wallet address.');
      /* A wallet swap settles on Arbitrum, so a TRON address has nowhere to
         land there: saying so is kinder than accepting it and failing later. */
      if (S.mode === 'wallet') {
        return bad('chain', 'This swap pays on Arbitrum, so the address is a 0x one (40 characters). A T address belongs to TRON.');
      }
      return good('Address ready.', { address: a, chain: 'tron' });
    }
    return bad('format', S.mode === 'wallet'
      ? 'That is not an Arbitrum address. Paste the 0x address (40 characters) your wallet shows.'
      : 'That is not a USDT address. It starts with 0x (40 characters) or T (34 characters).');
  }

  /* Lock codes the contract produces - kept for the escrow hand-off and the
     tests that decode them. */
  function readLockProof(text) {
    var t = String(text || '').trim();
    if (!t) return { kind: 'empty' };
    if (t.charAt(0) === '{') {
      var j;
      try { j = JSON.parse(t); } catch (e) { return { kind: 'error', msg: 'That JSON does not parse.' }; }
      if (!j || !j.hashlock) return { kind: 'error', msg: 'The JSON record has no hashlock field.' };
      return {
        kind: 'json', hashlock: String(j.hashlock),
        timelock: j.timelock == null ? '' : String(j.timelock),
        amount: j.amount == null ? '' : String(j.amount),
        receiver: String(j.receiver || ''), token: String(j.token || '')
      };
    }
    var raw = t.toLowerCase(), h = raw.replace(/^0x/, '');
    if (/^[0-9a-f]{328}$/.test(h)) return decodeLockCalldata(h);
    if (/^0x[0-9a-f]{64}$/.test(raw)) return { kind: 'tx', hash: raw };
    if (/^(liquidnetwork:|lq1|el1|vj|ex1)/i.test(t)) {
      var body = t.replace(/^liquidnetwork:/i, '');
      var qi = body.indexOf('?');
      var addr = qi < 0 ? body : body.slice(0, qi);
      /* A lock code is a stranger's text: a query string with no prototype to
         reach, only whole key=value pairs, and a broken escape in it is one
         field dropped rather than an exception out of the decoder. */
      var q = Object.create(null);
      if (qi >= 0) {
        body.slice(qi + 1).split('&').forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          if (i < 1) return;
          try {
            var k = decodeURIComponent(kv.slice(0, i));
            var v = decodeURIComponent(kv.slice(i + 1));
            if (k && !(k in q)) q[k] = v;
          } catch (e) { /* not a field, and not a reason to fail the whole code */ }
        });
      }
      return {
        kind: 'liquid', address: addr, hashlock: q.hashlock || '',
        timelock: q.timelock || q.t2 || '', amount: q.amount || ''
      };
    }
    return { kind: 'error', msg: 'Unrecognised proof.' };
  }

  function readEscrow(raw) {
    var p = readLockProof(raw);
    if (p.kind === 'empty') return bad('empty', 'Paste the lock code your partner sent.');
    if (p.kind === 'error') return bad('format', 'That lock code cannot be read.');
    if (p.kind === 'tx') {
      if (/^0x0{64}$/.test(p.hash)) return bad('format', 'That lock code cannot be read.');
      log('REF', 'lock transaction ' + short(p.hash, 6) + ' recorded');
      return { ok: true, code: 'ref', msg: 'Lock recorded.', dec: p };
    }
    if (p.kind === 'calldata' && String(p.selector || '').toLowerCase() !== ('0x' + SEL.lock).toLowerCase()) {
      return bad('format', 'That lock code cannot be read.');
    }
    var locked = String(p.hashlock || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(locked)) return bad('format', 'That lock code cannot be read.');
    if (normHex(locked) !== normHex(S.H)) return bad('mismatch', 'That lock is for a different swap.');
    if (!sameAmount(p.timelock, S.t2)) return bad('timelock', 'That lock ends at the wrong time.');
    var held, want = BigInt(usdtUnits());
    try { held = BigInt(String(p.amount == null ? '' : p.amount).trim()); } catch (e) { held = -1n; }
    if (held <= 0n) return bad('amount', 'That lock has no amount.');
    if (held !== want) return bad('amount', 'That lock holds ' + unitsTxt(held) + ' USDT, not ' + usdtTxt() + '.');
    return good('The USDT side is locked.', { dec: p });
  }

  function escrowUnits() {
    if (!isAddr(S.addr)) return '';
    return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: tokenNow(), amount: usdtUnits() });
  }

  /* ----------------------------------------------------------- one gate --- */
  /* The gate runs on the chain's clock as well as the phone's: a window the
     chain says has run out has run out, whatever this phone believes the time
     to be. One reading serves every check for 45 seconds. */
  function validate() {
    return syncChainTime().then(validateNow);
  }
  function validateNow() {
    if (S.phase === 'settled') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'You received ' + usdtTxt() + ' USDT' + (S.mode === 'wallet' ? ' on ' + curChain().label : '') + '.'
        : 'You received ' + fmt(S.sats) + ' sats.'));
    }
    if (S.phase === 'refunded') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'The USDT went back to your partner.'
        : 'Your ' + usdtTxt() + ' USDT came back to you.'));
    }
    if (S.phase === 'paying') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'Tap I paid once the sats have left your wallet.'
        : 'Tap I paid once the USDT has been sent.'));
    }
    if (S.phase === 'paid') {
      return Promise.resolve(good('Your side is locked. Check the chain, or leave it watching.'));
    }
    if (S.phase === 'locking') {
      return Promise.resolve(good('Send the one call that puts your USDT in the escrow.'));
    }
    var sendBtc = S.direction === 'btc2u';
    var inv = readInvoice(pasted());
    var ad = readAddress(addrIn());
    var invMsg = inv.ok ? '' : (inv.code === 'empty'
      ? (sendBtc ? "Paste the invoice your partner sends." : 'Paste your own invoice so the other side can pay you.')
      : inv.msg);
    var adMsg = ad.ok ? '' : (ad.code === 'empty'
      ? (sendBtc ? 'Add the USDT address that should receive your USDT.' : "Add your partner's USDT address.")
      : ad.msg);
    if (inv.ok && ad.ok) {
      /* Wallet mode moves the USDT in a contract, so a swap with no contract
         set has nowhere to lock: the third step says that, not "ready". */
      if (S.mode === 'wallet' && !isAddr(S.contract)) {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'One thing first: set the escrow contract for ' + curChain().label + '.',
          fields: { invoice: inv, address: ad }
        });
      }
      if (S.mode === 'wallet' && !isAddr(tokenNow())) {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'Add the USDT token for ' + curChain().label + ' in Setup.',
          fields: { invoice: inv, address: ad }
        });
      }
      /* The token was read and it is not one this page can count in: a token
         that does not count in six decimals would move an amount other than
         the one the screen says, so nothing is approved against it. */
      if (S.mode === 'wallet' && S.tokenState === 'wrong') {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'The token set in Setup is not a 6-decimal token, so this swap cannot count with it. Set the right token in Setup.',
          fields: { invoice: inv, address: ad }
        });
      }
      /* Zero is not an amount. Before the quote lands there is no USDT figure
         at all, and a tap in that window would lock a swap with nothing in
         it - the escrow would take it and the bitcoin would buy 0 USDT. */
      if (!(Number(usdtUnits()) > 0)) {
        return Promise.resolve({ ok: false, code: 'rate', field: 'go',
          msg: 'The rate has not loaded yet, so the USDT amount would be zero. Tap Approve again in a moment.',
          fields: { invoice: inv, address: ad } });
      }
      /* A wallet swap moves real USDT, and the amount is the one the live quote
         prices. Without that quote the figure is this page's own guess, and a
         lock built on a guess hands the other side an amount nobody quoted.
         Practice rehearses on a stand-in and keeps running. */
      if (quoteMissing()) {
        return Promise.resolve({ ok: false, code: 'rate', field: 'go',
          msg: 'The live BTC price has not arrived, so this swap would lock USDT at a guessed amount. Tap Approve again once the rate line is live.',
          fields: { invoice: inv, address: ad } });
      }
      /* The escrow window has to leave room to pay and claim, and the invoice
         has to outlive it. A code that names five minutes, or years, stops
         here - before any button can approve it. */
      var wp = windowProblem(inv.dec, S.t2);
      if (wp) {
        return Promise.resolve({ ok: false, code: 'window', field: 'invoice', msg: wp,
          fields: { invoice: inv, address: ad } });
      }
      /* The swap id names the address that funds the escrow. On the side that
         receives the USDT that address is the partner's, and this side can only
         check the lock once the partner has said it. */
      if (S.mode === 'wallet' && sendBtc && !isAddr(lockerNow())) {
        return Promise.resolve({ ok: false, code: 'locker', field: 'go',
          msg: 'Ask your partner for the code they made after their wallet was connected, or paste the transaction that locked the USDT.',
          fields: { invoice: inv, address: ad } });
      }
      return Promise.resolve(good(sendBtc
        ? 'Both sides are ready. Approve ties both legs to one secret.'
        : 'Both sides are ready. Approve puts your USDT in the escrow.',
        { dec: inv.dec, H: inv.H, basis: inv.basis, address: ad.address, inv: String(pasted()) }));
    }
    // the sentence names the first thing missing, in the order the steps are on screen
    var miss = sendBtc
      ? (inv.ok ? { code: ad.code, msg: adMsg, field: 'address' } : { code: inv.code, msg: invMsg, field: 'invoice' })
      : (ad.ok ? { code: inv.code, msg: invMsg, field: 'invoice' } : { code: ad.code, msg: adMsg, field: 'address' });
    return Promise.resolve({
      ok: false, code: miss.code, msg: miss.msg, field: miss.field,
      fields: { invoice: inv, address: ad }
    });
  }

  function gateSentence() {
    var r = S.gate;
    if (!r) return 'Fill in the two steps, then tap Approve.';
    return r.msg;
  }

  /* ------------------------------------------------------------ render --- */
  function usdtLine() { return usdtOf() ? usdtTxt() + ' USDT' : '\u2014 USDT'; }

  function render() {
    var sendBtc = S.direction === 'btc2u';
    var done = S.phase === 'settled' || S.phase === 'refunded';
    var paying = S.phase === 'paying';
    var locking = S.phase === 'locking';
    var held = S.phase === 'paid';
    var waiting = paying || locking || held;

    document.body.dataset.phase = S.phase;
    document.body.dataset.mode = S.mode;
    document.body.dataset.dir = S.direction;
    document.body.dataset.role = sendBtc ? 'maker' : 'taker';

    $('modePractice').className = S.mode === 'practice' ? 'on' : '';
    $('modeWallet').className = S.mode === 'wallet' ? 'on' : '';
    $('rateDot').className = 'dot ' + (S.pstate === 'live' ? 'live' : S.pstate === 'offline' ? 'off' : '');
    $('rateTxt').textContent = S.price ? '1 BTC \u2248 ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC \u2248 \u2014 USDT';

    if (sendBtc) {
      $('sendAmt').textContent = fmt(S.sats); $('sendUnit').textContent = 'sats';
      $('sendSub').textContent = '\u2248 ' + usdtLine();
      $('getAmt').textContent = usdtLine().replace(' USDT', ''); $('getUnit').textContent = 'USDT';
      $('getSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
    } else {
      $('sendAmt').textContent = usdtLine().replace(' USDT', ''); $('sendUnit').textContent = 'USDT';
      $('sendSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
      $('getAmt').textContent = fmt(S.sats); $('getUnit').textContent = 'sats';
      $('getSub').textContent = '\u2248 ' + usdtLine();
    }

    // step order follows the direction: when you send USDT, the address is step 1
    $('nInv').textContent = sendBtc ? '1' : '2';
    $('nAddr').textContent = sendBtc ? '2' : '1';
    $('stepInv').style.order = sendBtc ? '1' : '2';
    $('stepAddr').style.order = sendBtc ? '2' : '1';
    $('invTitle').textContent = sendBtc ? "Partner's Lightning invoice" : 'Your Lightning invoice';
    $('addrTitle').textContent = sendBtc ? 'Your USDT address' : "Partner's USDT address";

    // the invoice row: pay it when it is the other side's, hand it over when it
    // is yours. The same row is on screen in both modes; only Wallet can reach
    // a wallet with it, so in Practice the hand-off says what mode this is
    // instead of opening one (see the click handler at the bottom).
    $('invRow').hidden = false;
    $('walletLink').hidden = !sendBtc;
    $('copyInv').hidden = sendBtc;
    var inv = readInvoice(pasted());
    $('walletLink').setAttribute('href', inv.ok ? 'lightning:' + String(pasted()).replace(/^lightning:/i, '') : '#');
    $('walletLink').dataset.empty = inv.ok ? '0' : '1';

    /* Bitcoin paid from a wallet that keeps the payment secret cannot be
       claimed back here, so the sentence is on screen before the button. */
    var ih = $('invHint');
    if (ih) {
      ih.hidden = !sendBtc || done || waiting;
      ih.textContent = sendBtc
        ? 'Pay from a wallet that shows the payment secret: it is how you claim the USDT if your partner stops answering.'
        : '';
    }

    $('sampleInv').hidden = S.mode === 'wallet';
    $('sampleAddr').hidden = S.mode === 'wallet';

    /* When the partner's funding address is not known yet, their lock
       transaction is the one thing that supplies it. */
    var needTx = S.mode === 'wallet' && !done && !waiting && S.direction === 'btc2u' && !isAddr(lockerNow()) && !S.lockTx;
    $('lockTxRow').hidden = !needTx;
    $('addrIn').placeholder = S.mode === 'wallet' ? '0x\u2026 on ' + curChain().label : '0x\u2026 or T\u2026';

    $('headRow').hidden = !(done || waiting);
    // the finished swap says it once, in the title and on the receipt
    $('stateTxt').hidden = done;
    $('presets').hidden = done || waiting;
    $('terms').hidden = done || waiting;
    $('codeRow').hidden = done || waiting || $('codeRow').hidden;
    $('steps').hidden = done || waiting;
    $('payBox').hidden = !waiting;
    $('receipt').hidden = !done;
    $('stepTitle').textContent = S.phase === 'settled' ? 'Swap complete'
      : (S.phase === 'refunded' ? 'Swap closed'
        : (paying ? 'Waiting for payment'
          : (locking ? 'Lock your USDT'
            : (held ? (sendBtc ? 'Paid, waiting for the USDT' : 'Your USDT is locked')
              : (sendBtc ? 'Swap bitcoin for USDT' : 'Swap USDT for bitcoin')))));
    $('stepTitle').className = 'q' + (S.phase === 'settled' ? ' done' : '');
    $('primary').textContent = done ? 'Done'
      : (paying ? 'I paid' : (waiting ? 'Check chain' : 'Approve'));
    $('primary').disabled = !!S.busy;
    $('primary').dataset.ready = done || waiting || (S.gate && S.gate.ok) ? '1' : '0';
    if (waiting) paintPay();

    $('stateTxt').textContent = S.phase === 'settled' ? 'Completed'
      : (S.phase === 'refunded' ? 'Refunded'
        : (S.busy ? 'Reading the chain\u2026'
          : (paying ? 'Nothing sent yet'
            : (locking ? 'Not locked yet'
              : (held ? (S.chain && S.chain.state === 'locked' ? 'USDT locked' : 'Waiting')
                : (S.gate && S.gate.ok ? 'Ready to approve'
                  : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready')))))));
    $('stateTxt').dataset.on = done || (!waiting && S.gate && S.gate.ok) || held ? '1' : '0';

    if (done) {
      $('rcSend').textContent = sendBtc ? fmt(S.sats) + ' sats' : usdtTxt() + ' USDT';
      $('rcGet').textContent = S.phase === 'refunded'
        ? (sendBtc ? '\u2014 USDT' : usdtTxt() + ' USDT back')
        : (sendBtc ? usdtTxt() + ' USDT' : fmt(S.sats) + ' sats');
      $('rcAddr').textContent = S.addr || '\u2014';
      $('rcNet').textContent = S.mode === 'practice'
        ? 'Practice \u00b7 simulated'
        : curChain().label + (S.chain && S.chain.state === 'claimed' ? ' \u00b7 paid on chain'
          : (S.chain && S.chain.state === 'refunded' ? ' \u00b7 refunded on chain' : ''));
    }

    renderChain();
    renderLog();
  }

  /* The chain line under the rate: which Arbitrum, and whether the escrow
     behind it answers at all. It is on screen in both modes: a rehearsal runs
     against the stand-in escrow, which is always there, so the line never asks
     for a deployment in Practice. */
  function renderChain() {
    var row = $('chainRow');
    if (!row) return;
    row.hidden = false;
    var practice = S.mode === 'practice';
    var c = curChain(), txt = c.label, dot = 'off';
    if (S.busy && !practice) {
      txt += ' \u00b7 reading the chain\u2026';
      dot = '';
    } else if (!practice && !isAddr(S.contract)) {
      txt += ' \u00b7 escrow not set';
    } else if (!practice && S.rpcState === 'bad') {
      txt += ' \u00b7 no answer from the chain';
    } else if (!practice && S.rpcState === 'nocon') {
      txt += ' \u00b7 no contract at that address';
    } else if (!practice && S.rpcState === 'nohtlc') {
      txt += ' \u00b7 not the swap contract';
    } else if (!practice && S.rpcState === 'unclear') {
      txt += ' \u00b7 endpoints disagree';
    } else if (S.chain) {
      if (S.chain.state === 'error') { txt += S.chain.disagree ? ' \u00b7 endpoints disagree' : ' \u00b7 no answer from the chain'; }
      else if (S.chain.state === 'locked') { txt += ' \u00b7 USDT locked'; dot = 'live'; }
      else if (S.chain.state === 'closed') { txt += ' \u00b7 window closed'; }
      else if (S.chain.state === 'claimed') { txt += ' \u00b7 USDT paid out'; dot = 'live'; }
      else if (S.chain.state === 'refunded') { txt += ' \u00b7 USDT returned'; }
      else if (S.chain.state === 'mismatch') { txt += ' \u00b7 not this swap'; }
      else { txt += ' \u00b7 nothing locked yet'; }
    } else {
      txt += practice || S.rpcState === 'ok' ? ' \u00b7 escrow ready' : ' \u00b7 escrow set';
      dot = practice || S.rpcState === 'ok' ? 'live' : 'off';
    }
    /* A reading that was not cross-checked says so on the screen, in one quiet
       line under the chain row (the row itself is too narrow for the sentence). */
    $('chainTxt').textContent = txt;
    $('chainDot').className = 'dot ' + dot;
    var ql = $('quorumLine');
    if (ql) {
      ql.textContent = !practice && S.quorum === 'single'
        ? 'One node answers, so nothing is cross-checked. Add a second RPC endpoint in Setup.' : '';
      ql.hidden = !ql.textContent;
    }
    if (!practice) paintSetup();
  }

  /* The waiting screen: what to send and where, and nothing that claims the
     swap is over before the money has actually moved. */
  function paintPay() {
    var sendBtc = S.direction === 'btc2u';
    var practice = S.mode === 'practice';
    var c = S.chain;
    var line;
    if (S.phase === 'locking') {
      line = practice
        ? 'Lock ' + usdtTxt() + ' USDT in the escrow. The stand-in signs for the wallet here.'
        : (provider()
          ? 'Lock ' + usdtTxt() + ' USDT in the escrow. One tap in your wallet approves the USDT and locks it.'
          : 'Lock ' + usdtTxt() + ' USDT from your wallet: approve the USDT first, then send the lock call.');
    } else if (S.phase === 'paid') {
      line = sendBtc
        ? 'Paid. The USDT is yours once the escrow releases it \u2014 this screen closes the swap when the chain says so.'
        : 'Your USDT is locked. The bitcoin arrives when your partner pays; the swap closes when the escrow pays out.';
    } else {
      line = sendBtc
        ? 'Send ' + fmt(S.sats) + ' sats to this invoice from your wallet, then tap I paid.'
        : 'Send ' + usdtTxt() + ' USDT to this address from your wallet, then tap I paid.';
    }
    $('payLine').textContent = S.note || line;
    $('payEsc').textContent = (practice
      ? 'Practice \u00b7 ' + curChain().label
      : curChain().label + (S.block ? ' \u00b7 block ' + fmt(S.block) : '')) + ' \u00b7 ' + chainSay(c).replace(/^The /, '');
    $('payAddr').hidden = sendBtc || S.phase !== 'paying';
    $('payAddr').textContent = sendBtc ? '' : (S.addr || '\u2014');
    $('payRowInv').hidden = !sendBtc || S.phase === 'locking' || S.phase === 'paid';
    $('payRowAddr').hidden = sendBtc || S.phase !== 'paying';
    $('payWalletLink').setAttribute('href', sendBtc && S.inv ? 'lightning:' + S.inv : '#');

    // the wallet's share of the work: only the call this side still owes.
    // A rehearsal has no wallet to send it, but the same call is on screen.
    var canCopy = isAddr(escrowNow());
    var locking = S.phase === 'locking';
    $('paySend').hidden = practice || !provider() || !locking;
    $('payCopyCall').hidden = !canCopy || !locking;
    $('payLink').hidden = !canCopy || !locking;
    $('payLink').setAttribute('href', canCopy && locking ? callLink(lockCall(), 'lock', [
      'bytes32=0x' + pad64(normHex(S.H)),
      'uint256=' + String(S.t2),
      'address=' + S.addr,
      'address=' + tokenNow(),
      'uint256=' + String(usdtUnits())
    ]) : '#');
    /* Moving USDT from a wallet outside this page is two calls, not one: the
       token has to allow the escrow the amount first, and only then can the
       lock pull it. The approve call is offered exactly the way the lock is -
       copied, or opened as an ethereum: link - so that wallet can do its part
       in the order the token requires. */
    var external = !practice && !provider() && locking && isAddr(tokenNow());
    var arow = $('payRowApprove');
    if (arow) arow.hidden = !external;
    var alink = $('payApproveLink');
    if (alink) {
      alink.hidden = !external;
      alink.setAttribute('href', external ? callLink(approveCall(), 'approve', [
        'address=' + String(S.contract),
        'uint256=' + String(usdtUnits())
      ]) : '#');
    }
    // the secret opens the escrow; whoever holds it can claim, and the app
    // checks that it hashes to this swap before offering it to a wallet. A
    // window that has closed can no longer be claimed, only refunded.
    var open = c && (c.state === 'locked' || c.state === 'closed') && S.phase === 'paid';
    var claimable = c && c.state === 'locked' && S.phase === 'paid';
    $('payRowClaim').hidden = !open;
    $('claimBtn').hidden = !claimable;
    $('refundBtn').hidden = !(open && S.direction === 'u2b' && (!claimable || (S.t2 && effNow() >= S.t2)));
    $('secretRow').hidden = !$('secretRow').dataset.open || $('secretRow').dataset.open === '0';

    // The payer has to be able to claim if the partner goes quiet: that takes
    // the payment secret, and only some wallets show it.
    var warn = $('payWarn');
    if (warn) {
      warn.hidden = !sendBtc;
      warn.textContent = sendBtc
        ? 'Pay from a wallet that shows the payment secret: it is how you claim the USDT if your partner stops answering.'
        : '';
    }
  }

  /* The setup panel is the only place a hash or an address is on screen: it is
     for the person who deploys the escrow, not the person swapping. */
  function paintSetup() {
    var box = $('setupBox');
    if (!box || box.hidden) return;
    $('netTest').className = S.net === 'testnet' ? 'on' : '';
    $('netMain').className = S.net === 'mainnet' ? 'on' : '';
    $('contractIn').value = S.contract;
    $('tokenIn').value = S.token || '';
    $('rpcIn').value = S.rpc || '';
    var c = curChain();
    var eps = endpoints().length;
    var cross = eps > 1 ? ' The ' + eps + ' endpoints are cross-checked: the escrow is only believed when two agree.' : '';
    /* What the chain said about the token, in the same panel the token is typed
       in: unread is a sentence, and a token that counts in other decimals is
       never stored, so this line only appears for a setup kept from before. */
    var tokenSay = S.tokenState === 'unread'
      ? ' The token at that address was not read: the chain did not answer.'
      : (S.tokenState === 'wrong'
        ? ' The token set here is not a 6-decimal token, so this swap cannot count with it. Set the right one and Save.'
        : '');
    $('setupHint').textContent = (!isAddr(S.contract)
      ? 'Deploy the escrow once on ' + c.label + ': copy the bytecode, open Remix, deploy, then paste the address here. Everything else stays on this phone.'
      : (S.rpcState === 'ok' ? 'The chain answers and the escrow reads like the swap contract: block ' + fmt(S.block || 0) + '.'
        : (S.rpcState === 'unclear' ? 'The endpoints disagree about that address, so the escrow is not read as ready. Check the endpoints in Setup.'
          : (S.rpcState === 'nocon' ? 'Nothing answers at that address on ' + c.label + '.'
            : (S.rpcState === 'nohtlc' ? 'That address answers, but it is not the swap contract. Check the address in Setup.'
              : (S.rpcState === 'bad' ? 'The chain did not answer. Check the endpoint, then tap Check.'
                : 'Tap Check to read the chain.')))))) + tokenSay + cross;
  }

  function presetsOn() {
    var btns = document.querySelectorAll('#presets [data-act="sats"]'), i, on;
    for (i = 0; i < btns.length; i++) {
      on = Number(btns[i].dataset.v) === Number(S.sats);
      btns[i].className = on ? 'on' : '';
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderLog() {
    var ol = $('log');
    ol.innerHTML = '';
    if (!S.log.length) {
      var li = document.createElement('li');
      var t = document.createElement('time'); t.textContent = '--:--:--';
      var b = document.createElement('b'); b.textContent = 'IDLE';
      var s = document.createElement('span'); s.textContent = 'Nothing recorded yet.';
      li.appendChild(t); li.appendChild(b); li.appendChild(s);
      ol.appendChild(li);
      return;
    }
    S.log.forEach(function (e) {
      var li = document.createElement('li');
      if (e.cls) li.className = e.cls;
      var t = document.createElement('time'); t.textContent = e.t;
      var b = document.createElement('b'); b.textContent = e.kind;
      var s = document.createElement('span'); s.textContent = e.text;
      li.appendChild(t); li.appendChild(b); li.appendChild(s);
      ol.appendChild(li);
    });
  }

  /* ------------------------------------------------------------- gate UI -- */
  /* The gate reads the chain, so the answer comes back after the keystroke
     that asked for it. A generation token is taken when the read is scheduled:
     a validation that was already on its way when newer input arrived is
     dropped here instead of painting its answer - an older invoice's verdict
     must never overwrite the gate the newer input earned. */
  var gateTimer, gateGen = 0;
  function refreshGate() {
    clearTimeout(gateTimer);
    var gen = ++gateGen;
    gateTimer = setTimeout(function () {
      validate().then(function (r) {
        if (gen === gateGen) paintGate(r);
      });
    }, 60);
  }

  function paintGate(r) {
    S.gate = r;
    var say = $('say');
    say.textContent = r.msg;
    say.className = 'say' + (r.ok || r.code === 'empty' ? '' : ' err');
    // a running swap has one job per phase, and its button stays lit for it
    $('primary').dataset.ready = r.ok || S.phase !== 'idle' ? '1' : '0';
    var f = r.fields || {};
    markField(invIn(), f.invoice, r.ok);
    markField(addrEl(), f.address, r.ok);
    if (S.phase === 'idle') {
      $('stateTxt').textContent = r.ok ? 'Ready to approve' : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready');
      $('stateTxt').dataset.on = r.ok ? '1' : '0';
    }
  }

  function markField(el, res, allOk) {
    if (!el) return;
    if (allOk) { el.dataset.state = 'ok'; return; }
    if (!res || res.ok || res.code === 'empty') { el.dataset.state = ''; return; }
    el.dataset.state = 'err';
  }

  function shake() {
    var say = $('say');
    say.classList.remove('shake');
    void say.offsetWidth;
    say.classList.add('shake');
  }
  function needInvoice() {
    toast('Paste the invoice first, then this opens.');
    shake();
  }

  /* ------------------------------------------------------------ actions -- */
  function logSwap(r) {
    log('INVOICE', 'payment hash ' + short(r.H, 8) + ' \u00b7 ' + fmt(S.sats) + ' sats');
    log('USDT', 'escrow pays ' + usdtTxt() + ' USDT to ' + short(r.address, 6));
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' \u00b7 funds from ' + short(lockerNow() || '\u2014', 6) +
      ' \u00b7 invoice ends ' + (invoiceExpiry(r.dec) == null ? 'never' : clock(invoiceExpiry(r.dec))));
  }

  /* Approve puts the terms of a swap together in steps: the window first, then
     the invoice, the address and the amount, and only then does it ask the
     chain. A refusal in the middle would otherwise leave half a swap behind: a
     window with nothing locked under it, an amount with no invoice, a hash no
     invoice names - and the next tap would build its swap on those leftovers.
     Everything the refused tap had put together is dropped here, so a swap
     that never started leaves no terms of its own. The terms a code brought
     stay: the partner's sats, the window the code named and the hash it pinned
     are not this tap's doing, and Back is what clears those. */
  function dropSwapTerms() {
    S.t1 = null; S.t2 = null;
    S.units = null; S.inv = ''; S.invDec = null;
    S.addr = ''; S.H = null; S.basis = null;
    log('RESET', 'the refused tap left no swap terms behind');
  }

  function approve() {
    if (S.phase === 'settled' || S.phase === 'refunded') { reset(); return; }
    if (S.phase === 'paying') { paid(); return; }
    if (S.phase === 'locking' || S.phase === 'paid') { checkChain(); return; }
    /* No live quote, no wallet swap: the tap is answered with a sentence and
       the price is read again, rather than opening a swap priced by a guess. */
    if (quoteMissing()) { refuseRate(); return; }
    /* The gate takes a chain reading and then opens the swap: a second tap in
       that gap would read the terms again and start a second swap on the same
       money. */
    if (!opStart('approve')) { opWait(); return; }
    /* The id names the address that funds the escrow. When this side funds it,
       the wallet is asked who it is before anything is computed. */
    var whoFirst = S.mode === 'wallet' && S.direction === 'u2b' ? ensureMe() : Promise.resolve(true);
    whoFirst.then(function () { return validate(); }).then(function (r) {
      if (!r.ok) {
        paintGate(r);
        if (r.code === 'setup') openSetup();
        shake();
        log('BLOCK', r.msg, 'c-err');
        renderLog();
        toast(r.msg);
        return;
      }
      if (!S.t2) { S.t2 = nowSec() + T2_SPAN; S.t1 = curHeight() + T1_BLOCKS; }
      /* Last look at the clock: nothing is approved on a window that has
         already closed or is about to. The tap had already built part of the
         swap - the window it set is dropped with the rest. */
      var wp = windowProblem(r.dec, S.t2);
      if (wp) {
        dropSwapTerms();
        log('BLOCK', wp, 'c-err');
        render();
        toast(wp);
        return;
      }
      S.units = usdtUnits();
      S.inv = String(pasted()).replace(/^lightning:/i, '');
      S.invDec = r.dec;
      S.addr = r.address;
      S.H = r.H;
      S.basis = 'invoice';
      logSwap(r);
      /* Practice rehearses the same gates against a stand-in escrow. Wallet
         mode moves real USDT and the chain has the last word. */
      return startSwap();
    }).then(opEnd, function (e) {
      opEnd();
      /* A tap that never got the swap going leaves no terms of its own: what
         it had half-built is dropped before the refusal is explained. */
      if (S.phase === 'idle') dropSwapTerms();
      walletFail(e);
    });
  }

  /* ------------------------------------------------- the rehearsal escrow --
     Practice differs from Wallet in what it draws on, never in what it asks
     the screen to do. Both modes tap the same Approve, park on the same
     waiting screen, and close only on a claimed escrow record; in Practice
     that record is the stand-in below, which is why nothing has to be
     deployed, signed or pasted to rehearse a swap. */
  function simRecord() {
    return {
      hashlock: S.H, amount: usdtUnits(), timelock: S.t2,
      token: tokenNow(), sender: EVM.usdtSide, receiver: S.addr,
      claimed: false, refunded: false
    };
  }

  /* A rehearsal has no deployment and no partner to wait for, so the stand-in
     escrow starts in the state a real swap reaches at this point: when this
     side sends bitcoin, the USDT is already locked for it. */
  function simSeed() {
    if (S.mode !== 'practice') return;
    var c = classify(simRead());
    if (c.state === 'locked' || c.state === 'claimed' || c.state === 'refunded') return;
    if (S.direction === 'u2b') { S.simRec = null; return; }   /* this side locks first */
    S.simRec = simRecord();
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
  }

  /* The lock this side owes, landing in the stand-in escrow. */
  function simLockNow() {
    if (S.mode !== 'practice' || !S.H) return null;
    S.simRec = simRecord();
    S.block = curHeight() + 1;
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
    return S.simRec;
  }

  /* No wallet signs in a rehearsal, so the stand-in does: the lock lands a
     moment after the tap, and the reading that follows picks it up. */
  function simLock(delay) {
    var want = normHex(S.H);
    setTimeout(function () {
      if (S.mode !== 'practice' || S.phase !== 'locking' || normHex(S.H) !== want) return;
      simLockNow();
      refreshChain().then(function (c) { if (S.phase === 'locking') lockedMine(c); });
    }, delay == null ? 1500 : delay);
  }

  /* The partner takes the USDT once the sats are paid: the stand-in claims a
     moment later, and the watch that closes a real swap closes this one on
     the same reading. */
  function simClaim(delay) {
    var want = normHex(S.H);
    setTimeout(function () {
      if (S.mode !== 'practice' || S.phase !== 'paid' || normHex(S.H) !== want || !S.simRec) return;
      S.simRec.claimed = true;
      refreshChain().then(function (c) { if (c && c.state === 'claimed') settleByChain(c); });
    }, delay == null ? 2000 : delay);
  }

  /* A pasted transaction hash in Practice stands for the moment the lock
     lands; there is no node to ask about it. */
  function simReceipt() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (S.phase === 'locking' && !S.simRec) simLockNow();
        resolve({ blockNumber: '0x' + (curHeight() + 1).toString(16) });
      }, 900);
    });
  }

  /* The payer says the money left. That starts the watch; the escrow is what
     decides whether the swap is over. */
  function paid() {
    if (S.phase !== 'paying') return;
    /* Paying into the last minutes of the window is how a payer loses: the
       escrow can be refunded before the claim lands. The clock that counts is
       the chain's, read fresh on the tap, because a phone's clock is something
       its owner can move. */
    syncChainTime(true).then(function (now) {
      if (S.phase !== 'paying') return;
      if (S.t2 && S.t2 - now <= PAY_MARGIN) {
        var m = 'The escrow window is closing. Do not pay; ask for a new code.';
        S.note = m;
        log('BLOCK', m, 'c-err');
        render();
        toast(m);
        return;
      }
      log('PAID', S.direction === 'btc2u'
        ? 'the sats have been sent \u00b7 waiting for the escrow to pay out on ' + curChain().label
        : 'the USDT has been sent');
      S.phase = 'paid';
      S.note = '';
      render();
      refreshGate();
      refreshChain().then(function (c) {
        if (!c) return;
        if (c.state === 'claimed') { settleByChain(c); return; }
        if (c.state === 'refunded') { wentBack(c); return; }
        startWatch();
        render();
        refreshGate();
        toast('Watching the chain. Nothing else to tap.');
      });
    });
  }

  /* Approve on a running swap reads the chain again: it is the only button
     that can move `paid` on, and it moves only on what the chain says. */
  function checkChain() {
    if (S.busy) return;
    S.note = '';
    /* Practice: a check on the lock this side owes is the moment the stand-in
       takes it, so the screen never strands a rehearsal. */
    if (S.mode === 'practice' && S.phase === 'locking' && !S.simRec) simLockNow();
    busy(true);
    refreshChain().then(function (c) {
      busy(false);
      if (!c) { toast('Nothing to check yet'); return; }
      if (c.state === 'claimed') { settleByChain(c); return; }
      if (c.state === 'refunded') { wentBack(c); return; }
      if (c.state === 'locked') {
        if (S.phase === 'locking') { lockedMine(c); return; }
        render();
        refreshGate();
        toast('The escrow still holds the USDT');
        return;
      }
      if (S.phase === 'paid') { blockChain(c); return; }
      blockChain(c);
    }, function () { busy(false); });
  }

  function reset() {
    stopWatch();
    S.note = '';
    S.phase = 'idle';
    S.H = null; S.id = null; S.units = null;
    S.t1 = null; S.t2 = null;
    S.inv = ''; S.invDec = null; S.addr = ''; S.expectH = null; S.basis = null;
    S.qrInv = ''; S.chain = null; S.simRec = null; S.txPending = null;
    S.locker = ''; S.funder = ''; S.codeWarn = ''; S.codeAddr = '';
    S.codeTerms = null; S.codeRateWarn = false; S.codeAddrFilled = '';
    S.lockTx = ''; S.claimTx = '';
    clearSecret();
    S.busy = false;
    S.op = ''; S.sending = false;
    var t = $('txIn'); if (t) { t.value = ''; }
    var row = $('secretRow'); if (row) { row.hidden = true; row.dataset.open = '0'; }
    var a = invIn(); if (a) { a.value = ''; a.dataset.state = ''; }
    var b = addrEl(); if (b) { b.value = ''; b.dataset.state = ''; }
    var c = $('codeIn'); if (c) c.value = '';
    var lt = $('lockTxIn'); if (lt) lt.value = '';
    renderCodeWarn();
    var box = $('qrBox'); if (box) box.innerHTML = '';
    var cx = $('codeRow'); if (cx) cx.hidden = true;
    log('RESET', 'state cleared');
    render();
    refreshGate();
  }

  /* Back from the finished swap or the waiting screen keeps the terms on
     screen but not the swap that used them. The window a code set, the hash it
     pinned, the address the escrow saw and the transaction that locked it
     belong to that swap alone: carried into the next one they would build its
     id from the last one's funder, pin a hash nobody will pay, or approve
     against a window that is already half gone. */
  function backToForm() {
    if (S.phase === 'idle') return;
    stopWatch();
    S.phase = 'idle';
    S.qrInv = '';
    S.t2 = null;
    S.expectH = null;
    S.funder = '';
    S.lockTx = '';
    /* A new swap starts without the last one's secret, on the screen and in
       this page, whatever state the last one ended in. */
    clearSecret();
    var box = $('qrBox'); if (box) box.innerHTML = '';
    log('BACK', 'a new swap starts without the last one\u2019s window or transaction');
    render();
    refreshGate();
  }

  /* A code is a stranger's text. It carries terms, never the app's setup:
     the chain is not switched and the escrow address is not written over. A
     code that names an escrow this app does not publish, or one that differs
     from the escrow already set here, is refused whole and nothing on this
     phone changes. That is what stops a code from pointing a swap at a
     contract that only imitates the real one. */
  function refuseCode(msg, detail) {
    S.codeWarn = msg;
    S.codeRateWarn = false;   /* the sentence on screen is this refusal, not the rate */
    log('SECURITY', detail || msg, 'c-err');
    toast(msg);
    renderCodeWarn();
    return false;
  }

  /* The terms a code put on this phone - the window it set, the hash it
     pinned, the address it named and the amount it agreed - belong to the one
     swap that code described. A tap that changes what the swap is (the
     direction, the amount) clears them, so the next swap is not locked under a
     window a stranger chose for another swap, against a hash this side is not
     paying, or from an address that belonged to the other side's role. Asking
     for a new code is what puts those terms back. */
  function clearCodeTerms(why) {
    var had = !!(S.expectH || S.locker || S.codeTerms || S.codeAddr || S.codeWarn || S.t2);
    S.t1 = null; S.t2 = null;
    S.expectH = null;
    S.locker = '';
    S.funder = '';
    S.units = null;
    S.codeTerms = null; S.codeRateWarn = false;
    S.codeWarn = ''; S.codeAddr = '';
    /* An address a code wrote into the field is the partner's, said in the
       code's own voice. One the person typed is theirs and stays. */
    var el = addrEl();
    if (S.codeAddrFilled && el && String(el.value).trim().toLowerCase() === String(S.codeAddrFilled).toLowerCase()) {
      el.value = '';
      el.dataset.state = '';
    }
    S.codeAddrFilled = '';
    renderCodeWarn();
    if (had) log('RESET', why);
  }

  function renderCodeWarn() {
    var el = $('codeWarn');
    if (el) { el.textContent = S.codeWarn || ''; el.hidden = !S.codeWarn; }
    var row = $('codeAddr'), txt = $('codeAddrTxt');
    if (!row || !txt) return;
    if (S.codeAddr) {
      txt.textContent = 'This code names a USDT address (' + short(S.codeAddr, 6) +
        '). Use it only if it is yours.';
      row.hidden = false;
    } else {
      txt.textContent = '';
      row.hidden = true;
    }
  }

  function applyCode(text) {
    var c = parseSwapLink(text);
    if (!c) { toast('That is not a swap code'); return false; }
    var now = effNow();
    if (S.phase === 'settled' || S.phase === 'refunded') { toast('Tap Done first, then use the code.'); return false; }
    /* A code names the terms of the next swap. Loading one into a swap that is
       already running would put different numbers under money that has moved,
       so every phase but idle refuses it. */
    if (S.phase !== 'idle') {
      return refuseCode('A swap is already running. Finish it first, then use the code.',
        'a code was refused while a swap was ' + S.phase);
    }
    if (c.t2 <= now) return refuseCode('Those terms have run out. Ask for a new code.');
    if (c.t2 - now < T2_MIN) {
      return refuseCode('Those terms close too soon to pay and claim. Ask for a new code.',
        'a code with a ' + Math.round((c.t2 - now) / 60) + ' minute window was refused');
    }
    if (c.t2 - now > T2_MAX) return refuseCode('Those terms would lock the money for too long. Ask for a new code.');

    /* The chain and the escrow a wallet code names are requirements, not
       settings. Neither is adopted here. */
    var practice = S.mode === 'practice';
    if (!practice && c.net && c.net !== S.net) {
      return refuseCode('That code is for ' + (CHAINS[c.net] ? CHAINS[c.net].label : c.net) +
        ', and this app is set to ' + curChain().label + '. Switch the network in Setup, then load it again.');
    }
    if (!practice && c.contract) {
      var want = String(c.contract).toLowerCase(), mine = String(S.contract || '').toLowerCase();
      if (mine && mine !== want) {
        return refuseCode('That code names a different escrow contract than the one set here. Nothing was changed.',
          'a code naming escrow ' + want + ' was refused; this phone uses ' + mine);
      }
      if (!mine) {
        if (!isOfficialEscrow(S.net, want)) {
          return refuseCode('That code points at an escrow this app does not publish. Nothing was changed: check it with your partner and set it in Setup yourself.',
            'an unpublished escrow ' + want + ' was refused');
        }
        S.contract = want;
        saveSetup();
        log('SETUP', 'the published escrow for ' + curChain().label + ' came from the code');
      }
    }

    S.direction = opposite(c.direction);
    S.sats = c.sats;
    S.units = c.units;
    S.t2 = c.t2;
    S.t1 = c.t1;
    S.expectH = c.H || null;
    /* The id is the terms plus the funding address: when the other side funds
       the escrow, their code is where that address comes from. */
    S.locker = S.direction === 'btc2u' ? (c.locker || '') : '';
    /* The address the escrow actually saw is learned from the escrow, not from
       a code, so a new set of terms starts without one. */
    S.funder = '';
    /* Where the USDT lands is the one field a code must not set on the side that
       receives it: whoever wrote the code could name their own address, and the
       sats would buy USDT paid to them. On the side that sends the USDT the
       address in a code is the partner's own destination, which is theirs to
       name - that one is filled in. On the receiving side it is only offered,
       for a tap that says it is this phone's address. */
    S.codeAddr = '';
    S.codeAddrFilled = '';
    if (c.address) {
      if (S.direction === 'u2b') { addrEl().value = c.address; S.codeAddrFilled = c.address; }
      else S.codeAddr = c.address;
    }
    S.codeWarn = '';
    S.codeRateWarn = false;
    /* The amounts this code states stay here after the screen is painted: the
       quote can land later, and the check below has to be made again when it
       does (see recheckCodeRate). */
    S.codeTerms = { units: c.units, sats: c.sats };
    renderCodeWarn();
    $('codeRow').hidden = true;
    presetsOn();
    log('CODE', 'terms from the other side \u00b7 ' + fmt(S.sats) + ' sats \u00b7 ' + usdtTxt() + ' USDT');
    if (!practice && S.direction === 'btc2u' && !isAddr(S.locker)) {
      log('CODE', 'the code does not name the address that funds the escrow; paste its lock transaction instead');
    }
    /* The price the code carries is checked against the live quote before
       anything is rendered as accepted. The swap still runs - a partner is
       allowed to quote their own spread - but the screen says how far the
       terms sit from the market, while it is still only terms. A quote that
       has not landed yet is checked again the moment it does. */
    var warn = rateWarnText(c.units, c.sats);
    if (warn) {
      S.codeWarn = warn;
      S.codeRateWarn = true;
      renderCodeWarn();
      var rg = rateGap(c.units, c.sats);
      log('SECURITY', 'a code pricing 1 BTC at ' + fmt(Math.round(rg.codePrice)) + ' USDT was loaded; the live quote says ' +
        fmt(Math.round(S.price)) + ' (' + Math.round(rg.gap * 100) + '% off)', 'c-err');
    }
    render();
    refreshGate();
    toast('Terms loaded');
    return true;
  }

  /* A sample invoice lasts as long as the escrow window plus the margin the
     gate asks for, so a rehearsal exercises the same rule a real invoice has
     to pass. */
  function sampleExpiry() {
    var left = S.t2 ? Math.max(S.t2 - effNow(), T2_MIN) : T2_SPAN;
    return left + T1_MARGIN + 900;
  }

  function sampleInvoice() {
    if (S.mode === 'wallet') return;
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      invIn().value = mintInvoice({ paymentHash: '0x' + H, sats: S.sats, expiry: sampleExpiry() });
      invIn().dataset.state = '';
      render();
      refreshGate();
    }).catch(function () { toast('This device cannot make a sample invoice'); });
  }

  function sampleAddress() {
    if (S.mode === 'wallet') return;
    addrEl().value = DEMO_ADDR;
    addrEl().dataset.state = '';
    render();
    refreshGate();
  }

  /* ---------------------------------------------------------------- QR --- */
  function qrLine(text) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    return p;
  }
  function qrClear(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
  }
  /* The QR is drawn here, element by element, from the encoder's module grid:
     the payload is a stranger's text and markup built out of strings is markup a
     stranger can write. Nothing is parsed, so nothing in the payload can turn
     into a node. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function qrNode(q, quiet) {
    var dim = q.size + quiet * 2, path = '', y, x;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    for (y = 0; y < q.size; y++) {
      for (x = 0; x < q.size; x++) {
        if (q.modules[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
      }
    }
    var el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('fill', '#040e09');
    svg.appendChild(el);
    return svg;
  }
  function showQr(payload, caption, reveal) {
    var box = $('qrBox');
    if (!box) return;
    if (!payload) { qrClear(box); toast('Nothing to show yet'); return; }
    var bytes = utf8(payload).length;
    var q = null, quiet = 2;
    if (bytes <= QR_MAX) {
      ['M', 'L'].forEach(function (level) {
        if (q) return;
        try { q = window.QR.encode(payload, { level: level }); } catch (e) { q = null; }
      });
    }
    qrClear(box);
    var node = q ? qrNode(q, quiet) : null;
    if (!node) {
      box.appendChild(qrLine('Too long for a QR: use Copy instead.'));
      return;
    }
    box.appendChild(node);
    if (caption) box.appendChild(qrLine(String(caption)));
    if (reveal) revealQr(box);
  }

  /* The Approve bar is fixed over the bottom of the page: when a QR opens,
     put all of it above the bar instead of leaving its lower half underneath. */
  function revealQr(box) {
    if (!box || !box.innerHTML) return;
    var bar = document.querySelector('.bar');
    var r = box.getBoundingClientRect();
    var limit = window.innerHeight - (bar ? bar.getBoundingClientRect().height : 80) - 16;
    var delta = r.bottom - limit;
    if (delta <= 0) return;
    var room = r.top - 12;
    window.scrollBy(0, Math.min(delta, Math.max(0, room)));
  }

  /* ------------------------------------------------------------ events --- */
  /* ------------------------------------------------------------- setup --- */
  function openSetup() {
    var box = $('setupBox');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) paintSetup();
  }
  function closeSetup() { var box = $('setupBox'); if (box) box.hidden = true; }

  function setNet(v) {
    var want = v === 'mainnet' ? 'mainnet' : 'testnet';
    if (S.net === want) return;
    /* What was typed belongs to the network it was typed for. It is put away
       under that one before the other network's own escrow, token and
       endpoints are read back, and every reading of the chain goes with it:
       a block height, a timestamp and an escrow record are true of one chain
       only, and none of them may be shown beside another. */
    keepSetup();
    S.net = want;
    applySetup();
    S.rpcState = 'idle';
    S.tokenState = '';
    S.block = null;
    S.blockTs = null; S.blockTsAt = 0; S.blockTsFail = 0;
    S.quorum = 'idle';
    S.chain = null;
    saveSetup();
    paintSetup();
    render();
    refreshGate();
    if (S.mode === 'wallet' && isAddr(S.contract)) {
      chainProbe().then(function () { if (S.H) refreshChain(); });
    }
  }

  /* What was typed, checked for shape only: nothing is stored here, so a
     token that the chain then refuses leaves the setup as it was. */
  function parseSetup() {
    var c = String($('contractIn').value || '').trim();
    var t = String($('tokenIn').value || '').trim();
    var r = String($('rpcIn').value || '').trim();
    if (c && !isAddr(c)) {
      toast(/^0x[0-9a-fA-F]{40}$/.test(c)
        ? 'That contract address has a mistyped character: its capitals do not spell it the way an address spells itself'
        : 'That contract address is not a 0x one');
      return null;
    }
    if (t && !isAddr(t)) {
      toast(/^0x[0-9a-fA-F]{40}$/.test(t)
        ? 'That token address has a mistyped character: its capitals do not spell it the way an address spells itself'
        : 'That token address is not a 0x one');
      return null;
    }
    if (r && !endpointsOk(r)) { toast('Every endpoint has to be an https one'); return null; }
    return { contract: c.toLowerCase(), token: t.toLowerCase(), rpc: r };
  }

  function commitSetup(v) {
    S.contract = v.contract;
    S.token = v.token;
    S.rpc = v.rpc;
    S.rpcState = 'idle';
    S.quorum = 'idle';
    S.chain = null;
    saveSetup();
    paintSetup();
    render();
    refreshGate();
  }

  /* Save and Check go through here: the shape is read first, then the token is
     asked about on the chain the setup is about to name. A token that is not a
     contract, or that counts in other decimals, is refused before it is stored
     and before any amount is priced against it. A chain that does not answer is
     not a verdict about the token: the setup is kept, marked unread, and the
     panel says so - nothing is refused on silence alone. */
  function applySetupFromForm(done) {
    var v = parseSetup();
    if (!v) return;
    function after() { if (done) done(); }
    if (!v.token) {
      S.tokenState = 'ok';        /* the chain's own token is the one this page counts in */
      commitSetup(v);
      after();
      return;
    }
    var list = endpointList(v.rpc);
    if (!list.length) list = curChain().rpc.slice();
    tokenVerdict(v.token, list).then(function (r) {
      if (r.ok) {
        S.tokenState = 'ok';
        commitSetup(v);
        log('SETUP', 'the token at ' + short(v.token, 6) + ' is a contract and counts in ' + r.decimals + ' decimals');
        paintSetup();
        after();
        return;
      }
      if (r.why === 'unread') {
        commitSetup(v);
        S.tokenState = 'unread';
        log('SETUP', 'the token at ' + short(v.token, 6) + ' was kept unread: the chain did not answer', 'c-err');
        paintSetup();
        toast('The chain did not answer, so the token was kept unread. Check again when it answers.');
        after();
        return;
      }
      /* A definite answer against the token: the token is not stored, and the
         escrow and endpoints typed with it are - fixing the token then costs
         one field, not the whole panel again. The refused address stays in
         the field, and the sentence says which answer it was. */
      S.contract = v.contract;
      S.rpc = v.rpc;
      S.rpcState = 'idle';
      S.quorum = 'idle';
      S.chain = null;
      S.tokenState = 'wrong';
      saveSetup();
      paintSetup();
      var el = $('tokenIn'); if (el) el.value = v.token;
      var msg = tokenWhy(r);
      log('SETUP', msg, 'c-err');
      toast(msg);
    }, function () {
      commitSetup(v);
      S.tokenState = 'unread';
      paintSetup();
      toast('The chain did not answer, so the token was kept unread. Check again when it answers.');
      after();
    });
  }

  function readSetup() {
    var v = parseSetup();
    if (!v) return false;
    commitSetup(v);
    return true;
  }

  var ACT = {
    mode: function (b) {
      S.mode = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      if (S.phase !== 'idle') backToForm();
      /* the two escrows are not each other's: a rehearsal's stand-in record
         never carries into a real swap, and a chain reading never into one */
      S.simRec = null;
      S.chain = null;
      closeSetup();
      render();
      refreshGate();
      if (S.mode === 'wallet' && isAddr(S.contract)) chainProbe().then(function () { if (S.H) refreshChain(); });
    },
    settings: function () {
      /* Setup is where an escrow is deployed and pointed at; a rehearsal runs
         on the stand-in, so there is nothing to set there. */
      if (S.mode === 'practice') { toast('Practice runs on a stand-in escrow, so there is nothing to set.'); return; }
      openSetup();
    },
    net: function (b) { setNet(b.dataset.v); },
    saveSetup: function () {
      applySetupFromForm(function () { chainProbe().then(function () { if (S.H) refreshChain(); }); });
    },
    checkSetup: function () {
      applySetupFromForm(function () {
        chainProbe().then(function () {
          if (S.rpcState === 'ok') toast(S.tokenState === 'unread'
            ? 'The chain answers, but the token was not read'
            : 'The chain answers');
          else if (S.rpcState === 'unclear') toast('The endpoints disagree about that address');
          else if (S.rpcState === 'nocon') toast('No contract at that address');
          else if (S.rpcState === 'nohtlc') toast('That address is not the swap contract');
          else toast('The chain did not answer');
          paintSetup();
        });
      });
    },
    copyBytecode: function () { copy(BYTECODE, 'Bytecode copied'); },
    checkChain: function () { checkChain(); },
    walletSend: function () {
      var p = provider();
      if (!p) { toast('No wallet in this page: copy the call instead'); return; }
      if (quoteMissing()) { refuseRate(); return; }
      runLock(p);
    },
    copyCall: function () {
      if (!isAddr(escrowNow()) || !S.H) { toast('Nothing to copy yet'); return; }
      if (S.phase === 'locking') { copy(callPacket(lockCall(), 'lock'), 'Call copied'); return; }
      toast('Nothing to copy yet');
    },
    copyApprove: function () {
      if (!isAddr(tokenNow())) { toast('Nothing to copy yet'); return; }
      copy(callPacket(approveCall(), 'approve'), 'Approve call copied');
    },
    openTx: function () {
      var row = $('txRow');
      if (!row) return;
      row.hidden = !row.hidden;
      if (!row.hidden) $('txIn').focus();
    },
    loadTx: function () { loadTx($('txIn').value); },
    useLockTx: function () { loadTx($('lockTxIn').value); },
    claimOpen: function () {
      var row = $('secretRow');
      if (!row) return;
      var open = row.hidden;
      row.hidden = !open;
      row.dataset.open = open ? '1' : '0';
      if (open) $('secretIn').focus();
    },
    sendClaim: function () {
      S.secret = normHex($('secretIn').value || '');
      doClaim();
    },
    sendRefund: function () { doRefund(); },
    direction: function () {
      if (S.phase === 'settled' || S.phase === 'refunded') return;
      S.direction = opposite(S.direction);
      /* The other direction is funded by the other side: an address learned
         for one side is not this side's. */
      S.funder = '';
      /* And the terms a code wrote belong to the swap it described, not to the
         one this flip starts: the window it set, the hash it pinned, the
         funding address it named and the amount it agreed are all its own.
         Carried over, the next swap would be locked under a window someone
         else chose for the other direction, against a hash this side is not
         paying. The sats stay - they are the amount this side picked. */
      clearCodeTerms('the direction flip left the last code\u2019s window, hash, funder and amount behind');
      render();
      refreshGate();
    },
    sats: function (b) {
      if (S.phase === 'settled') return;
      S.sats = Number(b.dataset.v);
      S.units = null;
      /* A new amount is a new swap: the window, the hash and the funding
         address a code set were agreed for the old amount. */
      clearCodeTerms('a new amount left the last code\u2019s window, hash and funder behind');
      presetsOn();
      render();
      refreshGate();
    },
    primary: function () { approve(); },
    back: function () { backToForm(); },
    /* Sharing a code on the side that funds the escrow asks the wallet who it
       is first: the id is the terms plus that address, so the partner cannot
       check the escrow without it. */
    /* A code states the terms of a swap, and a term of zero is not a term: an
       exchange rate that has not loaded yet cannot be written as "0 USDT" and
       handed to the other side, so no code is made here at all. */
    copyCode: function () {
      ensureMe().then(function () {
        var code;
        try { code = swapCode(); } catch (e) {
          log('BLOCK', String((e && e.message) || e), 'c-err');
          render();
          toast(String((e && e.message) || e));
          return;
        }
        copy(code, 'Code copied');
        render();
      });
    },
    qrCode: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      ensureMe().then(function () {
        var code;
        try { code = swapCode(); } catch (e) {
          log('BLOCK', String((e && e.message) || e), 'c-err');
          render();
          toast(String((e && e.message) || e));
          return;
        }
        S.qrInv = code;
        showQr(code, 'Your partner scans this for the same terms', true);
        render();
      });
    },
    pasteCode: function () {
      var row = $('codeRow');
      row.hidden = false;
      var el = $('codeIn');
      el.focus();
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) {
          if (t && !el.value) { el.value = String(t).trim(); }
        }, function () { /* typing it in is fine too */ });
      }
    },
    useCodeAddr: function () {
      if (!S.codeAddr) return;
      addrEl().value = S.codeAddr;
      addrEl().dataset.state = '';
      S.codeAddr = '';
      log('CODE', 'the USDT address the code named was used, after a tap');
      renderCodeWarn();
      render();
      refreshGate();
    },
    useCode: function () {
      var v = String($('codeIn').value || '').trim();
      if (!v) { toast('Paste the code first'); return; }
      applyCode(v);
    },
    copyInvoice: function () {
      var inv = readInvoice(pasted());
      if (!inv.ok) { needInvoice(); return; }
      copy(String(pasted()).replace(/^lightning:/i, ''), 'Invoice copied');
    },
    qrInvoice: function () {
      var inv = readInvoice(pasted());
      if (!inv.ok) { needInvoice(); return; }
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      var raw = String(pasted()).replace(/^lightning:/i, '');
      S.qrInv = raw;
      showQr('lightning:' + raw, S.direction === 'btc2u'
        ? 'The invoice for this swap'
        : 'Your partner scans this to pay you', true);
    },
    sampleInv: function () { sampleInvoice(); },
    sampleAddr: function () { sampleAddress(); },
    payCopyInv: function () {
      if (!S.inv) { needInvoice(); return; }
      copy(S.inv, 'Invoice copied');
    },
    payQrInv: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      if (!S.inv) { needInvoice(); return; }
      S.qrInv = S.inv;
      showQr('lightning:' + S.inv, 'The invoice for this swap', true);
    },
    payCopyAddr: function () {
      if (!S.addr) { toast('Nothing to copy yet'); return; }
      copy(S.addr, 'Address copied');
    },
    payQrAddr: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      if (!S.addr) { toast('Nothing to show yet'); return; }
      S.qrInv = S.addr;
      showQr(S.addr, 'The address the USDT goes to', true);
    },
    reset: function () { reset(); }
  };

  function loadRate() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 5000);
    fetch('https://mempool.space/api/v1/prices', ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var usd = Number(j && j.USD);
        if (!isFinite(usd) || usd <= 0) throw new Error('no USD field');
        S.price = usd; S.pstate = 'live';
      })
      .catch(function () { S.price = FALLBACK_PRICE; S.pstate = 'offline'; })
      .then(function () {
        clearTimeout(timer);
        /* A code can arrive before this quote does - the deep link in the
           address bar is read at boot, while the price is still loading - and
           the check it earns against the market is made again here, before
           the screen is painted. */
        recheckCodeRate();
        render(); refreshGate();
      });
  }

  /* ---------------------------------------------------------------- boot -- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var fn = ACT[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b); }
  });

  // A blank wallet link would open a wallet on nothing: say what is missing
  // instead. A rehearsal has no wallet to hand anything to, and its invoice is
  // a sample, so it keeps the hand-off on the phone.
  function walletHandoff(e) {
    if (S.mode === 'practice') {
      e.preventDefault();
      toast('Practice keeps this on the phone: no wallet opens.');
      return;
    }
    var ok = e.currentTarget.id === 'payWalletLink' ? !!S.inv : readInvoice(pasted()).ok;
    if (!ok) { e.preventDefault(); needInvoice(); }
  }
  ['walletLink', 'payWalletLink'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', walletHandoff);
  });

  [invIn(), addrEl(), $('codeIn')].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function () { render(); refreshGate(); });
  });

  loadSetup();
  render();
  refreshGate();
  presetsOn();
  loadRate();
  if (S.mode === 'wallet' && isAddr(S.contract)) chainProbe();

  // A code can arrive in the address bar of a hosted copy, or from the app
  // shell when another app hands it over. Nothing here is ever generated.
  var fromUrl = parseSwapCode(String(location.search) + ' ' + String(location.hash));
  if (fromUrl) applyCode(String(location.search) + ' ' + String(location.hash));

  /* What this page leaves on the window. The host shell needs one entry -
     `acceptCode`, to hand a swap code over from another app - and the page's
     own verification suites drive the rest through the same handle. The state
     is shared as a view, not as the object itself: the view answers every
     field the suites and a host may watch or set for a test, but keeps the
     one thing on this page worth stealing out of the window entirely -
     this side's payment secret, the 32 bytes that open the escrow leg. The
     app itself reads its state through the closure, so the guard costs the
     page nothing and the secret never crosses it. Every other export is
     either an action the page's own buttons call or a pure helper whose code
     ships in the same file anyone can download. */
  function guardedState() {
    return new Proxy(S, {
      /* `secretHeld` is a boolean about the state, never the state itself: the
         suites can see that the page let go of a finished swap's secret
         without the window ever holding the bytes. */
      get: function (o, k) {
        if (k === 'secret') return undefined;
        if (k === 'secretHeld') return !!o.secret;
        return o[k];
      },
      has: function (o, k) { return k !== 'secret' && k in o; },
      ownKeys: function (o) {
        return Reflect.ownKeys(o).filter(function (k) { return k !== 'secret'; });
      },
      getOwnPropertyDescriptor: function (o, k) {
        return k === 'secret' ? undefined : Reflect.getOwnPropertyDescriptor(o, k);
      },
      set: function (o, k, v) { if (k === 'secret') return false; o[k] = v; return true; },
      deleteProperty: function (o, k) { if (k === 'secret') return false; delete o[k]; return true; },
      defineProperty: function (o, k, d) {
        if (k === 'secret') return false;
        Object.defineProperty(o, k, d);
        return true;
      }
    });
  }

  window.CLEANSWAP = {
    state: guardedState(), acceptCode: function (t) { return applyCode(t); }, applyCode: applyCode,
    SEL: SEL, EVM: EVM, CHAINS: CHAINS, QR_MAX: QR_MAX, NET: NET, T2_SPAN: T2_SPAN,
    T2_MIN: T2_MIN, T2_MAX: T2_MAX, T1_MARGIN: T1_MARGIN, PAY_MARGIN: PAY_MARGIN,
    b64field: b64field, unB64field: unB64field,
    BYTECODE: BYTECODE, lockerNow: lockerNow, ensureMe: ensureMe, isOfficialEscrow: isOfficialEscrow,
    invoiceExpiry: invoiceExpiry, windowProblem: windowProblem, rpcQuorum: rpcQuorum, endpoints: endpoints,
    sha256Hex: sha256Hex, sha256Bytes: sha256Bytes, computeSwapId: computeSwapId, bech32Decode: bech32Decode,
    SECP: SECP, wordsToInt: wordsToInt, fromHex: fromHex, effNow: effNow, syncChainTime: syncChainTime,
    unitsTxt: unitsTxt,
    KECCAK: KECCAK, eip55: eip55, checksumOk: checksumOk, isAddr: isAddr,
    quorumKey: quorumKey, LOCKED_TOPIC: LOCKED_TOPIC, readLockedLog: readLockedLog,
    lockedLogFits: lockedLogFits,
    base58Bytes: base58Bytes, tronAddressBytes: tronAddressBytes, chainOf: chainOf,
    decodeBolt11: decodeBolt11, decodeBolt12: decodeSwapOffer, decodeSwapOffer: decodeSwapOffer,
    mintInvoice: mintInvoice, mintOffer: mintOffer,
    lockCalldata: lockCalldata, decodeLockCalldata: decodeLockCalldata, readLockProof: readLockProof,
    claimCalldata: claimCalldata, refundCalldata: refundCalldata, swapsCalldata: swapsCalldata,
    approveCalldata: approveCalldata, decodeSwap: decodeSwap, classify: classify, chainSay: chainSay,
    swapIdNow: swapIdNow, readSwap: function (id) { return rpc('eth_call', [{ to: S.contract, data: swapsCalldata(id) }, 'latest']).then(decodeSwap); },
    chainRead: chainRead, refreshChain: refreshChain, chainProbe: chainProbe,
    loadSetup: loadSetup, saveSetup: saveSetup, curChain: curChain,
    readEscrow: readEscrow, readInvoice: readInvoice, readAddress: readAddress,
    parseLightning: parseLightning, nextCalldata: nextCalldata, escrowProof: escrowProof,
    escrowUnits: escrowUnits, usdtUnits: usdtUnits, usdtTxt: usdtTxt, tokenNow: tokenNow,
    swapCode: swapCode, parseSwapCode: parseSwapCode, parseSwapLink: parseSwapLink,
    rateGap: rateGap, RATE_WARN: RATE_WARN, ZERO_ID: ZERO_ID,
    rateWarnText: rateWarnText, quoteMissing: quoteMissing, invNetOk: invNetOk,
    watchOnce: watchOnce, startWatch: startWatch,
    render: render, refreshGate: refreshGate, validate: validate, paintGate: paintGate,
    approve: approve, paid: paid, reset: reset, backToForm: backToForm, presetsOn: presetsOn,
    checkChain: checkChain, settleByChain: settleByChain, loadTx: loadTx,
    sampleInvoice: sampleInvoice, sampleAddress: sampleAddress, revealQr: revealQr, showQr: showQr,
    historyEntry: historyEntry, pasted: pasted, addrIn: addrIn
  };
})();
