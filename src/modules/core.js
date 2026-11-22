  /* core.js - the constants, the state object, hashing, formatting and the on-screen log */
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
  /* The two legs have to expire in the right order. The bitcoin side's payment
     lives in a Lightning HTLC at the payee, and the payee's node states how
     many blocks it keeps it: the invoice's `c` tag (BOLT 11's 18 blocks when the
     tag is absent). The USDT escrow closes at T2, the claim publishes the
     secret, and the payee settles with it after that - so the sats must not be
     able to come back before the escrow is over, or one secret would collect
     both legs: the payment returns at its expiry while the USDT is still
     claimable. A window that does not clear the payment's own deadline by
     LN_SAFETY_SECS is refused before anything is approved.

     The deltas a route hint states are not added here: they say how long the
     payer's own funds are held by the hops before the payee, while the deadline
     that matters is the payee's incoming HTLC, which the final delta sets. A few
     blocks on top of that cover the last hop's own hold, which is the routing
     margin this check keeps. */
  var LN_CLTV_DEFAULT = 18;         /* min_final_cltv_expiry when the invoice carries no c tag */
  var LN_ROUTE_MARGIN_CLTV = 3;     /* blocks kept for the last hop's own hold */
  var LN_SAFETY_SECS = 3600;        /* the claim side keeps this long after the escrow closes */

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
    price: null, pstate: 'loading',   /* the quote and its verdict: live | single | disagree | offline */
    priceAt: 0,                     /* when that quote landed, ms; its age is what PRICE_TTL judges */
    rateWait: false,                /* a fresh read is in flight before a tap goes on */
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
    codeAsk: null,                  /* a code from another app, waiting for a tap: {text, say} */
    codeAsk: null,                  /* a code from another app, waiting for a tap: {text, say} */
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
