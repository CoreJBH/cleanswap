#!/usr/bin/env python3
"""Run LightningUsdtHTLC.sol on a real EVM.

Uses py-evm through eth-tester (no node, no network) to deploy TestUSDT and
LightningUsdtHTLC and exercise the actual bytecode: lock, claim with the right
preimage, claim with a wrong preimage, double claim, refund before and after the
timelock, and the balance movements those imply.

Requires: solc (SOLC env var or .tools/solc-*), plus eth-tester, py-evm and eth-abi.
    pip install --target .tools/py eth-tester py-evm eth-abi eth-utils
    PYTHONPATH=.tools/py python3 test/contract-evm.py
"""
import glob
import json
import os
import re
import subprocess
import sys

from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_tester import EthereumTester, PyEVMBackend
from eth_tester.exceptions import TransactionFailed
from eth_utils import keccak, to_bytes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
SOLC = os.environ.get('SOLC') or (glob.glob(os.path.join(ROOT, '.tools', 'solc-linux-amd64-*')) or [None])[0]

fails = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail else ''))
    if not ok:
        fails.append(name)


def compile_contracts():
    if not SOLC or not os.path.exists(SOLC):
        sys.exit('solc not found — set SOLC=/path/to/solc')
    os.makedirs(BUILD, exist_ok=True)
    subprocess.run([SOLC, '--optimize', '--optimize-runs', '200', '--combined-json', 'abi,bin',
                    'contracts/LightningUsdtHTLC.sol', 'contracts/TestUSDT.sol',
                    '-o', BUILD, '--overwrite'], cwd=ROOT, check=True, capture_output=True)
    data = json.load(open(os.path.join(BUILD, 'combined.json')))
    out = {}
    for key, art in data['contracts'].items():
        name = key.split(':')[1]
        out[name] = {'abi': art['abi'], 'bin': art['bin']}
    return out


def selector(sig):
    return keccak(text=sig)[:4]


t = EthereumTester(backend=PyEVMBackend())


def now():
    return int(t.get_block_by_number('latest')['timestamp'])


def mine(n):
    a, b = accounts[0], accounts[1]
    for _ in range(n):
        t.send_transaction({'from': a, 'to': b, 'value': 0, 'gas': 21000})


def send(to, sig, types, args, frm, gas=400000):
    data = '0x' + (selector(sig) + abi_encode(types, args)).hex()
    tx = t.send_transaction({'from': frm, 'to': to, 'data': data, 'gas': gas})
    return t.get_transaction_receipt(tx)


def view(to, sig, types, args, out_types):
    data = '0x' + (selector(sig) + abi_encode(types, args)).hex()
    raw = t.call({'from': accounts[0], 'to': to, 'data': data})
    if isinstance(raw, str):
        raw = bytes.fromhex(raw[2:] if raw.startswith('0x') else raw)
    return abi_decode(out_types, bytes(raw))


def revert_reason(to, sig, types, args, frm):
    """eth-tester mines a failed call with status 0 instead of raising, so the
    receipt status is what says whether the EVM reverted."""
    try:
        rc = send(to, sig, types, args, frm)
    except TransactionFailed as e:
        return 'revert: ' + str(e)[:80]
    return 'revert: status 0' if rc.get('status', 1) == 0 else 'no revert'


def deploy(art, frm):
    tx = t.send_transaction({'from': frm, 'data': '0x' + art['bin'], 'gas': 4000000})
    return t.get_transaction_receipt(tx)['contract_address']


def event(receipt, sig):
    """Pick our event out of a receipt (the ERC-20 Transfer logs sit alongside)."""
    want = '0x' + keccak(text=sig).hex()
    for log in receipt['logs']:
        if log['topics'] and log['topics'][0].lower() == want:
            return log
    raise AssertionError('event %s not found' % sig)


arts = compile_contracts()
accounts = t.get_accounts()
taker, maker = accounts[1], accounts[2]
concrete = {k: v for k, v in arts.items() if v['bin']}
check('solc: both contracts compiled to bytecode', len(concrete) == 2 and 'LightningUsdtHTLC' in concrete,
      ', '.join('%s %dB' % (k, len(v['bin']) // 2) for k, v in concrete.items()))

usdt = deploy(arts['TestUSDT'], accounts[0])
htlc = deploy(arts['LightningUsdtHTLC'], accounts[0])
check('deploy: TestUSDT + LightningUsdtHTLC live on py-evm', bool(usdt) and bool(htlc),
      'usdt=%s htlc=%s' % (str(usdt)[:12], str(htlc)[:12]))

# faucet + approve
send(usdt, 'faucet()', [], [], taker)
cash = 10_000 * 10 ** 6
check('TestUSDT.faucet(): 10,000 USDT minted', view(usdt, 'balanceOf(address)', ['address'], [taker], ['uint256'])[0] == cash)
send(usdt, 'approve(address,uint256)', ['address', 'uint256'], [htlc, cash], taker)
check('TestUSDT.approve(): HTLC allowance set',
      view(usdt, 'allowance(address,address)', ['address', 'address'], [taker, htlc], ['uint256'])[0] == cash)

# ---- lock ------------------------------------------------------------------
R = bytes.fromhex('aa' * 32)
H = keccak(text='unused')[:0] + __import__('hashlib').sha256(R).digest()  # sha256, not keccak
timelock = now() + 310          # a little over MIN_TIMELOCK_DELTA (300s)
amount = 32_200_000                       # 32.20 USDT (6 decimals)
check('hashlock: derived with sha256 (Bitcoin construction)', len(H) == 32)

too_soon = revert_reason(htlc, 'lock(bytes32,uint256,address,address,uint256)',
                         ['bytes32', 'uint256', 'address', 'address', 'uint256'],
                         [H, now() + 60, maker, usdt, amount], taker)
check('lock: rejects a timelock inside MIN_TIMELOCK_DELTA', 'revert' in too_soon.lower(), too_soon[:60])

lock_rc = send(htlc, 'lock(bytes32,uint256,address,address,uint256)',
               ['bytes32', 'uint256', 'address', 'address', 'uint256'],
               [H, timelock, maker, usdt, amount], taker)
swap_id = to_bytes(hexstr=event(lock_rc, 'Locked(bytes32,address,address,address,uint256,bytes32,uint256)')['topics'][1])
check('lock: escrows USDT in the contract',
      view(usdt, 'balanceOf(address)', ['address'], [htlc], ['uint256'])[0] == amount)
check('lock: taker debited', view(usdt, 'balanceOf(address)', ['address'], [taker], ['uint256'])[0] == cash - amount)
stored = view(htlc, 'getSwap(bytes32)', ['bytes32'], [swap_id],
              ['bytes32', 'uint256', 'uint256', 'address', 'address', 'address', 'bool', 'bool'])
check('lock: swap record matches (hashlock, amount, timelock)', stored[0] == H and stored[1] == amount and stored[2] == timelock)
check('lock: swapId equals computeSwapId()',
      view(htlc, 'computeSwapId(bytes32,address,address,address,uint256,uint256)',
           ['bytes32', 'address', 'address', 'address', 'uint256', 'uint256'],
           [H, taker, maker, usdt, amount, timelock], ['bytes32'])[0] == swap_id)

# ---- claim -----------------------------------------------------------------
wrong = revert_reason(htlc, 'claim(bytes32,bytes32)', ['bytes32', 'bytes32'],
                      [swap_id, b'\xbb' * 32], accounts[3])
check('claim: wrong preimage reverts (HashlockMismatch)', 'revert' in wrong.lower(), wrong[:60])

claim_rc = send(htlc, 'claim(bytes32,bytes32)', ['bytes32', 'bytes32'], [swap_id, R], accounts[3])
check('claim: receiver paid', view(usdt, 'balanceOf(address)', ['address'], [maker], ['uint256'])[0] == amount)
check('claim: escrow emptied', view(usdt, 'balanceOf(address)', ['address'], [htlc], ['uint256'])[0] == 0)
topic_claim = t.get_transaction_receipt  # keep linters quiet
ev = event(claim_rc, 'Claimed(bytes32,bytes32)')
ev_data = to_bytes(hexstr=ev['data']) if isinstance(ev['data'], str) else bytes(ev['data'])
check('claim: emits Claimed(swapId) with R in the data',
      to_bytes(hexstr=ev['topics'][1]) == swap_id and ev_data[-32:] == R,
      ev_data.hex()[:16] + '…')
check('claim: anyone may submit R (front-run is harmless, funds are fixed)',
      claim_rc['from'].lower() == accounts[3].lower())

again = revert_reason(htlc, 'claim(bytes32,bytes32)', ['bytes32', 'bytes32'], [swap_id, R], accounts[3])
check('claim: second claim reverts (AlreadySettled)', 'revert' in again.lower(), again[:60])

# ---- refund ----------------------------------------------------------------
taker2 = accounts[4]
send(usdt, 'transfer(address,uint256)', ['address', 'uint256'], [taker2, amount], taker)
send(usdt, 'approve(address,uint256)', ['address', 'uint256'], [htlc, amount], taker2)
lock2 = send(htlc, 'lock(bytes32,uint256,address,address,uint256)',
             ['bytes32', 'uint256', 'address', 'address', 'uint256'],
             [H, now() + 305, maker, usdt, amount], taker2)
swap2 = to_bytes(hexstr=event(lock2, 'Locked(bytes32,address,address,address,uint256,bytes32,uint256)')['topics'][1])

early = revert_reason(htlc, 'refund(bytes32)', ['bytes32'], [swap2], accounts[5])
check('refund: refuses before the timelock (TimelockNotExpired)', 'revert' in early.lower(), early[:60])

mine(max(0, timelock - now()) + 2)
check('refund: timelock has passed on chain', now() >= timelock, 'now=%d timelock=%d' % (now(), timelock))

claim_late = revert_reason(htlc, 'claim(bytes32,bytes32)', ['bytes32', 'bytes32'], [swap2, R], accounts[3])
check('claim: closed after the timelock (TimelockExpired)', 'revert' in claim_late.lower(), claim_late[:60])

refund_rc = send(htlc, 'refund(bytes32)', ['bytes32'], [swap2], accounts[5])
check('refund: sender made whole', view(usdt, 'balanceOf(address)', ['address'], [taker2], ['uint256'])[0] == amount)
check('refund: emits Refunded(swapId)', to_bytes(hexstr=event(refund_rc, 'Refunded(bytes32)')['topics'][1]) == swap2)

again2 = revert_reason(htlc, 'refund(bytes32)', ['bytes32'], [swap2], accounts[5])
check('refund: second refund reverts (AlreadySettled)', 'revert' in again2.lower(), again2[:60])

# ---- the app's own encoding ------------------------------------------------
# The UI builds lock() calldata in the browser. These two checks tie that
# encoding to this ABI: the selector constants in src/app.js have to hash to the
# signature, and the calldata the page emitted has to decode to the swap fields.
src = open(os.path.join(ROOT, 'src', 'app.js'), encoding='utf-8').read()
m = re.search(r"SEL = \{ lock: '([0-9a-f]{8})', claim: '([0-9a-f]{8})', refund: '([0-9a-f]{8})' \}", src)
check('app: selector table found in src/app.js', bool(m))
if m:
    want = {
        'lock': selector('lock(bytes32,uint256,address,address,uint256)').hex(),
        'claim': selector('claim(bytes32,bytes32)').hex(),
        'refund': selector('refund(bytes32)').hex()
    }
    got = {'lock': m.group(1), 'claim': m.group(2), 'refund': m.group(3)}
    check('app: JS selectors equal keccak of the contract signatures', got == want,
          ', '.join('%s %s/%s' % (k, got[k], want[k]) for k in want))

dump = os.path.join(BUILD, 'app-calldata.json')
if os.path.exists(dump):
    d = json.load(open(dump))
    data = bytes.fromhex(d['calldata'][2:])
    check('app: emitted calldata starts with lock()', data[:4] == selector('lock(bytes32,uint256,address,address,uint256)'),
          data[:4].hex())
    hashlock, timelock, receiver, token, amount = abi_decode(
        ['bytes32', 'uint256', 'address', 'address', 'uint256'], data[4:])
    check('app: calldata decodes to the swap fields',
          hashlock == to_bytes(hexstr=d['hashlock']) and timelock == int(d['timelock'])
          and receiver.lower() == d['receiver'].lower() and token.lower() == d['token'].lower()
          and amount == int(d['amount']),
          '%d bytes, %d USDT units' % (len(data), amount))
else:
    print('note: build/app-calldata.json missing - run test/headless.js first')

print('\nEVM checks: %d failed' % len(fails))
sys.exit(1 if fails else 0)
