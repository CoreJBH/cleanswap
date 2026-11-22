  /* price.js - the BTC/USD quote, cross-checked between two public APIs */
  /* One API is one answer, and the rate this page prices a swap with decides
     how much USDT changes hands. So the quote is read from two independent
     public sources at the same time - mempool.space's own price index and
     Coinbase's spot price - and the rate the screen uses is the mean of what
     they answered.

     Three verdicts come out of the pair:

       live      both answered and sit within PRICE_GAP of each other: the
                 quote is used, and the rate line says nothing extra
       single    one answered: the quote is still a real one and is used, but
                 the rate line says it was not cross-checked, the same way the
                 chain line says one endpoint is one answer
       disagree  both answered and they are too far apart to be one market:
                 no rate at all, the rate line says so, and a wallet swap is
                 refused rather than priced from a number two markets disagree
                 about
       offline   neither answered: the offline guess, which no real USDT is
                 locked against (quoteMissing())

     A quote has to be a positive finite number to count at all: an API that
     answers with a shape this page does not know is an API that did not
     answer. */
  var PRICE_GAP = 0.02;             /* two honest quotes of one market sit this close */
  var PRICE_TIMEOUT = 5000;         /* one source's own moment in the sun, ms */
  var PRICE_SOURCES = [
    { name: 'mempool.space', url: 'https://mempool.space/api/v1/prices',
      read: function (j) { return Number(j && j.USD); } },
    { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      read: function (j) { return Number(j && j.data && j.data.amount); } }
  ];

  function priceOne(src, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    var opt = { cache: 'no-store' };
    if (ctl) opt.signal = ctl.signal;
    return fetch(src.url, opt)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var usd = src.read(j);
        if (!isFinite(usd) || !(usd > 0)) throw new Error('no USD in the answer');
        return usd;
      })
      .then(function (usd) { clearTimeout(timer); return usd; },
        function (e) { clearTimeout(timer); throw e; });
  }

  /* Two quotes, one verdict. Kept apart from the fetch so the same judgement
     can be made on answers a test hands over without a network. */
  function priceVerdict(quotes) {
    var got = [];
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (q && isFinite(q.usd) && q.usd > 0) got.push(q);
    }
    if (!got.length) return { state: 'offline', price: null };
    if (got.length === 1) return { state: 'single', price: got[0].usd };
    var lo = Math.min(got[0].usd, got[1].usd);
    var hi = Math.max(got[0].usd, got[1].usd);
    if ((hi - lo) / lo > PRICE_GAP) return { state: 'disagree', price: null, gap: (hi - lo) / lo };
    return { state: 'live', price: (lo + hi) / 2 };
  }

  /* A rate two markets agree on is a live rate; one market's own answer is a
     single one. Neither is a guess, and neither is a disagreement. */
  function rateKnown() { return S.pstate === 'live' || S.pstate === 'single'; }

  function loadRate() {
    var jobs = PRICE_SOURCES.map(function (src) {
      return priceOne(src, PRICE_TIMEOUT)
        .then(function (usd) { return { name: src.name, usd: usd }; },
          function () { return { name: src.name, usd: null }; });
    });
    return Promise.all(jobs).then(function (quotes) {
      var v = priceVerdict(quotes);
      if (v.state === 'offline') { S.price = FALLBACK_PRICE; S.pstate = 'offline'; }
      else if (v.state === 'disagree') { S.price = null; S.pstate = 'disagree'; }
      else { S.price = v.price; S.pstate = v.state; }
      /* A code can arrive before this quote does - the deep link in the
         address bar is read at boot, while the price is still loading - and
         the check it earns against the market is made again here, before
         the screen is painted. */
      recheckCodeRate();
      render(); refreshGate();
      return v;
    });
  }
