/* Extra inspection screenshots (not part of the pass/fail suite):
   the desktop escrow board and the wallet hand-off QR.
   Run with the same env as test/headless.js. */
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const OUT = path.resolve(__dirname, '..', 'shots');
const URL = 'file://' + APP;

(async () => {
  const browser = await chromium.launch();

  // desktop: idle board
  const d = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const p = await d.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'extra-desktop.png') });

  // desktop: both legs locked, through the gates
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await p.click('[data-act="fillOffer"]');
  await p.waitForTimeout(250);
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await p.click('[data-act="fillProof"]');
  await p.waitForTimeout(250);
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await p.waitForTimeout(2400);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.screenshot({ path: path.join(OUT, 'extra-desktop-locked.png') });
  await d.close();

  // mobile: the share-link QR on the maker's step 1
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const q = await m.newPage();
  await q.goto(URL, { waitUntil: 'load' });
  await q.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await q.click('#primary');
  await q.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await q.click('[data-act="qrLink"]');
  await q.waitForTimeout(300);
  await q.evaluate(() => {
    const el = document.getElementById('qrLinkBox');
    el.scrollIntoView({ block: 'center' });
  });
  await q.waitForTimeout(300);
  await q.screenshot({ path: path.join(OUT, 'extra-link-qr.png') });
  await m.close();

  await browser.close();
  console.log('wrote extra-desktop.png, extra-desktop-locked.png, extra-link-qr.png');
})().catch(e => { console.error(e); process.exit(1); });
