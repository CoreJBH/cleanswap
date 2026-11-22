  /* wallet.js - an EIP-1193 wallet, the calls it sends, claim, refund and a pasted receipt */
  /* --------------------------------------------------- wallets that sign -- */
  function provider() {
    var eth = window.ethereum;
    return eth && typeof eth.request === 'function' ? eth : null;
  }
  function ensureChain(p) {
    return p.request({ method: 'eth_chainId' }).then(function (id) {
      if (String(id || '').toLowerCase() === curChain().chainHex) return true;
      return p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: curChain().chainHex }] })
        .then(function () { return true; }, function () {
          return p.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: curChain().chainHex,
            chainName: curChain().label,
            rpcUrls: endpoints(),
            blockExplorerUrls: [curChain().explorer],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
          }] }).then(function () { return true; });
        });
    });
  }
  /* The chain a transaction lands on is the chain the wallet is on at the
     moment it signs, not the one it was on when it was asked to switch. Between
     the switch request and the signature a person can change networks in the
     wallet, and the same calldata on another chain is a call to whatever
     contract holds that address there. So the chain is read again immediately
     before every send, and a mismatch refuses the send instead of signing on
     the wrong chain. */
  function assertChain(p) {
    return p.request({ method: 'eth_chainId' }).then(function (id) {
      if (String(id || '').toLowerCase() === curChain().chainHex) return true;
      var e = new Error('the wallet is on another network now');
      e.chainSwitched = true;
      throw e;
    });
  }
  function walletSend(to, data) {
    var p = provider();
    if (!p) return Promise.reject(new Error('no wallet in this page'));
    /* Real USDT is never locked against a guessed price: without a live quote
       the wallet is not asked to sign anything. */
    if (quoteMissing()) return Promise.reject(rateError());
    /* A wallet call this page made is not made a second time while the first
       is still on its way: two claims of one escrow are one claim, and a
       wallet asked twice can charge twice. */
    if (S.sending) return Promise.reject(new Error('that call is already in flight'));
    S.sending = true;
    return ensureChain(p)
      .then(function () { return p.request({ method: 'eth_requestAccounts' }); })
      .then(function (accts) {
        var from = accts && accts[0];
        if (!from) throw new Error('the wallet shared no account');
        S.me = String(from);
        return assertChain(p).then(function () {
          return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: to, data: data, value: '0x0' }] });
        });
      })
      .then(function (h) { S.sending = false; return h; }, function (e) { S.sending = false; throw e; });
  }
  /* A transaction is only real once the chain has it: the receipt is what the
     app waits for, and the escrow reading after it is what the app believes. */
  function waitReceipt(hash) {
    var tries = 0;
    return new Promise(function (resolve, reject) {
      function again(e) {
        if (++tries > 45) return reject(e || new Error('the transaction is not mined yet'));
        setTimeout(poll, 3000);
      }
      function poll() {
        /* A receipt decides whether money moved, so it is read the way the
           escrow is: every endpoint is asked, and two answers have to agree.
           One node that has the block while another has not yet is not a
           disagreement to act on - the question is simply asked again. */
        rpcQuorum('eth_getTransactionReceipt', [hash]).then(function (rc) {
          if (rc && rc.blockNumber) {
            if (String(rc.status).toLowerCase() === '0x0') return reject(new Error('the transaction failed on chain'));
            return resolve(rc);
          }
          again();
        }, function (e) {
          if (e && e.disagree) return again();
          again(e);
        });
      }
      poll();
    });
  }

  /* ---------------------------------------------------- wallet actions --- */
  function busy(on) { S.busy = !!on; render(); }

  /* One tap, one operation. A slow phone, or a finger that lands twice, must
     not put two locks on the same USDT or two claims on the same escrow: the
     second tap is refused here, before anything is built or sent, and the
     first one decides what happens next. */
  function opStart(kind) {
    if (S.op) return false;
    S.op = kind;
    return true;
  }
  function opEnd() { S.op = ''; }
  function opWait() { toast('One moment: the last tap is still on its way.'); }

  function lockCall() {
    return { to: escrowNow(), data: lockCalldata({ hashlock: S.H, timelock: S.t2, receiver: S.addr, token: tokenNow(), amount: usdtUnits() }) };
  }
  function approveCall() { return { to: tokenNow(), data: approveCalldata(S.contract, usdtUnits()) }; }

  /* What a person carries to another wallet app when there is no wallet in the
     page: the call, typed out, so nothing has to be trusted to a link. */
  function callPacket(call, what) {
    return JSON.stringify({
      what: what, network: curChain().label, chainId: curChain().chainId,
      to: call.to, value: '0', data: call.data
    }, null, 2);
  }
  /* An EIP-681 link for the same call, for wallets that take one. */
  function callLink(call, fn, params) {
    var q = params && params.length ? '?' + params.join('&') : '';
    return 'ethereum:' + call.to + '@' + curChain().chainId + '/' + fn + q;
  }
  /* The two calls that close a swap, as the links a wallet app can take: the
     claim carries the id and the secret, the refund only the id. They are what
     a phone without `window.ethereum` uses - the copy button says the same
     call, this one hands it over, and the transaction hash comes back the way
     every hand-off in this app does. */
  function claimWalletLink(pre, id) {
    return callLink({ to: escrowNow(), data: claimCalldata(id, '0x' + normHex(pre)) }, 'claim', [
      'bytes32=0x' + normHex(id), 'bytes32=0x' + normHex(pre)
    ]);
  }
  function refundWalletLink(id) {
    return callLink({ to: escrowNow(), data: refundCalldata(id) }, 'refund', [
      'bytes32=0x' + normHex(id)
    ]);
  }
  /* Written again whenever the waiting screen is painted: the id is computed
     from the terms, and the claim cannot be written until its secret is in the
     field, so a link that is on screen is always the call those words describe. */
  function paintCallLinks() {
    var cl = $('claimLink'), rl = $('refundLink');
    if ((!cl || cl.hidden) && (!rl || rl.hidden)) return;
    if (!isAddr(escrowNow())) return;
    swapIdNow().then(function (id) {
      if (rl && !rl.hidden) rl.setAttribute('href', refundWalletLink(id));
      if (cl && !cl.hidden) {
        var pre = normHex($('secretIn').value || '');
        cl.setAttribute('href', claimWalletLink(pre, id));
      }
    }, function () { /* no complete terms yet: nothing to open */ });
  }

  function blockChain(c) {
    var msg = chainSay(c);
    log('BLOCK', msg, 'c-err');
    S.note = msg;
    render();
    // the sentence a person reads is #say on the form, #payLine on a running swap
    if (S.phase === 'idle') {
      var say = $('say');
      say.textContent = msg;
      say.className = 'say err';
      $('stateTxt').textContent = 'Not ready';
      $('stateTxt').dataset.on = '0';
    }
    toast(msg);
  }

  /* The Approve tap, in both modes. Nothing moves on the tap itself: the USDT
     has to be in the escrow before the bitcoin leg is worth starting - this
     side locks it, or the other side already did. */
  function startSwap() {
    if (S.mode === 'wallet' && !isAddr(S.contract)) { openSetup(); log('BLOCK', 'no escrow contract is set for this chain', 'c-err'); toast('Set the escrow contract first'); return; }
    busy(true);
    return chainProbe().then(function () {
      if (S.rpcState === 'nocon') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'nothing answers at the escrow address', 'c-err');
        openSetup();
        toast('No contract answers at that address');
        return null;
      }
      if (S.rpcState === 'nohtlc') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'that address is not the swap contract, so nothing is approved', 'c-err');
        openSetup();
        toast('That address is not the swap contract');
        return null;
      }
      if (S.rpcState === 'bad') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'the chain did not answer, so nothing is approved', 'c-err');
        toast('The chain did not answer. Nothing was approved.');
        return null;
      }
      if (S.rpcState === 'unclear') {
        busy(false);
        dropSwapTerms();
        log('BLOCK', 'the endpoints disagree about the escrow, so nothing is approved', 'c-err');
        toast('The two endpoints disagree about the escrow. Nothing was approved.');
        return null;
      }
      simSeed();
      return refreshChain();
    }).then(function (c) {
      if (!c) { render(); return; }
      busy(false);
      var st = c.state;
      if (st === 'claimed') { settleByChain(c); return; }
      if (st === 'refunded') { wentBack(c); return; }
      if (st === 'error') { blockChain(c); dropSwapTerms(); return; }
      if (S.direction === 'btc2u') {
        if (st === 'locked') { beginPaying(c); return; }
        /* 'none' is not a refusal: the partner has not locked yet, and the
           terms are what both sides are converging on. They stay, so the next
           tap reads the same escrow the first one described. */
        blockChain(c);
        return;
      }
      if (st === 'locked' || st === 'closed') { lockedMine(c); return; }   /* already locked: pick it up from here */
      if (st === 'mismatch') { blockChain(c); dropSwapTerms(); return; }
      beginLocking();
    });
  }

  function beginPaying(c) {
    S.phase = 'paying';
    S.note = '';
    keepSwapMeta();
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT for this swap');
    log('PAY', S.direction === 'btc2u'
      ? 'waiting for the sats to leave the wallet'
      : 'waiting for the USDT to be taken');
    render();
    refreshGate();
    toast('The USDT is locked. Pay, then tap I paid');
  }

  function beginLocking() {
    if (quoteMissing()) { refuseRate(); return; }
    S.phase = 'locking';
    S.note = '';
    /* The next thing that happens is another app: the wallet opens, and while
       it is in front this page can be killed. The terms are put away first. */
    keepSwapMeta();
    var p = provider();
    log('LOCK', 'one call puts ' + usdtTxt() + ' USDT in the escrow');
    render();
    if (S.mode === 'practice') { simLock(); return; }   /* no wallet here: the stand-in signs for it */
    if (!p) { toast('Copy the call into your wallet, then paste the transaction'); return; }
    runLock(p);
  }

  function runLock(p) {
    /* The approvals and the lock are one operation with a wallet: a second tap
       while the first is still being sent would ask for them all again. */
    if (S.sending) { opWait(); return; }
    /* Last line before real USDT moves: a swap whose amount came from the
       offline guess is not sent to a wallet at all. */
    if (quoteMissing()) { walletFail(rateError()); return; }
    S.sending = true;
    var amount = BigInt(usdtUnits());
    /* An approval is a transaction too: the next step only exists once it is
       mined, and a token that already allows this escrow something treats a
       second non-zero approval as a refusal, so a stale allowance is cleared to
       zero first and the new one is then exact. */
    function approveTo(v, why) {
      log('APPROVE', why);
      /* The chain is read once more here, because the approval was asked for
         some time after the switch: a wallet moved to another network in
         between would put the allowance on that chain's contract instead. */
      return assertChain(p).then(function () {
        return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: tokenNow(), data: approveCalldata(S.contract, v), value: '0x0' }] });
      }).then(function (h) {
        if (!h) throw new Error('the wallet sent nothing');
        return waitReceipt(h);
      });
    }
    busy(true);
    ensureChain(p)
      .then(function () { return p.request({ method: 'eth_requestAccounts' }); })
      .then(function (accts) {
        S.me = accts && accts[0] ? String(accts[0]) : '';
        if (!S.me) throw new Error('the wallet shared no account');
        /* The switch was requested a moment ago; the wallet is read again
           before anything is asked of it, so a person who changed networks in
           that moment is stopped before an approval goes out. */
        return assertChain(p).then(function () {
          /* What the token already allows is a state the money depends on, so it
             is read the way the escrow is: every endpoint, and two answers that
             agree before either is believed. */
          return rpcQuorum('eth_call', [{ to: tokenNow(), data: '0x' + SEL.allowance + encAddr(S.me) + encAddr(S.contract) }, 'latest']);
        });
      })
      .then(function (raw) {
        var w = abiWords(raw);
        var have = w.length ? BigInt('0x' + w[0]) : 0n;
        if (have >= amount) return null;
        if (have > 0n) {
          return approveTo(0, 'an old allowance is reset to nothing first, so the next one is exact')
            .then(function () { return approveTo(amount, 'the wallet is asked to allow ' + usdtTxt() + ' USDT'); });
        }
        return approveTo(amount, 'the wallet is asked to allow ' + usdtTxt() + ' USDT');
      })
      .then(function () {
        log('LOCK', 'the wallet is asked for the lock');
        /* The last look before the money moves: between the approval and this
           call the wallet can be switched to another network, and the same
           lock calldata there is a lock on that chain's contract at this
           chain's escrow address - or on nothing. */
        return assertChain(p).then(function () {
          return p.request({ method: 'eth_sendTransaction', params: [{ from: S.me, to: S.contract, data: lockCall().data, value: '0x0' }] });
        });
      })
      .then(function (h) {
        if (!h) throw new Error('the wallet sent nothing');
        S.lockTx = String(h);
        log('TX', 'lock sent');
        busy(true);
        return waitReceipt(h);
      })
      .then(function (rc) {
        /* The escrow's Locked event names the address it saw as its sender.
           When that is not the account the wallet handed this page (a smart
           contract wallet, a relayer), the event is the address that funded
           the swap, and the id is built from it. */
        var ev = readLockedLog(rc);
        if (ev && lockedLogFits(ev)) {
          S.funder = ev.sender;
          if (normHex(ev.sender) !== normHex(S.me)) {
            log('LOCK', 'the escrow was funded from ' + short(ev.sender, 6) + ', read from its Locked event');
          }
        }
        busy(false);
        return refreshChain();
      })
      .then(function (c) { S.sending = false; lockedMine(c); })
      .catch(function (e) { S.sending = false; busy(false); walletFail(e); });
  }

  function walletFail(e) {
    var m = String((e && e.message) || e || '');
    var say = (e && e.chainSwitched) ? 'Your wallet moved to another network, so nothing was sent. Switch it back to ' +
        curChain().label + ', then tap again.'
      : /denied|rejected|cancel/i.test(m) ? 'Nothing was sent: the wallet was not confirmed.'
      : /insufficient|balance|allowance/i.test(m) ? 'That wallet does not hold enough USDT for this swap.'
        : (e && e.quoteDisagrees) ? 'The two BTC price quotes disagree, so nothing was locked: a swap is not priced from a rate the market does not agree on.'
        : (e && e.noQuote) ? 'The live BTC price has not arrived, so nothing was locked: a swap is not priced by a guess.'
        : /already in flight/i.test(m) ? 'That call is already on its way, so nothing was sent twice.'
          : 'The wallet did not finish, so nothing has moved.';
    log('ERR', say, 'c-err');
    render();
    toast(say);
  }

  /* This side's own lock is in: the USDT is escrowed and the swap is now the
     other side's move. */
  function lockedMine(c) {
    if (c && c.state === 'claimed') { settleByChain(c); return; }
    if (c && c.state === 'refunded') { wentBack(c); return; }
    if (!c || (c.state !== 'locked' && c.state !== 'closed')) { blockChain(c); return; }
    S.phase = 'paid';
    S.note = c.state === 'closed' ? 'The escrow window has closed. The USDT can be taken back.' : '';
    keepSwapMeta();
    log('LOCK', 'the escrow holds ' + usdtTxt() + ' USDT until ' + clock(S.t2) + ' local');
    render();
    refreshGate();
    startWatch();
    toast('Your USDT is locked');
  }

  function wentBack(c) {
    S.phase = 'refunded';
    stopWatch();
    dropSwapMeta();
    log('REFUND', 'the escrow sent the ' + usdtTxt() + ' USDT back', 'c-err');
    render();
    refreshGate();
  }

  /* The payment secret is the one value that opens the bitcoin leg. It lives
     in this page only while the swap it belongs to is running: a swap that
     settled, a refund, Back, or a reset leaves neither the state nor the field
     holding it, so the next swap cannot be claimed with the last one's. */
  function clearSecret() {
    S.secret = '';
    var s = $('secretIn'); if (s) { s.value = ''; }
  }

  /* Settled means the escrow said so. Nothing else reaches this function. */
  function settleByChain(c) {
    if (!c || c.state !== 'claimed') { blockChain(c); return; }
    S.phase = 'settled';
    S.claimTx = '';
    dropSwapMeta();
    /* The swap this secret opened is over: neither the page nor the field
       keeps it for the next one. */
    clearSecret();
    swapIdNow().then(function (id) { S.id = id; }, function () { /* terms gone */ });
    log('CLAIM', 'the escrow paid out ' + usdtTxt() + ' USDT');
    log('SETTLE', 'both legs closed on the same secret, verified on chain');
    if (S.mode === 'wallet') {
      historyEntry('Swap', S.direction === 'btc2u' ? '+' + usdtTxt() + ' USDT' : '+' + fmt(S.sats) + ' sats', 'plus');
    }
    stopWatch();
    render();
    refreshGate();
    toast('Swap complete');
  }

  /* One poll of a running swap: the chain's clock first, then the escrow. A
     window is measured against the chain, and that reading is only good for 45
     seconds; without asking again here, a swap that runs longer than a minute
     would quietly measure its window against the phone's own clock, and a
     phone whose clock is off would see the window close early or late. */
  function watchOnce() {
    if (S.phase !== 'paid') { stopWatch(); return Promise.resolve(null); }
    return syncChainTime(true).then(function () { return refreshChain(); }).then(function (c) {
      if (!c) return c;
      if (c.state === 'claimed') settleByChain(c);
      else if (c.state === 'refunded') wentBack(c);
      return c;
    });
  }
  function startWatch() {
    stopWatch();
    var every = S.mode === 'practice' ? 1200 : 12000;
    S.watch = setInterval(watchOnce, every);
    simClaim();
  }
  function stopWatch() {
    if (S.watch) { clearInterval(S.watch); S.watch = 0; }
  }

  /* ------------------------------------------------------ claim / refund -- */
  /* The secret is checked here before it is offered to the chain:
     SHA-256 of what was pasted has to be the hash this swap was locked with,
     so a typo cannot burn a transaction. */
  function doClaim() {
    var pre = normHex(S.secret);
    if (!/^[0-9a-f]{64}$/.test(pre)) { toast('Paste the 32-byte payment secret'); return; }
    /* One claim at a time: the secret is hashed, the escrow is read and a
       wallet is asked, and a second tap in the middle of that would ask for
       the whole thing again. */
    if (!opStart('claim')) { opWait(); return; }
    busy(true);
    sha256Hex(pre).then(function (h) {
      busy(false);
      if (normHex(h) !== normHex(S.H)) {
        log('BLOCK', 'that secret is not the one this swap was locked with', 'c-err');
        render();
        toast('That secret does not open this swap');
        return;
      }
      /* The stand-in escrow takes the same secret and the same reading closes
         the swap, so a rehearsal cannot be claimed with a wrong secret. */
      if (S.mode === 'practice') {
        if (!S.simRec) { blockChain({ state: 'none' }); return; }
        S.simRec.claimed = true;
        return refreshChain().then(function (c) {
          if (c && c.state === 'claimed') settleByChain(c); else blockChain(c);
        });
      }
      return swapIdNow().then(function (id) {
        var call = { to: escrowNow(), data: claimCalldata(id, '0x' + pre) };
        S.txPending = { kind: 'claim', call: call };
        var p = provider();
        if (!p) { render(); copy(callPacket(call, 'claim'), 'Claim call copied'); return; }
        busy(true);
        /* Returned, so this tap's operation is still held while the wallet and
           the chain work: the promise the lock was taken around is the one that
           ends with the receipt, not the one that built the call. */
        return walletSend(call.to, call.data)
          .then(function (h) { if (!h) throw new Error('the wallet sent nothing'); busy(true); return waitReceipt(h); })
          .then(function () { busy(false); return refreshChain(); })
          .then(function (c) { if (c && c.state === 'claimed') settleByChain(c); else blockChain(c); })
          .catch(function (e) { busy(false); walletFail(e); });
      });
    }, function () { busy(false); toast('That secret cannot be read'); })
      .then(opEnd, function () { opEnd(); busy(false); });
  }

  function doRefund() {
    /* One refund at a time, for the same reason as one claim. */
    if (!opStart('refund')) { opWait(); return; }
    busy(true);
    swapIdNow().then(function (id) {
      var call = { to: escrowNow(), data: refundCalldata(id) };
      S.txPending = { kind: 'refund', call: call };
      busy(false);
      if (S.mode === 'practice') {
        if (S.simRec) S.simRec.refunded = true;
        refreshChain().then(function (c) { if (c && c.state === 'refunded') wentBack(c); else blockChain(c); });
        return;
      }
      var p = provider();
      if (!p) { render(); copy(callPacket(call, 'refund'), 'Refund call copied'); return; }
      busy(true);
      /* Returned for the same reason as a claim: the lock this tap took is let
         go when the transaction has an answer, not when its call was built. */
      return walletSend(call.to, call.data)
        .then(function (h) { if (!h) throw new Error('the wallet sent nothing'); busy(true); return waitReceipt(h); })
        .then(function () { busy(false); return refreshChain(); })
        .then(function (c) {
          if (c && c.state === 'refunded') wentBack(c);
          else blockChain(c);
        })
        .catch(function (e) { busy(false); walletFail(e); });
    }, function () { busy(false); toast('These terms are not readable yet'); })
      .then(opEnd, function () { opEnd(); busy(false); });
  }

  /* A transaction hash pasted back from a wallet that cannot be reached from
     the page: the receipt is the proof, and the reading after it decides. */
  function loadTx(hash) {
    var h = String(hash || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) { toast('Paste the transaction hash'); return; }
    busy(true);
    /* Set when this transaction was refused as this swap's lock: the reading
       after it must not then explain a missing window, because nothing is
       missing - the transaction is not the lock. */
    var refused = false;
    var waited = S.mode === 'practice' ? simReceipt() : waitReceipt(h);
    waited.then(function (rc) {
      busy(false);
      /* The id names the address that funded the escrow. The side that does
         not fund it learns that address from the lock transaction itself,
         after checking that the escrow recorded this swap's terms. */
      if (S.mode !== 'wallet' || isAddr(lockerNow())) return null;
      /* The escrow's own Locked event is the address it saw as msg.sender. A
         smart contract wallet (a Safe, an account-abstraction wallet) is that
         sender, while the transaction's `from` is only the key or bundler that
         relayed it - so the event is the one thing read, and a receipt without
         it names no funder at all. */
      var ev = readLockedLog(rc);
      if (ev) {
        if (!lockedLogFits(ev)) {
          log('BLOCK', 'that transaction locked different terms, so its address is not this swap\u2019s', 'c-err');
          render();
          toast('That transaction is not the lock for this swap');
          return null;
        }
        S.funder = ev.sender;
        S.lockTx = h;
        log('LOCK', 'the escrow was funded from ' + short(ev.sender, 6) + ', read from its Locked event');
        keepSwapMeta();
        /* The event is also where the terms come back when no swap code ever
           reached this phone: the window's end is written in it, and the
           hashlock and receiver the fit check just verified against this
           screen's invoice and address can be carried into the swap, so the
           escrow can be read at all. A side without them used to be shown a
           chain error that was really a missing code. */
        var t = termsOnScreen();
        if (!S.H && t.H) S.H = t.H;
        if (!S.addr && isAddr(t.addr)) S.addr = t.addr;
        if (!S.t2 && Number(ev.timelock) > 0) {
          S.t2 = Number(ev.timelock);
          if (!S.t1) S.t1 = curHeight() + T1_BLOCKS;
          log('CODE', 'no swap code was loaded, so the window came from the escrow\u2019s own event: ends ' + clock(S.t2));
        }
        return null;
      }
      /* No Locked event from this escrow, no funder. A receipt's `from` is the
         key or bundler that relayed the call, not the address the escrow saw as
         msg.sender - a smart contract wallet is the sender while the relaying
         key is only `from` - so a lock is read from the escrow's own event and
         from nothing else. A transaction whose receipt carries no such event is
         not read as this swap's lock. */
      log('BLOCK', 'that transaction carries no lock event from the escrow', 'c-err');
      render();
      toast('That transaction is not the lock for this swap');
      refused = true;
      return null;
    }).then(function () {
      /* The escrow is read with the terms, and without them there is no id
         to read under. Say what is missing instead of showing a chain
         connection error that would only send the person looking at the
         wrong thing. */
      if (refused) return null;
      if (!S.t2) {
        var msg = 'The terms are incomplete: load the swap code from your partner first.';
        log('CODE', 'the escrow cannot be read without the terms a swap code carries', 'c-err');
        S.note = msg;
        render();
        toast(msg);
        return null;
      }
      return refreshChain();
    }).then(function (c) {
      if (!c) return;
      if (S.phase === 'locking') { lockedMine(c); return; }
      if (c.state === 'claimed') settleByChain(c);
      else if (c.state === 'refunded') wentBack(c);
      else if (c.state === 'locked') { render(); toast('The escrow has it'); }
      else blockChain(c);
    }, function (e) {
      busy(false);
      log('ERR', 'that transaction is not on chain yet', 'c-err');
      render();
      toast('That transaction is not on chain yet');
    });
  }
