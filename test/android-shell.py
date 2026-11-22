#!/usr/bin/env python3
"""Check the Android shell's own guarantees, by reading its source.

The WebView is the app; the shell around it decides what the system may keep,
what the page may open, and what it may serve itself. Those are few lines of Java
and XML, and each one is a promise worth a test:

  * FLAG_SECURE, so the swap screen is not in a screenshot or the recents list
  * no WebView cache, and what it held is dropped with the screen
  * /index.html over https is the only document served from the APK
  * https hand-offs go to a named list of hosts, not to anywhere
  * cleartext traffic is off in the manifest

    python3 test/android-shell.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JAVA = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'jbitmstr', 'cleanswap', 'MainActivity.java')
MANIFEST = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')

fails = []
CHECKS = [0]


def check(name, ok, detail=''):
    CHECKS[0] += 1
    print(('PASS ' if ok else 'FAIL ') + name + (('   [' + str(detail) + ']') if detail else ''))
    if not ok:
        fails.append(name)


def body_of(src, signature):
    """The text of one Java method, from its signature to the matching brace."""
    start = src.index(signature)
    i = src.index('{', start)
    depth = 0
    for j in range(i, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
    return ''


def main():
    java = open(JAVA, encoding='utf-8').read()
    manifest = open(MANIFEST, encoding='utf-8').read()

    # --- the screen stays off other people's screens -----------------------
    on_create = body_of(java, 'protected void onCreate(')
    check('shell: FLAG_SECURE is set when the activity is created',
          'FLAG_SECURE' in on_create and 'setFlags' in on_create, on_create.count('FLAG_SECURE'))
    check('shell: it is the window manager flag, not a local constant',
          'WindowManager.LayoutParams.FLAG_SECURE' in java and 'import android.view.WindowManager;' in java)

    # --- nothing of a swap is kept on disk by the WebView -------------------
    check('shell: the WebView cache is switched off', 'LOAD_NO_CACHE' in java, 'LOAD_DEFAULT' in java)
    check('shell: the default cache mode is gone', 'LOAD_DEFAULT' not in java)
    on_destroy = body_of(java, 'protected void onDestroy()')
    check('shell: the cache is cleared and the history dropped when the screen goes',
          'clearCache(true)' in on_destroy and 'clearHistory()' in on_destroy,
          on_destroy.count('clear'))

    # --- one document, from the APK, at one address ------------------------
    intercept = body_of(java, 'public WebResourceResponse shouldInterceptRequest(')
    check('shell: only an https request is answered from the APK',
          re.search(r'!"https"\.equalsIgnoreCase', intercept) is not None, intercept.count('https'))
    check('shell: only the app host is answered', 'APP_HOST.equalsIgnoreCase' in intercept)
    check('shell: only the /index.html path is answered',
          '"/index.html".equals' in intercept and 'getPath()' in intercept)

    # --- https hand-offs go to named hosts ---------------------------------
    hosts = re.search(r'HTTPS_HOSTS\s*=\s*\{([^}]*)\}', java)
    named = set(re.findall(r'"([^"]+)"', hosts.group(1))) if hosts else set()
    check('shell: an https allowlist exists', bool(named), ', '.join(sorted(named)))
    check('shell: it names the deploy page and both explorers',
          {'remix.ethereum.org', 'arbiscan.io', 'sepolia.arbiscan.io'} <= named, ', '.join(sorted(named)))
    open_app = body_of(java, 'private boolean openInOtherApp(')
    check('shell: an https link outside that list never opens',
          'isAllowedHttpsHost' in open_app and 'return true' in open_app)
    check('shell: the host check compares whole lower-cased hosts',
          'toLowerCase(Locale.ROOT)' in body_of(java, 'private static boolean isAllowedHttpsHost('))
    check('shell: no wildcard or empty entry in the allowlist',
          all(h and '*' not in h and '/' not in h for h in named), ', '.join(sorted(named)))
    schemes = re.search(r'HANDOFF_SCHEMES\s*=\s*\{([^}]*)\}', java)
    handed = set(re.findall(r'"([^"]+)"', schemes.group(1))) if schemes else set()
    check('shell: only the wallet schemes and https leave the app',
          handed == {'lightning', 'bitcoin', 'ethereum', 'https'}, ', '.join(sorted(handed)))

    # --- the manifest --------------------------------------------------
    check('shell: cleartext traffic is off in the manifest',
          'android:usesCleartextTraffic="false"' in manifest)
    check('shell: no backup of the app data', 'android:allowBackup="false"' in manifest)

    print('%d/%d shell checks passed' % (CHECKS[0] - len(fails), CHECKS[0]))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
