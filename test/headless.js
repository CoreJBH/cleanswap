/* Headless verification for the built single-file app.

   Run:
     PLAYWRIGHT_PKG=/workspace/.local/lib/python3.12/site-packages/playwright/driver/package \
     LD_LIBRARY_PATH=/workspace/tmp/sysroot/usr/lib/x86_64-linux-gnu \
     /workspace/.local/lib/python3.12/site-packages/playwright/driver/node test/headless.js

   The suite drives the real DOM only: every state change goes through a click on
   the button a person would press. The point of the gates is that a click alone
   is not enough, so a large share of these checks assert that a click does NOT
   advance while the gate is unmet.

   Covers: boot, WebCrypto SHA-256, abi.encodePacked swap id, the Send BTC /
   Send USDT direction switch, BOLT12 offer mint and decode (plus BOLT12/BOLT11
   samples), the three lock gates (offer or invoice, escrow proof, preimage),
   the refund path, wallet mode with a receipt, the Send-USDT start on one
   screen, the USDT side reached through a #s= link, layout at 390x844 /
   360x780 / 1280x800, and a Hangul-free UI. Writes shots/v2-*.png.
*/
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PKG = process.env.PLAYWRIGHT_PKG || 'playwright';
const { chromium } = require(PKG);
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const SHOTS = path.resolve(__dirname, '..', 'shots');
const URL = 'file://' + APP;
const HANGUL = /[\uac00-\ud7af]/;

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '   [' + detail + ']'));
}

const BOLT11_SAMPLE_HASH = '0x' + '11'.repeat(32);
const BOLT12_NODE = '02d40d722b8fa32f8c588757c481462b27dadfece667ea0c662daa0e6d8a8b595e';
const BOLT12_DESC = 'CleanSwap - BTC for USDT';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();

  /* ---------------------------------------------------------- 1. boot --- */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const failedReqs = [];
  page.on('requestfailed', r => {
    const u = r.url();
    if (!/mempool\.space/.test(u)) failedReqs.push(u + ' :: ' + (r.failure() && r.failure().errorText));
  });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });

  const boot = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    mode: document.body.dataset.mode,
    role: document.body.dataset.role,
    rate: document.getElementById('rateTxt').textContent,
    pstate: window.CLEANSWAP.state.pstate,
    headline: document.getElementById('statusTxt').textContent,
    primary: document.getElementById('primary').textContent,
    gate: document.getElementById('gate').dataset.state,
    gateTxt: document.getElementById('gateTxt').textContent,
    dirBtn: !!document.getElementById('swapDir'),
    drawer: !!document.querySelector('details.tech'),
    hasQR: typeof window.QR === 'object' && typeof window.QR.encode === 'function',
    hasSubtle: !!(window.crypto && window.crypto.subtle)
  }));
  check('boot: no page or console errors', errors.length === 0, errors.join(' | '));
  check('boot: no unexpected failed requests', failedReqs.length === 0, failedReqs.join(' | '));
  check('boot: starts idle, practice, bitcoin side', boot.phase === 'idle' && boot.mode === 'practice' && boot.role === 'maker',
    boot.phase + '/' + boot.mode + '/' + boot.role);
  check('boot: live rate chip (live or honest offline)', /^1 BTC ≈ [\d,]+ USDT$/.test(boot.rate) && ['live', 'offline'].includes(boot.pstate),
    boot.pstate + ' ' + boot.rate);
  check('boot: WebCrypto available', boot.hasSubtle);
  check('boot: QR encoder present', boot.hasQR);
  check('boot: English headline', boot.headline === 'Swap bitcoin for USDT', boot.headline);
  check('boot: primary is Create swap', boot.primary === 'Create swap', boot.primary);
  check('boot: idle gate explains creation', boot.gate === 'ok' && /generates a fresh secret/.test(boot.gateTxt), boot.gateTxt);
  check('boot: the direction switch is on the board', boot.dirBtn);
  check('boot: no technical drawer on the page', !boot.drawer);

  const html = await page.content();
  check('content: no browser-extension wallet (window.ethereum) anywhere', !/window\.ethereum|eth_requestAccounts|ethereum\.request/i.test(html));
  check('content: no WebLN hand-off left (installed wallet apps only)', !/webln/i.test(html));
  check('content: contract source embedded (sha256 hashlock)', /sha256\(abi\.encodePacked\(preimage\)\)/.test(html));
  check('content: no remote scripts or styles', !/<script[^>]+src=/i.test(html) && !/<link[^>]+rel="stylesheet"/i.test(html));
  check('content: no Hangul in the built page', !HANGUL.test(html), (html.match(HANGUL) || []).length + ' chars');
  const uiText = await page.evaluate(() => document.body.innerText);
  check('content: no Hangul in rendered text', !HANGUL.test(uiText), (uiText.match(HANGUL) || []).length + ' chars');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-idle.png') });

  /* ------------------------------------------------- 2. real WebCrypto --- */
  const R0 = 'ab'.repeat(32);
  const expected = crypto.createHash('sha256').update(Buffer.from(R0, 'hex')).digest('hex');
  const got = await page.evaluate(r => window.CLEANSWAP.sha256Hex(r), R0);
  check('crypto: SHA256(R) equals node crypto', got === expected, got.slice(0, 16) + '…');
  const multi = await page.evaluate(() => window.CLEANSWAP.sha256Hex('00ffff00'));
  check('crypto: multi-byte preimage vector', multi === crypto.createHash('sha256').update(Buffer.from('00ffff00', 'hex')).digest('hex'));

  const swapId = await page.evaluate(async () => window.CLEANSWAP.computeSwapId(
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

  /* ---------------------------------------------------- 3. bech32 / 12 --- */
  const vectors = await page.evaluate(() => {
    const out = {};
    for (const v of ['A12UEL5L', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
      'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w']) {
      try { window.CLEANSWAP.bech32Decode(v); out[v] = 'ok'; } catch (e) { out[v] = 'err:' + e.message; }
    }
    try { window.CLEANSWAP.bech32Decode('A12UEL5X'); out.bad = 'ok'; } catch (e) { out.bad = 'err:' + e.message; }
    return out;
  });
  check('bech32: BIP-173 valid vectors pass',
    Object.entries(vectors).filter(([k]) => k !== 'bad').every(([, v]) => v === 'ok'),
    JSON.stringify(vectors));
  check('bech32: bad checksum rejected', /checksum/.test(vectors.bad), vectors.bad);

  const b12 = await page.evaluate(() => {
    const raw = document.getElementById('sample-bolt12').textContent.trim();
    const d = window.CLEANSWAP.decodeSwapOffer(raw);
    return { kind: d.kind, form: d.form, desc: d.description, node: d.nodeId, hash: d.paymentHash, expiry: d.absoluteExpiry };
  });
  check('BOLT12 sample: offer recognised', b12.kind === 'bolt12' && b12.form === 'offer', b12.kind + '/' + b12.form);
  check('BOLT12 sample: offer_description decoded', b12.desc === BOLT12_DESC, b12.desc);
  check('BOLT12 sample: node_id TLV decoded', b12.node === BOLT12_NODE, b12.node);
  check('BOLT12 sample: absolute_expiry TLV decoded', b12.expiry === 1798761600, b12.expiry);
  check('BOLT12 sample: a bare offer carries no payment_hash', b12.hash === null, String(b12.hash));

  const b11 = await page.evaluate(() => {
    const raw = document.getElementById('sample-bolt11').textContent.trim();
    const d = window.CLEANSWAP.decodeBolt11(raw);
    return { hash: d.paymentHash, sats: d.sats, net: d.network };
  });
  check('BOLT11 sample: payment_hash decoded', b11.hash === BOLT11_SAMPLE_HASH, b11.hash);
  check('BOLT11 sample: 50,000 sats decoded', b11.sats === 50000, b11.sats);
  check('BOLT11 sample: network bc', b11.net === 'bc', b11.net);

  const oneReader = await page.evaluate(() => {
    const offer = document.getElementById('sample-bolt12').textContent.trim();
    const inv = document.getElementById('sample-bolt11').textContent.trim();
    const a = window.CLEANSWAP.parseLightning(offer);
    const b = window.CLEANSWAP.parseLightning('lightning:' + inv);
    return { a: a.kind + ':' + a.form, b: b.kind };
  });
  check('parse: one input reads BOLT12 and BOLT11 alike',
    oneReader.a === 'bolt12:offer' && oneReader.b === 'bolt11', JSON.stringify(oneReader));

  /* ------------------------------------------- 4. direction switch ------- */
  await page.click('#swapDir');
  await page.waitForTimeout(250);
  let dirState = await page.evaluate(() => ({
    role: document.body.dataset.role,
    head: document.getElementById('statusTxt').textContent,
    note: document.getElementById('note').textContent
  }));
  check('direction: one tap flips to Send USDT', dirState.role === 'taker' && dirState.head === 'You send USDT', dirState.role + ' ' + dirState.head);
  check('direction: the note says which side you are', /USDT side/.test(dirState.note), dirState.note);
  await page.click('#swapDir');
  await page.waitForTimeout(250);
  dirState = await page.evaluate(() => document.body.dataset.role);
  check('direction: one tap flips back to Send BTC', dirState === 'maker', dirState);

  /* ------------------------------------------------------- 5. create --- */
  const phase = () => page.evaluate(() => document.body.dataset.phase);
  const btn = () => page.textContent('#primary');
  const gateState = () => page.evaluate(() => ({
    state: document.getElementById('gate').dataset.state,
    text: document.getElementById('gateTxt').textContent,
    ready: document.getElementById('primary').dataset.ready
  }));

  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const offer = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { H: s.H, R: s.R, id: s.id, t1: s.t1, t2: s.t2, counter: s.counterInv, alt: s.altInv, units: s.units, sats: s.sats };
  });
  const realHash = '0x' + crypto.createHash('sha256').update(Buffer.from(offer.R.replace(/^0x/, ''), 'hex')).digest('hex');
  check('create: 32-byte preimage R', /^0x[0-9a-f]{64}$/.test(offer.R));
  check('create: H is the real SHA-256 of R', offer.H === realHash, offer.H.slice(0, 20) + '…');
  check('create: T1 sits above T2 in wall-clock terms', offer.t1 > 0 && offer.t2 > 0 && offer.t2 - Math.floor(Date.now() / 1000) <= 3600);
  check('create: swapId derived', /^0x[0-9a-f]{64}$/.test(offer.id));
  check('create: counterparty BOLT12 offer minted', /^lno1\w+/.test(offer.counter), offer.counter.slice(0, 24) + '…');
  check('create: offer is short enough to fit a QR', offer.counter.length <= 340 && offer.alt.length <= 340,
    offer.counter.length + ' chars');
  check('create: step 1 asks for the offer', (await page.textContent('#stepTitle')) === 'Lock bitcoin', await page.textContent('#stepTitle'));
  check('create: primary is the bitcoin lock', (await btn()) === 'Pay invoice & lock bitcoin', await btn());

  const offerOk = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    const d = window.CLEANSWAP.decodeSwapOffer(s.counterInv);
    return { hash: d.paymentHash, sats: d.sats, form: d.form, len: s.counterInv.length };
  });
  check('offer: minted offer decodes back to H', offerOk.hash === offer.H, String(offerOk.hash).slice(0, 18) + '…');
  check('offer: minted offer carries the swap amount', offerOk.sats === offer.sats, String(offerOk.sats));
  check('offer: the hashlock rides in the type-80 TLV', offerOk.form === 'offer' && !!offerOk.hash, offerOk.form);

  const linkState = await page.evaluate(() => {
    const link = window.CLEANSWAP.swapLink();
    return { link, parsed: window.CLEANSWAP.parseSwapLink(link.split('#')[1]) };
  });
  check('share: swap link encodes H, amount and T2',
    linkState.parsed && linkState.parsed.H === offer.H && linkState.parsed.sats === offer.sats && linkState.parsed.t2 === offer.t2,
    linkState.link.slice(-60));

  /* ------------------------------- 6. gate 1: no offer, no advance --- */
  const before = await phase();
  await page.click('#primary');
  await page.waitForTimeout(350);
  let g = await gateState();
  check('gate 1: clicking with an empty field does not advance', (await phase()) === before, await phase());
  check('gate 1: empty field explains what is missing', g.state !== 'ok' && /Paste the BOLT12 offer or invoice/.test(g.text), g.state + ' · ' + g.text);
  check('gate 1: primary marked not ready', g.ready === '0', g.ready);
  const blocked = await page.textContent('#log');
  check('gate 1: refusal is recorded in the log', /BLOCK/.test(blocked));

  await page.click('[data-act="wrongOffer"]');
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 1: a mismatched offer is rejected', g.state === 'err' && /is for a different swap/.test(g.text), g.text);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 1: a mismatched offer cannot lock bitcoin', (await phase()) === 'open', await phase());
  await page.waitForTimeout(2300);
  await page.evaluate(() => document.getElementById('step').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-blocked.png') });

  await page.fill('#invIn', 'lnbc2500u1notarealinvoice');
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 1: garbage input reports a format error', g.state === 'err' && /rejected|checksum|not a BOLT/i.test(g.text), g.text);

  const wrongAmount = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.mintOffer({ paymentHash: s.H, sats: s.sats * 2, expiry: 3600 });
  });
  await page.fill('#invIn', wrongAmount);
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 1: an offer for another amount is rejected', g.state === 'err' && /sats/.test(g.text), g.text);

  const bolt11SameHash = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.mintInvoice({ paymentHash: s.H, sats: s.sats, expiry: 3600 });
  });
  await page.fill('#invIn', bolt11SameHash);
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 1: a BOLT11 hold invoice with the same H passes too',
    g.state === 'ok' && /BOLT11 invoice verified/.test(g.text), g.text);

  await page.click('[data-act="qrLink"]');
  await page.waitForTimeout(300);
  const linkQr = await page.evaluate(() => {
    const svg = document.querySelector('#qrLinkBox svg');
    return svg ? { has: true, modules: (svg.innerHTML.match(/M\d+ \d+h1v1h-1z/g) || []).length, len: window.CLEANSWAP.swapLink().length } : null;
  });
  check('share: the swap link renders as a QR', linkQr && linkQr.modules > 100, linkQr && linkQr.modules + ' modules, ' + linkQr.len + ' chars');
  check('share: the link fits the encoder', linkQr && linkQr.len <= 340, linkQr && String(linkQr.len));

  await page.click('[data-act="fillOffer"]');
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 1: the real offer passes', g.state === 'ok' && /BOLT12 offer verified/.test(g.text), g.text);
  check('gate 1: primary becomes ready', g.ready === '1', g.ready);
  check('gate 1: offer field marked valid', (await page.getAttribute('#invIn', 'data-state')) === 'ok');

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.waitForTimeout(2300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'v2-half.png') });
  check('lock: bitcoin leg is held', (await page.textContent('#chipBtcTxt')) === 'HTLC held', await page.textContent('#chipBtcTxt'));
  check('lock: USDT side still open', (await page.textContent('#chipUsdtTxt')) === 'Unlocked');
  check('lock: rail reports one side in', (await page.textContent('#railState')) === 'Bitcoin locked · waiting for USDT');
  check('lock: headline moves on', (await page.textContent('#statusTxt')) === 'Bitcoin is locked · USDT next');
  check('lock: step 2 verifies the escrow', (await page.textContent('#stepTitle')) === 'Verify the USDT lock', await page.textContent('#stepTitle'));
  const logText1 = await page.textContent('#log');
  check('lock: log records VERIFY and LOCK', /VERIFY/.test(logText1) && /LOCK/.test(logText1));

  /* ------------------------------------------------- 7. gate 2: proof --- */
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 2: empty proof does not advance', (await phase()) === 'btc', await phase());
  g = await gateState();
  check('gate 2: empty proof explains what is missing', g.state !== 'ok' && /Paste the escrow proof/.test(g.text), g.state + ' · ' + g.text);

  await page.fill('#proofIn', 'not-a-proof-at-all');
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: unrecognised proof rejected', g.state === 'err' && /Unrecognised proof/.test(g.text), g.text);

  await page.click('[data-act="wrongProof"]');
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: escrow locked to another hash rejected', g.state === 'err' && /not H/.test(g.text), g.text);
  await page.click('#primary');
  await page.waitForTimeout(250);
  check('gate 2: a wrong hashlock cannot unlock step 3', (await phase()) === 'btc', await phase());

  const badTimelock = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.lockCalldata({
      hashlock: s.H, timelock: s.t2 + 60, receiver: window.CLEANSWAP.EVM.btcSide,
      token: window.CLEANSWAP.EVM.token, amount: s.units
    });
  });
  await page.fill('#proofIn', badTimelock);
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: wrong timelock rejected', g.state === 'err' && /timelock/.test(g.text), g.text);

  const badAmount = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.lockCalldata({
      hashlock: s.H, timelock: s.t2, receiver: window.CLEANSWAP.EVM.btcSide,
      token: window.CLEANSWAP.EVM.token, amount: s.units - 1000000
    });
  });
  await page.fill('#proofIn', badAmount);
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: wrong amount rejected', g.state === 'err' && /USDT/.test(g.text), g.text);

  const jsonProof = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return JSON.stringify({ protocol: 'cleanswap/evm-lock/1', hashlock: s.H, timelock: s.t2, amount: String(s.units), receiver: window.CLEANSWAP.EVM.btcSide });
  });
  await page.fill('#proofIn', jsonProof);
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: a JSON lock record is decoded and matched', g.state === 'ok' && /lock record decoded/.test(g.text), g.text);

  const liquidProof = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return 'liquidnetwork:lq1qqwm4j0d9z6exampleaddress0x9f2k?amount=' + (s.units / 1e6).toFixed(6) + '&hashlock=' + s.H + '&timelock=' + s.t2;
  });
  await page.fill('#proofIn', liquidProof);
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: a Liquid lock URI is decoded and matched', g.state === 'ok' && /Liquid lock/.test(g.text), g.text);

  await page.fill('#proofIn', '0x' + '7f'.repeat(32));
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: a bare tx hash is accepted only as a reference', g.state === 'ref' && /reference/.test(g.text), g.text);

  await page.click('[data-act="fillProof"]');
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 2: generated escrow calldata verifies', g.state === 'ok' && /lock\(\) calldata decoded/.test(g.text), g.text);
  const calldataCheck = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    const d = window.CLEANSWAP.decodeLockCalldata(s.H ? document.getElementById('proofIn').value : '');
    return { selector: d.selector, hash: d.hashlock, lock: d.timelock, amount: d.amount, receiver: d.receiver };
  });
  check('gate 2: calldata uses the lock() selector', calldataCheck.selector === '91644b2b', calldataCheck.selector);
  check('gate 2: calldata binds H, T2 and the USDT amount',
    calldataCheck.hash === offer.H && calldataCheck.lock === String(offer.t2) && calldataCheck.amount === String(offer.units),
    calldataCheck.lock + '/' + calldataCheck.amount);

  /* hand the generated calldata to test/contract-evm.py, which decodes it with
     eth-abi and checks the selector against keccak of the real signature */
  const calldataDump = await page.evaluate(() => ({
    protocol: 'cleanswap/evm-lock/1',
    calldata: document.getElementById('proofIn').value,
    selector: window.CLEANSWAP.SEL.lock,
    hashlock: window.CLEANSWAP.state.H,
    timelock: window.CLEANSWAP.state.t2,
    amount: window.CLEANSWAP.usdtUnits(),
    receiver: window.CLEANSWAP.EVM.btcSide,
    token: window.CLEANSWAP.EVM.token
  }));
  fs.mkdirSync(path.resolve(__dirname, '..', 'build'), { recursive: true });
  fs.writeFileSync(path.resolve(__dirname, '..', 'build', 'app-calldata.json'), JSON.stringify(calldataDump, null, 2));

  await page.waitForTimeout(2400);
  await page.evaluate(() => document.getElementById('step').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-verified.png') });

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-locked.png') });
  check('lock: both legs in', (await page.textContent('#chipBtcTxt')) === 'HTLC held' && (await page.textContent('#chipUsdtTxt')) === 'Locked');
  check('lock: rail reports both sides', (await page.textContent('#railState')) === 'Both sides locked · settle before T2');
  check('lock: headline announces settlement', (await page.textContent('#statusTxt')) === 'Both sides locked · settle now');
  check('lock: step 3 asks for the preimage', (await page.textContent('#stepTitle')) === 'Settle with the preimage');

  /* ---------------------------------------------- 8. gate 3: preimage --- */
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 3: empty preimage does not settle', (await phase()) === 'both', await phase());
  g = await gateState();
  check('gate 3: empty preimage explains what is missing', g.state !== 'ok' && /preimage R/.test(g.text), g.state + ' · ' + g.text);

  await page.click('[data-act="wrongPre"]');
  await page.waitForTimeout(400);
  g = await gateState();
  check('gate 3: wrong preimage is refused with the computed hash', g.state === 'err' && /SHA256\(R\)/.test(g.text), g.text);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 3: a wrong R cannot settle the swap', (await phase()) === 'both', await phase());
  const logBlocked = await page.textContent('#log');
  check('gate 3: refusal recorded in the log', /BLOCK/.test(logBlocked));

  await page.fill('#preIn', 'zz');
  await page.waitForTimeout(300);
  g = await gateState();
  check('gate 3: a short R reports a format error', g.state === 'err' && /64 hex/.test(g.text), g.text);

  await page.click('[data-act="reveal"]');
  await page.waitForTimeout(200);
  check('seal: the local secret can be opened', !(await page.evaluate(() => document.getElementById('seal').hidden)));
  await page.click('[data-act="fillPre"]');
  await page.waitForTimeout(350);
  g = await gateState();
  check('gate 3: the real R passes SHA256(R) === H', g.state === 'ok' && /SHA256\(R\) matches H/.test(g.text), g.text);

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  const settled = await page.evaluate(() => ({
    head: document.getElementById('statusTxt').textContent,
    btc: document.getElementById('chipBtcTxt').textContent,
    usdt: document.getElementById('chipUsdtTxt').textContent,
    rail: document.getElementById('railState').textContent,
    R: window.CLEANSWAP.state.R,
    claim: window.CLEANSWAP.nextCalldata(),
    hist: document.getElementById('history').hidden ? '' : document.querySelector('.hist-item b').textContent
  }));
  check('settle: headline confirms the swap', settled.head === 'Swap settled', settled.head);
  check('settle: both chips close out', settled.btc === 'Settled' && settled.usdt === 'Claimed', settled.btc + '/' + settled.usdt);
  check('settle: rail reports closed', /Settled/.test(settled.rail), settled.rail);
  check('settle: claim calldata carries swapId and R',
    settled.claim.startsWith('0x84cc9dfb') && settled.claim.includes(settled.R.replace(/^0x/, '')), settled.claim.slice(0, 20) + '…');
  check('settle: the history shows one line', /^\+[\d,.]+ USDT$/.test(settled.hist), settled.hist);
  const logText = await page.textContent('#log');
  check('settle: log records CHECK / REVEAL / SETTLE', /REVEAL/.test(logText) && /SETTLE/.test(logText));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-settled.png') });

  /* ------------------------------------------------- 9. refund path --- */
  await page.click('#primary'); // start a new swap
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  check('reset: preimage and hashlock cleared',
    await page.evaluate(() => !window.CLEANSWAP.state.H && !window.CLEANSWAP.state.R));
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.click('[data-act="fillOffer"]');
  await page.waitForTimeout(300);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.click('#ghostA'); // advance the test clock past T2
  await page.waitForFunction(() => document.body.dataset.phase === 'expired', null, { timeout: 5000 });
  check('refund: timelock expiry closes the claim window', (await page.textContent('#statusTxt')) === 'Timelock expired');
  check('refund: primary offers the refund', (await btn()) === 'Refund both legs', await btn());
  check('refund: chips show the amber state', (await page.getAttribute('#chipUsdt', 'class')).includes('warn'));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-expired.png') });

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'refunded', null, { timeout: 5000 });
  check('refund: swap closes as refunded', (await page.textContent('#statusTxt')) === 'Both legs refunded');
  check('refund: history shows the refund', /Refunded/.test(await page.textContent('#history')));

  /* -------------------------------------------------- 10. wallet mode --- */
  await page.click('#primary'); // new swap
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#modeWallet');
  await page.waitForTimeout(300);
  check('wallet: mode badge switches', (await page.evaluate(() => document.body.dataset.mode)) === 'wallet');
  check('wallet: note describes the real hand-off', /Wallet mode/.test(await page.textContent('#note')));
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const walletUi = await page.evaluate(() => ({
    receipt: !document.getElementById('receiptIn').hidden,
    share: document.getElementById('shareRow').hidden,
    open: document.getElementById('walletLink').getAttribute('href').slice(0, 10),
    row: Array.from(document.querySelectorAll('#wRow .btn')).map((b) => b.textContent.trim())
  }));
  check('wallet: receipt field is shown', walletUi.receipt);
  check('wallet: share link hidden (this is a real hand-off)', walletUi.share);
  check('wallet: the row is wallet, copy and QR only', walletUi.row.join('/') === 'Open in wallet/Copy/QR', walletUi.row.join(' · '));
  check('wallet: no WebLN button and no webln handler',
    (await page.$('#btnWebln')) === null && (await page.$$('[data-act="webln"]')).length === 0);
  await page.fill('#invIn', await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.mintOffer({ paymentHash: s.H, sats: s.sats, expiry: 3600 });
  }));
  await page.waitForTimeout(300);
  const walletHref = await page.getAttribute('#walletLink', 'href');
  check('wallet: deep link carries the pasted offer', walletHref.startsWith('lightning:lno1'), walletHref.slice(0, 28) + '…');
  await page.click('[data-act="copyInv"]');
  await page.waitForTimeout(200);
  check('wallet: copy hands the invoice over', /Invoice copied/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  await page.click('[data-act="qrIn"]');
  await page.waitForTimeout(300);
  const walletQr = await page.evaluate(() => {
    const svg = document.querySelector('#qrInBox svg');
    return svg ? (svg.innerHTML.match(/M\d+ \d+h1v1h-1z/g) || []).length : 0;
  });
  check('wallet: the offer renders as a scannable QR', walletQr > 100, walletQr + ' modules');
  let wg = await gateState();
  check('wallet: a valid offer alone is not a payment', wg.state !== 'ok' && /payment_hash/i.test(wg.text), wg.state + ' · ' + wg.text);
  await page.click('#primary');
  await page.waitForTimeout(250);
  check('wallet: without a receipt the lock is refused', (await phase()) === 'open', await phase());
  await page.fill('#receiptIn', '0x' + '22'.repeat(32));
  await page.waitForTimeout(300);
  wg = await gateState();
  check('wallet: a receipt for another payment is refused', wg.state === 'err' && /not H/.test(wg.text), wg.text);
  await page.fill('#receiptIn', (await page.evaluate(() => window.CLEANSWAP.state.H)).replace('0x', ''));
  await page.waitForTimeout(300);
  wg = await gateState();
  check('wallet: the matching receipt unlocks the lock', wg.state === 'ok' && /Wallet receipt matches H/.test(wg.text), wg.text);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  check('wallet: bitcoin locks with a verified receipt', (await page.textContent('#chipBtcTxt')) === 'HTLC held');

  /* --------------------------------- 11. Send USDT on one screen --- */
  await page.click('#ghostB'); // reset the wallet swap
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#modePractice'); // back from wallet mode
  await page.waitForTimeout(250);
  await page.click('#swapDir'); // Send USDT
  await page.waitForTimeout(250);

  const usdtStart = await page.evaluate(() => ({
    role: document.body.dataset.role,
    head: document.getElementById('statusTxt').textContent,
    primary: document.getElementById('primary').textContent,
    gate: document.getElementById('gateTxt').textContent
  }));
  check('usdt start: the home screen offers Send USDT', usdtStart.role === 'taker' && usdtStart.primary === 'Start swap',
    usdtStart.role + '/' + usdtStart.primary);
  check('usdt start: the gate explains the direction', /send [\d,.]+ USDT and receive bitcoin/.test(usdtStart.gate), usdtStart.gate);

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.waitForTimeout(450);
  const frozen = await page.evaluate(() => {
    const vis = id => {
      const el = document.getElementById(id);
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };
    return {
      sats: window.CLEANSWAP.state.sats,
      presets: vis('presets'),
      dirBtn: vis('swapDir'),
      role: window.CLEANSWAP.state.role
    };
  });
  check('approval: the amount presets are gone once the swap is open', !frozen.presets);
  check('approval: the direction switch is gone once the swap is open', !frozen.dirBtn);
  check('approval: the amount cannot change mid-swap', frozen.sats === offer.sats, String(frozen.sats));

  const usdtOpen = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return {
      role: s.role, H: s.H, R: s.R, inv: s.inv, phase: document.body.dataset.phase,
      step: document.getElementById('stepTitle').textContent,
      out: document.getElementById('issueOut').textContent,
      gate: document.getElementById('gateTxt').textContent,
      btc: document.getElementById('chipBtcTxt').textContent
    };
  });
  check('usdt start: opens as the USDT side with no link', usdtOpen.role === 'taker' && usdtOpen.phase === 'open', usdtOpen.role);
  check('usdt start: a simulated bitcoin-side H exists', /^0x[0-9a-f]{64}$/.test(usdtOpen.H), String(usdtOpen.H).slice(0, 14) + '…');
  check('usdt start: the preimage stays on this device', /^0x[0-9a-f]{64}$/.test(usdtOpen.R), String(usdtOpen.R).slice(0, 14) + '…');
  check('usdt start: an offer was minted and pasted in one step',
    /^lno1/.test(usdtOpen.inv) && usdtOpen.out === usdtOpen.inv, usdtOpen.out.slice(0, 20) + '…');
  check('usdt start: step 1 is the offer check', usdtOpen.step === 'Verify the offer', usdtOpen.step);
  await page.click('[data-act="copyIssue"]');
  await page.waitForTimeout(200);
  check('usdt start: copy hands the offer over', /Invoice copied/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  check('usdt start: the minted offer already passes the gate', /hashlock and 50,000 sats/.test(usdtOpen.gate), usdtOpen.gate);

  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'v2-usdt-start.png') });

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v2-usdt-step2.png') });
  check('usdt start: the simulated HTLC arrives', (await page.textContent('#chipBtcTxt')) === 'HTLC held');
  check('usdt start: step 2 locks the USDT', (await page.textContent('#stepTitle')) === 'Lock USDT in escrow', await page.textContent('#stepTitle'));

  await page.click('#primary');
  await page.waitForTimeout(300);
  check('usdt start: an empty escrow proof does not advance', (await phase()) === 'btc', await phase());
  await page.click('[data-act="fillProof"]');
  await page.waitForTimeout(300);
  g = await gateState();
  check('usdt start: the generated lock verifies', g.state === 'ok' && /lock\(\) calldata decoded/.test(g.text), g.text);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  check('usdt start: USDT locks against the same H', (await page.textContent('#railState')) === 'Both sides locked · settle before T2');

  await page.click('#primary');
  await page.waitForTimeout(300);
  check('usdt start: settlement still needs the revealed R', (await phase()) === 'both', await phase());
  await page.click('[data-act="fillPre"]');
  await page.waitForTimeout(400);
  g = await gateState();
  check('usdt start: the revealed R passes the hash check', /SHA256\(R\) matches H/.test(g.text), g.text);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  check('usdt start: the swap settles from the USDT side', (await page.textContent('#statusTxt')) === 'Swap settled');
  const usdtHist = await page.textContent('#history');
  check('usdt start: the history records the sats received', /\+50,000 sats/.test(usdtHist), usdtHist.slice(0, 60));
  await page.waitForTimeout(2400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, 'v2-usdt-settled.png') });

  /* wallet mode, Send USDT: the offer you were sent builds the swap */
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#modeWallet');
  await page.waitForTimeout(250);
  const walletTaker = await page.evaluate(() => ({
    swapRow: !document.getElementById('swapRow').hidden,
    input: !document.getElementById('swapIn').hidden,
    gate: document.getElementById('gateTxt').textContent,
    ready: document.getElementById('primary').dataset.ready
  }));
  check('usdt wallet: the paste field appears on the home screen', walletTaker.swapRow && walletTaker.input);
  check('usdt wallet: starting without it is blocked', walletTaker.ready === '0' && /paste the BOLT12 offer or invoice/i.test(walletTaker.gate),
    walletTaker.ready + ' · ' + walletTaker.gate);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('usdt wallet: the start click does not open a swap', (await phase()) === 'idle', await phase());
  await page.fill('#swapIn', await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return window.CLEANSWAP.mintOffer({ paymentHash: '0x' + '3e'.repeat(32), sats: s.sats, expiry: 3600 });
  }));
  await page.waitForTimeout(350);
  g = await gateState();
  check('usdt wallet: a pasted offer arms the start button', g.ready === '1' && /send/.test(g.text), g.ready + ' · ' + g.text);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const usdtWallet = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { H: s.H, sats: s.sats, role: s.role, step: document.getElementById('stepTitle').textContent };
  });
  check('usdt wallet: the swap builds on the pasted hashlock',
    usdtWallet.H === '0x' + '3e'.repeat(32) && usdtWallet.role === 'taker', String(usdtWallet.H).slice(0, 14) + '…');
  check('usdt wallet: step 1 verifies the offer', usdtWallet.step === 'Verify the offer', usdtWallet.step);

  /* ------------------------------------------- 12. USDT side via link --- */
  await page.click('#ghostB'); // reset the wallet taker swap
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#swapDir'); // back to Send BTC
  await page.waitForTimeout(250);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const maker = await page.evaluate(() => ({ link: window.CLEANSWAP.swapLink(), H: window.CLEANSWAP.state.H, R: window.CLEANSWAP.state.R }));
  const taker = await ctx.newPage();
  const takerErrors = [];
  taker.on('pageerror', e => takerErrors.push('pageerror: ' + e.message));
  taker.on('console', m => { if (m.type() === 'error') takerErrors.push('console: ' + m.text()); });
  await taker.goto(maker.link, { waitUntil: 'load' });
  await taker.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  const joined = await taker.evaluate(() => ({
    role: document.body.dataset.role,
    phase: document.body.dataset.phase,
    head: document.getElementById('statusTxt').textContent,
    step: document.getElementById('stepTitle').textContent,
    actor: document.getElementById('stepActor').textContent,
    badge: !document.getElementById('roleBadge').hidden,
    H: window.CLEANSWAP.state.H,
    sats: window.CLEANSWAP.state.sats,
    R: window.CLEANSWAP.state.R
  }));
  check('link: opens as the USDT side', joined.role === 'taker' && joined.badge, joined.role + '/' + joined.badge);
  check('link: same hashlock, no preimage', joined.H === maker.H && joined.R === null, String(joined.H).slice(0, 12) + '…');
  check('link: amount carried over', joined.sats === offer.sats, joined.sats);
  check('link: step 1 verifies the offer', joined.step === 'Verify the offer' && joined.actor.includes('USDT side'), joined.step);
  check('link: no page errors on the joined tab', takerErrors.length === 0, takerErrors.join(' | '));

  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  const minted = await taker.evaluate(() => {
    const s = window.CLEANSWAP.state;
    const d = window.CLEANSWAP.decodeSwapOffer(s.inv);
    return { inv: s.inv, hash: d.paymentHash, sats: d.sats, form: d.form, len: s.inv.length };
  });
  check('link: minted offer carries H', minted.hash === maker.H, String(minted.hash).slice(0, 16) + '…');
  check('link: minted offer carries the amount', minted.sats === offer.sats, String(minted.sats));
  check('link: minted offer is a QR-sized BOLT12 offer', minted.form === 'offer' && minted.len <= 340, minted.form + ' ' + minted.len);
  check('link: the simulated HTLC arrives', (await taker.textContent('#chipBtcTxt')) === 'HTLC held');
  /* the offer is a long payload: the QR has to pick a level that fits and
     still produce a scannable symbol */
  const invQr = await taker.evaluate(() => {
    const q = window.QR.encode('lightning:' + window.CLEANSWAP.state.inv, { level: 'M' });
    const l = window.QR.encode('lightning:' + window.CLEANSWAP.state.inv, { level: 'L' });
    return { m: q.version, l: l.version };
  });
  check('link: the minted offer fits a QR symbol', invQr.l <= 13, 'v' + invQr.l + ' at level L');

  await taker.click('#primary');
  await taker.waitForTimeout(300);
  check('link: empty escrow proof does not advance', (await taker.evaluate(() => document.body.dataset.phase)) === 'btc');
  await taker.click('[data-act="fillProof"]');
  await taker.waitForTimeout(300);
  const takerGate = await taker.evaluate(() => document.getElementById('gateTxt').textContent);
  check('link: generated escrow proof verifies on the USDT side', /decoded/.test(takerGate), takerGate);
  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  check('link: both legs locked from the USDT side',
    (await taker.textContent('#chipUsdtTxt')) === 'Locked' && (await taker.textContent('#railState')) === 'Both sides locked · settle before T2');

  await taker.click('#primary');
  await taker.waitForTimeout(300);
  check('link: the USDT side cannot settle without the revealed R', (await taker.evaluate(() => document.body.dataset.phase)) === 'both');
  await taker.fill('#preIn', maker.R);
  await taker.waitForTimeout(400);
  const takerClaimGate = await taker.evaluate(() => document.getElementById('gateTxt').textContent);
  check('link: the revealed R passes the hash check', /SHA256\(R\) matches H/.test(takerClaimGate), takerClaimGate);
  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  check('link: the Lightning leg settles with the revealed R', (await taker.textContent('#statusTxt')) === 'Swap settled');
  await taker.waitForTimeout(2700);
  await taker.evaluate(() => window.scrollTo(0, 0));
  await taker.screenshot({ path: path.join(SHOTS, 'v2-taker.png') });
  await taker.close();

  check('run: still no page or console errors', errors.length === 0, errors.join(' | '));

  /* -------------------------------------------------------- 13. layout --- */
  async function layout(w, h, label) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
    await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const vw = window.innerWidth;
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && (r.right > vw + 1 || r.left < -1)) {
          bad.push((el.id || el.tagName) + '[' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
        }
      });
      return {
        vw,
        scrollW: document.documentElement.scrollWidth,
        bodyScrollW: document.body.scrollWidth,
        overflow: bad.slice(0, 6)
      };
    });
    check('layout ' + label + ': no horizontal overflow',
      m.scrollW <= m.vw && m.bodyScrollW <= m.vw && m.overflow.length === 0,
      'vw=' + m.vw + ' scrollW=' + m.scrollW + ' ' + m.overflow.join(','));
    await c.close();
    return m;
  }
  await layout(390, 844, '390x844');
  await layout(360, 780, '360x780');
  await layout(1280, 800, '1280x800');

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const dp = await desktop.newPage();
  await dp.goto(URL, { waitUntil: 'load' });
  await dp.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  const columns = await dp.evaluate(() => {
    const a = document.getElementById('cardBtc').getBoundingClientRect();
    const b = document.getElementById('cardUsdt').getBoundingClientRect();
    return { sameRow: Math.abs(a.top - b.top) < 2 && b.left > a.right };
  });
  check('layout desktop: the two escrow cards sit side by side', columns.sameRow);
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: path.join(SHOTS, 'v2-desktop.png') });
  await desktop.close();

  await browser.close();

  console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
