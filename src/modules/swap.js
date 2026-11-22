  /* swap.js - escrow calldata, the swap code and the inputs it is read from */
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
    if (!isFinite(S.price) || !(S.price > 0) || !rateKnown()) return null;
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
    return S.mode === 'wallet' && !rateKnown();
  }
  function rateError() {
    var e = new Error('no live price, so nothing is locked at a guess');
    if (S.pstate === 'disagree') e.quoteDisagrees = true;
    else e.noQuote = true;
    return e;
  }
  /* A tap with no live quote says so and asks for the quote again: the page
     reads the price once at boot, and a phone that was offline then must not
     be left with a guess for the rest of the session. Two quotes that disagree
     are not asked for again - the next tap may find them agreed - but the
     sentence says which of the two happened. */
  function refuseRate() {
    var split = S.pstate === 'disagree';
    log('BLOCK', split
      ? 'a wallet swap was refused while the two price quotes disagreed'
      : 'a wallet swap was refused while the price was the offline guess', 'c-err');
    toast(split
      ? 'Two price sources disagree about the BTC price, so no amount is priced from them. Nothing was sent: reading the price again now.'
      : 'The live BTC price has not arrived, so a swap would lock USDT at a guessed amount. Nothing was sent: reading the price again now.');
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

  /* How long the bitcoin side's own payment runs, in seconds, from the moment
     it starts: the payee's final delta, which is the minimum its node keeps the
     incoming payment, plus the few blocks of routing margin above. */
  function lnHtlcSpan(dec) {
    if (!dec || dec.kind !== 'bolt11') return null;
    var blocks = (dec.minFinalCltv == null ? LN_CLTV_DEFAULT : Number(dec.minFinalCltv)) + LN_ROUTE_MARGIN_CLTV;
    if (!isFinite(blocks) || blocks < 0) return null;
    return blocks * BLOCK_SECS;
  }
  /* The earliest the sats could come back: a payment that starts now, over the
     longest route the invoice allows. Every later payment gives a later one, so
     this is the reading a window has to clear. */
  function lnDeadline(dec, now) {
    var span = lnHtlcSpan(dec);
    if (span == null) return null;
    return (now == null ? effNow() : Number(now)) + span;
  }
  /* The two legs, in the order they have to expire: the escrow window closes
     first, the payment after it with room for the side that settles with the
     revealed secret. Empty when the window is not known or the invoice says
     nothing about its own deadline. */
  function lnProblem(dec, t2, now) {
    if (!t2) return '';
    var n = now == null ? effNow() : Number(now);
    var span = lnHtlcSpan(dec);
    if (span == null) return '';
    var room = Number(t2) - n;
    if (span < room + LN_SAFETY_SECS) {
      return 'That invoice keeps the payment open for ' + spanTxt(span) +
        ', and the window closes ' + spanTxt(room) + ' from now: the sats could come back while the USDT is still claimable. Ask for an invoice that stays open an hour past the window.';
    }
    return '';
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
    /* The payment has to outlive the escrow, not the other way round: the
       window closing first is what leaves the bitcoin side time to settle
       with the secret the claim has just published. */
    var ln = lnProblem(dec, t2, now);
    if (ln) return ln;
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
