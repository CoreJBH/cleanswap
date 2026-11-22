  /* crypto.js - secp256k1, bech32 and the BOLT11 / BOLT12 codecs */
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
    var routeHints = [], fallbacks = [], routeCltv = 0;
    (fields.r || []).forEach(function (f) {
      var b = wordsToBytes(f), j, sum = 0;
      for (j = 0; j + 51 <= b.length; j += 51) {
        var hop = {
          nodeId: hexOf(b.subarray(j, j + 33)),
          shortChannelId: hexOf(b.subarray(j + 33, j + 41)),
          baseMsat: beNum(b.subarray(j + 41, j + 45)),
          ppm: beNum(b.subarray(j + 45, j + 49)),
          cltv: beNum(b.subarray(j + 49, j + 51))
        };
        sum += hop.cltv;
        routeHints.push(hop);
      }
      /* What the deepest hint adds to the payment's own deadline: every hop
         holds the HTLC a little longer than the one after it. */
      if (sum > routeCltv) routeCltv = sum;
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
    /* `c` is min_final_cltv_expiry: how many blocks the payee's node keeps the
       incoming payment before letting it come back. It is read here with the
       rest of the terms, and BOLT 11 says a missing tag means 18 blocks - the
       same default its `x` tag has in this decoder, so neither a missing
       expiry nor a missing final delta can be read as "no deadline at all". */
    var minFinalCltv = fields.c && fields.c[0] ? toNum(wordsToInt(fields.c[0]), 'cltv') : LN_CLTV_DEFAULT;
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
      minFinalCltv: minFinalCltv,
      routeCltv: routeCltv,
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
  /* One hop of a route hint, as BOLT 11 packs it: a 33-byte node id, the short
     channel id, the base fee, the proportional fee and the delta. The delta is
     the only field this app reads, so the rest is a shape, not a claim. */
  function routeHintBytes(cltv) {
    var b = new Uint8Array(51), i;
    b[0] = 2;
    for (i = 1; i < 33; i++) b[i] = (i * 7) & 255;
    b[49] = (cltv >> 8) & 255;
    b[50] = cltv & 255;
    return b;
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
      /* The final delta the payee's node asks for (the `c` tag) and the route
         hint a private channel arrives with: both are terms the window check
         reads, so a sample can state them the way a real invoice does. */
      if (o.cltv != null) body = body.concat(tagField('c', intToVec(o.cltv)));
      if (o.hintCltv) body = body.concat(tagField('r', bytesToWords(routeHintBytes(o.hintCltv))));
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
