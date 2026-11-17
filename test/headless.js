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
    payRowInv: vis('payRowInv'),
    payRowAddr: vis('payRowAddr'),
    payLink: t('payWalletLink').getAttribute('href'),
    back: vis('headRow'),
    gate: window.CLEANSWAP.state.gate && window.CLEANSWAP.state.gate.code
  };
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });
  const browser = await chromium.launch();

  async function freshPage(width, height) {
    const c = await browser.newContext({ viewport: { width: width || 390, height: height || 844 }, deviceScaleFactor: 1 });
    const p = await c.newPage();
    const errs = [], failed = [];
    p.on('pageerror', e => errs.push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    p.on('requestfailed', r => { if (!/mempool\.space/.test(r.url())) failed.push(r.url()); });
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
    await p.waitForTimeout(250);
    return { c, p, errs, failed };
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
  check('boot: the invoice field welcomes an invoice and an offer',
    /lnbc/.test(ph.inv) && /lno1/.test(ph.inv), ph.inv);
  check('boot: the address field welcomes both USDT chains',
    /0x/.test(ph.addr) && /T/.test(ph.addr), ph.addr);
  check('boot: one big Approve button, not ready yet', w.cta === 'Approve' && w.ready === '0', w.cta + '/' + w.ready);
  check('boot: the sentence asks for the first step', /Paste the invoice your partner sends/.test(w.say), w.say);
  check('boot: 50,000 sats on both cards', w.send === '50,000 sats' && /^[\d,.]+ USDT$/.test(w.get), w.send + ' / ' + w.get);
  check('boot: the amount presets are shown, 50,000 selected',
    w.presets && w.on.length === 1 && w.on[0] === '50,000', w.on.join(','));
  check('boot: practice offers Sample beside both fields', w.sampleInv && w.sampleAddr,
    [w.sampleInv, w.sampleAddr].join('/'));
  check('boot: practice offers no wallet hand-off at all', !w.invRow, String(w.invRow));
  check('boot: the terms code is a small helper, not a step', w.terms && !w.receipt, String(w.terms));

  const html = await page.content();
  check('content: no test toolbox left in the page', !OLD_ACTS.some(a => new RegExp('data-act="' + a + '"').test(html)),
    OLD_ACTS.filter(a => new RegExp('data-act="' + a + '"').test(html)).join(','));
  check('content: no sample or mismatch helpers anywhere', !/use sample|mismatched|wrong r|advance clock/i.test(html));
  check('content: no browser-extension wallet (window.ethereum)', !/window\.ethereum|eth_requestAccounts|ethereum\.request/i.test(html));
  check('content: no WebLN hand-off', !/webln/i.test(html));
  check('content: contract source embedded (sha256 hashlock)', /sha256\(abi\.encodePacked\(preimage\)\)/.test(html));
  check('content: no remote scripts or styles', !/<script[^>]+src=/i.test(html) && !/<link[^>]+rel="stylesheet"/i.test(html));
  check('content: the page holds no file:// path of its own', !/file:\/\//.test(html),
    (html.match(/file:\/\/[^"'\s]*/) || [''])[0]);
  check('content: no web host in the page (no Pages address)', !/github\.io|jbitmstr\.github|https?:\/\/[a-z0-9.-]*cleanswap/i.test(html));
  check('content: no Hangul in the built page', !HANGUL.test(html), (html.match(HANGUL) || []).length + ' chars');
  const uiText = await page.evaluate(() => document.body.innerText);
  check('content: no Hangul in rendered text', !HANGUL.test(uiText), (uiText.match(HANGUL) || []).length + ' chars');
  check('content: no technical words on the screen', !JARGON.test(uiText), (uiText.match(JARGON) || [''])[0]);

  await page.screenshot({ path: path.join(SHOTS, 'v43-idle.png') });

  /* --------------------------------------------- 2. practice: the 3 steps --- */
  await page.click('[data-act="sampleInv"]');
  await page.waitForFunction(() => /^lnbc/.test(document.getElementById('invIn').value), null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view(page);
  check('practice: Sample fills a real lnbc invoice', w.gate === 'empty' && w.ready === '0', w.gate + '/' + w.ready);
  check('practice: the sentence now asks for the address', /Add the USDT address/.test(w.say), w.say);

  await page.click('[data-act="sampleAddr"]');
  await page.waitForTimeout(300);
  w = await view(page);
  check('practice: Sample fills a 0x address', /^0x[0-9a-f]{40}$/i.test(await page.inputValue('#addrIn')));
  check('practice: both steps in, Approve is ready', w.ready === '1' && w.gate === 'ok', w.gate + '/' + w.ready);
  check('practice: the sentence says what Approve does', /lock them and swap at once/.test(w.say), w.say);
  check('practice: the state line says so too', w.state === 'Ready to approve', w.state);
  await page.screenshot({ path: path.join(SHOTS, 'v43-filled.png') });

  const sent = await page.evaluate(() => ({
    H: window.CLEANSWAP.state.expectH, inv: document.getElementById('invIn').value,
    addr: document.getElementById('addrIn').value, units: window.CLEANSWAP.usdtUnits()
  }));
  const dec = await page.evaluate(i => window.CLEANSWAP.decodeBolt11(i), sent.inv);
  check('practice: the sample invoice carries the amount on screen', dec.sats === 50000, String(dec.sats));

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  w = await view(page);
  check('practice: Approve settles the swap', w.state === 'Completed' && w.cta === 'Done', w.state + '/' + w.cta);
  check('practice: the receipt shows both sides and the address',
    w.receipt && w.rc[0] === '50,000 sats' && /^[\d,.]+ USDT$/.test(w.rc[1]) && w.rc[2] === sent.addr.toLowerCase(),
    w.rc.join(' | '));
  check('practice: the sentence names what arrived', /You received [\d,.]+ USDT\./.test(w.say), w.say);
  check('practice: the steps fold away once settled', !w.steps && !w.presets && !w.terms, String(w.steps));
  check('practice: a rehearsal adds nothing to Recent', !w.history && w.rows === 0, String(w.rows));
  await page.screenshot({ path: path.join(SHOTS, 'v43-done.png') });

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
  const packed = Buffer.alloc(156);
  Buffer.from(settled.H.slice(2), 'hex').copy(packed, 0);
  const evm = await page.evaluate(() => window.CLEANSWAP.EVM);
  Buffer.from(evm.usdtSide.slice(2), 'hex').copy(packed, 32);
  Buffer.from(settled.addr.slice(2), 'hex').copy(packed, 52);
  Buffer.from(evm.token.slice(2), 'hex').copy(packed, 72);
  Buffer.from(BigInt(settled.units).toString(16).padStart(64, '0'), 'hex').copy(packed, 92);
  Buffer.from(BigInt(settled.t2).toString(16).padStart(64, '0'), 'hex').copy(packed, 124);
  const wantId = '0x' + crypto.createHash('sha256').update(packed).digest('hex');
  check('settle: the swap id binds both legs (abi.encodePacked)', settled.id === wantId,
    String(settled.id).slice(0, 14) + '…');
  fs.writeFileSync(path.join(BUILD, 'app-calldata.json'), JSON.stringify({
    calldata: settled.calldata, hashlock: settled.H, timelock: settled.t2,
    receiver: settled.addr, token: evm.token, amount: String(settled.units)
  }, null, 2));

  /* ------------------------------------------------- 3. Back and Done --- */
  await page.click('#primary');            /* Done */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  check('done: the fields start empty again',
    await page.evaluate(() => !window.CLEANSWAP.state.H && !window.CLEANSWAP.state.addr &&
      !document.getElementById('invIn').value && !document.getElementById('addrIn').value));

  /* ------------------------------------------- 4. the same screen, wallet --- */
  await page.click('#modeWallet');
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: the mode switch flips', w.mode === 'wallet');
  check('wallet: the screen keeps the same three steps',
    w.steps && w.n1 === '1' && w.n2 === '2' && w.order.join(',') === '1,2,3', w.order.join(','));
  check('wallet: Sample is gone', !w.sampleInv && !w.sampleAddr, [w.sampleInv, w.sampleAddr].join('/'));
  check('wallet: the invoice row hands off to a wallet',
    w.invRow && w.walletLink && !w.copyInv, [w.invRow, w.walletLink, w.copyInv].join('/'));

  const R2 = '77'.repeat(32);
  const H2 = '0x' + crypto.createHash('sha256').update(Buffer.from(R2, 'hex')).digest('hex');
  const realInv = await page.evaluate(h => window.CLEANSWAP.mintInvoice({ paymentHash: h, sats: 50000, expiry: 3600 }), H2);
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
  check('wallet: both steps in, Approve is ready', w.ready === '1' && w.gate === 'ok', w.gate + '/' + w.ready);
  await page.screenshot({ path: path.join(SHOTS, 'v43-wallet.png') });

  /* Approve is not the end in Wallet: nothing has been paid yet. */
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: Approve waits for the payment instead of finishing',
    w.phase === 'paying' && w.title === 'Waiting for payment' && w.cta === 'I paid',
    w.phase + ' / ' + w.title + ' / ' + w.cta);
  check('wallet: nothing on the waiting screen says the swap is done',
    !/swap complete|completed/i.test([w.title, w.state, w.say, w.toast].join(' ')) && !w.receipt,
    [w.title, w.state, w.toast].join(' | '));
  check('wallet: no receipt and no Recent entry before the money moves',
    !w.receipt && !w.history && w.rows === 0, w.rows + ' rows');
  check('wallet: the waiting screen says what to pay and how much',
    /^Send 50,000 sats to this invoice/.test(w.payLine), w.payLine);
  check('wallet: the invoice is one tap from a wallet there too',
    w.payRowInv && !w.payRowAddr && w.payLink === 'lightning:' + realInv, w.payLink.slice(0, 20) + '…');
  check('wallet: Back is offered while waiting', w.back, String(w.back));
  check('wallet: the two steps fold away while waiting', !w.steps && !w.presets && !w.terms, String(w.steps));
  await page.screenshot({ path: path.join(SHOTS, 'v43-paying.png') });

  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(350);
  check('wallet: the waiting screen can show the invoice as a QR', (await view(page)).qr);
  await page.click('[data-act="payQrInv"]');
  await page.waitForTimeout(200);
  check('wallet: and folds it away again', !(await view(page)).qr);

  /* I paid is the only thing that closes the swap. */
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  w = await view(page);
  check('wallet: I paid completes the swap', w.state === 'Completed' && w.cta === 'Done', w.state + '/' + w.cta);
  check('wallet: the receipt appears only now',
    w.receipt && w.rc[0] === '50,000 sats' && w.rc[2] === '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', w.rc.join(' | '));
  check('wallet: a real swap is kept in Recent', w.history && w.rows === 1, String(w.rows));
  check('wallet: the history row shows what arrived', await page.evaluate(() =>
    /^\+\s?[\d,.]+ USDT$/.test(document.querySelector('#histList .hist-item b').textContent)),
    await page.evaluate(() => document.querySelector('#histList .hist-item b').textContent));
  await page.screenshot({ path: path.join(SHOTS, 'v43-wallet-done.png') });

  /* Back from the waiting screen returns to the filled form, not a new swap. */
  await page.click('#primary');  /* Done */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.fill('#invIn', realInv);
  await page.fill('#addrIn', '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  await page.waitForTimeout(300);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.click('[data-act="back"]');
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view(page);
  check('back: leaving the waiting screen keeps the terms on screen',
    w.steps && w.invRow && (await page.inputValue('#invIn')) === realInv && (await page.inputValue('#addrIn')).length === 42,
    String(w.steps));
  check('back: it does not quietly settle a swap nobody paid', !w.receipt && w.rows === 1, w.rows + ' rows');
  await page.evaluate(() => window.CLEANSWAP.reset());
  await page.waitForTimeout(200);

  /* Back from a finished practice swap keeps the terms too */
  await page.click('#modePractice');
  await page.waitForTimeout(200);
  await page.click('[data-act="sampleInv"]');
  await page.waitForTimeout(250);
  await page.click('[data-act="sampleAddr"]');
  await page.waitForTimeout(250);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  check('back: the finished swap offers Back', await page.evaluate(() => !!document.querySelector('[data-act="back"]')));
  await page.click('[data-act="back"]');
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view(page);
  check('back: it returns to the filled form, not an empty one',
    w.steps && (await page.inputValue('#invIn')).length > 10 && (await page.inputValue('#addrIn')).length === 42);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  check('run: no page errors through both modes', A.errs.length === 0, A.errs.join(' | '));
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
  await p2.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
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

  const wrongInv = await other.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '11'.repeat(32), sats: 50000, expiry: 3600 }));
  await other.fill('#invIn', wrongInv);
  await other.waitForTimeout(300);
  const wr = await view(other);
  check('join: an invoice on another hash is refused', wr.ready === '0' && wr.gate === 'mismatch', wr.gate + ' · ' + wr.say);
  check('join: the refusal is plain English', /different swap/.test(wr.say), wr.say);
  check('join: no technical words in the refusal', !JARGON.test(wr.say), wr.say);

  const goodInv = await other.evaluate(() => window.CLEANSWAP.mintInvoice({
    paymentHash: window.CLEANSWAP.state.expectH, sats: 50000, expiry: 3600
  }));
  await other.fill('#invIn', goodInv);
  await other.waitForTimeout(300);
  check('join: the invoice on the pinned hash passes', (await view(other)).ready === '1',
    (await view(other)).gate + ' · ' + (await view(other)).say);
  await other.click('#primary');
  await other.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await other.waitForTimeout(300);
  const otherDone = await other.evaluate(() => ({
    H: window.CLEANSWAP.state.H, id: window.CLEANSWAP.state.id,
    escrow: window.CLEANSWAP.decodeLockCalldata(window.CLEANSWAP.nextCalldata()).hashlock
  }));
  const makerDone = await p3.evaluate(() => ({ H: window.CLEANSWAP.state.H, id: window.CLEANSWAP.state.id }));
  await p3.click('#primary');
  await p3.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
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
  check('gate: a BOLT12 offer is accepted, not sent away for an invoice',
    gates.offer.ok && gates.offer.basis === 'offer' && /^0x[0-9a-f]{64}$/.test(gates.offer.H), gates.offer.code + ' · ' + gates.offer.msg);
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

  /* a BOLT12 invoice (lni...) is read the same way: TLV 168 hash, TLV 170 amount */
  const nowS = Math.floor(Date.now() / 1000);
  const lni = bolt12Invoice('0x' + '5a'.repeat(32), 50000, nowS, 3600);
  const lniOld = bolt12Invoice('0x' + '5a'.repeat(32), 50000, nowS - 7200, 600);
  const lniOut = await p4.evaluate(({ a, b }) => ({
    live: window.CLEANSWAP.readInvoice(a),
    dead: window.CLEANSWAP.readInvoice(b)
  }), { a: lni, b: lniOld });
  check('gate: a BOLT12 invoice is accepted, with its own payment hash',
    lniOut.live.ok && lniOut.live.H === '0x' + '5a'.repeat(32), lniOut.live.code + ' ' + lniOut.live.msg);
  check('gate: a BOLT12 invoice over the amount is refused',
    lniOut.dead.code === 'expired', lniOut.dead.code + ' · ' + lniOut.dead.msg);

  /* A BOLT12 offer (lno1...) is a payment target a wallet pays directly, not a
     dead end. It has no payment hash of its own, so the swap binds to the offer. */
  const nowO = Math.floor(Date.now() / 1000);
  const offerPlain = bolt12Offer({ desc: 'Lexe offer', expiry: nowO + 86400 });
  const offerAmount = bolt12Offer({ amountMsat: 25000 * 1000, expiry: nowO + 86400 });
  const offerDead = bolt12Offer({ expiry: nowO - 120 });
  const offerHashed = bolt12Offer({ hash: '0x' + '6b'.repeat(32), expiry: nowO + 86400 });
  const offerChains = bolt12Offer({ chains: 1 });
  const offerNoId = bolt12Offer({ noNode: true, desc: 'no identity' });
  const offOut = await p4.evaluate((o) => ({
    plain: window.CLEANSWAP.readInvoice(o.plain),
    again: window.CLEANSWAP.readInvoice(o.plain),
    prefixed: window.CLEANSWAP.readInvoice('lightning:' + o.plain),
    amount: window.CLEANSWAP.readInvoice(o.amount),
    dead: window.CLEANSWAP.readInvoice(o.dead),
    hashed: window.CLEANSWAP.readInvoice(o.hashed),
    chains: window.CLEANSWAP.readInvoice(o.chains),
    junk: window.CLEANSWAP.readInvoice('lno1' + 'q'.repeat(40)),
    junk2: window.CLEANSWAP.readInvoice('lno1qqqqqqqqqqqqqqqq'),
    truncated: window.CLEANSWAP.readInvoice(o.plain.slice(0, -8)),
    noId: window.CLEANSWAP.readInvoice(o.noNode)
  }), { plain: offerPlain, amount: offerAmount, dead: offerDead, hashed: offerHashed, chains: offerChains, noNode: offerNoId });
  check('offer: a wallet-shaped lno1 offer is accepted',
    offOut.plain.ok && offOut.plain.basis === 'offer' && /^0x[0-9a-f]{64}$/.test(offOut.plain.H),
    offOut.plain.code + ' · ' + offOut.plain.msg);
  check('offer: the same offer always binds the same swap', offOut.plain.H === offOut.again.H, String(offOut.plain.H).slice(0, 16) + '…');
  check('offer: a lightning: prefix makes no difference',
    offOut.prefixed.ok && offOut.prefixed.H === offOut.plain.H, offOut.prefixed.code);
  check('offer: chains instead of a node id still passes', offOut.chains.ok, offOut.chains.code + ' · ' + offOut.chains.msg);
  check('offer: an expired offer is refused', offOut.dead.code === 'expired', offOut.dead.code + ' · ' + offOut.dead.msg);
  check('offer: the app\'s own offer keeps the hash it embedded',
    offOut.hashed.ok && offOut.hashed.H === '0x' + '6b'.repeat(32), String(offOut.hashed.H).slice(0, 16) + '…');
  check('offer: garbage that looks like an offer is refused',
    offOut.junk.code === 'format' && offOut.junk2.code === 'format', offOut.junk.code + '/' + offOut.junk2.code);
  check('offer: a truncated offer is refused', offOut.truncated.code === 'format', offOut.truncated.code);
  check('offer: text with no node, chains or paths is refused', offOut.noId.code === 'format', offOut.noId.code);
  check('offer: the refusals read as plain English',
    !JARGON.test([offOut.junk.msg, offOut.truncated.msg, offOut.noId.msg, offOut.dead.msg].join(' ')),
    (JARGON.exec([offOut.junk.msg, offOut.truncated.msg, offOut.noId.msg].join(' ')) || [''])[0]);

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

  /* -------------- 7b. an offer and a TRON address, on the actual screen --- */
  const F = await freshPage(390, 844);
  const p6 = F.p;
  await p6.click('#modeWallet');
  await p6.waitForTimeout(250);
  const screenOffer = bolt12Offer({ desc: 'Lexe offer', expiry: Math.floor(Date.now() / 1000) + 86400 });
  await p6.fill('#invIn', screenOffer);
  await p6.fill('#addrIn', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  await p6.waitForTimeout(300);
  w = await view(p6);
  check('screen: an offer and a TRON address together make Approve ready',
    w.ready === '1' && w.gate === 'ok', w.gate + '/' + w.ready);
  check('screen: Open in wallet carries the offer itself',
    w.href === 'lightning:' + screenOffer, w.href.slice(0, 22) + '…');
  await p6.click('[data-act="qrInvoice"]');
  await p6.waitForTimeout(350);
  check('screen: the offer also opens as a QR', (await view(p6)).qr);
  await p6.click('[data-act="qrInvoice"]');
  await p6.waitForTimeout(200);

  await p6.click('#primary');
  await p6.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
  await p6.waitForTimeout(250);
  w = await view(p6);
  check('screen: an offer swap waits for the sats like any other',
    /^Send 50,000 sats to this invoice/.test(w.payLine), w.payLine);
  check('screen: the waiting screen hands the offer to a wallet',
    w.payLink === 'lightning:' + screenOffer, w.payLink.slice(0, 22) + '…');
  check('screen: no address row while the sats are still to go', !w.payRowAddr && !w.payAddrShown, String(w.payAddrShown));
  await p6.screenshot({ path: path.join(SHOTS, 'v43-paying-offer.png') });

  await p6.click('#primary');
  await p6.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await p6.waitForTimeout(250);
  const offerSettled = await p6.evaluate(() => ({
    basis: window.CLEANSWAP.state.basis, addr: window.CLEANSWAP.state.addr,
    rc: document.getElementById('rcAddr').textContent, title: document.getElementById('stepTitle').textContent
  }));
  check('screen: the offer swap completes on I paid', offerSettled.title === 'Swap complete', offerSettled.title);
  check('screen: the swap records that it was paid as an offer', offerSettled.basis === 'offer', String(offerSettled.basis));
  check('screen: the receipt shows the TRON address as it was typed',
    offerSettled.rc === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', offerSettled.rc);
  check('screen: the TRON address is the one on record',
    offerSettled.addr === 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', offerSettled.addr);

  /* the other direction in Wallet: USDT leaves this phone */
  await p6.click('#primary');            /* Done */
  await p6.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await p6.click('#swapDir');
  await p6.waitForTimeout(250);
  const ownInv = await p6.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '9a'.repeat(32), sats: 50000, expiry: 3600 }));
  await p6.fill('#addrIn', 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G');
  await p6.fill('#invIn', ownInv);
  await p6.waitForTimeout(300);
  w = await view(p6);
  check('screen: a partner TRON address and your own invoice are ready', w.ready === '1' && w.dir === 'u2b', w.dir + '/' + w.ready);
  await p6.click('#primary');
  await p6.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
  await p6.waitForTimeout(250);
  w = await view(p6);
  check('screen: sending USDT waits on the transfer, not on an invoice',
    /^Send [\d,.]+ USDT to this address/.test(w.payLine) && w.payRowAddr && !w.payRowInv, w.payLine);
  check('screen: the TRON address sits on the waiting screen',
    w.payAddr === 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G' && w.payAddrShown, w.payAddr);
  check('screen: your own invoice is still one tap from a wallet', w.href === 'lightning:' + ownInv, w.href.slice(0, 20) + '…');
  await p6.screenshot({ path: path.join(SHOTS, 'v43-paying-usdt.png') });
  await p6.click('#primary');
  await p6.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await p6.waitForTimeout(250);
  w = await view(p6);
  check('screen: I paid closes the USDT side and the receipt reads the other way',
    w.state === 'Completed' && /USDT$/.test(w.rc[0]) && /sats$/.test(w.rc[1]), w.rc.join(' | '));
  check('screen: Recent keeps both wallet swaps', w.rows === 2, String(w.rows));
  await p6.screenshot({ path: path.join(SHOTS, 'v43-tron-done.png') });
  check('run: no page errors with an offer and a TRON address', F.errs.length === 0, F.errs.join(' | '));
  await F.c.close();

  /* ------------------------------------------------- 8. protocol vectors --- */
  const E = await freshPage(390, 844);
  const p5 = E.p;
  const vectors = await p5.evaluate(() => {
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

  const b12 = await p5.evaluate(() => {
    const raw = document.getElementById('sample-bolt12').textContent.trim();
    const d = window.CLEANSWAP.decodeSwapOffer(raw);
    return { kind: d.kind, form: d.form, desc: d.description, node: d.nodeId, hash: d.paymentHash, expiry: d.absoluteExpiry };
  });
  check('BOLT12 sample: offer recognised', b12.kind === 'bolt12' && b12.form === 'offer', b12.kind + '/' + b12.form);
  check('BOLT12 sample: offer_description decoded', b12.desc === BOLT12_DESC, b12.desc);
  check('BOLT12 sample: node_id TLV decoded', b12.node === BOLT12_NODE, b12.node);
  check('BOLT12 sample: absolute_expiry TLV decoded', b12.expiry === 1798761600, b12.expiry);
  check('BOLT12 sample: a bare offer carries no payment_hash', b12.hash === null, String(b12.hash));

  const b11 = await p5.evaluate(() => {
    const raw = document.getElementById('sample-bolt11').textContent.trim();
    const d = window.CLEANSWAP.decodeBolt11(raw);
    return { hash: d.paymentHash, sats: d.sats, net: d.network };
  });
  check('BOLT11 sample: payment_hash decoded', b11.hash === BOLT11_SAMPLE_HASH, b11.hash);
  check('BOLT11 sample: 50,000 sats decoded', b11.sats === 50000, b11.sats);
  check('BOLT11 sample: network bc', b11.net === 'bc', b11.net);

  const R0 = 'ab'.repeat(32);
  const expected = crypto.createHash('sha256').update(Buffer.from(R0, 'hex')).digest('hex');
  const got = await p5.evaluate(r => window.CLEANSWAP.sha256Hex(r), R0);
  check('crypto: SHA256(R) equals node crypto', got === expected, got.slice(0, 16) + '…');
  const multi = await p5.evaluate(() => window.CLEANSWAP.sha256Hex('00ffff00'));
  check('crypto: multi-byte preimage vector', multi === crypto.createHash('sha256').update(Buffer.from('00ffff00', 'hex')).digest('hex'));

  /* the synchronous SHA-256 behind the address checksum, against node */
  const sync = await p5.evaluate(() => {
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
  const tronBack = await p5.evaluate((a) => {
    const bytes = window.CLEANSWAP.tronAddressBytes(a);
    return bytes ? Array.from(bytes).map(x => x.toString(16).padStart(2, '0')).join('') : null;
  }, tronSelf);
  check('tron: an address built here keeps its 34 characters', tronSelf.length === 34 && tronSelf.charAt(0) === 'T', tronSelf);
  check('tron: Base58Check decodes back to its 20 bytes',
    tronBack === '7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', String(tronBack));
  const b58 = await p5.evaluate((a) => Array.from(window.CLEANSWAP.base58Bytes(a)).map(x => x.toString(16).padStart(2, '0')).join(''), tronSelf);
  const b58want = Buffer.concat([Buffer.from([0x41]), Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex'),
    crypto.createHash('sha256').update(crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x41]),
      Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex')])).digest()).digest().subarray(0, 4)]).toString('hex');
  check('tron: base58 decodes to the same 25 bytes as an independent encoder', b58 === b58want, b58.slice(0, 12) + '…');
  const tronFlip = await p5.evaluate((a) => {
    const cut = a.slice(0, -2) + (a.slice(-2, -1) === 'B' ? 'C' : 'B') + a.slice(-1);
    return { accepted: window.CLEANSWAP.readAddress(a).ok, flipped: window.CLEANSWAP.readAddress(cut).code };
  }, tronSelf);
  check('tron: the address built here is accepted', tronFlip.accepted === true, tronSelf);
  check('tron: one character changed is refused', tronFlip.flipped === 'format', String(tronFlip.flipped));

  const swapId = await p5.evaluate(async () => window.CLEANSWAP.computeSwapId(
    '0x' + '11'.repeat(32),
    '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71',
    '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761',
    '0x8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097',
    12345678, 1700000000));
  const buf = Buffer.alloc(156);
  Buffer.from('11'.repeat(32), 'hex').copy(buf, 0);
  Buffer.from('7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71', 'hex').copy(buf, 32);
  Buffer.from('3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761', 'hex').copy(buf, 52);
  Buffer.from('8f2b7c1d94a63e05b8d71c4209af6e38b5d2c097', 'hex').copy(buf, 72);
  Buffer.from(12345678n.toString(16).padStart(64, '0'), 'hex').copy(buf, 92);
  Buffer.from(1700000000n.toString(16).padStart(64, '0'), 'hex').copy(buf, 124);
  const expectId = '0x' + crypto.createHash('sha256').update(buf).digest('hex');
  check('contract: computeSwapId mirrors abi.encodePacked', swapId === expectId, swapId.slice(0, 18) + '…');

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
  const payInv = await pp.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '4d'.repeat(32), sats: 50000, expiry: 3600 }));
  await pp.fill('#invIn', payInv);
  await pp.fill('#addrIn', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  await pp.waitForTimeout(300);
  await pp.click('#primary');
  await pp.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
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
  const qrInv = await qp.evaluate(() => window.CLEANSWAP.mintInvoice({ paymentHash: '0x' + '44'.repeat(32), sats: 50000, expiry: 3600 }));
  await qp.click('#modeWallet');
  await qp.waitForTimeout(250);
  await qp.fill('#invIn', qrInv);
  await qp.waitForTimeout(300);
  await qp.click('[data-act="qrInvoice"]');
  await qp.waitForTimeout(350);
  await qp.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await qp.waitForTimeout(250);
  const deep = await qp.evaluate(() => {
    const q = document.getElementById('qrBox').getBoundingClientRect();
    const b = document.querySelector('.bar').getBoundingClientRect();
    return { qrBottom: Math.round(q.bottom), qrTop: Math.round(q.top), barTop: Math.round(b.top) };
  });
  check('qr 360x780: the invoice QR never sits under the Approve bar',
    deep.qrBottom <= deep.barTop - 4, 'qr ' + deep.qrTop + '..' + deep.qrBottom + ' bar ' + deep.barTop);
  await qp.screenshot({ path: path.join(SHOTS, 'v43-qr-360.png') });
  await qp.click('[data-act="qrInvoice"]');
  await qp.waitForTimeout(200);
  check('qr: tapping the button again folds it away', !(await qp.evaluate(() => !!document.querySelector('#qrBox svg'))));
  await qrCtx.c.close();

  const desktop = await freshPage(1280, 860);
  await desktop.p.screenshot({ path: path.join(SHOTS, 'v43-desktop.png') });
  await desktop.c.close();

  await E.c.close();
  await browser.close();

  console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
