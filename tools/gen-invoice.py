#!/usr/bin/env python3
"""Generate the BOLT11 sample invoice embedded in the app (test fixture).

The invoice is built from the BOLT 11 spec's construction by hand (bech32 HRP,
35-bit timestamp, tagged 'p'/'d'/'x' fields, a 65-byte secp256k1 signature) so
that `test/headless.js` can decode it in the app and compare `payment_hash`
against the value printed here. It is signed with the app's practice key, the
same one src/modules/crypto.js uses for its own sample invoices: the app verifies every
invoice it reads, so a fixture with a made-up signature would be refused.
"""
import hashlib
import hmac

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

# The practice key, in src/modules/crypto.js as PRACTICE_KEY. It holds nothing.
PRACTICE_KEY = bytes.fromhex('2f1c8bd6a4e0793d5c1b8a6f47e293d0c5b8f17a26d4e9038b7c15fa6d2e4093')
P = 2 ** 256 - 2 ** 32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

PAYMENT_HASH = bytes.fromhex('11' * 32)
TIMESTAMP = 1735689600           # 2025-01-01T00:00:00Z
AMOUNT_HRP = '500u'              # 0.0005 BTC = 50,000 sats
DESCRIPTION = 'CleanSwap hold invoice'
EXPIRY = 3600


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


def checksum(hrp, data):
    p = polymod(hrp_expand(hrp) + data + [0] * 6) ^ 1
    return [(p >> 5 * (5 - i)) & 31 for i in range(6)]


def to_words(raw, pad=True):
    acc, bits, out = 0, 0, []
    for b in raw:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if pad and bits:
        out.append((acc << (5 - bits)) & 31)
    return out


def tag(char, words):
    # BOLT 11: the type is the 5-bit number written as the bech32 character at
    # that position (`p` = 1, `d` = 13, `x` = 6), not the letter's place in the
    # alphabet.
    return [CHARSET.index(char), len(words) >> 5, len(words) & 31] + words


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


def words_to_bytes_pad(words):
    acc, bits, out = 0, 0, []
    for w in words:
        acc = (acc << 5) | w
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 255)
    if bits:
        out.append((acc << (8 - bits)) & 255)
    return bytes(out)


def sign(words, hrp):
    """RFC 6979 with HMAC-SHA-256, low-S, 65 bytes with the recovery byte."""
    msg = hashlib.sha256(hrp.encode() + words_to_bytes_pad(words)).digest()
    d = int.from_bytes(PRACTICE_KEY, 'big')
    z = int.from_bytes(msg, 'big')
    x = d.to_bytes(32, 'big')
    h1 = (z % N).to_bytes(32, 'big')

    def mac(key, data):
        return hmac.new(key, data, hashlib.sha256).digest()

    k, v = bytes(32), b'\x01' * 32
    k = mac(k, v + b'\x00' + x + h1)
    v = mac(k, v)
    k = mac(k, v + b'\x01' + x + h1)
    v = mac(k, v)
    while True:
        v = mac(k, v)
        nonce = int.from_bytes(v, 'big')
        if 0 < nonce < N:
            break
        k = mac(k, v + b'\x00')
        v = mac(k, v)
    point = point_mul(nonce, G)
    r = point[0] % N
    s = pow(nonce, N - 2, N) * (z + r * d) % N
    rec = (point[1] & 1) | (2 if point[0] >= N else 0)
    if s > N // 2:
        s = N - s
        rec ^= 1
    return r.to_bytes(32, 'big') + s.to_bytes(32, 'big') + bytes([rec])


def build():
    hrp = 'lnbc' + AMOUNT_HRP
    body = []
    ts = TIMESTAMP
    body += [(ts >> 5 * (6 - i)) & 31 for i in range(7)]
    body += tag('p', to_words(PAYMENT_HASH))
    body += tag('d', to_words(DESCRIPTION.encode()))
    body += tag('x', to_words(EXPIRY.to_bytes(2, 'big')))
    body += to_words(sign(body, hrp))               # 104 words: 65-byte signature
    data = body + checksum(hrp, body)
    return hrp + '1' + ''.join(CHARSET[d] for d in data)


def bigsize(n):
    if n < 0xfd:
        return bytes([n])
    if n <= 0xffff:
        return b'\xfd' + n.to_bytes(2, 'big')
    if n <= 0xffffffff:
        return b'\xfe' + n.to_bytes(4, 'big')
    return b'\xff' + n.to_bytes(8, 'big')


def tlv(type_no, value):
    return bigsize(type_no) + bigsize(len(value)) + value


NODE_ID = b'\x02' + hashlib.sha256(b'cleanswap-node').digest()
OFFER_DESC = 'CleanSwap - BTC for USDT'
OFFER_EXPIRY = 1798761600        # 2027-01-01T00:00:00Z


def build_offer():
    """A BOLT12 offer: bech32 (no checksum) over a TLV stream."""
    tlvs = (
        tlv(10, OFFER_DESC.encode()) +      # offer_description
        tlv(14, OFFER_EXPIRY.to_bytes(4, 'big')) +   # offer_absolute_expiry
        tlv(22, NODE_ID) +                  # node_id
        tlv(240, bytes(64))                 # signature slot (not verified by the app)
    )
    words = to_words(tlvs, pad=True)
    hrp = 'lno'
    return hrp + '1' + ''.join(CHARSET[w] for w in words)


if __name__ == '__main__':
    inv = build()
    print('payment_hash =', '0x' + PAYMENT_HASH.hex())
    print('invoice      =', inv)
    print('length       =', len(inv))
    offer = build_offer()
    print('offer_desc   =', OFFER_DESC)
    print('node_id      =', NODE_ID.hex())
    print('expiry       =', OFFER_EXPIRY)
    print('offer        =', offer)
    print('offer_len    =', len(offer))
