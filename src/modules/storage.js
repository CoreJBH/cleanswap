  /* storage.js - the setup, and the swap a killed page can pick up again */
  /* The setup is the one thing worth remembering between launches: a contract
     address typed once is a contract address forever - on the chain it was
     typed for. Two networks mean two escrows, two tokens and two endpoint
     lists, and what was typed on one is never read while the other is
     selected: a mainnet escrow address does not become a testnet one, and a
     private endpoint for one chain is not asked about the other. */
  function blankSetup() { return { contract: '', token: '', rpc: '' }; }
  function cleanSetup(one) {
    one = one || blankSetup();
    return {
      contract: isAddr(one.contract) ? String(one.contract).toLowerCase() : '',
      token: isAddr(one.token) ? String(one.token).toLowerCase() : '',
      rpc: endpointsOk(one.rpc) ? String(one.rpc) : ''
    };
  }
  function loadSetup() {
    try {
      var raw = window.localStorage && localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var j = JSON.parse(raw) || {}, net;
      if (j.net === 'testnet' || j.net === 'mainnet') S.net = j.net;
      S.setups = { testnet: blankSetup(), mainnet: blankSetup() };
      if (j.nets) {
        for (net in S.setups) if (j.nets[net]) S.setups[net] = cleanSetup(j.nets[net]);
      } else {
        /* The first spelling kept one setup with no network attached to it.
           It was written while one network was selected, so it belongs to
           that one and to no other. */
        S.setups[S.net] = cleanSetup(j);
      }
      applySetup();
    } catch (e) { /* a browser without storage simply forgets the setup */ }
  }
  /* The three fields the screen and the chain calls read are always the ones
     the selected network owns. */
  function applySetup() {
    var one = (S.setups && S.setups[S.net]) || blankSetup();
    S.contract = one.contract;
    S.token = one.token;
    S.rpc = one.rpc;
  }
  /* What is on screen is put away under the network it was typed for. */
  function keepSetup() {
    if (!S.setups) S.setups = { testnet: blankSetup(), mainnet: blankSetup() };
    S.setups[S.net] = cleanSetup({ contract: S.contract, token: S.token, rpc: S.rpc });
  }
  function saveSetup() {
    keepSetup();
    try {
      if (window.localStorage) localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        net: S.net, nets: S.setups
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------- a swap that outlives the page --
     An external wallet is another app. The phone switches to it, and while it
     is in front Android may kill this WebView; when the person comes back the
     page starts again with nothing - no terms, no window, no lock transaction,
     no hash - while the USDT may already be in the escrow. That is the one way
     a real swap can be lost after the money has moved.

     So the terms of a running swap are put away here, in one localStorage key,
     and read back when the page starts again. What is written is what a
     recovery needs and nothing more: the swap's identity, its window, its
     amount, the addresses it names and the transactions it has. The payment
     secret - the 32 bytes that open the escrow - is never written. It is not
     part of the terms, it is the money; a page that comes back without it can
     still read the escrow, refund, or wait for a claim with the secret the
     other side holds.

     A practice swap is never written: its escrow is a stand-in that died with
     the page it lived in. The record is removed the moment its swap is over -
     settled, refunded, Back or a reset - and one whose swap never ended is
     dropped after SWAP_KEEP days so a stale key cannot put an old window on a
     new screen. */
  var SWAP_KEY = 'cleanswap.swap.v1';
  var SWAP_KEEP = 30 * 24 * 3600;   /* days a recorded swap may still be picked up */
  var SWAP_PHASES = { locking: 1, paying: 1, paid: 1 };

  function swapMetaNow() {
    if (S.mode !== 'wallet' || !SWAP_PHASES[S.phase]) return null;
    if (!S.H && !S.lockTx) return null;
    return {
      v: 1, at: nowSec(),
      net: S.net, direction: S.direction, phase: S.phase,
      sats: S.sats, units: S.units, H: S.H || null, id: S.id || null,
      t1: S.t1, t2: S.t2, addr: S.addr, inv: S.inv,
      locker: S.locker || '', funder: S.funder || '',
      lockTx: S.lockTx || '', claimTx: S.claimTx || '',
      contract: S.contract, token: S.token
    };
  }

  /* Written when a swap starts and when its state moves; the secret is not in
     it, because swapMetaNow() has no field for it. */
  function keepSwapMeta() {
    var rec = swapMetaNow();
    if (!rec) return;
    try { if (window.localStorage) localStorage.setItem(SWAP_KEY, JSON.stringify(rec)); } catch (e) { /* no storage, no recovery */ }
  }

  function dropSwapMeta() {
    try { if (window.localStorage) localStorage.removeItem(SWAP_KEY); } catch (e) { /* ignore */ }
  }

  function readSwapMeta() {
    try {
      var raw = window.localStorage && localStorage.getItem(SWAP_KEY);
      if (!raw) return null;
      var j = JSON.parse(raw);
      return j && j.v === 1 ? j : null;
    } catch (e) { return null; }
  }

  /* A record is only acted on when it is one this page can still act on: the
     version it was written in, a phase that is still running, a window, a
     hashlock and an amount that are still shaped like one, and a lifetime
     short enough that its escrow can still be read. */
  function swapMetaFits(rec) {
    if (!rec || rec.v !== 1) return false;
    if (!SWAP_PHASES[rec.phase]) return false;
    if (!(Number(rec.at) > 0) || nowSec() - Number(rec.at) > SWAP_KEEP) return false;
    if (!(Number(rec.t2) > 0) || !(Number(rec.units) > 0)) return false;
    if (!rec.H && !rec.lockTx) return false;
    if (rec.H != null && !/^[0-9a-f]{64}$/i.test(normHex(rec.H))) return false;
    if (rec.lockTx && !/^0x[0-9a-f]{64}$/i.test(String(rec.lockTx))) return false;
    return true;
  }

  /* The terms go back on the screen and into the fields the page reads them
     from, so every gate judges the same swap it judged before the page died.
     The escrow and the token have to be the ones still set for this network:
     a record whose escrow is another address is not read here at all, because
     the money it describes lives somewhere this page is not pointed at. */
  function restoreSwap() {
    var rec = readSwapMeta();
    if (!rec || !swapMetaFits(rec)) return null;
    if (rec.net !== S.net) return null;
    if (String(rec.contract || '').toLowerCase() !== String(S.contract || '').toLowerCase()) return null;
    S.phase = rec.phase;
    S.direction = rec.direction === 'u2b' ? 'u2b' : 'btc2u';
    S.sats = Number(rec.sats) > 0 ? Number(rec.sats) : S.sats;
    S.units = Number(rec.units);
    S.H = rec.H ? '0x' + normHex(rec.H) : null;
    S.id = rec.id ? String(rec.id) : null;
    S.t1 = Number(rec.t1) > 0 ? Number(rec.t1) : null;
    S.t2 = Number(rec.t2);
    S.addr = isAddr(rec.addr) ? String(rec.addr) : '';
    S.inv = typeof rec.inv === 'string' ? rec.inv : '';
    S.invDec = null;
    S.basis = 'invoice';
    S.locker = isAddr(rec.locker) ? String(rec.locker) : '';
    S.funder = isAddr(rec.funder) ? String(rec.funder) : '';
    S.lockTx = rec.lockTx ? String(rec.lockTx) : '';
    S.claimTx = rec.claimTx ? String(rec.claimTx) : '';
    S.note = 'This swap was picked up again after the page was closed.';
    var a = invIn(); if (a && S.inv) a.value = S.inv;
    var b = addrEl(); if (b && S.addr) b.value = S.addr;
    var t = $('lockTxIn'); if (t && S.lockTx) t.value = S.lockTx;
    log('RESUME', 'the swap this page was in the middle of is back: ' +
      (S.direction === 'btc2u' ? fmt(S.sats) + ' sats for ' + usdtTxt() + ' USDT' : usdtTxt() + ' USDT for ' + fmt(S.sats) + ' sats'));
    return rec;
  }

  /* A page that has just started does not know what the chain did while it was
     gone, so the swap is read once before the screen is trusted: a claim or a
     refund that landed meanwhile settles it now, and a swap still waiting is
     watched from here. */
  function resumeSwap() {
    var rec = restoreSwap();
    if (!rec) return null;
    render();
    refreshGate();
    if (S.phase === 'paid') startWatch();
    toast('The swap you were in the middle of is back.');
    return syncChainTime(true).then(refreshChain).then(function (c) {
      if (!c) { render(); return null; }
      if (c.state === 'claimed') { settleByChain(c); return c; }
      if (c.state === 'refunded') { wentBack(c); return c; }
      render();
      return c;
    }, function () { render(); return null; });
  }
