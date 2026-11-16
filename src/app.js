/* CleanSwap — Lightning BTC <-> USDT atomic swap in one file.

   The screen is deliberately plain: two cards, one button. The protocol lives
   underneath — sha256 hashlock (Bitcoin's construction, never keccak), a
   Lightning HTLC on one leg and a token lock on the other, the same 32-byte
   preimage settling both.

   practice mode: local simulator. Real WebCrypto SHA-256, real state machine,
   no chain and no funds.
   wallet mode:  the same flow plus wallet hand-off — standard `lightning:`
   deep link, QR and clipboard, so BlueWallet / Wallet of Satoshi / Lexe / AQUA
   / Blockstream Green open the request natively, no browser extension.

   BOLT11 invoices carry payment_hash (what the HTLC needs). BOLT12 offers
   (lno1…) do not; they are the Lexe offer endpoint shape and are decoded and
   shown, while preimage matching stays with a BOLT11 invoice. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* keccak256(signature) selectors — verified against solc 0.8.26 --hashes */
  var SEL = { lock: '91644b2b', claim: '84cc9dfb', refund: '7249fbb6' };
  var EVM = {
    taker: '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',
    maker: '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761',
    token: '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097'
  };
  var FALLBACK_PRICE = 90000;
  var QR_MAX = 200; // bytes; QR encoder covers versions 1..10

  var S = {
    mode: 'practice',
    phase: 'idle',
    sats: 50000,
    price: null,
    pstate: 'loading',
    H: null, R: null, id: null,
    t1: null, t2: null,
    lockM: false, lockT: false,
    sim: 0,
    h0: 923452,
    log: [],
    webln: null,
    nwc: null,
    req: null,     // decoded payment request
    li: '',        // raw payment request string
    liquid: '',
    htlc: '',
    token: EVM.token
  };

  /* ------------------------------------------------------------ helpers -- */
  function hexOf(u8) {
    var s = '', i;
    for (i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return s;
  }
  function fromHex(h) {
    var clean = String(h).replace(/^0x/i, ''), out = new Uint8Array(clean.length / 2), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
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
    return h && h.length > n * 2 + 6 ? h.slice(0, n + 2) + '…' + h.slice(-4) : (h || '—');
  }
  function nowSec() { return Math.floor(Date.now() / 1000) + S.sim; }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  function usdtOf() { return S.price ? S.sats / 1e8 * S.price : 0; }
  function usdtTxt() {
    return usdtOf()
      ? usdtOf().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—';
  }
  function units() { return Math.round(usdtOf() * 1e6); }
  function tokenAddr() {
    var v = ($('tokenAddr').value || '').trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : EVM.token;
  }
  function htlcAddr() {
    var v = ($('htlcAddr').value || '').trim();
    return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
  }
  function clock(t) {
    var d = new Date((t || nowSec()) * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function leftTxt() {
    if (!S.t2) return '—';
    var s = S.t2 - nowSec();
    if (s <= 0) return '만료';
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return h ? h + '시간 ' + ('0' + m).slice(-2) + '분' : m + '분 ' + ('0' + sec).slice(-2) + '초';
  }
  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2000);
  }
  function copy(text, what) {
    if (!text || text === '—') { toast('복사할 내용이 없어요'); return; }
    var done = function () { toast((what || '복사') + '했어요'); };
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
    if (S.log.length > 40) S.log.pop();
  }

  /* ------------------------------------------------- sha256 swap identity -- */
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
    if (!s) throw new Error('empty');
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
    s = s.toLowerCase();
    var pos = s.lastIndexOf('1');
    if (pos < 1 || pos + 1 >= s.length) throw new Error('bad separator');
    var hrp = s.slice(0, pos), data = s.slice(pos + 1);
    for (i = 0; i < data.length; i++) {
      v = B32.indexOf(data.charAt(i));
      if (v < 0) throw new Error('bad char "' + data.charAt(i) + '"');
      words.push(v);
    }
    return { hrp: hrp, words: words };
  }
  /* BOLT11: bech32 with a 6-word checksum, no 90-char limit. */
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
  function wordsToInt(words) {
    var n = 0, i;
    for (i = 0; i < words.length; i++) n = n * 32 + words[i];
    return n;
  }
  function decodeBolt11(raw) {
    var inv = String(raw).trim().replace(/^lightning:/i, '');
    if (!/^ln[a-z]+/i.test(inv)) throw new Error('not a BOLT11 invoice');
    var dec = bech32Decode(inv), hrp = dec.hrp, words = dec.words;
    var m = hrp.match(/^ln([a-z]+?)(\d+)?([munp]?)$/);
    if (!m) throw new Error('unrecognised hrp ' + hrp);
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

  /* ----------------------------------------------------- BOLT12 (offers) -- */
  function readBigSize(u8, i) {
    if (i >= u8.length) return null;
    var b = u8[i], v, j;
    if (b < 0xfd) return { value: b, next: i + 1 };
    if (b === 0xfd) {
      if (i + 2 >= u8.length) throw new Error('truncated bigsize');
      return { value: (u8[i + 1] << 8) | u8[i + 2], next: i + 3 };
    }
    if (b === 0xfe) {
      if (i + 4 >= u8.length) throw new Error('truncated bigsize');
      return { value: ((u8[i + 1] << 24) >>> 0) + (u8[i + 2] << 16) + (u8[i + 3] << 8) + u8[i + 4], next: i + 5 };
    }
    if (i + 8 >= u8.length) throw new Error('truncated bigsize');
    v = 0n;
    for (j = 1; j <= 8; j++) v = (v << 8n) | BigInt(u8[i + j]);
    return { value: Number(v), next: i + 9 };
  }
  /* BOLT12 uses bech32 without a checksum; the payload is a TLV stream in 5-bit groups. */
  /* BOLT12 offer TLV types (draft). Shown with their numbers so an unfamiliar
     field is never silently renamed. */
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
    /* offer_amount / absolute_expiry / quantity_max are big-endian tu64 —
       the TLV *length* is BigSize, the value itself is not. */
    function beUint(u8) {
      var v = 0n, i;
      for (i = 0; i < u8.length; i++) v = (v << 8n) | BigInt(u8[i]);
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
      amount: num(8),           // offer_amount
      currency: txt(6),         // offer_currency
      description: txt(10),     // offer_description
      issuer: txt(18),          // offer_issuer
      absoluteExpiry: num(14),  // offer_absolute_expiry
      nodeId: fields[22] ? hexOf(fields[22]) : null,
      quantityMax: num(20),
      types: order.sort(function (a, b) { return a - b; }).map(function (t) {
        return t + (OFFER_TYPES[t] ? ' ' + OFFER_TYPES[t] : '');
      })
    };
  }

  /* ---------------------------------------------------------- calldata --- */
  function pad64(hex) { return ('0'.repeat(64) + hex).slice(-64); }
  function encU256(v) { return pad64(BigInt(v).toString(16)); }
  function encAddr(a) { return pad64(String(a).toLowerCase().replace(/^0x/, '')); }
  function encB32(h) { return pad64(String(h).toLowerCase().replace(/^0x/, '')); }
  function nextCalldata() {
    if (!S.H || !S.id) return '';
    if (S.phase === 'offer' || (S.phase === 'half' && !S.lockT)) {
      return '0x' + SEL.lock + encB32(S.H) + encU256(S.t2) + encAddr(EVM.maker) + encAddr(tokenAddr()) + encU256(units() || 1);
    }
    if (S.phase === 'both') return '0x' + SEL.claim + encB32(S.id) + encB32(S.R || '');
    if (S.phase === 'expired') return '0x' + SEL.refund + encB32(S.id);
    return '0x' + SEL.claim + encB32(S.id) + encB32(S.R || '');
  }

  /* ------------------------------------------------------------- render --- */
  var HEADLINE = {
    idle: ['얼마를 교환할까요?', ''],
    offer: ['비트코인을 잠가 주세요', ''],
    half: ['상대방 USDT를 기다리는 중', ''],
    both: ['잠금 완료, 교환할 수 있어요', 'ready'],
    settled: ['교환 완료!', 'done'],
    expired: ['시간이 초과됐어요', 'warn'],
    refunded: ['환불 완료', 'warn']
  };
  function makerBadge() {
    if (S.phase === 'settled') return { on: true, txt: '교환 완료' };
    if (S.lockM) return { on: true, txt: '잠금 완료' };
    if (S.phase === 'expired') return { on: false, txt: '만료' };
    if (S.phase === 'refunded') return { on: false, txt: '환불됨' };
    return { on: false, txt: '대기 중' };
  }
  function takerBadge() {
    if (S.phase === 'settled') return { on: true, txt: '교환 완료' };
    if (S.phase === 'refunded') return { on: false, txt: '환불됨' };
    if (S.phase === 'expired') return { on: false, txt: '만료' };
    if (S.lockT) return { on: true, txt: '잠금 완료' };
    return { on: false, txt: '대기 중' };
  }

  function render() {
    var p = S.phase, h = HEADLINE[p] || HEADLINE.idle;
    document.body.dataset.phase = p;
    document.body.dataset.mode = S.mode;

    $('statusTxt').textContent = h[0];
    $('statusTxt').className = 'headline' + (h[1] ? ' ' + h[1] : '');
    $('note').textContent = S.mode === 'practice'
      ? '연습 모드 · 실제 자금이 오가지 않아요'
      : '지갑 모드 · 요청서를 지갑으로 넘겨 실제로 결제·수령할 수 있어요';
    $('modeBtn').textContent = S.mode === 'practice' ? '연습 모드' : '지갑 모드';
    $('modeBtn').className = 'mode' + (S.mode === 'wallet' ? ' live' : '');

    $('makerAmt').textContent = fmt(S.sats);
    $('takerAmt').textContent = usdtTxt();
    $('makerSub').textContent = '≈ ' + usdtTxt() + ' USDT';
    $('takerSub').textContent = p === 'settled' ? '교환 완료 · AQUA 지갑으로 받았어요'
      : p === 'refunded' ? '환불 완료 · 잠금이 풀렸어요'
        : p === 'expired' ? '만료 · 환불할 수 있어요'
          : S.lockT ? '잠금 완료 · ' + leftTxt() + ' 뒤 환불 가능'
            : 'Liquid · AQUA 지갑';

    var bm = makerBadge(), bt = takerBadge();
    $('chipMaker').className = 'chip' + (bm.on ? ' on' : '');
    $('chipMakerTxt').textContent = bm.txt;
    $('chipTaker').className = 'chip' + (bt.on ? ' on' : '');
    $('chipTakerTxt').textContent = bt.txt;

    $('rateDot').className = 'dot ' + (S.pstate === 'live' ? 'live' : S.pstate === 'offline' ? 'off' : '');
    $('rateTxt').textContent = S.price ? '1 BTC ≈ ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC ≈ — USDT';

    $('vH').textContent = S.H || '—';
    $('vR').textContent = !S.R ? '—'
      : p === 'settled' ? S.R
        : '0x' + '•'.repeat(8) + S.R.slice(-8) + (p === 'refunded' ? ' (공개되지 않음)' : ' (교환 전에는 숨김)');
    $('vT1').textContent = S.t1 ? 'height ' + fmt(S.t1) + ' (약 6.7시간)' : '—';
    $('vT2').textContent = S.t2 ? 'unix ' + S.t2 + ' · ' + leftTxt() : '—';
    $('vId').textContent = S.id || '—';
    $('vRate').textContent = S.pstate === 'live'
      ? 'BTC $' + fmt(Math.round(S.price)) + ' · mempool.space'
      : S.pstate === 'offline' ? 'mempool.space 응답 없음 · 임시 $90,000' : '불러오는 중…';
    $('calldata').textContent = nextCalldata() ? short(nextCalldata(), 16) : '—';
    $('vRequest').textContent = liquidRequest() || '—';

    $('presets').className = 'presets' + (p === 'idle' ? '' : ' hide');
    Array.prototype.forEach.call($('presets').children, function (b) {
      b.className = Number(b.dataset.v) === S.sats ? 'on' : '';
    });

    var link = S.li ? 'lightning:' + S.li : '#dTech';
    $('openWallet').setAttribute('href', link);
    $('openWalletDeep').setAttribute('href', S.li ? link : '#');
    $('weblnInfo').textContent = S.webln ? S.webln.node : 'not connected';
    $('nwcInfo').textContent = S.nwc ? S.nwc.relay + ' · ' + short(S.nwc.pubkey, 4) : '—';

    renderBar();
    renderLog();
  }

  function renderBar() {
    var p = S.phase, pa = 'create', pt = '교환 시작하기', aa = null, at = '', ba = null, bt = '';
    if (p === 'idle') {
      pa = 'create'; pt = '교환 시작하기';
    } else if (p === 'offer') {
      pa = 'lockMaker'; pt = '1. 내 비트코인 잠그기';
      ba = 'reset'; bt = '처음부터';
    } else if (p === 'half') {
      pa = 'lockTaker'; pt = '2. 상대 USDT 잠금 확인';
      aa = 'advance'; at = '시간 초과 환불 테스트';
      ba = 'reset'; bt = '처음부터';
    } else if (p === 'both') {
      pa = 'claim'; pt = '3. 동시 교환 완료!';
      aa = 'advance'; at = '시간 초과 환불 테스트';
      ba = 'reset'; bt = '처음부터';
    } else if (p === 'expired') {
      pa = 'refund'; pt = '환불 받기';
      ba = 'reset'; bt = '처음부터';
    } else {
      pa = 'reset'; pt = '새로 시작하기';
      aa = 'copyReceipt'; at = '영수증 복사';
    }
    setBtn($('primary'), pa, pt);
    setBtn($('ghostA'), aa, at);
    setBtn($('ghostB'), ba, bt);
  }
  function setBtn(el, act, txt) {
    if (!act) { el.style.display = 'none'; el.dataset.act = ''; return; }
    el.style.display = '';
    el.dataset.act = act;
    el.textContent = txt;
  }

  function renderLog() {
    var ol = $('log');
    ol.innerHTML = '';
    if (!S.log.length) {
      var li = document.createElement('li');
      li.innerHTML = '<time>--:--:--</time><b>IDLE</b><span>아직 기록이 없어요</span>';
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

  function liquidRequest() {
    if (!S.liquid) return '';
    return 'liquidnetwork:' + S.liquid + '?amount=' + (usdtOf() || 0).toFixed(2);
  }

  /* --------------------------------------------------------------- QR --- */
  function showQr(boxId, payload, caption) {
    var box = $(boxId);
    if (!payload) { box.innerHTML = ''; toast('먼저 주소나 요청을 준비해 주세요'); return; }
    var bytes = new TextEncoder().encode(payload).length;
    if (bytes > QR_MAX) {
      box.innerHTML = '<p class="hint">QR로 담기엔 요청이 너무 길어요. ‘지갑 앱으로 열기’나 복사를 써 주세요.</p>';
      return;
    }
    try {
      box.innerHTML = window.QR.svg(payload, { level: 'M', quiet: 2 }) + (caption ? '<p class="hint" style="margin-top:8px">' + caption + '</p>' : '');
    } catch (e) {
      box.innerHTML = '<p class="hint">QR을 만들 수 없어요: ' + e.message + '</p>';
    }
  }

  /* ------------------------------------------------------------ actions -- */
  var ACT = {
    mode: function () {
      S.mode = S.mode === 'practice' ? 'wallet' : 'practice';
      render();
    },

    sats: function (b) {
      if (S.phase !== 'idle') return;
      S.sats = Number(b.dataset.v);
      render();
    },

    create: function () {
      if (S.phase !== 'idle') { toast('진행 중인 교환이 있어요'); return; }
      var R = rndHex(32);
      sha256Hex(R).then(function (H) {
        S.R = '0x' + R;
        S.H = '0x' + H;
        S.t2 = nowSec() + 3600;
        S.t1 = S.h0 + 40;
        S.lockM = false; S.lockT = false;
        log('OFFER', '비밀값 R 생성 · H = SHA256(R)');
        return computeSwapId(S.H, EVM.taker, EVM.maker, tokenAddr(), units(), S.t2);
      }).then(function (id) {
        S.id = id;
        S.phase = 'offer';
        log('HASH', 'H ' + short(S.H, 8));
        log('TIMELOCK', 'T1 ' + fmt(S.t1) + ' 블록 > T2 +1시간');
        render();
        toast('교환 준비 완료');
      }).catch(function (e) {
        log('FAIL', 'SHA-256: ' + e.message, 'c-err');
        render();
        toast('SHA-256을 쓸 수 없어요');
      });
    },

    lockMaker: function () {
      if (S.phase !== 'offer' && S.phase !== 'half') return;
      if (S.lockM) { toast('이미 잠겼어요'); return; }
      S.lockM = true;
      S.phase = S.lockT ? 'both' : 'half';
      log('LOCK', '비트코인 잠금 · ' + fmt(S.sats) + ' sats · T1 ' + fmt(S.t1));
      if (S.mode === 'wallet' && S.li) log('WALLET', '결제 요청을 지갑으로 넘길 수 있어요');
      render();
      toast('비트코인을 잠갔어요');
    },

    lockTaker: function () {
      if (S.phase !== 'offer' && S.phase !== 'half') return;
      if (S.lockT) { toast('이미 잠겼어요'); return; }
      S.lockT = true;
      S.phase = S.lockM ? 'both' : 'half';
      log('LOCK', 'USDT 잠금 · ' + usdtTxt() + ' USDT · T2 +1시간');
      if (S.phase === 'both') log('READY', '양쪽 잠금 완료 · 교환 가능');
      render();
      toast('USDT 잠금을 확인했어요');
    },

    claim: function () {
      if (S.phase !== 'both') { toast('양쪽 잠금이 먼저예요'); return; }
      if (!S.R) { toast('비밀값은 상대가 쥐고 있어요'); return; }
      sha256Hex(S.R).then(function (h) {
        if ('0x' + h !== S.H) {
          log('FAIL', 'SHA256(R)이 H와 달라요', 'c-err');
          render(); toast('해시가 맞지 않아 중단했어요');
          return;
        }
        log('CHECK', 'SHA256(R) == H ✓');
        log('CLAIM', '청구 · ' + usdtTxt() + ' USDT → 비트코인 판매자');
        log('REVEAL', '비밀값 R 공개 ' + short(S.R, 6));
        log('LN', '같은 R로 라이트닝 잠금도 정산');
        S.phase = 'settled';
        render();
        toast('교환 완료!');
      });
    },

    advance: function () {
      if (S.phase === 'idle' || S.phase === 'settled' || S.phase === 'refunded') return;
      S.sim += 3700;
      log('CLOCK', '+1시간 1분 · T2 ' + leftTxt());
      if (S.t2 && nowSec() >= S.t2 && S.phase !== 'expired') {
        S.phase = 'expired';
        log('TIMEOUT', 'T2 경과 · 청구 닫힘, 환불 열림', 'c-warn');
      }
      render();
      if (S.phase === 'expired') toast('시간 초과 · 환불할 수 있어요');
    },

    refund: function () {
      if (S.phase !== 'expired') return;
      S.phase = 'refunded';
      log('REFUND', '환불 · ' + usdtTxt() + ' USDT → USDT 보유자');
      log('VOID', '비밀값은 공개되지 않은 채 잠금이 만료됐어요', 'c-warn');
      render();
      toast('환불 완료');
    },

    reset: function () {
      S.phase = 'idle'; S.H = null; S.R = null; S.id = null;
      S.lockM = false; S.lockT = false; S.sim = 0; S.t1 = null; S.t2 = null;
      log('NEW', '새 교환을 시작했어요');
      render();
    },

    copyReceipt: function () { copy(JSON.stringify(payload(), null, 2), '영수증'); },

    evm: function () { /* kept for API compatibility */ },

    webln: function () {
      if (!window.webln) { toast('WebLN 지갑을 찾을 수 없어요'); log('FAIL', 'window.webln 없음', 'c-err'); render(); return; }
      Promise.resolve(window.webln.enable())
        .then(function () { return window.webln.getInfo ? window.webln.getInfo() : {}; })
        .then(function (info) {
          S.webln = { node: (info && info.node && info.node.alias) || 'webln' };
          log('WEBLN', '노드 ' + S.webln.node + ' 연결');
          render(); toast('WebLN 연결됐어요');
        })
        .catch(function (e) { toast(e && e.message ? e.message : 'WebLN 연결이 거부됐어요'); });
    },

    nwc: function () {
      var uri = ($('nwcInput').value || '').trim();
      if (!uri) { toast('NWC URI를 붙여넣어 주세요'); return; }
      try {
        var m = uri.match(/^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\??(.*)$/);
        if (!m) throw new Error('형식이 올바르지 않아요');
        var params = {};
        (m[2] || '').split('&').forEach(function (kv) {
          if (!kv) return;
          var i = kv.indexOf('=');
          params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        });
        if (!params.relay) throw new Error('relay 파라미터가 없어요');
        S.nwc = { pubkey: m[1], relay: params.relay, secret: params.secret ? 'set' : 'none', lud16: params.lud16 || '' };
        log('NWC', '지갑 공개키 ' + short(m[1], 4) + ' · ' + params.relay);
        render(); toast('NWC를 읽었어요 (소켓은 열지 않음)');
      } catch (e) {
        log('FAIL', 'NWC: ' + e.message, 'c-err');
        render(); toast(e.message);
      }
    },

    decode: function () {
      var raw = ($('invoice').value || '').trim().replace(/^lightning:/i, '');
      if (!raw) { toast('결제 요청을 붙여넣어 주세요'); return; }
      try {
        var d = /^lno1/i.test(raw) ? decodeBolt12(raw) : decodeBolt11(raw);
        S.req = d;
        S.li = raw;
        var rows = '';
        if (d.kind === 'bolt11') {
          var match = S.H && d.paymentHash && d.paymentHash.toLowerCase() === S.H.toLowerCase();
          rows = row('종류', 'BOLT11 인보이스') +
            row('payment_hash', d.paymentHash || '없음') +
            row('금액', d.sats == null ? '지정 없음' : fmt(d.sats) + ' sats') +
            row('네트워크', d.network) +
            row('만료', d.expiry == null ? '기본 3600초' : d.expiry + '초') +
            row('H 일치', match ? '일치 ✓' : '아직 맞지 않음');
          log('BOLT11', 'payment_hash ' + short(d.paymentHash, 6) + (match ? ' == H ✓' : ''));
        } else {
          rows = row('종류', 'BOLT12 오퍼') +
            row('설명', d.description || '없음') +
            row('금액', d.amount == null ? '지정 없음' : fmt(d.amount) + ' ' + (d.currency || 'msat')) +
            row('발급자', d.issuer || '없음') +
            row('노드', d.nodeId ? short('0x' + d.nodeId, 6) : '없음') +
            row('만료', d.absoluteExpiry ? new Date(d.absoluteExpiry * 1000).toISOString().slice(0, 10) : '없음') +
            row('payment_hash', '없음 (오퍼)');
          log('BOLT12', '오퍼 디코드 · ' + (d.description || '설명 없음'));
        }
        $('decodeOut').innerHTML = rows;
        render();
        toast(d.kind === 'bolt11' ? '인보이스를 읽었어요' : '오퍼를 읽었어요');
      } catch (e) {
        $('decodeOut').innerHTML = row('오류', e.message);
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

    useHash: function () {
      if (S.phase !== 'idle') { toast('먼저 처음부터로 되돌려 주세요'); return; }
      if (!S.req || !S.req.paymentHash) { toast('BOLT11 인보이스를 먼저 읽어 주세요'); return; }
      S.H = S.req.paymentHash;
      S.R = null;
      S.t2 = nowSec() + 3600;
      S.t1 = S.h0 + 40;
      log('JOIN', '인보이스 H로 합류 · R은 지불하는 쪽이 쥡니다');
      computeSwapId(S.H, EVM.taker, EVM.maker, tokenAddr(), units(), S.t2).then(function (id) {
        S.id = id; S.phase = 'offer'; render(); toast('인보이스 기준으로 시작했어요');
      });
    },

    copyUri: function () {
      if (!S.li) { toast('결제 요청이 없어요'); return; }
      copy('lightning:' + S.li, '결제 요청');
    },
    qrUri: function () { showQr('qrUriBox', S.li ? 'lightning:' + S.li : '', '지갑 앱으로 스캔하세요'); },

    copyAddr: function () { copy(S.liquid, '주소를 '); },
    copyReq: function () { copy(liquidRequest(), '결제 요청을 '); },
    qrAddr: function () { showQr('qrAddrBox', liquidRequest(), 'AQUA·Liquid 지갑으로 스캔하세요'); },

    copyData: function () {
      var d = nextCalldata();
      if (!d) { toast('아직 준비된 호출이 없어요'); return; }
      copy(d, 'calldata를 ');
    },
    copyPayload: function () { copy(JSON.stringify(payload(), null, 2), 'payload를 '); },
    copySol: function () { copy($('sol-source').textContent.trim(), '소스를 '); }
  };

  function row(k, v) {
    return '<div><span class="k">' + k + '</span><span class="v mono">' + String(v).replace(/[<>&]/g, '') + '</span></div>';
  }

  function payload() {
    var out = {
      protocol: 'ln-usdt-htlc/1',
      mode: S.mode,
      hashlock: S.H,
      sats: S.sats,
      usdt: usdtOf() || null,
      liquid: S.liquid || null,
      htlc: htlcAddr() || null,
      token: tokenAddr(),
      timelock: S.t2,
      swapId: S.id,
      request: S.req ? { kind: S.req.kind, paymentHash: S.req.paymentHash, sats: S.req.sats, description: S.req.description } : null,
      calldata: nextCalldata() || null
    };
    if (S.phase === 'settled' || S.phase === 'refunded') out.preimage = S.R;
    return out;
  }

  /* ------------------------------------------------------- tick + price -- */
  function tick() {
    if (!S.t2) return;
    if (['offer', 'half', 'both'].indexOf(S.phase) >= 0 && nowSec() >= S.t2) {
      S.phase = 'expired';
      log('TIMEOUT', 'T2 경과 · 청구 닫힘, 환불 열림', 'c-warn');
      render();
      return;
    }
    $('vT2').textContent = 'unix ' + S.t2 + ' · ' + leftTxt();
    if (S.lockT && S.phase !== 'settled' && S.phase !== 'refunded') {
      $('takerSub').textContent = '잠금 완료 · ' + leftTxt() + ' 뒤 환불 가능';
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
  $('liquidAddr').addEventListener('input', function () {
    S.liquid = this.value.trim();
    $('vRequest').textContent = liquidRequest() || '—';
  });

  $('solSrc').textContent = $('sol-source').textContent.trim();
  $('tokenAddr').value = S.token;
  render();
  setInterval(tick, 1000);
  loadRate();

  window.EMERALD = {
    state: S, SEL: SEL, EVM: EVM, QR_MAX: QR_MAX,
    sha256Hex: sha256Hex, computeSwapId: computeSwapId,
    bech32Decode: bech32Decode, decodeBolt11: decodeBolt11, decodeBolt12: decodeBolt12,
    nextCalldata: nextCalldata, payload: payload, render: render, liquidRequest: liquidRequest
  };
})();
