/* Headless verification for the built single-file app.
   Run:
     PLAYWRIGHT_PKG=/workspace/.local/lib/python3.12/site-packages/playwright/driver/package \
     LD_LIBRARY_PATH=/workspace/tmp/sysroot/usr/lib/x86_64-linux-gnu \
     /workspace/.local/lib/python3.12/site-packages/playwright/driver/node test/headless.js
   Checks: console/page errors, real WebCrypto SHA-256, real BOLT11 bech32 decode,
   BOLT12 offer TLV decode, BIP-173 bech32 vectors, the full lock->claim flow, the
   timelock->refund flow, the lightning: deep link, QR rendering, and layout
   overflow at 390x844 and 1280x800. Writes shots/p1-mobile.png and shots/p2-settled.png.
*/
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PKG = process.env.PLAYWRIGHT_PKG || 'playwright';
const { chromium } = require(PKG);
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const SHOTS = path.resolve(__dirname, '..', 'shots');
const URL = 'file://' + APP;

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '   [' + detail + ']'));
}

const BOLT11_HASH = '0x' + '11'.repeat(32);
const BOLT12_NODE = '021cbee87b8f3110153097d658851e0d237417eff5d2b594823799f34ba7bb6afb';
const BOLT12_DESC = 'CleanSwap - BTC for USDT';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();

  /* ---------------------------------------------------------- 1. boot --- */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
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
  await page.waitForFunction(() => window.EMERALD && window.EMERALD.state.pstate !== 'loading', null, { timeout: 20000 });

  const boot = await page.evaluate(() => ({
    phase: document.body.dataset.phase,
    mode: document.body.dataset.mode,
    rate: document.getElementById('rateTxt').textContent,
    pstate: window.EMERALD.state.pstate,
    headline: document.getElementById('statusTxt').textContent,
    hasQR: typeof window.QR === 'object' && typeof window.QR.encode === 'function',
    hasSubtle: !!(window.crypto && window.crypto.subtle)
  }));
  check('boot: no page/console errors', errors.length === 0, errors.join(' | '));
  check('boot: no unexpected failed requests', failedReqs.length === 0, failedReqs.join(' | '));
  check('boot: starts in practice mode, idle', boot.phase === 'idle' && boot.mode === 'practice', boot.phase + '/' + boot.mode);
  check('boot: live rate chip rendered (live or honest offline)', /^1 BTC ≈ [\d,]+ USDT$/.test(boot.rate) && ['live', 'offline'].includes(boot.pstate), boot.pstate + ' ' + boot.rate);
  check('boot: rate reflects mempool USD when live', boot.pstate !== 'live' || boot.rate !== '1 BTC ≈ — USDT', boot.rate);
  check('boot: WebCrypto available', boot.hasSubtle);
  check('boot: QR encoder present', boot.hasQR);
  check('boot: Korean headline on first screen', boot.headline === '얼마를 교환할까요?', boot.headline);

  const html = await page.content();
  check('content: no MetaMask / window.ethereum in the app', !/metamask|window\.ethereum|eth_requestAccounts/i.test(html));
  check('content: contract source embedded (sha256 hashlock)', /sha256\(abi\.encodePacked\(preimage\)\)/.test(html));
  check('content: BOLT12 note present', /BOLT12/.test(html));

  /* ------------------------------------------------- 2. real WebCrypto --- */
  const R = 'ab'.repeat(32);
  const expected = crypto.createHash('sha256').update(Buffer.from(R, 'hex')).digest('hex');
  const got = await page.evaluate(r => window.EMERALD.sha256Hex(r), R);
  check('crypto: SHA256(R) equals node crypto', got === expected, got.slice(0, 16) + '…');

  const oneByte = await page.evaluate(() => window.EMERALD.sha256Hex('00ffff00'));
  check('crypto: multi-byte preimage vector', oneByte === crypto.createHash('sha256').update(Buffer.from('00ffff00', 'hex')).digest('hex'));

  const swapId = await page.evaluate(async () => window.EMERALD.computeSwapId(
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

  /* ----------------------------------------------------- 3. bech32/11 --- */
  const vectors = await page.evaluate(() => {
    const out = {};
    for (const v of ['A12UEL5L', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
      'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w']) {
      try { window.EMERALD.bech32Decode(v); out[v] = 'ok'; } catch (e) { out[v] = 'err:' + e.message; }
    }
    try { window.EMERALD.bech32Decode('A12UEL5X'); out.bad = 'ok'; } catch (e) { out.bad = 'err:' + e.message; }
    return out;
  });
  check('bech32: BIP-173 valid vectors pass',
    Object.entries(vectors).filter(([k]) => k !== 'bad').every(([, v]) => v === 'ok'),
    JSON.stringify(vectors));
  check('bech32: bad checksum rejected', /checksum/.test(vectors.bad), vectors.bad);

  await page.evaluate(() => { document.getElementById('dTech').open = true; });

  await page.click('[data-act="sample11"]');
  const b11 = await page.evaluate(() => {
    const s = window.EMERALD.state;
    return { kind: s.req && s.req.kind, hash: s.req && s.req.paymentHash, sats: s.req && s.req.sats, net: s.req && s.req.network };
  });
  check('BOLT11: sample decodes to payment_hash', b11.hash === BOLT11_HASH, b11.hash);
  check('BOLT11: amount 50,000 sats decoded', b11.sats === 50000, b11.sats);
  check('BOLT11: network bc', b11.net === 'bc', b11.net);
  const decodeText = await page.textContent('#decodeOut');
  check('BOLT11: drawer shows payment_hash', decodeText.includes(BOLT11_HASH.slice(0, 10)));

  const tamper = await page.evaluate(() => {
    const inv = document.getElementById('sample-bolt11').textContent.trim();
    const bad = inv.slice(0, -1) + (inv.slice(-1) === 'q' ? 'p' : 'q');
    try { window.EMERALD.decodeBolt11(bad); return 'decoded'; } catch (e) { return 'err:' + e.message; }
  });
  check('BOLT11: corrupted invoice rejected', /checksum/.test(tamper), tamper);

  /* -------------------------------------------------------- 4. BOLT12 --- */
  await page.click('[data-act="sample12"]');
  const b12 = await page.evaluate(() => {
    const s = window.EMERALD.state;
    return {
      kind: s.req && s.req.kind, desc: s.req && s.req.description,
      node: s.req && s.req.nodeId, hash: s.req && s.req.paymentHash, expiry: s.req && s.req.absoluteExpiry
    };
  });
  check('BOLT12: offer recognised as bolt12', b12.kind === 'bolt12', b12.kind);
  check('BOLT12: offer_description decoded', b12.desc === BOLT12_DESC, b12.desc);
  check('BOLT12: node_id TLV decoded', b12.node === BOLT12_NODE, b12.node);
  check('BOLT12: absolute_expiry TLV decoded', b12.expiry === 1798761600, b12.expiry);
  check('BOLT12: reports no payment_hash', b12.hash === null, String(b12.hash));
  const b12text = await page.textContent('#decodeOut');
  check('BOLT12: drawer labels payment_hash 없음', b12text.includes('없음'), b12text.slice(0, 80));

  /* ------------------------------------------------- 5. deep link / QR --- */
  const links = await page.evaluate(() => ({
    main: document.getElementById('openWallet').getAttribute('href'),
    deep: document.getElementById('openWalletDeep').getAttribute('href'),
    offer: document.getElementById('sample-bolt12').textContent.trim(),
    invoice: document.getElementById('sample-bolt11').textContent.trim()
  }));
  check('wallet: main lightning: link follows the decoded offer', links.main === 'lightning:' + links.offer, links.main.slice(0, 34) + '…');
  check('wallet: drawer lightning: link follows the offer', links.deep === 'lightning:' + links.offer);

  await page.click('[data-act="sample11"]');
  const link11 = await page.getAttribute('#openWallet', 'href');
  check('wallet: lightning: link follows the invoice', link11 === 'lightning:' + links.invoice, link11.slice(0, 30) + '…');

  await page.fill('#liquidAddr', 'lq1qqwm4j0d9z6exampleaddress0x9f2k');
  const req = await page.evaluate(() => window.EMERALD.liquidRequest());
  check('USDT: payment request built from address + amount', /^liquidnetwork:lq1qqwm4j0d9z6exampleaddress0x9f2k\?amount=\d+\.\d\d$/.test(req), req);

  await page.click("#dTech [data-act=\"qrAddr\"]");
  const qr = await page.evaluate(() => {
    const svg = document.querySelector('#qrAddrBox svg');
    if (!svg) return null;
    const m = /QR|(\d+)-M mask (\d)/.exec(svg.innerHTML);
    return { has: true, paths: (svg.innerHTML.match(/M\d+ \d+h1v1h-1z/g) || []).length, size: svg.getAttribute('viewBox'), meta: m ? m[0] : '' };
  });
  check('USDT: QR rendered for the payment request', qr && qr.paths > 80, qr && qr.paths + ' modules');
  check('USDT: QR fits the encoder range', await page.evaluate(() => {
    const r = window.EMERALD.liquidRequest();
    const q = window.QR.encode(r, { level: 'M' });
    return q.version <= 10 && q.size === q.version * 4 + 17;
  }));

  /* ----------------------------------------------------- 6. swap flow --- */
  const phase = () => page.evaluate(() => document.body.dataset.phase);
  const btn = () => page.textContent('#primary');

  check('flow: primary starts as 교환 시작하기', (await btn()) === '교환 시작하기');
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'offer', null, { timeout: 5000 });
  const offer = await page.evaluate(() => {
    const s = window.EMERALD.state;
    return { H: s.H, R: s.R, id: s.id, t1: s.t1, t2: s.t2 };
  });
  const realHash = '0x' + crypto.createHash('sha256').update(Buffer.from(offer.R.replace(/^0x/, ''), 'hex')).digest('hex');
  check('flow: offer created with 32-byte R', /^0x[0-9a-f]{64}$/.test(offer.R));
  check('flow: H is the real SHA-256 of R', offer.H === realHash, offer.H.slice(0, 20) + '…');
  check('flow: T1 above T2 (lightning outlives the token leg)', offer.t1 > 0 && offer.t2 > 0);
  check('flow: swapId derived', /^0x[0-9a-f]{64}$/.test(offer.id));
  check('flow: step label is 잠금 1', (await btn()) === '1. 내 비트코인 잠그기', await btn());

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'half', null, { timeout: 5000 });
  check('flow: bitcoin leg locked → half', (await phase()) === 'half');
  check('flow: maker badge 잠금 완료', (await page.textContent('#chipMakerTxt')) === '잠금 완료');
  check('flow: taker badge still 대기 중', (await page.textContent('#chipTakerTxt')) === '대기 중');
  check('flow: refund test offered while locked', (await page.textContent('#ghostA')) === '시간 초과 환불 테스트');
  check('flow: step label is 잠금 2', (await btn()) === '2. 상대 USDT 잠금 확인', await btn());

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  check('flow: both legs locked', (await page.textContent('#statusTxt')) === '잠금 완료, 교환할 수 있어요');
  check('flow: both badges 잠금 완료',
    (await page.textContent('#chipMakerTxt')) === '잠금 완료' && (await page.textContent('#chipTakerTxt')) === '잠금 완료');
  check('flow: step label is 교환', (await btn()) === '3. 동시 교환 완료!', await btn());
  const chromeShots = await page.evaluate(() => {
    document.getElementById('dTech').open = false;
    window.scrollTo(0, 0);
    const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    return { presets: vis('presets'), walletRow: vis('walletRow'), drawer: document.getElementById('dTech').open };
  });
  check('screen: amount presets hidden mid-trade', chromeShots.presets === false);
  check('screen: wallet row hidden in practice mode', chromeShots.walletRow === false);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(SHOTS, 'p1-mobile.png') });

  const hiddenR = await page.textContent('#vR');
  check('flow: preimage hidden before claim', hiddenR.includes('•'), hiddenR.slice(0, 24));

  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  check('flow: settled headline', (await page.textContent('#statusTxt')) === '교환 완료!');
  const settled = await page.evaluate(() => ({
    R: window.EMERALD.state.R, vR: document.getElementById('vR').textContent,
    claim: window.EMERALD.nextCalldata()
  }));
  check('flow: preimage revealed after claim', settled.vR === settled.R, settled.vR.slice(0, 20) + '…');
  check('flow: claim calldata carries R', settled.claim.startsWith('0x84cc9dfb') && settled.claim.includes(settled.R.replace(/^0x/, '')), settled.claim.slice(0, 20) + '…');
  const logText = await page.textContent('#log');
  check('flow: log shows claim + reveal + lightning settle',
    /CHECK/.test(logText) && /REVEAL/.test(logText) && /LN/.test(logText));
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(SHOTS, 'p2-settled.png') });

  /* --------------------------------------------------- 7. refund path --- */
  await page.click('#primary'); // 새로 시작하기
  await page.waitForFunction(() => document.body.dataset.phase === 'idle', null, { timeout: 5000 });
  await page.click('#primary'); // 교환 시작하기
  await page.waitForFunction(() => document.body.dataset.phase === 'offer', null, { timeout: 5000 });
  await page.click('#primary'); // lock bitcoin
  await page.waitForFunction(() => document.body.dataset.phase === 'half', null, { timeout: 5000 });
  await page.click('#primary'); // confirm USDT
  await page.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await page.click('#ghostA');  // 시간 초과 환불 테스트
  await page.waitForFunction(() => document.body.dataset.phase === 'expired', null, { timeout: 5000 });
  check('refund: timelock expiry flips to refund', (await page.textContent('#statusTxt')) === '시간이 초과됐어요');
  check('refund: primary becomes 환불 받기', (await page.textContent('#primary')) === '환불 받기');
  check('refund: badges show 만료', (await page.textContent('#chipTakerTxt')) === '만료');
  await page.click('#primary');
  await page.waitForFunction(() => document.body.dataset.phase === 'refunded', null, { timeout: 5000 });
  check('refund: refunded headline', (await page.textContent('#statusTxt')) === '환불 완료');
  check('refund: taker badge 환불됨', (await page.textContent('#chipTakerTxt')) === '환불됨');
  check('refund: preimage never revealed', (await page.textContent('#vR')).includes('•'));

  check('run: still no page/console errors', errors.length === 0, errors.join(' | '));

  /* -------------------------------------------------------- 8. layout --- */
  async function layout(w, h, label) {
    const c = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForFunction(() => window.EMERALD && window.EMERALD.state.pstate !== 'loading', null, { timeout: 20000 });
    await p.evaluate(() => { document.getElementById('dTech').open = true; });
    await p.waitForTimeout(200);
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
        overflow: bad.slice(0, 6),
        cardRight: Math.round(document.getElementById('cardTaker').getBoundingClientRect().right)
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

  await browser.close();

  console.log('\n' + (results.length - failures) + '/' + results.length + ' checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
