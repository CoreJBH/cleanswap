#!/usr/bin/env python3
"""Assemble the single-file CleanSwap app from src/ into ../../ln-usdt-swap.html

Everything is inlined - CSS, the QR encoder, the BOLT11/BOLT12 codec, the app
and the Solidity reference source - so the built page makes no requests except
the optional BTC/USD quotes from two public price APIs. Also writes
dist/cleanswap.html for repository distribution.

The page is one script, built out of src/modules/ in the order listed below:
each module is a responsibility, and the whole list is concatenated inside one
closure, so the shipped artifact is still a single HTML file with one inline
script and the same hash-pinned CSP.

`--test` builds the same page with the window handle the verification suites
drive (bridge-test.js instead of bridge-prod.js) and writes it to
build/cleanswap.test.html. The production page exposes one entry - acceptCode -
and no state.

The build refuses to emit a page that contains Hangul: the repository and the
UI are English only, and this is the last gate before a byte reaches dist/.
"""
import base64
import glob
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
MODULES = os.path.join(SRC, 'modules')
CONTRACTS = os.path.join(HERE, 'contracts')
ASSETS = os.path.join(HERE, 'assets')
BUILD = os.path.join(HERE, 'build')
OUT = os.path.abspath(os.path.join(HERE, '..', '..', 'ln-usdt-swap.html'))
DIST = os.path.join(HERE, 'dist', 'cleanswap.html')
TEST_OUT = os.path.join(BUILD, 'cleanswap.test.html')
APK_ASSET = os.path.join(HERE, 'android', 'app', 'src', 'main', 'assets', 'index.html')
HANGUL = re.compile(r'[\uac00-\ud7af]')

# The order the modules are read in. Function declarations hoist across the
# whole closure, so this is about the top-level statements that run in order:
# the constants and the state come first, and the boot module starts the page.
ORDER = [
    'core.js',        # constants, the state object, hashing, formatting, the log
    'storage.js',     # the setup, and the swap a killed page can pick up again
    'chain.js',       # the swap id, endpoints, the clock, escrow ABI and reads
    'wallet.js',      # an EIP-1193 wallet, the calls it sends, a pasted receipt
    'crypto.js',      # secp256k1, bech32, the BOLT11 / BOLT12 codecs
    'swap.js',        # escrow calldata, the swap code, the inputs it is read from
    'gate.js',        # the one gate a tap has to pass
    'render.js',      # the three-step screen and the gate under it
    'actions.js',     # what a tap does, the rehearsal, codes arriving, the QR
    'price.js',       # the BTC/USD quote, cross-checked between two APIs
    'ui.js',          # the setup panel, the event wiring and the ACT table
    'boot.js',        # wiring the page and starting it
]
BRIDGE = {'prod': 'bridge-prod.js', 'test': 'bridge-test.js'}


SOLC = os.environ.get('SOLC') or (glob.glob(os.path.join(HERE, '.tools', 'solc-linux-amd64-*')) or [None])[0]


def escrow_bytecode():
    """The escrow's creation bytecode, for the Setup panel's deploy hand-off.

    solc 0.8.26 compiles contracts/CleanSwapHTLC.sol here when it is installed;
    otherwise the bytecode committed beside the source is used, and
    test/contract-evm.py fails if the two ever disagree.
    """
    committed = os.path.join(CONTRACTS, 'CleanSwapHTLC.bin')
    if SOLC and os.path.exists(SOLC):
        os.makedirs(BUILD, exist_ok=True)
        subprocess.run([SOLC, '--optimize', '--optimize-runs', '200', '--combined-json', 'abi,bin',
                        'contracts/CleanSwapHTLC.sol', 'contracts/TestUSDT.sol',
                        '-o', BUILD, '--overwrite'], cwd=HERE, check=True, capture_output=True)
        data = json.load(open(os.path.join(BUILD, 'combined.json'), encoding='utf-8'))
        for key, art in data['contracts'].items():
            if key.endswith(':CleanSwapHTLC'):
                return art['bin']
    if os.path.exists(committed):
        return open(committed, encoding='ascii').read().strip()
    sys.exit('ERROR: no solc and no contracts/CleanSwapHTLC.bin')


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


def app_source(mode):
    """src/app.js with its modules spliced in, in ORDER, for a build mode."""
    shell = read(SRC, 'app.js')
    if '/*__MODULES__*/' not in shell:
        sys.exit('ERROR: src/app.js has no module marker')
    names = ORDER + [BRIDGE[mode]]
    parts = []
    for name in names:
        body = read(MODULES, name).strip()
        if not body:
            sys.exit('ERROR: module %s is empty' % name)
        parts.append(body)
    return shell.replace('/*__MODULES__*/', '\n\n'.join(parts))


def inline_hashes(html):
    """The CSP source lists for the page's own script and style blocks.

    A hash names the exact bytes of one inline block, so the policy can allow
    the code that is in this file and nothing else: no 'unsafe-inline', and an
    injected block - or an edited one - does not run.
    """
    def one(blob):
        digest = hashlib.sha256(blob.encode('utf-8')).digest()
        return "'sha256-" + base64.b64encode(digest).decode('ascii') + "'"

    scripts = re.findall(r'<script\b[^>]*>(.*?)</script\s*>', html, re.S | re.I)
    styles = re.findall(r'<style\b[^>]*>(.*?)</style\s*>', html, re.S | re.I)
    if not scripts or not styles:
        sys.exit('ERROR: the page has an inline script or style the policy would block')
    return ' '.join(one(s) for s in scripts), ' '.join(one(s) for s in styles)


def page(mode):
    tpl = read(SRC, 'index.template.html')
    css = read(SRC, 'app.css')
    qr = read(SRC, 'qr.js').strip()
    app = app_source(mode)
    sol = read(CONTRACTS, 'CleanSwapHTLC.sol').strip()
    code = escrow_bytecode()

    for name, blob in (('qr', qr), ('app', app), ('css', css), ('template', tpl), ('contract', sol)):
        if HANGUL.search(blob):
            hit = HANGUL.search(blob)
            sys.exit('ERROR: %s contains Hangul at offset %d' % (name, hit.start()))
    for name, blob in (('qr', qr), ('app', app), ('css', css)):
        if '</script' in blob.lower():
            sys.exit('ERROR: %s contains a closing script tag' % name)
    if '/*' in sol and '*/' not in sol:
        sys.exit('ERROR: unterminated comment in contract source')

    out = tpl.replace('/*__CSS__*/', css)
    out = out.replace('/*__QR__*/', qr)
    out = out.replace('/*__APP__*/', app)
    out = out.replace('/*__SOL__*/', sol)
    out = out.replace('/*__BYTECODE__*/', code)
    out = out.replace('/*__BOLT11__*/', sample('bolt11'))
    out = out.replace('/*__BOLT12__*/', sample('bolt12'))
    out = out.replace('__ICON64__', icon_b64('icon-64.png'))
    out = out.replace('__ICON180__', icon_b64('icon-180.png'))

    script_src, style_src = inline_hashes(out)
    out = out.replace('/*__CSPSCRIPT__*/', script_src)
    out = out.replace('/*__CSPSTYLE__*/', style_src)
    policy = re.search(r'Content-Security-Policy" content="([^"]*)"', out)
    if not policy or 'unsafe-inline' in policy.group(1):
        sys.exit('ERROR: the Content-Security-Policy still allows inline code')

    missing = re.findall(r'/\*__[A-Z0-9]+__\*/', out)
    if missing:
        sys.exit('ERROR: unsubstituted tokens: %s' % ', '.join(sorted(set(missing))))
    if HANGUL.search(out):
        sys.exit('ERROR: built page contains Hangul')
    return out


def main():
    mode = 'prod'
    for arg in sys.argv[1:]:
        if arg == '--test':
            mode = 'test'
        else:
            sys.exit('ERROR: unknown argument %s (only --test)' % arg)
    out = page(mode)

    if mode == 'test':
        os.makedirs(BUILD, exist_ok=True)
        with open(TEST_OUT, 'w', encoding='utf-8') as f:
            f.write(out)
        print('wrote %s (%d bytes)' % (TEST_OUT, len(out.encode('utf-8'))))
        return

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (OUT, len(out.encode('utf-8'))))

    os.makedirs(os.path.dirname(DIST), exist_ok=True)
    with open(DIST, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (DIST, len(out.encode('utf-8'))))

    # The Android shell ships this exact file, so keep the staged copy in step
    # with dist/ (CI does the same copy before gradle).
    os.makedirs(os.path.dirname(APK_ASSET), exist_ok=True)
    with open(APK_ASSET, 'w', encoding='utf-8') as f:
        f.write(out)
    print('wrote %s (%d bytes)' % (APK_ASSET, len(out.encode('utf-8'))))


if __name__ == '__main__':
    main()
