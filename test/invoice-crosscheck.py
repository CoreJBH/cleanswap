#!/usr/bin/env python3
"""Decode the invoices the app mints with an independent BOLT11 implementation.

tools/mint-invoices.js asks the built app to mint hold invoices; this file parses
them from scratch - bech32 polymod, 35-bit timestamp, tagged fields, 104-word
signature slot - and compares every field with the fixture and with what the app
itself decoded. If the app minted something a wallet would reject, it shows here.

    PLAYWRIGHT_PKG=... LD_LIBRARY_PATH=... PYTHONPATH=.tools/py python3 test/invoice-crosscheck.py
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = os.environ.get('NODE', 'node')
DATA = os.path.join(ROOT, 'build', 'js-invoices.json')

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
MULT = {'m': 1e-3, 'u': 1e-6, 'n': 1e-9, 'p': 1e-12, '': 1}
HRP = re.compile(r'^ln([a-z]+?)(\d+)?([munp]?)$')

fails = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail else ''))
    if not ok:
        fails.append(name)


def polymod(values):
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1ffffff) << 5 ^ v
        for i in range(5):
            chk ^= GEN[i] if ((b >> i) & 1) else 0
    return chk


def hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def bech32_decode(invoice):
    if invoice.lower() != invoice:
        raise ValueError('mixed case invoice')
    pos = invoice.rfind('1')
    if pos < 1:
        raise ValueError('missing separator')
    hrp, data = invoice[:pos], invoice[pos + 1:]
    try:
        words = [CHARSET.index(c) for c in data]
    except ValueError:
        raise ValueError('character outside the bech32 alphabet')
    if polymod(hrp_expand(hrp) + words) != 1:
        raise ValueError('bech32 checksum failed')
    return hrp, words[:-6]


def words_to_bytes(words):
    acc = bits = 0
    out = []
    for w in words:
        acc = (acc << 5) | w
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 255)
    return bytes(out)


def words_to_int(words):
    n = 0
    for w in words:
        n = n * 32 + w
    return n


def decode(invoice):
    hrp, words = bech32_decode(invoice)
    m = HRP.match(hrp)
    if not m:
        raise ValueError('unrecognised human-readable part %r' % hrp)
    amount = round(int(m.group(2)) * MULT[m.group(3)] * 1e8) if m.group(2) else None
    if len(words) < 7 + 104:
        raise ValueError('invoice body too short')
    body, sig = words[7:-104], words[-104:]
    fields, i = {}, 0
    while i + 3 <= len(body):
        t = body[i]
        size = (body[i + 1] << 5) | body[i + 2]
        if i + 3 + size > len(body):
            raise ValueError('truncated field')
        fields.setdefault(chr(96 + t), body[i + 3:i + 3 + size])
        i += 3 + size
    return {
        'network': m.group(1),
        'sats': amount,
        'timestamp': words_to_int(words[:7]),
        'payment_hash': '0x' + words_to_bytes(fields['p']).hex() if 'p' in fields else None,
        'expiry': words_to_int(fields['x']) if 'x' in fields else None,
        'description': words_to_bytes(fields['d']).decode('utf-8') if 'd' in fields else None,
        'sig_bytes': len(words_to_bytes(sig)),
        'sig_words': len(sig),
        'tags': ''.join(sorted(fields)),
    }


def main():
    out = subprocess.run([NODE, os.path.join(ROOT, 'tools', 'mint-invoices.js')],
                         cwd=ROOT, capture_output=True, text=True, env=dict(os.environ))
    print(out.stdout.strip())
    if out.returncode != 0:
        sys.exit('mint-invoices.js failed:\n' + out.stderr)

    cases = json.load(open(DATA))
    per_case = 9
    for row in cases:
        c, inv, name = row['case'], row['invoice'], row['case']['label']
        try:
            d = decode(inv)
            decoded = True
        except ValueError as e:
            d, decoded = {}, False
            check('mint %s: the invoice parses' % name, False, e)
        if not decoded:
            continue
        check('mint %s: bech32 checksum holds under an independent decoder' % name, decoded)
        check('mint %s: payment_hash matches the swap' % name,
              d['payment_hash'] == c['paymentHash'], d['payment_hash'])
        check('mint %s: amount round-trips to %d sats' % (name, c['sats']), d['sats'] == c['sats'], d['sats'])
        check('mint %s: 35-bit timestamp' % name, d['timestamp'] == c['timestamp'], d['timestamp'])
        check('mint %s: expiry tag' % name, d['expiry'] == c['expiry'], d['expiry'])
        check('mint %s: 65-byte signature slot (104 words)' % name,
              d['sig_bytes'] == 65 and d['sig_words'] == 104,
              '%d bytes / %d words' % (d['sig_bytes'], d['sig_words']))
        check('mint %s: description tag only when it fit' % name,
              d['description'] == c.get('description'), d['description'])
        check('mint %s: app decoder agrees with this one' % name,
              row['selfDecoded']['sats'] == d['sats']
              and row['selfDecoded']['paymentHash'] == d['payment_hash']
              and row['selfDecoded']['expiresAt'] == d['timestamp'] + d['expiry'],
              json.dumps(row['selfDecoded'])[:80])
        check('mint %s: fits a version-10 QR (<=271 bytes at level L)' % name, row['length'] <= 271, row['length'])

    total = len(cases) * per_case
    print('%d/%d invoice checks passed' % (total - len(fails), total))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
