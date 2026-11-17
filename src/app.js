/* CLEANSWAP v0.3 — Lightning bitcoin <-> USDT atomic swap in one file.

   The screen stays out of the way: a big amount card, two asset rows, one
   input, one button. Underneath, every step is still gated on data a real
   swap would need, and the gate runs here, in the browser:

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

   Practice mode runs both sides on one screen (offer mint, escrow lock,
   reveal) with real WebCrypto, real bech32 and real ABI encoding, and a share
   link that turns another tab into the USDT side. Wallet mode swaps the
   simulated counterparty for a real offer or invoice, a real wallet hand-off
   and the payment_hash your wallet shows afterwards.

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
  function historyEntry(title, detail, cls) {
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
      paymentHash: hash && hash.length === 32 ? '0x' + hexOf(hash) : null,
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
  function checkSwapRequest() {
    var raw = String($('invIn').value || '').trim();
    if (!raw) return bad('empty', 'Paste the BOLT12 offer or invoice from the other side. Nothing locks without it.');
    var d;
    try { d = parseLightning(raw); } catch (e) { return bad('format', 'Rejected — ' + e.message + '.'); }
    if (!d) return bad('empty', 'Paste the BOLT12 offer or invoice from the other side. Nothing locks without it.');
    var what = d.kind === 'bolt12' ? (d.form === 'invoice' ? 'BOLT12 invoice' : 'BOLT12 offer') : 'BOLT11 invoice';
    if (!d.paymentHash) return bad('format', 'That ' + what + ' carries no payment hash, so it cannot hold a hashlock.');
    if (normHex(d.paymentHash) !== normHex(S.H)) {
      return bad('mismatch', 'That ' + what + ' is for a different swap: its hash is not H. Revealing R could never claim it.');
    }
    if (d.sats == null) return bad('amount', 'The ' + what + ' sets no amount, so it cannot be tied to this swap.');
    if (d.sats !== S.sats) {
      return bad('amount', 'The ' + what + ' asks for ' + fmt(d.sats) + ' sats; this swap is ' + fmt(S.sats) + ' sats.');
    }
    if (d.absoluteExpiry != null && nowSec() > d.absoluteExpiry) {
      return bad('expired', 'It expired at ' + clock(d.absoluteExpiry) + '. Ask for a fresh one.');
    }
    if (d.kind === 'bolt11' && d.network !== NET) {
      return bad('network', 'Invoice network "' + d.network + '" does not match this swap (' + NET + ').');
    }
    return good(what + ' verified · ' + fmt(d.sats) + ' sats' +
      (d.absoluteExpiry != null ? ' · expires ' + clock(d.absoluteExpiry) : ''), { dec: d, kind: what, raw: raw });
  }

  function checkReceipt() {
    if (S.mode !== 'wallet') return good('practice: the wallet step is simulated here', { code: 'skip' });
    var v = normHex($('receiptIn').value);
    if (!v) return bad('empty', 'Wallet mode: paste the payment_hash your wallet shows after paying this offer.');
    if (!/^[0-9a-f]{64}$/.test(v)) return bad('format', 'A payment hash is 32 bytes: 64 hex characters.');
    if (v !== normHex(S.H)) return bad('mismatch', 'That receipt is for a different payment — its hash is not H.');
    return good('Wallet receipt matches H.');
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
    return { kind: 'error', msg: 'Unrecognised proof. Paste lock() calldata, a swap JSON record, a Liquid lock URI or a 32-byte tx hash.' };
  }

  function checkProof() {
    var p = readLockProof($('proofIn').value);
    if (p.kind === 'empty') {
      return bad('empty', 'Paste the escrow proof: lock() calldata, a lock JSON record, a Liquid lock URI or the lock tx hash.');
    }
    if (p.kind === 'error') return bad('format', p.msg);
    if (p.kind === 'tx') {
      if (/^0x0{64}$/.test(p.hash)) return bad('format', 'That transaction hash is all zeros.');
      return { ok: true, code: 'ref', dec: p,
        msg: 'Lock transaction ' + short(p.hash, 6) + ' recorded as a reference. A hash alone cannot be matched to H offline, so this leg is logged unverified.' };
    }
    if (p.kind === 'calldata' && p.selector !== SEL.lock) {
      return bad('format', 'This calldata calls 0x' + p.selector + ', not lock() (0x' + SEL.lock + ').');
    }
    var locked = String(p.hashlock || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(locked)) return bad('format', 'The proof carries no 32-byte hashlock.');
    if (normHex(locked) !== normHex(S.H)) {
      return bad('mismatch', 'The escrow locks ' + short(locked, 6) + ', not H (' + short(S.H, 6) +
        '). Revealing R could never claim it.');
    }
    var tl = String(p.timelock == null ? '' : p.timelock).trim();
    if (!tl) return bad('timelock', 'The proof has no timelock. T2 has to be visible to compare it with the swap.');
    if (tl !== String(S.t2)) {
      return bad('timelock', 'The escrow timelock is ' + tl + '; this swap needs T2 = ' + S.t2 + '.');
    }
    var units = p.kind === 'liquid'
      ? (p.amount === '' ? null : Math.round(Number(p.amount) * 1e6))
      : (p.amount === '' ? null : Number(p.amount));
    if (units == null || !isFinite(units) || Math.round(units) <= 0) {
      return bad('amount', 'The proof has no USDT amount to compare with ' + usdtTxt() + ' USDT.');
    }
    var held = Math.round(units), want = Number(usdtUnits());
    var same = p.kind === 'liquid' ? Math.round(held / 1e4) === Math.round(want / 1e4) : held === want;
    if (!same) {
      return bad('amount', 'The escrow holds ' + (held / 1e6).toFixed(2) + ' USDT; this swap needs ' + usdtTxt() + ' USDT.');
    }
    if (p.receiver && isAddr(p.receiver) && /^0x0{40}$/.test(p.receiver)) {
      return bad('format', 'The escrow receiver is the zero address — nobody could claim it.');
    }
    var where = p.kind === 'calldata' ? 'lock() calldata' : p.kind === 'json' ? 'lock record' : 'Liquid lock ' + short(p.address, 6);
    var who = p.receiver && isAddr(p.receiver) ? ' · pays ' + short(p.receiver, 4) : '';
    return good(where + ' decoded: hashlock H, timelock T2, ' + usdtTxt() + ' USDT' + who, { dec: p });
  }

  function checkPreimage() {
    var v = normHex($('preIn').value);
    if (!v) return Promise.resolve(bad('empty', 'Paste the 32-byte preimage R. The escrow will not release without it.'));
    if (!/^[0-9a-f]{64}$/.test(v)) return Promise.resolve(bad('format', 'R is 32 bytes: exactly 64 hex characters.'));
    return sha256Hex(v).then(function (h) {
      var got = '0x' + h;
      if (normHex(got) !== normHex(S.H)) {
        return bad('mismatch', 'SHA256(R) = ' + short(got, 8) + ' but H = ' + short(S.H, 8) +
          '. The escrow rejects this preimage.');
      }
      return good('SHA256(R) matches H · this reveal releases the escrow and settles the HTLC.');
    }).catch(function (e) { return bad('format', 'SHA-256 failed: ' + e.message); });
  }

  function stepNo() {
    if (S.phase === 'idle') return 0;
    if (S.phase === 'open') return 1;
    if (S.phase === 'btc') return 2;
    if (S.phase === 'both') return 3;
    return 4;
  }
  function mainInput() {
    if (S.phase === 'open' && S.role === 'maker') return 'invIn';
    if (S.phase === 'btc') return 'proofIn';
    if (S.phase === 'both') return 'preIn';
    return null;
  }

  function validate() {
    if (S.phase === 'idle') {
      if (S.role === 'taker') {
        if (S.mode === 'wallet') {
          var raw = String($('swapIn').value || '').trim();
          if (!raw) return Promise.resolve(bad('empty', 'Wallet mode: paste the BOLT12 offer or invoice you were sent.'));
          var d;
          try { d = parseLightning(raw); } catch (e) { return Promise.resolve(bad('format', 'Rejected — ' + e.message + '.')); }
          if (!d || !d.paymentHash) {
            return Promise.resolve(bad('format', 'That string carries no payment hash to build the swap on.'));
          }
        }
        return Promise.resolve(good('You send ' + usdtTxt() + ' USDT and receive bitcoin.'));
      }
      return Promise.resolve(good('Creating a swap generates a fresh secret R and H = SHA256(R).'));
    }
    if (S.phase === 'expired') return Promise.resolve(good('T2 has passed, so both legs can only be refunded.'));
    if (S.phase === 'settled' || S.phase === 'refunded') return Promise.resolve(good('This swap is closed.'));
    if (stepNo() === 1) {
      if (S.role === 'taker') return Promise.resolve(good('The offer carries this swap\u2019s hashlock and ' + fmt(S.sats) + ' sats.'));
      var inv = checkSwapRequest();
      if (!inv.ok) return Promise.resolve(inv);
      var rc = checkReceipt();
      if (!rc.ok) return Promise.resolve(rc);
      return Promise.resolve(good(inv.msg + (S.mode === 'wallet' ? ' · ' + rc.msg : ''), { inv: inv }));
    }
    if (stepNo() === 2) return Promise.resolve(checkProof());
    if (stepNo() === 3) return checkPreimage();
    return Promise.resolve(bad('state', 'Nothing to confirm in this state.'));
  }

  /* ------------------------------------------------------------ render --- */
  function headline() {
    var t = S.role === 'taker';
    if (S.phase === 'idle') return [t ? 'You send USDT' : 'Swap bitcoin for USDT', ''];
    if (S.phase === 'open') return t ? ['Get paid in bitcoin', ''] : ['Lock bitcoin to open the swap', ''];
    if (S.phase === 'btc') return t ? ['Lock USDT in escrow', ''] : ['Bitcoin is locked · USDT next', ''];
    if (S.phase === 'both') return ['Both sides locked · settle now', 'ready'];
    if (S.phase === 'settled') return ['Swap settled', 'done'];
    if (S.phase === 'expired') return ['Timelock expired', 'warn'];
    return ['Both legs refunded', 'warn'];
  }

  function btcChip() {
    if (S.btcState === 'settled') return { txt: 'Settled', cls: 'on' };
    if (S.btcState === 'held') return { txt: 'HTLC held', cls: S.phase === 'expired' ? 'warn' : 'on' };
    if (S.btcState === 'refunded') return { txt: 'Refunded', cls: 'warn' };
    if (S.phase === 'expired') return { txt: 'Expired', cls: 'warn' };
    return { txt: 'Unlocked', cls: '' };
  }
  function usdtChip() {
    if (S.usdtState === 'claimed') return { txt: 'Claimed', cls: 'on' };
    if (S.usdtState === 'locked') return { txt: 'Locked', cls: S.phase === 'expired' ? 'warn' : 'on' };
    if (S.usdtState === 'refunded') return { txt: 'Refunded', cls: 'warn' };
    if (S.phase === 'expired') return { txt: 'Expired', cls: 'warn' };
    return { txt: 'Unlocked', cls: '' };
  }

  function render() {
    var h = headline();
    document.body.dataset.phase = S.phase;
    document.body.dataset.mode = S.mode;
    document.body.dataset.role = S.role;

    $('statusTxt').textContent = h[0];
    $('statusTxt').className = 'headline' + (h[1] ? ' ' + h[1] : '');
    $('note').textContent = S.mode === 'wallet'
      ? 'Wallet mode · a real offer or invoice, your wallet, its payment hash'
      : S.role === 'taker'
        ? 'Practice escrow · you are the USDT side'
        : 'Practice escrow · no real funds move';
    $('modePractice').className = S.mode === 'practice' ? 'on' : '';
    $('modeWallet').className = S.mode === 'wallet' ? 'on' : '';
    $('roleBadge').hidden = S.role !== 'taker';
    $('roleTxt').textContent = 'USDT side';

    $('btcAmt').textContent = fmt(S.sats);
    $('usdtAmt').textContent = usdtTxt();
    $('btcSub').textContent = '\u2248 ' + usdtTxt() + ' USDT' + (S.pstate === 'live' ? ' at the live rate' : ' at the demo rate');
    $('usdtSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';

    var cb = btcChip(), cu = usdtChip();
    $('chipBtc').className = 'chip ' + cb.cls;
    $('chipBtcTxt').textContent = cb.txt;
    $('chipUsdt').className = 'chip ' + cu.cls;
    $('chipUsdtTxt').textContent = cu.txt;

    $('rateDot').className = 'dot ' + (S.pstate === 'live' ? 'live' : S.pstate === 'offline' ? 'off' : '');
    $('rateTxt').textContent = S.price ? '1 BTC \u2248 ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC \u2248 — USDT';

    var btcOn = S.btcState === 'held' || S.btcState === 'settled';
    var usdtOn = S.usdtState === 'locked' || S.usdtState === 'claimed';
    $('cardBtc').dataset.on = btcOn ? '1' : '0';
    $('cardUsdt').dataset.on = usdtOn ? '1' : '0';
    $('lkBtc').className = 'lk' + (btcOn ? ' on' : '');
    $('lkUsdt').className = 'lk' + (usdtOn ? ' on' : '');
    $('railFill').style.setProperty('--f', (btcOn && usdtOn ? 100 : btcOn || usdtOn ? 50 : 0) + '%');
    var rs = 'Neither side locked', rsOn = false;
    if (S.phase === 'settled') { rs = 'Settled · both legs closed'; rsOn = true; }
    else if (S.phase === 'refunded') { rs = 'Refunded · nothing was claimed'; }
    else if (S.phase === 'expired') { rs = 'Timelock expired · refund open'; }
    else if (btcOn && usdtOn) { rs = 'Both sides locked · settle before T2'; rsOn = true; }
    else if (btcOn) { rs = 'Bitcoin locked · waiting for USDT'; rsOn = true; }
    else if (usdtOn) { rs = 'USDT locked · waiting for bitcoin'; rsOn = true; }
    else if (S.phase === 'open') { rs = S.role === 'taker' ? 'No lock yet · verify the offer' : 'No lock yet'; }
    $('railState').textContent = rs;
    $('railState').className = 'rail-state' + (rsOn ? ' on' : '');

    $('t1Row').hidden = !S.t1;
    $('t2Row').hidden = !S.t2;
    $('t1H').textContent = S.t1 ? fmt(S.t1) : '—';
    $('t1Left').textContent = !S.t1 ? '—' : (S.phase === 'settled' || S.phase === 'refunded') ? 'closed' : '~' + spanTxt((S.t1 - curHeight()) * BLOCK_SECS);
    $('t2U').textContent = S.t2 ? String(S.t2) : '—';
    $('t2Left').textContent = !S.t2 ? '—' : (S.phase === 'settled' || S.phase === 'refunded') ? 'closed' : priceNow();
    $('t1Meter').className = 'meter' + (S.t1 && (S.phase !== 'settled' && S.phase !== 'refunded') && ((S.t1 - curHeight()) * BLOCK_SECS) < T1_BLOCKS * BLOCK_SECS * .25 ? ' warn' : '');
    $('t2Meter').className = 'meter' + (S.t2 && (S.phase !== 'settled' && S.phase !== 'refunded') && (S.t2 - nowSec()) < T2_SPAN * .25 ? ' warn' : '');
    $('t1Bar').style.width = S.t1 ? Math.max(0, Math.min(100, (S.t1 - curHeight()) * BLOCK_SECS / (T1_BLOCKS * BLOCK_SECS) * 100)) + '%' : '0%';
    $('t2Bar').style.width = S.t2 ? Math.max(0, Math.min(100, (S.t2 - nowSec()) / T2_SPAN * 100)) + '%' : '0%';

    $('counterInv').textContent = S.counterInv || '—';
    $('shareLink').textContent = swapLink() || '—';
    $('shareRow').hidden = !(S.phase === 'open' && S.role === 'maker' && S.mode === 'practice');
    $('receiptLbl').hidden = S.mode !== 'wallet';
    $('receiptIn').hidden = S.mode !== 'wallet';
    $('wRow').hidden = S.mode !== 'wallet';
    $('walletLink').setAttribute('href', 'lightning:' + (currentInvoice() || ''));
    $('issueOut').textContent = S.inv || '—';
    $('sealR').textContent = S.R || '—';
    $('seal').hidden = !S.sealOpen || !S.R || S.role === 'taker';
    $('preHint').textContent = S.role === 'taker' ? '· revealed by the bitcoin side' : '· sealed on this device';
    $('swapRow').hidden = !(S.phase === 'idle' && S.role === 'taker' && S.mode === 'wallet');
    $('swapIn').hidden = !(S.phase === 'idle' && S.role === 'taker' && S.mode === 'wallet');

    renderStep();
    renderLog();
  }

  function currentInvoice() {
    var v = String($('invIn').value || '').trim();
    return v || S.counterInv || '';
  }

  function renderStep() {
    var step = stepNo(), taker = S.role === 'taker';
    var kick = 'START', title = taker ? 'You send USDT' : 'Choose an amount';
    var actor = taker ? 'You · USDT side' : 'You · bitcoin side', panel = 'pCreate';
    var desc = taker ? 'Verify the offer, lock USDT, settle in bitcoin.' : 'Open a swap, then lock each side against the same hashlock.';
    var primary = taker ? 'Start swap' : 'Create swap', ghosts = false;

    if (S.phase === 'open' && taker) {
      kick = 'STEP 1 OF 3'; title = 'Verify the offer'; actor = 'You · USDT side'; panel = 'pIssue';
      desc = '';
      primary = 'Verify & lock'; ghosts = true;
    } else if (S.phase === 'open') {
      kick = 'STEP 1 OF 3'; title = 'Lock bitcoin'; actor = 'You · bitcoin side'; panel = 'pInvoice';
      desc = '';
      primary = 'Pay invoice & lock bitcoin'; ghosts = true;
    } else if (S.phase === 'btc' && taker) {
      kick = 'STEP 2 OF 3'; title = 'Lock USDT in escrow'; actor = 'You · USDT side'; panel = 'pProof';
      desc = '';
      primary = 'Lock USDT'; ghosts = true;
    } else if (S.phase === 'btc') {
      kick = 'STEP 2 OF 3'; title = 'Verify the USDT lock'; actor = 'Counterparty · USDT side'; panel = 'pProof';
      desc = '';
      primary = 'Verify escrow & continue'; ghosts = true;
    } else if (S.phase === 'both') {
      kick = 'STEP 3 OF 3'; title = taker ? 'Settle the Lightning leg' : 'Settle with the preimage';
      actor = taker ? 'You · USDT side' : 'You · bitcoin side'; panel = 'pClaim';
      desc = '';
      primary = taker ? 'Settle with revealed R' : 'Settle swap'; ghosts = true;
    } else if (S.phase === 'expired') {
      kick = 'TIMELOCK'; title = 'Refund both legs'; actor = 'Anyone'; panel = '';
      desc = '';
      primary = 'Refund both legs'; ghosts = true;
    } else if (S.phase === 'settled') {
      kick = 'CLOSED'; title = 'Swap settled'; actor = 'Both sides'; panel = '';
      desc = '';
      primary = 'Start a new swap';
    } else if (S.phase === 'refunded') {
      kick = 'CLOSED'; title = 'Both legs refunded'; actor = 'Both sides'; panel = '';
      desc = '';
      primary = 'Start a new swap';
    }

    $('stepKicker').textContent = kick;
    $('stepTitle').textContent = title;
    $('stepActor').textContent = actor;
    $('stepActor').className = 'actor' + (actor.indexOf('Counterparty') === 0 ? ' other' : '');
    $('stepDesc').textContent = desc;
    ['pCreate', 'pIssue', 'pInvoice', 'pProof', 'pClaim'].forEach(function (id) {
      $(id).hidden = (panel !== id);
    });
    $('primary').textContent = primary;
    $('ghostA').hidden = !ghosts;
    $('ghostB').hidden = !ghosts;
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
    gateTimer = setTimeout(function () {
      validate().then(paintGate);
    }, 80);
  }
  function paintGate(r) {
    S.gate = r;
    var g = $('gate');
    var state = r.ok ? (r.code === 'ref' ? 'ref' : 'ok') : (r.code === 'empty' ? 'idle' : 'err');
    g.dataset.state = state;
    $('gateTxt').textContent = r.msg;
    $('primary').dataset.ready = r.ok ? '1' : '0';
    var id = mainInput();
    if (id) {
      var el = $(id);
      el.dataset.state = r.ok ? 'ok' : (r.code === 'empty' ? '' : 'err');
    }
  }
  function shake() {
    var g = $('gate');
    g.classList.remove('shake');
    void g.offsetWidth;
    g.classList.add('shake');
  }

  /* ------------------------------------------------------------ actions -- */
  function createSwap() {
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      S.R = '0x' + R;
      S.H = '0x' + H;
      S.t2 = nowSec() + T2_SPAN;
      S.t1 = curHeight() + T1_BLOCKS;
      S.units = S.price ? Math.round(S.sats / 1e8 * S.price * 1e6) : null;
      S.phase = 'open';
      S.btcState = 'none'; S.usdtState = 'none';
      S.inv = ''; S.invDec = null;
      $('invIn').value = ''; $('proofIn').value = ''; $('preIn').value = ''; $('receiptIn').value = '';
      $('invIn').dataset.state = ''; $('proofIn').dataset.state = ''; $('preIn').dataset.state = '';
      S.counterInv = S.mode === 'practice' ? mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
      S.altInv = S.mode === 'practice' ? mintOffer({ paymentHash: '0x' + rndHex(32), sats: S.sats, expiry: T2_SPAN }) : '';
      log('CREATE', 'Swap opened · ' + fmt(S.sats) + ' sats \u21c4 ' + usdtTxt() + ' USDT');
      log('HASH', 'R sealed · H = SHA256(R) = ' + short(S.H, 8));
      log('TIMELOCK', 'T1 block ' + fmt(S.t1) + ' (BTC) · T2 unix ' + S.t2 + ' (USDT)');
      if (S.counterInv) log('OFFER', 'BOLT12 offer minted · hashlock = H');
      return computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2);
    }).then(function (id) {
      S.id = id;
      render();
      refreshGate();
      toast('Swap opened · verify the offer');
    }).catch(function (e) {
      log('FAIL', 'SHA-256: ' + e.message, 'c-err');
      render();
      toast('WebCrypto is unavailable');
    });
  }

  /* Send-USDT start: this device plays both sides, so the hashlock is created
     here and the bitcoin side is simulated from the same secret. */
  function createSwapUsdt() {
    var done = function (H, R) {
      /* practice: this device simulates the bitcoin side, so it also holds
         the preimage. wallet: R stays with the counterparty until the reveal. */
      S.R = R || null;
      S.H = '0x' + normHex(H);
      S.t2 = nowSec() + T2_SPAN;
      S.t1 = curHeight() + T1_BLOCKS;
      S.units = S.price ? Math.round(S.sats / 1e8 * S.price * 1e6) : null;
      S.phase = 'open';
      S.btcState = 'none'; S.usdtState = 'none';
      S.inv = ''; S.invDec = null;
      $('proofIn').value = ''; $('preIn').value = ''; $('receiptIn').value = '';
      $('proofIn').dataset.state = ''; $('preIn').dataset.state = '';
      S.counterInv = S.mode === 'practice' ? mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
      S.altInv = S.mode === 'practice' ? mintOffer({ paymentHash: '0x' + rndHex(32), sats: S.sats, expiry: T2_SPAN }) : '';
      log('CREATE', 'Swap opened from the USDT side · ' + usdtTxt() + ' USDT \u21c4 ' + fmt(S.sats) + ' sats');
      log('HASH', 'H = SHA256(R) = ' + short(S.H, 8) + ' · the bitcoin side keeps R');
      log('TIMELOCK', 'T1 block ' + fmt(S.t1) + ' (BTC) · T2 unix ' + S.t2 + ' (USDT)');
      if (S.mode === 'practice') {
        S.inv = S.counterInv;
        $('invIn').value = S.counterInv;
        log('OFFER', 'BOLT12 offer minted · hashlock = H');
        log('SIM', 'the bitcoin side is this device in practice mode', 'c-sim');
        log('PASTE', 'offer pasted · hashlock verified');
      } else {
        log('OFFER', 'waiting for the offer or invoice you were sent');
      }
      historyEntry('Opened', '+' + fmt(S.sats) + ' sats');
      computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2).then(function (id) {
        S.id = id;
        render();
        refreshGate();
        toast('Swap opened · lock your USDT');
      });
    };
    if (S.mode === 'wallet') {
      try {
        var d = parseLightning($('swapIn').value);
        if (!d || !d.paymentHash) {
          log('BLOCK', 'that string carries no payment hash to build the swap on', 'c-err');
          render();
          refreshGate();
          return;
        }
        if (d.sats) S.sats = d.sats;
        done(d.paymentHash);
      } catch (e) {
        log('BLOCK', e.message, 'c-err');
        render();
        refreshGate();
      }
      return;
    }
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      done(H, '0x' + R);
    });
  }

  function lockBtc(r) {
    var inv = (r && r.inv) || checkSwapRequest();
    S.inv = inv.raw || String($('invIn').value || '').trim();
    S.invDec = inv.dec;
    S.btcState = 'held';
    S.phase = 'btc';
    log('VERIFY', (inv.dec && inv.dec.kind === 'bolt12' ? 'BOLT12 ' + (inv.dec.form || 'offer') : 'BOLT11') +
      ' · payment_hash == H · ' + fmt(S.sats) + ' sats');
    log('LOCK', 'BTC · ' + fmt(S.sats) + ' sats held in the HTLC until block ' + fmt(S.t1));
    if (S.mode === 'wallet') log('WALLET', 'Receipt accepted · ' + short(normHex($('receiptIn').value), 6));
    render();
    refreshGate();
    toast('Bitcoin locked · verify the USDT escrow');
  }

  function issueInvoice() {
    if (!S.inv) S.inv = mintOffer({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN });
    var d;
    try { d = decodeSwapOffer(S.inv); } catch (e) {
      log('FAIL', 'minted offer does not decode: ' + e.message, 'c-err');
      render();
      toast('Offer could not be verified');
      return;
    }
    S.invDec = d;
    log('OFFER', 'BOLT12 minted · ' + fmt(d.sats || S.sats) + ' sats · hashlock ' + short(d.paymentHash, 6));
    if (normHex(d.paymentHash) !== normHex(S.H)) {
      log('FAIL', 'minted offer hashlock is not H', 'c-err');
      render();
      toast('Offer hash mismatch');
      return;
    }
    log('VERIFY', 'self-check · hashlock == H \u2713 · expires ' + clock(d.absoluteExpiry));
    S.btcState = 'held';
    S.phase = 'btc';
    log('SIM', 'BTC side paid the hold invoice · HTLC held (simulated)', 'c-sim');
    render();
    refreshGate();
    toast('Offer verified · lock your USDT');
  }

  function lockUsdt(r) {
    S.usdtState = 'locked';
    S.phase = 'both';
    S.usdtProof = String($('proofIn').value || '').trim();
    log('VERIFY', (r && r.msg) || checkProof().msg);
    log('LOCK', 'USDT · ' + usdtTxt() + ' USDT locked in escrow until T2 ' + S.t2);
    render();
    refreshGate();
    toast('USDT locked · settle with R');
  }

  function settle(r) {
    var pre = '0x' + normHex($('preIn').value);
    S.btcState = 'settled';
    S.usdtState = 'claimed';
    S.phase = 'settled';
    if (S.role === 'maker') {
      log('CLAIM', 'escrow claimed · ' + usdtTxt() + ' USDT \u2192 you');
      log('REVEAL', 'R published ' + short(pre, 6) + ' · anyone can settle the HTLC with it');
      log('SETTLE', 'bitcoin HTLC settled with R · swap closed');
      historyEntry('Swapped', '+' + usdtTxt() + ' USDT', 'plus');
    } else {
      log('CHECK', (r && r.code === 'ok' ? 'SHA256(revealed R) == H \u2713' : 'reveal accepted'));
      log('SETTLE', 'Lightning HTLC settled with the revealed R · swap closed');
      historyEntry('Swapped', '+' + fmt(S.sats) + ' sats', 'plus');
    }
    render();
    refreshGate();
    toast('Swap settled');
  }

  function doRefund() {
    if (nowSec() < (S.t2 || 0)) { toast('T2 has not passed yet'); return; }
    var held = S.btcState === 'held' || S.usdtState === 'locked';
    if (S.btcState === 'held') S.btcState = 'refunded';
    if (S.usdtState === 'locked') S.usdtState = 'refunded';
    S.phase = 'refunded';
    log('REFUND', held ? 'both legs returned to their owners after T2' : 'nothing was locked · the swap expired unused');
    log('VOID', 'R was never revealed · the hashlock stays unused', 'c-warn');
    historyEntry('Refunded', 'after T2', 'warn');
    render();
    toast('Refunded');
  }

  function reset() {
    S.phase = 'idle'; S.H = null; S.R = null; S.id = null;
    S.btcState = 'none'; S.usdtState = 'none';
    S.sim = 0; S.t1 = null; S.t2 = null; S.units = null; S.sealOpen = false;
    S.inv = ''; S.invDec = null; S.counterInv = ''; S.altInv = '';
    S.role = S.direction === 'u2b' ? 'taker' : 'maker';
    ['invIn', 'proofIn', 'preIn', 'receiptIn', 'swapIn'].forEach(function (id) {
      $(id).value = ''; $(id).dataset.state = '';
    });
    log('RESET', 'State cleared · start a new swap');
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
    log('JOIN', 'Joined as the USDT side · ' + fmt(S.sats) + ' sats \u21c4 ' + usdtTxt() + ' USDT');
    log('HASH', 'H ' + short(S.H, 8) + ' · R stays with the bitcoin side');
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' · T1 block ' + fmt(S.t1));
    computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, EVM.token, usdtUnits(), S.t2).then(function (id) {
      S.id = id;
      render();
      refreshGate();
    });
    render();
  }

  function run() {
    if (S.phase === 'settled' || S.phase === 'refunded' || S.phase === 'idle') {
      if (S.phase === 'idle') {
        if (S.role === 'taker') { createSwapUsdt(); return; }
        createSwap();
        return;
      }
      reset();
      return;
    }
    if (S.phase === 'expired') { doRefund(); return; }
    var step = stepNo();
    validate().then(function (r) {
      paintGate(r);
      if (!r.ok) {
        shake();
        log('BLOCK', r.msg, 'c-err');
        renderLog();
        toast(r.msg);
        return;
      }
      if (step === 1) (S.role === 'taker' ? issueInvoice() : lockBtc(r));
      else if (step === 2) lockUsdt(r);
      else if (step === 3) settle(r);
    });
  }

  /* ---------------------------------------------------------------- QR --- */
  function showQr(boxId, payload, caption) {
    var box = $(boxId);
    if (!payload) { box.innerHTML = ''; toast('Nothing to encode yet'); return; }
    var bytes = utf8(payload).length;
    if (bytes > QR_MAX) {
      box.innerHTML = '<p class="hint">Too long for a QR here: copy it, or use the lightning: link instead.</p>';
      return;
    }
    var svg = null;
    ['M', 'L'].forEach(function (level) {
      if (svg) return;
      try { svg = window.QR.svg(payload, { level: level, quiet: 2 }); } catch (e) { svg = null; }
    });
    if (!svg) {
      box.innerHTML = '<p class="hint">Too long for a QR here: copy it, or use the lightning: link instead.</p>';
      return;
    }
    box.innerHTML = svg + (caption ? '<p class="hint" style="margin-top:8px">' + caption + '</p>' : '');
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
    if (S.phase === 'settled') out.preimage = S.R || ('0x' + normHex($('preIn').value));
    return out;
  }

  /* ------------------------------------------------------------ events --- */
  var ACT = {
    mode: function (b) {
      if (S.phase !== 'idle') { toast('Finish or reset the swap first'); return; }
      if (S.role === 'taker' && S.direction !== 'u2b') { toast('A joined swap runs in practice mode'); return; }
      S.mode = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      render();
      refreshGate();
      if (S.mode === 'wallet') toast('Wallet mode · offer or invoice + wallet receipt');
    },
    direction: function (b) {
      if (S.phase !== 'idle') { toast('Finish or reset the swap first'); return; }
      if (b.dataset.v === 'toggle') {
        S.direction = S.direction === 'u2b' ? 'btc2u' : 'u2b';
      } else {
        S.direction = b.dataset.v === 'u2b' ? 'u2b' : 'btc2u';
      }
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
    primary: function () { run(); },
    advance: function () {
      if (['open', 'btc', 'both'].indexOf(S.phase) < 0) return;
      S.sim += T2_SPAN + 60;
      log('CLOCK', 'test clock +' + Math.round((T2_SPAN + 60) / 60) + ' min', 'c-warn');
      tick();
      render();
      refreshGate();
    },
    reset: function () { reset(); },
    fillOffer: function () {
      if (!S.counterInv) return;
      $('invIn').value = S.counterInv;
      log('PASTE', 'offer pasted · checking the hashlock');
      render();
      refreshGate();
    },
    wrongOffer: function () {
      if (!S.altInv) return;
      $('invIn').value = S.altInv;
      log('PASTE', 'mismatched offer pasted · it must be refused');
      render();
      refreshGate();
    },
    copyLink: function () { copy(swapLink(), 'Link copied'); },
    qrLink: function () { showQr('qrLinkBox', swapLink(), 'Open on the USDT side'); },
    fillProof: function () {
      if (!S.H) return;
      $('proofIn').value = escrowProof();
      log('PROOF', 'escrow lock calldata generated · hashlock H, timelock T2');
      render();
      refreshGate();
    },
    wrongProof: function () {
      if (!S.H) return;
      var alt = '0x' + rndHex(32);
      $('proofIn').value = lockCalldata({ hashlock: alt, timelock: S.t2, receiver: EVM.btcSide, token: EVM.token, amount: usdtUnits() });
      log('PASTE', 'mismatched escrow lock pasted · it must be refused');
      render();
      refreshGate();
    },
    reveal: function () {
      if (!S.R) { toast('R belongs to the bitcoin side'); return; }
      S.sealOpen = true;
      $('seal').hidden = false;
      log('SEAL', 'R revealed on this device only');
    },
    fillPre: function () {
      if (!S.R) { toast('R belongs to the bitcoin side'); return; }
      $('preIn').value = S.R;
      log('PASTE', 'own preimage pasted · checking SHA256(R) == H');
      render();
      refreshGate();
    },
    wrongPre: function () {
      $('preIn').value = '0x' + rndHex(32);
      log('PASTE', 'wrong preimage pasted · it must be refused');
      render();
      refreshGate();
    },
    qrOut: function () { showQr('qrOutBox', S.inv ? 'lightning:' + S.inv : '', 'Scan from the other side'); },
    copyIssue: function () {
      if (!S.inv) { toast('Nothing to copy yet'); return; }
      copy(S.inv, 'Invoice copied');
    },
    copyInv: function () {
      var inv = currentInvoice();
      if (!inv) { toast('Paste the offer or invoice first'); return; }
      copy(inv, 'Invoice copied');
    },
    qrIn: function () {
      var inv = currentInvoice();
      if (!inv) { toast('Paste the offer or invoice first'); return; }
      showQr('qrInBox', 'lightning:' + inv, 'Scan from a Lightning wallet');
    },
    copyData: function () {
      var d = nextCalldata();
      if (!d) { toast('No call ready yet'); return; }
      copy(d, 'calldata copied');
    },
    copyPayload: function () { copy(JSON.stringify(payloadJson(), null, 2), 'swap JSON copied'); }
  };

  /* ---------------------------------------------------------------- tick -- */
  function tick() {
    if (S.t2) {
      if (['open', 'btc', 'both'].indexOf(S.phase) >= 0 && nowSec() >= S.t2) {
        S.phase = 'expired';
        log('TIMEOUT', 'T2 passed · claim closed, refund open', 'c-warn');
        render();
        refreshGate();
        toast('Timelock expired');
        return;
      }
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
      .then(function () { clearTimeout(timer); render(); });
  }

  /* ---------------------------------------------------------------- boot -- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var fn = ACT[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b); }
  });
  ['invIn', 'receiptIn', 'proofIn', 'preIn', 'swapIn'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      if (id === 'invIn') $('walletLink').setAttribute('href', 'lightning:' + currentInvoice());
      if (id === 'swapIn' && S.phase === 'idle' && S.role === 'taker' && S.mode === 'wallet') {
        try {
          var d = parseLightning($('swapIn').value);
          if (d && d.sats && d.sats !== S.sats) { S.sats = d.sats; S.units = null; }
        } catch (e) { /* validated on start */ }
      }
      render();
      refreshGate();
    });
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
    parseLightning: parseLightning,
    nextCalldata: nextCalldata, payload: payloadJson, render: render, renderStep: renderStep,
    refreshGate: refreshGate, validate: validate, checkSwapRequest: checkSwapRequest, checkReceipt: checkReceipt,
    checkProof: checkProof, checkPreimage: checkPreimage, swapLink: swapLink, parseSwapLink: parseSwapLink,
    escrowProof: escrowProof, usdtUnits: usdtUnits, stepNo: stepNo,
    join: join, reset: reset, createSwap: createSwap, createSwapUsdt: createSwapUsdt, run: run, tick: tick,
    historyEntry: historyEntry
  };
})();
