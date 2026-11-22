/* Mint BOLT11 hold invoices in the real app and dump them for an independent
   decoder (test/invoice-crosscheck.py).

   The fixtures carry a fixed timestamp so the output is reproducible; the app
   signs each one with its practice key by RFC 6979, a nonce derived from the key
   and the message, so the same (hash, amount, expiry) always gives the same
   string - and the signature is checked against the curve in the Python suite. */
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');

const ROOT = path.resolve(__dirname, '..');
/* The test build: the page without the shipped handle, plus the one the suite
   signs its sample invoices with (build.py --test). */
const APP = path.resolve(ROOT, 'build', 'cleanswap.test.html');
const OUT = path.join(ROOT, 'build', 'js-invoices.json');

const CASES = [
  { label: '10k sats', sats: 10000, paymentHash: '0x' + 'a1'.repeat(32), timestamp: 1767225600, expiry: 3600 },
  { label: '50k sats', sats: 50000, paymentHash: '0x' + '5c'.repeat(32), timestamp: 1767225600, expiry: 3600 },
  { label: '250k sats', sats: 250000, paymentHash: '0x' + '0f'.repeat(32), timestamp: 1767225600, expiry: 1800 },
  { label: '1 sat', sats: 1, paymentHash: '0x' + 'ff'.repeat(32), timestamp: 1767225600, expiry: 600 },
  { label: 'described', sats: 50000, paymentHash: '0x' + '3b'.repeat(32), timestamp: 1767225600, expiry: 3600, description: 'CleanSwap' }
];

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto('file://' + APP, { waitUntil: 'load' });
  await page.waitForFunction(() => window.CLEANSWAP && window.CLEANSWAP.mintInvoice, null, { timeout: 20000 });

  const out = [];
  for (const c of CASES) {
    const invoice = await page.evaluate(f => window.CLEANSWAP.mintInvoice(f), c);
    const decoded = await page.evaluate(inv => {
      const d = window.CLEANSWAP.decodeBolt11(inv);
      return { sats: d.sats, paymentHash: d.paymentHash, network: d.network, expiresAt: d.expiresAt, description: d.description, nodeId: d.nodeId };
    }, invoice);
    out.push({ case: c, invoice, length: invoice.length, selfDecoded: decoded });
    console.log(c.label.padEnd(10) + ' ' + invoice.length + ' chars  ' + invoice.slice(0, 28) + '…');
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('wrote ' + OUT);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
