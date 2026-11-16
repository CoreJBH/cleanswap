/* CLEANSWAP v0.2 — Lightning bitcoin <-> USDT atomic swap in one file.

   The screen stays plain: two escrow cards, one honest button. What changed in
   v0.2 is that the button is no longer decorative. Every step is gated on data
   that a real swap would need, and the gate runs here, in the browser:

     step 1  a BOLT11 hold invoice whose payment_hash is exactly H, for the right
             amount, on the right network, still inside its expiry window
     step 2  the counterparty's escrow lock, decoded and matched against H, T2
             and the USDT amount (lock() calldata, JSON record, Liquid lock URI
             or a lock transaction hash)
     step 3  the 32-byte preimage R, accepted only when SHA256(R) === H

   Practice mode runs both sides on one screen (hold invoice mint, escrow lock,
   reveal) with real WebCrypto, real bech32 and real ABI encoding, and a share
   link that turns another tab into the USDT side. Wallet mode swaps the
   simulated counterparty for a real invoice, a real wallet hand-off and the
   payment_hash your wallet shows afterwards.

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
  var QR_MAX = 271;                 /* bytes at level L, version 10 (the encoder's ceiling) */
  var QR_M = 213;                   /* bytes at level M, version 10 */
  var NET = 'bc';                   /* invoice network prefix */
  var T2_SPAN = 3600;               /* USDT escrow window, seconds */
  var T1_BLOCKS = 40;               /* ~6h40m of bitcoin blocks */
  var BLOCK_SECS = 600;
  var INV_DESC = 'CleanSwap hold invoice';

  var S = {
    mode: 'practice',               /* practice | wallet */
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
    webln: null, nwc: null,
    sealOpen: false,
    usdtProof: '',
    req: null, li: '',
    liquid: '', htlc: '', token: EVM.token,
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
  function tokenAddr() {
    var v = ($('tokenAddr').value || '').trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : EVM.token;
  }
  function htlcAddr() {
    var v = ($('htlcAddr').value || '').trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : EVM.htlc;
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
    var s = String(str).replace(/\s+/g, ''), words = [], i, v;
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
  function assembleInvoice(hrp, body) {
    var data = body.concat(bech32Checksum(hrp, body)), out = hrp + '1', i;
    for (i = 0; i < data.length; i++) out += B32.charAt(data[i]);
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
      return assembleInvoice(hrp, body);
    }
    var out = build(null);
    if (o.description) {
      var withDesc = build(o.description);
      if (withDesc.length <= QR_M) out = withDesc;
    }
    return out;
  }

  /* ----------------------------------------------------- BOLT12 (offers) -- */
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
  function decodeBolt12(raw) {
    var o = String(raw).trim().replace(/^lightning:/i, '');
    if (!/^lno1/i.test(o)) throw new Error('not a BOLT12 offer');
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
    return {
      kind: 'bolt12',
      hrp: r.hrp,
      network: r.hrp.length > 3 ? r.hrp.slice(3) : 'bitcoin',
      paymentHash: null,
      sats: null,
      amount: num(8),
      currency: txt(6),
      description: txt(10),
      issuer: txt(18),
      absoluteExpiry: num(14),
      nodeId: fields[22] ? hexOf(fields[22]) : null,
      quantityMax: num(20),
      types: order.sort(function (a, b) { return a - b; }).map(function (x) {
        return x + (OFFER_TYPES[x] ? ' ' + OFFER_TYPES[x] : '');
      })
    };
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
      token: tokenAddr(), amount: usdtUnits()
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
      return lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: EVM.btcSide, token: tokenAddr(), amount: usdtUnits() });
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
  function checkInvoice() {
    var raw = String($('invIn').value || '').trim().replace(/^lightning:/i, '');
    if (!raw) return bad('empty', 'Paste the hold invoice the USDT side sent you. Nothing locks without a payment_hash.');
    if (!/^ln(bc|tb|bcrt)/i.test(raw)) {
      return bad('format', 'That is not a BOLT11 invoice: it has to start with lnbc, lntb or lnbcrt.');
    }
    var d;
    try { d = decodeBolt11(raw); } catch (e) { return bad('format', 'Invoice rejected — ' + e.message + '.'); }
    if (!d.paymentHash) return bad('format', 'This invoice carries no payment_hash, so it cannot hold a hashlock.');
    if (normHex(d.paymentHash) !== normHex(S.H)) {
      return bad('mismatch', 'payment_hash ' + short(d.paymentHash, 6) + ' is not H (' + short(S.H, 6) +
        '). Paying it would lock bitcoin against a different secret.');
    }
    if (d.sats == null) return bad('amount', 'The invoice is amountless, so the amount cannot be tied to this swap.');
    if (d.sats !== S.sats) {
      return bad('amount', 'The invoice asks for ' + fmt(d.sats) + ' sats; this swap is ' + fmt(S.sats) + ' sats.');
    }
    if (d.expiresAt != null && nowSec() > d.expiresAt) {
      return bad('expired', 'The invoice expired at ' + clock(d.expiresAt) + '. Ask for a fresh one.');
    }
    if (d.network !== NET) return bad('network', 'Invoice network "' + d.network + '" does not match this swap (' + NET + ').');
    return good('payment_hash matches H · ' + fmt(d.sats) + ' sats · expires ' + (d.expiresAt ? clock(d.expiresAt) : 'never'),
      { dec: d, raw: raw });
  }

  function checkReceipt() {
    if (S.mode !== 'wallet') return good('practice: the wallet step is simulated here', { code: 'skip' });
    var v = normHex($('receiptIn').value);
    if (!v) return bad('empty', 'Wallet mode: paste the payment_hash your wallet shows after paying this invoice.');
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
    if (S.phase === 'idle') return Promise.resolve(good('Creating a swap generates a fresh secret R and H = SHA256(R).'));
    if (S.phase === 'expired') return Promise.resolve(good('T2 has passed, so both legs can only be refunded.'));
    if (S.phase === 'settled' || S.phase === 'refunded') return Promise.resolve(good('This swap is closed.'));
    if (stepNo() === 1) {
      if (S.role === 'taker') return Promise.resolve(good('Minting a BOLT11 invoice with payment_hash = H and ' + fmt(S.sats) + ' sats.'));
      var inv = checkInvoice();
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
    if (S.phase === 'idle') return ['Swap bitcoin for USDT', ''];
    if (S.phase === 'open') return t ? ['Issue the hold invoice', ''] : ['Lock bitcoin to open the swap', ''];
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
      ? 'Wallet mode · a real invoice, a real wallet and its payment hash'
      : S.role === 'taker'
        ? 'Practice escrow · you joined as the USDT side'
        : 'Practice escrow · no real funds move';
    $('modePractice').className = S.mode === 'practice' ? 'on' : '';
    $('modeWallet').className = S.mode === 'wallet' ? 'on' : '';
    $('roleBadge').hidden = S.role !== 'taker';
    $('roleTxt').textContent = 'USDT side';

    $('btcAmt').textContent = fmt(S.sats);
    $('usdtAmt').textContent = usdtTxt();
    $('btcSub').textContent = '≈ ' + usdtTxt() + ' USDT' + (S.pstate === 'live' ? ' at the live rate' : ' at the demo rate');

    var cb = btcChip(), cu = usdtChip();
    $('chipBtc').className = 'chip ' + cb.cls;
    $('chipBtcTxt').textContent = cb.txt;
    $('chipUsdt').className = 'chip ' + cu.cls;
    $('chipUsdtTxt').textContent = cu.txt;

    $('rateDot').className = 'dot ' + (S.pstate === 'live' ? 'live' : S.pstate === 'offline' ? 'off' : '');
    $('rateTxt').textContent = S.price ? '1 BTC ≈ ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC ≈ — USDT';

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
    else if (S.phase === 'open') { rs = S.role === 'taker' ? 'No lock yet · mint the invoice' : 'No lock yet'; }
    $('railState').textContent = rs;
    $('railState').className = 'rail-state' + (rsOn ? ' on' : '');

    $('vH').textContent = S.H ? short(S.H, 12) : '—';
    $('vR').textContent = !S.R ? '—'
      : (S.phase === 'settled') ? S.R
        : '0x' + '•'.repeat(8) + S.R.slice(-8) + (S.phase === 'refunded' ? ' (never revealed)' : ' (sealed until settlement)');
    $('vT1').textContent = S.t1 ? 'block ' + fmt(S.t1) + ' · ~' + spanTxt((S.t1 - curHeight()) * BLOCK_SECS) : '—';
    $('vT2').textContent = S.t2 ? 'unix ' + S.t2 + ' · ' + priceNow() : '—';
    $('vId').textContent = S.id || '—';
    $('vRate').textContent = S.pstate === 'live'
      ? 'BTC $' + fmt(Math.round(S.price)) + ' · mempool.space'
      : S.pstate === 'offline' ? 'mempool.space unreachable · demo $90,000' : 'loading…';
    $('vLink').textContent = swapLink() ? short(swapLink(), 14) : '—';
    $('calldata').textContent = nextCalldata() ? short(nextCalldata(), 14) : '—';
    $('vRequest').textContent = liquidRequest() || '—';
    $('weblnInfo').textContent = S.webln ? S.webln.node : 'not connected';
    $('nwcInfo').textContent = S.nwc ? S.nwc.relay + ' · ' + short(S.nwc.pubkey, 4) : '—';

    $('counterInv').textContent = S.counterInv || '—';
    $('shareLink').textContent = swapLink() || '—';
    $('shareRow').hidden = !(S.phase === 'open' && S.role === 'maker' && S.mode === 'practice');
    $('counterSrc').hidden = S.mode !== 'practice' || S.role !== 'maker';
    $('invTools').hidden = S.mode !== 'practice' || S.role !== 'maker';
    $('receiptLbl').hidden = S.mode !== 'wallet';
    $('receiptIn').hidden = S.mode !== 'wallet';
    $('wRow').hidden = S.mode !== 'wallet';
    $('walletLink').setAttribute('href', 'lightning:' + (currentInvoice() || ''));
    $('issueOut').textContent = S.inv || '—';
    $('sealR').textContent = S.R || '—';
    $('seal').hidden = !S.sealOpen || !S.R || S.role === 'taker';
    $('preHint').textContent = S.role === 'taker' ? '· revealed by the bitcoin side' : '· sealed on this device';
    $('expH').textContent = S.H ? short(S.H, 6) : '—';
    $('expT2').textContent = S.t2 ? String(S.t2) : '—';
    $('expAmt').textContent = usdtTxt();

    renderStep();
    renderLog();
    renderMeters();
  }

  function currentInvoice() {
    var v = String($('invIn').value || '').trim();
    return v || S.counterInv || '';
  }

  function renderStep() {
    var step = stepNo(), taker = S.role === 'taker';
    var kick = 'START', title = 'Choose an amount', actor = 'You · bitcoin side', panel = 'pCreate';
    var desc = 'Open a swap, then lock each side against the same hashlock. Nothing moves until both sides are in.';
    var primary = 'Create swap', ghosts = false;

    if (S.phase === 'open' && taker) {
      kick = 'STEP 1 OF 3'; title = 'Issue the hold invoice'; actor = 'You · USDT side'; panel = 'pIssue';
      desc = 'Mint the invoice the bitcoin side will pay. Same H, same amount: the payer locks into an HTLC it can only release with R.';
      primary = 'Mint hold invoice';
    } else if (S.phase === 'open') {
      kick = 'STEP 1 OF 3'; title = 'Lock bitcoin'; actor = 'You · bitcoin side'; panel = 'pInvoice';
      desc = 'Paste the hold invoice from the USDT side. The app decodes it and refuses anything whose payment_hash is not H.';
      primary = 'Pay invoice & lock bitcoin'; ghosts = true;
    } else if (S.phase === 'btc' && taker) {
      kick = 'STEP 2 OF 3'; title = 'Lock USDT in escrow'; actor = 'You · USDT side'; panel = 'pProof';
      desc = 'The bitcoin HTLC is held. Lock the same amount of USDT against the same H, and check the proof before you sign anything.';
      primary = 'Lock USDT'; ghosts = true;
    } else if (S.phase === 'btc') {
      kick = 'STEP 2 OF 3'; title = 'Verify the USDT lock'; actor = 'Counterparty · USDT side'; panel = 'pProof';
      desc = 'Read the counterparty escrow proof and match it against H, T2 and the amount. A lock to any other hash cannot be claimed.';
      primary = 'Verify escrow & continue'; ghosts = true;
    } else if (S.phase === 'both') {
      kick = 'STEP 3 OF 3'; title = taker ? 'Settle the Lightning leg' : 'Settle with the preimage';
      actor = taker ? 'You · USDT side' : 'You · bitcoin side'; panel = 'pClaim';
      desc = taker
        ? 'The claim published R on-chain. Verify it against H and settle the HTLC with it.'
        : 'Reveal R. One hash check settles both legs: the escrow pays out and the HTLC learns its preimage.';
      primary = taker ? 'Settle with revealed R' : 'Settle swap'; ghosts = true;
    } else if (S.phase === 'expired') {
      kick = 'TIMELOCK'; title = 'Refund both legs'; actor = 'Anyone'; panel = '';
      desc = 'T2 has passed, so the claim window is closed. Both sides get their own funds back and R is never revealed.';
      primary = 'Refund both legs'; ghosts = true;
    } else if (S.phase === 'settled') {
      kick = 'CLOSED'; title = 'Swap settled'; actor = 'Both sides'; panel = '';
      desc = 'The escrow paid the bitcoin side and the HTLC was settled with the same R.';
      primary = 'Start a new swap';
    } else if (S.phase === 'refunded') {
      kick = 'CLOSED'; title = 'Both legs refunded'; actor = 'Both sides'; panel = '';
      desc = 'Nothing was claimed before the timelock, so each side kept its own funds.';
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

  function renderMeters() {
    var closed = S.phase === 'settled' || S.phase === 'refunded';
    var t1s = S.t1 ? (S.t1 - curHeight()) * BLOCK_SECS : 0;
    var t1p = S.t1 ? Math.max(0, Math.min(100, t1s / (T1_BLOCKS * BLOCK_SECS) * 100)) : 0;
    var t2s = S.t2 ? S.t2 - nowSec() : 0;
    var t2p = S.t2 ? Math.max(0, Math.min(100, t2s / T2_SPAN * 100)) : 0;
    $('t1H').textContent = S.t1 ? fmt(S.t1) : '—';
    $('t1Left').textContent = !S.t1 ? '—' : closed ? 'closed' : '~' + spanTxt(t1s);
    $('t2U').textContent = S.t2 ? String(S.t2) : '—';
    $('t2Left').textContent = !S.t2 ? '—' : closed ? 'closed' : spanTxt(t2s);
    $('t1Bar').style.width = t1p + '%';
    $('t2Bar').style.width = t2p + '%';
    $('t1Meter').className = 'meter' + (t1p <= 0 ? ' dead' : t1p < 25 ? ' warn' : '');
    $('t2Meter').className = 'meter' + (t2p <= 0 ? ' dead' : t2p < 25 ? ' warn' : '');
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
      S.counterInv = S.mode === 'practice' ? mintInvoice({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN }) : '';
      S.altInv = S.mode === 'practice' ? mintInvoice({ paymentHash: '0x' + rndHex(32), sats: S.sats, expiry: T2_SPAN }) : '';
      log('CREATE', 'Swap opened · ' + fmt(S.sats) + ' sats ⇄ ' + usdtTxt() + ' USDT');
      log('HASH', 'R sealed · H = SHA256(R) = ' + short(S.H, 8));
      log('TIMELOCK', 'T1 block ' + fmt(S.t1) + ' (BTC) · T2 unix ' + S.t2 + ' (USDT)');
      if (S.counterInv) log('INVOICE', 'Counterparty hold invoice minted · payment_hash = H');
      return computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, tokenAddr(), usdtUnits(), S.t2);
    }).then(function (id) {
      S.id = id;
      render();
      refreshGate();
      toast('Swap opened · paste the hold invoice');
    }).catch(function (e) {
      log('FAIL', 'SHA-256: ' + e.message, 'c-err');
      render();
      toast('WebCrypto is unavailable');
    });
  }

  function lockBtc(r) {
    var inv = (r && r.inv) || checkInvoice();
    S.inv = inv.raw;
    S.invDec = inv.dec;
    S.btcState = 'held';
    S.phase = 'btc';
    log('VERIFY', 'payment_hash == H · ' + fmt(inv.dec.sats) + ' sats · network ' + inv.dec.network);
    log('LOCK', 'BTC · ' + fmt(S.sats) + ' sats held in the HTLC until block ' + fmt(S.t1));
    if (S.mode === 'wallet') log('WALLET', 'Receipt accepted · ' + short(normHex($('receiptIn').value), 6));
    render();
    refreshGate();
    toast('Bitcoin locked · verify the USDT escrow');
  }

  function issueInvoice() {
    S.inv = mintInvoice({ paymentHash: S.H, sats: S.sats, expiry: T2_SPAN });
    var d;
    try { d = decodeBolt11(S.inv); } catch (e) {
      log('FAIL', 'minted invoice does not decode: ' + e.message, 'c-err');
      render();
      toast('Invoice could not be verified');
      return;
    }
    S.invDec = d;
    log('INVOICE', 'BOLT11 minted · ' + fmt(d.sats) + ' sats · payment_hash ' + short(d.paymentHash, 6));
    if (normHex(d.paymentHash) !== normHex(S.H)) {
      log('FAIL', 'minted invoice payment_hash is not H', 'c-err');
      render();
      toast('Invoice hash mismatch');
      return;
    }
    log('VERIFY', 'self-check · payment_hash == H ✓ · expires ' + clock(d.expiresAt));
    S.btcState = 'held';
    S.phase = 'btc';
    log('SIM', 'BTC side paid the hold invoice · HTLC held (simulated)', 'c-sim');
    render();
    refreshGate();
    toast('Invoice minted · lock your USDT');
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
      log('CLAIM', 'escrow claimed · ' + usdtTxt() + ' USDT → you');
      log('REVEAL', 'R published ' + short(pre, 6) + ' · anyone can settle the HTLC with it');
      log('SETTLE', 'bitcoin HTLC settled with R · swap closed');
    } else {
      log('CHECK', (r && r.code === 'ok' ? 'SHA256(revealed R) == H ✓' : 'reveal accepted'));
      log('SETTLE', 'Lightning HTLC settled with the revealed R · swap closed');
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
    render();
    toast('Refunded');
  }

  function reset() {
    S.phase = 'idle'; S.H = null; S.R = null; S.id = null;
    S.btcState = 'none'; S.usdtState = 'none';
    S.sim = 0; S.t1 = null; S.t2 = null; S.units = null; S.sealOpen = false;
    S.inv = ''; S.invDec = null; S.counterInv = ''; S.altInv = '';
    ['invIn', 'proofIn', 'preIn', 'receiptIn'].forEach(function (id) {
      $(id).value = ''; $(id).dataset.state = '';
    });
    log('RESET', 'State cleared · start a new swap');
    render();
    refreshGate();
  }

  function join(link) {
    S.role = 'taker';
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
    log('JOIN', 'Joined as the USDT side · ' + fmt(S.sats) + ' sats ⇄ ' + usdtTxt() + ' USDT');
    log('HASH', 'H ' + short(S.H, 8) + ' · R stays with the bitcoin side');
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' · T1 block ' + fmt(S.t1));
    computeSwapId(S.H, EVM.usdtSide, EVM.btcSide, tokenAddr(), usdtUnits(), S.t2).then(function (id) {
      S.id = id;
      render();
      refreshGate();
    });
    render();
  }

  function run() {
    if (S.phase === 'settled' || S.phase === 'refunded' || S.phase === 'idle') {
      if (S.phase === 'idle') { createSwap(); return; }
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

  function row(k, v) {
    return '<div><span class="k">' + k + '</span><span class="v mono">' +
      String(v).replace(/[<>&]/g, '') + '</span></div>';
  }

  function liquidRequest() {
    if (!S.liquid) return '';
    return 'liquidnetwork:' + S.liquid + '?amount=' + (usdtOf() || 0).toFixed(2);
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
      liquid: S.liquid || null,
      htlc: htlcAddr(),
      token: tokenAddr(),
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
      if (S.role === 'taker') { toast('A joined swap runs in practice mode'); return; }
      S.mode = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      render();
      refreshGate();
      if (S.mode === 'wallet') toast('Wallet mode · invoice + wallet receipt');
    },
    sats: function (b) {
      if (S.phase !== 'idle') return;
      S.sats = Number(b.dataset.v);
      S.units = null;
      render();
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
    copyCounter: function () { copy(S.counterInv, 'Invoice copied'); },
    fillCounter: function () {
      if (!S.counterInv) return;
      $('invIn').value = S.counterInv;
      log('PASTE', 'counterparty invoice pasted · checking payment_hash');
      render();
      refreshGate();
    },
    fillWrong: function () {
      if (!S.altInv) return;
      $('invIn').value = S.altInv;
      log('PASTE', 'mismatched invoice pasted · it must be refused');
      render();
      refreshGate();
    },
    copyLink: function () { copy(swapLink(), 'Link copied'); },
    qrLink: function () { showQr('qrLinkBox', swapLink(), 'Open on the USDT side'); },
    genProof: function () {
      if (!S.H) return;
      $('proofIn').value = escrowProof();
      log('PROOF', 'escrow lock calldata generated · hashlock H, timelock T2');
      render();
      refreshGate();
    },
    copyProof: function () { copy($('proofIn').value || escrowProof(), 'Proof copied'); },
    fillWrongProof: function () {
      if (!S.H) return;
      var alt = '0x' + rndHex(32);
      $('proofIn').value = lockCalldata({ hashlock: alt, timelock: S.t2, receiver: EVM.btcSide, token: tokenAddr(), amount: usdtUnits() });
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
    fillWrongPre: function () {
      $('preIn').value = '0x' + rndHex(32);
      log('PASTE', 'wrong preimage pasted · it must be refused');
      render();
      refreshGate();
    },
    copyMine: function () { copy(S.inv, 'Invoice copied'); },
    qrMine: function () { showQr('qrMineBox', S.inv ? 'lightning:' + S.inv : '', 'Scan from the bitcoin wallet'); },
    regenMine: function () { issueInvoice(); },
    qrInv: function () {
      var inv = currentInvoice();
      if (!inv) { toast('Paste the hold invoice first'); return; }
      showQr('qrInvBox', 'lightning:' + inv, 'Scan from a Lightning wallet');
    },
    webln: function () {
      if (!window.webln) { log('FAIL', 'window.webln is absent', 'c-err'); render(); toast('No WebLN wallet in this browser'); return; }
      Promise.resolve(window.webln.enable())
        .then(function () { return window.webln.getInfo ? window.webln.getInfo() : {}; })
        .then(function (info) {
          S.webln = { node: (info && info.node && info.node.alias) || 'webln' };
          log('WEBLN', 'node ' + S.webln.node + ' connected');
          render();
          var inv = currentInvoice();
          if (!inv || !window.webln.sendPayment) { toast('Wallet connected'); return null; }
          return window.webln.sendPayment(inv).then(function (res) {
            var pre = res && res.preimage ? '0x' + normHex(res.preimage) : '';
            if (!pre) { log('WEBLN', 'payment sent but no preimage returned'); toast('Wallet connected'); return; }
            return sha256Hex(pre).then(function (h) {
              if (normHex('0x' + h) === normHex(S.H)) {
                $('receiptIn').value = '0x' + h;
                log('VERIFY', 'WebLN preimage hashes to H ✓');
                toast('Payment verified');
              } else {
                log('BLOCK', 'WebLN preimage does not hash to H', 'c-err');
                toast('That preimage does not match H');
              }
              render();
              refreshGate();
            });
          });
        })
        .catch(function (e) { toast(e && e.message ? e.message : 'WebLN refused the connection'); });
    },
    nwc: function () {
      var uri = ($('nwcInput').value || '').trim();
      if (!uri) { toast('Paste an NWC URI first'); return; }
      try {
        var m = uri.match(/^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\??(.*)$/);
        if (!m) throw new Error('not a nostr+walletconnect URI');
        var params = {};
        (m[2] || '').split('&').forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
        if (!params.relay) throw new Error('missing relay parameter');
        S.nwc = { pubkey: m[1], relay: params.relay, secret: params.secret ? 'set' : 'none', lud16: params.lud16 || '' };
        log('NWC', 'wallet key ' + short(m[1], 4) + ' · ' + params.relay);
        render();
        toast('NWC parsed (no socket opened)');
      } catch (e) {
        log('FAIL', 'NWC: ' + e.message, 'c-err');
        render();
        toast(e.message);
      }
    },
    decode: function () {
      var raw = ($('invoice').value || '').trim().replace(/^lightning:/i, '');
      if (!raw) { toast('Paste a payment request first'); return; }
      try {
        var d = /^lno1/i.test(raw) ? decodeBolt12(raw) : decodeBolt11(raw);
        S.req = d;
        S.li = raw;
        var rows = '';
        if (d.kind === 'bolt11') {
          var match = S.H && d.paymentHash && normHex(d.paymentHash) === normHex(S.H);
          rows = row('kind', 'BOLT11 invoice') +
            row('payment_hash', d.paymentHash || 'none') +
            row('amount', d.sats == null ? 'not set' : fmt(d.sats) + ' sats') +
            row('network', d.network) +
            row('expiry', d.expiry == null ? 'default 3600s' : d.expiry + 's') +
            row('matches H', match ? 'yes ✓' : 'no');
          log('BOLT11', 'payment_hash ' + short(d.paymentHash, 6) + (match ? ' == H ✓' : ''));
        } else {
          rows = row('kind', 'BOLT12 offer') +
            row('description', d.description || 'none') +
            row('amount', d.amount == null ? 'not set' : fmt(d.amount) + ' ' + (d.currency || 'msat')) +
            row('issuer', d.issuer || 'none') +
            row('node', d.nodeId ? short('0x' + d.nodeId, 6) : 'none') +
            row('expiry', d.absoluteExpiry ? new Date(d.absoluteExpiry * 1000).toISOString().slice(0, 10) : 'none') +
            row('payment_hash', 'none (offer)');
          log('BOLT12', 'offer decoded · ' + (d.description || 'no description'));
        }
        $('decodeOut').innerHTML = rows;
        render();
        toast(d.kind === 'bolt11' ? 'Invoice decoded' : 'Offer decoded');
      } catch (e) {
        $('decodeOut').innerHTML = row('error', e.message);
        log('FAIL', 'payment request: ' + e.message, 'c-err');
        render();
      }
    },
    sample11: function () {
      $('invoice').value = $('sample-bolt11').textContent.trim();
      ACT.decode();
    },
    sample12: function () {
      $('invoice').value = $('sample-bolt12').textContent.trim();
      ACT.decode();
    },
    copyUri: function () {
      if (!S.li) { toast('No payment request yet'); return; }
      copy('lightning:' + S.li, 'lightning: URI copied');
    },
    qrUri: function () { showQr('qrUriBox', S.li ? 'lightning:' + S.li : '', 'Scan from a wallet'); },
    copyAddr: function () { copy(S.liquid, 'Address copied'); },
    copyReq: function () { copy(liquidRequest(), 'Request copied'); },
    qrAddr: function () { showQr('qrAddrBox', liquidRequest(), 'Scan from a Liquid wallet'); },
    copyData: function () {
      var d = nextCalldata();
      if (!d) { toast('No call ready yet'); return; }
      copy(d, 'calldata copied');
    },
    copyPayload: function () { copy(JSON.stringify(payloadJson(), null, 2), 'swap JSON copied'); },
    copySol: function () { copy($('sol-source').textContent.trim(), 'contract copied'); },
    ownSwap: function () { reset(); }
  };

  /* --------------------------------------------------------- tick + rate -- */
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
      renderMeters();
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
  ['invIn', 'receiptIn', 'proofIn', 'preIn'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      if (id === 'invIn') $('walletLink').setAttribute('href', 'lightning:' + currentInvoice());
      refreshGate();
    });
  });
  $('liquidAddr').addEventListener('input', function () {
    S.liquid = this.value.trim();
    $('vRequest').textContent = liquidRequest() || '—';
  });

  $('solSrc').textContent = $('sol-source').textContent.trim();
  $('tokenAddr').value = S.token;

  var joined = parseSwapLink(location.hash);
  if (joined) join(joined);

  render();
  refreshGate();
  setInterval(tick, 1000);
  loadRate();

  window.CLEANSWAP = {
    state: S, SEL: SEL, EVM: EVM, QR_MAX: QR_MAX, NET: NET, T2_SPAN: T2_SPAN,
    sha256Hex: sha256Hex, computeSwapId: computeSwapId, bech32Decode: bech32Decode,
    decodeBolt11: decodeBolt11, decodeBolt12: decodeBolt12, mintInvoice: mintInvoice,
    lockCalldata: lockCalldata, decodeLockCalldata: decodeLockCalldata, readLockProof: readLockProof,
    nextCalldata: nextCalldata, payload: payloadJson, render: render, renderStep: renderStep,
    refreshGate: refreshGate, validate: validate, checkInvoice: checkInvoice, checkReceipt: checkReceipt,
    checkProof: checkProof, checkPreimage: checkPreimage, swapLink: swapLink, parseSwapLink: parseSwapLink,
    escrowProof: escrowProof, usdtUnits: usdtUnits, liquidRequest: liquidRequest, stepNo: stepNo,
    join: join, reset: reset, createSwap: createSwap, run: run, tick: tick
  };
})();
