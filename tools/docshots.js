/* Regenerate docs/preview.png and docs/wallet.png from the built app. */
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
const APP = path.resolve(__dirname, '..', '..', '..', 'ln-usdt-swap.html');
const DOCS = path.resolve(__dirname, '..', 'docs');
const SHOTS = path.resolve(__dirname, '..', 'shots');

(async () => {
  const b = await chromium.launch();

  async function page(w, h) {
    const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const p = await c.newPage();
    await p.goto('file://' + APP, { waitUntil: 'load' });
    await p.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.state.pstate !== 'loading', null, { timeout: 20000 });
    await p.waitForTimeout(400);
    return { c, p };
  }

  // 1. the form, filled in practice
  const one = await page(390, 844);
  await one.p.click('[data-act="sampleInv"]');
  await one.p.waitForTimeout(300);
  await one.p.click('[data-act="sampleAddr"]');
  await one.p.waitForTimeout(300);
  await one.p.screenshot({ path: path.join(DOCS, 'preview.png'), fullPage: false });

  // 2. the flight through the states, side by side, for the README
  const two = await page(390, 844);
  await two.p.screenshot({ path: path.join(SHOTS, 'v42-readme-empty.png'), fullPage: false });
  await two.p.click('[data-act="sampleInv"]');
  await two.p.waitForTimeout(250);
  await two.p.click('[data-act="sampleAddr"]');
  await two.p.waitForTimeout(250);
  await two.p.click('#primary');
  await two.p.waitForFunction(() => document.body.dataset.phase === 'settled', null, { timeout: 5000 });
  await two.p.waitForTimeout(2800);
  await two.p.screenshot({ path: path.join(SHOTS, 'v42-readme-done.png'), fullPage: false });

  // 3. wallet mode, the three steps with a real invoice
  const three = await page(390, 844);
  await three.p.click('#modeWallet');
  await three.p.waitForTimeout(300);
  const inv = await three.p.evaluate(() => window.CLEANSWAP.mintInvoice({
    paymentHash: '0x' + '5c'.repeat(32), sats: 50000, expiry: 3600
  }));
  await three.p.fill('#invIn', inv);
  await three.p.waitForTimeout(300);
  await three.p.fill('#addrIn', '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  await three.p.waitForTimeout(400);
  await three.p.screenshot({ path: path.join(DOCS, 'wallet.png'), fullPage: false });

  // 3b. the screen Wallet mode parks on after Approve, before I paid
  await three.p.click('#primary');
  await three.p.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 5000 });
  await three.p.waitForTimeout(2800);   // let the toast fade before the shot
  await three.p.screenshot({ path: path.join(DOCS, 'paying.png'), fullPage: false });

  // 4. the code QR, for whoever wants to see it
  const four = await page(390, 844);
  await four.p.click('[data-act="qrCode"]');
  await four.p.waitForTimeout(400);
  await four.p.screenshot({ path: path.join(SHOTS, 'v42-code-qr.png'), fullPage: false });

  await b.close();
  console.log('docs images written');
})().catch(e => { console.error(e); process.exit(2); });
