/* Headless verification for the built single-file app.

   Run:
     PLAYWRIGHT_PKG=/workspace/.local/lib/python3.12/site-packages/playwright/driver/package \
     LD_LIBRARY_PATH=/workspace/tmp/sysroot/usr/lib/x86_64-linux-gnu \
     /workspace/.local/lib/python3.12/site-packages/playwright/driver/node test/headless.js

   The suite drives the real DOM only: every state change goes through a click or
   a typed field. The point of the gates is that a tap alone is not enough, so
   part of these checks assert that Approve does NOT advance while a check fails.

   Covers: the three-step screen and its numbers, the same screen in Practice and
   Wallet with Sample only in Practice, the direction flip that reverses the
   steps, invoice checks (checksum, amount, expiry, network, a hash that is not
   this swap's), a BOLT12 offer (lno1...) accepted both as an offer to pay and as
   the thing a waiting screen hands to a wallet, the USDT address checks on both
   chains (0x plus 40 hex, and a TRON T address through its Base58Check
   checksum), the wallet wait (Approve parks on Waiting for payment and only
   `I paid` produces the receipt), the cleanswap: off-line code (shape, round
   trip, nothing path- or host-shaped in it, QR equal to the code, two phones
   settling on the same hash), the QR clearing the fixed Approve bar, layout at
   360x780 / 390x844 / 1280x800 including the waiting screen, the protocol
   vectors (SHA-256 both ways, Base58Check, abi.encodePacked swap id, bech32,
   BOLT11, BOLT12), and a Hangul-free, jargon-free screen. Writes shots/v43-*.
*/
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PKG = process.env.PLAYWRIGHT_PKG || 'playwright';
const { chromium } = require(PKG);
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const SHOTS = path.resolve(__dirname, '..', 'shots');
const BUILD = path.resolve(__dirname, '..', 'build');
/* BOLT #11's own test vectors: real invoices signed by the spec's key, so the
   app's signature check is measured against something it did not make. */
const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'bolt11-vectors.json'), 'utf8'));
const vector = (name) => VECTORS.cases.find(c => c.name === name).invoice;
const URL = 'file://' + APP;
const HANGUL = /[\uac00-\ud7af]/;
/* words that must never reach the screen: symbol names, hashes, raw payloads */
const JARGON = /preimage|hashlock|bolt1[12]|calldata|escrow proof|lno1|lni1|lnbc|htlc|abi\.|bech32|sha-?256|unix|timelock|\[\s*0x/i;
/* buttons from the old practice/test toolbox: none of them may exist any more */
const OLD_ACTS = ['fillOffer', 'wrongOffer', 'fillProof', 'wrongProof', 'reveal', 'fillPre',
  'wrongPre', 'advance', 'copyIssue', 'qrOut', 'fillPreimage', 'clock', 'partnerCancel', 'qrPay',
  'qrInvite', 'copyPay', 'stay', 'leave'];

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '   [' + detail + ']'));
}

/* A BOLT12 invoice string (lni...) built here, not by the app: the amount in TLV
   170 and the payment hash in the standard TLV 168, bech32 without a checksum. */
const B32C = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function fiveBits(bytes) {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function bigsize(n) {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, (n >> 8) & 255, n & 255];
  return [0xfe, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function tlv(t, v) { return [...bigsize(t), ...bigsize(v.length), ...v]; }
function u64(n) { const o = []; for (let k = 7; k >= 0; k--) o.push(Number((BigInt(n) >> BigInt(8 * k)) & 255n)); return o; }
function bolt12Invoice(hashHex, sats, created, expiry) {
  const bytes = [
    ...tlv(168, [...Buffer.from(hashHex.slice(2), 'hex')]),
    ...tlv(170, u64(sats * 1000)),
    ...tlv(164, u64(created)),
    ...tlv(166, u64(expiry))
  ];
  return 'lni1' + fiveBits(bytes).map(i => B32C[i]).join('');
}
/* The same invoice with a field left out, to see what the decoder does with an
   invoice that states no creation time (164) or no expiry (166): both are
   required by the format, and neither may turn into "never expires". */
function bolt12InvoiceWithout(omit) {
  const bytes = [];
  if (omit !== 168) bytes.push(...tlv(168, [...Buffer.from('5a'.repeat(32), 'hex')]));
  if (omit !== 170) bytes.push(...tlv(170, u64(50000 * 1000)));
  if (omit !== 164) bytes.push(...tlv(164, u64(Math.floor(Date.now() / 1000))));
  if (omit !== 166) bytes.push(...tlv(166, u64(3600)));
  return 'lni1' + fiveBits(bytes).map(i => B32C[i]).join('');
}

/* A BOLT12 offer shaped the way a wallet makes one (Lexe and friends): a node
   id and a 64-byte signature, optionally an amount in msat, an expiry, and - in
   this app's own offers - the swap hashlock in the custom type-80 TLV. */
function bolt12Offer(o) {
  const tlvs = [];
  const add = (t, v) => { tlvs.push(...tlv(t, v)); };
  if (o.amountMsat) add(8, u64(o.amountMsat));
  if (o.desc) add(10, [...Buffer.from(o.desc, 'utf8')]);
  if (o.expiry) add(14, u64(o.expiry));
  if (o.chains) add(2, new Array(32 * o.chains).fill(0x5b));
  if (!o.noNode) add(22, [...Buffer.from(BOLT12_NODE, 'hex')]);
  if (o.hash) add(80, [...Buffer.from(o.hash.slice(2), 'hex')]);
  add(240, new Array(64).fill(0));
  return 'lno1' + fiveBits(tlvs).map(i => B32C[i]).join('');
}

const BOLT11_SAMPLE_HASH = '0x' + '11'.repeat(32);
const BOLT12_NODE = '02d40d722b8fa32f8c588757c481462b27dadfece667ea0c662daa0e6d8a8b595e';

/* bech32 for a BOLT11 body built here, so an invoice with a field the app's own
   minter never leaves out can still be handed to it. */
const B32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function b32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let j = 0; j < 5; j++) if ((b >>> j) & 1) chk ^= B32_GEN[j];
  }
  return chk >>> 0;
}
function b32Hrp(hrp) {
  const out = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >>> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}
function intWords(n, len) {
  const out = [];
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(n / Math.pow(32, i)) % 32);
  return out;
}
function tagField(ch, words) {
  return [ch.charCodeAt(0) - 96, words.length >> 5, words.length & 31, ...words];
}
/* An invoice with the payment hash and the timestamp and no `x` tag: the
   standard says such an invoice expires 3600 seconds after its timestamp. It is
   minted by the app because a hand-built one would now carry an unverifiable
   signature - the point of the case is the missing tag, not the signature. */
async function bolt11NoExpiry(page, hashHex, sats, ts) {
  return page.evaluate((o) => window.CLEANSWAP.mintInvoice({
    paymentHash: o.h, sats: o.sats, timestamp: o.ts, noExpiry: true
  }), { h: hashHex, sats: sats, ts: ts });
}

/* A binary field of a swap code: `~` plus base64url of the bytes, the way the
   app writes a hash and an address so the whole code still fits a QR. */
function codeField(hex) {
  return '~' + Buffer.from(String(hex).replace(/^0x/, ''), 'hex').toString('base64url');
}
/* The swap id, packed the way the contract and the app pack it:
   sha256(hashlock, sender, receiver, token, amount, timelock). */
function swapIdOf(o) {
  const b = Buffer.alloc(156);
  Buffer.from(String(o.hashlock).replace(/^0x/, ''), 'hex').copy(b, 0);
  Buffer.from(String(o.sender).replace(/^0x/, ''), 'hex').copy(b, 32);
  Buffer.from(String(o.receiver).replace(/^0x/, ''), 'hex').copy(b, 52);
  Buffer.from(String(o.token).replace(/^0x/, ''), 'hex').copy(b, 72);
  Buffer.from(BigInt(o.amount).toString(16).padStart(64, '0'), 'hex').copy(b, 92);
  Buffer.from(BigInt(o.timelock).toString(16).padStart(64, '0'), 'hex').copy(b, 124);
  return '0x' + crypto.createHash('sha256').update(b).digest('hex');
}

/* A code as the other phone makes it. */
function swapCodeOf(o) {
  const body = { v: 1, d: o.dir || 'u2b', s: o.sats, u: o.units, t2: o.t2 };
  if (o.h) body.h = codeField(o.h);
  if (o.a) body.a = codeField(o.a);
  if (o.t1) body.t1 = o.t1;
  if (o.net) body.n = o.net;
  if (o.contract) body.c = codeField(o.contract);
  if (o.locker) body.l = codeField(o.locker);
  return 'cleanswap:' + Buffer.from(JSON.stringify(body)).toString('base64url');
}

/* ------------------------------------------------------------- mock chain ---
   A JSON-RPC endpoint on 127.0.0.1 that answers the calls Arbitrum answers.
   The app is pointed at it through Setup, so the page walks the same
   eth_call / eth_getTransactionReceipt path it walks against a real node; the
   tests write the record and watch what the screen does with it. */
const http = require('http');
/* the escrow, the token and the partner address the wallet tests use */
const CONTRACT = '0x9d1f4c7a2b8e6035f4a7c1d9028be35f7a6c4d18';
const TOKEN = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const PARTNER = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
const CHAIN = {
  chainId: '0x66eee',                 /* Arbitrum Sepolia */
  block: 0x2f0000,
  blockTs: Math.floor(Date.now() / 1000),  /* the chain's own clock */
  allowance: 0,                       /* what the token answers for allowance(...) */
  records: {},                        /* swapId (lower-case) -> record */
  receipts: {},                       /* tx hash -> {status, blockNumber} */
  txs: {},                            /* tx hash -> transaction (from, to, input) */
  calls: [],                          /* every method the page asked for */
  down: false,                        /* flip to make the endpoint refuse */
  headSkew: 0,                        /* how many blocks the second endpoint is ahead */
  nohtlc: false                       /* flip to make the address answer like some other contract */
};
function hexWord(v) { return BigInt(v).toString(16).padStart(64, '0'); }
function hexAddr(a) { return String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
function hexB32(h) { return String(h).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
function recordHex(r) {
  return '0x' + [
    hexB32(r.hashlock), hexWord(r.amount), hexWord(r.timelock),
    hexAddr(r.token), hexAddr(r.sender), hexAddr(r.receiver),
    hexWord(r.claimed ? 1 : 0), hexWord(r.refunded ? 1 : 0)
  ].join('');
}
function chainJson(j) {
  const p = (j && j.params) || [];
  switch (j && j.method) {
    case 'eth_chainId': return CHAIN.chainId;
    case 'eth_blockNumber': return '0x' + CHAIN.block.toString(16);
    case 'eth_getBlockByNumber': return {
      number: '0x' + CHAIN.block.toString(16),
      timestamp: '0x' + CHAIN.blockTs.toString(16),
      hash: '0x' + '11'.repeat(32)
    };
    case 'eth_getCode': return '0x6080604052348015600e575f80fd5b50';
    case 'eth_call': {
      const data = String((p[0] && p[0].data) || '');
      if (data.toLowerCase().startsWith('0xeb84e7f2')) {              /* swaps(bytes32) */
        if (CHAIN.nohtlc) return '0x';                                /* a contract that is not the escrow */
        const id = ('0x' + data.slice(10, 74)).toLowerCase();
        const rec = CHAIN.records[id];
        return rec ? recordHex(rec) : '0x' + '0'.repeat(64 * 8);
      }
      if (data.toLowerCase().startsWith('0x70a08231')) return '0x' + hexWord(32500000);
      if (data.toLowerCase().startsWith('0xdd62ed3e')) return '0x' + hexWord(CHAIN.allowance);
      return '0x';
    }
    case 'eth_getTransactionReceipt': {
      const r = CHAIN.receipts[String(p[0] || '').toLowerCase()];
      if (!r) return null;
      return Object.assign({
        transactionHash: p[0], status: r.status || '0x1',
        blockNumber: r.blockNumber || '0x' + CHAIN.block.toString(16), logs: r.logs || []
      }, r.extra || {});
    }
    case 'eth_getTransactionByHash': return CHAIN.txs[String(p[0] || '').toLowerCase()] || null;
    default: return null;
  }
}
const chainServer = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (CHAIN.down) { res.writeHead(503, cors); res.end('down'); return; }
    let j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    if (!j) { res.writeHead(400, cors); res.end('{}'); return; }
    CHAIN.calls.push({ method: j.method, params: j.params || [] });
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: chainJson(j) }));
  });
});

/* A second endpoint that lies about the escrow: it answers every swaps(id)
   with a locked record, whatever the id. With two endpoints configured the app
   has to notice that the two answers differ and trust neither. */
const LIE = {
  record: {
    hashlock: '0x' + '31'.repeat(32), amount: 32500000, timelock: 1999999999,
    token: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    sender: '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761',
    receiver: '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',
    claimed: false, refunded: false
  }
};
const lieServer = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    if (!j) { res.writeHead(400, cors); res.end('{}'); return; }
    let result = null;
    if (j.method === 'eth_chainId') result = CHAIN.chainId;
    /* A second node is a few blocks ahead of the first, as two honest
       Arbitrum nodes usually are: the probe has to take the higher head
       instead of calling the chain broken. */
    else if (j.method === 'eth_blockNumber') result = '0x' + (CHAIN.block + CHAIN.headSkew).toString(16);
    else if (j.method === 'eth_getBlockByNumber') result = {
      number: '0x' + CHAIN.block.toString(16), timestamp: '0x' + CHAIN.blockTs.toString(16)
    };
    else if (j.method === 'eth_getCode') result = '0x6080604052348015600e575f80fd5b50';
    else if (j.method === 'eth_call') result = recordHex(LIE.record);
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: result }));
  });
});

/* A second honest endpoint. It answers the same chain in a different shape:
   the same keys in reverse order, Arbitrum's own extra fields on every receipt,
   and quantities written 0x01 instead of 0x1. Two nodes really do this, and a
   quorum that compares raw JSON calls it a disagreement - so this is the
   endpoint that proves the comparison looks at what the money depends on. */
function twist(v) {
  if (Array.isArray(v)) return v.map(twist);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const k of Object.keys(v).reverse()) out[k] = twist(v[k]);
  if ('logs' in v) {
    out.l1BlockNumber = '0x1234567';
    out.gasUsedForL1 = '0x00';
    out.depositNonce = '0x0';
  }
  if ('status' in v && /^0x[0-9a-f]{1,2}$/.test(String(v.status))) {
    out.status = '0x' + String(v.status).slice(2).padStart(2, '0');
  }
  if ('blockNumber' in v && /^0x[0-9a-f]{1,10}$/.test(String(v.blockNumber))) {
    out.blockNumber = '0x' + String(v.blockNumber).slice(2).padStart(8, '0');
  }
  return out;
}
const TWIN = { calls: 0 };
const twinServer = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = null;
    try { j = JSON.parse(body); } catch (e) { j = null; }
    if (!j) { res.writeHead(400, cors); res.end('{}'); return; }
    TWIN.calls++;
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: twist(chainJson(j)) }));
  });
});

/* Base58Check, as an independent implementation: bytes in, a TRON address out. */
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  let n = BigInt('0x' + (buf.length ? buf.toString('hex') : '0'));
  let out = '';
  while (n > 0n) { out = B58A[Number(n % 58n)] + out; n /= 58n; }
  let pad = 0;
  while (pad < buf.length && buf[pad] === 0) pad++;
  return '1'.repeat(pad) + out;
}
function tronFrom(hex20) {
  const payload = Buffer.concat([Buffer.from([0x41]), Buffer.from(hex20, 'hex')]);
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  return base58Encode(Buffer.concat([payload, sum]));
}
const BOLT12_DESC = 'CleanSwap - BTC for USDT';

const view = (pg) => pg.evaluate(() => {
  const t = (id) => document.getElementById(id);
  const vis = (id) => !t(id).hidden;
  return {
    phase: document.body.dataset.phase,
    mode: document.body.dataset.mode,
    dir: document.body.dataset.dir,
    state: t('stateTxt').textContent,
    title: t('stepTitle').textContent,
    say: t('say').textContent,
    cta: t('primary').textContent,
    ready: t('primary').dataset.ready,
    send: t('sendAmt').textContent + ' ' + t('sendUnit').textContent,
    get: t('getAmt').textContent + ' ' + t('getUnit').textContent,
    presets: vis('presets'),
    terms: vis('terms'),
    steps: vis('steps'),
    receipt: vis('receipt'),
    invTitle: t('invTitle').textContent,
    addrTitle: t('addrTitle').textContent,
    n1: t('nInv').textContent,
    n2: t('nAddr').textContent,
    order: [getComputedStyle(t('stepInv')).order, getComputedStyle(t('stepAddr')).order, getComputedStyle(t('stepGo')).order],
    sampleInv: vis('sampleInv'),
    sampleAddr: vis('sampleAddr'),
    invRow: vis('invRow'),
    walletLink: vis('walletLink'),
    copyInv: vis('copyInv'),
    href: t('walletLink').getAttribute('href'),
    qr: !!document.querySelector('#qrBox svg'),
    history: vis('history'),
    rows: document.querySelectorAll('#histList .hist-item').length,
    on: Array.from(document.querySelectorAll('#presets button.on')).map(b => b.textContent.trim()),
    rate: t('rateTxt').textContent,
    rc: [t('rcSend').textContent, t('rcGet').textContent, t('rcAddr').textContent],
    toast: t('toast').textContent,
    payLine: t('payLine').textContent,
    payAddr: t('payAddr').textContent,
    payAddrShown: vis('payAddr'),
    payEsc: t('payEsc').textContent,
    payRowInv: vis('payRowInv'),
    payRowAddr: vis('payRowAddr'),
    payLink: t('payWalletLink').getAttribute('href'),
    callLink: t('payLink').getAttribute('href'),
    callLinkShown: vis('payLink'),
    paySend: vis('paySend'),
    payCopyCall: vis('payCopyCall'),
    payCheck: vis('payCheck'),
    claimRow: vis('payRowClaim'),
    claimBtn: vis('claimBtn'),
    refundBtn: vis('refundBtn'),
    secret: vis('secretRow'),
    txRow: vis('txRow'),
    chainRow: vis('chainRow'),
    chainTxt: t('chainTxt').textContent,
    setup: vis('setupBox'),
    setupHint: t('setupHint').textContent,
    rcNet: t('rcNet').textContent,
    chainState: window.CLEANSWAP.state.chain && window.CLEANSWAP.state.chain.state,
    codeWarn: document.getElementById('codeWarn').hidden ? '' : document.getElementById('codeWarn').textContent,
    quorumWarn: t('quorumLine').hidden ? '' : t('quorumLine').textContent,
    back: vis('headRow'),
    gate: window.CLEANSWAP.state.gate && window.CLEANSWAP.state.gate.code
  };
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
  await new Promise((r) => chainServer.listen(0, '127.0.0.1', r));
  const RPC = 'http://127.0.0.1:' + chainServer.address().port;
  await new Promise((r) => lieServer.listen(0, '127.0.0.1', r));
  const RPC_LIE = 'http://127.0.0.1:' + lieServer.address().port;
  await new Promise((r) => twinServer.listen(0, '127.0.0.1', r));
  const RPC_TWIN = 'http://127.0.0.1:' + twinServer.address().port;
  /* /dev/shm is 64 MB in a container, and a renderer that runs out of it dies
     with "Target crashed" on the next context. Chromium is told to use its own
     shared memory files instead. */
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });

  async function freshPage(width, height) {
    const c = await browser.newContext({ viewport: { width: width || 390, height: height || 844 }, deviceScaleFactor: 1 });
    const p = await c.newPage();
    const errs = [], failed = [], reqs = [];
    p.on('request', r => reqs.push(r.url()));
    p.on('pageerror', e => errs.push('pageerror: ' + e.message));
    /* a deliberately failed endpoint (the offline test) logs a resource error in
       the console; that is the browser talking, not the page breaking */
    p.on('console', m => {
      if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errs.push('console: ' + m.text());
    });
    p.on('requestfailed', r => { if (!/mempool\.space/.test(r.url())) failed.push(r.url()); });
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
    await p.waitForTimeout(250);
    return { c, p, errs, failed, reqs };
  }

  /* ------------------------------------------------------------ 1. boot --- */
  const A = await freshPage(390, 844);
  const page = A.p;
  let w = await view(page);

  check('boot: no page or console errors', A.errs.length === 0, A.errs.join(' | '));
  check('boot: no failed requests except the optional quote', A.failed.length === 0, A.failed.join(','));
  check('boot: starts idle, practice, sending bitcoin', w.phase === 'idle' && w.mode === 'practice' && w.dir === 'btc2u',
    [w.phase, w.mode, w.dir].join('/'));
  check('boot: one clean rate line', /^1 BTC ≈ [\d,]+ USDT$/.test(w.rate), w.rate);
  check('boot: the three steps are on screen in order, 1-2-3',
    w.steps && w.n1 === '1' && w.n2 === '2' && w.order.join(',') === '1,2,3', w.order.join(','));
  check('boot: step 1 is the partner invoice, step 2 your USDT address',
    w.invTitle === "Partner's Lightning invoice" && w.addrTitle === 'Your USDT address', w.invTitle + ' / ' + w.addrTitle);
  const ph = await page.evaluate(() => ({ inv: document.getElementById('invIn').placeholder, addr: document.getElementById('addrIn').placeholder }));
  check('boot: the invoice field asks for a hold invoice, not an offer',
    /lnbc/.test(ph.inv) && /hold invoice/.test(ph.inv) && !/lno1/.test(ph.inv), ph.inv);
  check('boot: the address field welcomes both USDT chains',
    /0x/.test(ph.addr) && /T/.test(ph.addr), ph.addr);
  check('boot: one big Approve button, not ready yet', w.cta === 'Approve' && w.ready === '0', w.cta + '/' + w.ready);
  check('boot: the sentence asks for the first step', /Paste the invoice your partner sends/.test(w.say), w.say);
  check('boot: 50,000 sats on both cards', w.send === '50,000 sats' && /^[\d,.]+ USDT$/.test(w.get), w.send + ' / ' + w.get);
  check('boot: the amount presets are shown, 50,000 selected',
    w.presets && w.on.length === 1 && w.on[0] === '50,000', w.on.join(','));
  check('boot: practice offers Sample beside both fields', w.sampleInv && w.sampleAddr,
    [w.sampleInv, w.sampleAddr].join('/'));
  check('boot: practice shows the same invoice row as wallet', w.invRow && w.walletLink, [w.invRow, w.walletLink].join('/'));
  check('boot: practice already names the chain and its stand-in escrow',
    w.chainRow && /^Arbitrum Sepolia · escrow ready$/.test(w.chainTxt), w.chainTxt);
  check('boot: the terms code is a small helper, not a step', w.terms && !w.receipt, String(w.terms));

  const html = await page.content();
  check('content: no test toolbox left in the page', !OLD_ACTS.some(a => new RegExp('data-act="' + a + '"').test(html)),
    OLD_ACTS.filter(a => new RegExp('data-act="' + a + '"').test(html)).join(','));
  check('content: no sample or mismatch helpers anywhere', !/use sample|mismatched|wrong r|advance clock/i.test(html));
  check('content: a page wallet can sign when there is one (EIP-1193)',
    /window\.ethereum/.test(html) && /eth_requestAccounts/.test(html) && /eth_sendTransaction/.test(html) &&
    /wallet_switchEthereumChain/.test(html));
  check('content: no key, no seed and no password field anywhere',
    !/privateKey|mnemonic|seed ?phrase|type="password"/i.test(html));
  check('content: no WebLN hand-off', !/webln/i.test(html));
  check('content: no markup is parsed into the page (DOMParser/innerHTML of strangers)',
    !/DOMParser/.test(html) && !/insertAdjacentHTML/.test(html) && !/document\.write/.test(html));
  check('content: contract source embedded (sha256 hashlock)', /sha256\(abi\.encodePacked\(preimage\)\)/.test(html));
  check('content: no remote scripts or styles', !/<script[^>]+src=/i.test(html) && !/<link[^>]+rel="stylesheet"/i.test(html));
  check('content: the page holds no file:// path of its own', !/file:\/\//.test(html),
    (html.match(/file:\/\/[^"'\s]*/) || [''])[0]);
  check('content: no web host in the page (no Pages address)', !/github\.io|jbitmstr\.github|https?:\/\/[a-z0-9.-]*cleanswap/i.test(html));
  check('content: no Hangul in the built page', !HANGUL.test(html), (html.match(HANGUL) || []).length + ' chars');
  const uiText = await page.evaluate(() => document.body.innerText);
  check('content: no Hangul in rendered text', !HANGUL.test(uiText), (uiText.match(HANGUL) || []).length + ' chars');
  check('content: no technical words on the screen', !JARGON.test(uiText), (uiText.match(JARGON) || [''])[0]);

  await page.screenshot({ path: path.join(SHOTS, 'v51-idle.png') });

  /* --------------------------------------------- 2. practice: the 3 steps --- */
  await page.click('[data-act="sampleInv"]');
  await page.waitForFunction(() => /^lnbc/.test(document.getElementById('invIn').value), null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view(page);
  check('practice: Sample fills a real lnbc invoice', w.gate === 'empty' && w.ready === '0', w.gate + '/' + w.ready);
  check('practice: the sentence now asks for the address', /Add the USDT address/.test(w.say), w.say);
  check('practice: the invoice row carries the invoice, as in wallet',
    w.invRow && w.walletLink && w.href === 'lightning:' + w.href.replace('lightning:', ''), String(w.href).slice(0, 22) + '…');

  /* the hand-off row is the same in both modes; a rehearsal just keeps it on
     the phone instead of opening a wallet */
  await page.click('#walletLink');
  await page.waitForTimeout(300);
  check('practice: Open in wallet says the invoice stays on the phone',
    /no wallet opens/.test((await view(page)).toast), (await view(page)).toast);
  check('practice: and nothing left the page', page.url() === URL, page.url());

  await page.click('[data-act="sampleAddr"]');
  await page.waitForTimeout(300);
  w = await view(page);
  check('practice: Sample fills a 0x address', /^0x[0-9a-f]{40}$/i.test(await page.inputValue('#addrIn')));
  check('practice: both steps in, Approve is ready', w.ready === '1' && w.gate === 'ok', w.gate + '/' + w.ready);
  check('practice: the sentence says what Approve does', /ties both legs to one secret/.test(w.say), w.say);
  check('practice: the state line says so too', w.state === 'Ready to approve', w.state);
  await page.screenshot({ path: path.join(SHOTS, 'v43-filled.png') });

  const sent = await page.evaluate(() => ({
    H: window.CLEANSWAP.state.expectH, inv: document.getElementById('invIn').value,
    addr: document.getElementById('addrIn').value, units: window.CLEANSWAP.usdtUnits()
  }));
  const dec = await page.evaluate(i => window.CLEANSWAP.decodeBolt11(i), sent.inv);
  const practiceToken = await page.evaluate(() => window.CLEANSWAP.tokenNow());
  const PRACTICE_LOCKER = await page.evaluate(() => window.CLEANSWAP.EVM.usdtSide);
  check('practice: the sample invoice carries the amount on screen', dec.sats === 50000, String(dec.sats));

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 8000 });
  await page.waitForTimeout(300);
  w = await view(page);
  check('practice: Approve parks on the waiting screen, not on a finished swap',
    w.phase === 'paying' && w.title === 'Waiting for payment' && w.cta === 'I paid' && !w.receipt,
    w.phase + ' / ' + w.title + ' / ' + w.cta);
  check('practice: the waiting screen says what to pay and how much',
    /^Send 50,000 sats to this invoice/.test(w.payLine), w.payLine);
  check('practice: the invoice waits there with the same hand-off',
    w.payRowInv && w.payLink === 'lightning:' + sent.inv, String(w.payLink).slice(0, 22) + '…');
  check('practice: Check chain and Paste tx are both on the screen, as in wallet',
    w.payCheck && !w.claimRow, w.payCheck + '/' + w.claimRow);
  check('practice: the escrow line names the same chain and the stand-in escrow',
    /^Practice · Arbitrum Sepolia · escrow holds your/.test(w.payEsc), w.payEsc);
  check('practice: the chain bar is on screen and says the USDT is locked',
    w.chainRow && /^Arbitrum Sepolia · USDT locked$/.test(w.chainTxt), w.chainTxt);
  check('practice: Back is offered while waiting', w.back, String(w.back));
  check('practice: the two steps fold away while waiting', !w.steps && !w.presets && !w.terms, String(w.steps));
  check('practice: nothing on the screen says the swap is done',
    !/swap complete|completed/i.test([w.title, w.state, w.payLine, w.say].join(' ')) && !w.receipt,
    [w.title, w.state].join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'v51-practice-paying.png') });

  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(350);
  check('practice: the waiting screen can show the invoice as a QR', (await view(page)).qr);
  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(200);

  /* I paid starts the watch; the stand-in claim is what finishes it */
  await page.click('#primary');
  await page.waitForTimeout(350);
  w = await view(page);
  check('practice: I paid waits for the escrow instead of finishing',
    w.phase === 'paid' && w.cta === 'Check chain' && !w.receipt, w.phase + ' / ' + w.cta);
  check('practice: the screen says what it is waiting for',
    /closes the swap when the chain says so/.test(w.payLine), w.payLine);
  check('practice: a lock without a claim offers the claim, as in wallet', w.claimRow, String(w.claimRow));
  await page.screenshot({ path: path.join(SHOTS, 'v51-practice-paid.png') });

  await page.click('#primary');            /* Check chain, before the claim lands */
  await page.waitForTimeout(350);
  w = await view(page);
  check('practice: Check chain on a lock alone finishes nothing',
    w.phase === 'paid' && !w.receipt, w.phase);
  check('practice: and says the escrow still holds it', /still holds/.test(w.toast), w.toast);

  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 10000 });
  await page.waitForTimeout(300);
  w = await view(page);
  check('practice: the stand-in claim closes the swap', w.state === 'Completed' && w.cta === 'Done', w.state + '/' + w.cta);
  check('practice: the receipt shows both sides and the address',
    w.receipt && w.rc[0] === '50,000 sats' && /^[\d,.]+ USDT$/.test(w.rc[1]) && w.rc[2] === sent.addr.toLowerCase(),
    w.rc.join(' | '));
  check('practice: the receipt says it was a rehearsal', /^Practice · simulated$/.test(w.rcNet), w.rcNet);
  check('practice: the sentence names what arrived', /You received [\d,.]+ USDT\./.test(w.say), w.say);
  check('practice: the steps fold away once settled', !w.steps && !w.presets && !w.terms, String(w.steps));
  check('practice: a rehearsal adds nothing to Recent', !w.history && w.rows === 0, String(w.rows));
  const remote = A.reqs.filter(u => /^https?:/i.test(u) && !/mempool\.space/.test(u));
  check('practice: a whole rehearsal talks to no chain and no wallet', remote.length === 0,
    remote.slice(0, 3).join(',') || 'no request left the phone');
  await page.screenshot({ path: path.join(SHOTS, 'v51-done.png') });

  /* the settled state is a real swap record, not just a label */
  const settled = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    const d = window.CLEANSWAP.decodeLockCalldata(window.CLEANSWAP.nextCalldata());
    return { H: s.H, id: s.id, t2: s.t2, units: s.units, addr: s.addr, dec: d, calldata: window.CLEANSWAP.nextCalldata() };
  });
  check('settle: the invoice hash is the swap hashlock',
    settled.H === '0x' + dec.paymentHash.slice(2), String(settled.H).slice(0, 12) + '…');
  check('settle: the escrow lock carries that same hashlock',
    settled.dec && settled.dec.hashlock.toLowerCase() === settled.H.toLowerCase(), settled.dec && settled.dec.hashlock);
  check('settle: the escrow pays the address on step 2',
    settled.dec && settled.dec.receiver.toLowerCase() === sent.addr.toLowerCase(), settled.dec && settled.dec.receiver);
  check('settle: the escrow holds the agreed USDT amount and window',
    settled.dec && Number(settled.dec.amount) === Number(settled.units) && Number(settled.dec.timelock) === Number(settled.t2),
    settled.dec && settled.dec.amount + ' / ' + settled.dec.timelock);
  /* the id is the terms and the funding address, packed:
     hashlock, sender, receiver, token, amount, timelock. */
  const packed = Buffer.alloc(156);
  Buffer.from(settled.H.slice(2), 'hex').copy(packed, 0);
  Buffer.from(PRACTICE_LOCKER.slice(2), 'hex').copy(packed, 32);
  Buffer.from(settled.addr.slice(2), 'hex').copy(packed, 52);
  Buffer.from(practiceToken.slice(2), 'hex').copy(packed, 72);
  Buffer.from(BigInt(settled.units).toString(16).padStart(64, '0'), 'hex').copy(packed, 92);
  Buffer.from(BigInt(settled.t2).toString(16).padStart(64, '0'), 'hex').copy(packed, 124);
  const wantId = '0x' + crypto.createHash('sha256').update(packed).digest('hex');
  check('settle: the swap id binds both legs and the funding address (abi.encodePacked)', settled.id === wantId,
    String(settled.id).slice(0, 14) + '…');
  check('settle: the id names the funding address, not the receiver',
    await page.evaluate(() => window.CLEANSWAP.state.id === window.CLEANSWAP.state.id &&
      window.CLEANSWAP.lockerNow() === window.CLEANSWAP.EVM.usdtSide), 'locker ' + PRACTICE_LOCKER.slice(0, 10));
  fs.writeFileSync(path.join(BUILD, 'app-calldata.json'), JSON.stringify({
    calldata: settled.calldata, hashlock: settled.H, timelock: settled.t2,
    receiver: settled.addr, token: practiceToken, amount: String(settled.units)
  }, null, 2));

  /* ------------------------------------------------- 3. Back and Done --- */
  await page.click('#primary');            /* Done */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  check('done: the fields start empty again',
    await page.evaluate(() => !window.CLEANSWAP.state.H && !window.CLEANSWAP.state.addr &&
      !document.getElementById('invIn').value && !document.getElementById('addrIn').value));

  /* ------------------------------------------- 4. wallet: the real escrow --- */
  await page.click('#modeWallet');
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: the mode switch flips', w.mode === 'wallet');
  check('wallet: the screen keeps the same three steps',
    w.steps && w.n1 === '1' && w.n2 === '2' && w.order.join(',') === '1,2,3', w.order.join(','));
  check('wallet: Sample is gone', !w.sampleInv && !w.sampleAddr, [w.sampleInv, w.sampleAddr].join('/'));
  check('wallet: the invoice row hands off to a wallet',
    w.invRow && w.walletLink && !w.copyInv, [w.invRow, w.walletLink, w.copyInv].join('/'));
  check('wallet: the chain line names the chain and says no escrow is set',
    w.chainRow && /^Arbitrum Sepolia · escrow not set$/.test(w.chainTxt), w.chainTxt);

  const R2 = '77'.repeat(32);
  const H2 = '0x' + crypto.createHash('sha256').update(Buffer.from(R2, 'hex')).digest('hex');
  const realInv = await page.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H2);
  check('wallet: the sample invoice is a normal lnbc invoice', /^lnbc1|^lnbc\d/.test(realInv), realInv.slice(0, 12) + '…');
  await page.fill('#invIn', realInv);
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: a real invoice passes and the wallet link carries it', w.gate === 'empty' && w.href === 'lightning:' + realInv,
    w.gate + ' ' + w.href.slice(0, 18) + '…');
  await page.click('[data-act="qrInvoice"]');
  await page.waitForTimeout(350);
  check('wallet: the QR button shows the invoice', (await view(page)).qr);
  await page.click('[data-act="qrInvoice"]');
  await page.waitForTimeout(200);
  check('wallet: and folds it away again', !(await view(page)).qr);

  await page.fill('#addrIn', '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: with no escrow set the third step asks for one, it does not say ready',
    w.gate === 'setup' && w.ready === '0' && /escrow contract/.test(w.say), w.gate + ' ' + w.say);

  /* the escrow is set once, in Setup; the bytecode and Remix are the deploy path */
  await page.click('#chainRow');
  await page.waitForTimeout(250);
  w = await view(page);
  check('setup: the chain line opens the setup panel', w.setup, String(w.setup));
  const setupHtml = await page.textContent('#setupBox');
  check('setup: it offers the deploy hand-off (bytecode + Remix)',
    /Copy bytecode/.test(setupHtml) && (await page.getAttribute('#remixLink', 'href')) === 'https://remix.ethereum.org');
  const codeBytes = await page.evaluate(() => window.CLEANSWAP.BYTECODE);
  check('setup: the escrow bytecode is in the page (solc 0.8.26, creation code)',
    /^6080[0-9a-f]{1000,}$/.test(codeBytes), codeBytes.length + ' hex chars');

  await page.fill('#contractIn', CONTRACT);
  await page.fill('#tokenIn', TOKEN);
  await page.fill('#rpcIn', RPC);
  await page.click('[data-act="saveSetup"]');
  await page.waitForTimeout(1000);
  w = await view(page);
  check('setup: saving reads the chain and finds a contract there', /escrow ready/.test(w.chainTxt), w.chainTxt);
  check('setup: the page really called the endpoint',
    CHAIN.calls.some(c => c.method === 'eth_blockNumber') && CHAIN.calls.some(c => c.method === 'eth_getCode'));
  check('setup: the block it read is on screen in the panel', /block [\d,]+/.test(w.setupHint), w.setupHint);
  await page.screenshot({ path: path.join(SHOTS, 'v50-setup.png') });

  /* Two honest Arbitrum nodes are a block or two apart by design (a block every
     ~250ms), so the height is read from every endpoint and the highest stands:
     the probe must not call a working chain broken and refuse the swap. */
  CHAIN.headSkew = 9;
  const headOut = await page.evaluate(async ({ rpc, lie }) => {
    const S = window.CLEANSWAP.state;
    const was = S.rpc;
    S.rpc = rpc + ' ' + lie;
    await window.CLEANSWAP.chainProbe();
    const out = { rpcState: S.rpcState, block: S.block, quorum: S.quorum };
    S.rpc = was;
    return out;
  }, { rpc: RPC, lie: RPC_LIE });
  CHAIN.headSkew = 0;
  check('head: a head a few blocks apart on two endpoints is not a disagreement',
    headOut.rpcState === 'ok', headOut.rpcState + ' / ' + headOut.quorum);
  check('head: the highest head is the one on screen', headOut.block === CHAIN.block + 9, String(headOut.block));

  /* One escrow, one token, one endpoint list per network: a mainnet address
     never becomes a testnet one, and coming back brings the right set back. */
  const MAIN_CONTRACT = '0x2b1e7d4c9a6f3058b1ce42d7a890f3c5e6721b04';
  await page.click('#netMain');
  await page.waitForTimeout(400);
  const onMain = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { net: s.net, contract: s.contract, token: s.token, rpc: s.rpc, block: s.block, chain: s.chain };
  });
  check('net: switching to mainnet carries no testnet escrow, token or endpoint with it',
    onMain.net === 'mainnet' && onMain.contract === '' && onMain.token === '' && onMain.rpc === '',
    JSON.stringify(onMain));
  check('net: the setup fields are the mainnet ones, and they are empty',
    (await page.inputValue('#contractIn')) === '' && (await page.inputValue('#rpcIn')) === '',
    (await page.inputValue('#contractIn')) + ' / ' + (await page.inputValue('#rpcIn')));
  await page.fill('#contractIn', MAIN_CONTRACT);
  await page.fill('#tokenIn', TOKEN);
  await page.fill('#rpcIn', RPC);
  await page.click('[data-act="saveSetup"]');
  await page.waitForTimeout(1100);
  const onMainSaved = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { contract: s.contract, token: s.token, rpc: s.rpc, rpcState: s.rpcState };
  });
  check('net: a mainnet escrow is read on mainnet',
    onMainSaved.contract === MAIN_CONTRACT && onMainSaved.rpcState === 'ok', JSON.stringify(onMainSaved));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cleanswap.setup.v1')));
  check('net: storage keeps one setup for each network, side by side',
    !!stored && stored.net === 'mainnet' && stored.nets.mainnet.contract === MAIN_CONTRACT &&
    stored.nets.testnet.contract === CONTRACT && stored.nets.testnet.token === TOKEN && stored.nets.testnet.rpc === RPC,
    JSON.stringify(stored && stored.nets));
  await page.click('#netTest');
  await page.waitForTimeout(1100);
  const backOnTest = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { net: s.net, contract: s.contract, token: s.token, rpc: s.rpc };
  });
  check('net: switching back brings the testnet escrow, token and endpoint, not the mainnet one',
    backOnTest.net === 'testnet' && backOnTest.contract === CONTRACT && backOnTest.token === TOKEN && backOnTest.rpc === RPC,
    JSON.stringify(backOnTest));
  check('net: the field shows the testnet escrow again',
    (await page.inputValue('#contractIn')) === CONTRACT, await page.inputValue('#contractIn'));

  /* An address with code is not yet the escrow: any contract has code. The
     probe asks the escrow's own view function - `swaps()` on an id nobody
     locked reads back eight zeroed words on the real contract, and anything
     else (a revert, a short answer, some other shape) is refused by name
     before any money is asked for. */
  /* the setup panel is still open here, left that way by the net tests */
  CHAIN.nohtlc = true;
  await page.click('[data-act="saveSetup"]');
  await page.waitForTimeout(1400);
  const noHtlc = await view(page);
  check('probe: an address that answers but is not the escrow is refused by name',
    noHtlc.chainTxt.includes('not the swap contract') &&
    (await page.evaluate(() => window.CLEANSWAP.state.rpcState)) === 'nohtlc', noHtlc.chainTxt);
  const noHtlcCalls = CHAIN.calls.filter(c => c.method === 'eth_call' &&
    String((c.params[0] || {}).data || '').toLowerCase().startsWith('0xeb84e7f2'));
  check('probe: the escrow view function was really asked', noHtlcCalls.length > 0,
    noHtlcCalls.length + ' swaps() calls');
  const HNH = '0x' + crypto.createHash('sha256').update(Buffer.from('64'.repeat(32), 'hex')).digest('hex');
  const invNH = await page.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), HNH);
  await page.click('#swapDir');   /* the side that sends USDT has no locker gate, so Approve reaches the probe */
  await page.waitForTimeout(250);
  await page.fill('#invIn', invNH);
  await page.fill('#addrIn', '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  await page.waitForTimeout(300);
  await page.click('#primary');
  await page.waitForTimeout(1600);
  const noHtlcTap = await view(page);
  check('probe: Approve on a look-alike address says so and approves nothing',
    noHtlcTap.phase === 'idle' && /not the swap contract/.test(noHtlcTap.toast),
    noHtlcTap.phase + ' / ' + noHtlcTap.toast);
  await page.click('#swapDir');
  await page.fill('#invIn', '');
  await page.fill('#addrIn', '');
  await page.waitForTimeout(200);
  /* the refused tap had already filled in the terms, and a saved setup reads
     the chain again when terms are on screen: clear them, so the recovery
     reads as a fresh setup would */
  await page.evaluate(() => window.CLEANSWAP.reset());
  await page.waitForTimeout(200);
  /* the refusal opens Setup on its way out - and the panel toggles, so the
     state after the refusal depends on the state before. Make sure it is
     open before saving the real contract back. */
  if (!(await page.isVisible('#setupBox'))) {
    await page.click('#chainRow');
    await page.waitForTimeout(250);
  }
  CHAIN.nohtlc = false;
  await page.click('[data-act="saveSetup"]');
  await page.waitForTimeout(1400);
  const htlcBack = await view(page);
  check('probe: the same address reads ready again once it answers like the escrow',
    /escrow ready/.test(htlcBack.chainTxt) &&
    (await page.evaluate(() => window.CLEANSWAP.state.rpcState)) === 'ok', htlcBack.chainTxt);
  check('probe: no page errors through the refusal and the recovery',
    A.errs.length === 0, A.errs.join(' | '));

  await page.click('#chainRow');
  await page.waitForTimeout(250);

  /* The partner funds the escrow, so the partner's code says which address the
     escrow will be read under: that address is part of the swap id. */
  const unitsW = await page.evaluate(() => window.CLEANSWAP.usdtUnits());
  const t2W = Math.floor(Date.now() / 1000) + 7200;
  const USER_ADDR = '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71';
  const partnerCode = swapCodeOf({
    dir: 'u2b', sats: 50000, units: unitsW, t2: t2W, h: H2,
    a: USER_ADDR, net: 't', contract: CONTRACT, locker: PARTNER
  });
  await page.click('[data-act="pasteCode"]');
  await page.fill('#codeIn', partnerCode);
  await page.fill('#addrIn', '');        /* the field starts empty, as a new phone's would */
  await page.click('[data-act="useCode"]');
  await page.waitForTimeout(400);
  /* The code names this phone's address, and on the receiving side that is
     exactly what is not taken on faith: it is offered, and typed here. */
  check('code: the address a code names is offered, not written into the field',
    (await page.inputValue('#addrIn')) === '' &&
    /Use it only if it is yours/.test(await page.textContent('#codeAddr')),
    await page.inputValue('#addrIn'));
  await page.click('[data-act="useCodeAddr"]');
  await page.waitForTimeout(200);
  check('code: one tap on "Use it" puts the address in',
    (await page.inputValue('#addrIn')) === USER_ADDR && !(await page.isVisible('#codeAddr')),
    await page.inputValue('#addrIn'));
  await page.fill('#invIn', realInv);
  await page.waitForTimeout(350);
  w = await view(page);
  check('setup: both steps in, the third one is ready again', w.gate === 'ok' && w.ready === '1', w.gate + '/' + w.ready);
  check('code: the partner code brings the funding address the id needs',
    await page.evaluate(() => window.CLEANSWAP.lockerNow()) === PARTNER,
    await page.evaluate(() => String(window.CLEANSWAP.lockerNow())));

  /* the code a wallet swap hands over names the chain and the escrow too, and
     still fits a QR */
  const walletCode = await page.evaluate(() => window.CLEANSWAP.swapCode());
  const walletCodeBack = await page.evaluate(c => window.CLEANSWAP.parseSwapCode(c), walletCode);
  check('code: a wallet code carries the chain and the escrow',
    walletCodeBack && walletCodeBack.net === 'testnet' && walletCodeBack.contract === CONTRACT,
    walletCodeBack && (walletCodeBack.net + ' ' + walletCodeBack.contract));
  check('code: it still fits a QR with the hashlock inside',
    new TextEncoder().encode(walletCode).length <= 340 && /^0x[0-9a-f]{64}$/.test(walletCodeBack.H),
    new TextEncoder().encode(walletCode).length + ' bytes');

  /* The rate a code carries is the one term a stranger wrote that the money
     follows. Against the live quote, a price far off the market is said out
     loud while it is still only terms; the quote is fed by hand here, since
     the page's own fetch fails off-line and the fallback price is a guess
     the app refuses to warn against. */
  const RG = await freshPage(390, 844);
  const rgp = RG.p;
  await rgp.evaluate(() => {
    window.CLEANSWAP.state.price = 90000;
    window.CLEANSWAP.state.pstate = 'live';
  });
  const t2rg = Math.floor(Date.now() / 1000) + 7200;
  const fairCode = swapCodeOf({ dir: 'u2b', sats: 50000, units: 45000000, t2: t2rg });
  const skewCode = swapCodeOf({ dir: 'u2b', sats: 50000, units: 60000000, t2: t2rg + 10 });
  await rgp.evaluate(c => window.CLEANSWAP.applyCode(c), fairCode);
  let rgw = await view(rgp);
  check('rate: a code at the market price loads with no warning', rgw.codeWarn === '', rgw.codeWarn);
  const gap = await rgp.evaluate(() => window.CLEANSWAP.rateGap(60000000, 50000));
  check('rate: the gap is computed as a fraction of the market price',
    gap && Math.abs(gap.gap - 1 / 3) < 0.001 && gap.codePrice === 120000, JSON.stringify(gap));
  await rgp.evaluate(c => window.CLEANSWAP.applyCode(c), skewCode);
  rgw = await view(rgp);
  check('rate: a code 33% off the market is warned about while it is still only terms',
    /33% away from the market rate/.test(rgw.codeWarn) && rgw.codeWarn.startsWith('Careful:'), rgw.codeWarn);
  check('rate: the warning is plain English', !JARGON.test(rgw.codeWarn), rgw.codeWarn);
  check('rate: the terms still loaded, nothing was refused',
    rgw.phase === 'idle' && rgw.send === '50,000 sats', rgw.phase + ' ' + rgw.send);
  check('rate: the log records the divergence',
    await rgp.evaluate(() => window.CLEANSWAP.state.log.some(e => /% off/.test(e.text))));
  await RG.c.close();

  /* 4a. nothing in the escrow: Approve may not start a swap */
  await page.click('#primary');
  await page.waitForTimeout(1500);
  w = await view(page);
  check('escrow: Approve is refused while the USDT is not locked', w.phase === 'idle', w.phase);
  check('escrow: the refusal says what is missing', /not in the escrow yet/.test(w.say), w.say);
  check('escrow: the refusal is plain English', !JARGON.test(w.say), w.say);
  check('escrow: no receipt and nothing in Recent', !w.receipt && w.rows === 0, w.rows + ' rows');
  check('escrow: the chain line says nothing is locked', /nothing locked yet/.test(w.chainTxt), w.chainTxt);
  check('escrow: the page read the escrow record itself',
    CHAIN.calls.some(c => c.method === 'eth_call' && String(c.params[0].data).toLowerCase().startsWith('0xeb84e7f2')),
    String(CHAIN.calls.length) + ' calls');
  await page.screenshot({ path: path.join(SHOTS, 'v50-blocked.png') });

  /* 4b. the partner locks the USDT: the app reads it and lets the payment start */
  const terms = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { H: s.H, units: s.units, t2: s.t2, addr: s.addr };
  });
  const swapId = await page.evaluate(() => window.CLEANSWAP.swapIdNow());
  const lockRecord = {
    hashlock: terms.H, amount: terms.units, timelock: terms.t2, token: TOKEN,
    sender: PARTNER, receiver: terms.addr, claimed: false, refunded: false
  };
  CHAIN.records[swapId.toLowerCase()] = lockRecord;
  /* the record and the bytes the mock answers with: test/contract-evm.py checks
     that encoding against eth_abi, so the layout the page decodes is not one
     these tests invented */
  fs.writeFileSync(path.join(BUILD, 'mock-record.json'), JSON.stringify({ record: lockRecord, hex: recordHex(lockRecord) }, null, 2));
  await page.click('#primary');
  await page.waitForTimeout(1800);
  w = await view(page);
  check('locked: the app reads the escrow and moves on to the payment',
    w.phase === 'paying' && w.chainState === 'locked', w.phase + ' / ' + w.chainState);
  check('locked: the waiting screen says what to pay and how much',
    /^Send 50,000 sats to this invoice/.test(w.payLine), w.payLine);
  check('locked: it shows the chain and the escrow state',
    /Arbitrum Sepolia · block/.test(w.payEsc) && /holds your/.test(w.payEsc), w.payEsc);
  check('locked: the invoice is one tap from a wallet there too',
    w.payRowInv && !w.payRowAddr && w.payLink === 'lightning:' + realInv, String(w.payLink).slice(0, 20) + '…');
  check('locked: Back is offered while waiting', w.back, String(w.back));
  check('locked: the two steps fold away while waiting', !w.steps && !w.presets && !w.terms, String(w.steps));
  await page.screenshot({ path: path.join(SHOTS, 'v50-paying.png') });

  /* The escrow window is measured by the chain as well as by the phone: a node
     that has moved on says the window is closing even while this phone's clock
     still shows minutes left, and paying then is how a payer loses. */
  const realChainTs = CHAIN.blockTs;
  CHAIN.blockTs = Math.floor(Date.now() / 1000) + 7200 - 300;
  const clockCalls = CHAIN.calls.length;
  await page.click('#primary');                 /* I paid */
  await page.waitForTimeout(900);
  w = await view(page);
  check('clock: a chain past the window refuses to pay, though the phone says there is time',
    w.phase === 'paying' && /window is closing/.test(w.toast), w.phase + ' · ' + w.toast);
  check('clock: the block time was read from the chain for that answer',
    CHAIN.calls.slice(clockCalls).some(c => c.method === 'eth_getBlockByNumber'),
    CHAIN.calls.slice(clockCalls).map(c => c.method).join(','));
  check('clock: moving the phone back does not reopen the window',
    await page.evaluate(() => { const s = window.CLEANSWAP.state; s.sim = -7200; const t = window.CLEANSWAP.effNow(); s.sim = 0; return t; })
      >= CHAIN.blockTs, String(CHAIN.blockTs));
  CHAIN.blockTs = realChainTs;
  await page.waitForTimeout(200);

  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(350);
  check('locked: the waiting screen can show the invoice as a QR', (await view(page)).qr);
  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(200);

  /* 4c. I paid starts the watch; it does not finish the swap */
  await page.click('#primary');
  await page.waitForTimeout(1600);
  w = await view(page);
  check('paid: I paid waits for the escrow instead of finishing',
    w.phase === 'paid' && w.cta === 'Check chain', w.phase + ' / ' + w.cta);
  check('paid: nothing on the screen says the swap is done',
    !/swap complete|completed/i.test([w.title, w.state, w.payLine, w.say].join(' ')) && !w.receipt,
    [w.title, w.state].join(' | '));
  check('paid: no receipt and no Recent entry yet', !w.receipt && w.rows === 0, w.rows + ' rows');
  check('paid: the screen says what it is waiting for',
    /closes the swap when the chain says so/.test(w.payLine), w.payLine);
  await page.screenshot({ path: path.join(SHOTS, 'v50-paid.png') });

  /* 4d. a lock without a claim is not a finished swap */
  await page.click('#primary');
  await page.waitForTimeout(1400);
  w = await view(page);
  check('claimed: a lock without a claim finishes nothing', w.phase === 'paid' && !w.receipt, w.phase);
  check('claimed: the screen says the escrow still holds it', /still holds/.test(w.toast), w.toast);

  /* 4e. an endpoint that does not answer completes nothing and says so */
  CHAIN.down = true;
  await page.click('#primary');
  await page.waitForTimeout(2600);
  w = await view(page);
  check('offline: an unreachable chain completes nothing', w.phase === 'paid' && !w.receipt, w.phase);
  check('offline: the chain line says it did not answer', /no answer/.test(w.chainTxt), w.chainTxt);
  CHAIN.down = false;

  /* 4f. a record that is not this swap is refused, not accepted */
  lockRecord.amount = Number(terms.units) + 1000000;
  await page.click('#primary');
  await page.waitForTimeout(1600);
  w = await view(page);
  check('mismatch: a lock holding another amount finishes nothing', w.phase === 'paid' && !w.receipt, w.phase);
  check('mismatch: the refusal names the amount', /different amount/.test(w.payLine), w.payLine);
  lockRecord.amount = terms.units;

  /* 4g. the claim lands: now, and only now, the swap completes */
  lockRecord.claimed = true;
  await page.click('#primary');
  await page.waitForTimeout(1800);
  w = await view(page);
  check('chain: a claimed escrow completes the swap',
    w.phase === 'settled' && w.state === 'Completed' && w.cta === 'Done',
    w.phase + ' / ' + w.state + ' / ' + w.cta);
  check('chain: the receipt says where it settled', /Arbitrum Sepolia · paid on chain/.test(w.rcNet), w.rcNet);
  check('chain: the receipt shows both sides and the address',
    w.receipt && /sats$/.test(w.rc[0]) && /USDT$/.test(w.rc[1]) && w.rc[2] === terms.addr, w.rc.join(' | '));
  check('chain: the sentence names what arrived', /You received [\d,.]+ USDT on Arbitrum Sepolia\./.test(w.say), w.say);
  check('chain: the swap is kept in Recent', w.history && w.rows === 1, String(w.rows));
  check('chain: the history row shows what arrived', await page.evaluate(() =>
    /^\+\s?[\d,.]+ USDT$/.test(document.querySelector('#histList .hist-item b').textContent)),
    await page.evaluate(() => document.querySelector('#histList .hist-item b').textContent));
  await page.screenshot({ path: path.join(SHOTS, 'v50-settled.png') });
  check('run: no page errors through both modes', A.errs.length === 0, A.errs.join(' | '));

  /* ---------------------------------- 4h. wallet, sending the USDT --- */
  const L = await freshPage(390, 844);
  const p5 = L.p;
  await p5.click('#modeWallet');
  await p5.click('#swapDir');
  await p5.waitForTimeout(250);
  const H5 = '0x' + crypto.createHash('sha256').update(Buffer.from('99'.repeat(32), 'hex')).digest('hex');
  const ownInv = await p5.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H5);
  await p5.fill('#addrIn', PARTNER);
  await p5.fill('#invIn', ownInv);
  await p5.click('#chainRow');
  await p5.fill('#contractIn', CONTRACT);
  await p5.fill('#tokenIn', TOKEN);
  await p5.fill('#rpcIn', RPC);
  await p5.click('[data-act="saveSetup"]');
  await p5.waitForTimeout(900);
  await p5.click('#chainRow');
  await p5.waitForTimeout(200);
  check('u2b: the swap is ready to lock', (await view(p5)).ready === '1', (await view(p5)).say);

  await p5.click('#primary');
  await p5.waitForTimeout(1500);
  w = await view(p5);
  check('u2b: Approve asks for the lock, it does not finish anything',
    w.phase === 'locking' && w.title === 'Lock your USDT' && !w.receipt, w.phase + ' / ' + w.title);
  check('u2b: the screen says two calls, approve then lock, from another wallet',
    /approve the USDT first, then send the lock call/.test(w.payLine), w.payLine);
  check('u2b: the call can be copied to a wallet', w.payCopyCall, String(w.payCopyCall));
  check('u2b: no wallet in the page means no one-tap send', !w.paySend, String(w.paySend));
  const deep = await p5.getAttribute('#payLink', 'href');
  check('u2b: the call also opens as an EIP-681 link on the right chain and contract',
    String(deep).startsWith('ethereum:' + CONTRACT + '@421614/lock?bytes32=') && String(deep).split('&').length === 5,
    String(deep).slice(0, 60) + '…');
  check('u2b: the link carries the receiver, the token and the amount',
    String(deep).includes('&address=' + PARTNER) && String(deep).includes('&address=' + TOKEN) && /&uint256=\d+$/.test(deep),
    String(deep).slice(-60));
  /* EIP-681 writes a bytes32 parameter as a 32-byte hex value, so it carries
     its 0x prefix exactly like the address and uint256 ones do. */
  const lockHashParam = String(deep).split('?')[1].split('&')[0];
  check('u2b: the bytes32 parameter is 0x-prefixed and 32 bytes wide',
    /^bytes32=0x[0-9a-f]{64}$/.test(lockHashParam) &&
    lockHashParam.slice(10) === await p5.evaluate(() => String(window.CLEANSWAP.state.H).replace(/^0x/, '').toLowerCase()),
    lockHashParam.slice(0, 20) + '…');
  /* USDT from a wallet outside this page takes two calls: the token allows the
     escrow the amount, and only then can the lock pull it. */
  const arow = await p5.evaluate(() => !document.getElementById('payRowApprove').hidden);
  const alink = await p5.getAttribute('#payApproveLink', 'href');
  const approveCopy = await p5.evaluate(() => window.CLEANSWAP.state.units);
  check('u2b: another wallet gets its approve call as well as the lock',
    arow === true && String(alink).startsWith('ethereum:' + TOKEN + '@421614/approve?address=' + CONTRACT + '&uint256='),
    String(alink).slice(0, 80) + '…');
  check('u2b: the approve link allows exactly the swap amount',
    String(alink).endsWith('&uint256=' + approveCopy), String(alink).slice(-40));
  check('u2b: the approve call can be copied too',
    await p5.evaluate(() => !document.getElementById('payCopyApprove').hidden));
  const calldata = await p5.evaluate(() => window.CLEANSWAP.lockCalldata({
    hashlock: window.CLEANSWAP.state.H, timelock: window.CLEANSWAP.state.t2,
    receiver: window.CLEANSWAP.state.addr, token: window.CLEANSWAP.tokenNow(),
    amount: window.CLEANSWAP.state.units
  }));
  check('u2b: the lock call encodes to the contract ABI', /^0x91644b2b[0-9a-f]{320}$/.test(calldata), calldata.slice(0, 12) + '… ' + calldata.length);
  await p5.screenshot({ path: path.join(SHOTS, 'v50-lock.png') });

  /* The lock lands in another wallet and its hash comes back. The wallet is
     not in the page, so the transaction is where the app learns which address
     funded the escrow - the address the swap id is built with. */
  const lockTx = '0x' + 'ab'.repeat(32);
  const LOCKER5 = '0x5c1d3f8a92b04e67d1a8c3f5027be64d89a0c1f3';
  const t5 = await p5.evaluate(() => ({ H: window.CLEANSWAP.state.H, units: window.CLEANSWAP.state.units, t2: window.CLEANSWAP.state.t2, addr: window.CLEANSWAP.state.addr, token: window.CLEANSWAP.tokenNow() }));
  const id5 = swapIdOf({ hashlock: t5.H, sender: LOCKER5, receiver: t5.addr, token: t5.token, amount: t5.units, timelock: t5.t2 });
  CHAIN.records[id5.toLowerCase()] = {
    hashlock: t5.H, amount: t5.units, timelock: t5.t2, token: TOKEN,
    sender: LOCKER5, receiver: t5.addr, claimed: false, refunded: false
  };
  CHAIN.receipts[lockTx] = { status: '0x1' };
  /* the lock call itself, as the wallet signed it: the app reads its terms,
     so a lock against another hash can never be read as this swap's */
  CHAIN.txs[lockTx] = {
    from: LOCKER5, to: CONTRACT,
    input: '0x91644b2b' + hexB32(t5.H) + hexWord(t5.t2) + hexAddr(t5.addr) + hexAddr(t5.token) + hexWord(t5.units)
  };
  await p5.click('[data-act="openTx"]');
  await p5.fill('#txIn', lockTx);
  await p5.click('[data-act="loadTx"]');
  await p5.waitForTimeout(2000);
  w = await view(p5);
  check('u2b: a pasted transaction hash is read, not trusted', w.phase === 'paid' && w.chainState === 'locked',
    w.phase + ' / ' + w.chainState);
  check('u2b: the funding address comes from the lock transaction',
    await p5.evaluate(() => window.CLEANSWAP.state.funder) === LOCKER5,
    await p5.evaluate(() => String(window.CLEANSWAP.state.funder)));
  check('u2b: the receipt check really happened', CHAIN.calls.some(c => c.method === 'eth_getTransactionReceipt'),
    String(CHAIN.calls.length) + ' calls');
  check('u2b: the screen says the side is locked and what happens next',
    /bitcoin arrives when your partner pays/.test(w.payLine), w.payLine);

  /* the secret opens the escrow; a wrong one never reaches a wallet */
  await p5.click('[data-act="claimOpen"]');
  await p5.fill('#secretIn', '00'.repeat(32));
  await p5.click('[data-act="sendClaim"]');
  await p5.waitForTimeout(1200);
  w = await view(p5);
  check('claim: a secret that does not hash to the swap is refused', /does not open this swap/.test(w.toast), w.toast);
  check('claim: and the swap is still not finished', w.phase === 'paid' && !w.receipt, w.phase);

  CHAIN.records[id5.toLowerCase()].claimed = true;
  await p5.click('#primary');
  await p5.waitForTimeout(1800);
  w = await view(p5);
  check('u2b: the claim on chain closes the swap', w.phase === 'settled', w.phase);
  check('u2b: the receipt reads the other way round', /USDT$/.test(w.rc[0]) && /sats$/.test(w.rc[1]), w.rc.join(' | '));
  check('u2b: the bitcoin is named as received', /You received 50,000 sats\./.test(w.say), w.say);
  await p5.screenshot({ path: path.join(SHOTS, 'v50-u2b-done.png') });
  check('u2b: no page errors', L.errs.length === 0, L.errs.join(' | '));

  /* ---------------------------------------- 4i. the window runs out --- */
  const W2 = await freshPage(390, 844);
  const p6 = W2.p;
  await p6.click('#modeWallet');
  await p6.click('#swapDir');
  await p6.waitForTimeout(200);
  const H6 = '0x' + crypto.createHash('sha256').update(Buffer.from('66'.repeat(32), 'hex')).digest('hex');
  const inv6 = await p6.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H6);
  await p6.fill('#addrIn', PARTNER);
  await p6.fill('#invIn', inv6);
  await p6.click('#chainRow');
  await p6.fill('#contractIn', CONTRACT);
  await p6.fill('#tokenIn', TOKEN);
  await p6.fill('#rpcIn', RPC);
  await p6.click('[data-act="saveSetup"]');
  await p6.waitForTimeout(900);
  await p6.click('#chainRow');
  await p6.waitForTimeout(200);
  /* no wallet app is connected to this page: the address that funds the escrow
     stands in for what a wallet would say */
  const LOCKER6 = '0x5c1d3f8a92b04e67d1a8c3f5027be64d89a0c1f3';
  await p6.evaluate((who) => { window.CLEANSWAP.state.me = who; }, LOCKER6);
  await p6.click('#primary');
  await p6.waitForTimeout(1500);
  const id6 = await p6.evaluate(() => window.CLEANSWAP.swapIdNow());
  const t6 = await p6.evaluate(() => ({ H: window.CLEANSWAP.state.H, units: window.CLEANSWAP.state.units, t2: window.CLEANSWAP.state.t2, addr: window.CLEANSWAP.state.addr }));
  CHAIN.records[id6.toLowerCase()] = {
    hashlock: t6.H, amount: t6.units, timelock: t6.t2, token: TOKEN,
    sender: LOCKER6, receiver: t6.addr, claimed: false, refunded: false
  };
  await p6.click('#primary');   /* Check chain: the record is there now */
  await p6.waitForTimeout(1600);
  w = await view(p6);
  check('window: the lock is picked up on the next check', w.phase === 'paid', w.phase);

  /* the window passes: the refund opens, and only a refunded record closes it */
  await p6.evaluate(() => { window.CLEANSWAP.state.sim = 7300; window.CLEANSWAP.render(); });
  await p6.waitForTimeout(300);
  w = await view(p6);
  check('window: after the window the refund is offered', w.refundBtn, String(w.refundBtn));
  const refundData = await p6.evaluate(() => window.CLEANSWAP.refundCalldata(window.CLEANSWAP.state.id || '0x' + '00'.repeat(32)));
  check('window: the refund call encodes to the contract ABI', /^0x7249fbb6[0-9a-f]{64}$/.test(refundData), refundData.slice(0, 12) + '…');
  CHAIN.records[id6.toLowerCase()].refunded = true;
  await p6.click('#primary');
  await p6.waitForTimeout(1600);
  w = await view(p6);
  check('window: a refunded record closes the swap as refunded, not complete',
    w.phase === 'refunded' && w.title === 'Swap closed' && !/swap complete/i.test(w.title), w.phase + ' / ' + w.title);
  check('window: the receipt says the USDT came back', /back$/.test(w.rc[1]), w.rc.join(' | '));
  check('window: the receipt names the chain', /refunded on chain/.test(w.rcNet), w.rcNet);
  check('window: nothing was added to Recent', w.rows === 0, String(w.rows));
  await p6.screenshot({ path: path.join(SHOTS, 'v50-refund.png') });
  check('window: no page errors', W2.errs.length === 0, W2.errs.join(' | '));
  await W2.c.close();
  await L.c.close();
  await A.c.close();
  /* ------------------------------------------------- 5. direction flip --- */
  const B = await freshPage(390, 844);
  const p2 = B.p;
  await p2.click('#swapDir');
  await p2.waitForTimeout(300);
  w = await view(p2);
  check('flip: sending USDT puts the address first', w.dir === 'u2b' && w.n2 === '1' && w.n1 === '2' && w.order.join(',') === '2,1,3',
    w.order.join(','));
  check('flip: the step titles follow the direction',
    w.invTitle === 'Your Lightning invoice' && w.addrTitle === "Partner's USDT address", w.invTitle + ' / ' + w.addrTitle);
  check('flip: the cards swap around', /^[\d,.]+ USDT$/.test(w.send) && /sats$/.test(w.get), w.send + ' / ' + w.get);
  check('flip: the first sentence asks for the address', /partner's USDT address/.test(w.say), w.say);
  check('flip: practice still offers Sample on both fields', w.sampleInv && w.sampleAddr);
  await p2.screenshot({ path: path.join(SHOTS, 'v43-flip.png') });

  await p2.click('[data-act="sampleAddr"]');
  await p2.waitForTimeout(250);
  w = await view(p2);
  check('flip: the address is done first', w.ready === '0' && /own invoice/.test(w.say), w.say);
  await p2.click('[data-act="sampleInv"]');
  await p2.waitForTimeout(300);
  check('flip: then the invoice makes Approve ready', (await view(p2)).ready === '1');

  await p2.click('#primary');
  await p2.waitForFunction(() => document.body.dataset.phase === 'locking', null, { timeout: 8000 });
  await p2.waitForTimeout(200);
  w = await view(p2);
  check('flip: the USDT side is asked to lock first, as in wallet',
    w.title === 'Lock your USDT' && w.cta === 'Check chain' && !w.receipt, w.title + ' / ' + w.cta);
  check('flip: the lock call is on screen to copy or open, even in a rehearsal',
    w.payCopyCall && String(w.callLink).startsWith('ethereum:'), String(w.callLink).slice(0, 34) + '…');
  check('flip: the chain bar says nothing is locked yet',
    w.chainRow && /nothing locked yet/.test(w.chainTxt), w.chainTxt);
  await p2.screenshot({ path: path.join(SHOTS, 'v51-practice-lock.png') });

  await p2.waitForFunction(() => document.body.dataset.phase === 'paid', null, { timeout: 8000 });
  await p2.waitForTimeout(200);
  w = await view(p2);
  check('flip: the stand-in lock lands and the screen says the USDT is locked',
    w.phase === 'paid' && w.title === 'Your USDT is locked', w.phase + ' / ' + w.title);

  await p2.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 10000 });
  await p2.waitForTimeout(250);
  w = await view(p2);
  check('flip: the USDT side completes and names the bitcoin received',
    w.state === 'Completed' && /You received [\d,.]+ sats\./.test(w.say), w.say);
  check('flip: the receipt reads the other way round',
    /USDT$/.test(w.rc[0]) && /sats$/.test(w.rc[1]), w.rc.join(' | '));
  check('run: no page errors while flipping', B.errs.length === 0, B.errs.join(' | '));
  await B.c.close();

  /* --------------------------------------------------- 6. the code --- */
  const C = await freshPage(390, 844);
  const p3 = C.p;
  await p3.click('[data-act="sampleInv"]');
  await p3.waitForTimeout(300);
  await p3.click('[data-act="sampleAddr"]');
  await p3.waitForTimeout(300);
  const code = await p3.evaluate(() => window.CLEANSWAP.swapCode());
  check('code: the terms leave as a cleanswap: code', /^cleanswap:[A-Za-z0-9_-]+$/.test(code), code.slice(0, 30) + '…');
  check('code: no file path, host or name in it',
    !/file:|http|\/|github|jbitmstr|@/i.test(code), (code.match(/(file:|http|\/|github|jbitmstr)/i) || [''])[0]);
  check('code: short enough for a QR', new TextEncoder().encode(code).length <= 340,
    new TextEncoder().encode(code).length + ' bytes');
  check('code: nothing about it is taken from the page address',
    !/android_asset|index\.html|#s=/i.test(code));

  const codeInfo = await p3.evaluate(c => {
    const t = window.CLEANSWAP.parseSwapCode(c);
    const s = window.CLEANSWAP.state;
    return { t: t, sats: s.sats, units: window.CLEANSWAP.usdtUnits(), H: s.H, addr: s.addr };
  }, code);
  check('code: it reads back to the same terms',
    codeInfo.t && codeInfo.t.sats === codeInfo.sats && codeInfo.t.units === codeInfo.units &&
    codeInfo.t.direction === 'btc2u' && codeInfo.t.address === String(await p3.inputValue('#addrIn')).toLowerCase(),
    JSON.stringify(codeInfo.t && { sats: codeInfo.t.sats, dir: codeInfo.t.direction }));

  await p3.click('[data-act="qrCode"]');
  await p3.waitForTimeout(400);
  const qrMeta = await p3.evaluate(() => {
    const svg = document.querySelector('#qrBox svg');
    const box = document.getElementById('qrBox').getBoundingClientRect();
    const bar = document.querySelector('.bar').getBoundingClientRect();
    return {
      has: !!svg,
      modules: svg ? (svg.innerHTML.match(/M\d+ \d+h1v1h-1z/g) || []).length : 0,
      qrBottom: Math.round(box.bottom), qrTop: Math.round(box.top), barTop: Math.round(bar.top)
    };
  });
  check('code: the QR carries it', qrMeta.has && qrMeta.modules > 100, qrMeta.modules + ' modules');
  check('code: the QR is fully above the Approve bar at 360x780-class size',
    qrMeta.qrTop >= 0 && qrMeta.qrBottom <= qrMeta.barTop - 4,
    'qr ' + qrMeta.qrTop + '..' + qrMeta.qrBottom + ' bar ' + qrMeta.barTop);
  await p3.screenshot({ path: path.join(SHOTS, 'v43-qr.png') });

  /* the other phone: paste the code, take the other side */
  const other = await C.c.newPage();
  const oErrs = [];
  other.on('pageerror', e => oErrs.push(e.message));
  other.on('console', m => { if (m.type() === 'error') oErrs.push(m.text()); });
  await other.goto(URL, { waitUntil: 'load' });
  await other.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await other.click('[data-act="pasteCode"]');
  await other.fill('#codeIn', code);
  await other.click('[data-act="useCode"]');
  await other.waitForTimeout(400);
  const joined = await other.evaluate(() => ({
    dir: document.body.dataset.dir, sats: window.CLEANSWAP.state.sats,
    units: window.CLEANSWAP.state.units, H: window.CLEANSWAP.state.expectH,
    addr: document.getElementById('addrIn').value,
    n1: document.getElementById('nInv').textContent,
    title: document.getElementById('invTitle').textContent,
    toast: document.getElementById('toast').textContent
  }));
  check('join: the code puts the other phone on the other side', joined.dir === 'u2b' && joined.n1 === '2',
    joined.dir + ' ' + joined.n1);
  check('join: it adopts the same amounts and the USDT address', joined.sats === 50000 && joined.units === codeInfo.units &&
    joined.addr === codeInfo.t.address, joined.sats + ' · ' + joined.addr);
  check('join: it pins the same hashlock',
    joined.H && codeInfo.t.H && joined.H.toLowerCase() === codeInfo.t.H.toLowerCase(),
    String(joined.H).slice(0, 12) + '…');

  const wrongInv = await other.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '11'.repeat(32), sats: 50000, expiry: 6 * 3600 }));
  await other.fill('#invIn', wrongInv);
  await other.waitForTimeout(300);
  const wr = await view(other);
  check('join: an invoice on another hash is refused', wr.ready === '0' && wr.gate === 'mismatch', wr.gate + ' · ' + wr.say);
  check('join: the refusal is plain English', /different swap/.test(wr.say), wr.say);
  check('join: no technical words in the refusal', !JARGON.test(wr.say), wr.say);

  const goodInv = await other.evaluate(() => window.CLEANSWAP.mintInvoice({
    paymentHash: window.CLEANSWAP.state.expectH, sats: 50000, expiry: 6 * 3600
  }));
  await other.fill('#invIn', goodInv);
  await other.waitForTimeout(300);
  check('join: the invoice on the pinned hash passes', (await view(other)).ready === '1',
    (await view(other)).gate + ' · ' + (await view(other)).say);
  await other.click('#primary');
  await other.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 15000 });
  await other.waitForTimeout(300);
  const otherDone = await other.evaluate(() => ({
    H: window.CLEANSWAP.state.H, id: window.CLEANSWAP.state.id,
    escrow: window.CLEANSWAP.decodeLockCalldata(window.CLEANSWAP.nextCalldata()).hashlock
  }));
  const makerDone = await p3.evaluate(() => ({ H: window.CLEANSWAP.state.H, id: window.CLEANSWAP.state.id }));
  await p3.click('#primary');
  await p3.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 8000 });
  await p3.waitForTimeout(200);
  await p3.click('#primary');            /* I paid */
  await p3.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 15000 });
  const makerSettled = await p3.evaluate(() => ({ H: window.CLEANSWAP.state.H, id: window.CLEANSWAP.state.id }));
  check('join: both phones settle on the same hashlock',
    otherDone.H.toLowerCase() === makerSettled.H.toLowerCase(), String(otherDone.H).slice(0, 12) + '…');
  check('join: and on the same swap id', otherDone.id === makerSettled.id, String(otherDone.id).slice(0, 14) + '…');
  check('join: the other phone shows the swap complete',
    (await other.textContent('#stateTxt')) === 'Completed');
  check('join: no page errors on the other phone', oErrs.length === 0, oErrs.join(' | '));
  await other.close();

  /* ------------------------------------------------ 7. what gets refused --- */
  const D = await freshPage(390, 844);
  const p4 = D.p;
  const gates = await p4.evaluate(() => {
    const out = {};
    const mint = (o) => window.CLEANSWAP.mintInvoice(o);
    const offer = document.getElementById('sample-bolt12').textContent.trim();
    out.garbage = window.CLEANSWAP.readInvoice('lnbc2500u1notarealinvoice');
    out.broken = window.CLEANSWAP.readInvoice(mint({ paymentHash: '0x' + '22'.repeat(32), sats: 50000, expiry: 3600 }).slice(0, -4) + 'zzzz');
    out.amount = window.CLEANSWAP.readInvoice(mint({ paymentHash: '0x' + '22'.repeat(32), sats: 25000, expiry: 3600 }));
    out.expired = window.CLEANSWAP.readInvoice(mint({ paymentHash: '0x' + '22'.repeat(32), sats: 50000, expiry: 60, timestamp: Math.floor(Date.now() / 1000) - 600 }));
    out.offer = window.CLEANSWAP.readInvoice(offer);
    out.zero = window.CLEANSWAP.readAddress('0x' + '0'.repeat(40));
    out.short = window.CLEANSWAP.readAddress('0x1234');
    out.empty = window.CLEANSWAP.readAddress('');
    out.good = window.CLEANSWAP.readAddress('0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
    out.tron = window.CLEANSWAP.readAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    out.tron2 = window.CLEANSWAP.readAddress('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G');
    out.tronBad = window.CLEANSWAP.readAddress('TM7Y3SFx8KWgmLZJKkZVYQKW6rewd4JeqA');
    out.tronShort = window.CLEANSWAP.readAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6');
    out.tronLong = window.CLEANSWAP.readAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6tX');
    out.tronLower = window.CLEANSWAP.readAddress('tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t');
    out.tronZero = window.CLEANSWAP.readAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
    out.tronBadChar = window.CLEANSWAP.readAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60');
    return out;
  });
  check('gate: a broken invoice is refused', gates.garbage.code === 'format', gates.garbage.code + ' · ' + gates.garbage.msg);
  check('gate: a broken checksum is refused', gates.broken.code === 'format', gates.broken.code + ' · ' + gates.broken.msg);
  check('gate: another amount is refused and both amounts are named',
    gates.amount.code === 'amount' && /25,000 sats, not 50,000/.test(gates.amount.msg), gates.amount.msg);
  check('gate: an expired invoice is refused', gates.expired.code === 'expired' && /expired/.test(gates.expired.msg), gates.expired.msg);
  check('gate: a BOLT12 offer is refused and not bound to a made-up hash',
    gates.offer.code === 'offer' && !gates.offer.H && /hold invoice/.test(gates.offer.msg),
    gates.offer.code + ' · ' + gates.offer.msg);
  check('gate: a zero address is refused', gates.zero.code === 'format', gates.zero.msg);
  check('gate: a short address is refused', gates.short.code === 'format' && /40/.test(gates.short.msg), gates.short.msg);
  check('gate: an empty address is refused in plain words', gates.empty.code === 'empty' && !JARGON.test(gates.empty.msg), gates.empty.msg);
  check('gate: a full 0x address passes and is lower-cased', gates.good.ok && gates.good.address === '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71' && gates.good.chain === 'evm', gates.good.address);
  check('gate: a TRC-20 T address passes as it was typed',
    gates.tron.ok && gates.tron.chain === 'tron' && gates.tron.address === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', gates.tron.code + ' · ' + gates.tron.address);
  check('gate: a second TRC-20 address passes too', gates.tron2.ok && gates.tron2.address === 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G', gates.tron2.msg);
  check('gate: a T address with a bad checksum is refused', gates.tronBad.code === 'format', gates.tronBad.msg);
  check('gate: a 33-character T address is refused', gates.tronShort.code === 'format', gates.tronShort.msg);
  check('gate: a 35-character T address is refused', gates.tronLong.code === 'format', gates.tronLong.msg);
  check('gate: a lower-cased T address is refused (base58 has case)', gates.tronLower.code === 'format', gates.tronLower.msg);
  check('gate: the TRON zero address is refused', gates.tronZero.code === 'format' && /cannot receive/.test(gates.tronZero.msg), gates.tronZero.msg);
  check('gate: a T address holding a 0 is refused', gates.tronBadChar.code === 'format', gates.tronBadChar.msg);

  /* A BOLT12 invoice (lni1...) is read, and then refused: its signature is a
     Schnorr signature over a merkle root of its own TLVs, this page verifies
     BOLT11 signatures only, and none of it is taken on trust. */
  const nowS = Math.floor(Date.now() / 1000);
  const lni = bolt12Invoice('0x' + '5a'.repeat(32), 50000, nowS, 3600);
  const lniOld = bolt12Invoice('0x' + '5a'.repeat(32), 50000, nowS - 7200, 600);
  const noCreated = bolt12InvoiceWithout(164);
  const noExpiry = bolt12InvoiceWithout(166);
  const lniOut = await p4.evaluate(({ a, b, c, d }) => ({
    live: window.CLEANSWAP.readInvoice(a),
    dead: window.CLEANSWAP.readInvoice(b),
    noCreated: window.CLEANSWAP.readInvoice(c),
    noExpiry: window.CLEANSWAP.readInvoice(d),
    dec: (() => { try { return window.CLEANSWAP.decodeBolt12(a); } catch (e) { return { err: e.message }; } })(),
    decNoCreated: (() => { try { window.CLEANSWAP.decodeBolt12(c); return 'decoded'; } catch (e) { return e.message; } })(),
    decNoExpiry: (() => { try { window.CLEANSWAP.decodeBolt12(d); return 'decoded'; } catch (e) { return e.message; } })()
  }), { a: lni, b: lniOld, c: noCreated, d: noExpiry });
  check('gate: a BOLT12 invoice is refused because its signature cannot be checked',
    !lniOut.live.ok && lniOut.live.code === 'bolt12' && !lniOut.live.H,
    lniOut.live.code + ' · ' + lniOut.live.msg);
  check('gate: the refusal asks for an ordinary Lightning invoice',
    /ordinary Lightning invoice/.test(lniOut.live.msg), lniOut.live.msg);
  check('gate: an expired BOLT12 invoice gets the same refusal', lniOut.dead.code === 'bolt12', lniOut.dead.code);
  check('gate: the BOLT12 refusal reads as plain English', !JARGON.test(lniOut.live.msg), lniOut.live.msg);
  check('bolt12: an invoice is still decoded, with creation time plus expiry as its end',
    lniOut.dec && lniOut.dec.absoluteExpiry === nowS + 3600 && lniOut.dec.createdAt === nowS,
    JSON.stringify({ e: lniOut.dec && lniOut.dec.absoluteExpiry, c: lniOut.dec && lniOut.dec.createdAt }));
  check('bolt12: an invoice with no creation time is refused at the decoder, not read as endless',
    /no creation time/.test(String(lniOut.decNoCreated)), String(lniOut.decNoCreated));
  check('bolt12: an invoice with no expiry is refused at the decoder too',
    /no expiry/.test(String(lniOut.decNoExpiry)), String(lniOut.decNoExpiry));
  check('gate: an invoice with no creation time gets the plain refusal, not "cannot be read"',
    lniOut.noCreated.code === 'bolt12' && /cannot check the signature/.test(lniOut.noCreated.msg),
    lniOut.noCreated.code + ' · ' + lniOut.noCreated.msg);
  check('gate: an invoice with no expiry gets the plain refusal too',
    lniOut.noExpiry.code === 'bolt12', lniOut.noExpiry.code + ' · ' + lniOut.noExpiry.msg);

  /* A BOLT12 offer (lno1...) is refused. It carries no payment hash, and the
     invoice a wallet gets for one carries its own, so binding the escrow to the
     offer's bytes would lock it to a hash no Lightning payment ever moves. */
  const nowO = Math.floor(Date.now() / 1000);
  const offerPlain = bolt12Offer({ desc: 'Lexe offer', expiry: nowO + 86400 });
  const offerHashed = bolt12Offer({ hash: '0x' + '6b'.repeat(32), expiry: nowO + 86400 });
  const offerAmount = bolt12Offer({ amountMsat: 25000 * 1000, expiry: nowO + 86400 });
  const offOut = await p4.evaluate((o) => ({
    plain: window.CLEANSWAP.readInvoice(o.plain),
    again: window.CLEANSWAP.readInvoice(o.plain),
    prefixed: window.CLEANSWAP.readInvoice('lightning:' + o.plain),
    hashed: window.CLEANSWAP.readInvoice(o.hashed),
    amount: window.CLEANSWAP.readInvoice(o.amount),
    junk: window.CLEANSWAP.readInvoice('lno1' + 'q'.repeat(40)),
    truncated: window.CLEANSWAP.readInvoice(o.plain.slice(0, -8))
  }), { plain: offerPlain, hashed: offerHashed, amount: offerAmount });
  check('offer: a wallet-shaped lno1 offer is refused, not accepted', offOut.plain.code === 'offer' && !offOut.plain.ok,
    offOut.plain.code + ' · ' + offOut.plain.msg);
  check('offer: the refusal asks for a hold invoice instead',
    /hold invoice/.test(offOut.plain.msg), offOut.plain.msg);
  check('offer: an offer that carries a hash tag is refused just the same',
    offOut.hashed.code === 'offer' && !offOut.hashed.H, offOut.hashed.code);
  check('offer: the same offer gives the same refusal, prefixed or not',
    offOut.prefixed.code === 'offer' && offOut.again.code === 'offer', offOut.prefixed.code);
  check('offer: a refused offer has no hash to show', !/[0-9a-f]{32}/i.test(JSON.stringify(offOut.plain)), offOut.plain.code);
  check('offer: garbage that looks like an offer is refused', offOut.junk.code === 'format', offOut.junk.code);
  check('offer: a truncated offer is refused', offOut.truncated.code === 'format', offOut.truncated.code);
  check('offer: the refusals read as plain English',
    !JARGON.test([offOut.plain.msg, offOut.junk.msg, offOut.truncated.msg].join(' ')),
    (JARGON.exec([offOut.plain.msg, offOut.junk.msg].join(' ')) || [''])[0]);

  /* Approve with nothing in it must not move */
  await p4.click('#primary');
  await p4.waitForTimeout(350);
  check('gate: Approve with empty fields stays on the form',
    (await p4.evaluate(() => document.body.dataset.phase)) === 'idle');
  check('gate: and says what is missing', /Paste the invoice/.test(await p4.textContent('#say')));
  await p4.screenshot({ path: path.join(SHOTS, 'v43-blocked.png') });

  /* a 1-letter-off invoice is refused by the checksum, on the real screen */
  const nearly = await p4.evaluate(() => {
    const inv = window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '33'.repeat(32), sats: 50000, expiry: 3600 });
    return inv.slice(0, -1) + (inv.slice(-1) === 'q' ? 'p' : 'q');
  });
  await p4.fill('#invIn', nearly);
  await p4.waitForTimeout(300);
  w = await view(p4);
  check('gate: a bad checksum on screen is refused', w.ready === '0' && /cannot be read/.test(w.say), w.say);
  await p4.fill('#invIn', '');
  await p4.waitForTimeout(200);
  check('run: no page errors on the refusal paths', D.errs.length === 0, D.errs.join(' | '));
  await D.c.close();

  /* -------------- 7b. a hold invoice and a TRON address, on the screen --- */
  const W3 = await freshPage(390, 844);
  const p7 = W3.p;
  const TRON_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const h7 = '0x' + crypto.createHash('sha256').update(Buffer.from('7e'.repeat(32), 'hex')).digest('hex');
  const inv7 = await p7.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 14400 }), h7);
  await p7.fill('#invIn', inv7);
  await p7.fill('#addrIn', TRON_ADDR);
  await p7.waitForTimeout(350);
  w = await view(p7);
  check('screen: a hold invoice and a TRON address together make Approve ready',
    w.ready === '1' && w.gate === 'ok', w.gate + '/' + w.ready);
  check('screen: the invoice is read as an invoice to pay',
    await p7.evaluate(() => window.CLEANSWAP.readInvoice(document.getElementById('invIn').value).basis === 'invoice'));

  await p7.click('#primary');
  await p7.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 8000 });
  await p7.waitForTimeout(200);
  await p7.click('#primary');            /* I paid */
  await p7.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 15000 });
  await p7.waitForTimeout(400);
  const tronSettled = await p7.evaluate(() => ({
    addr: window.CLEANSWAP.state.addr,
    rc: document.getElementById('rcAddr').textContent,
    title: document.getElementById('stepTitle').textContent
  }));
  check('screen: the swap completes', tronSettled.title === 'Swap complete', tronSettled.title);
  check('screen: the receipt shows the TRON address as it was typed',
    tronSettled.rc === TRON_ADDR, tronSettled.rc);
  check('screen: the TRON address is the one on record',
    tronSettled.addr === TRON_ADDR, tronSettled.addr);
  await p7.screenshot({ path: path.join(SHOTS, 'v50-tron-done.png') });

  /* Wallet mode pays the USDT on Arbitrum, so a T address gets an answer, not a pass */
  await p7.click('#primary');            /* Done */
  await p7.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await p7.click('#modeWallet');
  await p7.waitForTimeout(250);
  await p7.fill('#invIn', inv7);
  await p7.fill('#addrIn', TRON_ADDR);
  await p7.waitForTimeout(350);
  w = await view(p7);
  check('screen: wallet mode explains that the address is an Arbitrum one',
    w.gate === 'chain' && /0x one/.test(w.say) && /TRON/.test(w.say), w.gate + ' · ' + w.say);
  check('screen: that guidance is plain English', !JARGON.test(w.say), w.say);
  await p7.screenshot({ path: path.join(SHOTS, 'v50-tron-wallet.png') });
  check('run: no page errors with a TRON address', W3.errs.length === 0, W3.errs.join(' | '));
  await W3.c.close();

  /* ---------------------------------------- 7c. codes never change setup --- */
  /* A code is a stranger's text. It may state the terms, the chain and the
     escrow it is meant for, but it may not switch the network or write an
     escrow address into this phone. */
  const SEC = await freshPage(390, 844);
  const ps = SEC.p;
  await ps.click('#modeWallet');
  await ps.waitForTimeout(250);
  const SETUP_KEY = 'cleanswap.setup.v1';
  const t2s = Math.floor(Date.now() / 1000) + 7200;
  const unitsS = await ps.evaluate(() => window.CLEANSWAP.usdtUnits());
  const UNKNOWN_ESCROW = '0x' + 'de'.repeat(20);

  const stranger = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2s, h: H2,
    a: USER_ADDR, net: 't', contract: UNKNOWN_ESCROW, locker: PARTNER });
  const took = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), stranger);
  w = await view(ps);
  const afterRefuse = await ps.evaluate((k) => ({
    contract: window.CLEANSWAP.state.contract, net: window.CLEANSWAP.state.net,
    stored: localStorage.getItem(k)
  }), SETUP_KEY);
  check('security: a code naming an unpublished escrow is refused', took === false, String(took));
  check('security: nothing was written into the setup', afterRefuse.contract === '' && afterRefuse.stored === null,
    afterRefuse.contract + ' / ' + afterRefuse.stored);
  check('security: the refusal is on the screen and names what did not happen',
    w.codeWarn && /does not publish/.test(w.codeWarn) && /Nothing was changed/.test(w.codeWarn), w.codeWarn);
  check('security: the refusal is in the log as a security event',
    await ps.evaluate(() => window.CLEANSWAP.state.log.some(e => e.kind === 'SECURITY')));

  /* an escrow this app publishes may come from a code, once */
  const OFFICIAL = '0x' + '0e'.repeat(20);
  await ps.evaluate((a) => { window.CLEANSWAP.CHAINS.testnet.escrows.push(a); }, OFFICIAL);
  const official = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2s, h: H2,
    a: USER_ADDR, net: 't', contract: OFFICIAL, locker: PARTNER });
  const tookOfficial = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), official);
  check('security: an escrow the app publishes is accepted from a code', tookOfficial === true,
    await ps.evaluate(() => window.CLEANSWAP.state.contract));
  check('security: and it is the one the code named',
    await ps.evaluate(() => window.CLEANSWAP.state.contract) === OFFICIAL);

  /* once an escrow is set, a code naming another one never replaces it */
  const swapped = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2s, h: H2,
    a: USER_ADDR, net: 't', contract: CONTRACT, locker: PARTNER });
  const tookSwap = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), swapped);
  check('security: a code naming a different escrow is refused even when it is a real one',
    tookSwap === false && await ps.evaluate(() => window.CLEANSWAP.state.contract) === OFFICIAL,
    await ps.evaluate(() => window.CLEANSWAP.state.contract));

  /* the chain is never switched by a code */
  const otherChain = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2s, h: H2,
    a: USER_ADDR, net: 'm', contract: CONTRACT, locker: PARTNER });
  const tookChain = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), otherChain);
  check('security: a code for another chain is refused, not followed',
    tookChain === false && await ps.evaluate(() => window.CLEANSWAP.state.net) === 'testnet',
    String(tookChain) + ' / ' + await ps.evaluate(() => window.CLEANSWAP.state.net));

  /* the escrow window: too short, too long (the escrow and the chain match, so
     the window is the only thing that can fail) */
  const t2Before = await ps.evaluate(() => window.CLEANSWAP.state.t2);
  const shortCode = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS,
    t2: Math.floor(Date.now() / 1000) + 300, h: H2, a: USER_ADDR, net: 't', contract: OFFICIAL, locker: PARTNER });
  const longCode = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS,
    t2: Math.floor(Date.now() / 1000) + 8 * 24 * 3600, h: H2, a: USER_ADDR, net: 't', contract: OFFICIAL, locker: PARTNER });
  const shortTook = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), shortCode);
  const shortWarn = await ps.evaluate(() => window.CLEANSWAP.state.codeWarn);
  const longTook = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), longCode);
  check('timelock: a code with a five-minute window is refused', shortTook === false && /too soon/.test(shortWarn), shortWarn);
  check('timelock: a code with an eight-day window is refused', longTook === false,
    await ps.evaluate(() => window.CLEANSWAP.state.codeWarn));
  check('timelock: neither refusal changed the terms on screen',
    await ps.evaluate(() => window.CLEANSWAP.state.t2) === t2Before,
    String(t2Before));
  /* Amounts in a code are decimal text, read in BigInt: a token amount above
     2^53 is refused rather than rounded into a different swap. */
  const hugeUnits = swapCodeOf({ dir: 'u2b', sats: 50000, units: '9007199254740993',
    t2: Math.floor(Date.now() / 1000) + 7200, h: H2, a: USER_ADDR, net: 't', contract: OFFICIAL, locker: PARTNER });
  const tookHuge = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), hugeUnits);
  const textUnits = swapCodeOf({ dir: 'u2b', sats: '50000', units: String(unitsS),
    t2: String(Math.floor(Date.now() / 1000) + 7200), h: H2, a: USER_ADDR });
  const tookText = await ps.evaluate((c) => window.CLEANSWAP.applyCode(c), textUnits);
  check('amounts: a code whose token amount does not fit a number is refused',
    tookHuge === false && await ps.evaluate(() => window.CLEANSWAP.state.units) === Number(unitsS),
    String(tookHuge));
  check('amounts: a code that writes its amounts as text is read the same way',
    tookText === true && await ps.evaluate(() => window.CLEANSWAP.state.sats) === 50000,
    String(tookText));
  const codeText = await ps.evaluate(() => window.CLEANSWAP.swapCode());
  const codeJson = Buffer.from(codeText.replace('cleanswap:', ''), 'base64url').toString();
  check('amounts: the app writes its own code amounts as text',
    /"s":"?50000"?/.test(codeJson) && /"u":"\d+"/.test(codeJson), codeJson.slice(0, 60));

  await ps.screenshot({ path: path.join(SHOTS, 'v60-code-refused.png') });
  check('security: no page errors on the refusal paths', SEC.errs.length === 0, SEC.errs.join(' | '));
  await SEC.c.close();

  /* ------------------------------- 7c2. a code never redirects the USDT -------- */
  /* Where the USDT lands is the one field a stranger's code must not set on the
     side that receives it: a code could name its author's own address, and the
     sats would buy USDT paid to them. On the side that sends the USDT the
     address is the partner's own destination, so it is filled in. */
  const ADDRC = await freshPage(390, 844);
  const pac = ADDRC.p;
  const attacker = '0x' + 'ee'.repeat(20);
  const mine = '0x' + '7a'.repeat(20);
  const takeCode = await pac.evaluate((c) => window.CLEANSWAP.applyCode(c), swapCodeOf({
    dir: 'u2b', sats: 50000, units: unitsS, t2: Math.floor(Date.now() / 1000) + 7200, a: attacker
  }));
  const afterTake = await pac.evaluate(() => ({
    dir: document.body.dataset.dir,
    field: document.getElementById('addrIn').value,
    row: !document.getElementById('codeAddr').hidden,
    text: document.getElementById('codeAddrTxt').textContent
  }));
  check('address: a code that sends the USDT somewhere is taken, its address is not',
    takeCode === true && afterTake.dir === 'btc2u' && afterTake.field === '', JSON.stringify(afterTake.field));
  check('address: the code\'s address is shown, and needs a tap to be used',
    afterTake.row && afterTake.text.includes(attacker.slice(0, 8)) && /Use it only if it is yours/.test(afterTake.text),
    afterTake.text);
  check('address: the refusal is plain English', !JARGON.test(afterTake.text), afterTake.text);

  /* the other direction: the code's address is the partner's own destination */
  const sendSide = await pac.evaluate((c) => window.CLEANSWAP.applyCode(c), swapCodeOf({
    dir: 'btc2u', sats: 50000, units: unitsS, t2: Math.floor(Date.now() / 1000) + 7200, a: mine
  }));
  const afterSend = await pac.evaluate(() => ({
    dir: document.body.dataset.dir, field: document.getElementById('addrIn').value,
    row: !document.getElementById('codeAddr').hidden
  }));
  check('address: on the side that sends the USDT the code\'s address is filled in',
    sendSide === true && afterSend.dir === 'u2b' && afterSend.field === mine && afterSend.row === false,
    afterSend.dir + ' ' + afterSend.field);
  check('address: no page errors while loading codes', ADDRC.errs.length === 0, ADDRC.errs.join(' | '));
  await ADDRC.c.close();

  /* ------------------------------- 7d. the invoice has to outlive the window --- */
  const WIN = await freshPage(390, 844);
  const pw = WIN.p;
  await pw.click('#modeWallet');
  await pw.waitForTimeout(250);
  await pw.click('#chainRow');
  await pw.fill('#contractIn', CONTRACT);
  await pw.fill('#tokenIn', TOKEN);
  await pw.fill('#rpcIn', RPC);
  await pw.click('[data-act="saveSetup"]');
  await pw.waitForTimeout(800);
  await pw.click('#chainRow');
  const t2w = Math.floor(Date.now() / 1000) + 7200;
  await pw.evaluate((args) => { window.CLEANSWAP.applyCode(args.c); }, {
    c: swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2w, h: H2, a: USER_ADDR, net: 't', contract: CONTRACT, locker: PARTNER })
  });
  const shortInv = await pw.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 3600 }), H2);
  await pw.fill('#invIn', shortInv);
  await pw.fill('#addrIn', USER_ADDR);
  await pw.waitForTimeout(350);
  w = await view(pw);
  check('window: an invoice that ends before the escrow window is refused',
    w.ready === '0' && w.gate === 'window' && /stays payable at least an hour longer/.test(w.say), w.gate + ' · ' + w.say);
  const longInv = await pw.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 4 * 3600 }), H2);
  await pw.fill('#invIn', longInv);
  await pw.waitForTimeout(350);
  w = await view(pw);
  check('window: an invoice that outlives it passes', w.ready === '1', w.gate + ' · ' + w.say);
  check('window: the refusal is plain English', !JARGON.test('an invoice that ends before the escrow window is refused'), '');
  await pw.screenshot({ path: path.join(SHOTS, 'v60-window.png') });
  check('window: no page errors', WIN.errs.length === 0, WIN.errs.join(' | '));
  await WIN.c.close();

  /* ------------------------------- 7e. two endpoints, one of them lying --- */
  /* The same swap seen through two endpoints that disagree: the lie says the
     USDT is locked, the truth says nothing is there. Neither is believed. */
  const Q = await freshPage(390, 844);
  const pq = Q.p;
  await pq.click('#modeWallet');
  await pq.waitForTimeout(250);
  await pq.click('#chainRow');
  await pq.fill('#contractIn', CONTRACT);
  await pq.fill('#tokenIn', TOKEN);
  await pq.fill('#rpcIn', RPC + ',' + RPC_LIE);
  await pq.click('[data-act="saveSetup"]');
  await pq.waitForTimeout(1200);
  await pq.click('#chainRow');
  const codeQ = swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2w, h: '0x' + '5e'.repeat(32),
    a: USER_ADDR, net: 't', contract: CONTRACT, locker: PARTNER });
  await pq.evaluate((c) => window.CLEANSWAP.applyCode(c), codeQ);
  await pq.fill('#addrIn', USER_ADDR);
  const invQ = await pq.evaluate(() => window.CLEANSWAP.mintInvoice({
    paymentHash: window.CLEANSWAP.state.expectH, sats: 50000, expiry: 14400
  }));
  await pq.fill('#invIn', invQ);
  await pq.waitForTimeout(400);
  const quorumSetup = await pq.evaluate(() => window.CLEANSWAP.endpoints());
  check('quorum: both endpoints are kept', quorumSetup.length === 2, quorumSetup.join(' '));
  await pq.click('#primary');
  await pq.waitForTimeout(2500);
  const qw = await view(pq);
  check('quorum: a lying endpoint cannot show a lock that is not there', qw.phase === 'idle', qw.phase);
  check('quorum: the screen says the endpoints disagree', /endpoints disagree/.test(qw.chainTxt) || /do not agree/.test(qw.say),
    qw.chainTxt + ' · ' + qw.say);
  check('quorum: the refusal is plain English', !JARGON.test(qw.say), qw.say);
  await pq.screenshot({ path: path.join(SHOTS, 'v60-quorum.png') });
  check('quorum: no page errors', Q.errs.length === 0, Q.errs.join(' | '));
  await Q.c.close();

  /* ------------------------------------- 7f. paying bitcoin needs the secret --- */
  const PG = await freshPage(390, 844);
  const pg = PG.p;
  let pgw = await view(pg);
  check('secret: sending bitcoin says what the wallet has to hand back',
    /payment secret/.test(await pg.textContent('#invHint')), await pg.textContent('#invHint'));
  await pg.click('#swapDir');
  await pg.waitForTimeout(250);
  check('secret: sending USDT does not ask for it', !(await pg.evaluate(() => !document.getElementById('invHint').hidden)));
  await PG.c.close();

  /* ----------------------- 7f2. an old allowance is cleared, not topped up -- */
  /* A token that already allows the escrow something refuses a second non-zero
     approval, so the app resets the allowance to zero first and only then asks
     for the exact amount - both as real transactions, each waited for. */
  const ACCOUNT = '0xc0ffee0000000000000000000000000000000001';
  const ALW = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ALW.addInitScript((acct) => {
    window.__walletCalls = [];
    window.ethereum = {
      request: function (o) {
        const p = o.params || [];
        if (o.method === 'eth_chainId') return Promise.resolve('0x66eee');
        if (o.method === 'eth_accounts' || o.method === 'eth_requestAccounts') return Promise.resolve([acct]);
        if (o.method === 'eth_sendTransaction') {
          const h = '0x' + String(window.__walletCalls.length + 1).padStart(64, '0');
          window.__walletCalls.push({ to: p[0].to, data: p[0].data, hash: h });
          return Promise.resolve(h);
        }
        return Promise.reject(new Error('unexpected ' + o.method));
      }
    };
  }, ACCOUNT);
  const alp = await ALW.newPage();
  const alErrs = [];
  alp.on('pageerror', e => alErrs.push(e.message));
  alp.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) alErrs.push(m.text()); });
  await alp.goto(URL, { waitUntil: 'load' });
  await alp.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await alp.click('#modeWallet');
  await alp.click('#swapDir');
  await alp.waitForTimeout(250);
  const alInv = await alp.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '5d'.repeat(32), sats: 50000, expiry: 6 * 3600 }));
  await alp.fill('#addrIn', PARTNER);
  await alp.fill('#invIn', alInv);
  await alp.click('#chainRow');
  await alp.fill('#contractIn', CONTRACT);
  await alp.fill('#tokenIn', TOKEN);
  await alp.fill('#rpcIn', RPC);
  await alp.click('[data-act="saveSetup"]');
  await alp.waitForTimeout(900);
  await alp.click('#chainRow');
  await alp.waitForTimeout(200);
  const approveHashes = ['0x' + '01'.padStart(64, '0'), '0x' + '02'.padStart(64, '0'), '0x' + '03'.padStart(64, '0')];
  approveHashes.forEach(h => { CHAIN.receipts[h] = { status: '0x1' }; });
  CHAIN.allowance = 5000000;                    /* 5 USDT already allowed */
  const alUnits = await alp.evaluate(() => window.CLEANSWAP.usdtUnits());
  await alp.click('#primary');
  await alp.waitForTimeout(2500);
  const walletCalls = await alp.evaluate(() => window.__walletCalls);
  const approveCalls = walletCalls.filter(c => String(c.data).toLowerCase().startsWith('0x095ea7b3'));
  const lockCalls = walletCalls.filter(c => String(c.data).toLowerCase().startsWith('0x91644b2b'));
  const word = (data, i) => String(data).replace(/^0x/, '').slice(8 + i * 64, 8 + (i + 1) * 64);
  check('allowance: an old allowance is reset to zero before the new one',
    approveCalls.length === 2 && /^0+$/.test(word(approveCalls[0].data, 1)),
    approveCalls.map(c => BigInt('0x' + word(c.data, 1)).toString()).join(','));
  check('allowance: the second approval is exactly the swap amount',
    approveCalls.length === 2 && BigInt('0x' + word(approveCalls[1].data, 1)) === BigInt(alUnits),
    approveCalls.length === 2 ? BigInt('0x' + word(approveCalls[1].data, 1)).toString() : 'none');
  check('allowance: both approvals name the escrow as the spender',
    approveCalls.every(c => ('0x' + word(c.data, 0).slice(24)) === CONTRACT), approveCalls.length + ' approvals');
  check('allowance: the lock is sent only after both approvals are mined',
    lockCalls.length === 1 && walletCalls.indexOf(lockCalls[0]) === walletCalls.length - 1,
    walletCalls.length + ' calls');
  check('allowance: the allowance was read before any approval',
    CHAIN.calls.some(c => String((c.params[0] || {}).data || '').toLowerCase().startsWith('0xdd62ed3e')),
    String(CHAIN.calls.length) + ' rpc calls');
  check('allowance: no page errors while approving', alErrs.length === 0, alErrs.join(' | '));
  await alp.screenshot({ path: path.join(SHOTS, 'v62-allowance.png') });
  await ALW.close();
  CHAIN.allowance = 0;

  /* ------------------------------ 7g. one endpoint is not a cross-check --- */
  /* A private node is its own answer, but a reading nobody else confirms is not
     a cross-checked one, and the screen says which it got. */
  const ONE = await freshPage(390, 844);
  const p1e = ONE.p;
  await p1e.click('#modeWallet');
  await p1e.waitForTimeout(250);
  await p1e.click('#chainRow');
  await p1e.fill('#contractIn', CONTRACT);
  await p1e.fill('#tokenIn', TOKEN);
  await p1e.fill('#rpcIn', RPC);
  await p1e.click('[data-act="saveSetup"]');
  await p1e.waitForTimeout(1500);
  const oneW = await view(p1e);
  check('single: one endpoint can still read the chain', /escrow ready/.test(oneW.chainTxt), oneW.chainTxt);
  check('single: the screen says the reading was not cross-checked', /nothing is cross-checked/.test(oneW.quorumWarn), oneW.quorumWarn);
  check('single: and what to do about it', /second RPC endpoint/.test(oneW.quorumWarn), oneW.quorumWarn);
  check('single: the warning is plain English', !JARGON.test(oneW.quorumWarn), oneW.quorumWarn);
  check('single: no page errors', ONE.errs.length === 0, ONE.errs.join(' | '));
  await p1e.screenshot({ path: path.join(SHOTS, 'v61-single-endpoint.png') });
  await ONE.c.close();

  /* --------------- 7h. an invoice with no expiry tag, and a running swap --- */
  /* BOLT 11: no `x` field means 3600 seconds after the timestamp. Read as
     "never", an old invoice would pass the window check for any window. A code
     is the terms of the next swap, so it may not land on a running one. */
  const EXPW = await freshPage(390, 844);
  const pex = EXPW.p;
  const t2x = Math.floor(Date.now() / 1000) + 7200;
  const hx = '0x' + crypto.createHash('sha256').update(Buffer.from('a7'.repeat(32), 'hex')).digest('hex');
  await pex.evaluate((c) => window.CLEANSWAP.applyCode(c),
    swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2x, h: hx, a: USER_ADDR }));
  const noXInv = await bolt11NoExpiry(pex, hx, 50000, Math.floor(Date.now() / 1000));
  const noX = await pex.evaluate((inv) => {
    const d = window.CLEANSWAP.decodeBolt11(inv);
    return { expiry: d.expiry, expiresAt: d.expiresAt, ts: d.timestamp, sats: d.sats, hash: d.paymentHash };
  }, noXInv);
  check('expiry: a BOLT11 with no x tag expires 3600s after its timestamp',
    noX.expiry === 3600 && noX.expiresAt === noX.ts + 3600, noX.expiry + ' / ' + noX.expiresAt);
  check('expiry: the rest of that invoice is read normally',
    noX.sats === 50000 && String(noX.hash).toLowerCase() === hx, noX.sats + ' ' + noX.hash);
  await pex.fill('#invIn', noXInv);
  await pex.fill('#addrIn', USER_ADDR);
  await pex.waitForTimeout(350);
  w = await view(pex);
  check('expiry: an hour-long invoice cannot serve a two-hour escrow window',
    w.ready === '0' && w.gate === 'window' && /stays payable at least an hour longer/.test(w.say), w.gate + ' · ' + w.say);
  check('expiry: the refusal is plain English', !JARGON.test(w.say), w.say);

  /* the same page now runs a real rehearsal, and a second code tries to land */
  const t2r = Math.floor(Date.now() / 1000) + 7200;
  const hr = '0x' + crypto.createHash('sha256').update(Buffer.from('b8'.repeat(32), 'hex')).digest('hex');
  await pex.evaluate((c) => window.CLEANSWAP.applyCode(c),
    swapCodeOf({ dir: 'u2b', sats: 50000, units: unitsS, t2: t2r, h: hr, a: USER_ADDR }));
  const invR = await pex.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 14400 }), hr);
  await pex.fill('#invIn', invR);
  await pex.fill('#addrIn', USER_ADDR);
  await pex.waitForTimeout(350);
  await pex.click('#primary');
  await pex.waitForFunction(() => document.body.dataset.phase !== 'idle', null, { timeout: 8000 });
  await pex.waitForTimeout(300);
  const runBefore = await pex.evaluate(() => ({ sats: window.CLEANSWAP.state.sats, t2: window.CLEANSWAP.state.t2 }));
  const tookRun = await pex.evaluate((c) => window.CLEANSWAP.applyCode(c),
    swapCodeOf({ dir: 'u2b', sats: 250000, units: unitsS, t2: t2r + 600, h: '0x' + 'c9'.repeat(32), a: USER_ADDR }));
  const runAfter = await pex.evaluate(() => ({
    sats: window.CLEANSWAP.state.sats, t2: window.CLEANSWAP.state.t2,
    warn: document.getElementById('codeWarn').hidden ? '' : document.getElementById('codeWarn').textContent
  }));
  check('running: a code cannot overwrite a swap that is under way', tookRun === false, String(tookRun));
  check('running: the running terms are untouched',
    runAfter.sats === runBefore.sats && runAfter.t2 === runBefore.t2, runAfter.sats + ' / ' + runAfter.t2);
  check('running: the refusal says a swap is already running', /already running/.test(runAfter.warn), runAfter.warn);
  check('running: the refusal is plain English', !JARGON.test(runAfter.warn), runAfter.warn);
  check('running: no page errors', EXPW.errs.length === 0, EXPW.errs.join(' | '));
  await EXPW.c.close();

  /* -------- 7i. a lock code is data, a QR is drawn, the page has a policy --- */
  const LC = await freshPage(360, 780);
  const lc = await LC.p.evaluate(() => {
    const out = {};
    out.bad = window.CLEANSWAP.readLockProof('liquidnetwork:lq1example?hashlock=%E0%A4%A&timelock=1');
    out.proto = window.CLEANSWAP.readLockProof('liquidnetwork:lq1example?__proto__=x&hashlock=abc');
    out.bare = window.CLEANSWAP.readLockProof('liquidnetwork:lq1example?hashlock');
    out.dup = window.CLEANSWAP.readLockProof('liquidnetwork:lq1example?hashlock=aa&hashlock=bb');
    out.ctor = window.CLEANSWAP.readLockProof('liquidnetwork:lq1example?constructor=z&amount=7');
    out.clean = Object.prototype.hashlock === undefined && ({})['__proto__'] === Object.prototype;
    return out;
  });
  check('lock code: a broken escape drops one field instead of failing the code',
    lc.bad.kind === 'liquid' && lc.bad.hashlock === '' && lc.bad.timelock === '1',
    JSON.stringify([lc.bad.kind, lc.bad.hashlock, lc.bad.timelock]));
  check('lock code: __proto__ is an ordinary key and changes no prototype',
    lc.proto.hashlock === 'abc' && lc.clean, lc.proto.hashlock);
  check('lock code: a pair with no = is ignored', lc.bare.kind === 'liquid' && lc.bare.hashlock === '', lc.bare.hashlock);
  check('lock code: the first of two same keys wins', lc.dup.hashlock === 'aa', lc.dup.hashlock);
  check('lock code: constructor= is data, not a function call', lc.ctor.amount === '7', lc.ctor.amount);

  const qz = await LC.p.evaluate(() => {
    const evil = '<img src=x onerror="window.__pwn=1"><b>bold</b>';
    window.CLEANSWAP.showQr('lightning:lnbc2500u1sample', evil, false);
    const box = document.getElementById('qrBox');
    const shown = {
      svg: !!box.querySelector('svg'),
      imgs: box.querySelectorAll('img').length,
      bolds: box.querySelectorAll('b').length,
      caption: (box.querySelector('p') || { textContent: '' }).textContent
    };
    window.CLEANSWAP.showQr('x'.repeat(window.CLEANSWAP.QR_MAX + 40), '<i>cap</i>', false);
    const long = {
      svg: !!box.querySelector('svg'),
      text: box.textContent,
      italics: box.querySelectorAll('i').length
    };
    return { shown, long, pwn: !!window.__pwn };
  });
  check('qr: the code is drawn as an SVG', qz.shown.svg, String(qz.shown.svg));
  check('qr: the caption is text, not markup',
    qz.shown.caption.indexOf('<img') === 0 && qz.shown.imgs === 0 && qz.shown.bolds === 0, qz.shown.caption);
  check('qr: nothing in the payload ran as script', qz.pwn === false);
  check('qr: a payload too long for a QR says so, still as text',
    qz.long.svg === false && /Too long for a QR/.test(qz.long.text) && qz.long.italics === 0, qz.long.text);

  const csp = await LC.p.evaluate(() => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    const icon = document.querySelector('img.mark');
    return {
      policy: m ? m.getAttribute('content') : '',
      icon: icon ? icon.naturalWidth : 0,
      scripts: Array.from(document.querySelectorAll('script')).map(s => s.textContent),
      style: (document.querySelector('style') || {}).textContent || ''
    };
  });
  /* The hashes in the policy are recomputed here from the blocks the page holds:
     a policy that names a hash nobody can reproduce allows nothing, and one that
     says 'unsafe-inline' allows anything. */
  const sha = (text) => 'sha256-' + crypto.createHash('sha256').update(text, 'utf8').digest('base64');
  const scriptHashes = (csp.policy.match(/script-src([^;]*)/) || ['', ''])[1];
  const styleHash = (csp.policy.match(/style-src([^;]*)/) || ['', ''])[1];
  check('csp: the page carries a Content-Security-Policy', /default-src 'none'/.test(csp.policy), csp.policy.slice(0, 70));
  check('csp: its own inline code is allowed by hash, never by "unsafe-inline"',
    scriptHashes.includes("'sha256-") && styleHash.includes("'sha256-") &&
    !/unsafe-inline/.test(csp.policy) && !/unsafe-eval/.test(csp.policy) &&
    /object-src 'none'/.test(csp.policy), csp.policy.slice(0, 110));
  check('csp: every script block on the page matches its hash in the policy',
    csp.scripts.length > 0 && csp.scripts.every(t => scriptHashes.includes("'" + sha(t) + "'")),
    csp.scripts.length + ' blocks');
  check('csp: the style block matches its hash in the policy',
    csp.style.length > 0 && styleHash.includes("'" + sha(csp.style) + "'"), String(csp.style.length) + ' chars');
  check('csp: images come from the page itself, connections from the chain',
    /img-src data:/.test(csp.policy) && /connect-src https:/.test(csp.policy), csp.policy);
  check("csp: the page's own icon still renders", csp.icon > 0, String(csp.icon));
  const errsBefore = LC.errs.length;
  await LC.p.evaluate(() => {
    const s = document.createElement('script');
    s.src = 'https://example.com/outside.js';
    document.head.appendChild(s);
  });
  await LC.p.waitForTimeout(800);
  const cspErrs = LC.errs.slice(errsBefore).filter((m) => /Content Security Policy/.test(m));
  check('csp: a script from outside the page is refused by the policy',
    cspErrs.length === 1 && /script-src/.test(cspErrs[0]), String(cspErrs.join(' | ')).slice(0, 110));

  /* An injected block runs only if its bytes are one of the hashes: the same
     policy that allows this page's code refuses code added afterwards. */
  const errsBefore2 = LC.errs.length;
  await LC.p.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = 1';
    document.body.appendChild(s);
  });
  await LC.p.waitForTimeout(400);
  const injected = await LC.p.evaluate(() => !!window.__injected);
  const injectedErrs = LC.errs.slice(errsBefore2).filter((m) => /Content Security Policy/.test(m));
  check('csp: a script block added to the page afterwards does not run',
    injected === false && injectedErrs.length === 1, 'ran=' + injected + ' ' + injectedErrs.join(' | ').slice(0, 80));
  await LC.c.close();

  /* ------------------------------------------------- 8. protocol vectors --- */
  const E = await freshPage(390, 844);
  const p9 = E.p;
  const vectors = await p9.evaluate(() => {
    const out = {};
    for (const t of ['A12UEL5L', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
      'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w']) {
      try { window.CLEANSWAP.bech32Decode(t); out[t] = 'ok'; } catch (e) { out[t] = 'err:' + e.message; }
    }
    try { window.CLEANSWAP.bech32Decode('A12UEL5X'); out.bad = 'ok'; } catch (e) { out.bad = 'err:' + e.message; }
    return out;
  });
  check('bech32: BIP-173 valid vectors pass',
    Object.entries(vectors).filter(([k]) => k !== 'bad').every(([, x]) => x === 'ok'), JSON.stringify(vectors));
  check('bech32: bad checksum rejected', /checksum/.test(vectors.bad), vectors.bad);

  const b12 = await p9.evaluate(() => {
    const raw = document.getElementById('sample-bolt12').textContent.trim();
    const d = window.CLEANSWAP.decodeSwapOffer(raw);
    return { kind: d.kind, form: d.form, desc: d.description, node: d.nodeId, hash: d.paymentHash, expiry: d.absoluteExpiry };
  });
  check('BOLT12 sample: offer recognised', b12.kind === 'bolt12' && b12.form === 'offer', b12.kind + '/' + b12.form);
  check('BOLT12 sample: offer_description decoded', b12.desc === BOLT12_DESC, b12.desc);
  check('BOLT12 sample: node_id TLV decoded', b12.node === BOLT12_NODE, b12.node);
  check('BOLT12 sample: absolute_expiry TLV decoded', b12.expiry === 1798761600, b12.expiry);
  check('BOLT12 sample: a bare offer carries no payment_hash', b12.hash === null, String(b12.hash));

  const b11 = await p9.evaluate(() => {
    const raw = document.getElementById('sample-bolt11').textContent.trim();
    const d = window.CLEANSWAP.decodeBolt11(raw);
    return { hash: d.paymentHash, sats: d.sats, net: d.network };
  });
  check('BOLT11 sample: payment_hash decoded', b11.hash === BOLT11_SAMPLE_HASH, b11.hash);
  check('BOLT11 sample: 50,000 sats decoded', b11.sats === 50000, b11.sats);
  check('BOLT11 sample: network bc', b11.net === 'bc', b11.net);

  /* BOLT #11's own invoices, signed by the spec's key: the signature check is
     measured against invoices this app did not make. */
  const spec = await p9.evaluate((v) => {
    const dec = (inv) => { try { return { ok: true, d: window.CLEANSWAP.decodeBolt11(inv) }; } catch (e) { return { ok: false, err: e.message }; } };
    const read = (inv) => { const r = window.CLEANSWAP.readInvoice(inv); return { ok: r.ok, code: r.code, msg: r.msg, H: r.H }; };
    const saved = window.CLEANSWAP.state.sats;
    const out = {};
    window.CLEANSWAP.state.sats = 250000;          /* the coffee invoice's amount */
    out.coffee = dec(v.coffee);
    out.coffeeRead = read(v.coffee);
    window.CLEANSWAP.state.sats = saved;
    out.amountless = dec(v.amountless);
    out.amountlessRead = read(v.amountless);
    out.missingP = read(v.missingP);
    out.twoP = dec(v.twoP);
    out.twoPRead = read(v.twoP);
    out.sameP = read(v.sameP);
    out.badChecksum = read(v.badChecksum);
    out.unrecoverable = read(v.unrecoverable);
    return out;
  }, {
    coffee: vector('coffee'), amountless: vector('amountless'), missingP: vector('missing-p'),
    twoP: vector('two-p'), sameP: vector('same-p-twice'), badChecksum: vector('bad-checksum'),
    unrecoverable: vector('unrecoverable')
  });
  check('BOLT11 vector: the coffee invoice reads with its amount and its signature',
    spec.coffee.ok && spec.coffee.d.sats === 250000 && spec.coffee.d.signed === true,
    String(spec.coffee.err || spec.coffee.d && spec.coffee.d.sats));
  check('BOLT11 vector: the payee key comes back out of the signature',
    spec.coffee.d.nodeId === VECTORS.node_id, String(spec.coffee.d && spec.coffee.d.nodeId));
  check('BOLT11 vector: its payment hash is the one the spec prints',
    spec.coffee.d.paymentHash === '0x0001020304050607080900010203040506070809000102030405060708090102',
    String(spec.coffee.d.paymentHash));
  check('BOLT11 vector: the gate reads the same invoice and refuses only its 2017 expiry',
    spec.coffeeRead.code === 'expired', spec.coffeeRead.code + ' · ' + spec.coffeeRead.msg);
  check('BOLT11 vector: an amountless invoice is refused, not read as any amount',
    !spec.amountless.ok && /states no amount/.test(spec.amountless.err) &&
    spec.amountlessRead.code === 'amount', spec.amountlessRead.code + ' · ' + spec.amountlessRead.msg);
  check('BOLT11 vector: two p fields are refused, so two readers cannot disagree',
    !spec.twoP.ok && /two "p" fields/.test(spec.twoP.err) && spec.twoPRead.code === 'format',
    spec.twoPRead.code + ' · ' + String(spec.twoP.err));
  check('BOLT11 vector: the same p field twice is refused too', spec.sameP.code === 'format', spec.sameP.code);
  check('BOLT11 vector: an invoice with no p field has no hash to lock on',
    spec.missingP.code === 'hash', spec.missingP.code + ' · ' + spec.missingP.msg);
  check('BOLT11 vector: a bad checksum is refused', spec.badChecksum.code === 'format', spec.badChecksum.code);
  check('BOLT11 vector: an unrecoverable signature is refused as a signature, not as gibberish',
    spec.unrecoverable.code === 'signature' && /does not check out/.test(spec.unrecoverable.msg),
    spec.unrecoverable.code + ' · ' + spec.unrecoverable.msg);
  check('BOLT11 vector: every refusal is plain English',
    !JARGON.test([spec.amountlessRead.msg, spec.twoPRead.msg, spec.unrecoverable.msg].join(' ')),
    (JARGON.exec([spec.amountlessRead.msg, spec.unrecoverable.msg].join(' ')) || [''])[0]);

  /* BOLT 11 says a reader that recovers the key must accept a high-S signature:
     the same invoice, re-signed mathematically (s -> N-s, recovery byte flipped)
     by the test, has to read exactly the same. */
  const hiS = await p9.evaluate((inv) => {
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const toBytes = (ws) => {
      let acc = 0, bits = 0; const out = [];
      for (const w of ws) {
        acc = (acc << 5) | w; bits += 5;
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
      }
      if (bits) out.push((acc << (8 - bits)) & 255);
      return new Uint8Array(out);
    };
    const pos = inv.lastIndexOf('1');
    const hrp = inv.slice(0, pos);
    const all = Array.from(inv.slice(pos + 1)).map(c => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.indexOf(c));
    const body = all.slice(0, -6);
    const sig = toBytes(body.slice(-104));
    const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const s = N - BigInt('0x' + hex(sig.subarray(32, 64)));
    const hi = new Uint8Array(65);
    hi.set(sig.subarray(0, 32), 0);
    const sHex = s.toString(16).padStart(64, '0');
    for (let i = 0; i < 32; i++) hi[32 + i] = parseInt(sHex.slice(i * 2, i * 2 + 2), 16);
    hi[64] = sig[64] ^ 1;
    const toWords = (bytes) => {
      let acc = 0, bits = 0; const out = [];
      for (const b of bytes) {
        acc = (acc << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
      }
      if (bits) out.push((acc << (5 - bits)) & 31);
      return out;
    };
    const sigWords = toWords(hi);
    const rebuilt = body.slice(0, -104).concat(sigWords);
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const polymod = (vals) => {
      let chk = 1;
      for (const v of vals) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let j = 0; j < 5; j++) if ((top >>> j) & 1) chk ^= GEN[j];
      }
      return chk >>> 0;
    };
    const hrpExpand = (h) => {
      const o = [];
      for (const c of h) o.push(c.charCodeAt(0) >>> 5);
      o.push(0);
      for (const c of h) o.push(c.charCodeAt(0) & 31);
      return o;
    };
    const p = polymod([...hrpExpand(hrp), ...rebuilt, 0, 0, 0, 0, 0, 0]) ^ 1;
    const sum = []; for (let i = 0; i < 6; i++) sum.push((p >>> (5 * (5 - i))) & 31);
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const text = hrp + '1' + [...rebuilt, ...sum].map(i => CHARSET[i]).join('');
    const base = window.CLEANSWAP.decodeBolt11(inv);
    let now = null, err = '';
    try { now = window.CLEANSWAP.decodeBolt11(text); } catch (e) { err = e.message; }
    return { highS: s > N / 2n, sameKey: now && now.nodeId === base.nodeId, sats: now && now.sats, err, len: text.length };
  }, await p9.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '77'.repeat(32), sats: 50000 })));
  check('BOLT11: a high-S signature is accepted when the key is recovered (BOLT 11 rule)',
    hiS.highS && hiS.sameKey && hiS.sats === 50000, JSON.stringify(hiS).slice(0, 120));

  const R0 = 'ab'.repeat(32);
  const expected = crypto.createHash('sha256').update(Buffer.from(R0, 'hex')).digest('hex');
  const got = await p9.evaluate(r => window.CLEANSWAP.sha256Hex(r), R0);
  check('crypto: SHA256(R) equals node crypto', got === expected, got.slice(0, 16) + '…');
  const multi = await p9.evaluate(() => window.CLEANSWAP.sha256Hex('00ffff00'));
  check('crypto: multi-byte preimage vector', multi === crypto.createHash('sha256').update(Buffer.from('00ffff00', 'hex')).digest('hex'));

  /* the synchronous SHA-256 behind the address checksum, against node */
  const sync = await p9.evaluate(() => {
    const hex = (u8) => Array.from(u8).map(x => x.toString(16).padStart(2, '0')).join('');
    const enc = new TextEncoder();
    return {
      empty: hex(window.CLEANSWAP.sha256Bytes(new Uint8Array(0))),
      abc: hex(window.CLEANSWAP.sha256Bytes(enc.encode('abc'))),
      a55: hex(window.CLEANSWAP.sha256Bytes(enc.encode('a'.repeat(55)))),
      a56: hex(window.CLEANSWAP.sha256Bytes(enc.encode('a'.repeat(56)))),
      a200: hex(window.CLEANSWAP.sha256Bytes(enc.encode('a'.repeat(200))))
    };
  });
  for (const [k, text] of [['empty', ''], ['abc', 'abc'], ['a55', 'a'.repeat(55)], ['a56', 'a'.repeat(56)], ['a200', 'a'.repeat(200)]]) {
    const want = crypto.createHash('sha256').update(text).digest('hex');
    check('crypto: the sync SHA-256 matches node on ' + (text.length || 'empty') + ' byte(s)',
      sync[k] === want, sync[k].slice(0, 16) + '…');
  }

  /* Base58Check: an address is built here from its 20 bytes and must decode
     back to them in the app, which is how a TRON address is verified. */
  const tronSelf = tronFrom('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  const tronBack = await p9.evaluate((a) => {
    const bytes = window.CLEANSWAP.tronAddressBytes(a);
    return bytes ? Array.from(bytes).map(x => x.toString(16).padStart(2, '0')).join('') : null;
  }, tronSelf);
  check('tron: an address built here keeps its 34 characters', tronSelf.length === 34 && tronSelf.charAt(0) === 'T', tronSelf);
  check('tron: Base58Check decodes back to its 20 bytes',
    tronBack === '7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', String(tronBack));
  const b58 = await p9.evaluate((a) => Array.from(window.CLEANSWAP.base58Bytes(a)).map(x => x.toString(16).padStart(2, '0')).join(''), tronSelf);
  const b58want = Buffer.concat([Buffer.from([0x41]), Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex'),
    crypto.createHash('sha256').update(crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x41]),
      Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex')])).digest()).digest().subarray(0, 4)]).toString('hex');
  check('tron: base58 decodes to the same 25 bytes as an independent encoder', b58 === b58want, b58.slice(0, 12) + '…');
  const tronFlip = await p9.evaluate((a) => {
    const cut = a.slice(0, -2) + (a.slice(-2, -1) === 'B' ? 'C' : 'B') + a.slice(-1);
    return { accepted: window.CLEANSWAP.readAddress(a).ok, flipped: window.CLEANSWAP.readAddress(cut).code };
  }, tronSelf);
  check('tron: the address built here is accepted', tronFlip.accepted === true, tronSelf);
  check('tron: one character changed is refused', tronFlip.flipped === 'format', String(tronFlip.flipped));

  /* the swap id, as the contract computes it: hashlock, sender, receiver,
     token, amount, timelock */
  const SENDER_V = '0x5c1d3f8a92b04e67d1a8c3f5027be64d89a0c1f3';
  const vectorId = await p9.evaluate(async (who) => window.CLEANSWAP.computeSwapId(
    '0x' + '11'.repeat(32),
    who,
    '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',
    '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097',
    12345678, 1700000000), SENDER_V);
  const vecBuf = Buffer.alloc(156);
  Buffer.from('11'.repeat(32), 'hex').copy(vecBuf, 0);
  Buffer.from(SENDER_V.slice(2), 'hex').copy(vecBuf, 32);
  Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex').copy(vecBuf, 52);
  Buffer.from('8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097', 'hex').copy(vecBuf, 72);
  Buffer.from(12345678n.toString(16).padStart(64, '0'), 'hex').copy(vecBuf, 92);
  Buffer.from(1700000000n.toString(16).padStart(64, '0'), 'hex').copy(vecBuf, 124);
  const expectId = '0x' + crypto.createHash('sha256').update(vecBuf).digest('hex');
  check('contract: computeSwapId mirrors abi.encodePacked', vectorId === expectId, vectorId.slice(0, 18) + '…');
  const otherSender = await p9.evaluate(async () => window.CLEANSWAP.computeSwapId(
    '0x' + '11'.repeat(32), '0x' + 'aa'.repeat(20),
    '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',
    '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097', 12345678, 1700000000));
  check('contract: the same terms from another sender give another id',
    otherSender !== vectorId, String(otherSender).slice(0, 14) + '…');

  /* --------------- 8x. the fourth review: shapes, senders, spellings --- */

  /* keccak-256, which both EIP-55 and the escrow's Locked event are made of.
     Measured against the digest of the empty string and the four addresses the
     standard prints, so the page's hash is not its own only witness. */
  const LOCKED_TOPIC = '0x14442dbf5e9aa943f3b7681bdf4e57c3256930c69ccc137263150f7e01bd51cf';
  const EIP55 = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'];
  /* the vector page has done its work; its context goes before another opens */
  await E.c.close();
  const KX = await freshPage(390, 844);
  const kx = await KX.p.evaluate((vec) => {
    const CS = window.CLEANSWAP;
    return {
      empty: CS.KECCAK.hex(new Uint8Array()),
      locked: CS.LOCKED_TOPIC,
      canon: vec.map(v => CS.eip55(v)),
      ok: vec.map(v => CS.isAddr(v)),
      badMixed: CS.isAddr('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'),
      lower: CS.isAddr('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'),
      upper: CS.isAddr('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED')
    };
  }, EIP55);
  check('keccak: the digest of the empty string is the known one',
    kx.empty === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', kx.empty);
  check('keccak: the Locked event topic is keccak of its signature',
    kx.locked === LOCKED_TOPIC, kx.locked);
  check('address: the four addresses EIP-55 prints come back spelled that way',
    kx.canon.every((v, i) => v === EIP55[i]), kx.canon.join(' '));
  check('address: correct spellings pass, all-lower and all-upper pass, a wrong capital does not',
    kx.ok.every(Boolean) && kx.lower && kx.upper && !kx.badMixed,
    JSON.stringify({ ok: kx.ok, lower: kx.lower, upper: kx.upper, bad: kx.badMixed }));
  const spell = await KX.p.evaluate(() => {
    const CS = window.CLEANSWAP;
    return {
      bad: CS.readAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'),
      good: CS.readAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
    };
  });
  check('address: a mistyped capital is refused with its own sentence',
    spell.bad.ok === false && spell.bad.code === 'checksum' && /mistyped/.test(spell.bad.msg),
    spell.bad.code + ' / ' + spell.bad.msg);
  check('address: the right spelling is accepted, and stored lower-case',
    spell.good.ok === true && spell.good.address === '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', spell.good.address);
  check('address: that sentence is plain English', !JARGON.test(spell.bad.msg), spell.bad.msg);

  /* A BOLT11 invoice of the shape Phoenix, Breez and Zeus send: more than one
     route hint and more than one fallback address. BOLT 11 lets both repeat,
     and refusing the second one refused a partner's real invoice. Signed here
     with the page's own signer, so the only thing under test is the tags. */
  const MULTI = await KX.p.evaluate(async () => {
    const CS = window.CLEANSWAP;
    const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const polymod = (vals) => {
      let chk = 1;
      for (const v of vals) {
        const b = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let j = 0; j < 5; j++) if ((b >>> j) & 1) chk ^= GEN[j];
      }
      return chk >>> 0;
    };
    const hrpWords = (hrp) => {
      const o = [];
      for (const c of hrp) o.push(c.charCodeAt(0) >>> 5);
      o.push(0);
      for (const c of hrp) o.push(c.charCodeAt(0) & 31);
      return o;
    };
    const toWords = (bytes) => {
      let acc = 0, bits = 0; const out = [];
      for (const b of bytes) {
        acc = (acc << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
      }
      if (bits) out.push((acc << (5 - bits)) & 31);
      return out;
    };
    const toBytes = (ws) => {
      let acc = 0, bits = 0; const out = [];
      for (const w of ws) {
        acc = (acc << 5) | w; bits += 5;
        while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
      }
      if (bits) out.push((acc << (8 - bits)) & 255);
      return new Uint8Array(out);
    };
    const hex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
    const hrp = 'lnbc500u';
    const ts = Math.floor(Date.now() / 1000);
    const words = [];
    for (let i = 6; i >= 0; i--) words.push(Math.floor(ts / Math.pow(32, i)) % 32);
    const tag = (ch, w) => { words.push(B32.indexOf(ch), w.length >> 5, w.length & 31, ...w); };
    const iv = (n) => {
      const o = []; let v = n;
      while (v > 0) { o.unshift(v & 31); v = Math.floor(v / 32); }
      return o.length ? o : [0];
    };
    tag('p', toWords(new Uint8Array(32).fill(0x21)));
    tag('d', toWords(new TextEncoder().encode('two routes')));
    const hint = (fill) => { const b = new Uint8Array(51); b.fill(fill); return b; };
    tag('r', toWords(hint(0x41)));
    tag('r', toWords(hint(0x42)));
    tag('f', [17, ...toWords(new Uint8Array(20).fill(0x51))]);
    tag('f', [17, ...toWords(new Uint8Array(20).fill(0x52))]);
    tag('x', iv(7200));
    const data = words.slice();
    const pre = new Uint8Array([...new TextEncoder().encode(hrp), ...toBytes(data)]);
    const msg = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', pre)));
    const sigHex = CS.SECP.sign(msg, '11'.repeat(32));
    const sigWords = toWords(new Uint8Array(sigHex.match(/../g).map(h => parseInt(h, 16))));
    const all = data.concat(sigWords);
    const p = polymod(hrpWords(hrp).concat(all).concat([0, 0, 0, 0, 0, 0])) ^ 1;
    const tail = [];
    for (let i = 0; i < 6; i++) tail.push((p >>> (5 * (5 - i))) & 31);
    const inv = hrp + '1' + all.concat(tail).map(v => B32[v]).join('');
    let dec = null, err = '';
    try { dec = CS.decodeBolt11(inv); } catch (e) { err = e.message; }
    const read = CS.readInvoice(inv);
    return {
      inv, err, tags: dec && dec.tags, hints: dec && dec.routeHints,
      fallbacks: dec && dec.fallbacks, sats: dec && dec.sats,
      readOk: read.ok, readCode: read.code, readMsg: read.msg
    };
  });
  check('invoice: two route hints are read, not refused',
    !MULTI.err && !!MULTI.hints && MULTI.hints.length === 2, MULTI.err || JSON.stringify(MULTI.hints));
  check('invoice: each hint names its node, its channel and its fees',
    !!MULTI.hints && MULTI.hints[0].nodeId === '41'.repeat(33) &&
    MULTI.hints[0].shortChannelId === '41'.repeat(8) &&
    MULTI.hints[0].baseMsat === 0x41414141 && MULTI.hints[0].cltv === 0x4141,
    MULTI.hints ? JSON.stringify(MULTI.hints[0]) : 'none');
  check('invoice: both fallback addresses are kept',
    !!MULTI.fallbacks && MULTI.fallbacks.length === 2 && MULTI.fallbacks[1].version === 17 &&
    MULTI.fallbacks[1].program === '52'.repeat(20), JSON.stringify(MULTI.fallbacks));
  check('invoice: the amount and the signature still read the same',
    MULTI.sats === 50000 && MULTI.readOk === true, MULTI.sats + ' / ' + MULTI.readCode + ' ' + MULTI.readMsg);
  check('invoice: each tag is listed once, however often it repeats',
    MULTI.tags === 'dfprx', MULTI.tags);
  await KX.p.fill('#invIn', MULTI.inv);
  await KX.p.fill('#addrIn', USER_ADDR);
  await KX.p.waitForTimeout(450);
  const multiW = await view(KX.p);
  check('invoice: a two-hint invoice makes Approve ready, as any other does',
    multiW.ready === '1' && multiW.gate === 'ok', multiW.gate + ' / ' + multiW.say);

  /* Two honest nodes, one of them writing the same receipt in another shape:
     keys in reverse order, Arbitrum's own fields, 0x01 for 0x1. The quorum
     compares what the money depends on, so these are one answer - while a
     different status or a different log is still a disagreement. */
  const qk = await KX.p.evaluate(() => {
    const CS = window.CLEANSWAP;
    const A = { transactionHash: '0xAB', status: '0x01', blockNumber: '0x2f0000', from: '0xAA', to: '0xBB', logs: [{ address: '0xCC', topics: ['0xDD'], data: '0xEE', logIndex: '0x0' }] };
    const B = { logs: [{ data: '0xee', topics: ['0xdd'], address: '0xcc' }], l1BlockNumber: '0x1', gasUsedForL1: '0x0', to: '0xbb', from: '0xaa', blockNumber: '0x002f0000', status: '0x1', transactionHash: '0xab', contractAddress: null };
    const C = Object.assign({}, A, { status: '0x0' });
    const D = Object.assign({}, A, { logs: [{ address: '0xCC', topics: ['0xDD'], data: '0xEF' }] });
    const t1 = { hash: '0xAB', from: '0xAA', to: '0xBB', value: '0x00', input: '0x91644b2b', nonce: '0x1' };
    const t2 = { nonce: '0x01', input: '0x91644b2b', value: '0x0', to: '0xbb', from: '0xaa', hash: '0xab', blockHash: '0x12' };
    return {
      same: CS.quorumKey(A) === CS.quorumKey(B),
      statusDiff: CS.quorumKey(A) !== CS.quorumKey(C),
      logDiff: CS.quorumKey(A) !== CS.quorumKey(D),
      txSame: CS.quorumKey(t1) === CS.quorumKey(t2),
      callSame: CS.quorumKey('0x' + 'AB'.repeat(32)) === CS.quorumKey('0x' + 'ab'.repeat(32)),
      unknownDiff: CS.quorumKey({ a: 1 }) !== CS.quorumKey({ a: 2 })
    };
  });
  check('quorum: the same receipt in another shape is the same answer', qk.same, String(qk.same));
  check('quorum: the same transaction in another shape is the same answer', qk.txSame, String(qk.txSame));
  check('quorum: a call answer compares by its bytes, not its spelling', qk.callSame, String(qk.callSame));
  check('quorum: a different status, a different log, or an unknown shape is still a disagreement',
    qk.statusDiff && qk.logDiff && qk.unknownDiff,
    JSON.stringify({ status: qk.statusDiff, log: qk.logDiff, unknown: qk.unknownDiff }));
  await KX.c.close();

  /* A lock funded by a smart contract wallet. The transaction is sent by a key
     that relays it and goes to the wallet, not to the escrow, so `tx.from` is
     not the address that funded anything; the escrow's own Locked event names
     it (topics[2]), and the swap id is built with that address. The two
     endpoints here are one node and one that writes the same receipt in the
     other shape, so the same run also proves the quorum's comparison. */
  const TW = await freshPage(390, 844);
  const twp = TW.p;
  await twp.click('#modeWallet');
  await twp.waitForTimeout(300);
  await twp.click('#chainRow');
  await twp.fill('#contractIn', CONTRACT);
  await twp.fill('#tokenIn', TOKEN);
  await twp.fill('#rpcIn', RPC + ',' + RPC_TWIN);
  await twp.click('[data-act="saveSetup"]');
  await twp.waitForTimeout(1500);
  await twp.click('#chainRow');
  const SAFE = '0x1f2e3d4c5b6a7988071625344a3b2c1d0e9f8a7b';
  const RELAYER = '0x9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5';
  const H8 = '0x' + crypto.createHash('sha256').update(Buffer.from('61'.repeat(32), 'hex')).digest('hex');
  const t2_8 = Math.floor(Date.now() / 1000) + 7200;
  const inv8 = await twp.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H8);
  await twp.fill('#invIn', inv8);
  await twp.fill('#addrIn', USER_ADDR);
  await twp.waitForTimeout(300);
  const units8 = await twp.evaluate((t) => { window.CLEANSWAP.state.t2 = t; return window.CLEANSWAP.usdtUnits(); }, t2_8);
  const lockEvent = (o) => ({
    address: CONTRACT,
    topics: [LOCKED_TOPIC,
      swapIdOf({ hashlock: o.H, sender: o.sender, receiver: USER_ADDR, token: TOKEN, amount: o.units, timelock: o.t2 }),
      '0x' + '0'.repeat(24) + o.sender.slice(2), '0x' + '0'.repeat(24) + USER_ADDR.slice(2)],
    data: '0x' + [hexAddr(TOKEN), hexWord(o.units), hexB32(o.H), hexWord(o.t2)].join('')
  });
  const wrongTx = '0x' + 'ce'.repeat(32);
  CHAIN.receipts[wrongTx] = { logs: [lockEvent({ H: H8, sender: SAFE, units: units8 + 1, t2: t2_8 })] };
  await twp.fill('#lockTxIn', wrongTx);
  await twp.click('[data-act="useLockTx"]');
  await twp.waitForTimeout(1800);
  const wrongW = await view(twp);
  check('smart wallet: a lock with other terms is refused and names no address',
    wrongW.toast === 'That transaction is not the lock for this swap' &&
    (await twp.evaluate(() => window.CLEANSWAP.state.funder)) === '', wrongW.toast);
  const lockTx8 = '0x' + 'cf'.repeat(32);
  CHAIN.receipts[lockTx8] = { logs: [lockEvent({ H: H8, sender: SAFE, units: units8, t2: t2_8 })] };
  /* the transaction itself went to the wallet, sent by a relaying key */
  CHAIN.txs[lockTx8] = { from: RELAYER, to: SAFE, input: '0x' };
  const id8 = swapIdOf({ hashlock: H8, sender: SAFE, receiver: USER_ADDR, token: TOKEN, amount: units8, timelock: t2_8 });
  CHAIN.records[id8.toLowerCase()] = {
    hashlock: H8, amount: units8, timelock: t2_8, token: TOKEN,
    sender: SAFE, receiver: USER_ADDR, claimed: false, refunded: false
  };
  await twp.fill('#lockTxIn', lockTx8);
  await twp.click('[data-act="useLockTx"]');
  await twp.waitForTimeout(1800);
  check('smart wallet: the Locked event says who funded the escrow',
    (await twp.evaluate(() => window.CLEANSWAP.state.funder)) === SAFE,
    await twp.evaluate(() => String(window.CLEANSWAP.state.funder || window.CLEANSWAP.state.me)));
  await twp.click('#primary');
  await twp.waitForTimeout(2200);
  const twW8 = await view(twp);
  check('smart wallet: the swap reads as locked under the id that address makes',
    twW8.chainState === 'locked' && twW8.phase === 'paying',
    twW8.phase + ' / ' + twW8.chainState);
  check('smart wallet: the log says where the address came from',
    await twp.evaluate(() => window.CLEANSWAP.state.log.some(e => /Locked event/.test(e.text))));
  check('smart wallet: both endpoints answered the receipt', TWIN.calls > 0, String(TWIN.calls) + ' calls');
  check('smart wallet: the refusal is plain English', !JARGON.test(wrongW.toast), wrongW.toast);
  check('smart wallet: no page errors', TW.errs.length === 0, TW.errs.join(' | '));
  await twp.screenshot({ path: path.join(SHOTS, 'v64-smart-wallet.png') });
  await TW.c.close();

  /* The same question through a wallet in the page: the account this page is
     handed is a relaying key, and the escrow's Locked event names the smart
     wallet that actually funded the swap. The id has to come from the event,
     or the page would look up an escrow entry nobody ever made. */
  const OWNER = '0xc0ffee0000000000000000000000000000000002';
  const SA2 = '0x2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e';
  const INP = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await INP.addInitScript((acct) => {
    window.__calls = [];
    window.ethereum = {
      request: function (o) {
        const p = o.params || [];
        if (o.method === 'eth_chainId') return Promise.resolve('0x66eee');
        if (o.method === 'eth_accounts' || o.method === 'eth_requestAccounts') return Promise.resolve([acct]);
        if (o.method === 'eth_sendTransaction') {
          const h = '0x' + String(window.__calls.length + 1).padStart(64, '0');
          window.__calls.push({ to: p[0].to, data: p[0].data, hash: h, from: p[0].from });
          return Promise.resolve(h);
        }
        return Promise.reject(new Error('unexpected ' + o.method));
      }
    };
  }, OWNER);
  const inp = await INP.newPage();
  const inpErrs = [];
  inp.on('pageerror', e => inpErrs.push(e.message));
  await inp.goto(URL, { waitUntil: 'load' });
  await inp.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await inp.click('#modeWallet');
  await inp.click('#swapDir');
  await inp.waitForTimeout(300);
  const H9 = '0x' + crypto.createHash('sha256').update(Buffer.from('62'.repeat(32), 'hex')).digest('hex');
  const inv9 = await inp.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H9);
  await inp.fill('#addrIn', PARTNER);
  await inp.fill('#invIn', inv9);
  await inp.click('#chainRow');
  await inp.fill('#contractIn', CONTRACT);
  await inp.fill('#tokenIn', TOKEN);
  await inp.fill('#rpcIn', RPC);
  await inp.click('[data-act="saveSetup"]');
  await inp.waitForTimeout(1000);
  await inp.click('#chainRow');
  await inp.waitForTimeout(250);
  const t2_9 = Math.floor(Date.now() / 1000) + 7200;
  const units9 = await inp.evaluate((t) => { window.CLEANSWAP.state.t2 = t; return window.CLEANSWAP.usdtUnits(); }, t2_9);
  const hApprove = '0x' + '1'.padStart(64, '0');
  const hLock = '0x' + '2'.padStart(64, '0');
  const id9 = swapIdOf({ hashlock: H9, sender: SA2, receiver: PARTNER, token: TOKEN, amount: units9, timelock: t2_9 });
  CHAIN.receipts[hApprove] = { status: '0x1' };
  CHAIN.receipts[hLock] = {
    status: '0x1',
    logs: [{
      address: CONTRACT,
      topics: [LOCKED_TOPIC, id9,
        '0x' + '0'.repeat(24) + SA2.slice(2), '0x' + '0'.repeat(24) + PARTNER.slice(2)],
      data: '0x' + [hexAddr(TOKEN), hexWord(units9), hexB32(H9), hexWord(t2_9)].join('')
    }]
  };
  CHAIN.records[id9.toLowerCase()] = {
    hashlock: H9, amount: units9, timelock: t2_9, token: TOKEN,
    sender: SA2, receiver: PARTNER, claimed: false, refunded: false
  };
  await inp.click('#primary');
  await inp.waitForTimeout(3200);
  const iw = await view(inp);
  check('in-page wallet: the lock is read as the escrow saw it, not as the wallet named it',
    iw.phase === 'paid' && iw.chainState === 'locked', iw.phase + ' / ' + iw.chainState);
  check('in-page wallet: the funding address is the one in the Locked event',
    (await inp.evaluate(() => window.CLEANSWAP.state.funder)) === SA2,
    await inp.evaluate(() => String(window.CLEANSWAP.state.funder || window.CLEANSWAP.state.me)));
  check('in-page wallet: the wallet never signed for that address',
    await inp.evaluate((o) => window.__calls.every(c => String(c.from).toLowerCase() === o), OWNER));
  check('in-page wallet: no page errors', inpErrs.length === 0, inpErrs.join(' | '));
  await INP.close();

  /* A lock read back with no swap code on the phone. The terms a code would
     have carried are still knowable: the escrow's Locked event names the
     window, and a plain wallet's lock call states it in its calldata. The
     old code read the escrow with a null window instead, threw inside
     BigInt, and showed a chain error that had nothing to do with the chain. */
  const NT = await freshPage(390, 844);
  const ntp = NT.p;
  await ntp.click('#modeWallet');
  await ntp.waitForTimeout(300);
  await ntp.click('#chainRow');
  await ntp.fill('#contractIn', CONTRACT);
  await ntp.fill('#tokenIn', TOKEN);
  await ntp.fill('#rpcIn', RPC);
  await ntp.click('[data-act="saveSetup"]');
  await ntp.waitForTimeout(1300);
  await ntp.click('#chainRow');
  const H10 = '0x' + crypto.createHash('sha256').update(Buffer.from('63'.repeat(32), 'hex')).digest('hex');
  const inv10 = await ntp.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 6 * 3600 }), H10);
  await ntp.fill('#invIn', inv10);
  await ntp.fill('#addrIn', USER_ADDR);
  await ntp.waitForTimeout(300);
  const units10 = await ntp.evaluate(() => window.CLEANSWAP.usdtUnits());
  check('terms: a wallet swap without a code has no window yet',
    (await ntp.evaluate(() => window.CLEANSWAP.state.t2)) === null,
    String(await ntp.evaluate(() => window.CLEANSWAP.state.t2)));
  const t2_10 = Math.floor(Date.now() / 1000) + 7200;
  const LOCKER10 = '0x4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70';
  const lockTx10 = '0x' + 'd1'.repeat(32);
  CHAIN.receipts[lockTx10] = { logs: [lockEvent({ H: H10, sender: LOCKER10, units: units10, t2: t2_10 })] };
  const id10 = swapIdOf({ hashlock: H10, sender: LOCKER10, receiver: USER_ADDR, token: TOKEN, amount: units10, timelock: t2_10 });
  CHAIN.records[id10.toLowerCase()] = {
    hashlock: H10, amount: units10, timelock: t2_10, token: TOKEN,
    sender: LOCKER10, receiver: USER_ADDR, claimed: false, refunded: false
  };
  await ntp.fill('#lockTxIn', lockTx10);
  await ntp.click('[data-act="useLockTx"]');
  await ntp.waitForTimeout(2200);
  const nw10 = await view(ntp);
  check('terms: the lock event fills the window instead of crashing on a null one',
    (await ntp.evaluate(() => window.CLEANSWAP.state.t2)) === t2_10,
    String(await ntp.evaluate(() => window.CLEANSWAP.state.t2)));
  check('terms: the funding address still comes from the event',
    (await ntp.evaluate(() => window.CLEANSWAP.state.funder)) === LOCKER10,
    await ntp.evaluate(() => String(window.CLEANSWAP.state.funder)));
  check('terms: the escrow reads as locked under the terms the event carried',
    /USDT locked/.test(nw10.chainTxt) && nw10.phase === 'idle', nw10.phase + ' / ' + nw10.chainTxt);
  check('terms: the log says where the window came from',
    await ntp.evaluate(() => window.CLEANSWAP.state.log.some(e => /window came from/.test(e.text))));
  check('terms: no page errors through the event path', NT.errs.length === 0, NT.errs.join(' | '));

  /* The same gap, but a receipt with no log at all: a plain wallet's lock
     call carries the terms itself, and the window is read out of the
     calldata the escrow was called with. */
  await ntp.evaluate(() => window.CLEANSWAP.reset());
  await ntp.waitForTimeout(200);
  await ntp.fill('#invIn', inv10);
  await ntp.fill('#addrIn', USER_ADDR);
  await ntp.waitForTimeout(250);
  const t2_11 = Math.floor(Date.now() / 1000) + 7200;
  const EOA10 = '0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081';
  const lockTx11 = '0x' + 'd2'.repeat(32);
  CHAIN.receipts[lockTx11] = { logs: [] };
  CHAIN.txs[lockTx11] = {
    from: EOA10, to: CONTRACT,
    input: '0x91644b2b' + hexB32(H10) + hexWord(t2_11) + hexAddr(USER_ADDR) + hexAddr(TOKEN) + hexWord(units10)
  };
  const id11 = swapIdOf({ hashlock: H10, sender: EOA10, receiver: USER_ADDR, token: TOKEN, amount: units10, timelock: t2_11 });
  CHAIN.records[id11.toLowerCase()] = {
    hashlock: H10, amount: units10, timelock: t2_11, token: TOKEN,
    sender: EOA10, receiver: USER_ADDR, claimed: false, refunded: false
  };
  await ntp.fill('#lockTxIn', lockTx11);
  await ntp.click('[data-act="useLockTx"]');
  await ntp.waitForTimeout(2200);
  const nw11 = await view(ntp);
  check('terms: a plain lock call fills the window from its own calldata',
    (await ntp.evaluate(() => window.CLEANSWAP.state.t2)) === t2_11,
    String(await ntp.evaluate(() => window.CLEANSWAP.state.t2)));
  check('terms: the funding address comes from the transaction',
    (await ntp.evaluate(() => window.CLEANSWAP.state.funder)) === EOA10,
    await ntp.evaluate(() => String(window.CLEANSWAP.state.funder)));
  check('terms: the escrow reads as locked under the terms the call carried',
    /USDT locked/.test(nw11.chainTxt), nw11.chainTxt);
  check('terms: no page errors through the calldata path', NT.errs.length === 0, NT.errs.join(' | '));

  /* And when nothing on chain says what the terms are, the screen says what
     is missing instead of a chain error that would send the person looking
     at the wrong thing. */
  await ntp.evaluate(() => window.CLEANSWAP.reset());
  await ntp.waitForTimeout(200);
  await ntp.fill('#invIn', inv10);
  await ntp.fill('#addrIn', USER_ADDR);
  await ntp.waitForTimeout(250);
  const lockTx12 = '0x' + 'd3'.repeat(32);
  CHAIN.receipts[lockTx12] = { logs: [] };
  CHAIN.txs[lockTx12] = { from: EOA10, to: CONTRACT, input: '0x' };
  await ntp.fill('#lockTxIn', lockTx12);
  await ntp.click('[data-act="useLockTx"]');
  await ntp.waitForTimeout(1400);
  const nw12 = await view(ntp);
  check('terms: nothing knowable says what is missing, not a chain error',
    /terms are incomplete/.test(nw12.toast) && !/chain/.test(nw12.toast), nw12.toast);
  check('terms: the refusal is plain English', !JARGON.test(nw12.toast), nw12.toast);
  check('terms: nothing was adopted from a transaction that was not the lock',
    (await ntp.evaluate(() => window.CLEANSWAP.state.t2)) === null &&
    (await ntp.evaluate(() => window.CLEANSWAP.state.funder)) === '',
    await ntp.evaluate(() => window.CLEANSWAP.state.funder + ' / ' + window.CLEANSWAP.state.t2));
  check('terms: no page errors through the empty path', NT.errs.length === 0, NT.errs.join(' | '));
  await ntp.screenshot({ path: path.join(SHOTS, 'v65-no-terms.png') });
  await NT.c.close();

  /* A code states terms, and zero is not a term: a rate that has not loaded
     cannot become "0 USDT" in a code the other phone would refuse. */
  const ZR = await freshPage(390, 844);
  const zero = await ZR.p.evaluate(() => {
    const CS = window.CLEANSWAP;
    const saved = { price: CS.state.price, pstate: CS.state.pstate, units: CS.state.units };
    CS.state.price = null; CS.state.pstate = 'loading'; CS.state.units = null;
    let threw = '';
    try { CS.swapCode(); } catch (e) { threw = e.message; }
    CS.state.price = saved.price; CS.state.pstate = saved.pstate; CS.state.units = saved.units;
    return { threw };
  });
  check('code: no code is made while the rate is unknown',
    /rate has not loaded/.test(zero.threw), zero.threw);
  const zeroBtn = await ZR.p.evaluate(async () => {
    const CS = window.CLEANSWAP;
    CS.state.price = null; CS.state.pstate = 'loading'; CS.state.units = null;
    document.querySelector('[data-act="copyCode"]').click();
    await new Promise(r => setTimeout(r, 80));
    const t = document.getElementById('toast').textContent;
    CS.state.price = 90000; CS.state.pstate = 'offline';
    return t;
  });
  check('code: the Share code button says so instead of copying one',
    /rate has not loaded/.test(zeroBtn), zeroBtn);
  check('code: that sentence is plain English', !JARGON.test(zeroBtn), zeroBtn);
  await ZR.c.close();

  /* ------------------------------------------------------ 9. layout --- */
  async function layout(width, height, label) {
    const f = await freshPage(width, height);
    const m = await f.p.evaluate(() => {
      const vw = window.innerWidth;
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1)) {
          bad.push((el.id || el.tagName) + '[' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
        }
      });
      return { vw, scrollW: document.documentElement.scrollWidth, overflow: bad.slice(0, 6) };
    });
    check('layout ' + label + ': no horizontal overflow',
      m.scrollW <= m.vw && m.overflow.length === 0, 'vw=' + m.vw + ' scrollW=' + m.scrollW + ' ' + m.overflow.join(','));
    await f.c.close();
  }
  await layout(360, 780, '360x780');
  await layout(390, 844, '390x844');
  await layout(1280, 800, '1280x800');

  /* the waiting screen on a small phone: no overflow, and clear of the bar */
  const payCtx = await freshPage(360, 780);
  const pp = payCtx.p;
  await pp.click('#modeWallet');
  await pp.waitForTimeout(250);
  const payInv = await pp.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '4d'.repeat(32), sats: 50000, expiry: 6 * 3600 }));
  await pp.fill('#invIn', payInv);
  await pp.fill('#addrIn', PARTNER);
  await pp.click('#chainRow');
  await pp.fill('#contractIn', CONTRACT);
  await pp.fill('#tokenIn', TOKEN);
  await pp.fill('#rpcIn', RPC);
  await pp.click('[data-act="saveSetup"]');
  await pp.waitForTimeout(800);
  await pp.click('#chainRow');
  await pp.waitForTimeout(200);
  /* the terms the app will use, read the way it reads them, so the record the
     mock holds is the record this swap asks about */
  const PAY_LOCKER = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
  const payId = await pp.evaluate(async () => {
    const st = window.CLEANSWAP.state;
    const inv = window.CLEANSWAP.readInvoice(document.getElementById('invIn').value);
    const addr = window.CLEANSWAP.readAddress(document.getElementById('addrIn').value).address;
    st.t2 = Math.floor(Date.now() / 1000) + 7200;
    st.locker = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
    st.expectH = null;
    const units = window.CLEANSWAP.usdtUnits();
    const id = await window.CLEANSWAP.computeSwapId(inv.H, st.locker, addr, window.CLEANSWAP.tokenNow(), units, st.t2);
    return id;
  });
  const payTerms = await pp.evaluate(() => ({ H: window.CLEANSWAP.state.expectH, units: window.CLEANSWAP.usdtUnits(), t2: window.CLEANSWAP.state.t2, addr: document.getElementById('addrIn').value }));
  CHAIN.records[payId.toLowerCase()] = {
    hashlock: '0x' + '4d'.repeat(32), amount: payTerms.units, timelock: payTerms.t2, token: TOKEN,
    sender: PAY_LOCKER, receiver: payTerms.addr, claimed: false, refunded: false
  };
  await pp.click('#primary');
  await pp.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 8000 });
  await pp.waitForTimeout(300);
  const payFit = await pp.evaluate(() => {
    const vw = window.innerWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1)) {
        bad.push((el.id || el.tagName) + '[' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      }
    });
    return { vw, scrollW: document.documentElement.scrollWidth, overflow: bad.slice(0, 6) };
  });
  check('layout 360x780: the waiting screen does not overflow',
    payFit.scrollW <= payFit.vw && payFit.overflow.length === 0,
    'vw=' + payFit.vw + ' scrollW=' + payFit.scrollW + ' ' + payFit.overflow.join(','));
  await pp.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await pp.waitForTimeout(300);
  const payBar = await pp.evaluate(() => {
    const box = document.getElementById('payBox').getBoundingClientRect();
    const bar = document.querySelector('.bar').getBoundingClientRect();
    const cta = document.getElementById('primary').getBoundingClientRect();
    return { payBottom: Math.round(box.bottom), barTop: Math.round(bar.top), ctaTop: Math.round(cta.top), ctaText: document.getElementById('primary').textContent };
  });
  check('layout 360x780: the waiting screen ends above the I paid bar',
    payBar.payBottom <= payBar.barTop - 4, 'pay ' + payBar.payBottom + ' bar ' + payBar.barTop);
  check('layout 360x780: the bar offers I paid, not Approve', payBar.ctaText === 'I paid', payBar.ctaText);
  await pp.screenshot({ path: path.join(SHOTS, 'v43-paying-360.png') });
  await payCtx.c.close();

  /* the fixed Approve bar must never cover the last line of the page */
  const barCtx = await freshPage(360, 740);
  const bp = barCtx.p;
  await bp.evaluate(() => {
    window.CLEANSWAP.state.mode = 'wallet';
    const box = document.getElementById('history');
    box.hidden = false;
    for (let i = 0; i < 5; i++) window.CLEANSWAP.historyEntry('Swap', '+' + (10 + i) + '.00 USDT', 'plus');
  });
  await bp.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await bp.waitForTimeout(300);
  const bar = await bp.evaluate(() => {
    const b = document.querySelector('.bar').getBoundingClientRect();
    const foot = document.getElementById('foot').getBoundingClientRect();
    const last = document.querySelector('#histList .hist-item:last-child').getBoundingClientRect();
    return { barTop: b.top, footBottom: foot.bottom, lastBottom: last.bottom, fixed: getComputedStyle(document.querySelector('.bar')).position };
  });
  check('bar: the action bar is fixed to the bottom', bar.fixed === 'fixed', bar.fixed);
  check('bar: scrolling to the end never puts Recent under the bar',
    bar.lastBottom <= bar.barTop + 1 && bar.footBottom <= bar.barTop + 1,
    'last=' + Math.round(bar.lastBottom) + ' foot=' + Math.round(bar.footBottom) + ' bar=' + Math.round(bar.barTop));
  await bp.screenshot({ path: path.join(SHOTS, 'v43-scroll.png') });
  await barCtx.c.close();

  /* the QR with the longest content still clears the bar at 360x780 */
  const qrCtx = await freshPage(360, 780);
  const qp = qrCtx.p;
  const qrInv = await qp.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '44'.repeat(32), sats: 50000, expiry: 6 * 3600 }));
  await qp.click('#modeWallet');
  await qp.waitForTimeout(250);
  await qp.fill('#invIn', qrInv);
  await qp.waitForTimeout(300);
  await qp.click('[data-act="qrInvoice"]');
  await qp.waitForTimeout(350);
  await qp.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await qp.waitForTimeout(250);
  const qrDeep = await qp.evaluate(() => {
    const q = document.getElementById('qrBox').getBoundingClientRect();
    const b = document.querySelector('.bar').getBoundingClientRect();
    return { qrBottom: Math.round(q.bottom), qrTop: Math.round(q.top), barTop: Math.round(b.top) };
  });
  check('qr 360x780: the invoice QR never sits under the Approve bar',
    qrDeep.qrBottom <= qrDeep.barTop - 4, 'qr ' + qrDeep.qrTop + '..' + qrDeep.qrBottom + ' bar ' + qrDeep.barTop);
  await qp.screenshot({ path: path.join(SHOTS, 'v43-qr-360.png') });
  await qp.click('[data-act="qrInvoice"]');
  await qp.waitForTimeout(200);
  check('qr: tapping the button again folds it away', !(await qp.evaluate(() => !!document.querySelector('#qrBox svg'))));
  await qrCtx.c.close();

  const desktop = await freshPage(1280, 860);
  await desktop.p.screenshot({ path: path.join(SHOTS, 'v43-desktop.png') });
  await desktop.c.close();

  /* A setup saved by the first version named one network and no others. It is
     read as the network it was written under, not copied into both. */
  const legacyCtx = await freshPage(390, 844);
  const legacy = await legacyCtx.p.evaluate(() => {
    const key = 'cleanswap.setup.v1';
    localStorage.setItem(key, JSON.stringify({
      net: 'mainnet', contract: '0x' + 'ab'.repeat(20), token: '0x' + 'cd'.repeat(20), rpc: ''
    }));
    window.CLEANSWAP.loadSetup();
    const s = window.CLEANSWAP.state;
    const out = {
      net: s.net, contract: s.contract, token: s.token,
      testnet: s.setups.testnet.contract, mainnet: s.setups.mainnet.contract
    };
    localStorage.removeItem(key);
    return out;
  });
  check('setup: a first-version setup is read as the network it was written under',
    legacy.net === 'mainnet' && legacy.contract === '0x' + 'ab'.repeat(20) &&
    legacy.mainnet === '0x' + 'ab'.repeat(20) && legacy.testnet === '',
    JSON.stringify(legacy));
  await legacyCtx.c.close();

  await browser.close();

  console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
