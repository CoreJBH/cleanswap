/* Regenerate docs/preview.png, docs/wallet.png and docs/paying.png from the
   built app.

   The paying screen needs an escrow that answers, so this starts a throwaway
   JSON-RPC endpoint on 127.0.0.1, points Setup at it, writes the lock record
   the swap asks about, and lets the app read it. Nothing here is a real chain:
   the pictures show the real screen with the real gate. */
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PLAYWRIGHT_PKG || 'playwright');
/* The test build: these pictures are made by driving the page's own handle,
   which only the test build carries (build.py --test). */
const APP = path.resolve(__dirname, '..', 'build', 'cleanswap.test.html');
const DOCS = path.resolve(__dirname, '..', 'docs');
const SHOTS = path.resolve(__dirname, '..', 'shots');

const NEWCONTRACT = '0x9d1f4c7a2b8e6035f4a7c1d9028be35f7a6c4d18';
const NEWTOKEN = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const RECORDS = {};

function hexWord(v) { return BigInt(v).toString(16).padStart(64, '0'); }
function hexAddr(a) { return String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
function recordHex(r) {
  return '0x' + [hexAddr(r.hashlock), hexWord(r.amount), hexWord(r.timelock), hexAddr(r.token),
    hexAddr(r.sender), hexAddr(r.receiver), hexWord(r.claimed ? 1 : 0), hexWord(r.refunded ? 1 : 0)].join('');
}
function answer(j) {
  const p = (j && j.params) || [];
  switch (j && j.method) {
    case 'eth_chainId': return '0x66eee';
    case 'eth_blockNumber': return '0x2f1c40';
    case 'eth_getCode': return '0x6080604052';
    case 'eth_call': {
      const data = String((p[0] && p[0].data) || '').toLowerCase();
      if (data.startsWith('0xeb84e7f2')) {
        const rec = RECORDS['0x' + data.slice(10, 74)];
        return rec ? recordHex(rec) : '0x' + '0'.repeat(64 * 8);
      }
      return '0x' + hexWord(0);
    }
    default: return null;
  }
}
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: answer(j) }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const RPC = 'http://127.0.0.1:' + server.address().port;
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
  await one.c.close();

  // 2. wallet mode: the three steps and the chain line, no escrow yet
  const two = await page(390, 844);
  await two.p.click('#modeWallet');
  await two.p.waitForTimeout(300);
  const inv = await two.p.evaluate(() => window.CLEANSWAP.mintInvoice({
    paymentHash: '0x' + '5c'.repeat(32), sats: 50000, expiry: 6 * 3600
  }));
  await two.p.fill('#invIn', inv);
  await two.p.waitForTimeout(250);
  await two.p.fill('#addrIn', '0x7a3c9b1e5d84f0a2c6b7390e14d8f52a6c9b0e71');
  await two.p.waitForTimeout(500);
  /* the fixed Approve bar sits over the last line: bring step 3 up into view */
  await two.p.evaluate(() => document.getElementById('stepGo').scrollIntoView({ block: 'center' }));
  await two.p.waitForTimeout(300);
  await two.p.screenshot({ path: path.join(DOCS, 'wallet.png'), fullPage: false });

  // 3. the escrow answers, so the swap can wait on the payment
  await two.p.click('#chainRow');
  await two.p.fill('#contractIn', NEWCONTRACT);
  await two.p.fill('#tokenIn', NEWTOKEN);
  await two.p.fill('#rpcIn', RPC);
  await two.p.click('[data-act="saveSetup"]');
  await two.p.waitForTimeout(900);
  const shotTerms = await two.p.evaluate(async () => {
    const st = window.CLEANSWAP.state;
    const r = window.CLEANSWAP.readInvoice(document.getElementById('invIn').value);
    const a = window.CLEANSWAP.readAddress(document.getElementById('addrIn').value).address;
    st.t2 = Math.floor(Date.now() / 1000) + 7200;
    st.locker = '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761';
    const units = window.CLEANSWAP.usdtUnits();
    const id = await window.CLEANSWAP.computeSwapId(r.H, st.locker, a, window.CLEANSWAP.tokenNow(), units, st.t2);
    return { id: id, H: r.H, units: units, t2: st.t2, addr: a };
  });
  RECORDS[shotTerms.id.toLowerCase()] = {
    hashlock: shotTerms.H, amount: shotTerms.units, timelock: shotTerms.t2, token: NEWTOKEN,
    sender: '0x3d0f6a8c72b41e95d8a3c0671f2b4e8d90c5a761', receiver: shotTerms.addr,
    claimed: false, refunded: false
  };
  await two.p.click('#chainRow');
  await two.p.waitForTimeout(200);
  await two.p.click('#primary');
  await two.p.waitForFunction(() => document.body.dataset.phase === 'paying', null, { timeout: 8000 });
  await two.p.waitForTimeout(2800);          /* let the toast fade before the shot */
  await two.p.screenshot({ path: path.join(DOCS, 'paying.png'), fullPage: false });
  await two.c.close();

  // 4. the code QR, for whoever wants to see it
  const four = await page(390, 844);
  await four.p.click('[data-act="sampleInv"]');
  await four.p.waitForTimeout(250);
  await four.p.click('[data-act="sampleAddr"]');
  await four.p.waitForTimeout(250);
  await four.p.click('[data-act="qrCode"]');
  await four.p.waitForTimeout(400);
  await four.p.screenshot({ path: path.join(SHOTS, 'v50-code-qr.png'), fullPage: false });
  await four.c.close();

  await b.close();
  server.close();
  console.log('docs images written');
})().catch((e) => { console.error(e); process.exit(2); });
