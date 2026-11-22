  /* bridge-test.js - the window handle a test build leaves (never in a shipped page) */
  /* What this page leaves on the window. The host shell needs one entry -
     `acceptCode`, to hand a swap code over from another app - and the page's
     own verification suites drive the rest through the same handle. The state
     is shared as a view, not as the object itself: the view answers every
     field the suites and a host may watch or set for a test, but keeps the
     one thing on this page worth stealing out of the window entirely -
     this side's payment secret, the 32 bytes that open the escrow leg. The
     app itself reads its state through the closure, so the guard costs the
     page nothing and the secret never crosses it. Every other export is
     either an action the page's own buttons call or a pure helper whose code
     ships in the same file anyone can download. */
  function guardedState() {
    return new Proxy(S, {
      /* `secretHeld` is a boolean about the state, never the state itself: the
         suites can see that the page let go of a finished swap's secret
         without the window ever holding the bytes. */
      get: function (o, k) {
        if (k === 'secret') return undefined;
        if (k === 'secretHeld') return !!o.secret;
        return o[k];
      },
      has: function (o, k) { return k !== 'secret' && k in o; },
      ownKeys: function (o) {
        return Reflect.ownKeys(o).filter(function (k) { return k !== 'secret'; });
      },
      getOwnPropertyDescriptor: function (o, k) {
        return k === 'secret' ? undefined : Reflect.getOwnPropertyDescriptor(o, k);
      },
      set: function (o, k, v) { if (k === 'secret') return false; o[k] = v; return true; },
      deleteProperty: function (o, k) { if (k === 'secret') return false; delete o[k]; return true; },
      defineProperty: function (o, k, d) {
        if (k === 'secret') return false;
        Object.defineProperty(o, k, d);
        return true;
      }
    });
  }

  window.CLEANSWAP = {
    state: guardedState(), acceptCode: acceptCode, applyCode: applyCode,
    SEL: SEL, EVM: EVM, CHAINS: CHAINS, QR_MAX: QR_MAX, NET: NET, T2_SPAN: T2_SPAN,
    T2_MIN: T2_MIN, T2_MAX: T2_MAX, T1_MARGIN: T1_MARGIN, PAY_MARGIN: PAY_MARGIN,
    b64field: b64field, unB64field: unB64field,
    BYTECODE: BYTECODE, lockerNow: lockerNow, ensureMe: ensureMe, isOfficialEscrow: isOfficialEscrow,
    invoiceExpiry: invoiceExpiry, windowProblem: windowProblem, rpcQuorum: rpcQuorum, endpoints: endpoints,
    lnHtlcSpan: lnHtlcSpan, lnDeadline: lnDeadline, lnProblem: lnProblem, chainTimeOnce: chainTimeOnce,
    CLOCK_TOL: CLOCK_TOL, CLOCK_SKEW_MAX: CLOCK_SKEW_MAX, LN_SAFETY_SECS: LN_SAFETY_SECS,
    claimWalletLink: claimWalletLink, refundWalletLink: refundWalletLink, callLink: callLink,
    sha256Hex: sha256Hex, sha256Bytes: sha256Bytes, computeSwapId: computeSwapId, bech32Decode: bech32Decode,
    SECP: SECP, wordsToInt: wordsToInt, fromHex: fromHex, effNow: effNow, syncChainTime: syncChainTime,
    unitsTxt: unitsTxt,
    KECCAK: KECCAK, eip55: eip55, checksumOk: checksumOk, isAddr: isAddr,
    quorumKey: quorumKey, LOCKED_TOPIC: LOCKED_TOPIC, readLockedLog: readLockedLog,
    lockedLogFits: lockedLogFits,
    base58Bytes: base58Bytes, tronAddressBytes: tronAddressBytes, chainOf: chainOf,
    decodeBolt11: decodeBolt11, decodeBolt12: decodeSwapOffer, decodeSwapOffer: decodeSwapOffer,
    mintInvoice: mintInvoice, mintOffer: mintOffer,
    lockCalldata: lockCalldata, decodeLockCalldata: decodeLockCalldata, readLockProof: readLockProof,
    claimCalldata: claimCalldata, refundCalldata: refundCalldata, swapsCalldata: swapsCalldata,
    approveCalldata: approveCalldata, decodeSwap: decodeSwap, classify: classify, chainSay: chainSay,
    swapIdNow: swapIdNow, readSwap: function (id) { return rpc('eth_call', [{ to: S.contract, data: swapsCalldata(id) }, 'latest']).then(decodeSwap); },
    chainRead: chainRead, refreshChain: refreshChain, chainProbe: chainProbe,
    loadSetup: loadSetup, saveSetup: saveSetup, curChain: curChain,
    readEscrow: readEscrow, readInvoice: readInvoice, readAddress: readAddress,
    parseLightning: parseLightning, nextCalldata: nextCalldata, escrowProof: escrowProof,
    escrowUnits: escrowUnits, usdtUnits: usdtUnits, usdtTxt: usdtTxt, tokenNow: tokenNow,
    swapCode: swapCode, parseSwapCode: parseSwapCode, parseSwapLink: parseSwapLink,
    rateGap: rateGap, RATE_WARN: RATE_WARN, ZERO_ID: ZERO_ID,
    priceVerdict: priceVerdict, priceSources: PRICE_SOURCES, rateKnown: rateKnown,
    PRICE_TTL: PRICE_TTL, PRICE_TTL_MIN: PRICE_TTL_MIN, PRICE_TTL_MAX: PRICE_TTL_MAX,
    priceTtl: priceTtl, priceAge: priceAge, priceStale: priceStale, refreshRate: refreshRate,
    rateWarnText: rateWarnText, quoteMissing: quoteMissing, invNetOk: invNetOk,
    watchOnce: watchOnce, startWatch: startWatch,
    render: render, refreshGate: refreshGate, validate: validate, paintGate: paintGate,
    approve: approve, paid: paid, reset: reset, backToForm: backToForm, presetsOn: presetsOn,
    checkChain: checkChain, settleByChain: settleByChain, loadTx: loadTx,
    sampleInvoice: sampleInvoice, sampleAddress: sampleAddress, revealQr: revealQr, showQr: showQr,
    historyEntry: historyEntry, pasted: pasted, addrIn: addrIn
  };
