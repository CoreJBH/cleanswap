#!/usr/bin/env python3
"""Assemble the single-file Emerald Swap app from src/ into ../../ln-usdt-swap.html

Everything is inlined — CSS, the QR encoder, the BOLT11/BOLT12 decoder, the app
and the Solidity reference source — so the built page makes no requests except
the optional BTC/USD quote from mempool.space. Also writes dist/emerald-swap.html
for repository distribution.
"""
import base64
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
CONTRACTS = os.path.join(HERE, 'contracts')
ASSETS = os.path.join(HERE, 'assets')
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'ln-usdt-swap.html'))
DIST = os.path.join(HERE, 'dist', 'cleanswap.html')


def read(*p):
    with open(os.path.join(*p), encoding='utf-8') as f:
        return f.read()


def icon_b64(name):
    with open(os.path.join(ASSETS, name), 'rb') as f:
        return base64.b64encode(f.read()).decode('ascii')


def sample(tag):
    """Pull the sample strings printed by tools/gen-invoice.py out of the module."""
    path = os.path.join(HERE, 'tools', 'gen-invoice.py')
    sys.path.insert(0, os.path.dirname(path))
    import importlib.util
    spec = importlib.util.spec_from_file_location('gen_invoice', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build() if tag == 'bolt11' else mod.build_offer()


def main():
    tpl = read(SRC, 'index.template.html')
    css = read(SRC, 'app.css')
    qr = read(SRC, 'qr.js').strip()
    app = read(SRC, 'app.js').strip()
    sol = read(CONTRACTS, 'LightningUsdtHTLC.sol').strip()

    for name, blob in (('qr', qr), ('app', app), ('css', css)):
        if '</script' in blob.lower():
            sys.exit('ERROR: %s contains a closing script tag' % name)
    if '/*' in sol and '*/' not in sol:
        sys.exit('ERROR: unterminated comment in contract source')

    out = tpl.replace('/*__CSS__*/', css)
    out = out.replace('/*__QR__*/', qr)
    out = out.replace('/*__APP__*/', app)
    out = out.replace('/*__SOL__*/', sol)
    out = out.replace('/*__BOLT11__*/', sample('bolt11'))
    out = out.replace('/*__BOLT12__*/', sample('bolt12'))
    out = out.replace('__ICON64__', icon_b64('icon-64.png'))
    out = out.replace('__ICON180__', icon_b64('icon-180.png'))

    missing = re.findall(r'/\*__[A-Z0-9]+__\*/', out)
    if missing:
        sys.exit('ERROR: unsubstituted tokens: %s' % ', '.join(sorted(set(missing))))

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (OUT, len(out.encode('utf-8'))))

    os.makedirs(os.path.dirname(DIST), exist_ok=True)
    with open(DIST, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (DIST, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
