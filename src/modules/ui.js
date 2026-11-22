  /* ui.js - the setup panel, the event wiring and the ACT table */
  /* ------------------------------------------------------------ events --- */
  /* ------------------------------------------------------------- setup --- */
  function openSetup() {
    var box = $('setupBox');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) paintSetup();
  }
  function closeSetup() { var box = $('setupBox'); if (box) box.hidden = true; }

  function setNet(v) {
    var want = v === 'mainnet' ? 'mainnet' : 'testnet';
    if (S.net === want) return;
    /* What was typed belongs to the network it was typed for. It is put away
       under that one before the other network's own escrow, token and
       endpoints are read back, and every reading of the chain goes with it:
       a block height, a timestamp and an escrow record are true of one chain
       only, and none of them may be shown beside another. */
    keepSetup();
    S.net = want;
    applySetup();
    S.rpcState = 'idle';
    S.tokenState = '';
    S.block = null;
    S.blockTs = null; S.blockTsAt = 0; S.blockTsFail = 0;
    S.quorum = 'idle';
    S.chain = null;
    saveSetup();
    paintSetup();
    render();
    refreshGate();
    if (S.mode === 'wallet' && isAddr(S.contract)) {
      chainProbe().then(function () { if (S.H) refreshChain(); });
    }
  }

  /* What was typed, checked for shape only: nothing is stored here, so a
     token that the chain then refuses leaves the setup as it was. */
  function parseSetup() {
    var c = String($('contractIn').value || '').trim();
    var t = String($('tokenIn').value || '').trim();
    var r = String($('rpcIn').value || '').trim();
    if (c && !isAddr(c)) {
      toast(/^0x[0-9a-fA-F]{40}$/.test(c)
        ? 'That contract address has a mistyped character: its capitals do not spell it the way an address spells itself'
        : 'That contract address is not a 0x one');
      return null;
    }
    if (t && !isAddr(t)) {
      toast(/^0x[0-9a-fA-F]{40}$/.test(t)
        ? 'That token address has a mistyped character: its capitals do not spell it the way an address spells itself'
        : 'That token address is not a 0x one');
      return null;
    }
    if (r && !endpointsOk(r)) { toast('Every endpoint has to be an https one'); return null; }
    return { contract: c.toLowerCase(), token: t.toLowerCase(), rpc: r };
  }

  function commitSetup(v) {
    S.contract = v.contract;
    S.token = v.token;
    S.rpc = v.rpc;
    S.rpcState = 'idle';
    S.quorum = 'idle';
    S.chain = null;
    saveSetup();
    paintSetup();
    render();
    refreshGate();
  }

  /* Save and Check go through here: the shape is read first, then the token is
     asked about on the chain the setup is about to name. A token that is not a
     contract, or that counts in other decimals, is refused before it is stored
     and before any amount is priced against it. A chain that does not answer is
     not a verdict about the token: the setup is kept, marked unread, and the
     panel says so - nothing is refused on silence alone. */
  function applySetupFromForm(done) {
    var v = parseSetup();
    if (!v) return;
    function after() { if (done) done(); }
    if (!v.token) {
      S.tokenState = 'ok';        /* the chain's own token is the one this page counts in */
      commitSetup(v);
      after();
      return;
    }
    var list = endpointList(v.rpc);
    if (!list.length) list = curChain().rpc.slice();
    tokenVerdict(v.token, list).then(function (r) {
      if (r.ok) {
        S.tokenState = 'ok';
        commitSetup(v);
        log('SETUP', 'the token at ' + short(v.token, 6) + ' is a contract and counts in ' + r.decimals + ' decimals');
        paintSetup();
        after();
        return;
      }
      if (r.why === 'unread') {
        commitSetup(v);
        S.tokenState = 'unread';
        log('SETUP', 'the token at ' + short(v.token, 6) + ' was kept unread: the chain did not answer', 'c-err');
        paintSetup();
        toast('The chain did not answer, so the token was kept unread. Check again when it answers.');
        after();
        return;
      }
      /* A definite answer against the token: the token is not stored, and the
         escrow and endpoints typed with it are - fixing the token then costs
         one field, not the whole panel again. The refused address stays in
         the field, and the sentence says which answer it was. */
      S.contract = v.contract;
      S.rpc = v.rpc;
      S.rpcState = 'idle';
      S.quorum = 'idle';
      S.chain = null;
      S.tokenState = 'wrong';
      saveSetup();
      paintSetup();
      var el = $('tokenIn'); if (el) el.value = v.token;
      var msg = tokenWhy(r);
      log('SETUP', msg, 'c-err');
      toast(msg);
    }, function () {
      commitSetup(v);
      S.tokenState = 'unread';
      paintSetup();
      toast('The chain did not answer, so the token was kept unread. Check again when it answers.');
      after();
    });
  }

  function readSetup() {
    var v = parseSetup();
    if (!v) return false;
    commitSetup(v);
    return true;
  }

  var ACT = {
    mode: function (b) {
      var want = b.dataset.v === 'wallet' ? 'wallet' : 'practice';
      var was = S.mode;
      /* A real swap is not a rehearsal to switch out of. Changing the mode
         mid-swap would put the screen on the other escrow while the USDT of
         this one is still locked - the claim, the refund and the reading that
         closes it would all be asked of the wrong chain. It is refused until
         the swap is done or left behind. */
      if (want !== S.mode && S.phase !== 'idle' && S.mode === 'wallet') {
        var m = 'A real swap is running. Finish it, or tap Back, before switching modes.';
        log('BLOCK', 'the mode was not switched while a wallet swap was ' + S.phase, 'c-err');
        toast(m);
        if (S.phase === 'paying') { S.note = m; }
        render();
        return;
      }
      S.mode = want;
      if (S.phase !== 'idle') backToForm();
      /* A rehearsal's terms are not a real swap's. The window a Practice code
         set, the hash it pinned, the funding address it named and the amount
         both sides agreed were agreed for a stand-in escrow; Wallet prices its
         own swap and locks it on a chain. So they go when Practice does, before
         a swap this phone was in the middle of writes its terms back. */
      if (want !== was && was === 'practice' && S.phase === 'idle') {
        clearCodeTerms('the switch to Wallet left the Practice terms behind');
      }
      /* Switching to Wallet is also how a swap the page was in the middle of
         comes back when the phone did not open on it - the same record the
         boot reads, read once more here. */
      if (S.mode === 'wallet' && S.phase === 'idle') resumeSwap();
      /* the two escrows are not each other's: a rehearsal's stand-in record
         never carries into a real swap, and a chain reading never into one */
      S.simRec = null;
      S.chain = null;
      closeSetup();
      render();
      refreshGate();
      if (S.mode === 'wallet' && isAddr(S.contract)) chainProbe().then(function () { if (S.H) refreshChain(); });
    },
    settings: function () {
      /* Setup is where an escrow is deployed and pointed at; a rehearsal runs
         on the stand-in, so there is nothing to set there. */
      if (S.mode === 'practice') { toast('Practice runs on a stand-in escrow, so there is nothing to set.'); return; }
      openSetup();
    },
    net: function (b) { setNet(b.dataset.v); },
    saveSetup: function () {
      applySetupFromForm(function () { chainProbe().then(function () { if (S.H) refreshChain(); }); });
    },
    checkSetup: function () {
      applySetupFromForm(function () {
        chainProbe().then(function () {
          if (S.rpcState === 'ok') toast(S.tokenState === 'unread'
            ? 'The chain answers, but the token was not read'
            : 'The chain answers');
          else if (S.rpcState === 'unclear') toast('The endpoints disagree about that address');
          else if (S.rpcState === 'nocon') toast('No contract at that address');
          else if (S.rpcState === 'nohtlc') toast('That address is not the swap contract');
          else toast('The chain did not answer');
          paintSetup();
        });
      });
    },
    copyBytecode: function () { copy(BYTECODE, 'Bytecode copied'); },
    checkChain: function () { checkChain(); },
    walletSend: function () {
      var p = provider();
      if (!p) { toast('No wallet in this page: copy the call instead'); return; }
      if (quoteMissing()) { refuseRate(); return; }
      runLock(p);
    },
    copyCall: function () {
      if (!isAddr(escrowNow()) || !S.H) { toast('Nothing to copy yet'); return; }
      if (S.phase === 'locking') { copy(callPacket(lockCall(), 'lock'), 'Call copied'); return; }
      toast('Nothing to copy yet');
    },
    copyApprove: function () {
      if (!isAddr(tokenNow())) { toast('Nothing to copy yet'); return; }
      copy(callPacket(approveCall(), 'approve'), 'Approve call copied');
    },
    openTx: function () {
      var row = $('txRow');
      if (!row) return;
      row.hidden = !row.hidden;
      if (!row.hidden) $('txIn').focus();
    },
    loadTx: function () { loadTx($('txIn').value); },
    useLockTx: function () { loadTx($('lockTxIn').value); },
    claimOpen: function () {
      var row = $('secretRow');
      if (!row) return;
      var open = row.hidden;
      row.hidden = !open;
      row.dataset.open = open ? '1' : '0';
      if (open) $('secretIn').focus();
    },
    sendClaim: function () {
      S.secret = normHex($('secretIn').value || '');
      doClaim();
    },
    sendRefund: function () { doRefund(); },
    direction: function () {
      if (S.phase === 'settled' || S.phase === 'refunded') return;
      S.direction = opposite(S.direction);
      /* The other direction is funded by the other side: an address learned
         for one side is not this side's. */
      S.funder = '';
      /* And the terms a code wrote belong to the swap it described, not to the
         one this flip starts: the window it set, the hash it pinned, the
         funding address it named and the amount it agreed are all its own.
         Carried over, the next swap would be locked under a window someone
         else chose for the other direction, against a hash this side is not
         paying. The sats stay - they are the amount this side picked. */
      clearCodeTerms('the direction flip left the last code\u2019s window, hash, funder and amount behind');
      render();
      refreshGate();
    },
    sats: function (b) {
      if (S.phase === 'settled') return;
      S.sats = Number(b.dataset.v);
      S.units = null;
      /* A new amount is a new swap: the window, the hash and the funding
         address a code set were agreed for the old amount. */
      clearCodeTerms('a new amount left the last code\u2019s window, hash and funder behind');
      presetsOn();
      render();
      refreshGate();
    },
    primary: function () { approve(); },
    back: function () { backToForm(); },
    /* Sharing a code on the side that funds the escrow asks the wallet who it
       is first: the id is the terms plus that address, so the partner cannot
       check the escrow without it. */
    /* A code states the terms of a swap, and a term of zero is not a term: an
       exchange rate that has not loaded yet cannot be written as "0 USDT" and
       handed to the other side, so no code is made here at all. And a code that
       prices the swap is written from a current quote: one older than its shelf
       life is read again from both sources before the code is made. */
    copyCode: function () {
      ensureMe().then(rateForCode).then(function () {
        var code;
        try { code = swapCode(); } catch (e) {
          log('BLOCK', String((e && e.message) || e), 'c-err');
          render();
          toast(String((e && e.message) || e));
          return;
        }
        copy(code, 'Code copied');
        render();
      });
    },
    qrCode: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      ensureMe().then(rateForCode).then(function () {
        var code;
        try { code = swapCode(); } catch (e) {
          log('BLOCK', String((e && e.message) || e), 'c-err');
          render();
          toast(String((e && e.message) || e));
          return;
        }
        S.qrInv = code;
        showQr(code, 'Your partner scans this for the same terms', true);
        render();
      });
    },
    pasteCode: function () {
      var row = $('codeRow');
      row.hidden = false;
      var el = $('codeIn');
      el.focus();
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (t) {
          if (t && !el.value) { el.value = String(t).trim(); }
        }, function () { /* typing it in is fine too */ });
      }
    },
    useCodeAddr: function () {
      if (!S.codeAddr) return;
      addrEl().value = S.codeAddr;
      addrEl().dataset.state = '';
      S.codeAddr = '';
      log('CODE', 'the USDT address the code named was used, after a tap');
      renderCodeWarn();
      render();
      refreshGate();
    },
    useCode: function () {
      var v = String($('codeIn').value || '').trim();
      if (!v) { toast('Paste the code first'); return; }
      applyCode(v);
    },
    /* The two answers to a code that arrived from another app. Yes loads it
       with every gate a typed code walks; no leaves the screen exactly as it
       was, address and terms included. */
    codeAskYes: function () {
      var ask = S.codeAsk;
      if (!ask) return;
      applyCode(ask.text);
    },
    codeAskNo: function () {
      if (!S.codeAsk) return;
      S.codeAsk = null;
      renderCodeAsk();
      log('CODE', 'the code that arrived was left alone; this screen kept its own');
      render();
      toast('Kept what was on this screen');
    },
    copyInvoice: function () {
      var inv = readInvoice(pasted());
      if (!inv.ok) { needInvoice(); return; }
      copy(String(pasted()).replace(/^lightning:/i, ''), 'Invoice copied');
    },
    qrInvoice: function () {
      var inv = readInvoice(pasted());
      if (!inv.ok) { needInvoice(); return; }
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      var raw = String(pasted()).replace(/^lightning:/i, '');
      S.qrInv = raw;
      showQr('lightning:' + raw, S.direction === 'btc2u'
        ? 'The invoice for this swap'
        : 'Your partner scans this to pay you', true);
    },
    sampleInv: function () { sampleInvoice(); },
    sampleAddr: function () { sampleAddress(); },
    payCopyInv: function () {
      if (!S.inv) { needInvoice(); return; }
      copy(S.inv, 'Invoice copied');
    },
    payQrInv: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      if (!S.inv) { needInvoice(); return; }
      S.qrInv = S.inv;
      showQr('lightning:' + S.inv, 'The invoice for this swap', true);
    },
    payCopyAddr: function () {
      if (!S.addr) { toast('Nothing to copy yet'); return; }
      copy(S.addr, 'Address copied');
    },
    payQrAddr: function () {
      var box = $('qrBox');
      if (box.innerHTML) { box.innerHTML = ''; S.qrInv = ''; return; }
      if (!S.addr) { toast('Nothing to show yet'); return; }
      S.qrInv = S.addr;
      showQr(S.addr, 'The address the USDT goes to', true);
    },
    reset: function () { reset(); }
  };
