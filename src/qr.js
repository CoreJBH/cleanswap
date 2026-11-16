/* Minimal QR encoder — byte mode, error correction L/M/Q/H, versions 1..13.
   No dependencies, ~250 lines. Byte mode + level M is what the offer and
   invoice panels need; other versions exist so the panels never overflow.

   Structural check: test/headless.js compares every module of every mask
   against python-qrcode for several payload lengths, so the Reed-Solomon
   blocks, interleaving, placement, mask and format/version bits all have to
   agree with an independent implementation. */
(function (global) {
  'use strict';

  var EC = { L: 1, M: 0, Q: 3, H: 2 };            // format-info EC bits
  var ECU = { L: 0, M: 1, Q: 2, H: 3 };            // index into the tables below
  /* tables[level][version] = [ecCodewordsPerBlock, [[numBlocks, dataCodewords], ...]] */
  var TABLES = {
    0: { /* L */
      1: [7, [[1, 19]]], 2: [10, [[1, 34]]], 3: [15, [[1, 55]]], 4: [20, [[1, 80]]],
      5: [26, [[1, 108]]], 6: [18, [[2, 68]]], 7: [20, [[2, 78]]], 8: [24, [[2, 97]]],
      9: [30, [[2, 116]]], 10: [18, [[2, 68], [2, 69]]],
      11: [20, [[4, 81]]], 12: [24, [[2, 92], [2, 93]]], 13: [26, [[4, 107]]]
    },
    1: { /* M */
      1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
      5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
      9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
      11: [30, [[1, 50], [4, 51]]], 12: [22, [[6, 36], [2, 37]]], 13: [28, [[8, 37], [1, 38]]]
    },
    2: { /* Q */
      1: [13, [[1, 13]]], 2: [22, [[1, 22]]], 3: [18, [[2, 17]]], 4: [26, [[2, 24]]],
      5: [18, [[2, 15], [2, 16]]], 6: [24, [[4, 19]]], 7: [18, [[2, 14], [4, 15]]],
      8: [22, [[4, 18], [2, 19]]], 9: [20, [[4, 16], [4, 17]]], 10: [24, [[6, 19], [2, 20]]],
      11: [28, [[4, 22], [4, 23]]], 12: [26, [[4, 20], [6, 21]]], 13: [26, [[8, 20], [4, 21]]]
    },
    3: { /* H */
      1: [17, [[1, 9]]], 2: [28, [[1, 16]]], 3: [22, [[2, 13]]], 4: [16, [[4, 9]]],
      5: [22, [[2, 11], [2, 12]]], 6: [28, [[4, 15]]], 7: [26, [[4, 13], [1, 14]]],
      8: [26, [[4, 14], [2, 15]]], 9: [24, [[4, 12], [4, 13]]], 10: [28, [[6, 15], [2, 16]]],
      11: [24, [[3, 12], [8, 13]]], 12: [28, [[7, 14], [4, 15]]], 13: [24, [[12, 11], [4, 12]]]
    }
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62]
  };

  /* ---- GF(256), primitive polynomial 0x11d ---- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGen(deg) {
    var poly = [1], i, j, a, next;
    for (i = 0; i < deg; i++) {
      a = EXP[i];
      next = [];
      for (j = 0; j < poly.length + 1; j++) next.push(0);
      for (j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= mul(poly[j], a); }
      poly = next;
    }
    return poly;
  }
  function rsRem(data, deg) {
    var gen = rsGen(deg), rem = [], i, j, factor;
    for (i = 0; i < deg; i++) rem.push(0);
    for (i = 0; i < data.length; i++) {
      factor = data[i] ^ rem[0];
      rem.shift(); rem.push(0);
      if (factor !== 0) for (j = 0; j < deg; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
  }

  function spec(level, version) {
    var t = TABLES[ECU[level]] && TABLES[ECU[level]][version];
    if (!t) throw new Error('QR: no table for ' + level + version);
    return t;
  }
  function dataCapacity(level, version) {
    var blocks = spec(level, version)[1], sum = 0, i;
    for (i = 0; i < blocks.length; i++) sum += blocks[i][0] * blocks[i][1];
    return sum;
  }

  function pushBits(arr, val, n) {
    for (var i = n - 1; i >= 0; i--) arr.push((val >>> i) & 1);
  }

  function dataWords(bytes, level, version) {
    var cap = dataCapacity(level, version), bits = [], i, j;
    pushBits(bits, 4, 4);                                     // byte mode
    pushBits(bits, bytes.length, version < 10 ? 8 : 16);      // char count
    for (i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
    var maxBits = cap * 8;
    pushBits(bits, 0, Math.min(4, maxBits - bits.length));     // terminator
    while (bits.length % 8) bits.push(0);
    var words = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      words.push(b);
    }
    for (i = 0; words.length < cap; i++) words.push(i % 2 ? 0x11 : 0xEC);
    return words;
  }

  function codewords(bytes, level, version) {
    var t = spec(level, version), ecLen = t[0], blocks = t[1];
    var words = dataWords(bytes, level, version), out = [], chunks = [], i, j, k, off = 0, maxLen = 0;
    for (i = 0; i < blocks.length; i++) {
      for (k = 0; k < blocks[i][0]; k++) {
        var d = words.slice(off, off + blocks[i][1]);
        off += blocks[i][1];
        chunks.push({ d: d, e: rsRem(d, ecLen) });
      }
    }
    for (i = 0; i < chunks.length; i++) maxLen = Math.max(maxLen, chunks[i].d.length);
    for (j = 0; j < maxLen; j++) for (i = 0; i < chunks.length; i++) if (j < chunks[i].d.length) out.push(chunks[i].d[j]);
    for (j = 0; j < ecLen; j++) for (i = 0; i < chunks.length; i++) out.push(chunks[i].e[j]);
    return out;
  }

  function bitLen(n) { var c = 0; while (n) { c++; n = Math.floor(n / 2); } return c; }
  function formatBits(level, mask) {
    var d = (EC[level] << 3) | mask, v = d << 10;
    while (bitLen(v) >= 11) v ^= 0x537 << (bitLen(v) - 11);
    return ((d << 10) | v) ^ 0x5412;
  }
  function versionBits(version) {
    var x = version << 12;
    while (bitLen(x) >= 13) x ^= 0x1f25 << (bitLen(x) - 13);
    return (version << 12) | x;
  }

  function maskAt(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function build(version, level, words, mask) {
    var size = version * 4 + 17, m = [], fn = [], r, c, i, j;
    for (r = 0; r < size; r++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(x, y, dark) { m[y][x] = !!dark; fn[y][x] = true; }

    // finders + separators
    var corners = [[3, 3], [size - 4, 3], [3, size - 4]];
    for (i = 0; i < corners.length; i++) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var x = corners[i][0] + dx, y = corners[i][1] + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, dist <= 3 && dist !== 2);
        }
      }
    }
    // alignment patterns
    var pos = ALIGN[version] || [];
    for (i = 0; i < pos.length; i++) {
      for (j = 0; j < pos.length; j++) {
        var cx = pos[j], cy = pos[i];
        if (fn[cy][cx]) continue;
        for (dy = -2; dy <= 2; dy++) {
          for (dx = -2; dx <= 2; dx++) {
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    // timing patterns
    for (i = 0; i < size; i++) {
      if (!fn[6][i]) set(i, 6, i % 2 === 0);
      if (!fn[i][6]) set(6, i, i % 2 === 0);
    }
    // reserve format-info areas
    for (i = 0; i < 9; i++) { if (!fn[i][8]) set(8, i, false); if (!fn[8][i]) set(i, 8, false); }
    for (i = 0; i < 8; i++) if (!fn[8][size - 1 - i]) set(size - 1 - i, 8, false);
    for (i = 0; i < 7; i++) if (!fn[size - 1 - i][8]) set(8, size - 1 - i, false);
    if (!fn[size - 8][8]) set(8, size - 8, false); // dark module (row size-8, col 8)
    // reserve version-info areas
    if (version >= 7) {
      for (i = 0; i < 18; i++) {
        var a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, false);
        set(b, a, false);
      }
    }

    // data bits, zigzag from the bottom-right
    var bits = [];
    for (i = 0; i < words.length; i++) pushBits(bits, words[i], 8);
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (j = 0; j < 2; j++) {
          x = right - j;
          var upward = ((right + 1) & 2) === 0;
          y = upward ? size - 1 - vert : vert;
          if (!fn[y][x]) {
            if (build.trace) build.trace.push([y, x]);
            m[y][x] = idx < bits.length ? bits[idx] === 1 : false;
            idx += 1;
          }
        }
      }
    }

    // mask
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (!fn[y][x] && maskAt(mask, x, y)) m[y][x] = !m[y][x];

    // format info (two copies), dark module
    var fb = formatBits(level, mask);
    function bit(v, n) { return ((v >>> n) & 1) === 1; }
    for (i = 0; i <= 5; i++) set(8, i, bit(fb, i));
    set(8, 7, bit(fb, 6));
    set(8, 8, bit(fb, 7));
    set(7, 8, bit(fb, 8));
    for (i = 9; i < 15; i++) set(14 - i, 8, bit(fb, i));
    for (i = 0; i < 8; i++) set(size - 1 - i, 8, bit(fb, i));
    for (i = 8; i < 15; i++) set(8, size - 15 + i, bit(fb, i));
    set(8, size - 8, true);

    if (version >= 7) {
      var vb = versionBits(version);
      for (i = 0; i < 18; i++) {
        var bitv = bit(vb, i), ax = size - 11 + (i % 3), ay = Math.floor(i / 3);
        set(ax, ay, bitv);
        set(ay, ax, bitv);
      }
    }
    build.lastFn = fn;
    return { size: size, modules: m };
  }

  function penalty(size, m) {
    var p = 0, x, y, i, j, run, prev;
    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) run++;
        else { if (run >= 5) p += 3 + run - 5; run = 1; }
      }
      if (run >= 5) p += 3 + run - 5;
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) run++;
        else { if (run >= 5) p += 3 + run - 5; run = 1; }
      }
      if (run >= 5) p += 3 + run - 5;
    }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        prev = m[y][x];
        if (prev === m[y][x + 1] && prev === m[y + 1][x] && prev === m[y + 1][x + 1]) p += 3;
      }
    }
    var p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function hit(get, start, pat) {
      for (var k = 0; k < 11; k++) if ((get(start + k) ? 1 : 0) !== pat[k]) return false;
      return true;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x + 11 <= size; x++) {
        if (hit(function (i) { return m[y][i]; }, x, p1) || hit(function (i) { return m[y][i]; }, x, p2)) p += 40;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y + 11 <= size; y++) {
        if (hit(function (i) { return m[i][x]; }, y, p1) || hit(function (i) { return m[i][x]; }, y, p2)) p += 40;
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return p;
  }

  function utf8(text) {
    if (global.TextEncoder) return Array.prototype.slice.call(new global.TextEncoder().encode(String(text)));
    var out = [], s = unescape(encodeURIComponent(String(text))), i;
    for (i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function fitVersion(level, byteLen) {
    for (var v = 1; v <= 13; v++) {
      var cc = v < 10 ? 8 : 16;
      if (4 + cc + byteLen * 8 <= dataCapacity(level, v) * 8) return v;
    }
    throw new Error('QR: payload too long (' + byteLen + ' bytes)');
  }

  function encode(text, opts) {
    opts = opts || {};
    var level = opts.level || 'M';
    var bytes = utf8(text);
    var version = opts.version || fitVersion(level, bytes.length);
    var words = codewords(bytes, level, version);
    if (typeof opts.mask === 'number') {
      build.trace = [];
      var fixed = build(version, level, words, opts.mask);
      var t = build.trace; build.trace = null;
      return { version: version, level: level, mask: opts.mask, size: fixed.size, modules: fixed.modules, trace: t };
    }
    var best = null, bestMask = 0, bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var q = build(version, level, words, mask);
      var pen = penalty(q.size, q.modules);
      if (pen < bestPenalty) { bestPenalty = pen; best = q; bestMask = mask; }
    }
    return { version: version, level: level, mask: bestMask, size: best.size, modules: best.modules };
  }

  function svg(text, opts) {
    opts = opts || {};
    var q = encode(text, opts), quiet = opts.quiet == null ? 2 : opts.quiet;
    var dim = q.size + quiet * 2, path = [], y, x;
    for (y = 0; y < q.size; y++) {
      for (x = 0; x < q.size; x++) {
        if (q.modules[y][x]) path.push('M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR">' +
      '<!-- ' + q.version + '-' + q.level + ' mask ' + q.mask + ' -->' +
      '<path d="' + path.join('') + '" fill="#040e09"/></svg>';
  }

  global.QR = { lastFn: function () { return build.lastFn; }, encode: encode, svg: svg, formatBits: formatBits, versionBits: versionBits, _codewords: codewords, _dataWords: dataWords, _fitVersion: fitVersion };
})(typeof window !== 'undefined' ? window : this);
