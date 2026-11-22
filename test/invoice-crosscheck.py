#!/usr/bin/env python3
"""Decode the invoices the app mints with an independent BOLT11 implementation.

tools/mint-invoices.js asks the built app to mint hold invoices; this file parses
them from scratch - bech32 polymod, 35-bit timestamp, tagged fields, the 65-byte
signature - and compares every field with the fixture and with what the app
itself decoded. The signature is checked here with secp256k1 recovery plus
OpenSSL's ECDSA (cryptography), never with the app's own arithmetic, and the
BOLT #11 test vectors are checked the same way against the spec's key. If the app
minted something a wallet would reject, it shows here.

    PLAYWRIGHT_PKG=... LD_LIBRARY_PATH=... PYTHONPATH=.tools/py python3 test/invoice-crosscheck.py
"""
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = os.environ.get('NODE', 'node')
DATA = os.path.join(ROOT, 'build', 'js-invoices.json')
VECTORS = os.path.join(HERE, 'bolt11-vectors.json')

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
MULT = {'m': 1e-3, 'u': 1e-6, 'n': 1e-9, 'p': 1e-12, '': 1}
HRP = re.compile(r'^ln([a-z]+?)(\d+)?([munp]?)$')

fails = []
checks = 0


def check(name, ok, detail=''):
    global checks
    checks += 1
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail else ''))
    if not ok:
        fails.append(name)


# ------------------------------------------------------------ secp256k1 ----
# Enough of the curve to recover a public key from a BOLT11 signature and check
# it with a second ECDSA implementation.
P = 2 ** 256 - 2 ** 32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        lam = 3 * a[0] * a[0] * pow(2 * a[1], P - 2, P) % P
    else:
        lam = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P) % P
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)


def point_mul(k, p):
    r = None
    while k:
        if k & 1:
            r = point_add(r, p)
        p = point_add(p, p)
        k >>= 1
    return r


def recover_pubkey(msg, r, s, recid):
    if not (0 < r < N and 0 < s < N) or recid > 3:
        return None
    x = r + (N if recid >= 2 else 0)
    if x >= P:
        return None
    y2 = (x * x * x + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if (y * y - y2) % P != 0:
        return None
    if (y & 1) != (recid & 1):
        y = P - y
    rinv = pow(r, N - 2, N)
    q = point_add(point_mul(s * rinv % N, (x, y)), point_mul((N - msg) % N * rinv % N, G))
    return q


def parse_pubkey(hexkey):
    raw = bytes.fromhex(hexkey)
    if len(raw) == 33:
        x = int.from_bytes(raw[1:], 'big')
        y2 = (x * x * x + 7) % P
        y = pow(y2, (P + 1) // 4, P)
        if (y & 1) != (raw[0] & 1):
            y = P - y
        return (x, y)
    return (int.from_bytes(raw[:32], 'big'), int.from_bytes(raw[32:], 'big'))


def compress(point):
    return '%02x%s' % (2 + (point[1] & 1), format(point[0], '064x'))


def der(r, s):
    def one(v):
        b = v.to_bytes((v.bit_length() + 7) // 8 or 1, 'big')
        if b[0] & 0x80:
            b = b'\x00' + b
        return b'\x02' + bytes([len(b)]) + b
    body = one(r) + one(s)
    return b'\x30' + bytes([len(body)]) + body


def ecdsa_ok(msg, r, s, point):
    """A second implementation (OpenSSL through cryptography) on the same bytes."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    key = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256K1(), bytes.fromhex(compress(point)))
    try:
        # msg is already the SHA-256 the invoice signs, so the hashing step is
        # declared prehashed rather than repeated inside OpenSSL.
        key.verify(der(r, s), msg, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return True
    except Exception:
        return False


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


def words_to_bytes_pad(words):
    acc = bits = 0
    out = []
    for w in words:
        acc = (acc << 5) | w
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 255)
    if bits:
        out.append((acc << (8 - bits)) & 255)
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
        fields.setdefault(CHARSET[t] if 1 <= t <= 26 else '?', body[i + 3:i + 3 + size])
        i += 3 + size
    return {
        'hrp': hrp,
        'network': m.group(1),
        'sats': amount,
        'timestamp': words_to_int(words[:7]),
        'payment_hash': '0x' + words_to_bytes(fields['p']).hex() if 'p' in fields else None,
        'expiry': words_to_int(fields['x']) if 'x' in fields else None,
        'description': words_to_bytes(fields['d']).decode('utf-8') if 'd' in fields else None,
        'sig_bytes': len(words_to_bytes(sig)),
        'sig_words': len(sig),
        'sig': words_to_bytes_pad(sig),
        'message': hashlib.sha256(hrp.encode('ascii') + words_to_bytes_pad(words[:-104])).digest(),
        'tags': ''.join(sorted(fields)),
    }


def main():
    out = subprocess.run([NODE, os.path.join(ROOT, 'tools', 'mint-invoices.js')],
                         cwd=ROOT, capture_output=True, text=True, env=dict(os.environ))
    print(out.stdout.strip())
    if out.returncode != 0:
        sys.exit('mint-invoices.js failed:\n' + out.stderr)

    cases = json.load(open(DATA))
    practice_keys = set()
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

        # the signature: recovered with this file's curve code, verified by OpenSSL
        raw = d['sig']
        r = int.from_bytes(raw[:32], 'big')
        s = int.from_bytes(raw[32:64], 'big')
        z = int.from_bytes(d['message'], 'big')
        check('mint %s: the signature is low-S' % name, s <= N // 2, hex(s)[:10])
        point = recover_pubkey(z, r, s, raw[64])
        check('mint %s: the signature recovers a key' % name, point is not None, raw[64])
        if point is not None:
            practice_keys.add(compress(point))
            check('mint %s: an independent ECDSA verifies it' % name, ecdsa_ok(d['message'], r, s, point),
                  compress(point)[:16] + '...')
            check('mint %s: the app reports the same payee key' % name,
                  row['selfDecoded'].get('nodeId') == compress(point),
                  str(row['selfDecoded'].get('nodeId'))[:16])

    check('mint: every sample invoice is signed by the one practice key',
          len(practice_keys) == 1, ', '.join(sorted(practice_keys))[:80])

    # ------------------------------------------------- BOLT #11 vectors ----
    # Real invoices from the standard, signed by the spec's key: the same
    # checks, but against something the app did not produce.
    spec = json.load(open(VECTORS))
    node = spec['node_id']
    # Two vectors are meant to fail on their own bytes: a broken checksum and a
    # signature that cannot be recovered.
    unparseable = {'bad-checksum', 'unrecoverable'}
    for case in spec['cases']:
        try:
            d = decode(case['invoice'])
        except ValueError as e:
            check('vector %s: refused, as the spec says' % case['name'],
                  case['name'] in unparseable, e)
            continue
        raw = d['sig']
        r = int.from_bytes(raw[:32], 'big')
        s = int.from_bytes(raw[32:64], 'big')
        z = int.from_bytes(d['message'], 'big')
        point = recover_pubkey(z, r, s, raw[64])
        if case['name'] == 'unrecoverable':
            check('vector unrecoverable: no key comes out of the signature, as the spec says',
                  point is None, 'none' if point is None else compress(point)[:16])
            continue
        check('vector %s: the spec key comes back out of the signature' % case['name'],
              point is not None and compress(point) == node,
              compress(point)[:16] if point else 'none')
        check('vector %s: OpenSSL verifies the spec signature on these bytes' % case['name'],
              point is not None and ecdsa_ok(d['message'], r, s, parse_pubkey(node)),
              d['message'].hex()[:16])
        if case['name'] == 'amountless':
            check('vector amountless: the signed preimage is the hash the spec prints',
                  d['message'].hex() == spec['preimage_sha256'],
                  d['message'].hex()[:24])

    print('%d/%d invoice checks passed' % (checks - len(fails), checks))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
