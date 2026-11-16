/* Extra inspection screenshots (not part of the pass/fail suite):
   desktop idle + locked, and the technical drawer with a QR on mobile.
   Run with the same env as test/headless.js. */
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const OUT = path.resolve(__dirname, '..', 'shots');
const URL = 'file://' + APP;

(async () => {
  const browser = await chromium.launch();

  // desktop idle
  const d = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const p = await d.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction(() => window.EMERALD && window.EMERALD.state.pstate !== 'loading', null, { timeout: 20000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'p3-desktop-idle.png') });

  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'offer', null, { timeout: 5000 });
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'half', null, { timeout: 5000 });
  await p.click('#primary');
  await p.waitForFunction(() => document.body.dataset.phase === 'both', null, { timeout: 5000 });
  await p.waitForTimeout(2400);
  await p.screenshot({ path: path.join(OUT, 'p4-desktop-locked.png') });
  await d.close();

  // mobile drawer with QR + decoded offer
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const q = await m.newPage();
  await q.goto(URL, { waitUntil: 'load' });
  await q.waitForFunction(() => window.EMERALD && window.EMERALD.state.pstate !== 'loading', null, { timeout: 20000 });
  await q.evaluate(() => { document.getElementById('dTech').open = true; });
  await q.click('[data-act="sample12"]');
  await q.fill('#liquidAddr', 'lq1qqwm4j0d9z6exampleaddress0x9f2k');
  await q.click('#dTech [data-act="qrAddr"]');
  await q.waitForTimeout(2300);
  await q.evaluate(() => {
    const el = document.getElementById('qrAddrBox');
    el.scrollIntoView({ block: 'center' });
  });
  await q.waitForTimeout(300);
  await q.screenshot({ path: path.join(OUT, 'p5-drawer-qr.png') });
  await m.close();

  await browser.close();
  console.log('wrote p3/p4/p5');
})().catch(e => { console.error(e); process.exit(1); });
