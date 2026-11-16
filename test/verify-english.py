#!/usr/bin/env python3
"""Fail if any text file in the repository - or any commit message - contains Hangul.

CLEANSWAP is an English-only repository: source, tests, README, Android resources,
build scripts and the built page. This is the gate that keeps it that way.

    python3 test/verify-english.py            # tracked files + full commit history
    python3 test/verify-english.py --quiet

Exit code 0 means zero Hangul characters. Binary files (NUL bytes) and files that
are not UTF-8 are skipped; file names are checked too.
"""
import os
import re
import subprocess
import sys

HANGUL = re.compile(r'[\uac00-\ud7af]')            # precomposed syllables
JAMO = re.compile(r'[\u1100-\u11ff\u3130-\u318f]')  # conjoining / compatibility jamo
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = ('.git', '.tools', 'build', 'node_modules', '__pycache__', 'shots', '.scratch')


def tracked_files():
    out = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True)
    if out.returncode != 0:
        sys.exit('git ls-files failed - run this inside the repository')
    return [p for p in out.stdout.decode('utf-8').split('\0') if p]


def read_text(path):
    try:
        with open(os.path.join(ROOT, path), 'rb') as f:
            data = f.read()
    except OSError:
        return None
    if b'\x00' in data:          # binary: png, apk, object files
        return None
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return None


def scan():
    hits = []
    files = 0
    for path in tracked_files():
        if any(part in SKIP_DIRS for part in path.split('/')):
            continue
        if HANGUL.search(path) or JAMO.search(path):
            hits.append((path + ' (file name)', 1, 'Hangul in the path'))
        text = read_text(path)
        if text is None:
            continue
        files += 1
        found = HANGUL.findall(text) + JAMO.findall(text)
        if found:
            first = HANGUL.search(text) or JAMO.search(text)
            line = text[:first.start()].count('\n') + 1
            snippet = text.splitlines()[line - 1][:120]
            hits.append((path, len(found), 'line %d: %s' % (line, snippet)))
    return files, hits


def scan_commits():
    out = subprocess.run(['git', 'log', '--format=%H%x09%s%x09%b'], cwd=ROOT, capture_output=True, text=True)
    hits = []
    count = 0
    for line in out.stdout.splitlines():
        if not line.strip():
            continue
        count += 1
        if HANGUL.search(line) or JAMO.search(line):
            hits.append((line.split('\t')[0][:12] + ' (commit message)', len(HANGUL.findall(line)), line[:120]))
    return count, hits


def main():
    quiet = '--quiet' in sys.argv
    files, hits = scan()
    commits, commit_hits = scan_commits()
    all_hits = hits + commit_hits
    total = sum(n for _, n, _ in all_hits)
    if not quiet:
        print('scanned %d text files and %d commit messages' % (files, commits))
    for path, n, detail in all_hits:
        print('FAIL %s: %d Hangul character(s) - %s' % (path, n, detail))
    if all_hits:
        print('\n%d Hangul characters in %d place(s). The repository must be English only.' % (total, len(all_hits)))
        return 1
    print('Hangul characters: 0 in %d files and %d commits - English only' % (files, commits))
    return 0


if __name__ == '__main__':
    sys.exit(main())
