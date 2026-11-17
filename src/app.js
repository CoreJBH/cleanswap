/* CLEANSWAP v0.4 — Lightning bitcoin <-> USDT atomic swap in one file.

   The screen stays out of the way: two amount cards, one plain sentence and
   one big button per step, the way a payment app reads. No symbol names, no
   hashes and no raw hex are ever shown; practice mode needs no pasting at all.
   Underneath, every step is still gated on data a real swap would need, and
   the gate runs here, in the browser:

     step 1  a BOLT12 offer or invoice (or a BOLT11 hold invoice) whose
             payment_hash is exactly H, for the right amount, still unexpired
     step 2  the counterparty's escrow lock, decoded and matched against H, T2
             and the USDT amount (lock() calldata, JSON record, Liquid lock URI
             or a lock transaction hash)
     step 3  the 32-byte preimage R, accepted only when SHA256(R) === H

   BOLT12 is the default format. A BOLT12 offer cannot carry a payment_hash by
   itself, so every offer the app mints embeds the swap's hashlock in a custom
   type-80 TLV; invoices the app mints use the standard invoice_payment_hash
   field. BOLT11 hold invoices stay fully accepted as input.

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
  var T2_SPAN = 3600;               /* USDT escrow window, seconds */
  var T1_BLOCKS = 40;               /* ~6h40m of bitcoin blocks */
  var BLOCK_SECS = 600;

  var S = {
    mode: 'practice',               /* practice | wallet */
    direction: 'btc2u',             /* home-screen direction: send BTC or send USDT */
    role: 'maker',                  /* maker (bitcoin side) | taker (USDT side) */
    phase: 'idle',                  /* idle | open | btc | both | settled | expired | refunded */
    sats: 50000,
    price: null, pstate: 'loading',
    units: null,                    /* frozen USDT amount, micro-units */
    H: null, R: null, id: null,
    t1: null, t2: null,
    sim: 0, h0: 923452,
    counterInv: '', altInv: '', inv: '', invDec: null,
    btcState: 'none', usdtState: 'none',
    log: [],
    sealOpen: false,
    usdtProof: '',
    qrInv: '',                      /* the invoice whose QR is on screen */
    left: null,                     /* why a swap was left: partner | time */
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
    buf.set(fromHex(sender), 32);
    buf.set(fromHex(receiver), 52);
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
    var hash = fields[SWAP_HASH_TYPE];
    return {
      kind: 'bolt12',
      form: /^lni1/i.test(o) ? 'invoice' : 'offer',
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
  function escrowProof() {
    return lockCalldata({
      hashlock: S.H, timelock: S.t2, receiver: EVM.btcSide,
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
  function nextCalldata() {
    if (!S.H || !S.id) return '';
    if (S.phase === 'open') {
      return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: EVM.btcSide, token: EVM.token, amount: usdtUnits() });
    }
    if (S.phase === 'settled' && S.R) {
      return '0x' + SEL.claim + encU256(S.id) + encU256(S.R);
    }
    if (S.phase === 'expired') return '0x' + SEL.refund + encU256(S.id);
    return '';
  }

  /* ------------------------------------------------------- swap link ----- */
  function swapLink() {
    if (!S.H || !S.t2) return '';
    var base = String(location.href).split('#')[0];
    return base + '#s=1.' + normHex(S.H) + '.' + S.sats + '.' + usdtUnits() + '.' + S.t2 + '.' + (S.t1 || 0);
  }
  function parseSwapLink(hash) {
    var m = /(?:^|[#&])s=([0-9A-Za-z._-]+)/.exec(String(hash || ''));
    if (!m) return null;
    var p = m[1].split('.');
    if (p.length < 5 || p[0] !== '1') return null;
    if (!/^[0-9a-f]{64}$/i.test(p[1])) return null;
    var sats = Number(p[2]), units = Number(p[3]), t2 = Number(p[4]), t1 = Number(p[5] || 0);
    if (!(sats > 0) || !(units > 0) || !(t2 > 0)) return null;
    return { H: '0x' + p[1].toLowerCase(), sats: sats, units: units, t2: t2, t1: t1 };
  }
  /* ------------------------------------------------------------ gates --- */
  /* The screen shows one plain sentence. Underneath, every step is still
     gated on data a real swap needs: the other side's invoice (a BOLT12
     offer or invoice, or a BOLT11 hold invoice) carrying this swap's hashlock
     and amount, the USDT escrow decoded from lock() calldata, a lock record,
     a Liquid lock URI or a lock tx hash, and the 32-byte preimage whose
     SHA-256 is the hashlock. Practice mode builds those same objects on this
     device, so the checks are identical - nobody has to paste anything. */

  function bad(code, msg) { return { ok: false, code: code, msg: msg }; }
  function good(msg, extra) {
    var r = { ok: true, code: 'ok', msg: msg };
    if (extra) { for (var k in extra) r[k] = extra[k]; }
    return r;
  }

  /* one reader for anything the other side sends: BOLT12 offer or invoice
     first (the default format), BOLT11 hold invoice second */
  function parseLightning(raw) {
    var t = String(raw || '').trim().replace(/^lightning:/i, '');
    if (!t) return null;
    if (/^ln[io]1/i.test(t)) return decodeSwapOffer(t);
    return decodeBolt11(t);
  }

  function pasted() {
    var el = $('pasteIn');
    return String(el ? el.value : '').trim();
  }

  /* the invoice the other side sends, checked against this swap.

     A real wallet puts its own payment hash in the invoice it hands over. In
     Wallet mode that hash is the swap: the invoice decides it, this side adopts
     it, and whoever holds the secret (the partner) reveals it at the end. Only
     Practice mode keeps the stricter rule that the invoice must already carry
     the hash this screen made. */
  function adoptHash(h) {
    var next = '0x' + normHex(h);
    if (!next || normHex(next) === normHex(S.H)) return false;
    S.H = next;
    S.R = null;                 /* the partner holds the secret from here on */
    S.counterInv = '';
    log('HASH', 'hashlock adopted from the invoice · H ' + short(S.H, 8));
    refreshId();
    return true;
  }
  function refreshId() {
    if (!S.H || !S.t2) return;
    computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2).then(function (id) {
      S.id = id;
      render();
    });
  }

  function readOffer(raw) {
    var t = String(raw || '').trim();
    if (!t) return bad('empty', 'Paste the invoice your partner sent.');
    var d;
    try { d = parseLightning(t); } catch (e) { return bad('format', 'That code cannot be read. Paste the whole thing.'); }
    if (!d) return bad('format', 'That code cannot be read. Paste the whole thing.');
    var what = d.kind === 'bolt12' ? (d.form === 'invoice' ? 'BOLT12 invoice' : 'BOLT12 offer') : 'BOLT11 invoice';
    var wallet = S.mode === 'wallet';

    /* An offer is only a request to pay: it carries no payment hash, so there
       is nothing to bind the two legs to. The invoice that comes back from it
       does, and that is what this step needs. */
    if (!d.paymentHash) {
      if (d.kind === 'bolt12' && d.form === 'offer') {
        log('BLOCK', 'an offer carries no payment hash to lock on', 'c-err');
        return bad('offer', 'That is an offer, not an invoice. Ask your partner for the invoice that pays this swap.');
      }
      return bad('format', 'That code is not an invoice for this swap.');
    }

    /* nothing is adopted or logged until the invoice passes every check */
    var same = normHex(d.paymentHash) === normHex(S.H);
    if (!same && !wallet) return bad('mismatch', 'That invoice is for a different swap.');
    if (d.sats != null && Number(d.sats) !== Number(S.sats)) {
      return bad('amount', 'That invoice is for ' + fmt(d.sats) + ' sats, not ' + fmt(S.sats) + '. Ask for one for this amount.');
    }
    var exp = d.absoluteExpiry != null ? d.absoluteExpiry : (d.expiresAt != null ? d.expiresAt : null);
    if (exp != null && nowSec() > exp) return bad('expired', 'That invoice has expired. Ask for a new one.');
    if (d.kind === 'bolt11' && d.network !== NET && !wallet) return bad('network', 'That invoice is for another bitcoin network.');

    var note = '';
    if (!same) {
      adoptHash(d.paymentHash);
      note = 'Invoice accepted. ';
    }
    log('VERIFY', what + (same ? ' · payment_hash == H' : ' · payment_hash adopted as H') + ' · ' + fmt(S.sats) + ' sats');
    return good(note + 'Now pay it from your wallet, then tap I paid.', { dec: d, raw: t, note: !!note });
  }

  function partnerOffer() {
    return readOffer(S.mode === 'wallet' ? pasted() : (S.counterInv || ''));
  }

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

  /* the USDT escrow, decoded and matched against H, T2 and the amount */
  function readEscrow(raw) {
    var p = readLockProof(raw);
    if (p.kind === 'empty') return bad('empty', 'Paste the lock code your partner sent.');
    if (p.kind === 'error') return bad('format', 'That lock code cannot be read.');
    if (p.kind === 'tx') {
      if (/^0x0{64}$/.test(p.hash)) return bad('format', 'That lock code cannot be read.');
      log('REF', 'lock transaction ' + short(p.hash, 6) + ' recorded; a hash alone cannot be matched offline');
      return { ok: true, code: 'ref', msg: 'Lock recorded. Tap to finish this side.', dec: p };
    }
    if (p.kind === 'calldata' && p.selector !== SEL.lock) return bad('format', 'That lock code cannot be read.');
    var locked = String(p.hashlock || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(locked)) return bad('format', 'That lock code cannot be read.');
    if (normHex(locked) !== normHex(S.H)) return bad('mismatch', 'That lock is for a different swap.');
    var tl = String(p.timelock == null ? '' : p.timelock).trim();
    if (!tl) return bad('timelock', 'That lock has no end time.');
    if (tl !== String(S.t2)) return bad('timelock', 'That lock ends at the wrong time.');
    var units = p.kind === 'liquid'
      ? (p.amount === '' ? null : Math.round(Number(p.amount) * 1e6))
      : (p.amount === '' ? null : Number(p.amount));
    if (units == null || !isFinite(units) || Math.round(units) <= 0) {
      return bad('amount', 'That lock has no amount.');
    }
    var held = Math.round(units), want = Number(usdtUnits());
    var same = p.kind === 'liquid' ? Math.round(held / 1e4) === Math.round(want / 1e4) : held === want;
    if (!same) return bad('amount', 'That lock holds ' + (held / 1e6).toFixed(2) + ' USDT, not ' + usdtTxt() + '.');
    if (p.receiver && isAddr(p.receiver) && /^0x0{40}$/.test(p.receiver)) {
      return bad('format', 'That lock pays nobody.');
    }
    log('VERIFY', 'USDT lock decoded · hashlock H · timelock T2 · ' + usdtTxt() + ' USDT');
    return good('The USDT side is locked. Tap to finish this side.', { dec: p });
  }

  function partnerEscrow() {
    if (S.mode === 'wallet') return readEscrow(pasted());
    // practice: the partner's lock is made once, when it is the partner's turn,
    // and then checked like any other lock - it is not regenerated to match.
    return readEscrow(S.usdtProof || escrowProof());
  }

  /* the 32-byte preimage. In practice the device holds it; on the USDT side
     of a real swap it arrives from the bitcoin side. */
  function checkSecret() {
    var own = !!S.R;
    var v = normHex(own ? S.R : pasted());
    if (!v) return Promise.resolve(bad('empty', own ? 'The secret for this swap is missing.' : 'Paste the code your partner sent.'));
    if (!/^[0-9a-f]{64}$/.test(v)) return Promise.resolve(bad('format', 'That code is too short.'));
    return sha256Hex(v).then(function (h) {
      var got = '0x' + h;
      if (normHex(got) !== normHex(S.H)) return bad('mismatch', 'That code does not unlock this swap.');
      log('CHECK', 'SHA256(preimage) == H');
      return good('Unlocked. Tap to complete the swap.', { preimage: '0x' + v });
    }).catch(function () { return bad('format', 'That code cannot be read.'); });
  }

  /* ---------------------------------------------------------- one gate --- */
  /* The checks produce codes; the stage decides the one sentence the screen
     shows when a check passes, so a step reads like a payment app. */
  function sayOk(r, msg) { if (r && r.ok) r.msg = msg; return r; }

  function validate() {
    if (S.phase === 'idle') {
      if (S.mode === 'wallet' && S.role === 'taker') {
        var raw = pasted();
        if (!raw) return Promise.resolve(bad('empty', 'Paste the link your partner sent, then tap Start swap.'));
        var link = parseSwapLink(raw);
        if (link) return Promise.resolve(good('The invite is for ' + fmt(link.sats) + ' sats. Tap Start swap.'));
        var d;
        try { d = parseLightning(raw); } catch (e) { return Promise.resolve(bad('format', 'That invite cannot be read.')); }
        if (!d) return Promise.resolve(bad('format', 'That invite cannot start a swap.'));
        if (!d.paymentHash) return Promise.resolve(bad('format', 'That invite has no payment hash. Ask for the invoice for this swap.'));
        return Promise.resolve(good('Your USDT is ready to lock. Tap Start swap.'));
      }
      return Promise.resolve(good(S.role === 'maker'
        ? 'Pick an amount, then tap Start swap.'
        : 'Pick how much bitcoin you want, then tap Start swap.'));
    }
    if (S.phase === 'settled') {
      return Promise.resolve(good(S.role === 'maker'
        ? 'You received ' + usdtTxt() + ' USDT.'
        : 'You received ' + fmt(S.sats) + ' sats.'));
    }
    if (S.phase === 'refunded') {
      return Promise.resolve(good(S.left === 'partner'
        ? 'Your partner walked away, so nothing was exchanged. Everything you locked came back.'
        : 'Time ran out. Everything you locked came back.'));
    }
    if (S.phase === 'expired') return Promise.resolve(good('Time is up. Tap to take your funds back.'));

    if (S.phase === 'open') {
      if (S.mode === 'wallet' && S.role === 'maker') {
        if (!pasted()) return Promise.resolve(bad('empty', 'Share the link first, then paste the invoice your partner sends back.'));
        var offer = partnerOffer();
        if (offer.ok && offer.note) return Promise.resolve(offer);
        return Promise.resolve(sayOk(offer, 'Pay this invoice from your wallet, then tap I paid.'));
      }
      if (S.mode === 'wallet') return Promise.resolve(good('Tap to lock your USDT.'));
      if (S.role === 'maker') return Promise.resolve(sayOk(partnerOffer(), 'Tap to lock your bitcoin. It is held safely until the swap finishes.'));
      return Promise.resolve(sayOk(partnerEscrow(), 'Tap to lock your USDT. It is released only when you get the bitcoin.'));
    }
    if (S.phase === 'btc') {
      if (S.usdtState !== 'locked') {
        var e = partnerEscrow();
        if (!e.ok) return Promise.resolve(e);
        return Promise.resolve(good(S.mode === 'wallet'
          ? 'The USDT side is locked. Tap to finish your side.'
          : 'Now the USDT side locks. Tap to let your partner lock it.'));
      }
      if (S.mode === 'wallet') return Promise.resolve(good('Your partner pays the invoice you shared. Tap when it shows up.'));
      return Promise.resolve(sayOk(partnerOffer(), 'Your partner paid the invoice. Tap to continue.'));
    }
    if (S.phase === 'both') {
      return checkSecret().then(function (r) {
        return sayOk(r, 'Both sides are locked. Tap to complete the swap.');
      });
    }
    return Promise.resolve(bad('state', 'Nothing to do here.'));
  }

  /* ------------------------------------------------------------ render --- */
  function locked() {
    return {
      btc: S.btcState === 'held' || S.btcState === 'settled',
      usdt: S.usdtState === 'locked' || S.usdtState === 'claimed'
    };
  }
  function phaseNow() {
    var l = locked();
    if (l.btc && l.usdt) return 'both';
    if (l.btc || l.usdt) return 'btc';
    return 'open';
  }
  function stepNo() {
    if (S.phase === 'idle') return 0;
    if (S.phase === 'open') return 1;
    if (S.phase === 'btc') return 2;
    if (S.phase === 'both') return 3;
    return 4;
  }
  function stage() {
    if (S.phase === 'idle' || S.phase === 'open' || S.phase === 'btc' || S.phase === 'both') return S.phase;
    return 'closed';
  }

  function showTag(el, txt, on, done) {
    el.hidden = !on;
    txt.textContent = done ? 'Done' : 'Locked';
  }

  function presetsOn() {
    var btns = document.querySelectorAll('#presets [data-act="sats"]'), i, on;
    for (i = 0; i < btns.length; i++) {
      on = Number(btns[i].dataset.v) === Number(S.sats);
      btns[i].className = on ? 'on' : '';
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function currentInvoice() {
    if (S.mode === 'wallet' && S.role === 'maker' && S.phase === 'open') {
      return pasted().replace(/^lightning:/i, '');
    }
    return S.inv || '';
  }
  function invitePayload() {
    if (S.mode === 'wallet' && S.role === 'taker' && S.inv) return 'lightning:' + S.inv;
    return swapLink();
  }

  function render() {
    var l = locked(), sendingBtc = S.role === 'maker', done = S.phase === 'settled';

    document.body.dataset.phase = S.phase;
    document.body.dataset.mode = S.mode;
    document.body.dataset.role = S.role;
    document.body.dataset.dir = S.direction;

    $('modePractice').className = S.mode === 'practice' ? 'on' : '';
    $('modeWallet').className = S.mode === 'wallet' ? 'on' : '';
    $('rateDot').className = 'dot ' + (S.pstate === 'live' ? 'live' : S.pstate === 'offline' ? 'off' : '');
    $('rateTxt').textContent = S.price ? '1 BTC \u2248 ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC \u2248 \u2014 USDT';

    if (sendingBtc) {
      $('sendAmt').textContent = fmt(S.sats); $('sendUnit').textContent = 'sats';
      $('sendSub').textContent = '\u2248 ' + (usdtOf() ? usdtTxt() + ' USDT' : '\u2014 USDT');
      $('getAmt').textContent = usdtOf() ? usdtTxt() : '\u2014'; $('getUnit').textContent = 'USDT';
      $('getSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
    } else {
      $('sendAmt').textContent = usdtOf() ? usdtTxt() : '\u2014'; $('sendUnit').textContent = 'USDT';
      $('sendSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
      $('getAmt').textContent = fmt(S.sats); $('getUnit').textContent = 'sats';
      $('getSub').textContent = '\u2248 ' + (usdtOf() ? usdtTxt() + ' USDT' : '\u2014 USDT');
    }

    showTag($('sendTag'), $('sendTagTxt'), sendingBtc ? l.btc : l.usdt, done);
    showTag($('getTag'), $('getTagTxt'), sendingBtc ? l.usdt : l.btc, done);

    var st = 'Ready', on = false;
    if (S.phase === 'settled') { st = 'Completed'; on = true; }
    else if (S.phase === 'refunded') { st = 'Refunded'; }
    else if (S.phase === 'expired') { st = 'Expired'; }
    else if (l.btc && l.usdt) { st = 'Both locked'; on = true; }
    else if (l.btc) { st = 'Bitcoin locked'; on = true; }
    else if (l.usdt) { st = 'USDT locked'; on = true; }
    $('stateTxt').textContent = st;
    $('stateTxt').dataset.on = on ? '1' : '0';

    $('counterInv').textContent = S.counterInv || '\u2014';
    renderStep();
    renderLog();
  }

  function renderStep() {
    var taker = S.role === 'taker', w = S.mode === 'wallet', l = locked(), p = S.phase;
    var title = 'Swap bitcoin for USDT', cta = 'Start swap', tone = '';
    var flow = false, share = false, shareLbl = 'Copy link', paste = false, pasteLbl = '';
    var pay = false, ghost = false, track = false, sim = false, back = false;

    if (p === 'idle') {
      title = taker ? 'Swap USDT for bitcoin' : 'Swap bitcoin for USDT';
      paste = w && taker; pasteLbl = 'Link from your partner';
    } else if (p === 'open') {
      back = true;
      if (taker) { title = 'Lock your USDT'; cta = 'Lock my USDT'; }
      else { title = 'Lock your bitcoin'; cta = w ? 'I paid' : 'Lock my BTC'; }
      flow = w && !taker;
      share = flow; paste = flow; pay = flow;
      pasteLbl = 'Paste the invoice your partner sends';
      track = !flow;
    } else if (p === 'btc') {
      back = true;
      if (l.usdt) {
        title = taker ? 'Your partner pays you' : 'Your partner locks USDT';
        cta = w && taker ? 'Partner paid' : 'Partner locks';
        share = w && taker; shareLbl = 'Copy invoice';
      } else {
        title = 'Your partner locks USDT';
        cta = 'Partner locks';
        paste = w; pasteLbl = 'Lock code from your partner';
      }
      track = true;
    } else if (p === 'both') {
      back = true;
      title = 'Complete the swap'; cta = 'Complete swap';
      paste = !S.R; pasteLbl = 'Code from your partner';
      track = true; sim = S.mode === 'practice';
    } else if (p === 'settled') {
      title = 'Swap complete'; cta = 'Done'; tone = 'done'; ghost = true; track = true;
    } else if (p === 'expired') {
      title = 'Time is up'; cta = 'Refund'; ghost = true;
    } else {
      title = 'Swap refunded'; cta = 'Done'; ghost = true;
    }
    if (S.mode === 'practice' && p === 'btc') sim = true;

    $('stepTitle').textContent = title;
    $('stepTitle').className = 'q' + (tone ? ' ' + tone : '');
    $('primary').textContent = cta;

    $('stepHead').hidden = !back;
    $('presets').hidden = p !== 'idle';
    presetsOn();

    $('flow').hidden = !(share || paste || pay);
    $('stepShare').hidden = !share;
    $('stepPaste').hidden = !paste;
    $('stepPay').hidden = !pay;
    $('inviteRow').hidden = !share;
    $('pasteRow').hidden = !paste;
    $('walletRow').hidden = !pay;
    // the numbers belong to the wallet path; a lone field keeps its own label
    $('shareHead').hidden = !flow;
    $('pasteHead').hidden = !flow;
    $('payHead').hidden = !flow;
    $('fieldLbl').hidden = flow;
    $('fieldLbl').textContent = pasteLbl;
    $('copyInviteBtn').textContent = shareLbl;

    $('track').hidden = !track;
    $('simRow').hidden = !sim;
    $('ghost').hidden = !ghost;
    // the direction stays visible between the cards, inert once a swap is open
    $('swapDir').hidden = false;
    $('swapDir').dataset.lock = S.phase === 'idle' ? '0' : '1';
    $('swapDir').setAttribute('aria-disabled', S.phase === 'idle' ? 'false' : 'true');

    var inv = currentInvoice();
    $('walletLink').setAttribute('href', inv ? 'lightning:' + inv : '#');
    $('walletLink').dataset.empty = inv ? '0' : '1';

    paintTrack();
    paintFlow();
  }

  /* three plain stages, so the screen shows where the swap is and why it is safe */
  function setMark(el, n, state) {
    el.dataset.s = state;
    var m = el.querySelector('.tr-mark');
    if (m) m.textContent = state === 'done' ? '\u2713' : String(n);
  }
  function paintTrack() {
    if (!($('track') && !$('track').hidden)) return;
    var l = locked(), done = S.phase === 'settled';
    var mine = S.role === 'maker' ? fmt(S.sats) + ' sats' : usdtTxt() + ' USDT';
    var theirs = S.role === 'maker' ? usdtTxt() + ' USDT' : fmt(S.sats) + ' sats';
    var mineIn = S.role === 'maker' ? l.btc : l.usdt;
    var theirsIn = S.role === 'maker' ? l.usdt : l.btc;
    var both = l.btc && l.usdt;

    setMark($('tr1'), 1, mineIn ? 'done' : 'now');
    setMark($('tr2'), 2, theirsIn ? 'done' : (mineIn ? 'now' : 'next'));
    setMark($('tr3'), 3, done ? 'done' : (both ? 'now' : 'next'));

    $('tr1s').textContent = mineIn ? mine + ' is locked.' : 'Your ' + mine + ' goes in first.';
    $('tr2s').textContent = theirsIn ? theirs + ' is locked.'
      : (mineIn ? 'Waiting for ' + theirs + '.' : 'They lock ' + theirs + ' to match.');
    $('tr3s').textContent = done ? 'Both sides swapped at once.'
      : (both ? 'Both sides are in. One tap swaps them together.' : 'Both sides locked, then swapped together.');
    $('trackNote').textContent = done ? 'Both sides swapped at once. No side could take off with the other.'
      : (both ? 'Both sides are locked. One tap finishes the swap.' : 'Nothing moves until both sides are locked.');
  }

  /* the wallet path marks the step in hand, and the two behind it */
  function setStep(el, n, state) {
    el.dataset.s = state;
    var m = el.querySelector('.step-h .n');
    if (m) m.textContent = state === 'done' ? '\u2713' : String(n);
  }
  function paintFlow() {
    if (!($('flow') && !$('flow').hidden)) return;
    var ok = !!(S.gate && S.gate.ok);
    setStep($('stepShare'), 1, ok ? 'done' : 'now');
    setStep($('stepPaste'), 2, ok ? 'done' : 'now');
    setStep($('stepPay'), 3, ok ? 'now' : 'next');
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
    var say = $('stepSay');
    say.textContent = r.msg;
    say.className = 'say' + (r.ok || r.code === 'empty' ? '' : ' err');
    $('primary').dataset.ready = r.ok ? '1' : '0';
    var el = $('pasteIn');
    if (el && !$('pasteRow').hidden) {
      el.dataset.state = r.ok ? 'ok' : (r.code === 'empty' ? '' : 'err');
    }
    paintFlow();
    showInvoiceQrOnce(r);
  }

  /* the moment the pasted invoice checks out, its QR is on screen and the
     wallet link carries it: QR and Open in wallet are never a dead tap */
  function showInvoiceQrOnce(r) {
    if (!(S.mode === 'wallet' && S.phase === 'open' && S.role === 'maker')) return;
    var inv = currentInvoice();
    var box = $('qrBox');
    if (!r || !r.ok || !inv) {
      if (box.innerHTML) box.innerHTML = '';
      S.qrInv = '';
      return;
    }
    if (inv === S.qrInv) return;
    S.qrInv = inv;
    showQr('lightning:' + inv, 'Scan from your wallet, or tap Open in wallet');
  }
  function needInvoice() {
    toast('Paste the invoice first, then this opens.');
    var row = $('pasteRow');
    if (row && !row.hidden) {
      row.classList.remove('shake');
      void row.offsetWidth;
      row.classList.add('shake');
    }
  }
  function shake() {
    var g = $('stepSay');
    g.classList.remove('shake');
    void g.offsetWidth;
    g.classList.add('shake');
  }

  /* ------------------------------------------------------------ actions -- */
  function startSwap() {
    if (S.mode === 'wallet' && S.role === 'taker') { createSwapUsdt(); return; }
    createSwap();
  }

  function createSwap() {
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      S.R = '0x' + R;
      S.H = '0x' + H;
      S.t2 = nowSec() + T2_SPAN;
      S.t1 = curHeight() + T1_BLOCKS;
      S.units = S.price ? Math.round(S.sats / 1e8 * S.price * 1e6) : null;
      S.btcState = 'none'; S.usdtState = 'none';
      S.inv = ''; S.invDec = null; S.usdtProof = '';
      S.counterInv = S.mode === 'practice' ? mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
      S.phase = 'open';
      log('CREATE', 'swap opened · ' + fmt(S.sats) + ' sats \u21c4 ' + usdtTxt() + ' USDT');
      log('HASH', 'R sealed · H = SHA256(R) = ' + short(S.H, 8));
      log('TIMELOCK', 'T1 block ' + fmt(S.t1) + ' · T2 unix ' + S.t2);
      if (S.counterInv) log('OFFER', 'BOLT12 offer minted · hashlock = H');
      return computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2);
    }).then(function (id) {
      S.id = id;
      var el = $('pasteIn'); if (el) { el.value = ''; el.dataset.state = ''; }
      var box = $('qrBox'); if (box) box.innerHTML = '';
      S.qrInv = '';
      render();
      refreshGate();
      toast('Swap started');
    }).catch(function (e) {
      log('FAIL', 'SHA-256: ' + e.message, 'c-err');
      render();
      toast('This device cannot make the secret');
    });
  }

  /* Send-USDT start: the hashlock comes from the invite, or is created here
     when the practice partner is simulated on the same screen. */
  function createSwapUsdt() {
    var done = function (H, R) {
      S.R = R || null;
      S.H = '0x' + normHex(H);
      S.t2 = nowSec() + T2_SPAN;
      S.t1 = curHeight() + T1_BLOCKS;
      S.units = S.price ? Math.round(S.sats / 1e8 * S.price * 1e6) : null;
      S.btcState = 'none'; S.usdtState = 'none';
      S.inv = ''; S.invDec = null; S.usdtProof = '';
      S.counterInv = S.mode === 'practice' ? mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
      S.phase = 'open';
      S.qrInv = '';
      log('CREATE', 'swap opened from the USDT side · ' + usdtTxt() + ' USDT \u21c4 ' + fmt(S.sats) + ' sats');
      log('HASH', 'H = SHA256(R) = ' + short(S.H, 8));
      log('TIMELOCK', 'T1 block ' + fmt(S.t1) + ' · T2 unix ' + S.t2);
      render();
      refreshGate();
      computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2).then(function (id) {
        S.id = id;
        render();
        refreshGate();
      });
    };
    if (S.mode === 'wallet') {
      var raw = pasted(), link = parseSwapLink(raw);
      if (link) {
        /* the invite is the swap: same hashlock, same amounts, same windows */
        done(link.H);
        S.sats = link.sats;
        S.units = link.units;
        S.t2 = link.t2;
        S.t1 = link.t1 || S.t1;
        render();
        refreshGate();
        return;
      }
      try {
        var d = parseLightning(raw);
        if (!d || !d.paymentHash) {
          log('BLOCK', 'that invite carries no payment hash to lock on', 'c-err');
          render(); refreshGate();
          toast('That invite has no payment hash. Ask for the invoice for this swap.');
          return;
        }
        if (d.sats) S.sats = d.sats;
        done(d.paymentHash);
      } catch (e) {
        log('BLOCK', e.message, 'c-err');
        render(); refreshGate();
      }
      return;
    }
    var R = rndHex(32);
    sha256Hex(R).then(function (H) { done(H, '0x' + R); });
  }

  function lockBtc(r) {
    S.btcState = 'held';
    if (S.mode === 'practice' && !S.usdtProof) {
      S.usdtProof = escrowProof();
      log('SIM', 'the USDT side locks against the same H while this screen plays both', 'c-sim');
    }
    S.invDec = (r && r.dec) || (S.inv ? decodeSwapOffer(S.inv) : null);
    if (S.mode === 'wallet' && r && r.raw) S.inv = r.raw;
    log('LOCK', 'BTC · ' + fmt(S.sats) + ' sats held in the HTLC until block ' + fmt(S.t1));
    S.phase = phaseNow();
    var el = $('pasteIn'); if (el) el.value = '';
    render();
    refreshGate();
    toast('Bitcoin locked');
  }

  function lockUsdtLeg(r) {
    if (S.role === 'taker' && !S.inv) {
      S.inv = mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN });
      var self = decodeSwapOffer(S.inv);
      if (!self || normHex(self.paymentHash) !== normHex(S.H)) {
        log('FAIL', 'minted offer does not carry H', 'c-err');
        render();
        toast('Could not make the invoice');
        return;
      }
      log('OFFER', 'BOLT12 invoice minted · hashlock = H');
    }
    S.usdtState = 'locked';
    S.usdtProof = S.mode === 'wallet' ? pasted() : escrowProof();
    log('LOCK', 'USDT · ' + usdtTxt() + ' USDT locked in escrow until T2 ' + S.t2);
    S.phase = phaseNow();
    var el = $('pasteIn'); if (el) el.value = '';
    render();
    refreshGate();
    toast('USDT locked');
  }

  function complete(r) {
    var pre = (r && r.preimage) || (S.mode === 'wallet' && S.role === 'taker' ? '0x' + normHex(pasted()) : S.R);
    S.btcState = 'settled';
    S.usdtState = 'claimed';
    S.phase = 'settled';
    log('REVEAL', 'R published ' + short(pre, 6) + ' · the HTLC settles with it');
    log('SETTLE', 'both legs closed');
    if (S.mode === 'wallet') {
      historyEntry('Swap', (S.role === 'maker' ? '+' + usdtTxt() + ' USDT' : '+' + fmt(S.sats) + ' sats'), 'plus');
    }
    render();
    refreshGate();
    toast('Swap complete');
  }

  function refund() {
    if (nowSec() < (S.t2 || 0)) { toast('Not time yet'); return; }
    var held = S.btcState === 'held' || S.usdtState === 'locked';
    if (S.btcState === 'held') S.btcState = 'refunded';
    if (S.usdtState === 'locked') S.usdtState = 'refunded';
    S.phase = 'refunded';
    S.left = 'time';
    log('REFUND', held ? 'both legs returned to their owners after T2' : 'nothing was locked; the swap expired unused');
    log('VOID', 'R was never revealed', 'c-warn');
    if (S.mode === 'wallet') historyEntry('Refund', 'nothing moved', 'warn');
    render();
    refreshGate();
    toast('Refunded');
  }

  /* Practice only: the partner gives up after one side is already in. The point
     of the three steps is exactly this - nothing can be taken, and what was
     locked goes back to whoever locked it. */
  function cancelByPartner() {
    if (S.phase !== 'btc' && S.phase !== 'both') { toast('Nothing is locked yet'); return; }
    if (S.btcState === 'held') S.btcState = 'refunded';
    if (S.usdtState === 'locked') S.usdtState = 'refunded';
    S.phase = 'refunded';
    S.left = 'partner';
    log('SIM', 'the partner walked away without locking', 'c-warn');
    log('REFUND', 'every locked side went back to its owner');
    log('VOID', 'nothing was exchanged', 'c-warn');
    render();
    refreshGate();
    closeSheet();
    toast('Your money came back');
  }

  /* --------------------------------------------------------------- back --- */
  /* Back returns to the amount screen at any point. Once something is locked
     it asks first, so a stray tap cannot throw a running swap away. */
  function openSheet() {
    var l = locked(), body;
    if (l.btc && l.usdt) {
      body = 'Both sides are locked, but nothing is exchanged until the last tap. Leave and anything you locked comes back when the time runs out.';
    } else if (l.btc || l.usdt) {
      body = 'One side is locked already. Leave and whatever you locked comes back when the time runs out.';
    } else {
      body = 'This swap is open, but nothing has been locked yet. Leave and you can start again with another amount.';
    }
    $('sheetBody').textContent = body;
    $('sheet').hidden = false;
    var stay = $('sheetStay');
    if (stay) { try { stay.focus(); } catch (e) { /* ignore */ } }
  }
  function closeSheet() { $('sheet').hidden = true; }
  function goBack() {
    if (S.phase === 'idle' || S.phase === 'settled' || S.phase === 'refunded') return;
    var l = locked();
    if (l.btc || l.usdt) { openSheet(); return; }
    reset();
    toast('Back to the start');
  }

  function reset() {
    S.phase = 'idle'; S.H = null; S.R = null; S.id = null;
    S.btcState = 'none'; S.usdtState = 'none';
    S.sim = 0; S.t1 = null; S.t2 = null; S.units = null; S.sealOpen = false;
    S.inv = ''; S.invDec = null; S.counterInv = ''; S.altInv = ''; S.usdtProof = '';
    S.left = null;
    S.qrInv = '';
    S.role = S.direction === 'u2b' ? 'taker' : 'maker';
    var el = $('pasteIn'); if (el) { el.value = ''; el.dataset.state = ''; }
    var box = $('qrBox'); if (box) box.innerHTML = '';
    closeSheet();
    log('RESET', 'state cleared');
    render();
    refreshGate();
  }

  function join(link) {
    S.role = 'taker';
    S.direction = 'u2b';
    S.mode = 'practice';
    S.H = link.H;
    S.sats = link.sats;
    S.units = link.units;
    S.t2 = link.t2;
    S.t1 = link.t1 || (curHeight() + T1_BLOCKS);
    S.R = null;
    S.phase = 'open';
    S.btcState = 'none'; S.usdtState = 'none';
    S.inv = ''; S.invDec = null;
    S.counterInv = S.mode === 'practice' ? mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
    log('JOIN', 'joined as the USDT side · ' + fmt(S.sats) + ' sats \u21c4 ' + usdtTxt() + ' USDT');
    log('HASH', 'H ' + short(S.H, 8) + ' · R stays with the bitcoin side');
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' · T1 block ' + fmt(S.t1));
    computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2).then(function (id) {
      S.id = id;
      render();
      refreshGate();
    });
    render();
  }

  /* one tap: the gate decides whether it moves on */
  function tap() {
    if (S.phase === 'settled' || S.phase === 'refunded') { reset(); return; }
    if (S.phase === 'idle') { startSwap(); return; }
    if (S.phase === 'expired') { refund(); return; }
    validate().then(function (r) {
      paintGate(r);
      if (!r.ok) {
        shake();
        log('BLOCK', r.msg, 'c-err');
        renderLog();
        toast(r.msg);
        return;
      }
      if (S.phase === 'open') {
        if (S.role === 'maker') lockBtc(r); else lockUsdtLeg(r);
      } else if (S.phase === 'btc') {
        if (S.usdtState !== 'locked') lockUsdtLeg(r); else lockBtc(r);
      } else if (S.phase === 'both') {
        complete(r);
      }
    });
  }

  /* ---------------------------------------------------------------- QR --- */
  function showQr(payload, caption) {
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
  }

  function payloadJson() {
    var out = {
      protocol: 'cleanswap/1',
      mode: S.mode,
      role: S.role,
      phase: S.phase,
      hashlock: S.H,
      sats: S.sats,
      usdt: usdtOf() || null,
      usdtUnits: usdtUnits() || null,
      timelock: S.t2,
      t1: S.t1,
      swapId: S.id,
      invoice: S.inv || null,
      paymentHash: S.invDec ? S.invDec.paymentHash : null,
      usdtProof: (S.usdtProof || '').slice(0, 400),
      calldata: nextCalldata() || null
    };
    if (S.phase === 'settled') out.preimage = S.R || ('0x' + normHex(pasted()));
    return out;
  }

  /* ------------------------------------------------------------ events --- */
  var ACT = {
    mode: function (b) {
      if (S.phase !== 'idle') { toast('Finish this swap first'); return; }
      S.mode = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      S.role = S.direction === 'u2b' ? 'taker' : 'maker';
      render();
      refreshGate();
    },
    direction: function (b) {
      if (S.phase !== 'idle') { toast('Finish this swap first'); return; }
      if (b.dataset.v === 'toggle') S.direction = S.direction === 'u2b' ? 'btc2u' : 'u2b';
      else S.direction = b.dataset.v === 'u2b' ? 'u2b' : 'btc2u';
      S.role = S.direction === 'u2b' ? 'taker' : 'maker';
      render();
      refreshGate();
    },
    sats: function (b) {
      if (S.phase !== 'idle') return;
      S.sats = Number(b.dataset.v);
      S.units = null;
      render();
      refreshGate();
    },
    primary: function () { tap(); },
    reset: function () { reset(); },
    back: function () { goBack(); },
    stay: function () { closeSheet(); },
    leave: function () { reset(); toast('Back to the start'); },
    partnerCancel: function () { cancelByPartner(); },
    copyInvite: function () {
      var p = invitePayload();
      if (!p) { toast('Nothing to share yet'); return; }
      copy(p, 'Link copied');
    },
    qrInvite: function () {
      var p = invitePayload();
      if (!p) { toast('Nothing to share yet'); return; }
      showQr(p, S.mode === 'wallet' && S.role === 'taker' ? 'Your partner scans this to pay you' : 'Your partner scans this to join');
    },
    copyPay: function () {
      var inv = currentInvoice();
      if (!inv) { needInvoice(); return; }
      copy(inv, 'Invoice copied');
    },
    qrPay: function () {
      var inv = currentInvoice();
      if (!inv) { needInvoice(); return; }
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      S.qrInv = inv;
      showQr('lightning:' + inv, 'Scan from your wallet, or tap Open in wallet');
    }
  };

  /* ---------------------------------------------------------------- tick -- */
  function tick() {
    if (S.t2 && ['open', 'btc', 'both'].indexOf(S.phase) >= 0 && nowSec() >= S.t2) {
      S.phase = 'expired';
      log('TIMEOUT', 'T2 passed · claim closed, refund open', 'c-warn');
      render();
      refreshGate();
      toast('Time is up');
    }
  }

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
    if (!currentInvoice()) { e.preventDefault(); needInvoice(); }
  });
  $('pasteIn').addEventListener('input', function () {
    if (S.phase === 'idle' && S.mode === 'wallet' && S.role === 'taker') {
      try {
        var d = parseLightning(pasted());
        if (d && d.sats && d.sats !== S.sats) { S.sats = d.sats; S.units = null; }
      } catch (e) { /* checked on start */ }
    }
    render();
    refreshGate();
  });

  var joined = parseSwapLink(location.hash);
  if (joined) join(joined);

  render();
  refreshGate();
  setInterval(tick, 1000);
  loadRate();

  window.CLEANSWAP = {
    state: S, SEL: SEL, EVM: EVM, QR_MAX: QR_MAX, NET: NET, T2_SPAN: T2_SPAN,
    sha256Hex: sha256Hex, computeSwapId: computeSwapId, bech32Decode: bech32Decode,
    decodeBolt11: decodeBolt11, decodeBolt12: decodeSwapOffer, decodeSwapOffer: decodeSwapOffer,
    mintInvoice: mintInvoice, mintOffer: mintOffer,
    lockCalldata: lockCalldata, decodeLockCalldata: decodeLockCalldata, readLockProof: readLockProof,
    parseLightning: parseLightning, readOffer: readOffer, readEscrow: readEscrow,
    partnerOffer: partnerOffer, partnerEscrow: partnerEscrow, checkSecret: checkSecret,
    nextCalldata: nextCalldata, payload: payloadJson, render: render, renderStep: renderStep,
    refreshGate: refreshGate, validate: validate, checkSwapRequest: function () { return partnerOffer(); },
    checkReceipt: function () { return good('practice: the wallet step is simulated here', { code: 'skip' }); },
    checkProof: function () { return partnerEscrow(); }, checkPreimage: checkSecret,
    swapLink: swapLink, parseSwapLink: parseSwapLink, escrowProof: escrowProof, usdtUnits: usdtUnits,
    stepNo: stepNo, stage: stage, locked: locked, presetsOn: presetsOn,
    paintTrack: paintTrack, paintFlow: paintFlow,
    join: join, reset: reset, createSwap: createSwap, createSwapUsdt: createSwapUsdt,
    tap: tap, run: tap, refund: refund, tick: tick, goBack: goBack,
    cancelByPartner: cancelByPartner, openSheet: openSheet, closeSheet: closeSheet,
    advanceClock: function (sec) { S.sim += (sec || (T2_SPAN + 60)); tick(); render(); refreshGate(); },
    historyEntry: historyEntry
  };
})();
