/* Extra inspection screenshots (not part of the pass/fail suite):
   the desktop view, a swap with both sides locked, and the wallet hand-off
   with its QR. Run with the same env as test/headless.js. */
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const OUT = path.resolve(__dirname, '..', 'shots');
const URL = 'file://' + APP;

(async () => {
  const browser = await chromium.launch();

  // desktop: the idle screen
  const d = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const p = await d.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'extra-desktop.png') });

  // desktop: both sides locked, through the gates
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'btc', null, { timeout: 5000 });
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'extra-desktop-locked.png') });
  await d.close();

  // mobile: wallet hand-off, invoice pasted, QR open
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const q = await m.newPage();
  await q.goto(URL, { waitUntil: 'load' });
  await q.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
  await q.click('#modeWallet');
  await q.click('#primary');
  await q.waitForFunction(() => document.body.dataset.phase === 'open', null, { timeout: 5000 });
  const offer = await q.evaluate(() => window.CLEANSWAP.mintOffer({
    paymentHash: window.CLEANSWAP.state.H, sats: window.CLEANSWAP.state.sats, expiry: 3600
  }));
  await q.fill('#pasteIn', offer);
  await q.waitForTimeout(250);
  await q.click('[data-act="qrPay"]');
  await q.waitForTimeout(300);
  await q.evaluate(() => document.getElementById('qrBox').scrollIntoView({ block: 'center' }));
  await q.waitForTimeout(300);
  await q.screenshot({ path: path.join(OUT, 'extra-wallet-qr.png') });
  await m.close();

  await browser.close();
  console.log('wrote extra-desktop.png, extra-desktop-locked.png, extra-wallet-qr.png');
})().catch(e => { console.error(e); process.exit(1); });
