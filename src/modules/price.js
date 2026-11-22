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
     answer. And a quote has a shelf life: one older than PRICE_TTL is read
     again from both sources before the tap that would spend it goes through. */
  var PRICE_GAP = 0.02;             /* two honest quotes of one market sit this close */
  var PRICE_TIMEOUT = 5000;         /* one source's own moment in the sun, ms */
  /* A quote is a market, and a market moves. The price this page read a while
     ago is not the price a swap is approved at now, and the USDT amount that
     follows from it is real money. So a quote is good for ninety seconds; past
     that, the tap that would spend it reads both sources again first (see
     withFreshRate and refreshStaleRate below). Ninety seconds sits inside the
     minute-to-two band a swap's price can be trusted over, and the band is
     enforced, so a number outside it is not a shelf life this page honours. */
  var PRICE_TTL = 90000;            /* how long a quote prices a swap for, ms */
  var PRICE_TTL_MIN = 60000;
  var PRICE_TTL_MAX = 120000;
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

  /* How long a quote is believed, and how old the one on screen is. A quote
     this page did not read carries no stamp, so it has no age to judge and is
     not called stale: only a quote that actually arrived is aged. */
  function priceTtl() { return Math.min(PRICE_TTL_MAX, Math.max(PRICE_TTL_MIN, PRICE_TTL)); }
  function priceAge() { return S.priceAt > 0 ? Date.now() - S.priceAt : null; }
  function priceStale() {
    var age = priceAge();
    return age != null && age > priceTtl();
  }

  /* One read at a time: a tap and the boot read, or two taps in the same
     moment, ask the two sources once and share the answer, so the verdict on
     screen is never the slower of two races. */
  var rateJob = null;
  function loadRate() {
    if (rateJob) return rateJob;
    var jobs = PRICE_SOURCES.map(function (src) {
      return priceOne(src, PRICE_TIMEOUT)
        .then(function (usd) { return { name: src.name, usd: usd }; },
          function () { return { name: src.name, usd: null }; });
    });
    rateJob = Promise.all(jobs).then(function (quotes) {
      var v = priceVerdict(quotes);
      if (v.state === 'offline') { S.price = FALLBACK_PRICE; S.pstate = 'offline'; }
      else if (v.state === 'disagree') { S.price = null; S.pstate = 'disagree'; }
      else { S.price = v.price; S.pstate = v.state; }
      S.priceAt = Date.now();
      rateJob = null;
      /* A code can arrive before this quote does - the deep link in the
         address bar is read at boot, while the price is still loading - and
         the check it earns against the market is made again here, before
         the screen is painted. */
      recheckCodeRate();
      render(); refreshGate();
      return v;
    }, function (e) { rateJob = null; throw e; });
    return rateJob;
  }

  /* The same read, named for what it is here: both sources asked again, the
     pair judged by priceVerdict, the rate the screen keeps replaced. */
  function refreshRate() { return loadRate(); }

  /* Read the quote again when it is older than its shelf life, and say on the
     log why a read that should not have been needed was made. Resolves false
     when the quote was still fresh. */
  function refreshStaleRate(why) {
    if (!priceStale()) return Promise.resolve(false);
    var age = priceAge();
    log('RATE', 'the quote was ' + Math.round(age / 1000) + ' s old, so both sources were asked again' +
      (why ? ' before ' + why : ''));
    return refreshRate().then(function () { return true; });
  }

  /* A tap that would turn terms into money - the approve, the lock, a code
     handed to the other side - waits for a quote it can call current: one older
     than PRICE_TTL is read again first, both sources with it, and the same tap
     goes on from the fresh answer. A second tap while that read is in flight
     waits on the same read rather than starting another. */
  function withFreshRate(go, why) {
    if (!priceStale()) { go(); return; }
    if (S.rateWait) { toast('Reading the BTC price again: the last quote was too old to spend.'); return; }
    S.rateWait = true;
    var done = function () { S.rateWait = false; go(); };
    refreshStaleRate(why).then(done, done);
  }

  /* A code that prices a swap is written from a quote this page can call
     current. A code made from terms both sides already agreed prices nothing
     and waits for nothing. */
  function rateForCode() {
    if (S.units != null) return Promise.resolve(false);
    return refreshStaleRate('a code priced the swap');
  }
