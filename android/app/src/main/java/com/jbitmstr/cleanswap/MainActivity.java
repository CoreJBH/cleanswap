package com.jbitmstr.cleanswap;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * The whole application is one HTML file (assets/index.html) built from src/ by build.py.
 * This shell gives it a full-screen, light, dependency-free WebView: no local server and no
 * permission beyond the optional BTC/USD quote the page itself requests.
 *
 * The page is the prototype: the practice sandbox works offline, and the wallet hand-off
 * (lightning: links, QR, clipboard) leaves the WebView for whichever wallet app is installed.
 * That hand-off is the shell's job: the WebView cannot load a scheme it does not own, so a
 * lightning: link has to become an ACTION_VIEW intent instead of a navigation.
 */
public class MainActivity extends Activity {

    /* The page itself lives in the APK, served to the WebView from a made-up
       https origin that only this class answers. Nothing is ever fetched from a
       real host for it, and the page is not a file:// document: an https origin
       means ordinary CORS and no universal file access (the setting that lets
       a local page reach every site is off). The only thing that travels
       between two people is a cleanswap:... code. */
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/index.html";
    private static final String CODE_SCHEME = "cleanswap";
    private static final int BG = 0xFF08100E;

    private WebView web;
    private boolean pageReady;
    private String pendingCode;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        /* Nothing on this screen belongs in a screenshot, a screen recording or
           the thumbnail the recent-apps switcher keeps: an invoice, a USDT
           address and a running swap are all on it. */
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        pendingCode = codeFrom(getIntent());

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new WebChromeClient());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // The page is served from the app's own https origin, so it needs no file access at
        // all; a page that cannot read files cannot be tricked into reading one.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        /* The page is one file in the APK and its bytes are the app: a cached
           copy is a stale swap screen at best. Nothing is read from a cache. */
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setSaveFormData(false);
        /* The page is served from the app's own https origin, so nothing it
           loads may arrive over plain http: a mixed-content load would put a
           document that is not the app's own next to its terms, and a network
           in between would be able to write it. */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        setContentView(web);
        /* The screen always starts from the form. The WebView is deliberately
           never saved into the instance state and never restored from it: what
           the page holds - an invoice, a USDT address, a running swap with its
           secret - would then sit in a Bundle that the system writes out for a
           process that may come back much later. A recreated screen asks again
           instead of reading back what it had. */
        web.loadUrl(APP_URL);
        deliverCode();
    }

    /**
     * A cleanswap:... code arriving from another app (a scanner, a message, the
     * camera) is handed to the page, which takes the other side of those terms.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String code = codeFrom(intent);
        if (code != null) {
            pendingCode = code;
            deliverCode();
        }
    }

    private void deliverCode() {
        if (!pageReady || pendingCode == null || web == null) {
            return;
        }
        String code = pendingCode;
        pendingCode = null;
        web.evaluateJavascript(
                "window.CLEANSWAP && window.CLEANSWAP.acceptCode(" + jsString(code) + ")", null);
    }

    private static String codeFrom(Intent intent) {
        if (intent == null) {
            return null;
        }
        Uri data = intent.getData();
        if (data == null) {
            return null;
        }
        String raw = data.toString();
        if (raw == null || !raw.toLowerCase(Locale.ROOT).startsWith(CODE_SCHEME + ":")) {
            return null;
        }
        return raw;
    }

    /** A JavaScript string literal, quoted by the platform rather than by hand: it escapes
        newlines, quotes, backslashes and the line separators an intent can carry. */
    private static String jsString(String s) {
        return JSONObject.quote(s);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (web != null) {
            web.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            // Whatever the WebView held of a swap goes when the screen does.
            web.clearCache(true);
            web.clearHistory();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * Keeps the app's own pages inside the WebView and hands every other scheme
     * (lightning:, LIGHTNING:, bitcoin:, mailto:, tel:, ...) to an app that declares it.
     *
     * Without this the "Open in wallet" link is treated as a page load, the WebView finds no
     * handler of its own and shows ERR_UNKNOWN_URL_SCHEME (lightning:) instead of the wallet.
     */
    private final class ShellClient extends WebViewClient {

        @Override
        public void onPageFinished(WebView view, String url) {
            /* Ready means the one document that is this app has finished, not
               any page that happened to finish: a code is only handed to the
               page when the page is the app, so a failed or foreign finish
               cannot consume a pending code. */
            if (APP_URL.equals(url)) {
                pageReady = true;
                deliverCode();
            }
        }

        /**
         * The app's origin is this class, not the network: the one asset in the APK is
         * handed to the WebView here. Every other request (the quote, the chain) is a
         * normal same-origin https request and goes out untouched.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request == null ? null : request.getUrl();
            /* Exactly one document is answered from the APK: https, this app's
               own host, and the one path the shell loads. Another scheme, or
               another path on the same host, is not a page of this app: it is
               answered with an empty 404 here, inside the app's own origin,
               rather than left to fall through to the network - nothing on a
               real host can be pulled in under this origin. */
            if (uri == null
                    || !"https".equalsIgnoreCase(String.valueOf(uri.getScheme()))
                    || !APP_HOST.equalsIgnoreCase(String.valueOf(uri.getHost()))) {
                return null;
            }
            if (!"/index.html".equals(String.valueOf(uri.getPath()))) {
                WebResourceResponse notFound = new WebResourceResponse(
                        "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                notFound.setStatusCodeAndReasonPhrase(404, "Not Found");
                return notFound;
            }
            try {
                InputStream in = getAssets().open("index.html");
                return new WebResourceResponse("text/html", "utf-8", in);
            } catch (IOException missing) {
                WebResourceResponse gone = new WebResourceResponse(
                        "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                gone.setStatusCodeAndReasonPhrase(404, "Not Found");
                return gone;
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url));
        }
    }

    /**
     * Returns true when the navigation was taken away from the WebView. Only the schemes the
     * shell can actually display are left to it; anything else is either handed to another
     * app from {@link #HANDOFF_SCHEMES} or refused.
     */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) {
            return false;
        }
        // A page of this app stays here; every other host and scheme belongs to another app.
        // The app's own page is one https document, so this host under any other scheme is
        // not that page either: it is refused instead of being loaded or handed on.
        if (APP_HOST.equalsIgnoreCase(String.valueOf(uri.getHost()))) {
            return !"https".equalsIgnoreCase(String.valueOf(uri.getScheme()));
        }
        if (isLocalScheme(uri.getScheme())) {
            return false;
        }
        return openInOtherApp(uri);
    }

    /** Schemes that never leave the phone's own app surface. `data:` and `blob:` are not
        among them: a page that can name such a document could otherwise show it in place of
        the app's own screen, and nothing in this page ever needs one. */
    private static boolean isLocalScheme(String rawScheme) {
        String scheme = rawScheme == null ? "" : rawScheme.toLowerCase(Locale.ROOT);
        return scheme.isEmpty() || scheme.equals("about");
    }

    /** The only schemes this shell hands to another app. The page asks for exactly these
        three wallet schemes and https; anything else stays here and is refused, so a page
        cannot use an intent to reach an app the person never asked for. */
    private static final String[] HANDOFF_SCHEMES = {"lightning", "bitcoin", "ethereum", "https"};

    /** https is the one scheme that could reach anything at all, so it is narrowed to the
        hosts this app actually offers: the deploy page, the two block explorers and the
        price feed. Any other https address is refused here and stays something the person
        can open in their own browser. */
    private static final String[] HTTPS_HOSTS = {
            "remix.ethereum.org", "arbiscan.io", "sepolia.arbiscan.io", "mempool.space"
    };

    private static boolean isHandoffScheme(String scheme) {
        for (String allowed : HANDOFF_SCHEMES) {
            if (allowed.equals(scheme)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isAllowedHttpsHost(String host) {
        String h = host == null ? "" : host.toLowerCase(Locale.ROOT);
        for (String allowed : HTTPS_HOSTS) {
            if (allowed.equals(h)) {
                return true;
            }
        }
        return false;
    }

    private boolean openInOtherApp(Uri uri) {
        String raw = uri.getScheme() == null ? "" : uri.getScheme();
        String scheme = raw.toLowerCase(Locale.ROOT);
        if (!isHandoffScheme(scheme)) {
            Toast.makeText(this, "This app does not open " + label(scheme) + ".", Toast.LENGTH_LONG).show();
            return true;
        }
        if (scheme.equals("https") && !isAllowedHttpsHost(uri.getHost())) {
            String host = uri.getHost() == null ? "that address" : uri.getHost();
            Toast.makeText(this, "This app does not open " + host + ".", Toast.LENGTH_LONG).show();
            return true;
        }
        // Intent filters match the scheme case-sensitively, and a pasted or QR-read link may
        // arrive as LIGHTNING:. Hand off the lower-cased form the wallets declare.
        Uri target = raw.equals(scheme) ? uri : uri.buildUpon().scheme(scheme).build();
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, target));
        } catch (ActivityNotFoundException notFound) {
            // No wallet (or other app) claims this scheme. Say so instead of crashing or
            // leaving the user on a blank error page.
            Toast.makeText(this, missingAppMessage(scheme), Toast.LENGTH_LONG).show();
        } catch (SecurityException blocked) {
            Toast.makeText(this, "This device blocks " + label(scheme) + ".", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    private static String missingAppMessage(String scheme) {
        if (scheme.startsWith("lightning") || scheme.equals("bitcoin")) {
            return "No Lightning wallet app found. Install one (Phoenix, Breez, Zeus, "
                    + "Wallet of Satoshi), then tap again.";
        }
        return "No app found to open " + label(scheme) + ".";
    }

    private static String label(String scheme) {
        return scheme.isEmpty() ? "this link" : scheme + ": links";
    }
}
