  /* render.js - the three-step screen and the gate under it */
  /* ------------------------------------------------------------ render --- */
  function usdtLine() { return usdtOf() ? usdtTxt() + ' USDT' : '\u2014 USDT'; }

  function render() {
    var sendBtc = S.direction === 'btc2u';
    var done = S.phase === 'settled' || S.phase === 'refunded';
    var paying = S.phase === 'paying';
    var locking = S.phase === 'locking';
    var held = S.phase === 'paid';
    var waiting = paying || locking || held;

    document.body.dataset.phase = S.phase;
    document.body.dataset.mode = S.mode;
    document.body.dataset.dir = S.direction;
    document.body.dataset.role = sendBtc ? 'maker' : 'taker';

    $('modePractice').className = S.mode === 'practice' ? 'on' : '';
    $('modeWallet').className = S.mode === 'wallet' ? 'on' : '';
    $('rateDot').className = 'dot ' + (rateKnown() ? 'live' : (S.pstate === 'offline' || S.pstate === 'disagree') ? 'off' : '');
    $('rateTxt').textContent = (S.price ? '1 BTC \u2248 ' + fmt(Math.round(S.price)) + ' USDT' : '1 BTC \u2248 \u2014 USDT') +
      (S.pstate === 'single' ? ' \u00b7 one quote' : S.pstate === 'disagree' ? ' \u00b7 quotes disagree' : '');

    if (sendBtc) {
      $('sendAmt').textContent = fmt(S.sats); $('sendUnit').textContent = 'sats';
      $('sendSub').textContent = '\u2248 ' + usdtLine();
      $('getAmt').textContent = usdtLine().replace(' USDT', ''); $('getUnit').textContent = 'USDT';
      $('getSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
    } else {
      $('sendAmt').textContent = usdtLine().replace(' USDT', ''); $('sendUnit').textContent = 'USDT';
      $('sendSub').textContent = '\u2248 ' + fmt(S.sats) + ' sats';
      $('getAmt').textContent = fmt(S.sats); $('getUnit').textContent = 'sats';
      $('getSub').textContent = '\u2248 ' + usdtLine();
    }

    // step order follows the direction: when you send USDT, the address is step 1
    $('nInv').textContent = sendBtc ? '1' : '2';
    $('nAddr').textContent = sendBtc ? '2' : '1';
    $('stepInv').style.order = sendBtc ? '1' : '2';
    $('stepAddr').style.order = sendBtc ? '2' : '1';
    $('invTitle').textContent = sendBtc ? "Partner's Lightning invoice" : 'Your Lightning invoice';
    $('addrTitle').textContent = sendBtc ? 'Your USDT address' : "Partner's USDT address";

    // the invoice row: pay it when it is the other side's, hand it over when it
    // is yours. The same row is on screen in both modes; only Wallet can reach
    // a wallet with it, so in Practice the hand-off says what mode this is
    // instead of opening one (see the click handler at the bottom).
    $('invRow').hidden = false;
    $('walletLink').hidden = !sendBtc;
    $('copyInv').hidden = sendBtc;
    var inv = readInvoice(pasted());
    $('walletLink').setAttribute('href', inv.ok ? 'lightning:' + String(pasted()).replace(/^lightning:/i, '') : '#');
    $('walletLink').dataset.empty = inv.ok ? '0' : '1';

    /* Bitcoin paid from a wallet that keeps the payment secret cannot be
       claimed back here, so the sentence is on screen before the button. */
    var ih = $('invHint');
    if (ih) {
      ih.hidden = !sendBtc || done || waiting;
      ih.textContent = sendBtc
        ? 'Pay from a wallet that shows the payment secret: it is how you claim the USDT if your partner stops answering.'
        : '';
    }

    $('sampleInv').hidden = S.mode === 'wallet';
    $('sampleAddr').hidden = S.mode === 'wallet';

    /* When the partner's funding address is not known yet, their lock
       transaction is the one thing that supplies it. */
    var needTx = S.mode === 'wallet' && !done && !waiting && S.direction === 'btc2u' && !isAddr(lockerNow()) && !S.lockTx;
    $('lockTxRow').hidden = !needTx;
    $('addrIn').placeholder = S.mode === 'wallet' ? '0x\u2026 on ' + curChain().label : '0x\u2026 or T\u2026';

    $('headRow').hidden = !(done || waiting);
    // the finished swap says it once, in the title and on the receipt
    $('stateTxt').hidden = done;
    $('presets').hidden = done || waiting;
    /* A swap that sends the USDT is the one whose terms the other side still
       needs: the partner pays bitcoin against a code, and on a phone with this
       app that code leaves as a QR or a paste while the USDT is already locked.
       Hiding the row the moment the swap starts would strand that hand-off, so
       Share code and QR stay for the two stages the USDT sits in the escrow.
       A code cannot land on a running swap, so `Use code` goes. */
    var shareLocked = !done && S.mode === 'wallet' && S.direction === 'u2b' && (locking || held);
    $('terms').hidden = (done || waiting) && !shareLocked;
    var pasteBtn = $('terms') && $('terms').querySelector('[data-act="pasteCode"]');
    if (pasteBtn) pasteBtn.hidden = waiting;
    $('codeRow').hidden = done || waiting || $('codeRow').hidden;
    $('steps').hidden = done || waiting;
    $('payBox').hidden = !waiting;
    $('receipt').hidden = !done;
    $('stepTitle').textContent = S.phase === 'settled' ? 'Swap complete'
      : (S.phase === 'refunded' ? 'Swap closed'
        : (paying ? 'Waiting for payment'
          : (locking ? 'Lock your USDT'
            : (held ? (sendBtc ? 'Paid, waiting for the USDT' : 'Your USDT is locked')
              : (sendBtc ? 'Swap bitcoin for USDT' : 'Swap USDT for bitcoin')))));
    $('stepTitle').className = 'q' + (S.phase === 'settled' ? ' done' : '');
    $('primary').textContent = done ? 'Done'
      : (paying ? 'I paid' : (waiting ? 'Check chain' : 'Approve'));
    $('primary').disabled = !!S.busy;
    $('primary').dataset.ready = done || waiting || (S.gate && S.gate.ok) ? '1' : '0';
    if (waiting) paintPay();

    $('stateTxt').textContent = S.phase === 'settled' ? 'Completed'
      : (S.phase === 'refunded' ? 'Refunded'
        : (S.busy ? 'Reading the chain\u2026'
          : (paying ? 'Nothing sent yet'
            : (locking ? 'Not locked yet'
              : (held ? (S.chain && S.chain.state === 'locked' ? 'USDT locked' : 'Waiting')
                : (S.gate && S.gate.ok ? 'Ready to approve'
                  : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready')))))));
    $('stateTxt').dataset.on = done || (!waiting && S.gate && S.gate.ok) || held ? '1' : '0';

    if (done) {
      $('rcSend').textContent = sendBtc ? fmt(S.sats) + ' sats' : usdtTxt() + ' USDT';
      $('rcGet').textContent = S.phase === 'refunded'
        ? (sendBtc ? '\u2014 USDT' : usdtTxt() + ' USDT back')
        : (sendBtc ? usdtTxt() + ' USDT' : fmt(S.sats) + ' sats');
      $('rcAddr').textContent = S.addr || '\u2014';
      $('rcNet').textContent = S.mode === 'practice'
        ? 'Practice \u00b7 simulated'
        : curChain().label + (S.chain && S.chain.state === 'claimed' ? ' \u00b7 paid on chain'
          : (S.chain && S.chain.state === 'refunded' ? ' \u00b7 refunded on chain' : ''));
    }

    renderChain();
    renderLog();
    renderCodeAsk();
  }

  /* The chain line under the rate: which Arbitrum, and whether the escrow
     behind it answers at all. It is on screen in both modes: a rehearsal runs
     against the stand-in escrow, which is always there, so the line never asks
     for a deployment in Practice. */
  function renderChain() {
    var row = $('chainRow');
    if (!row) return;
    row.hidden = false;
    var practice = S.mode === 'practice';
    var c = curChain(), txt = c.label, dot = 'off';
    if (S.busy && !practice) {
      txt += ' \u00b7 reading the chain\u2026';
      dot = '';
    } else if (!practice && !isAddr(S.contract)) {
      txt += ' \u00b7 escrow not set';
    } else if (!practice && S.rpcState === 'bad') {
      txt += ' \u00b7 no answer from the chain';
    } else if (!practice && S.rpcState === 'nocon') {
      txt += ' \u00b7 no contract at that address';
    } else if (!practice && S.rpcState === 'nohtlc') {
      txt += ' \u00b7 not the swap contract';
    } else if (!practice && S.rpcState === 'unclear') {
      txt += ' \u00b7 endpoints disagree';
    } else if (S.chain) {
      if (S.chain.state === 'error') { txt += S.chain.disagree ? ' \u00b7 endpoints disagree' : ' \u00b7 no answer from the chain'; }
      else if (S.chain.state === 'locked') { txt += ' \u00b7 USDT locked'; dot = 'live'; }
      else if (S.chain.state === 'closed') { txt += ' \u00b7 window closed'; }
      else if (S.chain.state === 'claimed') { txt += ' \u00b7 USDT paid out'; dot = 'live'; }
      else if (S.chain.state === 'refunded') { txt += ' \u00b7 USDT returned'; }
      else if (S.chain.state === 'mismatch') { txt += ' \u00b7 not this swap'; }
      else { txt += ' \u00b7 nothing locked yet'; }
    } else {
      txt += practice || S.rpcState === 'ok' ? ' \u00b7 escrow ready' : ' \u00b7 escrow set';
      dot = practice || S.rpcState === 'ok' ? 'live' : 'off';
    }
    /* A reading that was not cross-checked says so on the screen, in one quiet
       line under the chain row (the row itself is too narrow for the sentence). */
    $('chainTxt').textContent = txt;
    $('chainDot').className = 'dot ' + dot;
    var ql = $('quorumLine');
    if (ql) {
      ql.textContent = !practice && S.quorum === 'single'
        ? 'One node answers, so nothing is cross-checked. Add a second RPC endpoint in Setup.' : '';
      ql.hidden = !ql.textContent;
    }
    if (!practice) paintSetup();
  }

  /* The waiting screen: what to send and where, and nothing that claims the
     swap is over before the money has actually moved. */
  function paintPay() {
    var sendBtc = S.direction === 'btc2u';
    var practice = S.mode === 'practice';
    var c = S.chain;
    var line;
    if (S.phase === 'locking') {
      line = practice
        ? 'Lock ' + usdtTxt() + ' USDT in the escrow. The stand-in signs for the wallet here.'
        : (provider()
          ? 'Lock ' + usdtTxt() + ' USDT in the escrow. One tap in your wallet approves the USDT and locks it.'
          : 'Lock ' + usdtTxt() + ' USDT from your wallet: approve the USDT first, then send the lock call.');
    } else if (S.phase === 'paid') {
      line = sendBtc
        ? 'Paid. The USDT is yours once the escrow releases it \u2014 this screen closes the swap when the chain says so.'
        : 'Your USDT is locked. The bitcoin arrives when your partner pays; the swap closes when the escrow pays out.';
    } else {
      line = sendBtc
        ? 'Send ' + fmt(S.sats) + ' sats to this invoice from your wallet, then tap I paid.'
        : 'Send ' + usdtTxt() + ' USDT to this address from your wallet, then tap I paid.';
    }
    $('payLine').textContent = S.note || line;
    $('payEsc').textContent = (practice
      ? 'Practice \u00b7 ' + curChain().label
      : curChain().label + (S.block ? ' \u00b7 block ' + fmt(S.block) : '')) + ' \u00b7 ' + chainSay(c).replace(/^The /, '');
    $('payAddr').hidden = sendBtc || S.phase !== 'paying';
    $('payAddr').textContent = sendBtc ? '' : (S.addr || '\u2014');
    $('payRowInv').hidden = !sendBtc || S.phase === 'locking' || S.phase === 'paid';
    $('payRowAddr').hidden = sendBtc || S.phase !== 'paying';
    $('payWalletLink').setAttribute('href', sendBtc && S.inv ? 'lightning:' + S.inv : '#');

    // the wallet's share of the work: only the call this side still owes.
    // A rehearsal has no wallet to send it, but the same call is on screen.
    var canCopy = isAddr(escrowNow());
    var locking = S.phase === 'locking';
    $('paySend').hidden = practice || !provider() || !locking;
    $('payCopyCall').hidden = !canCopy || !locking;
    $('payLink').hidden = !canCopy || !locking;
    $('payLink').setAttribute('href', canCopy && locking ? callLink(lockCall(), 'lock', [
      'bytes32=0x' + pad64(normHex(S.H)),
      'uint256=' + String(S.t2),
      'address=' + S.addr,
      'address=' + tokenNow(),
      'uint256=' + String(usdtUnits())
    ]) : '#');
    /* Moving USDT from a wallet outside this page is two calls, not one: the
       token has to allow the escrow the amount first, and only then can the
       lock pull it. The approve call is offered exactly the way the lock is -
       copied, or opened as an ethereum: link - so that wallet can do its part
       in the order the token requires. */
    var external = !practice && !provider() && locking && isAddr(tokenNow());
    var arow = $('payRowApprove');
    if (arow) arow.hidden = !external;
    var alink = $('payApproveLink');
    if (alink) {
      alink.hidden = !external;
      alink.setAttribute('href', external ? callLink(approveCall(), 'approve', [
        'address=' + String(S.contract),
        'uint256=' + String(usdtUnits())
      ]) : '#');
    }
    // the secret opens the escrow; whoever holds it can claim, and the app
    // checks that it hashes to this swap before offering it to a wallet. A
    // window that has closed can no longer be claimed, only refunded.
    var open = c && (c.state === 'locked' || c.state === 'closed') && S.phase === 'paid';
    var claimable = c && c.state === 'locked' && S.phase === 'paid';
    $('payRowClaim').hidden = !open;
    $('claimBtn').hidden = !claimable;
    $('refundBtn').hidden = !(open && S.direction === 'u2b' && (!claimable || (S.t2 && effNow() >= S.t2)));
    /* A phone whose wallet is not inside this page still has a wallet app, so
       each of the two calls is offered as an `ethereum:` link beside the button
       that copies it. The claim's link needs the secret checked here first, so
       it appears once a secret is in the field - and it is the same call the
       Claim button would send, never a different one. */
    var noWallet = !practice && !provider();
    var preField = normHex(($('secretIn') || {}).value || '');
    var cl = $('claimLink'), rl = $('refundLink');
    if (cl) cl.hidden = !(noWallet && claimable && /^[0-9a-f]{64}$/.test(preField));
    if (rl) rl.hidden = !(noWallet && !$('refundBtn').hidden);
    paintCallLinks();
    $('secretRow').hidden = !$('secretRow').dataset.open || $('secretRow').dataset.open === '0';

    // The payer has to be able to claim if the partner goes quiet: that takes
    // the payment secret, and only some wallets show it.
    var warn = $('payWarn');
    if (warn) {
      warn.hidden = !sendBtc;
      warn.textContent = sendBtc
        ? 'Pay from a wallet that shows the payment secret: it is how you claim the USDT if your partner stops answering.'
        : '';
    }
  }

  /* The setup panel is the only place a hash or an address is on screen: it is
     for the person who deploys the escrow, not the person swapping. */
  function paintSetup() {
    var box = $('setupBox');
    if (!box || box.hidden) return;
    $('netTest').className = S.net === 'testnet' ? 'on' : '';
    $('netMain').className = S.net === 'mainnet' ? 'on' : '';
    $('contractIn').value = S.contract;
    $('tokenIn').value = S.token || '';
    $('rpcIn').value = S.rpc || '';
    var c = curChain();
    var eps = endpoints().length;
    var cross = eps > 1 ? ' The ' + eps + ' endpoints are cross-checked: the escrow is only believed when two agree.' : '';
    /* What the chain said about the token, in the same panel the token is typed
       in: unread is a sentence, and a token that counts in other decimals is
       never stored, so this line only appears for a setup kept from before. */
    var tokenSay = S.tokenState === 'unread'
      ? ' The token at that address was not read: the chain did not answer.'
      : (S.tokenState === 'wrong'
        ? ' The token set here is not a 6-decimal token, so this swap cannot count with it. Set the right one and Save.'
        : '');
    $('setupHint').textContent = (!isAddr(S.contract)
      ? 'Deploy the escrow once on ' + c.label + ': copy the bytecode, open Remix, deploy, then paste the address here. Everything else stays on this phone.'
      : (S.rpcState === 'ok' ? 'The chain answers and the escrow reads like the swap contract: block ' + fmt(S.block || 0) + '.'
        : (S.rpcState === 'unclear' ? 'The endpoints disagree about that address, so the escrow is not read as ready. Check the endpoints in Setup.'
          : (S.rpcState === 'nocon' ? 'Nothing answers at that address on ' + c.label + '.'
            : (S.rpcState === 'nohtlc' ? 'That address answers, but it is not the swap contract. Check the address in Setup.'
              : (S.rpcState === 'bad' ? 'The chain did not answer. Check the endpoint, then tap Check.'
                : 'Tap Check to read the chain.')))))) + tokenSay + cross;
  }

  function presetsOn() {
    var btns = document.querySelectorAll('#presets [data-act="sats"]'), i, on;
    for (i = 0; i < btns.length; i++) {
      on = Number(btns[i].dataset.v) === Number(S.sats);
      btns[i].className = on ? 'on' : '';
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function renderLog() {
    var ol = $('log');
    ol.innerHTML = '';
    if (!S.log.length) {
      var li = document.createElement('li');
      var t = document.createElement('time'); t.textContent = '--:--:--';
      var b = document.createElement('b'); b.textContent = 'IDLE';
      var s = document.createElement('span'); s.textContent = 'Nothing recorded yet.';
      li.appendChild(t); li.appendChild(b); li.appendChild(s);
      ol.appendChild(li);
      return;
    }
    S.log.forEach(function (e) {
      var li = document.createElement('li');
      if (e.cls) li.className = e.cls;
      var t = document.createElement('time'); t.textContent = e.t;
      var b = document.createElement('b'); b.textContent = e.kind;
      var s = document.createElement('span'); s.textContent = e.text;
      li.appendChild(t); li.appendChild(b); li.appendChild(s);
      ol.appendChild(li);
    });
  }

  /* ------------------------------------------------------------- gate UI -- */
  /* The gate reads the chain, so the answer comes back after the keystroke
     that asked for it. A generation token is taken when the read is scheduled:
     a validation that was already on its way when newer input arrived is
     dropped here instead of painting its answer - an older invoice's verdict
     must never overwrite the gate the newer input earned. */
  var gateTimer, gateGen = 0;
  function refreshGate() {
    clearTimeout(gateTimer);
    var gen = ++gateGen;
    gateTimer = setTimeout(function () {
      validate().then(function (r) {
        if (gen === gateGen) paintGate(r);
      });
    }, 60);
  }

  function paintGate(r) {
    S.gate = r;
    var say = $('say');
    say.textContent = r.msg;
    say.className = 'say' + (r.ok || r.code === 'empty' ? '' : ' err');
    // a running swap has one job per phase, and its button stays lit for it
    $('primary').dataset.ready = r.ok || S.phase !== 'idle' ? '1' : '0';
    var f = r.fields || {};
    markField(invIn(), f.invoice, r.ok);
    markField(addrEl(), f.address, r.ok);
    if (S.phase === 'idle') {
      $('stateTxt').textContent = r.ok ? 'Ready to approve' : (readInvoice(pasted()).ok ? 'Invoice ready' : 'Ready');
      $('stateTxt').dataset.on = r.ok ? '1' : '0';
    }
  }

  function markField(el, res, allOk) {
    if (!el) return;
    if (allOk) { el.dataset.state = 'ok'; return; }
    if (!res || res.ok || res.code === 'empty') { el.dataset.state = ''; return; }
    el.dataset.state = 'err';
  }

  function shake() {
    var say = $('say');
    say.classList.remove('shake');
    void say.offsetWidth;
    say.classList.add('shake');
  }
  function needInvoice() {
    toast('Paste the invoice first, then this opens.');
    shake();
  }
