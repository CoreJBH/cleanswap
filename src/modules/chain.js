  /* chain.js - the swap id, the chain and its endpoints, the clock, escrow ABI and reads */
  /* ------------------------------------------------ sha256 swap identity -- */
  function writeU256(buf, off, val) {
    var b = BigInt(val), i;
    for (i = 0; i < 32; i++) buf[off + 31 - i] = Number((b >> BigInt(8 * i)) & 255n);
  }
  /* mirrors computeSwapId() in the contract:
     sha256(abi.encodePacked(hashlock, sender, receiver, token, amount, timelock)).
     The sender — the address that funds the escrow — is in it, so a third party
     who copies the terms cannot lock them first and burn the id by refunding:
     their own address gives the same terms a different id. The side that does
     not fund the escrow learns that address from the other side's code (or
     from its lock transaction) and then computes the same id off-line. */
  function computeSwapId(hashlock, sender, receiver, token, amount, timelock) {
    var buf = new Uint8Array(156);
    buf.set(fromHex(hashlock), 0);
    buf.set(addr20(sender), 32);
    buf.set(addr20(receiver), 52);
    buf.set(fromHex(token), 72);
    writeU256(buf, 92, amount);
    writeU256(buf, 124, timelock);
    return crypto.subtle.digest('SHA-256', buf).then(function (d) { return '0x' + hexOf(new Uint8Array(d)); });
  }

  /* Who funds the USDT escrow: this side when it sends USDT, the other side
     when it receives it. A rehearsal funds it from its stand-in address. The
     escrow's own Locked event wins over anything this side worked out: with a
     smart contract wallet the funding address is the contract the escrow saw,
     not the key that sent the transaction. */
  function lockerNow() {
    if (S.mode === 'practice') return EVM.usdtSide;
    if (isAddr(S.funder)) return String(S.funder).toLowerCase();
    return S.direction === 'u2b' ? String(S.me || '') : String(S.locker || '');
  }

  /* The wallet account this side signs with, asked for once. Wallets answer
     `eth_accounts` silently after a connection and prompt only when there is
     none; a refusal leaves the address unknown and the swap unreadable. */
  function ensureMe() {
    if (S.me) return Promise.resolve(true);
    var p = provider();
    if (S.mode !== 'wallet' || !p) return Promise.resolve(false);
    return p.request({ method: 'eth_accounts' }).then(function (a) {
      if (a && a[0]) { S.me = String(a[0]); return true; }
      return p.request({ method: 'eth_requestAccounts' }).then(function (b) {
        if (b && b[0]) { S.me = String(b[0]); return true; }
        return false;
      }, function () { return false; });
    }, function () { return false; });
  }

  /* ------------------------------------------------------------ the chain --
     Wallet mode's USDT leg is a real HTLC on Arbitrum. Everything the screen
     says about it comes from here: one JSON-RPC client, the escrow ABI, and
     the reading of `swaps(id)`. Nothing in this section believes the phone;
     the chain is the only thing that can say USDT moved. */
  function curChain() { return CHAINS[S.net] || CHAINS.testnet; }
  /* https, and http only for a node on this device: a local node speaks plain
     http, and anything further away has no business being typed in here. */
  function isEndpoint(u) {
    var t = String(u || '');
    return /^https:\/\/[^\s]+$/i.test(t) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/i.test(t);
  }
  /* Setup takes one endpoint or several, separated by commas or spaces. More
     than one is a cross-check: the escrow is only believed when two of them
     answer the same thing.

     The list is deduplicated before it is used, because the cross-check counts
     answers, not strings: the same URL typed twice - padded with a space, a
     trailing slash, or spelled in another case - is still one node, and two
     answers from one node would let that node alone decide what the escrow
     says. The comparison is on the trimmed, lower-cased address with a
     trailing slash dropped, which is the same endpoint however it is spelled;
     the spelling the person typed is what the list keeps, so the calls and the
     wallet's chain setup still go to the address as it was written. */
  function endpointKey(u) {
    return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
  }
  function endpointList(raw) {
    var parts = String(raw == null ? '' : raw).split(/[\s,]+/), out = [], seen = {}, i, k;
    for (i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      k = endpointKey(parts[i]);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(parts[i]);
    }
    return out;
  }
  function endpointsOk(raw) {
    var list = endpointList(raw);
    for (var i = 0; i < list.length; i++) if (!isEndpoint(list[i])) return false;
    return true;
  }
  /* An escrow the app publishes for this chain. A code may point at one of
     these on its own; any other address has to be typed in Setup by the person
     who deploys it. */
  function isOfficialEscrow(net, addr) {
    var list = (CHAINS[net] && CHAINS[net].escrows) || [], a = String(addr || '').toLowerCase();
    for (var i = 0; i < list.length; i++) if (String(list[i]).toLowerCase() === a) return true;
    return false;
  }
  function tokenNow() { return S.mode === 'practice' ? EVM.token : (S.token || curChain().token); }
  function escrowNow() { return S.mode === 'practice' ? EVM.htlc : S.contract; }

  /* A token is only a token when the chain says two things about it: that code
     lives at that address, and that the code counts in the decimals this page
     counts in. Every amount here is written in millionths, so a token that
     counts in another unit would turn the amount the person agreed into a
     different amount of money - a seven-decimal token would move a tenth of
     what the screen said. The escrow itself refuses a token with no code; this
     is the same question asked where the token is typed, before any swap is
     priced against it. */
  function decimalsOf(res) {
    var s = String(res == null ? '' : res);
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return null;
    var h = s.slice(2);
    if (!/^0{56}/.test(h)) return null;        /* wider than 32 bits: not a decimals count */
    return parseInt(h.slice(56), 16);
  }
  function tokenVerdict(addr, list) {
    var opt = { list: list, quiet: true };
    return rpcQuorum('eth_getCode', [addr, 'latest'], opt).then(function (code) {
      if (!code || /^0x0*$/.test(String(code))) return { ok: false, why: 'nocontract' };
      return rpcQuorum('eth_call', [{ to: addr, data: '0x' + SEL.decimals }, 'latest'], opt)
        .then(function (res) {
          var d = decimalsOf(res);
          if (d == null) return { ok: false, why: 'nodecimals' };
          if (d !== DECIMALS) return { ok: false, why: 'decimals', decimals: d };
          return { ok: true, decimals: d };
        }, function (e) { return { ok: false, why: 'unread', disagree: !!(e && e.disagree) }; });
    }, function (e) { return { ok: false, why: 'unread', disagree: !!(e && e.disagree) }; });
  }
  function tokenWhy(v) {
    if (v.why === 'nocontract') return 'There is no token contract at that address on ' + curChain().label + '.';
    if (v.why === 'nodecimals') return 'That address answers, but it does not say how many decimals its token has, so it is not the token this swap counts in.';
    if (v.why === 'decimals') return 'That token counts in ' + v.decimals + ' decimals, and this swap moves a token that counts in ' + DECIMALS + '.';
    if (v.disagree) return 'The endpoints do not agree about that token, so it was not accepted.';
    return 'The chain did not answer, so the token could not be read.';
  }

  /* ------------------------------------------------------------ json-rpc -- */
  var rpcId = 0;
  /* Endpoints typed in Setup are the only ones used: a person who runs their
     own node did not ask for a public one to be asked instead. With nothing
     typed, the chain's own endpoints answer. */
  function endpoints() {
    var custom = endpointList(S.rpc);
    if (custom.length) return custom;
    return curChain().rpc.slice();
  }
  function rpcOne(url, method, params) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 12000);
    var body = { jsonrpc: '2.0', id: ++rpcId, method: method, params: params || [] };
    return fetch(url, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || typeof j !== 'object') throw new Error('bad reply');
      if (j.error) { var e = new Error(j.error.message || 'call failed'); e.chain = true; throw e; }
      return j.result;
    }).catch(function (e) { clearTimeout(timer); throw e; });
  }
  /* One query, walked down the endpoint list: a public endpoint that is down or
     rate-limiting earns the next one, never a decision that the escrow is
     empty and never a swap called done. An answer from the chain (a revert)
     stops the walk: asking a second node the same question cannot change it. */
  function rpc(method, params) { return rpcWalk(endpoints(), method, params); }
  /* The same walk over a list that was just typed rather than the one already in
     effect: Setup has to read the chain it is about to save, and the endpoints it
     is about to save with it. */
  function rpcWalk(list, method, params) {
    list = list && list.length ? list : endpoints();
    var i = 0, last = null;
    function step() {
      if (i >= list.length) return Promise.reject(last || new Error('no endpoint'));
      var url = list[i++];
      return rpcOne(url, method, params).catch(function (e) {
        if (e && e.chain) return Promise.reject(e);
        last = e;
        return step();
      });
    }
    return step();
  }
  /* What two nodes have to agree on, written one way.

     Two honest nodes answer the same question in different shapes: the same
     receipt comes back with its keys in another order, with Arbitrum's own
     extra fields (l1BlockNumber, gasUsedForL1), or with a quantity as 0x01
     where the other wrote 0x1. Comparing raw JSON called that a disagreement,
     and a swap stopped on a chain that was working. So a receipt is compared
     by the parts the money depends on - its status, its block, who it came
     from and went to, and its logs' address, topics and data - and a
     transaction by its hash, from, to, value and input. A call's answer is
     compared as the bytes it is. Anything the page does not recognise is
     compared whole and normalized, never reduced to "agrees": an unknown
     shape must not pass as a match. */
  var QUORUM_QTY = {
    blocknumber: 1, status: 1, value: 1, nonce: 1, gas: 1, gasused: 1,
    cumulativegasused: 1, effectivegasprice: 1, gasprice: 1, transactionindex: 1,
    type: 1, chainid: 1, timestamp: 1, l1blocknumber: 1
  };
  function canonHex(x) { return String(x == null ? '' : x).trim().toLowerCase(); }
  function canonQty(x) {
    var s = canonHex(x);
    if (/^0x[0-9a-f]+$/.test(s)) {
      try { return '0x' + BigInt(s).toString(16); } catch (e) { return s; }
    }
    if (/^\d+$/.test(s)) {
      try { return '0x' + BigInt(s).toString(16); } catch (e) { return s; }
    }
    return s;
  }
  function canonValue(v) {
    var out, keys, i, k;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return /^0x/i.test(v) ? canonHex(v) : v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      out = [];
      for (i = 0; i < v.length; i++) out.push(canonValue(v[i]));
      return out;
    }
    if (typeof v !== 'object') return String(v);
    keys = Object.keys(v).sort(); out = {};
    for (i = 0; i < keys.length; i++) {
      k = keys[i].toLowerCase();
      out[k] = QUORUM_QTY[k] ? canonQty(v[keys[i]]) : canonValue(v[keys[i]]);
    }
    return out;
  }
  function canonLog(l) {
    if (!l || typeof l !== 'object') return canonValue(l);
    return {
      address: canonHex(l.address),
      topics: (Array.isArray(l.topics) ? l.topics : []).map(canonHex),
      data: canonHex(l.data)
    };
  }
  function quorumKey(v) {
    var o, keys, i, out;
    if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.logs)) {
      out = {
        status: canonQty(v.status), blockNumber: canonQty(v.blockNumber),
        from: canonHex(v.from), to: canonHex(v.to),
        contractAddress: canonHex(v.contractAddress),
        hash: canonHex(v.transactionHash || v.hash),
        logs: v.logs.map(canonLog)
      };
      return 'receipt:' + JSON.stringify(out);
    }
    if (v && typeof v === 'object' && !Array.isArray(v) &&
      (v.hash != null || v.transactionHash != null) &&
      ('from' in v || 'to' in v)) {
      out = {
        hash: canonHex(v.hash || v.transactionHash), from: canonHex(v.from),
        to: canonHex(v.to), value: canonQty(v.value),
        input: canonHex(v.input != null ? v.input : v.data),
        blockNumber: canonQty(v.blockNumber)
      };
      return 'tx:' + JSON.stringify(out);
    }
    return 'raw:' + JSON.stringify(canonValue(v));
  }

  /* A state the money depends on is asked of every configured endpoint at once
     and believed only when two of them answer the same thing. One lying node
     cannot then show a lock that is not there: it disagrees with the other, and
     the page says so instead of trusting either. A single endpoint is its own
     answer — that is what a private node is for. */
  function rpcQuorum(method, params, opt) {
    opt = opt || {};
    var list = opt.list && opt.list.length ? opt.list : endpoints();
    if (list.length < 2) {
      /* One endpoint is its own answer - that is what a private node is for -
         but the reading was not cross-checked, and the screen says so instead
         of letting a single node's word pass for a verified one. A quiet read
         (Setup asking about a token it has not saved yet) leaves the line alone. */
      if (!opt.quiet && S.mode !== 'practice') { S.quorum = 'single'; renderChain(); }
      return rpcWalk(list, method, params);
    }
    return Promise.all(list.map(function (url) {
      return rpcOne(url, method, params).then(
        function (v) { return { ok: true, key: quorumKey(v), v: v }; },
        function (e) { return { ok: false, e: e }; });
    })).then(function (all) {
      var seen = {}, best = null;
      all.forEach(function (r) {
        if (!r.ok) return;
        seen[r.key] = (seen[r.key] || 0) + 1;
        if (!best || seen[r.key] > seen[best.key]) best = r;
      });
      if (best && seen[best.key] >= 2) { if (!opt.quiet) S.quorum = 'ok'; return best.v; }
      if (!opt.quiet) S.quorum = (best ? 'disagree' : 'down');
      var e = new Error('the endpoints do not agree');
      e.disagree = true;
      throw e;
    });
  }

  /* ------------------------------------------------------ the chain clock --
     A timelock is measured by the chain, not by a phone whose clock anyone can
     move. The latest block's timestamp is read beside the escrow, and the later
     of the two clocks is what the window checks use: setting the phone back can
     only make the app more careful, never let it pay into a closing window.
     One reading serves 45 seconds so a screen full of checks is one request, and
     a failed read falls back to the phone's clock after a short pause instead of
     asking again on every keystroke. */
  var BLOCK_TS_TTL = 45000;
  var BLOCK_TS_RETRY = 15000;
  function effNow() {
    var local = nowSec();
    if (S.mode === 'practice') return local;
    var fresh = S.blockTs && (Date.now() - S.blockTsAt) < BLOCK_TS_TTL;
    return fresh && S.blockTs > local ? S.blockTs : local;
  }
  /* Every configured endpoint is asked, and the reading is the one they agree
     on: the median of their answers, with any answer further than CLOCK_TOL
     from it left out. Taking the highest answer instead let one node - behind
     by an hour, or lying about the head by a year - decide that a window had
     closed while an honest clock said it had not. Two honest heads are always
     within a few seconds of each other, so a majority is a real majority; a
     single endpoint is its own answer, as it is for the escrow. A reading
     further than CLOCK_SKEW_MAX from this phone's clock is not a clock anyone
     can vouch for (a year 3000 head, a zero), so it is not used either. This is
     not the escrow itself, so it does not go through the quorum path: a stale
     head is a stricter answer, not a disagreement to report. */
  var CLOCK_TOL = 300;              /* seconds: two honest heads agree this closely */
  var CLOCK_SKEW_MAX = 24 * 3600;   /* beyond this a "head" is a mistake, not a clock */
  function chainTimeOnce() {
    var list = endpoints();
    return Promise.all(list.map(function (url) {
      return rpcOne(url, 'eth_getBlockByNumber', ['latest', false]).then(function (b) {
        var t = parseInt(String(b && b.timestamp), 16);
        return isFinite(t) && t > 0 ? t : null;
      }, function () { return null; });
    })).then(function (all) {
      var local = nowSec();
      var seen = all.filter(function (t) { return t && Math.abs(t - local) <= CLOCK_SKEW_MAX; })
        .sort(function (a, b) { return a - b; });
      if (!seen.length) return null;
      var median = seen[Math.floor((seen.length - 1) / 2)];
      var near = seen.filter(function (t) { return Math.abs(t - median) <= CLOCK_TOL; });
      /* A majority of the answers have to sit together. With one endpoint that
         is its own answer; with two or more, one node alone is not the clock. */
      if (seen.length > 1 && near.length * 2 < seen.length) {
        log('BLOCK', 'the endpoints do not agree on the time, so the phone\u2019s clock is what this screen uses', 'c-err');
        return null;
      }
      return near[Math.floor((near.length - 1) / 2)];
    }, function () { return null; });
  }
  function syncChainTime(force) {
    /* A rehearsal has no chain, and wallet mode without an escrow has no window
       to measure: neither should send a request just because a field changed. */
    if (S.mode !== 'wallet' || !isAddr(S.contract)) return Promise.resolve(nowSec());
    if (!force && Date.now() - S.blockTsAt < BLOCK_TS_TTL) return Promise.resolve(effNow());
    if (!force && Date.now() - S.blockTsFail < BLOCK_TS_RETRY) return Promise.resolve(effNow());
    return chainTimeOnce().then(function (t) {
      if (t) { S.blockTs = t; S.blockTsAt = Date.now(); }
      else S.blockTsFail = Date.now();
      return effNow();
    }, function () { S.blockTsFail = Date.now(); return effNow(); });
  }

  /* ------------------------------------------------------- escrow ABI ----- */
  function pad64(hex) { return ('0'.repeat(64) + hex).slice(-64); }
  function encU256(v) { return pad64(BigInt(v).toString(16)); }
  function encAddr(a) { return pad64(String(a).toLowerCase().replace(/^0x/, '')); }
  function encB32(h) { return pad64(normHex(h)); }
  function abiWords(hex) {
    var h = normHex(hex), out = [], i;
    if (!h.length || h.length % 64) return out;
    for (i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
    return out;
  }
  function wordNum(w) { return BigInt('0x' + (w || '0')).toString(); }
  function wordAddr(w) { return '0x' + String(w || '').slice(24); }
  function wordBool(w) { return !/^0+$/.test(String(w || '')); }
  function wordB32(w) { return '0x' + String(w || ''); }

  /* The escrow's Locked event, as the chain writes it: topics[0] is the hash of
     the signature, topics[1] the swap id, topics[2] the address that funded the
     escrow and topics[3] the receiver; the token, the amount, the hashlock and
     the timelock follow in the data. */
  var LOCKED_TOPIC = '0x' + KECCAK.hex(utf8('Locked(bytes32,address,address,address,uint256,bytes32,uint256)'));
  function lockedSender(t) {
    var w = String(t == null ? '' : t).replace(/^0x/i, '');
    if (w.length !== 64) return '';
    var a = '0x' + w.slice(24).toLowerCase();
    return isAddr(a) ? a : '';
  }
  /* The Locked event of this swap, out of a receipt. A smart contract wallet
     (a Safe, an account-abstraction wallet) is the msg.sender of the lock, so
     the address the escrow recorded is the one the swap id is built with - not
     `tx.from`, which is whatever key or bundler relayed the transaction. */
  function readLockedLog(rc) {
    var logs = rc && rc.logs, esc = String(S.contract || '').toLowerCase(), i, l, t, w, sender;
    if (!logs || !logs.length || !isAddr(S.contract)) return null;
    for (i = logs.length - 1; i >= 0; i--) {
      l = logs[i];
      if (!l || String(l.address || '').toLowerCase() !== esc) continue;
      t = l.topics || [];
      if (String(t[0] || '').toLowerCase() !== LOCKED_TOPIC) continue;
      w = abiWords(l.data);
      if (w.length < 4) continue;
      sender = lockedSender(t[2]);
      if (!sender) continue;
      return {
        swapId: String(t[1] || '').toLowerCase(),
        sender: sender,
        receiver: lockedSender(t[3]),
        token: wordAddr(w[0]).toLowerCase(),
        amount: wordNum(w[1]),
        hashlock: wordB32(w[2]).toLowerCase(),
        timelock: wordNum(w[3])
      };
    }
    return null;
  }
  /* A Locked event is about this swap only when the escrow wrote this swap's
     terms in it. Without that check, a transaction that locked something else
     would hand the page an address to build the wrong swap id from. A term the
     screen does not know yet (a form not filled in) is not compared; a term it
     does know has to match, and the escrow read after this decides the rest. */
  function termsOnScreen() {
    var inv = { ok: false }, ad, H = S.H;
    if (!H) {
      try { inv = readInvoice(pasted()); } catch (e) { inv = { ok: false }; }
      if (inv.ok) H = inv.H;
    }
    ad = S.addr ? { ok: true, address: S.addr } : readAddress(addrIn());
    return {
      H: H || null,
      addr: ad && ad.ok ? String(ad.address) : '',
      units: usdtUnits(),
      t2: S.t2
    };
  }
  function lockedLogFits(ev) {
    if (!ev) return false;
    var t = termsOnScreen(), token = String(tokenNow()).toLowerCase();
    if (t.H && normHex(ev.hashlock) !== normHex(t.H)) return false;
    if (isAddr(t.addr) && String(ev.receiver).toLowerCase() !== t.addr.toLowerCase()) return false;
    if (isAddr(token) && ev.token !== token) return false;
    if (Number(t.units) > 0 && !sameAmount(ev.amount, t.units)) return false;
    if (t.t2 && !sameAmount(ev.timelock, t.t2)) return false;
    return true;
  }

  /* The calls, in the shapes the contract declares them. */
  function lockCalldata(o) {
    return '0x' + SEL.lock + encB32(o.hashlock) + encU256(o.timelock) +
      encAddr(o.receiver) + encAddr(o.token) + encU256(o.amount);
  }
  function claimCalldata(swapId, preimage) { return '0x' + SEL.claim + encB32(swapId) + encB32(preimage); }
  function refundCalldata(swapId) { return '0x' + SEL.refund + encB32(swapId); }
  function swapsCalldata(swapId) { return '0x' + SEL.swaps + encB32(swapId); }
  function approveCalldata(spender, amount) { return '0x' + SEL.approve + encAddr(spender) + encU256(amount); }

  /* `swaps(id)` returns the whole struct as a tuple of eight values. */
  function decodeSwap(hex) {
    var w = abiWords(hex);
    if (w.length < 8) return null;
    return {
      hashlock: wordB32(w[0]),
      amount: wordNum(w[1]),
      timelock: wordNum(w[2]),
      token: wordAddr(w[3]),
      sender: wordAddr(w[4]),
      receiver: wordAddr(w[5]),
      claimed: wordBool(w[6]),
      refunded: wordBool(w[7])
    };
  }

  function decodeLockCalldata(hex) {
    var h = normHex(hex);
    if (h.length !== 8 + 5 * 64) return null;
    var w = [], i;
    for (i = 0; i < 5; i++) w.push(h.slice(8 + i * 64, 8 + (i + 1) * 64));
    return {
      kind: 'calldata',
      selector: h.slice(0, 8),
      hashlock: '0x' + w[0],
      timelock: BigInt('0x' + w[1]).toString(),
      receiver: '0x' + w[2].slice(24),
      token: '0x' + w[3].slice(24),
      amount: BigInt('0x' + w[4]).toString()
    };
  }

  function swapIdNow() {
    var who = lockerNow();
    if (!isAddr(who)) return Promise.reject(new Error('the escrow side is not known yet'));
    /* The id is the terms plus the funding address. Terms that never arrived
       (no swap code, no lock read back yet) mean there is no id to compute,
       and refusing here says so instead of handing a null into the bytes
       below and calling it a chain error. */
    if (!S.H || !S.t2) return Promise.reject(new Error('the swap terms are not complete yet'));
    return computeSwapId(S.H, who, S.addr, tokenNow(), S.units != null ? S.units : usdtUnits(), S.t2);
  }

  /* ------------------------------------------------------ reading it ------ */
  function termsNow() {
    return {
      hashlock: String(S.H || ''),
      sender: String(lockerNow() || ''),
      receiver: String(S.addr || ''),
      token: String(tokenNow() || ''),
      amount: String(S.units != null ? S.units : usdtUnits()),
      timelock: String(S.t2 || 0)
    };
  }

  /* What the escrow says about this swap, judged against the terms on screen.
     The id is derived from those terms, so a record found under it already
     shares them - they are compared again anyway, because a reading that only
     agrees with itself is not evidence. */
  function classify(rec) {
    if (!rec || !rec.sender || /^0x0+$/.test(rec.sender)) return { state: 'none', rec: rec };
    var t = termsNow(), why = '';
    if (normHex(rec.hashlock) !== normHex(t.hashlock)) why = 'hash';
    else if (String(rec.receiver).toLowerCase() !== t.receiver.toLowerCase()) why = 'receiver';
    else if (String(rec.token).toLowerCase() !== t.token.toLowerCase()) why = 'token';
    else if (!sameAmount(rec.amount, t.amount)) why = 'amount';
    else if (!sameAmount(rec.timelock, t.timelock)) why = 'tl';
    else if (t.sender && String(rec.sender).toLowerCase() !== t.sender.toLowerCase()) why = 'sender';
    if (why) return { state: 'mismatch', why: why, rec: rec };
    if (rec.claimed) return { state: 'claimed', rec: rec };
    if (rec.refunded) return { state: 'refunded', rec: rec };
    /* A record past its timelock can no longer be claimed: paying now would
       hand the sats over with nothing left to claim. */
    if (Number(rec.timelock) <= effNow()) return { state: 'closed', rec: rec };
    return { state: 'locked', rec: rec };
  }

  /* Plain sentences: what the chain says, without a symbol name in sight. */
  function chainSay(c) {
    var x = usdtTxt() + ' USDT';
    switch (c && c.state) {
      case 'locked': return 'The escrow holds your ' + x + ' until the swap closes or the window ends.';
      case 'closed': return 'The escrow window has closed, so the ' + x + ' can only go back to the side that locked it.';
      case 'claimed': return 'The escrow paid out the ' + x + '.';
      case 'refunded': return 'The escrow sent the ' + x + ' back to the side that locked it.';
      case 'mismatch':
        if (c.why === 'amount') return 'The escrow holds a different amount, so this is not the agreed swap.';
        if (c.why === 'receiver') return 'The escrow pays a different address, so it is not this swap.';
        if (c.why === 'tl') return 'The escrow ends at a different time, so it is not the agreed swap.';
        if (c.why === 'sender') return 'The escrow was funded from a different address, so it is not this swap.';
        return 'The escrow record does not match these terms.';
      case 'error': return c.disagree
        ? 'The endpoints do not agree on what the escrow holds, so nothing is trusted.'
        : 'The chain could not be reached just now.';
      default: return 'The ' + x + ' is not in the escrow yet.';
    }
  }

  function simRead() {
    var r = S.simRec;
    if (!r) return null;
    return {
      hashlock: r.hashlock, amount: String(r.amount), timelock: String(r.timelock),
      token: r.token, sender: r.sender, receiver: r.receiver,
      claimed: !!r.claimed, refunded: !!r.refunded
    };
  }

  /* One reading of the escrow for the terms on screen. Practice answers from
     the stand-in record; Wallet asks the chain. Either way the verdict comes
     from classify(), so the rehearsal and the real thing are judged alike. */
  function chainRead() {
    if (S.mode === 'practice') return Promise.resolve(simRead());
    if (!isAddr(S.contract)) return Promise.reject(new Error('no escrow contract set'));
    /* The side that funds the escrow has not told the app its address yet: by
       definition nothing of this side's is in the escrow, and the address is
       learned when the wallet signs or the lock transaction comes back. */
    if (!isAddr(lockerNow())) return Promise.resolve(null);
    /* Without the window there is no id to read under: a null reading, which
       the screen treats as nothing to say, never a chain error dressed as
       one. loadTx() fills the window from the lock before it asks here. */
    if (!S.t2) return Promise.resolve(null);
    return swapIdNow().then(function (id) { return rpcQuorum('eth_call', [{ to: S.contract, data: swapsCalldata(id) }, 'latest']); })
      .then(decodeSwap);
  }

  function refreshChain() {
    if (!S.H || (S.mode === 'wallet' && !isAddr(S.contract))) {
      S.chain = null;
      renderChain();
      return Promise.resolve(null);
    }
    var want = normHex(termsNow().hashlock);
    S.busy = true;
    if (S.mode === 'practice') S.block = curHeight();
    renderChain();
    return chainRead().then(function (rec) {
      S.busy = false;
      if (want !== normHex(termsNow().hashlock)) { renderChain(); return null; }   /* terms moved on */
      S.chain = classify(rec);
      S.rpcState = 'ok';
      S.chainAt = Date.now();
      renderChain();
      return S.chain;
    }, function (e) {
      S.busy = false;
      S.rpcState = 'bad';
      S.chain = { state: 'error', why: String((e && e.message) || e), disagree: !!(e && e.disagree) };
      renderChain();
      return S.chain;
    });
  }

  /* The head of the chain, read the way the chain's clock is: every configured
     endpoint is asked and the highest answer stands. A block number is a
     liveness reading, not a state the money depends on, so it is not a
     question for the quorum: Arbitrum makes a block every ~250ms, which means
     two honest nodes are almost always a block or two apart, and a quorum on
     the height would call a working chain broken and refuse the swap. */
  function headNumber() {
    var list = endpoints();
    return Promise.all(list.map(function (url) {
      return rpcOne(url, 'eth_blockNumber', []).then(function (bn) {
        var n = parseInt(String(bn), 16);
        return isFinite(n) && n > 0 ? n : null;
      }, function () { return null; });
    })).then(function (all) {
      var best = null;
      all.forEach(function (n) { if (n && (!best || n > best)) best = n; });
      if (best == null) throw new Error('no endpoint answered');
      return best;
    });
  }

  /* Does the chain answer, and is the escrow really the escrow? Code at an
     address is not yet an answer: any contract has code, and a token or a
     mimic wears an address just as well. The escrow is known by its own
     reading - `swaps(id)` returns the whole record, eight words, and for an
     id nobody locked it is zeroed fields rather than a revert. A screen that
     points at something else says so before any money is asked for. */
  function chainProbe() {
    /* A rehearsal has a stand-in escrow on the phone, so it already answers. */
    if (S.mode === 'practice') {
      S.busy = false;
      S.rpcState = 'ok';
      S.block = curHeight();
      renderChain();
      return Promise.resolve('ok');
    }
    if (S.mode !== 'wallet') return Promise.resolve(null);
    if (!isAddr(S.contract)) { S.rpcState = 'idle'; S.block = null; renderChain(); return Promise.resolve(null); }
    S.busy = true;
    renderChain();
    return headNumber().then(function (n) {
      S.block = n;
      /* Whether code exists at the escrow address is a state the money
         depends on, so it keeps the cross-check. */
      return rpcQuorum('eth_getCode', [S.contract, 'latest']);
    }).then(function (code) {
      var empty = !code || /^0x0*$/.test(String(code));
      if (empty) return null;
      /* Code is not the escrow; the escrow's view function is. An unknown
         swap reads back as eight zeroed words on the real contract. Anything
         else - a revert, a short answer, a different shape - is some other
         contract wearing the address, and the screen refuses it by name. */
      return rpcQuorum('eth_call', [{ to: S.contract, data: swapsCalldata(ZERO_ID) }, 'latest'])
        .then(function (res) { return decodeSwap(res) ? 'htlc' : 'other'; },
              function (e) { return (e && e.disagree) ? 'unclear' : 'other'; });
    }).then(function (verdict) {
      S.busy = false;
      if (verdict === null) {
        S.rpcState = 'nocon';
        log('SETUP', 'no contract answers at the escrow address', 'c-err');
      } else if (verdict === 'other') {
        S.rpcState = 'nohtlc';
        log('SETUP', 'the address answers, but not the way the swap contract answers', 'c-err');
      } else if (verdict === 'unclear') {
        /* A disagreement between the endpoints is not a verdict about the
           contract, and it is not a yes either: nothing that depends on this
           address is read as ready until they agree again. */
        S.rpcState = 'unclear';
        log('SETUP', 'the endpoints disagree about the escrow, so nothing is read as ready', 'c-err');
      } else {
        S.rpcState = 'ok';
      }
      /* The token is asked about on the same pass: a setup stored before this
         page read decimals is still on a phone, and a token that turned out to
         count in another unit has to be named before an amount is built from
         it. A chain that does not answer marks the token unread, not wrong. */
      var tokenRead = Promise.resolve();
      if (isAddr(tokenNow())) {
        tokenRead = tokenVerdict(tokenNow()).then(function (r) {
          S.tokenState = r.ok ? 'ok' : (r.why === 'unread' ? 'unread' : 'wrong');
          if (S.tokenState === 'wrong') log('SETUP', tokenWhy(r), 'c-err');
        }, function () { S.tokenState = 'unread'; });
      }
      return tokenRead.then(function () {
        paintSetup();
        renderChain();
        return S.rpcState;
      });
    }, function (e) {
      S.busy = false;
      S.rpcState = 'bad';
      renderChain();
      log('NET', 'the chain did not answer: ' + short(String((e && e.message) || e), 12), 'c-err');
      return S.rpcState;
    });
  }
