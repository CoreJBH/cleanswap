  /* actions.js - what a tap does, the rehearsal escrow, codes arriving and the QR */
  /* ------------------------------------------------------------ actions -- */
  function logSwap(r) {
    log('INVOICE', 'payment hash ' + short(r.H, 8) + ' \u00b7 ' + fmt(S.sats) + ' sats');
    log('USDT', 'escrow pays ' + usdtTxt() + ' USDT to ' + short(r.address, 6));
    log('TIMELOCK', 'T2 unix ' + S.t2 + ' \u00b7 funds from ' + short(lockerNow() || '\u2014', 6) +
      ' \u00b7 invoice ends ' + (invoiceExpiry(r.dec) == null ? 'never' : clock(invoiceExpiry(r.dec))));
  }

  /* Approve puts the terms of a swap together in steps: the window first, then
     the invoice, the address and the amount, and only then does it ask the
     chain. A refusal in the middle would otherwise leave half a swap behind: a
     window with nothing locked under it, an amount with no invoice, a hash no
     invoice names - and the next tap would build its swap on those leftovers.
     Everything the refused tap had put together is dropped here, so a swap
     that never started leaves no terms of its own. The terms a code brought
     stay: the partner's sats, the window the code named and the hash it pinned
     are not this tap's doing, and Back is what clears those. */
  function dropSwapTerms() {
    S.t1 = null; S.t2 = null;
    S.units = null; S.inv = ''; S.invDec = null;
    S.addr = ''; S.H = null; S.basis = null;
    log('RESET', 'the refused tap left no swap terms behind');
  }
  /* The token in Setup is read from the chain before an amount is built from
     it. A tap that finds it not yet read reads it now - once - and lets the
     gate judge the answer; a token the chain has already refused is not asked
     again here, because the gate has a sentence for that and Setup is where it
     is fixed. */
  function tokenReady() {
    if (S.mode !== 'wallet') return Promise.resolve(true);
    if (S.tokenState === 'ok' || S.tokenState === 'wrong') return Promise.resolve(true);
    if (!isAddr(S.contract) || !isAddr(tokenNow())) return Promise.resolve(true);
    return chainProbe().then(function () { return true; }, function () { return true; });
  }

  function approve() {
    if (S.phase === 'settled' || S.phase === 'refunded') { reset(); return; }
    if (S.phase === 'paying') { paid(); return; }
    if (S.phase === 'locking' || S.phase === 'paid') { checkChain(); return; }
    /* No live quote, no wallet swap: the tap is answered with a sentence and
       the price is read again, rather than opening a swap priced by a guess. */
    if (quoteMissing()) { refuseRate(); return; }
    /* The gate takes a chain reading and then opens the swap: a second tap in
       that gap would read the terms again and start a second swap on the same
       money. */
    if (!opStart('approve')) { opWait(); return; }
    /* The id names the address that funds the escrow. When this side funds it,
       the wallet is asked who it is before anything is computed. */
    var whoFirst = S.mode === 'wallet' && S.direction === 'u2b' ? ensureMe() : Promise.resolve(true);
    whoFirst.then(tokenReady).then(function () { return validate(); }).then(function (r) {
      if (!r.ok) {
        paintGate(r);
        if (r.code === 'setup') openSetup();
        shake();
        log('BLOCK', r.msg, 'c-err');
        renderLog();
        toast(r.msg);
        return;
      }
      if (!S.t2) { S.t2 = nowSec() + T2_SPAN; S.t1 = curHeight() + T1_BLOCKS; }
      /* Last look at the clock: nothing is approved on a window that has
         already closed or is about to. The tap had already built part of the
         swap - the window it set is dropped with the rest. */
      var wp = windowProblem(r.dec, S.t2);
      if (wp) {
        dropSwapTerms();
        log('BLOCK', wp, 'c-err');
        render();
        toast(wp);
        return;
      }
      S.units = usdtUnits();
      S.inv = String(pasted()).replace(/^lightning:/i, '');
      S.invDec = r.dec;
      S.addr = r.address;
      S.H = r.H;
      S.basis = 'invoice';
      logSwap(r);
      /* Practice rehearses the same gates against a stand-in escrow. Wallet
         mode moves real USDT and the chain has the last word. */
      return startSwap();
    }).then(opEnd, function (e) {
      opEnd();
      /* A tap that never got the swap going leaves no terms of its own: what
         it had half-built is dropped before the refusal is explained. */
      if (S.phase === 'idle') dropSwapTerms();
      walletFail(e);
    });
  }

  /* ------------------------------------------------- the rehearsal escrow --
     Practice differs from Wallet in what it draws on, never in what it asks
     the screen to do. Both modes tap the same Approve, park on the same
     waiting screen, and close only on a claimed escrow record; in Practice
     that record is the stand-in below, which is why nothing has to be
     deployed, signed or pasted to rehearse a swap. */
  function simRecord() {
    return {
      hashlock: S.H, amount: usdtUnits(), timelock: S.t2,
      token: tokenNow(), sender: EVM.usdtSide, receiver: S.addr,
      claimed: false, refunded: false
    };
  }

  /* A rehearsal has no deployment and no partner to wait for, so the stand-in
     escrow starts in the state a real swap reaches at this point: when this
     side sends bitcoin, the USDT is already locked for it. */
  function simSeed() {
    if (S.mode !== 'practice') return;
    var c = classify(simRead());
    if (c.state === 'locked' || c.state === 'claimed' || c.state === 'refunded') return;
    if (S.direction === 'u2b') { S.simRec = null; return; }   /* this side locks first */
    S.simRec = simRecord();
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
  }

  /* The lock this side owes, landing in the stand-in escrow. */
  function simLockNow() {
    if (S.mode !== 'practice' || !S.H) return null;
    S.simRec = simRecord();
    S.block = curHeight() + 1;
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
    return S.simRec;
  }

  /* No wallet signs in a rehearsal, so the stand-in does: the lock lands a
     moment after the tap, and the reading that follows picks it up. */
  function simLock(delay) {
    var want = normHex(S.H);
    setTimeout(function () {
      if (S.mode !== 'practice' || S.phase !== 'locking' || normHex(S.H) !== want) return;
      simLockNow();
      refreshChain().then(function (c) { if (S.phase === 'locking') lockedMine(c); });
    }, delay == null ? 1500 : delay);
  }

  /* The partner takes the USDT once the sats are paid: the stand-in claims a
     moment later, and the watch that closes a real swap closes this one on
     the same reading. */
  function simClaim(delay) {
    var want = normHex(S.H);
    setTimeout(function () {
      if (S.mode !== 'practice' || S.phase !== 'paid' || normHex(S.H) !== want || !S.simRec) return;
      S.simRec.claimed = true;
      refreshChain().then(function (c) { if (c && c.state === 'claimed') settleByChain(c); });
    }, delay == null ? 2000 : delay);
  }

  /* A pasted transaction hash in Practice stands for the moment the lock
     lands; there is no node to ask about it. */
  function simReceipt() {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (S.phase === 'locking' && !S.simRec) simLockNow();
        resolve({ blockNumber: '0x' + (curHeight() + 1).toString(16) });
      }, 900);
    });
  }

  /* The payer says the money left. That starts the watch; the escrow is what
     decides whether the swap is over. */
  function paid() {
    if (S.phase !== 'paying') return;
    /* Paying into the last minutes of the window is how a payer loses: the
       escrow can be refunded before the claim lands. The clock that counts is
       the chain's, read fresh on the tap, because a phone's clock is something
       its owner can move. */
    syncChainTime(true).then(function (now) {
      if (S.phase !== 'paying') return;
      if (S.t2 && S.t2 - now <= PAY_MARGIN) {
        var m = 'The escrow window is closing. Do not pay; ask for a new code.';
        S.note = m;
        log('BLOCK', m, 'c-err');
        render();
        toast(m);
        return;
      }
      /* And the payment has to outlive the window from this moment on: a
         payment made now runs for the invoice's own delta, and if that lands
         before the escrow can be claimed the same secret would open both legs.
         Read again here, on the tap, against the same fresh clock - from the
         invoice this side approved, or the one on the screen when it approved
         nothing yet. The invoice is decoded here rather than through the gate's
         reader: the gate already refused the ones it could, and the question
         now is one the gate never asks. */
      var decNow = S.invDec;
      if (!decNow && pasted()) {
        try { decNow = parseLightning(pasted()); } catch (e) { decNow = null; }
      }
      var ln = lnProblem(decNow, S.t2, now);
      if (ln) {
        S.note = ln;
        log('BLOCK', ln, 'c-err');
        render();
        toast(ln);
        return;
      }
      log('PAID', S.direction === 'btc2u'
        ? 'the sats have been sent \u00b7 waiting for the escrow to pay out on ' + curChain().label
        : 'the USDT has been sent');
      S.phase = 'paid';
      S.note = '';
      keepSwapMeta();
      render();
      refreshGate();
      refreshChain().then(function (c) {
        if (!c) return;
        if (c.state === 'claimed') { settleByChain(c); return; }
        if (c.state === 'refunded') { wentBack(c); return; }
        startWatch();
        render();
        refreshGate();
        toast('Watching the chain. Nothing else to tap.');
      });
    });
  }

  /* Approve on a running swap reads the chain again: it is the only button
     that can move `paid` on, and it moves only on what the chain says. */
  function checkChain() {
    if (S.busy) return;
    S.note = '';
    /* Practice: a check on the lock this side owes is the moment the stand-in
       takes it, so the screen never strands a rehearsal. */
    if (S.mode === 'practice' && S.phase === 'locking' && !S.simRec) simLockNow();
    busy(true);
    refreshChain().then(function (c) {
      busy(false);
      if (!c) { toast('Nothing to check yet'); return; }
      if (c.state === 'claimed') { settleByChain(c); return; }
      if (c.state === 'refunded') { wentBack(c); return; }
      if (c.state === 'locked') {
        if (S.phase === 'locking') { lockedMine(c); return; }
        render();
        refreshGate();
        toast('The escrow still holds the USDT');
        return;
      }
      if (S.phase === 'paid') { blockChain(c); return; }
      blockChain(c);
    }, function () { busy(false); });
  }

  function reset() {
    stopWatch();
    dropSwapMeta();
    S.note = '';
    S.phase = 'idle';
    S.H = null; S.id = null; S.units = null;
    S.t1 = null; S.t2 = null;
    S.inv = ''; S.invDec = null; S.addr = ''; S.expectH = null; S.basis = null;
    S.qrInv = ''; S.chain = null; S.simRec = null; S.txPending = null;
    S.locker = ''; S.funder = ''; S.codeWarn = ''; S.codeAddr = '';
    S.codeTerms = null; S.codeRateWarn = false; S.codeAddrFilled = '';
    S.codeAsk = null;
    S.lockTx = ''; S.claimTx = '';
    clearSecret();
    S.busy = false;
    S.op = ''; S.sending = false;
    var t = $('txIn'); if (t) { t.value = ''; }
    var row = $('secretRow'); if (row) { row.hidden = true; row.dataset.open = '0'; }
    var a = invIn(); if (a) { a.value = ''; a.dataset.state = ''; }
    var b = addrEl(); if (b) { b.value = ''; b.dataset.state = ''; }
    var c = $('codeIn'); if (c) c.value = '';
    var lt = $('lockTxIn'); if (lt) lt.value = '';
    renderCodeWarn();
    renderCodeAsk();
    var box = $('qrBox'); if (box) box.innerHTML = '';
    var cx = $('codeRow'); if (cx) cx.hidden = true;
    log('RESET', 'state cleared');
    render();
    refreshGate();
  }

  /* Back from the finished swap or the waiting screen keeps the terms on
     screen but not the swap that used them. The window a code set, the hash it
     pinned, the address the escrow saw and the transaction that locked it
     belong to that swap alone: carried into the next one they would build its
     id from the last one's funder, pin a hash nobody will pay, or approve
     against a window that is already half gone. */
  function backToForm() {
    if (S.phase === 'idle') return;
    stopWatch();
    dropSwapMeta();
    S.phase = 'idle';
    S.qrInv = '';
    S.t2 = null;
    S.expectH = null;
    S.funder = '';
    S.lockTx = '';
    /* The terms the last swap was locked under go with it: the hash it pinned,
       the amount both sides agreed and the funding address a code named. Carried
       into the next one they would approve against another swap's terms. */
    S.H = null;
    S.units = null;
    S.locker = '';
    /* A new swap starts without the last one's secret, on the screen and in
       this page, whatever state the last one ended in. */
    clearSecret();
    var box = $('qrBox'); if (box) box.innerHTML = '';
    log('BACK', 'a new swap starts without the last one\u2019s window or transaction');
    render();
    refreshGate();
  }

  /* A code is a stranger's text. It carries terms, never the app's setup:
     the chain is not switched and the escrow address is not written over. A
     code that names an escrow this app does not publish, or one that differs
     from the escrow already set here, is refused whole and nothing on this
     phone changes. That is what stops a code from pointing a swap at a
     contract that only imitates the real one. */
  function refuseCode(msg, detail) {
    S.codeWarn = msg;
    S.codeRateWarn = false;   /* the sentence on screen is this refusal, not the rate */
    log('SECURITY', detail || msg, 'c-err');
    toast(msg);
    renderCodeWarn();
    return false;
  }

  /* The terms a code put on this phone - the window it set, the hash it
     pinned, the address it named and the amount it agreed - belong to the one
     swap that code described. A tap that changes what the swap is (the
     direction, the amount) clears them, so the next swap is not locked under a
     window a stranger chose for another swap, against a hash this side is not
     paying, or from an address that belonged to the other side's role. Asking
     for a new code is what puts those terms back. */
  function clearCodeTerms(why) {
    var had = !!(S.expectH || S.locker || S.codeTerms || S.codeAddr || S.codeWarn || S.t2);
    S.t1 = null; S.t2 = null;
    S.expectH = null;
    S.locker = '';
    S.funder = '';
    S.units = null;
    S.codeTerms = null; S.codeRateWarn = false;
    S.codeWarn = ''; S.codeAddr = '';
    /* An address a code wrote into the field is the partner's, said in the
       code's own voice. One the person typed is theirs and stays. */
    var el = addrEl();
    if (S.codeAddrFilled && el && String(el.value).trim().toLowerCase() === String(S.codeAddrFilled).toLowerCase()) {
      el.value = '';
      el.dataset.state = '';
    }
    S.codeAddrFilled = '';
    renderCodeWarn();
    if (had) log('RESET', why);
  }

  function renderCodeWarn() {
    var el = $('codeWarn');
    if (el) { el.textContent = S.codeWarn || ''; el.hidden = !S.codeWarn; }
    var row = $('codeAddr'), txt = $('codeAddrTxt');
    if (!row || !txt) return;    if (S.codeAddr) {
      txt.textContent = 'This code names a USDT address (' + short(S.codeAddr, 6) +
        '). Use it only if it is yours.';
      row.hidden = false;
    } else {
      txt.textContent = '';
      row.hidden = true;
    }
  }

  /* ------------------------------------------------------ a code arriving --
     A code from another app (a scanner, a message, the camera) lands on a
     screen that may already be set up. Applying it writes the terms, the
     direction and - on the side that sends the USDT - the partner's address
     over what is here, so it is not done on arrival: the code waits with one
     sentence and two buttons, and the screen keeps what it had until one is
     pressed. A screen with nothing on it has nothing to lose and takes the
     code straight away, which is what a link tapped on a fresh screen is. */
  function codeWouldReplace(c) {
    var addr = String(addrEl() && addrEl().value || '').trim();
    if (String(pasted()).trim()) return true;
    if (S.expectH || S.codeTerms || S.t2) return true;
    if (addr && (!c.address || String(c.address).toLowerCase() !== addr.toLowerCase())) return true;
    return false;
  }
  function codeAskText(c) {
    var dir = opposite(c.direction);
    var addr = String(addrEl() && addrEl().value || '').trim();
    var say = 'A swap code from another app would put ' + fmt(c.sats) + ' sats ' +
      (dir === 'btc2u' ? 'paid in bitcoin' : 'paid in USDT') + ' here';
    if (addr && c.address && String(c.address).toLowerCase() !== addr.toLowerCase()) {
      say += ', with its own USDT address';
    }
    return say + '. Loading it replaces what is on this screen.';
  }
  function renderCodeAsk() {
    var box = $('codeAsk'), txt = $('codeAskTxt');
    if (!box || !txt) return;
    if (!S.codeAsk) { box.hidden = true; txt.textContent = ''; return; }
    txt.textContent = S.codeAsk.say;
    box.hidden = false;
  }
  function acceptCode(text) {
    var c = parseSwapLink(text);
    if (!c) { toast('That is not a swap code'); return false; }
    /* A swap that is already running refuses the code for its own reason, and
       saying so is what the screen should do rather than asking a question
       whose answer could not change anything. */
    if (S.phase !== 'idle' || !codeWouldReplace(c)) return applyCode(text);
    S.codeAsk = { text: String(text), say: codeAskText(c) };
    log('CODE', 'a code from another app was held until this screen says so');
    renderCodeAsk();
    toast('A swap code is waiting: load it, or keep this one');
    return false;
  }

  function applyCode(text) {
    var c = parseSwapLink(text);
    if (!c) { toast('That is not a swap code'); return false; }
    S.codeAsk = null;
    renderCodeAsk();
    var now = effNow();
    if (S.phase === 'settled' || S.phase === 'refunded') { toast('Tap Done first, then use the code.'); return false; }
    /* A code names the terms of the next swap. Loading one into a swap that is
       already running would put different numbers under money that has moved,
       so every phase but idle refuses it. */
    if (S.phase !== 'idle') {
      return refuseCode('A swap is already running. Finish it first, then use the code.',
        'a code was refused while a swap was ' + S.phase);
    }
    if (c.t2 <= now) return refuseCode('Those terms have run out. Ask for a new code.');
    if (c.t2 - now < T2_MIN) {
      return refuseCode('Those terms close too soon to pay and claim. Ask for a new code.',
        'a code with a ' + Math.round((c.t2 - now) / 60) + ' minute window was refused');
    }
    if (c.t2 - now > T2_MAX) return refuseCode('Those terms would lock the money for too long. Ask for a new code.');

    /* The chain and the escrow a wallet code names are requirements, not
       settings. Neither is adopted here. */
    var practice = S.mode === 'practice';
    if (!practice && c.net && c.net !== S.net) {
      return refuseCode('That code is for ' + (CHAINS[c.net] ? CHAINS[c.net].label : c.net) +
        ', and this app is set to ' + curChain().label + '. Switch the network in Setup, then load it again.');
    }
    if (!practice && c.contract) {
      var want = String(c.contract).toLowerCase(), mine = String(S.contract || '').toLowerCase();
      if (mine && mine !== want) {
        return refuseCode('That code names a different escrow contract than the one set here. Nothing was changed.',
          'a code naming escrow ' + want + ' was refused; this phone uses ' + mine);
      }
      if (!mine) {
        if (!isOfficialEscrow(S.net, want)) {
          return refuseCode('That code points at an escrow this app does not publish. Nothing was changed: check it with your partner and set it in Setup yourself.',
            'an unpublished escrow ' + want + ' was refused');
        }
        S.contract = want;
        saveSetup();
        log('SETUP', 'the published escrow for ' + curChain().label + ' came from the code');
      }
    }

    S.direction = opposite(c.direction);
    S.sats = c.sats;
    S.units = c.units;
    S.t2 = c.t2;
    S.t1 = c.t1;
    S.expectH = c.H || null;
    /* The id is the terms plus the funding address: when the other side funds
       the escrow, their code is where that address comes from. */
    S.locker = S.direction === 'btc2u' ? (c.locker || '') : '';
    /* The address the escrow actually saw is learned from the escrow, not from
       a code, so a new set of terms starts without one. */
    S.funder = '';
    /* Where the USDT lands is the one field a code must not set on the side that
       receives it: whoever wrote the code could name their own address, and the
       sats would buy USDT paid to them. On the side that sends the USDT the
       address in a code is the partner's own destination, which is theirs to
       name - that one is filled in. On the receiving side it is only offered,
       for a tap that says it is this phone's address. */
    S.codeAddr = '';
    S.codeAddrFilled = '';
    if (c.address) {
      if (S.direction === 'u2b') { addrEl().value = c.address; S.codeAddrFilled = c.address; }
      else S.codeAddr = c.address;
    }
    S.codeWarn = '';
    S.codeRateWarn = false;
    /* The amounts this code states stay here after the screen is painted: the
       quote can land later, and the check below has to be made again when it
       does (see recheckCodeRate). */
    S.codeTerms = { units: c.units, sats: c.sats };
    renderCodeWarn();
    $('codeRow').hidden = true;
    presetsOn();
    log('CODE', 'terms from the other side \u00b7 ' + fmt(S.sats) + ' sats \u00b7 ' + usdtTxt() + ' USDT');
    if (!practice && S.direction === 'btc2u' && !isAddr(S.locker)) {
      log('CODE', 'the code does not name the address that funds the escrow; paste its lock transaction instead');
    }
    /* The price the code carries is checked against the live quote before
       anything is rendered as accepted. The swap still runs - a partner is
       allowed to quote their own spread - but the screen says how far the
       terms sit from the market, while it is still only terms. A quote that
       has not landed yet is checked again the moment it does. */
    var warn = rateWarnText(c.units, c.sats);
    if (warn) {
      S.codeWarn = warn;
      S.codeRateWarn = true;
      renderCodeWarn();
      var rg = rateGap(c.units, c.sats);
      log('SECURITY', 'a code pricing 1 BTC at ' + fmt(Math.round(rg.codePrice)) + ' USDT was loaded; the live quote says ' +
        fmt(Math.round(S.price)) + ' (' + Math.round(rg.gap * 100) + '% off)', 'c-err');
    }
    render();
    refreshGate();
    toast('Terms loaded');
    return true;
  }

  /* A sample invoice lasts as long as the escrow window plus the margin the
     gate asks for, so a rehearsal exercises the same rule a real invoice has
     to pass. */
  function sampleExpiry() {
    var left = S.t2 ? Math.max(S.t2 - effNow(), T2_MIN) : T2_SPAN;
    return left + T1_MARGIN + 900;
  }

  function sampleInvoice() {
    if (S.mode === 'wallet') return;
    var R = rndHex(32);
    sha256Hex(R).then(function (H) {
      invIn().value = mintInvoice({ paymentHash: '0x' + H, sats: S.sats, expiry: sampleExpiry() });
      invIn().dataset.state = '';
      render();
      refreshGate();
    }).catch(function () { toast('This device cannot make a sample invoice'); });
  }

  function sampleAddress() {
    if (S.mode === 'wallet') return;
    addrEl().value = DEMO_ADDR;
    addrEl().dataset.state = '';
    render();
    refreshGate();
  }

  /* ---------------------------------------------------------------- QR --- */
  function qrLine(text) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    return p;
  }
  function qrClear(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
  }
  /* The QR is drawn here, element by element, from the encoder's module grid:
     the payload is a stranger's text and markup built out of strings is markup a
     stranger can write. Nothing is parsed, so nothing in the payload can turn
     into a node. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function qrNode(q, quiet) {
    var dim = q.size + quiet * 2, path = '', y, x;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    for (y = 0; y < q.size; y++) {
      for (x = 0; x < q.size; x++) {
        if (q.modules[y][x]) path += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
      }
    }
    var el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('fill', '#040e09');
    svg.appendChild(el);
    return svg;
  }
  function showQr(payload, caption, reveal) {
    var box = $('qrBox');
    if (!box) return;
    if (!payload) { qrClear(box); toast('Nothing to show yet'); return; }
    var bytes = utf8(payload).length;
    var q = null, quiet = 2;
    if (bytes <= QR_MAX) {
      ['M', 'L'].forEach(function (level) {
        if (q) return;
        try { q = window.QR.encode(payload, { level: level }); } catch (e) { q = null; }
      });
    }
    qrClear(box);
    var node = q ? qrNode(q, quiet) : null;
    if (!node) {
      box.appendChild(qrLine('Too long for a QR: use Copy instead.'));
      return;
    }
    box.appendChild(node);
    if (caption) box.appendChild(qrLine(String(caption)));
    if (reveal) revealQr(box);
  }

  /* The Approve bar is fixed over the bottom of the page: when a QR opens,
     put all of it above the bar instead of leaving its lower half underneath. */
  function revealQr(box) {
    if (!box || !box.innerHTML) return;
    var bar = document.querySelector('.bar');
    var r = box.getBoundingClientRect();
    var limit = window.innerHeight - (bar ? bar.getBoundingClientRect().height : 80) - 16;
    var delta = r.bottom - limit;
    if (delta <= 0) return;
    var room = r.top - 12;
    window.scrollBy(0, Math.min(delta, Math.max(0, room)));
  }
