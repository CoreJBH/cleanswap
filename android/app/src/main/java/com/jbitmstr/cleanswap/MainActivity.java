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
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

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

    private static final String APP_URL = "file:///android_asset/index.html";
    private static final int BG = 0xFFF2F4F7;

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }

        web = new WebView(this);
        web.setBackgroundColor(BG);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new WebChromeClient());

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        // The page is a local file that talks to an https quote API: universal access from
        // file URLs lets fetch reach mempool.space without a local proxy.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }

        setContentView(web);
        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(APP_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
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
     * shell can actually display are left to it; anything else is a hand-off to another app.
     */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) {
            return false;
        }
        if (isAppScheme(uri.getScheme())) {
            return false;
        }
        return openInOtherApp(uri);
    }

    /** Schemes the WebView itself can render. Everything else belongs to another app. */
    private static boolean isAppScheme(String rawScheme) {
        String scheme = rawScheme == null ? "" : rawScheme.toLowerCase(Locale.ROOT);
        switch (scheme) {
            case "":
            case "http":
            case "https":
            case "file":
            case "data":
            case "about":
            case "javascript":
            case "blob":
            case "content":
                return true;
            default:
                return false;
        }
    }

    private boolean openInOtherApp(Uri uri) {
        String raw = uri.getScheme() == null ? "" : uri.getScheme();
        String scheme = raw.toLowerCase(Locale.ROOT);
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
