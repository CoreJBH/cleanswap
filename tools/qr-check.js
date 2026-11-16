/* Emit QR matrices for cross-checking against python-qrcode.
   Run: node tools/qr-check.js > build/qr-js.json */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'qr.js'), 'utf8');
const sandbox = { window: {}, TextEncoder: TextEncoder };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const QR = sandbox.window.QR;

const cases = [];
const texts = [
  'liquidnetwork:lq1qqvtestaddress0',
  'lq1qqwxyz' + 'a'.repeat(20),
  'liquidnetwork:lq1qq' + 'x'.repeat(60) + '?amount=45.00',
  'lq1' + 'q'.repeat(100),
  'https://example.org/pay?to=' + 'z'.repeat(40)
];
let seq = 0;
for (const text of texts) {
  seq++;
  for (let mask = 0; mask < 8; mask++) {
    const q = QR.encode(text, { mask });
    cases.push({ text, mask, version: q.version, size: q.size, modules: q.modules.map(r => r.map(b => (b ? 1 : 0))) });
  }
  const auto = QR.encode(text);
  cases.push({ text, mask: 'auto', version: auto.version, size: auto.size, chosen: auto.mask, modules: auto.modules.map(r => r.map(b => (b ? 1 : 0))) });
}
fs.writeFileSync(path.resolve(__dirname, '..', 'build', 'qr-js.json'), JSON.stringify(cases));
console.log('cases:', cases.length, 'versions:', [...new Set(cases.map(c => c.version))].join(','));
