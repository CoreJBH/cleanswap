  /* boot.js - wiring the page and starting it */
  /* ---------------------------------------------------------------- boot -- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    var fn = ACT[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b); }
  });

  // A blank wallet link would open a wallet on nothing: say what is missing
  // instead. A rehearsal has no wallet to hand anything to, and its invoice is
  // a sample, so it keeps the hand-off on the phone.
  function walletHandoff(e) {
    if (S.mode === 'practice') {
      e.preventDefault();
      toast('Practice keeps this on the phone: no wallet opens.');
      return;
    }
    var ok = e.currentTarget.id === 'payWalletLink' ? !!S.inv : readInvoice(pasted()).ok;
    if (!ok) { e.preventDefault(); needInvoice(); }
  }
  ['walletLink', 'payWalletLink'].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('click', walletHandoff);
  });

  [invIn(), addrEl(), $('codeIn'), $('secretIn')].forEach(function (el) {
    if (!el) return;
    el.addEventListener('input', function () { render(); refreshGate(); });
  });

  loadSetup();
  /* A wallet swap that was running when the page died comes back in the mode
     it was running in: the record is read before the first paint, so the phone
     opens on the swap instead of on an empty form, and the terms are the ones
     the money was locked under rather than a stranger's guess. */
  var back = readSwapMeta();
  if (back && swapMetaFits(back) && back.net === S.net &&
    String(back.contract || '').toLowerCase() === String(S.contract || '').toLowerCase()) S.mode = 'wallet';
  render();
  refreshGate();
  presetsOn();
  loadRate();
  /* Wallet mode is the only mode a swap can outlive the page in, and the setup
     has just said which escrow this phone is pointed at. A swap it was in the
     middle of comes back before anything else asks the chain, and the code in
     the address bar is read after it: a running swap refuses a code, which is
     what it did before the page died too. */
  if (S.mode === 'wallet') resumeSwap();
  if (S.mode === 'wallet' && isAddr(S.contract)) chainProbe();

  // A code can arrive in the address bar of a hosted copy, or from the app
  // shell when another app hands it over. Nothing here is ever generated.
  var fromUrl = parseSwapLink(String(location.search) + ' ' + String(location.hash));
  if (fromUrl) acceptCode(String(location.search) + ' ' + String(location.hash));
