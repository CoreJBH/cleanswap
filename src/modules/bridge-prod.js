  /* What this page leaves on the window: one entry, and it is the one the host
     shell needs - `acceptCode`, to hand a swap code over from another app.

     Nothing else crosses this line in a shipped build. The state object, the
     actions a button calls and the helpers behind them all stay inside the
     closure, so a script from anywhere on the page - or from a webview that
     loaded this document - cannot read the swap's terms, change its phase or
     drive a claim by reaching for a name on `window`. A test build adds the
     handle the verification suites use, and only a test build; see
     bridge-test.js. */
  window.CLEANSWAP = { acceptCode: acceptCode };
