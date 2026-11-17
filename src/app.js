/* CLEANSWAP v0.4.3 — Lightning bitcoin <-> USDT atomic swap in one file.

   The screen stays out of the way: two amount cards, one plain sentence and
   one big button per step, the way a payment app reads. No symbol names, no
   hashes and no raw hex are ever shown; practice mode needs no pasting at all.
   Underneath, every step is still gated on data a real swap would need, and
   the gate runs here, in the browser:

     step 1  a BOLT12 offer or invoice (or a BOLT11 hold invoice): an offer is
             paid straight from the wallet, an invoice's payment_hash is H
     step 2  the counterparty's escrow lock, decoded and matched against H, T2
             and the USDT amount (lock() calldata, JSON record, Liquid lock URI
             or a lock transaction hash)
     step 3  the 32-byte preimage R, accepted only when SHA256(R) === H

   Wallet mode does not call a swap complete on the Approve tap: the tap parks
   the screen on "Waiting for payment", showing what to pay, and only the
   `I paid` tap that follows closes the swap and produces the receipt.

   BOLT12 is the default format. A BOLT12 offer cannot carry a payment_hash by
   itself, so every offer the app mints embeds the swap's hashlock in a custom
   type-80 TLV, and an offer from someone else's wallet (Lexe, say) binds the
   swap to its own string instead: H = SHA-256 of the offer's TLV bytes, which
   the same offer gives on both phones. Invoices the app mints use the standard
   invoice_payment_hash field. BOLT11 hold invoices stay fully accepted as input.

   The USDT address is either an EVM one (`0x` + 40 hex) or a TRON TRC-20 one
   (`T` + 33 base58 characters, checked with its real Base58Check checksum).

   Practice mode runs both sides on one screen (invoice mint, escrow lock,
   reveal) with real WebCrypto, real bech32 and real ABI encoding, and a share
   link that turns another tab into the USDT side. The practice partner is
   simulated, so no code is pasted; the same decoders check what it produces.
   Wallet mode swaps the simulated partner for a real invoice, a real wallet
   hand-off and the values the other side sends back.

   No chain, no funds, no browser-extension wallet. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* keccak256(signature) selectors — verified against solc 0.8.26 --hashes */
  var SEL = { lock: '91644b2b', claim: '84cc9dfb', refund: '7249fbb6' };
  var EVM = {
    btcSide: '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',   /* receives the USDT */
    usdtSide: '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761',  /* locks the USDT */
    htlc: '0x9d1f4c7a2b8e6035f4a7c1d9028be35f7a6c4d18',
    token: '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097'
  };
  var FALLBACK_PRICE = 90000;
  var QR_MAX = 340;                 /* bytes at level L, version 13 (the encoder's ceiling) */
  var QR_M = 269;                   /* bytes at level M, version 12 */
  var NET = 'bc';                   /* invoice network prefix */
  /* A practice address, so the rehearsal has somewhere to send USDT. */
  var DEMO_ADDR = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
  var T2_SPAN = 3600;               /* USDT escrow window, seconds */
  var T1_BLOCKS = 40;               /* ~6h40m of bitcoin blocks */
  var BLOCK_SECS = 600;

  var S = {
    mode: 'practice',               /* practice | wallet */
    direction: 'btc2u',             /* what leaves this phone: btc2u sends BTC, u2b sends USDT */
    phase: 'idle',                  /* idle (filling the three steps in) | settled */
    sats: 50000,
    price: null, pstate: 'loading',
    units: null,                    /* agreed USDT amount, micro-units */
    H: null, id: null,
    t1: null, t2: null,
    sim: 0, h0: 923452,
    inv: '', invDec: null,          /* the Lightning invoice on the screen */
    basis: null,                    /* how the bitcoin leg is paid: invoice | offer */
    addr: '',                       /* the USDT address on the screen */
    expectH: null,                  /* hashlock pinned by a code from the other side */
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
  function fromHex(h) {
    var clean = String(h).replace(/^0x/i, ''), out = new Uint8Array(Math.floor(clean.length / 2)), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    return out;
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
    return spanTxt(S.t2 - nowSec());
  }
  function isAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a || '')); }
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
  /* mirrors computeSwapId(): sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock)) */
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
  function bytesToWords(bytes) {
    var acc = 0, bits = 0, out = [], i;
    for (i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
    }
    if (bits) out.push((acc << (5 - bits)) & 31);
    return out;
  }
  function wordsToInt(words) {
    var n = 0, i;
    for (i = 0; i < words.length; i++) n = n * 32 + words[i];
    return n;
  }
  function intWords(n, len) {
    var out = [], i;
    for (i = len - 1; i >= 0; i--) out.push(Math.floor(n / Math.pow(32, i)) % 32);
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
    var mult = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, '': 1 };
    var amtBtc = m[2] ? Number(m[2]) * mult[m[3] || ''] : null;
    var ts = wordsToInt(words.slice(0, 7));
    var body = words.slice(7, words.length - 104), fields = {}, i = 0, type, len, ch;
    while (i + 3 <= body.length) {
      type = body[i];
      len = (body[i + 1] << 5) | body[i + 2];
      if (i + 3 + len > body.length) throw new Error('truncated field');
      ch = String.fromCharCode(96 + type);
      if (type >= 1 && type <= 26) (fields[ch] = fields[ch] || []).push(body.slice(i + 3, i + 3 + len));
      i += 3 + len;
    }
    var ph = fields.p && fields.p[0];
    var expiry = fields.x && fields.x[0] ? wordsToInt(fields.x[0]) : null;
    var desc = fields.d && fields.d[0] ? new TextDecoder().decode(wordsToBytes(fields.d[0])) : null;
    return {
      kind: 'bolt11',
      network: m[1],
      sats: amtBtc == null ? null : Math.round(amtBtc * 1e8),
      paymentHash: ph && ph.length === 52 ? '0x' + hexOf(wordsToBytes(ph)) : null,
      timestamp: ts,
      expiry: expiry,
      expiresAt: expiry == null ? null : ts + expiry,
      description: desc,
      tags: Object.keys(fields).sort().join('')
    };
  }

  /* BOLT11 encoder — a hold invoice whose payment_hash the payer cannot choose.

     Field order follows the spec: 35-bit timestamp, then tagged fields, then a
     65-byte signature slot (104 words, exactly). The slot is deterministic
     filler derived from the payment hash: this app parses and checks the
     checksum and the fields, it does not do secp256k1, and every minted invoice
     says so in the log. */
  function amountPart(sats) {
    if (!sats) return '';
    if (sats % 100 === 0) return (sats / 100) + 'u';   /* 1u = 100 sats */
    return (sats * 10) + 'n';                          /* 1n = 0.1 sats */
  }
  function tagField(ch, words) {
    return [ch.charCodeAt(0) - 96, words.length >> 5, words.length & 31].concat(words);
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
    var seed = fromHex(o.paymentHash), filler = new Uint8Array(65), i;
    for (i = 0; i < 65; i++) filler[i] = seed[i % 32] ^ ((i * 37 + 11) & 255);
    filler[64] = 27;
    function build(desc) {
      var body = intWords(ts, 7).concat(tagField('p', bytesToWords(seed)));
      if (desc) body = body.concat(tagField('d', bytesToWords(utf8(desc))));
      body = body.concat(tagField('x', intToVec(x)));
      body = body.concat(bytesToWords(filler));
      return assembleBech32(hrp, body);
    }
    var out = build(null);
    if (o.description) {
      var withDesc = build(o.description);
      if (withDesc.length <= QR_M) out = withDesc;
    }
    return out;
  }

  /* ------------------------------------------------- BOLT12 offers/invoices --
     The swap format, and the default one: TLVs over bech32 without a checksum.
     An offer cannot carry a payment_hash, so offers minted here embed the swap
     hashlock in a custom type-80 TLV; a real invoice carries the standard
     invoice_payment_hash (168). Both decode through the same reader. */
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
      return { value: ((u8[i + 1] << 24) >>> 0) + (u8[i + 2] << 16) + (u8[i + 3] << 8) + u8[i + 4], next: i + 5 };
    }
    if (i + 8 >= u8.length) throw new Error('truncated BigSize');
    v = 0n;
    for (j = 1; j <= 8; j++) v = (v << 8n) | BigInt(u8[i + j]);
    return { value: Number(v), next: i + 9 };
  }
  var OFFER_TYPES = {
    2: 'offer_chains', 4: 'offer_metadata', 6: 'offer_currency', 8: 'offer_amount',
    10: 'offer_description', 12: 'offer_features', 14: 'offer_absolute_expiry',
    16: 'offer_paths', 18: 'offer_issuer', 20: 'offer_quantity_max',
    22: 'node_id', 80: 'signature'
  };
  /* type 80 carries the swap's payment_hash in every string the app mints: an
     offer cannot hold one by itself, so the hashlock travels with it. */
  var SWAP_HASH_TYPE = 80;
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
      fields[t.value] = bytes.slice(i, i + l.value);
      order.push(t.value);
      i += l.value;
    }
    var dec = new TextDecoder();
    function beUint(u8) {
      var v = 0n, j;
      for (j = 0; j < u8.length; j++) v = (v << 8n) | BigInt(u8[j]);
      return Number(v);
    }
    function num(type) { return fields[type] ? beUint(fields[type]) : null; }
    function txt(type) { return fields[type] ? dec.decode(fields[type]) : null; }
    var form = /^lni1/i.test(o) ? 'invoice' : 'offer';
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
      paymentHash: hash && hash.length === 32 ? '0x' + hexOf(hash)
        : (fields[168] && fields[168].length === 32 ? '0x' + hexOf(fields[168]) : null),
      sats: fields[170] ? Math.round(beUint(fields[170]) / 1000)
        : (fields[8] && !fields[6] ? Math.round(beUint(fields[8]) / 1000) : null),
      amount: num(8),
      currency: txt(6),
      description: txt(10),
      issuer: txt(18),
      absoluteExpiry: fields[164] ? beUint(fields[164]) + (fields[166] ? beUint(fields[166]) : 7200)
        : (num(14) || null),
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
  function pad64(hex) { return ('0'.repeat(64) + hex).slice(-64); }
  function encU256(v) { return pad64(BigInt(v).toString(16)); }
  function encAddr(a) { return pad64(String(a).toLowerCase().replace(/^0x/, '')); }
  function lockCalldata(o) {
    return '0x' + SEL.lock + encU256(o.hashlock) + encU256(o.timelock) +
      encAddr(o.receiver) + encAddr(o.token) + encU256(o.amount);
  }
  /* Only an EVM address has a lock() call here: a TRON address is a wallet-level
     hand-off, so the app does not pretend to build calldata for it. */
  function escrowProof() {
    if (!isAddr(S.addr)) return '';
    return lockCalldata({
      hashlock: S.H, timelock: S.t2, receiver: S.addr,
      token: EVM.token, amount: usdtUnits()
    });
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
  /* The escrow half of the swap, as the contract call the page would send:
     lock(H, T2, the USDT receiver, the token, the amount). */
  function nextCalldata() {
    if (!S.H || !S.addr || !S.t2 || !isAddr(S.addr)) return '';
    return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: EVM.token, amount: usdtUnits() });
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

  /* A code states what the sender of the code does; the phone that reads it
     takes the other side, so the same code reads correctly from both ends. */
  function swapCode() {
    if (!S.t2) { S.t2 = nowSec() + T2_SPAN; S.t1 = curHeight() + T1_BLOCKS; }
    var body = { v: 1, d: S.direction, s: S.sats, u: usdtUnits(), t2: S.t2, t1: S.t1 };
    var inv = readInvoice(pasted());
    if (inv.ok) body.h = normHex(inv.H);
    var ad = readAddress(addrIn());
    if (ad.ok) body.a = ad.address;
    return CODE_PREFIX + b64urlEncode(JSON.stringify(body));
  }

  function readCodeBody(json) {
    if (!json || Number(json.v) !== 1) return null;
    var sats = Number(json.s), units = Number(json.u), t2 = Number(json.t2), t1 = Number(json.t1 || 0);
    if (!isFinite(sats) || !isFinite(units) || !isFinite(t2) || !isFinite(t1)) return null;
    if (!(sats > 0) || !(units > 0) || !(t2 > 0)) return null;
    var h = normHex(json.h || ''), a = String(json.a || '');
    return {
      direction: json.d === 'u2b' ? 'u2b' : 'btc2u',
      sats: Math.round(sats), units: Math.round(units), t2: Math.round(t2), t1: Math.round(t1),
      H: /^([0-9a-f]{2}){32}$/.test(h) ? '0x' + h : null,
      address: chainOf(a) ? a : null
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
    var sats = Number(p[2]), units = Number(p[3]), t2 = Number(p[4]), t1 = Number(p[5] || 0);
    if (!(sats > 0) || !(units > 0) || !(t2 > 0)) return null;
    return {
      direction: 'btc2u', sats: Math.round(sats), units: Math.round(units),
      t2: Math.round(t2), t1: Math.round(t1),
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

  function parseLightning(raw) {
    var t = String(raw || '').trim().replace(/^lightning:/i, '');
    if (!t) return null;
    if (/^ln[io]1/i.test(t)) return decodeSwapOffer(t);
    return decodeBolt11(t);
  }

  /* The Lightning half of the swap. Its payment hash IS the swap: the same H
     locks the USDT escrow, so whoever settles one leg settles both.

     A BOLT12 offer (`lno1...`, what Lexe and other BOLT12 wallets hand out) is
     a payment target a wallet can pay straight from `lightning:lno1...`: the
     wallet comes back with the invoice. It carries no payment_hash of its own
     (the type-80 TLV below is this app's own), so an offer binds the swap to
     itself: H is the SHA-256 of the offer, which the same string gives on both
     phones. An offer this app minted kept its hashlock, so that one wins. */
  function readInvoice(raw) {
    var t = String(raw || '').trim();
    if (!t) return bad('empty', 'Paste the invoice for this swap.');
    var d;
    try { d = parseLightning(t); } catch (e) { return bad('format', 'That invoice cannot be read. Paste the whole thing.'); }
    if (!d) return bad('format', 'That invoice cannot be read. Paste the whole thing.');
    var offer = d.kind === 'bolt12' && d.form === 'offer';
    var H = d.paymentHash ? '0x' + normHex(d.paymentHash) : null;
    if (!H && offer) {
      if (!d.payload || !d.payload.length) return bad('format', 'That offer cannot be read. Paste the whole thing.');
      H = '0x' + hexOf(sha256Bytes(d.payload));
    }
    if (!H) return bad('format', 'That invoice carries no payment hash to lock on.');
    if (S.expectH && normHex(H) !== normHex(S.expectH)) {
      return bad('mismatch', 'That invoice is for a different swap. Ask for the one made from this code.');
    }
    if (d.sats != null && Number(d.sats) !== Number(S.sats)) {
      return bad('amount', 'That invoice is for ' + fmt(d.sats) + ' sats, not ' + fmt(S.sats) + '.');
    }
    var exp = d.absoluteExpiry != null ? d.absoluteExpiry : (d.expiresAt != null ? d.expiresAt : null);
    if (exp != null && nowSec() > exp) return bad('expired', 'That invoice has expired. Ask for a new one.');
    if (d.kind === 'bolt11' && d.network !== NET) return bad('network', 'That invoice is for another bitcoin network.');
    return good(offer ? 'Offer ready. Your wallet pays it and gets the invoice.' : 'Invoice ready.',
      { dec: d, H: H, basis: offer ? 'offer' : 'invoice' });
  }

  /* The USDT half: where the USDT lands. Two forms of USDT are what people
     actually paste, the EVM tokens (`0x` + 40 hex) and TRON's TRC-20 (`T` + 33
     base58 characters, checked with its real Base58Check checksum). */
  function readAddress(raw) {
    var a = String(raw || '').trim();
    if (!a) return bad('empty', 'Add the USDT address for this swap.');
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
      if (/^0x0{40}$/i.test(a)) return bad('format', 'That address cannot receive anything. Use your own wallet address.');
      return good('Address ready.', { address: a.toLowerCase(), chain: 'evm' });
    }
    if (a.charAt(0) === 'T' || a.charAt(0) === 't') {
      var payload = tronAddressBytes(a);
      if (!payload) {
        return bad('format', 'That T address is not valid. A TRON address is 34 characters and has no 0, O, I or l in it.');
      }
      if (isZeroBytes(payload)) return bad('format', 'That address cannot receive anything. Use your own wallet address.');
      return good('Address ready.', { address: a, chain: 'tron' });
    }
    return bad('format', 'That is not a USDT address. It starts with 0x (40 characters) or T (34 characters).');
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
      var q = {};
      if (qi >= 0) {
        body.slice(qi + 1).split('&').forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
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
    if (p.kind === 'calldata' && p.selector !== SEL.lock) return bad('format', 'That lock code cannot be read.');
    var locked = String(p.hashlock || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(locked)) return bad('format', 'That lock code cannot be read.');
    if (normHex(locked) !== normHex(S.H)) return bad('mismatch', 'That lock is for a different swap.');
    if (String(p.timelock) !== String(S.t2)) return bad('timelock', 'That lock ends at the wrong time.');
    var held = Number(p.amount), want = Number(usdtUnits());
    if (!(held > 0)) return bad('amount', 'That lock has no amount.');
    if (held !== want) return bad('amount', 'That lock holds ' + (held / 1e6).toFixed(2) + ' USDT, not ' + usdtTxt() + '.');
    return good('The USDT side is locked.', { dec: p });
  }

  function escrowUnits() {
    if (!isAddr(S.addr)) return '';
    return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: EVM.token, amount: usdtUnits() });
  }

  /* ----------------------------------------------------------- one gate --- */
  function validate() {
    if (S.phase === 'settled') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'You received ' + usdtTxt() + ' USDT.'
        : 'You received ' + fmt(S.sats) + ' sats.'));
    }
    if (S.phase === 'paying') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'Tap I paid once the sats have left your wallet.'
        : 'Tap I paid once the USDT has been sent.'));
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
      return Promise.resolve(good('Both sides are ready. Tap Approve to lock them and swap at once.',
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
    var sendBtc = S.direction === 'btc2u', done = S.phase === 'settled', paying = S.phase === 'paying';

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

    // the invoice row: pay it when it is the other side's, hand it over when it is yours
    // Wallet hands the invoice to another app (pay it, or copy it out); practice
    // keeps everything on this screen, with Sample in place of a wallet.
    $('invRow').hidden = S.mode !== 'wallet';
    $('walletLink').hidden = !sendBtc;
    $('copyInv').hidden = sendBtc;
    var inv = readInvoice(pasted());
    $('walletLink').setAttribute('href', inv.ok ? 'lightning:' + String(pasted()).replace(/^lightning:/i, '') : '#');
    $('walletLink').dataset.empty = inv.ok ? '0' : '1';

    $('sampleInv').hidden = S.mode === 'wallet';
    $('sampleAddr').hidden = S.mode === 'wallet';

    $('headRow').hidden = !(done || paying);
    // the finished swap says it once, in the title and on the receipt
    $('stateTxt').hidden = done;
    $('presets').hidden = done || paying;
    $('terms').hidden = done || paying;
    $('codeRow').hidden = done || paying || $('codeRow').hidden;
    $('steps').hidden = done || paying;
    $('payBox').hidden = !paying;
    $('receipt').hidden = !done;
    $('stepTitle').textContent = done ? 'Swap complete'
      : (paying ? 'Waiting for payment' : (sendBtc ? 'Swap bitcoin for USDT' : 'Swap USDT for bitcoin'));
    $('stepTitle').className = 'q' + (done ? ' done' : '');
    $('primary').textContent = done ? 'Done' : (paying ? 'I paid' : 'Approve');
    if (paying) paintPay();

    $('stateTxt').textContent = done ? 'Completed'
      : (paying ? 'Nothing sent yet'
        : (S.gate && S.gate.ok ? 'Ready to approve'
          : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready')));
    $('stateTxt').dataset.on = done || (!paying && S.gate && S.gate.ok) ? '1' : '0';

    if (done) {
      $('rcSend').textContent = sendBtc ? fmt(S.sats) + ' sats' : usdtTxt() + ' USDT';
      $('rcGet').textContent = sendBtc ? usdtTxt() + ' USDT' : fmt(S.sats) + ' sats';
      $('rcAddr').textContent = S.addr || '\u2014';
    }

    renderLog();
  }

  /* The waiting screen: what to send and where, and nothing that claims the
     swap is over before the money has actually left the wallet. */
  function paintPay() {
    var sendBtc = S.direction === 'btc2u';
    $('payLine').textContent = sendBtc
      ? 'Send ' + fmt(S.sats) + ' sats to this invoice from your wallet, then tap I paid.'
      : 'Send ' + usdtTxt() + ' USDT to this address from your wallet, then tap I paid.';
    $('payAddr').hidden = sendBtc;
    $('payAddr').textContent = sendBtc ? '' : (S.addr || '\u2014');
    $('payRowInv').hidden = !sendBtc;
    $('payRowAddr').hidden = sendBtc;
    $('payWalletLink').setAttribute('href', sendBtc && S.inv ? 'lightning:' + S.inv : '#');
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
  var gateTimer;
  function refreshGate() {
    clearTimeout(gateTimer);
    gateTimer = setTimeout(function () { validate().then(paintGate); }, 60);
  }

  function paintGate(r) {
    S.gate = r;
    var say = $('say');
    say.textContent = r.msg;
    say.className = 'say' + (r.ok || r.code === 'empty' ? '' : ' err');
    $('primary').dataset.ready = r.ok || S.phase === 'paying' ? '1' : '0';
    var f = r.fields || {};
    markField(invIn(), f.invoice, r.ok);
    markField(addrEl(), f.address, r.ok);
    $('stateTxt').textContent = S.phase === 'settled' ? 'Completed'
      : (S.phase === 'paying' ? 'Nothing sent yet'
        : (r.ok ? 'Ready to approve' : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready')));
    $('stateTxt').dataset.on = S.phase === 'settled' || (S.phase !== 'paying' && r.ok) ? '1' : '0';
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
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' \u00b7 T1 block ' + fmt(S.t1));
  }

  function approve() {
    if (S.phase === 'settled') { reset(); return; }
    if (S.phase === 'paying') { paid(); return; }
    validate().then(function (r) {
      if (!r.ok) {
        paintGate(r);
        shake();
        log('BLOCK', r.msg, 'c-err');
        renderLog();
        toast(r.msg);
        return;
      }
      if (S.t2 && S.t2 - nowSec() <= 60) {
        toast('Those terms have run out. Ask for a new code.');
        return;
      }
      if (!S.t2) { S.t2 = nowSec() + T2_SPAN; S.t1 = curHeight() + T1_BLOCKS; }
      S.units = usdtUnits();
      S.inv = String(pasted()).replace(/^lightning:/i, '');
      S.invDec = r.dec;
      S.addr = r.address;
      S.H = r.H;
      S.basis = r.basis || 'invoice';
      logSwap(r);
      if (S.basis === 'offer') log('OFFER', 'the wallet pays the offer; H is the hash of that offer');
      /* Wallet mode stops here: nothing has been paid yet, so nothing is done.
         Practice has no money to move and settles on the same tap. */
      if (S.mode === 'wallet') {
        S.phase = 'paying';
        log('PAY', S.direction === 'btc2u'
          ? 'waiting for the sats to leave the wallet'
          : 'waiting for the USDT transfer to be sent');
        render();
        refreshGate();
        toast('Pay from your wallet, then tap I paid');
        return;
      }
      settleNow();
    });
  }

  /* The payer confirms the payment left the wallet: only now does the swap close
     and produce a receipt. */
  function paid() {
    if (S.phase !== 'paying') return;
    if (S.t2 && S.t2 - nowSec() <= 0) {
      toast('Those terms have run out. Ask for a new code.');
      return;
    }
    log('PAID', S.direction === 'btc2u' ? 'the sats have been sent' : 'the USDT has been sent');
    settleNow();
  }

  function settleNow() {
    computeSwapId(S.H, EVM.usdtSide, S.addr, EVM.token, S.units, S.t2).then(function (id) {
      S.id = id;
      log('LOCK', 'bitcoin HTLC and USDT escrow locked on the same H');
      log('SETTLE', 'swap id ' + short(id, 6) + ' \u00b7 both legs closed at once');
      S.phase = 'settled';
      if (S.mode === 'wallet') {
        historyEntry('Swap', S.direction === 'btc2u' ? '+' + usdtTxt() + ' USDT' : '+' + fmt(S.sats) + ' sats', 'plus');
      }
      render();
      refreshGate();
      toast('Swap complete');
    });
  }

  function reset() {
    S.phase = 'idle';
    S.H = null; S.id = null; S.units = null;
    S.t1 = null; S.t2 = null;
    S.inv = ''; S.invDec = null; S.addr = ''; S.expectH = null; S.basis = null;
    S.qrInv = '';
    var a = invIn(); if (a) { a.value = ''; a.dataset.state = ''; }
    var b = addrEl(); if (b) { b.value = ''; b.dataset.state = ''; }
    var c = $('codeIn'); if (c) c.value = '';
    var box = $('qrBox'); if (box) box.innerHTML = '';
    var row = $('codeRow'); if (row) row.hidden = true;
    log('RESET', 'state cleared');
    render();
    refreshGate();
  }

  /* Back from the finished swap or the waiting screen keeps the terms on
     screen. */
  function backToForm() {
    if (S.phase === 'idle') return;
    S.phase = 'idle';
    S.qrInv = '';
    var box = $('qrBox'); if (box) box.innerHTML = '';
    render();
    refreshGate();
  }

  function applyCode(text) {
    var c = parseSwapLink(text);
    if (!c) { toast('That is not a swap code'); return false; }
    if (c.t2 <= nowSec()) { toast('Those terms have run out. Ask for a new code.'); return false; }
    if (S.phase === 'settled') { toast('Tap Done first, then use the code.'); return false; }
    S.direction = opposite(c.direction);
    S.sats = c.sats;
    S.units = c.units;
    S.t2 = c.t2;
    S.t1 = c.t1;
    S.expectH = c.H || null;
    if (c.address) addrEl().value = c.address;
    $('codeRow').hidden = true;
    presetsOn();
    log('CODE', 'terms from the other side \u00b7 ' + fmt(S.sats) + ' sats \u00b7 ' + usdtTxt() + ' USDT');
    render();
    refreshGate();
    toast('Terms loaded');
    return true;
  }

  function sampleInvoice() {
    if (S.mode === 'wallet') return;
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      invIn().value = mintInvoice({ paymentHash: '0x' + H, sats: S.sats, expiry: T2_SPAN });
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
  function showQr(payload, caption, reveal) {
    var box = $('qrBox');
    if (!payload) { box.innerHTML = ''; toast('Nothing to show yet'); return; }
    var bytes = utf8(payload).length;
    var svg = null;
    if (bytes <= QR_MAX) {
      ['M', 'L'].forEach(function (level) {
        if (svg) return;
        try { svg = window.QR.svg(payload, { level: level, quiet: 2 }); } catch (e) { svg = null; }
      });
    }
    if (!svg) {
      box.innerHTML = '<p class="hint">Too long for a QR: use Copy instead.</p>';
      return;
    }
    box.innerHTML = svg + (caption ? '<p class="hint">' + caption + '</p>' : '');
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
  var ACT = {
    mode: function (b) {
      S.mode = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      if (S.phase !== 'idle') backToForm();
      render();
      refreshGate();
    },
    direction: function () {
      if (S.phase === 'settled') return;
      S.direction = opposite(S.direction);
      render();
      refreshGate();
    },
    sats: function (b) {
      if (S.phase === 'settled') return;
      S.sats = Number(b.dataset.v);
      S.units = null;
      presetsOn();
      render();
      refreshGate();
    },
    primary: function () { approve(); },
    back: function () { backToForm(); },
    copyCode: function () {
      copy(swapCode(), 'Code copied');
    },
    qrCode: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      var code = swapCode();
      S.qrInv = code;
      showQr(code, 'Your partner scans this for the same terms', true);
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
      .then(function () { clearTimeout(timer); render(); refreshGate(); });
  }

  /* ---------------------------------------------------------------- boot -- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var fn = ACT[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b); }
  });

  // A blank wallet link would open a wallet on nothing: say what is missing instead.
  $('walletLink').addEventListener('click', function (e) {
    if (!readInvoice(pasted()).ok) { e.preventDefault(); needInvoice(); }
  });

  [invIn(), addrEl(), $('codeIn')].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function () { render(); refreshGate(); });
  });

  render();
  refreshGate();
  presetsOn();
  loadRate();

  // A code can arrive in the address bar of a hosted copy, or from the app
  // shell when another app hands it over. Nothing here is ever generated.
  var fromUrl = parseSwapCode(String(location.search) + ' ' + String(location.hash));
  if (fromUrl) applyCode(String(location.search) + ' ' + String(location.hash));

  window.CLEANSWAP = {
    state: S, SEL: SEL, EVM: EVM, QR_MAX: QR_MAX, NET: NET, T2_SPAN: T2_SPAN,
    sha256Hex: sha256Hex, sha256Bytes: sha256Bytes, computeSwapId: computeSwapId, bech32Decode: bech32Decode,
    base58Bytes: base58Bytes, tronAddressBytes: tronAddressBytes, chainOf: chainOf,
    decodeBolt11: decodeBolt11, decodeBolt12: decodeSwapOffer, decodeSwapOffer: decodeSwapOffer,
    mintInvoice: mintInvoice, mintOffer: mintOffer,
    lockCalldata: lockCalldata, decodeLockCalldata: decodeLockCalldata, readLockProof: readLockProof,
    readEscrow: readEscrow, readInvoice: readInvoice, readAddress: readAddress,
    parseLightning: parseLightning, nextCalldata: nextCalldata, escrowProof: escrowProof,
    escrowUnits: escrowUnits, usdtUnits: usdtUnits, usdtTxt: usdtTxt,
    swapCode: swapCode, parseSwapCode: parseSwapCode, parseSwapLink: parseSwapLink,
    applyCode: applyCode, acceptCode: function (t) { return applyCode(t); },
    render: render, refreshGate: refreshGate, validate: validate, paintGate: paintGate,
    approve: approve, paid: paid, reset: reset, backToForm: backToForm, presetsOn: presetsOn,
    sampleInvoice: sampleInvoice, sampleAddress: sampleAddress, revealQr: revealQr,
    historyEntry: historyEntry, pasted: pasted, addrIn: addrIn
  };
})();
