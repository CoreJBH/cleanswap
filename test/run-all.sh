#!/usr/bin/env bash
# Build the single-file app and run every verification suite.
# Env overrides: NODE, PLAYWRIGHT_PKG, LD_LIBRARY_PATH, SOLC
set -uo pipefail
cd "$(dirname "$0")/.."

NODE="${NODE:-/workspace/.local/lib/python3.12/site-packages/playwright/driver/node}"
export PLAYWRIGHT_PKG="${PLAYWRIGHT_PKG:-/workspace/.local/lib/python3.12/site-packages/playwright/driver/package}"
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-/workspace/tmp/sysroot/usr/lib/x86_64-linux-gnu}"
PY="${PYTHONPATH:-.tools/py}"

fail=0

echo "== build =="
python3 build.py || exit 1

echo
echo "== headless UI + protocol suite =="
"$NODE" test/headless.js || fail=1

echo
echo "== contract on a real EVM (py-evm) =="
if command -v python3 >/dev/null; then
  PYTHONPATH="$PY" python3 test/contract-evm.py || fail=1
fi

echo
echo "== QR encoder cross-check =="
PYTHONPATH="$PY" NODE="$NODE" python3 test/qr-crosscheck.py || fail=1

echo
if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit "$fail"
