#!/usr/bin/env python3
"""Check the Android shell's own guarantees, by reading its source.

The WebView is the app; the shell around it decides what the system may keep,
what the page may open, and what it may serve itself. Those are few lines of Java
and XML, and each one is a promise worth a test:

  * FLAG_SECURE, so the swap screen is not in a screenshot or the recents list
  * no WebView cache, and what it held is dropped with the screen
  * no instance state: a recreated screen starts from the form, never from a Bundle
  * /index.html over https is the only document served from the APK
  * the app host is only a page under https, and mixed content is never allowed
  * https hand-offs go to a named list of hosts, not to anywhere
  * cleartext traffic is off in the manifest, and the network security config
    allows plain HTTP to the loopback only
  * a release APK is signed with the release key or not built at all

    python3 test/android-shell.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JAVA = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'jbitmstr', 'cleanswap', 'MainActivity.java')
MANIFEST = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
NSC = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml')
GRADLE = os.path.join(ROOT, 'android', 'app', 'build.gradle.kts')
# The workflow GitHub actually runs lives here, and it is the signed-release
# one. android/ci/apk-release.yml is a byte-for-byte copy kept in the tree
# because a push from the app cannot write .github/workflows/; the two are
# compared below, so the copy cannot drift from the workflow that runs.
CI = os.path.join(ROOT, 'android', 'ci', 'apk-release.yml')
CI_LIVE = os.path.join(ROOT, '.github', 'workflows', 'apk.yml')

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
    gradle = open(GRADLE, encoding='utf-8').read()
    ci = open(CI, encoding='utf-8').read()

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

    # --- a recreated screen starts from the form --------------------------
    check('shell: the WebView is never saved into the instance state',
          'saveState(' not in java, 'saveState' in java)
    check('shell: and never restored from it', 'restoreState(' not in java, 'restoreState' in java)
    check('shell: the screen always loads the app document',
          'web.loadUrl(APP_URL);' in on_create)

    # --- the app host is a page only under https --------------------------
    navigation = body_of(java, 'private boolean handleNavigation(')
    check('shell: the app host is only ours under https',
          'APP_HOST.equalsIgnoreCase' in navigation and
          re.search(r'!\"https\"\.equalsIgnoreCase', navigation) is not None,
          navigation.count('https'))
    mixed = re.search(r'setMixedContentMode\(\s*WebSettings\.MIXED_CONTENT_NEVER_ALLOW\s*\)', java)
    check('shell: mixed content is never allowed, said out loud', mixed is not None)
    check('shell: the setting is on the page\'s own WebSettings',
          'WebSettings.MIXED_CONTENT_ALWAYS_ALLOW' not in java and 'setMixedContentMode' in on_create)

    # --- one document, from the APK, at one address ------------------------
    intercept = body_of(java, 'public WebResourceResponse shouldInterceptRequest(')
    check('shell: only an https request is answered from the APK',
          re.search(r'!"https"\.equalsIgnoreCase', intercept) is not None, intercept.count('https'))
    check('shell: only the app host is answered', 'APP_HOST.equalsIgnoreCase' in intercept)
    check('shell: only the /index.html path is answered',
          '"/index.html".equals' in intercept and 'getPath()' in intercept)
    check('shell: any other path on that host is refused with an empty 404',
          'setStatusCodeAndReasonPhrase(404' in intercept and 'ByteArrayInputStream' in intercept,
          intercept.count('404'))
    check('shell: the 404 is answered inside the app host, not left to the network',
          'if (!"/index.html".equals' in intercept
          and intercept.index('setStatusCodeAndReasonPhrase(404') > intercept.index('getPath()'),
          'the deny answers after the host check')
    # --- the page is ready when the app document, not any page, finishes ---
    finished = body_of(java, 'public void onPageFinished(')
    check('shell: the page is marked ready only for the app document',
          'APP_URL.equals(url)' in finished, finished.count('pageReady'))
    check('shell: and a code is delivered only on that page',
          'deliverCode();' in finished and 'pageReady = true' in finished)

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

    # --- cleartext: refused everywhere but this phone itself ---------------
    nsc = open(NSC, encoding='utf-8').read()
    check('shell: a network security config exists and is wired into the manifest',
          'android:networkSecurityConfig="@xml/network_security_config"' in manifest)
    check('shell: cleartext is refused for every host by default',
          re.search(r'<base-config[^>]*cleartextTrafficPermitted="false"', nsc) is not None)
    dc = re.search(r'<domain-config[^>]*cleartextTrafficPermitted="true"\s*>(.*?)</domain-config>', nsc, re.S)
    domains = re.findall(r'<domain[^>]*>([^<]+)</domain>', dc.group(1)) if dc else []
    check('shell: plain HTTP is allowed only to the loopback names, without subdomains',
          dc is not None and set(domains) == {'localhost', '127.0.0.1'}
          and 'includeSubdomains="false"' in dc.group(1)
          and '*' not in nsc.split('<domain-config')[1] if dc else False,
          ', '.join(domains))

    # --- release signing: the release key, or no release ------------------
    check('gradle: the release key is read from the environment or keystore.properties',
          'CLEANSWAP_KEYSTORE' in gradle and 'keystore.properties' in gradle)
    check('gradle: a release task without the key stops instead of building',
          'releasePackagingTasks' in gradle and 'throw GradleException' in gradle)
    check('gradle: the gate does not touch debug builds or the tests',
          'if (asked.isEmpty() || hasReleaseSigning) return@whenReady' in gradle)
    check('gradle: the release build type uses the release signature when it exists',
          'if (hasReleaseSigning)' in gradle and 'signingConfigs.getByName("release")' in gradle)
    check('gradle: a release APK is minified, shrunk and never debuggable',
          'isMinifyEnabled = true' in gradle and 'isShrinkResources = true' in gradle
          and 'isDebuggable = false' in gradle)

    # --- the workflow this repository maintains ------------------------------
    # GitHub reads .github/workflows/apk.yml, and the app's automation has no
    # `workflows` permission: a push touching that path is refused. So the file
    # this repository maintains and can change is android/ci/apk-release.yml,
    # and the live one is compared with it below instead of being assumed.
    check('ci: it runs on a push to main, on tags and by hand',
          'branches: [main]' in ci and 'tags: ["v*"]' in ci and 'workflow_dispatch' in ci)
    check('ci: it builds the page from source and stages it into the APK',
          'python3 build.py' in ci and 'assets/index.html' in ci)
    check('ci: it uploads the APK, and a run without one fails',
          'upload-artifact' in ci and 'cleanswap.apk' in ci and 'if-no-files-found: error' in ci)
    check('ci: every working-directory line has its value after a space',
          'working-directory:android' not in ci and 'working-directory: android' in ci)
    # The one thing this file builds is the signed release.
    check('ci: it assembles the release variant', 'assembleRelease' in ci)
    check('ci: nothing in it assembles a debug APK', 'assembleDebug' not in ci,
          'assembleRelease only' if 'assembleRelease' in ci else 'no assemble task')
    check('ci: the APK is collected from the release folder only',
          'outputs/apk/release' in ci and 'outputs/apk/debug' not in ci)
    check('ci: a run whose keystore secret is missing stops before any APK exists',
          'CLEANSWAP_KEYSTORE_BASE64' in ci and 'is not set' in ci and 'exit 1' in ci)
    check('ci: it verifies the release signature before the APK goes up', 'apksigner' in ci)
    # What it runs is pinned: a tag can be moved, a commit SHA cannot.
    uses = re.findall(r'^\s*-?\s*uses:\s*(\S+)', ci, re.M)
    unpinned = [u for u in uses if not re.match(r'^[\w.-]+/[\w.-]+(/[\w.-]+)?@[0-9a-f]{40}$', u)]
    check('ci: every action it runs is pinned to a full commit SHA',
          bool(uses) and not unpinned, ', '.join(uses) if not unpinned else ', '.join(unpinned))
    check('ci: every pinned SHA says which release it came from',
          all(re.search(r'uses:\s*' + re.escape(u) + r'\s+#\s*v\d', ci) for u in uses if '@' in u),
          ', '.join(uses))

    # --- and what GitHub actually reads, when this checkout has it ----------
    live = open(CI_LIVE, encoding='utf-8').read() if os.path.exists(CI_LIVE) else ''
    if live == ci:
        check('ci: the workflow GitHub reads is this file, byte for byte', True, 'identical')
    elif not live:
        print('NOTE .github/workflows/apk.yml is not in this checkout. GitHub runs whatever is'
              ' there; android/ci/apk-release.yml is the file to paste into it.')
    else:
        debug = 'assembleDebug' in live
        print('NOTE .github/workflows/apk.yml differs from android/ci/apk-release.yml'
              + (' and still assembles a debug APK' if debug else '')
              + ": the app's automation cannot write workflows, so the signed-release file has to be"
              ' pasted over it by hand (or the GitHub App given the workflows permission).'
              ' Until then GitHub builds what that file says.')

    print('%d/%d shell checks passed' % (CHECKS[0] - len(fails), CHECKS[0]))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
