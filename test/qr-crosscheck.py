#!/usr/bin/env python3
"""Cross-check the dependency-free QR encoder against python-qrcode.

tools/qr-check.js emits the module matrix of every mask (0-7) for several payload
lengths; this compares them cell by cell with an independent implementation.

    pip install --target .tools/py qrcode
    PYTHONPATH=.tools/py python3 test/qr-crosscheck.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = os.environ.get('NODE', 'node')

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M
except ImportError:
    sys.exit('python-qrcode is required: pip install --target .tools/py qrcode')

LEVELS = {'L': ERROR_CORRECT_L, 'M': ERROR_CORRECT_M}

out = subprocess.run([NODE, os.path.join(ROOT, 'tools', 'qr-check.js')],
                     cwd=ROOT, capture_output=True, text=True)
if out.returncode != 0:
    sys.exit('qr-check.js failed:\n' + out.stderr)

cases = json.load(open(os.path.join(ROOT, 'build', 'qr-js.json')))
checked = failed = auto_ok = auto_total = 0

for case in cases:
    q = qrcode.QRCode(version=case['version'], error_correction=LEVELS[case.get('level', 'M')], border=0,
                      mask_pattern=None if case['mask'] == 'auto' else case['mask'])
    q.add_data(case['text'])
    q.make()
    ref = [[1 if b else 0 for b in row] for row in q.modules]
    same = ref == case['modules']
    if case['mask'] == 'auto':
        auto_total += 1
        auto_ok += 1 if same else 0
        if not same:
            print('note: auto-mask choice differs for %r (both are valid QRs)' % case['text'][:24])
        continue
    checked += 1
    if not same:
        failed += 1
        diff = sum(1 for r1, r2 in zip(ref, case['modules']) for a, b in zip(r1, r2) if a != b)
        print('FAIL v%s mask%s: %d modules differ' % (case['version'], case['mask'], diff))

print('%d/%d fixed-mask matrices identical to python-qrcode; %d/%d auto-mask matrices identical'
      % (checked - failed, checked, auto_ok, auto_total))
sys.exit(1 if failed else 0)
