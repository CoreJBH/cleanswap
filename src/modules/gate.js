  /* gate.js - the one gate a tap has to pass */
  /* ----------------------------------------------------------- one gate --- */
  /* The gate runs on the chain's clock as well as the phone's: a window the
     chain says has run out has run out, whatever this phone believes the time
     to be. One reading serves every check for 45 seconds. */
  function validate() {
    return syncChainTime().then(validateNow);
  }
  function validateNow() {
    if (S.phase === 'settled') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'You received ' + usdtTxt() + ' USDT' + (S.mode === 'wallet' ? ' on ' + curChain().label : '') + '.'
        : 'You received ' + fmt(S.sats) + ' sats.'));
    }
    if (S.phase === 'refunded') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'The USDT went back to your partner.'
        : 'Your ' + usdtTxt() + ' USDT came back to you.'));
    }
    if (S.phase === 'paying') {
      return Promise.resolve(good(S.direction === 'btc2u'
        ? 'Tap I paid once the sats have left your wallet.'
        : 'Tap I paid once the USDT has been sent.'));
    }
    if (S.phase === 'paid') {
      return Promise.resolve(good('Your side is locked. Check the chain, or leave it watching.'));
    }
    if (S.phase === 'locking') {
      return Promise.resolve(good('Send the one call that puts your USDT in the escrow.'));
    }
    var sendBtc = S.direction === 'btc2u';
    var inv = readInvoice(pasted());
    var ad = readAddress(addrIn());
    var invMsg = inv.ok ? '' : (inv.code === 'empty'
      ? (sendBtc ? "Paste the invoice your partner sends." : 'Paste your own invoice so the other side can pay you.')
      : inv.msg);
    var adMsg = ad.ok ? '' : (ad.code === 'empty'
      ? (sendBtc ? 'Add the USDT address that should receive your USDT.' : "Add your partner's USDT address.")
      : ad.msg);
    if (inv.ok && ad.ok) {
      /* Wallet mode moves the USDT in a contract, so a swap with no contract
         set has nowhere to lock: the third step says that, not "ready". */
      if (S.mode === 'wallet' && !isAddr(S.contract)) {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'One thing first: set the escrow contract for ' + curChain().label + '.',
          fields: { invoice: inv, address: ad }
        });
      }
      if (S.mode === 'wallet' && !isAddr(tokenNow())) {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'Add the USDT token for ' + curChain().label + ' in Setup.',
          fields: { invoice: inv, address: ad }
        });
      }
      /* The token was read and it is not one this page can count in: a token
         that does not count in six decimals would move an amount other than
         the one the screen says, so nothing is approved against it. */
      if (S.mode === 'wallet' && S.tokenState === 'wrong') {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: 'The token set in Setup is not a 6-decimal token, so this swap cannot count with it. Set the right token in Setup.',
          fields: { invoice: inv, address: ad }
        });
      }
      /* And the token has to have been read by the chain at all. A token the
         chain never confirmed is not a token this page counts in: 'not read'
         and 'not understood' are both silence, and silence is not a yes. */
      if (S.mode === 'wallet' && S.tokenState !== 'ok') {
        return Promise.resolve({
          ok: false, code: 'setup', field: 'go',
          msg: S.tokenState === 'unread'
            ? 'The chain did not answer about the USDT token in Setup, so nothing is approved. Check the setup and tap Approve again.'
            : 'The USDT token in Setup has not been read yet, so nothing is approved. Tap Approve again in a moment.',
          fields: { invoice: inv, address: ad }
        });
      }
      /* Zero is not an amount. Before the quote lands there is no USDT figure
         at all, and a tap in that window would lock a swap with nothing in
         it - the escrow would take it and the bitcoin would buy 0 USDT. */
      if (!(Number(usdtUnits()) > 0)) {
        return Promise.resolve({ ok: false, code: 'rate', field: 'go',
          msg: 'The rate has not loaded yet, so the USDT amount would be zero. Tap Approve again in a moment.',
          fields: { invoice: inv, address: ad } });
      }
      /* A wallet swap moves real USDT, and the amount is the one the live quote
         prices. Without that quote the figure is this page's own guess, and a
         lock built on a guess hands the other side an amount nobody quoted.
         Practice rehearses on a stand-in and keeps running. */
      if (quoteMissing()) {
        return Promise.resolve({ ok: false, code: 'rate', field: 'go',
          msg: 'The live BTC price has not arrived, so this swap would lock USDT at a guessed amount. Tap Approve again once the rate line is live.',
          fields: { invoice: inv, address: ad } });
      }
      /* The escrow window has to leave room to pay and claim, and the invoice
         has to outlive it. A code that names five minutes, or years, stops
         here - before any button can approve it. */
      var wp = windowProblem(inv.dec, S.t2);
      if (wp) {
        return Promise.resolve({ ok: false, code: 'window', field: 'invoice', msg: wp,
          fields: { invoice: inv, address: ad } });
      }
      /* The swap id names the address that funds the escrow. On the side that
         receives the USDT that address is the partner's, and this side can only
         check the lock once the partner has said it. */
      if (S.mode === 'wallet' && sendBtc && !isAddr(lockerNow())) {
        return Promise.resolve({ ok: false, code: 'locker', field: 'go',
          msg: 'Ask your partner for the code they made after their wallet was connected, or paste the transaction that locked the USDT.',
          fields: { invoice: inv, address: ad } });
      }
      return Promise.resolve(good(sendBtc
        ? 'Both sides are ready. Approve ties both legs to one secret.'
        : 'Both sides are ready. Approve puts your USDT in the escrow.',
        { dec: inv.dec, H: inv.H, basis: inv.basis, address: ad.address, inv: String(pasted()) }));
    }
    // the sentence names the first thing missing, in the order the steps are on screen
    var miss = sendBtc
      ? (inv.ok ? { code: ad.code, msg: adMsg, field: 'address' } : { code: inv.code, msg: invMsg, field: 'invoice' })
      : (ad.ok ? { code: inv.code, msg: invMsg, field: 'invoice' } : { code: ad.code, msg: adMsg, field: 'address' });
    return Promise.resolve({
      ok: false, code: miss.code, msg: miss.msg, field: miss.field,
      fields: { invoice: inv, address: ad }
    });
  }

  function gateSentence() {
    var r = S.gate;
    if (!r) return 'Fill in the two steps, then tap Approve.';
    return r.msg;
  }
