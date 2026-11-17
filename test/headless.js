/* Headless verification for the built single-file app.

   Run:
     PLAYWRIGHT_PKG=/workspace/.local/lib/python3.12/site-packages/playwright/driver/package \
     LD_LIBRARY_PATH=/workspace/tmp/sysroot/usr/lib/x86_64-linux-gnu \
     /workspace/.local/lib/python3.12/site-packages/playwright/driver/node test/headless.js

   The suite drives the real DOM only: every state change goes through a click on
   the button a person would press. The point of the gates is that a click alone
   is not enough, so part of these checks assert that a click does NOT advance
   while the check fails - the app is made to fail by corrupting the data it is
   about to verify, then repaired and clicked again.

   Covers: the simple screen (one sentence, one big button, no technical text),
   the amount preset highlight, the practice flow with zero pasting, the wallet
   flow with one paste per step, both directions, the USDT side reached through
   a share link, the refund path, "practice leaves no history, real swaps do",
   layout at 360x780 / 390x844 / 1280x800, the fixed action bar never covering
   content, the protocol vectors (SHA-256, abi.encodePacked swap id, bech32,
   BOLT11, BOLT12), and a Hangul-free, jargon-free screen. Writes shots/v4-*.
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
/* words that must never reach the screen: symbol names, hashes, raw payloads */
const JARGON = /preimage|hashlock|bolt1[12]|calldata|escrow proof|lno1|lni1|lnbc|htlc|abi\.|bech32|sha-?256|unix|timelock|\[\s*0x/i;
/* buttons from the old practice/test toolbox: none of them may exist any more */
const OLD_ACTS = ['fillOffer', 'wrongOffer', 'fillProof', 'wrongProof', 'reveal', 'fillPre',
  'wrongPre', 'advance', 'copyIssue', 'qrOut', 'fillPreimage', 'clock'];

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

  const view = () => page.evaluate(() => ({
    phase: document.body.dataset.phase,
    mode: document.body.dataset.mode,
    role: document.body.dataset.role,
    state: document.getElementById('stateTxt').textContent,
    title: document.getElementById('stepTitle').textContent,
    say: document.getElementById('stepSay').textContent,
    cta: document.getElementById('primary').textContent,
    ready: document.getElementById('primary').dataset.ready,
    send: document.getElementById('sendAmt').textContent + ' ' + document.getElementById('sendUnit').textContent,
    get: document.getElementById('getAmt').textContent + ' ' + document.getElementById('getUnit').textContent,
    presets: !document.getElementById('presets').hidden,
    paste: !document.getElementById('pasteRow').hidden,
    invite: !document.getElementById('inviteRow').hidden,
    pay: !document.getElementById('walletRow').hidden,
    ghost: !document.getElementById('ghost').hidden,
    history: !document.getElementById('history').hidden,
    rows: document.querySelectorAll('#histList .hist-item').length,
    on: Array.from(document.querySelectorAll('#presets button.on')).map(b => b.textContent.trim()),
    rate: document.getElementById('rateTxt').textContent,
    gate: window.CLEANSWAP.state.gate && window.CLEANSWAP.state.gate.code
  }));

  const boot = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    mode: document.body.dataset.mode,
    role: document.body.dataset.role,
    rate: document.getElementById('rateTxt').textContent,
    pstate: window.CLEANSWAP.state.pstate,
    hasQR: typeof window.QR === 'object' && typeof window.QR.encode === 'function',
    hasSubtle: !!(window.crypto && window.crypto.subtle),
    acts: Array.from(document.querySelectorAll('[data-act]')).map(b => b.dataset.act),
    buttons: document.querySelectorAll('button, a[href]').length
  }));
  check('boot: no page or console errors', errors.length === 0, errors.join(' | '));
  check('boot: no unexpected failed requests', failedReqs.length === 0, failedReqs.join(' | '));
  check('boot: starts idle, practice, sending bitcoin',
    boot.phase === 'idle' && boot.mode === 'practice' && boot.role === 'maker',
    boot.phase + '/' + boot.mode + '/' + boot.role);
  check('boot: one clean rate line', /^1 BTC ≈ [\d,]+ USDT$/.test(boot.rate) && ['live', 'offline'].includes(boot.pstate),
    boot.pstate + ' ' + boot.rate);
  check('boot: WebCrypto and the QR encoder are present', boot.hasSubtle && boot.hasQR);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('#inviteRow, #walletRow, #ghost, #pasteRow'))
    .filter(el => !el.hidden).map(el => el.id));
  check('boot: only the swap cards, the amount and one button are on the idle screen',
    shown.length === 0 && boot.acts.includes('primary'), shown.join(',') || 'no extra rows');

  const b0 = await view();
  check('boot: state line reads Ready', b0.state === 'Ready', b0.state);
  check('boot: one headline sentence', b0.title === 'Swap bitcoin for USDT', b0.title);
  check('boot: one instruction sentence', b0.say === 'Pick an amount, then tap Start swap.', b0.say);
  check('boot: 50,000 sats on both cards', b0.send === '50,000 sats' && /^[\d,.]+ USDT$/.test(b0.get), b0.send + ' / ' + b0.get);
  check('boot: the amount presets are shown, 50,000 selected', b0.presets && b0.on.length === 1 && b0.on[0] === '50,000', b0.on.join(','));

  const html = await page.content();
  check('content: no test toolbox left in the page', !OLD_ACTS.some(a => new RegExp('data-act="' + a + '"').test(html)),
    OLD_ACTS.filter(a => new RegExp('data-act="' + a + '"').test(html)).join(','));
  check('content: no sample or mismatch helpers anywhere', !/use sample|mismatched|wrong r|advance clock/i.test(html));
  check('content: no browser-extension wallet (window.ethereum)', !/window\.ethereum|eth_requestAccounts|ethereum\.request/i.test(html));
  check('content: no WebLN hand-off', !/webln/i.test(html));
  check('content: contract source embedded (sha256 hashlock)', /sha256\(abi\.encodePacked\(preimage\)\)/.test(html));
  check('content: no remote scripts or styles', !/<script[^>]+src=/i.test(html) && !/<link[^>]+rel="stylesheet"/i.test(html));
  check('content: no Hangul in the built page', !HANGUL.test(html), (html.match(HANGUL) || []).length + ' chars');
  const uiText = await page.evaluate(() => document.body.innerText);
  check('content: no Hangul in rendered text', !HANGUL.test(uiText), (uiText.match(HANGUL) || []).length + ' chars');
  check('content: no technical words on the screen', !JARGON.test(uiText), (uiText.match(JARGON) || [''])[0]);

  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, 'v4-idle.png') });

  /* ------------------------------------------- 2. preset highlight bug --- */
  await page.click('[data-act="sats"][data-v="10000"]');
  await page.waitForTimeout(220);
  let v = await view();
  check('presets: 10,000 moves the amount', v.send === '10,000 sats', v.send);
  check('presets: the highlight moves with it (one button, 10,000)',
    v.on.length === 1 && v.on[0] === '10,000', v.on.join(','));
  const pressed = await page.evaluate(() => Array.from(document.querySelectorAll('#presets button'))
    .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent.trim()));
  check('presets: aria-pressed follows the selection', pressed.length === 1 && pressed[0] === '10,000', pressed.join(','));

  await page.click('[data-act="sats"][data-v="250000"]');
  await page.waitForTimeout(220);
  v = await view();
  check('presets: 250,000 moves amount and highlight again',
    v.send === '250,000 sats' && v.on.length === 1 && v.on[0] === '250,000', v.send + ' · ' + v.on.join(','));

  await page.click('[data-act="sats"][data-v="50000"]');
  await page.waitForTimeout(220);
  check('presets: back to 50,000 with the highlight back on it',
    (await view()).on.join(',') === '50,000');

  /* ------------------------------------------------- 3. real WebCrypto --- */
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

  /* ---------------------------------------------------- 4. bech32 / 12 --- */
  const vectors = await page.evaluate(() => {
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
  check('parse: one reader reads BOLT12 and BOLT11 alike',
    oneReader.a === 'bolt12:offer' && oneReader.b === 'bolt11', JSON.stringify(oneReader));

  /* ------------------------------------------- 5. practice flow, no taps --- */
  const phase = () => page.evaluate(() => document.body.dataset.phase);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    return { R: s.R, H: s.H, t2: s.t2, id: s.id, counter: s.counterInv, sats: s.sats, units: s.units };
  });
  const realHash = '0x' + crypto.createHash('sha256').update(Buffer.from(opened.R.replace(/^0x/, ''), 'hex')).digest('hex');
  check('create: 32-byte preimage R', /^0x[0-9a-f]{64}$/.test(opened.R));
  check('create: H is the real SHA-256 of R', opened.H === realHash, opened.H.slice(0, 20) + '…');
  check('create: swapId derived', /^0x[0-9a-f]{64}$/.test(opened.id));
  check('create: the partner invoice is minted locally', /^lno1\w+/.test(opened.counter), opened.counter.slice(0, 20) + '…');
  check('create: the invoice still decodes to H and the amount', await page.evaluate(() => {
    const d = window.CLEANSWAP.decodeSwapOffer(window.CLEANSWAP.state.counterInv);
    return d.paymentHash === window.CLEANSWAP.state.H && d.sats === window.CLEANSWAP.state.sats;
  }));

  let w = await view();
  check('practice: no field to paste into', !w.paste);
  check('practice: no invite or wallet row on the first step', !w.invite && !w.pay);
  check('practice: the title is the next action', w.title === 'Lock your bitcoin', w.title);
  check('practice: one big button, already ready', w.cta === 'Lock my BTC' && w.ready === '1', w.cta + '/' + w.ready);
  check('practice: presets are gone once the swap is open', !w.presets);
  check('practice: the direction switch is inert once open',
    (await page.getAttribute('#swapDir', 'data-lock')) === '1');
  check('practice: the sentence says what the tap does', /Tap to lock your bitcoin/.test(w.say), w.say);
  await page.screenshot({ path: path.join(SHOTS, 'v4-open.png') });

  /* gate 1 really checks the invoice: break it, the tap must not move */
  await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    window.__goodCounter = s.counterInv;
    s.counterInv = window.CLEANSWAP.mintOffer({ paymentHash: '0x' + '33'.repeat(32), sats: s.sats, expiry: 3600 });
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(200);
  w = await view();
  check('gate 1: an invoice for another swap is refused', w.gate === 'mismatch' && w.ready === '0', w.gate + '/' + w.ready);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 1: the tap does not lock with a wrong invoice', (await phase()) === 'open', await phase());
  check('gate 1: the refusal is plain English', /different swap/.test((await view()).say), (await view()).say);
  check('gate 1: no technical words in the refusal', !JARGON.test((await view()).say), (await view()).say);
  await page.screenshot({ path: path.join(SHOTS, 'v4-blocked.png') });

  await page.evaluate(() => {
    window.CLEANSWAP.state.counterInv = window.__goodCounter;
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(200);
  check('gate 1: the right invoice passes again', (await view()).gate === 'ok');

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('lock: one side in, state line says Bitcoin locked', w.state === 'Bitcoin locked', w.state);
  check('lock: the send card is tagged Locked', await page.evaluate(() => {
    const t = document.getElementById('sendTag');
    return !t.hidden && document.getElementById('sendTagTxt').textContent === 'Locked';
  }));
  check('lock: the next sentence names the partner step', w.cta === 'Partner locks' && /USDT side locks/.test(w.say), w.cta + ' · ' + w.say);
  await page.screenshot({ path: path.join(SHOTS, 'v4-half.png') });

  /* gate 2 really checks the USDT lock amount */
  await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    window.__goodUnits = s.units;
    s.units = s.units + 1000000;
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(200);
  w = await view();
  check('gate 2: a lock for another amount is refused', w.gate === 'amount' && w.ready === '0', w.gate + '/' + w.ready);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 2: the tap does not advance on a wrong amount', (await phase()) === 'btc', await phase());
  await page.evaluate(() => {
    window.CLEANSWAP.state.units = window.__goodUnits;
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(200);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('lock: both sides in', w.state === 'Both locked', w.state);
  check('lock: both cards tagged', await page.evaluate(() =>
    !document.getElementById('sendTag').hidden && !document.getElementById('getTag').hidden));
  check('lock: the sentence asks for the last tap', /Tap to complete the swap/.test(w.say), w.say);
  await page.screenshot({ path: path.join(SHOTS, 'v4-both.png') });

  /* gate 3 really checks SHA256(R) === H */
  await page.evaluate(() => {
    const s = window.CLEANSWAP.state;
    window.__goodR = s.R;
    s.R = '0x' + '44'.repeat(32);
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(300);
  w = await view();
  check('gate 3: a wrong secret is refused', w.gate === 'mismatch' && w.ready === '0', w.gate + '/' + w.ready);
  await page.click('#primary');
  await page.waitForTimeout(300);
  check('gate 3: the tap does not settle without the secret', (await phase()) === 'both', await phase());
  await page.evaluate(() => {
    window.CLEANSWAP.state.R = window.__goodR;
    window.CLEANSWAP.render(); window.CLEANSWAP.refreshGate();
  });
  await page.waitForTimeout(200);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('settle: state line says Completed', w.state === 'Completed', w.state);
  check('settle: the closing sentence says what arrived', /You received [\d,.]+ USDT\./.test(w.say), w.say);
  check('settle: Done plus New swap', w.cta === 'Done' && w.ghost, w.cta + '/' + w.ghost);
  check('settle: a practice swap leaves no history', !w.history && w.rows === 0, w.rows + ' rows');
  const claim = await page.evaluate(() => window.CLEANSWAP.nextCalldata());
  check('settle: claim calldata carries swapId and R',
    claim.startsWith('0x84cc9dfb') && claim.includes(opened.R.replace(/^0x/, '')), claim.slice(0, 20) + '…');
  const logText = await page.evaluate(() => document.getElementById('log').textContent);
  check('settle: the hidden log records REVEAL and SETTLE', /REVEAL/.test(logText) && /SETTLE/.test(logText));
  await page.screenshot({ path: path.join(SHOTS, 'v4-done.png') });

  /* ------------------------------------------------ 6. refund path --- */
  await page.click('#primary'); /* Done -> idle */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  check('reset: preimage and hashlock cleared',
    await page.evaluate(() => !window.CLEANSWAP.state.H && !window.CLEANSWAP.state.R));
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.evaluate(() => window.CLEANSWAP.advanceClock());
  await page.waitForFunction(() => document.body.dataset.phase === 'expired', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('refund: the clock ends the claim window', w.state === 'Expired', w.state);
  check('refund: the button offers the money back', w.cta === 'Refund', w.cta);
  await page.screenshot({ path: path.join(SHOTS, 'v4-expired.png') });
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'refunded', null, { timeout: 5000 });
  w = await view();
  check('refund: the swap closes', w.cta === 'Done' && w.state === 'Refunded', w.cta + '/' + w.state);
  check('refund: a practice refund leaves no history', !w.history, String(w.rows));

  /* --------------------------------------------- 7. wallet mode, maker --- */
  await page.click('#primary'); /* Done -> idle */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#modeWallet');
  await page.waitForTimeout(250);
  check('wallet: the mode switch flips', (await page.evaluate(() => document.body.dataset.mode)) === 'wallet');
  const walletActs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-act]')).map(b => b.dataset.act));
  check('wallet: no practice or test buttons on the screen',
    !walletActs.some(a => OLD_ACTS.includes(a)), walletActs.join(','));

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('wallet: one paste field, one wallet row, one big button',
    w.paste && w.pay && !w.invite && w.cta === 'I paid', [w.paste, w.pay, w.invite, w.cta].join('/'));
  check('wallet: the first sentence asks for the invoice', /Paste the invoice/.test(w.say), w.say);
  check('wallet: the button waits for it', w.ready === '0', w.ready);
  await page.screenshot({ path: path.join(SHOTS, 'v4-wallet.png') });

  await page.click('#primary');
  await page.waitForTimeout(250);
  check('wallet: tapping without the invoice does not lock', (await phase()) === 'open', await phase());

  const partnerOffer = await page.evaluate(() => window.CLEANSWAP.mintOffer({
    paymentHash: window.CLEANSWAP.state.H, sats: window.CLEANSWAP.state.sats, expiry: 3600
  }));
  await page.fill('#pasteIn', 'lnbc2500u1notarealinvoice');
  await page.waitForTimeout(250);
  check('wallet: garbage is refused in plain words', /cannot be read/.test((await view()).say), (await view()).say);
  await page.fill('#pasteIn', partnerOffer);
  await page.waitForTimeout(250);
  w = await view();
  check('wallet: the invoice checks out and the button is ready', w.gate === 'ok' && w.ready === '1', w.gate + '/' + w.ready);
  check('wallet: the sentence moves to the wallet hand-off', /Pay this invoice from your wallet/.test(w.say), w.say);
  check('wallet: the deep link carries the invoice',
    (await page.getAttribute('#walletLink', 'href')).startsWith('lightning:lno1'),
    (await page.getAttribute('#walletLink', 'href')).slice(0, 24) + '…');
  await page.click('[data-act="qrPay"]');
  await page.waitForTimeout(250);
  const payQr = await page.evaluate(() => {
    const svg = document.querySelector('#qrBox svg');
    return svg ? (svg.innerHTML.match(/M\d+ \d+h1v1h-1z/g) || []).length : 0;
  });
  check('wallet: the invoice renders as a scannable QR', payQr > 100, payQr + ' modules');

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('wallet: paying locks the bitcoin side', w.state === 'Bitcoin locked', w.state);
  check('wallet: the next step asks for the lock code', w.paste && /Paste the lock code/.test(w.say), w.say);
  const escrow = await page.evaluate(() => window.CLEANSWAP.escrowProof());
  await page.fill('#pasteIn', escrow);
  await page.waitForTimeout(250);
  check('wallet: the lock code is checked against the swap', (await view()).gate === 'ok', (await view()).gate);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  w = await view();
  check('wallet: the real swap completes with its own secret', w.state === 'Completed' && w.cta === 'Done', w.state + '/' + w.cta);
  check('wallet: a completed real swap is kept in Recent', w.history && w.rows === 1, w.rows + ' rows');
  const walletRows = w.rows;
  check('wallet: the history row shows what arrived', await page.evaluate(() =>
    /^\+\s?[\d,.]+ USDT$/.test(document.querySelector('#histList .hist-item b').textContent)),
    await page.evaluate(() => document.querySelector('#histList .hist-item b').textContent));
  await page.screenshot({ path: path.join(SHOTS, 'v4-wallet-done.png') });

  /* ------------------------------------------- 8. send USDT direction --- */
  await page.click('#primary'); /* Done -> idle */
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#modePractice');
  await page.waitForTimeout(200);
  await page.click('#swapDir');
  await page.waitForTimeout(250);
  w = await view();
  check('direction: one tap flips to sending USDT',
    (await page.evaluate(() => document.body.dataset.role)) === 'taker' && w.title === 'Swap USDT for bitcoin',
    w.title);
  check('direction: the cards swap around', /^[\d,.]+ USDT$/.test(w.send) && /sats$/.test(w.get), w.send + ' / ' + w.get);

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('usdt start: the first tap locks the USDT side', w.cta === 'Lock my USDT' && !w.paste, w.cta + '/' + w.paste);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('usdt start: USDT is in, the bitcoin side is next', w.state === 'USDT locked' && w.cta === 'Partner locks', w.state + '/' + w.cta);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await page.waitForTimeout(250);
  w = await view();
  check('usdt start: the swap completes from the USDT side', w.state === 'Completed', w.state);
  check('usdt start: the closing sentence names the bitcoin received', /You received [\d,]+ sats\./.test(w.say), w.say);
  check('usdt start: a practice swap adds nothing to Recent', w.rows === walletRows, w.rows + ' rows (wallet left ' + walletRows + ')');

  /* --------------------------------------- 9. USDT side through a link --- */
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#swapDir');
  await page.waitForTimeout(200);
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const maker = await page.evaluate(() => ({
    link: window.CLEANSWAP.swapLink(), H: window.CLEANSWAP.state.H, R: window.CLEANSWAP.state.R
  }));
  const taker = await ctx.newPage();
  const takerErrors = [];
  taker.on('pageerror', e => takerErrors.push('pageerror: ' + e.message));
  taker.on('console', m => { if (m.type() === 'error') takerErrors.push('console: ' + m.text()); });
  await taker.goto(maker.link, { waitUntil: 'load' });
  await taker.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await taker.waitForTimeout(250);
  const joined = await taker.evaluate(() => ({
    role: document.body.dataset.role,
    phase: document.body.dataset.phase,
    H: window.CLEANSWAP.state.H,
    R: window.CLEANSWAP.state.R,
    cta: document.getElementById('primary').textContent
  }));
  check('link: opens as the USDT side of the same swap', joined.role === 'taker' && joined.H === maker.H && joined.R === null,
    joined.role + ' ' + String(joined.H).slice(0, 12) + '…');
  check('link: the joined tab starts at the USDT lock', joined.cta === 'Lock my USDT', joined.cta);
  check('link: no page errors on the joined tab', takerErrors.length === 0, takerErrors.join(' | '));

  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await taker.waitForTimeout(250);
  const needSecret = await taker.evaluate(() => ({
    say: document.getElementById('stepSay').textContent,
    paste: !document.getElementById('pasteRow').hidden,
    ready: document.getElementById('primary').dataset.ready
  }));
  check('link: the joined side cannot settle alone', needSecret.ready === '0' && /Paste the code/.test(needSecret.say),
    needSecret.ready + ' · ' + needSecret.say);
  await taker.fill('#pasteIn', maker.R);
  await taker.waitForTimeout(250);
  check('link: the revealed secret opens the swap', (await taker.evaluate(() => document.getElementById('primary').dataset.ready)) === '1');
  await taker.click('#primary');
  await taker.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  check('link: the USDT side completes the swap',
    (await taker.textContent('#stateTxt')) === 'Completed');
  await taker.close();

  check('run: still no page or console errors', errors.length === 0, errors.join(' | '));

  /* --------------------------------------------- 10. layout and the bar --- */
  async function layout(width, height, label) {
    const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
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
      return { vw, scrollW: document.documentElement.scrollWidth, overflow: bad.slice(0, 6) };
    });
    check('layout ' + label + ': no horizontal overflow',
      m.scrollW <= m.vw && m.overflow.length === 0, 'vw=' + m.vw + ' scrollW=' + m.scrollW + ' ' + m.overflow.join(','));
    await c.close();
  }
  await layout(360, 780, '360x780');
  await layout(390, 844, '390x844');
  await layout(1280, 800, '1280x800');

  /* the fixed action bar must never cover the last line of the page, with the
     longest content the app can hold (a few settled swaps on a small phone) */
  const barCtx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 1 });
  const bp = await barCtx.newPage();
  await bp.goto(URL, { waitUntil: 'load' });
  await bp.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await bp.evaluate(() => {
    for (let i = 0; i < 5; i++) window.CLEANSWAP.state.mode = 'wallet';
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
  await bp.screenshot({ path: path.join(SHOTS, 'v4-scroll.png') });
  await barCtx.close();

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const dp = await desktop.newPage();
  await dp.goto(URL, { waitUntil: 'load' });
  await dp.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await dp.waitForTimeout(400);
  await dp.screenshot({ path: path.join(SHOTS, 'v4-desktop.png') });
  await desktop.close();

  await browser.close();

  console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
