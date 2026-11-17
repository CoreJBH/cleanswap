#!/usr/bin/env python3
"""Generate the BOLT11 sample invoice embedded in the app (test fixture).

The invoice is built from the BOLT 11 spec's construction by hand (bech32 HRP,
35-bit timestamp, tagged 'p'/'d'/'x' fields, 104-word signature slot) so that
`test/headless.js` can decode it in the app and compare `payment_hash` against
the value printed here. The signature slot is filled with deterministic filler:
the app's decoder parses fields and checksum, it does not verify secp256k1.
"""
import hashlib

CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

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
    return [ord(char) - 97 + 1, len(words) >> 5, len(words) & 31] + words


def build():
    body = []
    ts = TIMESTAMP
    body += [(ts >> 5 * (6 - i)) & 31 for i in range(7)]
    body += tag('p', to_words(PAYMENT_HASH))
    body += tag('d', to_words(DESCRIPTION.encode()))
    body += tag('x', to_words(EXPIRY.to_bytes(2, 'big')))
    filler = hashlib.sha256(b'cleanswap-filler').digest() * 2 + b'\x1b'
    body += to_words(filler)                       # 104 words: 65-byte sig slot
    hrp = 'lnbc' + AMOUNT_HRP
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
