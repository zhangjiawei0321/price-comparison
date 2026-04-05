const readline = require('readline');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');
const { URL } = require('url');

/** 同一 userDataDir 只能被一个 Chromium 占用；后台监测与网页「添加」并行时会触发配置文件锁并报错 */
const persistentProfileLocks = new Map();

function createEnqueueLock() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

function runWithPersistentProfileLock(userDataDir, fn) {
  if (!userDataDir) return fn();
  const key = path.resolve(userDataDir);
  if (!persistentProfileLocks.has(key)) {
    persistentProfileLocks.set(key, createEnqueueLock());
  }
  return persistentProfileLocks.get(key)(fn);
}

function isJdPriceDebug() {
  return String(process.env.JD_PRICE_DEBUG || '').trim() === '1';
}

/** 天猫/淘宝内嵌 JSON 里可能出现的「原价/划线价」字段名（camel + snake）。 */
const TB_ORIGINAL_PRICE_KEY_ALT =
  'originalPrice|originPrice|origPrice|original_price|orig_price|origin_price|originalprice|' +
  'reservePrice|reserve_price|reservedPrice|referencePrice|reference_price|' +
  'beforeActivityPrice|before_activity_price|beforeDiscountPrice|before_discount_price|' +
  'campHighPrice|camp_high_price|promotionHighPrice|promotion_high_price|' +
  'tagPrice|tag_price|promotionPriceBefore|promotion_price_before|' +
  'marketPrice|market_price|counterPrice|counter_price|mktPrice|mkt_price|' +
  'listPrice|list_price|guidePrice|guide_price|crossedPrice|linePrice|underlinePrice|' +
  'skuOriginPrice|sku_original_price|skuOrigPrice|initPrice|init_price|' +
  'defaultPrice|default_price|barePrice|jingJiaPrice|jingjiaPrice|pcadPrice';

function tbOriginalPriceFloatRegex() {
  return new RegExp(`"(?:${TB_ORIGINAL_PRICE_KEY_ALT})"\\s*:\\s*"(\\d+(?:\\.\\d{1,2})?)"`, 'gi');
}

function tbOriginalPriceIntRegex() {
  return new RegExp(`"(?:${TB_ORIGINAL_PRICE_KEY_ALT})"\\s*:\\s*(\\d{5,12})\\b`, 'gi');
}

/** 在「实付分」或「实付元」字面量附近找更大的 5～8 位整数（多为原价分）。 */
function extractTaobaoListNearPayLiteral(html, payCents) {
  if (!html || !payCents || payCents <= 0) return null;
  const slice = String(html).slice(0, 3200000);
  const yuan = (payCents / 100).toFixed(2);
  const needles = [String(payCents), yuan];
  let best = 0;
  let bestRaw = null;
  const cap = Math.min(Math.floor(payCents * 3), 50000000);
  for (const needle of needles) {
    if (!needle) continue;
    let pos = slice.indexOf(needle);
    let guard = 0;
    while (pos !== -1 && guard < 50) {
      const seg = slice.slice(Math.max(0, pos - 900), Math.min(slice.length, pos + 900));
      const re = /\b(\d{5,8})\b/g;
      let m;
      while ((m = re.exec(seg)) !== null) {
        const n = parseInt(m[1], 10);
        let cand = n;
        if (n < 50000 && n > payCents / 400) {
          cand = n * 100;
        }
        if (cand <= payCents || cand >= cap) continue;
        if (cand > best) {
          best = cand;
          bestRaw = (cand / 100).toFixed(2);
        }
      }
      pos = slice.indexOf(needle, pos + 1);
      guard += 1;
    }
  }
  if (best <= payCents || !bestRaw) return null;
  return { listPriceCents: best, listRawPrice: bestRaw };
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function getSiteFromUrl(productUrl) {
  const host = new URL(productUrl).hostname.toLowerCase();
  if (host.includes('jd.com')) return 'jd';
  if (host.includes('taobao.com') || host.includes('tmall.com')) return 'taobao';
  if (host.includes('pinduoduo.com') || host.includes('yangkeduo.com')) return 'pinduoduo';
  return host || 'unknown';
}

function isTaobaoFamilyUrl(url) {
  return /taobao\.com|tmall\.com/i.test(String(url || ''));
}

/**
 * 监控用 URL 来自 item.jd.com，但实际打开落到 www.jd.com 首页、登录或带 reason=403 等，仍会解析出「假价格」。
 * 必须在 looksLikeCaptcha 里优先于 hasReliablePrice 判定，否则会误入库、误报巨幅降价。
 */
function isJdItemUrlRedirectedAway(sourceUrl, landingUrl) {
  try {
    const s = String(sourceUrl || '');
    if (!/item\.jd\.com|npcitem\.jd\.com/i.test(s)) return false;
    const lu = new URL(String(landingUrl || ''));
    const h = (lu.hostname || '').toLowerCase();
    if (/^(item|npcitem)\.jd\.com$/i.test(h) || h === 'item.m.jd.com') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/** 是否为淘宝/天猫商品详情 URL（与 assertAdd、监控入库判定一致）。 */
function isTaobaoProductDetailUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    const h = (u.hostname || '').toLowerCase();
    const p = u.pathname || '';
    if (h === 'item.taobao.com' || h.endsWith('.item.taobao.com')) return true;
    if (h === 'detail.tmall.com' || h === 'item.tmall.com' || h.endsWith('.detail.tmall.com')) return true;
    if (h === 'item.m.taobao.com' || h === 'item.m.tmall.com') return true;
    if (h === 'm.taobao.com' && (/\/item\//i.test(p) || /item\.htm/i.test(p))) return true;
    if ((h.includes('taobao.com') || h.includes('tmall.com')) && (/\/item\.htm/i.test(p) || /\/detail\//i.test(p)))
      return true;
    if (h.endsWith('.tb.cn') && /\/item\//i.test(p)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * 监控 URL 是淘系商详，但打开落到首页、登录、通行证等（非商详），仍可能解析出假价。
 */
function isTaobaoItemUrlRedirectedAway(sourceUrl, landingUrl) {
  try {
    if (!isTaobaoProductDetailUrl(sourceUrl)) return false;
    return !isTaobaoProductDetailUrl(landingUrl);
  } catch (_) {
    return false;
  }
}

function isPinduoduoFamilyUrl(url) {
  return /pinduoduo\.com|yangkeduo\.com/i.test(String(url || ''));
}

/**
 * 有界面或持久 profile 时默认用系统 Chrome（channel=chrome）。
 * Docker / Linux 无 Chrome 时设 PLAYWRIGHT_CHANNEL=chromium（Playwright 自带）。
 * 强制只用 Playwright 内置浏览器：PLAYWRIGHT_CHANNEL=bundled
 */
function launchBrowserOptions(headful, useChromeChannel) {
  const stealth = {
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  const needChannel = headful || useChromeChannel;
  const env = String(process.env.PLAYWRIGHT_CHANNEL || '').trim().toLowerCase();
  let channel;
  if (!needChannel) {
    channel = undefined;
  } else if (env === 'bundled' || env === 'playwright') {
    channel = undefined;
  } else if (env === 'chromium' || env === 'chrome' || env === 'msedge') {
    channel = env;
  } else {
    channel = 'chrome';
  }
  const opts = { ...stealth, headless: !headful };
  if (channel) opts.channel = channel;
  return opts;
}

/**
 * 京东：区分「标价」（.p-price 等）与「实付/国补后」（.summary-price .price 等）。
 * 入库主价 price_cents 取较低者（实付）；较高者写入 list_price_cents（标价）。
 * 仅一价或两价相同则只存主价。
 */
async function jdExtractPriceBundleFromPage(page) {
  const snippet = () => {
    const normNum = (s) => String(s || '').replace(/,/g, '').trim();
    const toCents = (raw) => {
      const s = normNum(raw || '');
      const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!m) return null;
      const whole = parseInt(m[1], 10);
      const frac = ((m[2] || '') + '00').slice(0, 2);
      const c = whole * 100 + parseInt(frac, 10);
      return c > 0 ? c : null;
    };
    const priceFromText = (raw) => {
      const t = normNum(raw || '');
      const rawStr = String(raw || '');
      const nums = [];
      const re = /(\d+(?:\.\d{1,2})?)/g;
      let mm;
      while ((mm = re.exec(t)) !== null) {
        const n = parseFloat(mm[1], 10);
        if (!Number.isNaN(n) && n >= 1) nums.push(n);
      }
      if (!nums.length) return null;
      const installment =
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(rawStr) ||
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(t);
      if (installment && nums.length >= 2) {
        return String(Math.max(...nums));
      }
      const ge100 = nums.filter((n) => n >= 100);
      const pool = ge100.length ? ge100 : nums.filter((n) => n >= 10);
      if (!pool.length) return String(Math.min(...nums));
      return String(Math.min(...pool));
    };
    const trySel = (sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        return priceFromText(el.textContent || '');
      } catch (_) {
        return null;
      }
    };
    const readFirst = (sels) => {
      for (const s of sels) {
        const v = trySel(s);
        if (v) return { raw: v, sel: s };
      }
      return null;
    };

    const listSels = [
      '.p-price .price',
      '.p-price',
      '#jd-price',
      '#spec-price',
      '.price.J-price',
      '[class*="J_Price"]',
    ];
    const summarySels = ['.summary-price .price', '.itemInfo-wrap .summary-price .price', '.itemInfo-wrap .price'];

    const L = readFirst(listSels);
    const S = readFirst(summarySels);
    if (S && L) {
      const cS = toCents(S.raw);
      const cL = toCents(L.raw);
      if (cS != null && cL != null && cS !== cL) {
        const payC = Math.min(cS, cL);
        const listC = Math.max(cS, cL);
        return {
          payableCents: payC,
          payableRaw: payC === cS ? S.raw : L.raw,
          listCents: listC,
          listRaw: listC === cL ? L.raw : S.raw,
        };
      }
      if (cS != null && cS > 0) {
        return { payableCents: cS, payableRaw: S.raw, listCents: null, listRaw: null };
      }
      if (cL != null && cL > 0) {
        return { payableCents: cL, payableRaw: L.raw, listCents: null, listRaw: null };
      }
    }
    if (S && !L) {
      const cS = toCents(S.raw);
      if (cS != null && cS > 0) {
        return { payableCents: cS, payableRaw: S.raw, listCents: null, listRaw: null };
      }
    }
    if (L && !S) {
      const cL = toCents(L.raw);
      if (cL != null && cL > 0) {
        return { payableCents: cL, payableRaw: L.raw, listCents: null, listRaw: null };
      }
    }

    const sels = [
      '#jd-price',
      '#spec-price',
      '.p-price .price',
      '.p-price',
      '.summary-price .price',
      '.itemInfo-wrap .summary-price .price',
      '.price.J-price',
      '[class*="J_Price"]',
      '.itemInfo-wrap .price',
      '#price',
      '.goods-price .main-price',
      '[class*="price-main"]',
      '[class*="purchasePrice"]',
      '[class*="PurchasePrice"]',
      '.J-pdjd-price',
      '[class*="sku-price"]',
      '[class*="SkuPrice"]',
      '[class*="emphasisPrice"]',
      '.goods-price',
    ];
    for (const s of sels) {
      const v = trySel(s);
      if (v) {
        const c = toCents(v);
        if (c != null && c > 0) {
          return { payableCents: c, payableRaw: v, listCents: null, listRaw: null };
        }
      }
    }
    const dataEl = document.querySelector('[data-price]');
    if (dataEl) {
      const dp = normNum(dataEl.getAttribute('data-price'));
      if (/^\d+(\.\d{1,2})?$/.test(dp)) {
        const c = toCents(dp);
        if (c != null && c > 0) {
          return { payableCents: c, payableRaw: dp, listCents: null, listRaw: null };
        }
      }
    }
    const body = document.body?.innerText || '';
    for (const raw of body.split(/\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (
        /到手价|京东价|抢购价|优惠价|补贴价|￥后价|券后|售价|共\s*￥|已降|现[：:价]/.test(line) &&
        /[¥￥\d]/.test(line)
      ) {
        const m1 = line.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
        if (m1) {
          const num = normNum(m1[1]);
          if (parseFloat(num, 10) >= 1) {
            const c = toCents(num);
            if (c != null && c > 0) {
              return { payableCents: c, payableRaw: num, listCents: null, listRaw: null };
            }
          }
        }
        const m2 = line.match(/([\d,]+(?:\.\d{1,2})?)\s*元/);
        if (m2) {
          const num = normNum(m2[1]);
          if (parseFloat(num, 10) >= 10) {
            const c = toCents(num);
            if (c != null && c > 0) {
              return { payableCents: c, payableRaw: num, listCents: null, listRaw: null };
            }
          }
        }
      }
    }
    const amounts = [];
    const reY = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g;
    let m;
    while ((m = reY.exec(body)) !== null) {
      const x = parseFloat(normNum(m[1]), 10);
      if (!Number.isNaN(x) && x >= 1) amounts.push(x);
    }
    if (amounts.length) {
      const hi = amounts.filter((x) => x >= 1000);
      const pool = hi.length ? hi : amounts.filter((x) => x >= 100);
      const pool2 = pool.length ? pool : amounts.filter((x) => x >= 10);
      const pick = pool2.length ? Math.min(...pool2) : Math.min(...amounts);
      const raw = String(pick);
      const c = toCents(raw);
      if (c != null && c > 0) {
        return { payableCents: c, payableRaw: raw, listCents: null, listRaw: null };
      }
    }
    return { payableCents: 0, payableRaw: '', listCents: null, listRaw: null };
  };

  const main = page.mainFrame();
  const frames = page.frames();
  const ordered = [];
  if (frames.includes(main)) {
    ordered.push(main);
    for (const f of frames) {
      if (f !== main) ordered.push(f);
    }
  } else {
    ordered.push(...frames);
  }
  for (let i = 0; i < ordered.length; i++) {
    try {
      const pack = await ordered[i].evaluate(snippet);
      if (pack && pack.payableCents > 0) {
        if (process.env.SCRAPER_DEBUG === '1' || isJdPriceDebug()) {
          const mainHit = ordered[i] === main;
          let u = '';
          try {
            u = ordered[i].url();
          } catch (_) {
            u = '';
          }
          const listPart =
            pack.listCents != null && pack.listCents > 0 ? ` list=${pack.listCents}c (${pack.listRaw})` : '';
          console.log(
            `[scraper] jd bundle from ${mainHit ? 'main' : `child[${i}]`}: payable=${pack.payableCents}c (${pack.payableRaw})${listPart}` +
              (u ? ` — ${u.slice(0, 120)}${u.length > 120 ? '…' : ''}` : '')
          );
        }
        return pack;
      }
    } catch (_) {
      // cross-origin frame
    }
  }
  return null;
}

/**
 * 淘宝/天猫：主价取实付/券后（偏低），标价取原价/划线（偏高，含 del、s 与常见 class）。
 */
async function taobaoExtractPriceBundleFromPage(page) {
  function taobaoBundleSnippet(keysAlt) {
    const normNum = (s) => String(s || '').replace(/,/g, '').trim();
    const toCents = (raw) => {
      const s = normNum(raw || '');
      const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
      if (!m) return null;
      const whole = parseInt(m[1], 10);
      const frac = ((m[2] || '') + '00').slice(0, 2);
      const c = whole * 100 + parseInt(frac, 10);
      return c > 0 ? c : null;
    };
    const priceFromTextLow = (raw) => {
      const t = normNum(raw || '');
      const rawStr = String(raw || '');
      const nums = [];
      const re = /(\d+(?:\.\d{1,2})?)/g;
      let mm;
      while ((mm = re.exec(t)) !== null) {
        const n = parseFloat(mm[1], 10);
        if (!Number.isNaN(n) && n >= 1) nums.push(n);
      }
      if (!nums.length) return null;
      const installment =
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(rawStr) ||
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(t);
      if (installment && nums.length >= 2) {
        return String(Math.max(...nums));
      }
      const ge100 = nums.filter((n) => n >= 100);
      const pool = ge100.length ? ge100 : nums.filter((n) => n >= 10);
      if (!pool.length) return String(Math.min(...nums));
      return String(Math.min(...pool));
    };
    const priceFromTextHigh = (raw) => {
      const t = normNum(raw || '');
      const rawStr = String(raw || '');
      const nums = [];
      const re = /(\d+(?:\.\d{1,2})?)/g;
      let mm;
      while ((mm = re.exec(t)) !== null) {
        const n = parseFloat(mm[1], 10);
        if (!Number.isNaN(n) && n >= 1) nums.push(n);
      }
      if (!nums.length) return null;
      const installment =
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(rawStr) ||
        /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(t);
      if (installment && nums.length >= 2) {
        return String(Math.max(...nums));
      }
      const ge100 = nums.filter((n) => n >= 100);
      const pool = ge100.length ? ge100 : nums.filter((n) => n >= 10);
      if (!pool.length) return String(Math.max(...nums));
      return String(Math.max(...pool));
    };
    const tryLow = (sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        return priceFromTextLow(el.textContent || '');
      } catch (_) {
        return null;
      }
    };
    const tryHigh = (sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        return priceFromTextHigh(el.textContent || '');
      } catch (_) {
        return null;
      }
    };
    const readFirst = (sels, high) => {
      const fn = high ? tryHigh : tryLow;
      for (const s of sels) {
        const v = fn(s);
        if (v) return { raw: v, sel: s };
      }
      return null;
    };

    const paySels = [
      '[class*="highlightPrice"]',
      '[class*="Price--price"]',
      '[class*="priceText--"]',
      '[class*="ItemPrice--"]',
      '[class*="itemPrice"]',
      'em.tb-rmb-num',
      '.tb-rmb-num',
      '#J_StrPriceModBox .tb-rmb-num',
      '#J_StrPrice .tb-rmb-num',
      '#J_StrPrice',
      '#J_PromoPrice .tb-rmb-num',
      '#J_PromoPrice',
      '.tb-detail-price .tb-rmb-num',
      '.tm-price .tm-mrmb',
      '.tm-price',
      '#J_priceStd',
      '.tm-m-price',
    ];
    const listSels = [
      '[class*="originPrice"]',
      '[class*="OriginPrice"]',
      '[class*="originalPrice"]',
      '[class*="lineThrough"]',
      '[class*="LineThrough"]',
      '[class*="referencePrice"]',
      '[class*="MarketPrice"]',
      '[class*="marketPrice"]',
      '[class*="counterPrice"]',
      'del .tb-rmb-num',
      's .tb-rmb-num',
    ];

    const P = readFirst(paySels, false);
    let L = readFirst(listSels, true);

    if (P) {
      const cP = toCents(P.raw);
      if (cP != null && cP > 0) {
        const roots = [
          document.querySelector('[class*="PriceMod"]'),
          document.querySelector('#J_StrPriceModBox'),
          document.querySelector('.tb-detail-price'),
          document.querySelector('[class*="mainPrice"]'),
          document.querySelector('[class*="MainPrice"]'),
          document.querySelector('[class*="itemInfo"]'),
          document.body,
        ].filter(Boolean);
        let strikeBest = null;
        let strikeC = 0;
        for (const root of roots) {
          try {
            root.querySelectorAll('del, s').forEach((el) => {
              const v = priceFromTextHigh(el.textContent || '');
              if (!v) return;
              const c = toCents(v);
              if (c != null && c > strikeC) {
                strikeC = c;
                strikeBest = v;
              }
            });
          } catch (_) {}
        }
        const cLhit = L ? toCents(L.raw) : 0;
        if (strikeC > cP && strikeBest && strikeC > (cLhit || 0)) {
          L = { raw: strikeBest, sel: 'del/s' };
        }
      }
    }

    const bodyText = document.body?.innerText || '';
    if (P && !L) {
      const cP0 = toCents(P.raw);
      if (cP0 != null && cP0 > 0) {
        for (const rawLine of bodyText.split(/\n/)) {
          const line = rawLine.trim();
          if (!/原价|划线|厂商指导|建议零售|日常价|券前|门市/.test(line)) continue;
          if (!/[¥￥\d]/.test(line)) continue;
          const m1 = line.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
          if (!m1) continue;
          const num = normNum(m1[1]);
          const c = toCents(num);
          if (c != null && c > cP0) {
            L = { raw: num, sel: 'line' };
            break;
          }
        }
      }
    }

    if (P) {
      const cP = toCents(P.raw);
      if (cP != null && cP > 0) {
        try {
          const u = new URL(location.href);
          const qp = u.searchParams.get('price');
          if (qp) {
            const qc = toCents(String(qp).replace(/,/g, ''));
            if (qc != null && qc > cP) {
              const cLcur = L ? toCents(L.raw) : 0;
              if (!L || qc > (cLcur || 0)) {
                L = { raw: normNum(qp), sel: 'urlPrice' };
              }
            }
          }
        } catch (_) {}

        const htmlSlice = String(document.documentElement.innerHTML || '').slice(0, 3200000);
        let blobBest = 0;
        let blobRaw = null;
        const floatKeys = new RegExp(
          `"(?:${keysAlt})"\\s*:\\s*"(\\d+(?:\\.\\d{1,2})?)"`,
          'gi'
        );
        const intKeys = new RegExp(`"(?:${keysAlt})"\\s*:\\s*(\\d{5,12})\\b`, 'gi');
        let bm;
        while ((bm = floatKeys.exec(htmlSlice)) !== null) {
          const c = toCents(bm[1]);
          if (c != null && c > cP && c > blobBest) {
            blobBest = c;
            blobRaw = bm[1];
          }
        }
        while ((bm = intKeys.exec(htmlSlice)) !== null) {
          const n = parseInt(bm[1], 10);
          if (!Number.isFinite(n) || n <= cP) continue;
          let cand = n;
          if (n < 50000 && n > cP / 250) {
            cand = n * 100;
          }
          if (cand <= cP) continue;
          const cap = Math.min(Math.floor(cP * 6), 80000000);
          if (cand >= cap) continue;
          if (cand > blobBest) {
            blobBest = cand;
            blobRaw = (cand / 100).toFixed(2);
          }
        }
        const yuanStr = (cP / 100).toFixed(2);
        const capNear = Math.min(Math.floor(cP * 3), 50000000);
        for (const needle of [String(cP), yuanStr]) {
          if (!needle) continue;
          let pos = htmlSlice.indexOf(needle);
          let guard = 0;
          while (pos !== -1 && guard < 50) {
            const seg = htmlSlice.slice(Math.max(0, pos - 900), Math.min(htmlSlice.length, pos + 900));
            const reNear = /\b(\d{5,8})\b/g;
            let nm;
            while ((nm = reNear.exec(seg)) !== null) {
              const n = parseInt(nm[1], 10);
              let cand = n;
              if (n < 50000 && n > cP / 400) {
                cand = n * 100;
              }
              if (cand <= cP || cand >= capNear) continue;
              if (cand > blobBest) {
                blobBest = cand;
                blobRaw = (cand / 100).toFixed(2);
              }
            }
            pos = htmlSlice.indexOf(needle, pos + 1);
            guard += 1;
          }
        }
        if (blobBest > cP && blobRaw) {
          const cLcur = L ? toCents(L.raw) : 0;
          if (!L || blobBest > (cLcur || 0)) {
            L = { raw: blobRaw, sel: 'scriptBlob' };
          }
        }
      }
    }

    if (P && L) {
      const cP = toCents(P.raw);
      const cL = toCents(L.raw);
      if (cP != null && cL != null && cP !== cL) {
        const payC = Math.min(cP, cL);
        const listC = Math.max(cP, cL);
        return {
          payableCents: payC,
          payableRaw: payC === cP ? P.raw : L.raw,
          listCents: listC,
          listRaw: listC === cL ? L.raw : P.raw,
        };
      }
      if (cP != null && cP > 0) {
        return { payableCents: cP, payableRaw: P.raw, listCents: null, listRaw: null };
      }
    }
    if (P && !L) {
      const cP = toCents(P.raw);
      if (cP != null && cP > 0) {
        return { payableCents: cP, payableRaw: P.raw, listCents: null, listRaw: null };
      }
    }
    if (L && !P) {
      const cL = toCents(L.raw);
      if (cL != null && cL > 0) {
        return { payableCents: cL, payableRaw: L.raw, listCents: null, listRaw: null };
      }
    }

    const legacySels = [
      'em.tb-rmb-num',
      '.tb-rmb-num',
      '#J_StrPriceModBox .tb-rmb-num',
      '#J_StrPrice .tb-rmb-num',
      '#J_StrPrice',
      '#J_PromoPrice .tb-rmb-num',
      '#J_PromoPrice',
      '.tb-detail-price .tb-rmb-num',
      '.tm-price .tm-mrmb',
      '.tm-price',
      '[class*="Price--price"]',
      '[class*="priceText--"]',
      '[class*="highlightPrice"]',
      '[class*="ItemPrice--"]',
      '[class*="itemPrice"]',
      '#J_priceStd',
      '.tm-m-price',
    ];
    for (const s of legacySels) {
      const v = tryLow(s);
      if (v) {
        const c = toCents(v);
        if (c != null && c > 0) {
          return { payableCents: c, payableRaw: v, listCents: null, listRaw: null };
        }
      }
    }
    const body = bodyText || document.body?.innerText || '';
    for (const raw of body.split(/\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (
        /优惠价|券后|到手价|现价|天猫价|售价|火拼价/.test(line) &&
        /[¥￥\d]/.test(line)
      ) {
        const m1 = line.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
        if (m1) {
          const num = normNum(m1[1]);
          if (parseFloat(num, 10) >= 1) {
            const c = toCents(num);
            if (c != null && c > 0) {
              return { payableCents: c, payableRaw: num, listCents: null, listRaw: null };
            }
          }
        }
      }
    }
    const amounts = [];
    const reY = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g;
    let m;
    while ((m = reY.exec(body)) !== null) {
      const x = parseFloat(normNum(m[1]), 10);
      if (!Number.isNaN(x) && x >= 1) amounts.push(x);
    }
    if (amounts.length) {
      const hi = amounts.filter((x) => x >= 1000);
      const pool = hi.length ? hi : amounts.filter((x) => x >= 100);
      const pool2 = pool.length ? pool : amounts.filter((x) => x >= 10);
      const pick = pool2.length ? Math.min(...pool2) : Math.min(...amounts);
      const raw = String(pick);
      const c = toCents(raw);
      if (c != null && c > 0) {
        return { payableCents: c, payableRaw: raw, listCents: null, listRaw: null };
      }
    }
    return { payableCents: 0, payableRaw: '', listCents: null, listRaw: null };
  }

  const main = page.mainFrame();
  const frames = page.frames();
  const ordered = [];
  if (frames.includes(main)) {
    ordered.push(main);
    for (const f of frames) {
      if (f !== main) ordered.push(f);
    }
  } else {
    ordered.push(...frames);
  }
  for (let i = 0; i < ordered.length; i++) {
    try {
      const pack = await ordered[i].evaluate(taobaoBundleSnippet, TB_ORIGINAL_PRICE_KEY_ALT);
      if (pack && pack.payableCents > 0) {
        if (process.env.SCRAPER_DEBUG === '1' || isJdPriceDebug()) {
          const mainHit = ordered[i] === main;
          let u = '';
          try {
            u = ordered[i].url();
          } catch (_) {
            u = '';
          }
          const listPart =
            pack.listCents != null && pack.listCents > 0 ? ` list=${pack.listCents}c (${pack.listRaw})` : '';
          console.log(
            `[scraper] taobao bundle from ${mainHit ? 'main' : `child[${i}]`}: payable=${pack.payableCents}c (${pack.payableRaw})${listPart}` +
              (u ? ` — ${u.slice(0, 120)}${u.length > 120 ? '…' : ''}` : '')
          );
        }
        return pack;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 在仍打开的商详页上打印各 frame 的选择器命中与 ¥ 采样，用于排查「活价」误读。
 * 启用：环境变量 JD_PRICE_DEBUG=1
 */
async function jdPriceDebugDump(page) {
  const sels = [
    '#jd-price',
    '#spec-price',
    '.p-price .price',
    '.p-price',
    '.summary-price .price',
    '.itemInfo-wrap .summary-price .price',
    '.price.J-price',
    '[class*="J_Price"]',
    '.itemInfo-wrap .price',
    '#price',
    '.goods-price .main-price',
    '[class*="price-main"]',
    '[class*="purchasePrice"]',
    '[class*="PurchasePrice"]',
    '.J-pdjd-price',
    '[class*="sku-price"]',
    '[class*="SkuPrice"]',
    '[class*="emphasisPrice"]',
    '.goods-price',
  ];

  console.log('[jd-price-debug] ===== dump (each frame: selectors with parsed value + data-price + ¥ floats) =====');
  for (const frame of page.frames()) {
    let frameUrl = '';
    try {
      frameUrl = frame.url();
    } catch (_) {
      frameUrl = '(unavailable)';
    }
    try {
      const block = await frame.evaluate(
        ({ selectorList }) => {
          const normNum = (s) => String(s || '').replace(/,/g, '').trim();
          const priceFromText = (raw) => {
            const t = normNum(raw || '');
            const rawStr = String(raw || '');
            const nums = [];
            const re = /(\d+(?:\.\d{1,2})?)/g;
            let mm;
            while ((mm = re.exec(t)) !== null) {
              const n = parseFloat(mm[1], 10);
              if (!Number.isNaN(n) && n >= 1) nums.push(n);
            }
            if (!nums.length) return null;
            const installment =
              /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(rawStr) ||
              /\d+\s*期|\/\s*月|每期|分期|[×x]\s*\d+\s*期|花呗|白条/.test(t);
            if (installment && nums.length >= 2) {
              return String(Math.max(...nums));
            }
            const ge100 = nums.filter((n) => n >= 100);
            const pool = ge100.length ? ge100 : nums.filter((n) => n >= 10);
            if (!pool.length) return String(Math.min(...nums));
            return String(Math.min(...pool));
          };
          const hits = [];
          for (const s of selectorList) {
            try {
              const el = document.querySelector(s);
              if (!el) {
                hits.push({ sel: s, hit: false });
                continue;
              }
              const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
              const parsed = priceFromText(el.textContent || '');
              hits.push({
                sel: s,
                hit: true,
                sample: fullText.slice(0, 140),
                parsed,
              });
            } catch (_) {
              hits.push({ sel: s, err: true });
            }
          }
          const dataEl = document.querySelector('[data-price]');
          const dataPriceAttr = dataEl ? normNum(dataEl.getAttribute('data-price')) : null;
          const body = document.body?.innerText || '';
          const yenFloats = [];
          const yre = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g;
          let m;
          while ((m = yre.exec(body)) !== null && yenFloats.length < 35) {
            yenFloats.push(parseFloat(normNum(m[1]), 10));
          }
          const withParsed = hits.filter((h) => h.parsed);
          return { dataPriceAttr, parsedHits: withParsed, yenFloats };
        },
        { selectorList: sels }
      );
      console.log(
        `[jd-price-debug] frame url: ${frameUrl}\n` +
          `  data-price attr: ${block.dataPriceAttr}\n` +
          `  selector parsed hits: ${JSON.stringify(block.parsedHits, null, 2)}\n` +
          `  ¥ floats (first 35): ${JSON.stringify(block.yenFloats)}`
      );
    } catch (e) {
      console.log(`[jd-price-debug] frame url: ${frameUrl}\n  (skip: ${e && e.message ? e.message : String(e)})`);
    }
  }
}

/**
 * @param headfulResume null = 终端 Enter / HEADFUL_AUTO_WAIT_MS（沿用原逻辑）;
 *                      { kind:'timeout', ms } = 网页「自动等待」;
 *                      { kind:'webPromise', promise } = 网页「手动确认」resolve 后继续
 */
async function fetchHtml(productUrl, userDataDir, headful = false, headfulResume = null) {
  return runWithPersistentProfileLock(userDataDir, () => fetchHtmlUnlocked(productUrl, userDataDir, headful, headfulResume));
}

async function fetchHtmlUnlocked(productUrl, userDataDir, headful = false, headfulResume = null) {
  const isJd = productUrl.includes('jd.com');
  const isTb = /\.(taobao|tmall)\.com/i.test(productUrl) || productUrl.includes('taobao.com') || productUrl.includes('tmall.com');
  const isPdd = isPinduoduoFamilyUrl(productUrl);
  const useChromeChannel = !!userDataDir;
  const launchOpts = launchBrowserOptions(headful, !headful && useChromeChannel);
  let browser;
  try {
    browser = userDataDir
      ? await chromium.launchPersistentContext(userDataDir, {
          ...launchOpts,
          viewport: { width: 1365, height: 900 },
          locale: 'zh-CN',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        })
      : await chromium.launch(launchOpts);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (userDataDir) {
      throw new Error(
        `${msg}\n` +
          '（提示）若设置了用户数据目录：请关闭所有正在使用该目录的 Chrome 窗口；若同时开启了「后台监测」，请先停掉监测或等本轮抓取结束后再添加链接，否则会出现「配置文件已被占用 / 浏览器已关闭」类错误。'
      );
    }
    throw e;
  }

  const page = await browser.newPage();

  const waitUntil = isJd || isTb || isPdd ? 'load' : 'domcontentloaded';
  await page.goto(productUrl, { waitUntil, timeout: 120000 });

  if (headful) {
    if (headfulResume && headfulResume.kind === 'timeout') {
      const ms = Math.max(0, headfulResume.ms || 0);
      console.log(`[headful] 网页「自动等待」${ms / 1000}s 后继续抓取…`);
      await new Promise((r) => setTimeout(r, ms));
    } else if (headfulResume && headfulResume.kind === 'webPromise' && headfulResume.promise) {
      console.log('[headful] 等待网页端「继续抓取」或 POST /api/add/continue …');
      await headfulResume.promise;
    } else {
      const autoMs = Number(process.env.HEADFUL_AUTO_WAIT_MS || 0);
      if (process.stdin.isTTY && !autoMs) {
        console.log('');
        console.log(
          '[headful] 已在浏览器中打开商品页。请在弹出的 Chrome 里完成登录/验证，确认标题与价格可见后，到【本机运行 node 的这个终端窗口】按 Enter 才会继续抓取并写入数据库（不是浏览器里按回车）。'
        );
        await waitForEnter('按 Enter 继续抓取… > ');
      } else {
        const ms = autoMs > 0 ? autoMs : 180000;
        console.log(
          `[headful] 当前 stdin 非交互（例如从 IDE 启动 web），将自动等待 ${ms / 1000}s 再抓取。` +
            `若登录较慢，请设置环境变量 HEADFUL_AUTO_WAIT_MS=300000，或改用 PowerShell/CMD 直接运行 node 以在终端按 Enter。\n`
        );
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  } else {
    await new Promise((r) => setTimeout(r, isJd || isTb ? 4000 : isPdd ? 5000 : 2500));
    if (isJd) {
      await page
        .waitForFunction(
          () => {
            const b = document.body;
            if (!b) return false;
            const t = b.innerText || '';
            if (/[¥￥]\s*[\d]/.test(t)) return true;
            const sel =
              '.summary-price .price, .itemInfo-wrap .price, #jd-price, .p-price .price, .price.J-price, [class*="J_Price"], [class*="purchasePrice"], .goods-price .main-price';
            const el = document.querySelector(sel);
            return !!(el && /\d/.test(el.textContent || ''));
          },
          { timeout: 25000 }
        )
        .catch(() => {});
    }
    if (isTb) {
      await page
        .waitForFunction(
          () => {
            const b = document.body;
            if (!b) return false;
            const t = b.innerText || '';
            if (/[¥￥]\s*[\d]/.test(t)) return true;
            const sel =
              'em.tb-rmb-num, .tb-rmb-num, .tm-price, [class*="Price--price"], [class*="priceText--"]';
            const el = document.querySelector(sel);
            return !!(el && /\d/.test(el.textContent || ''));
          },
          { timeout: 28000 }
        )
        .catch(() => {});
    }
    if (isPdd) {
      await page
        .waitForFunction(
          () => {
            const b = document.body;
            if (!b) return false;
            const t = b.innerText || '';
            if (/[¥￥]\s*[\d]/.test(t)) return true;
            return /拼单价|券后|万人团|销量|已拼/.test(t) && /\d+(\.\d{1,2})?/.test(t);
          },
          { timeout: 22000 }
        )
        .catch(() => {});
    }
  }

  let livePriceRaw = null;
  let liveListPriceRaw = null;
  if (isJd) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      await page.mouse.wheel(0, 320);
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) {}
    let jdBundle = await jdExtractPriceBundleFromPage(page);
    if (!jdBundle || !jdBundle.payableCents) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 400));
      } catch (_) {}
      jdBundle = await jdExtractPriceBundleFromPage(page);
    }
    if (jdBundle && jdBundle.payableCents > 0) {
      livePriceRaw = jdBundle.payableRaw;
      liveListPriceRaw =
        jdBundle.listCents != null && jdBundle.listCents > 0 && jdBundle.listRaw ? jdBundle.listRaw : null;
    }
  } else if (isTb) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      await page.mouse.wheel(0, 280);
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) {}
    let tbBundle = await taobaoExtractPriceBundleFromPage(page);
    if (!tbBundle || !tbBundle.payableCents) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 400));
      } catch (_) {}
      tbBundle = await taobaoExtractPriceBundleFromPage(page);
    }
    if (tbBundle && tbBundle.payableCents > 0) {
      livePriceRaw = tbBundle.payableRaw;
      liveListPriceRaw =
        tbBundle.listCents != null && tbBundle.listCents > 0 && tbBundle.listRaw ? tbBundle.listRaw : null;
    }
  }

  if (isJd && isJdPriceDebug()) {
    console.log(
      `[jd-price-debug] live payable / 标价: ${livePriceRaw == null ? '(null)' : JSON.stringify(String(livePriceRaw))} / ${liveListPriceRaw == null ? '—' : JSON.stringify(String(liveListPriceRaw))}`
    );
    try {
      await jdPriceDebugDump(page);
    } catch (e) {
      console.warn('[jd-price-debug] dump failed:', e && e.message ? e.message : e);
    }
  }

  const finalUrl = page.url();
  const html = await page.content();

  try {
    await page.close();
  } catch (_) {}
  try {
    await browser.close();
  } catch (_) {}

  return { finalUrl, html, livePriceRaw, liveListPriceRaw };
}

function findFirstString(obj, keySet) {
  if (!obj || typeof obj !== 'object') return null;
  const visited = new Set();

  function walk(x) {
    if (!x || typeof x !== 'object') return null;
    if (visited.has(x)) return null;
    visited.add(x);

    if (Array.isArray(x)) {
      for (const it of x) {
        const v = walk(it);
        if (typeof v === 'string' && v.trim()) return v;
      }
      return null;
    }

    for (const [k, v] of Object.entries(x)) {
      if (keySet.has(k) && typeof v === 'string' && v.trim()) return v;
      const vv = walk(v);
      if (typeof vv === 'string' && vv.trim()) return vv;
    }
    return null;
  }

  return walk(obj);
}

function extractProductNameFromCheerio($) {
  const og = $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content');
  if (og && og.trim()) return og.trim();

  const itemName = $('[itemprop="name"]').first().attr('content') || $('[itemprop="name"]').first().text();
  if (itemName && itemName.trim()) return itemName.trim();

  // JSON-LD
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const txt = $(scripts[i]).text().trim();
    if (!txt) continue;
    try {
      const data = JSON.parse(txt);
      const name = findFirstString(data, new Set(['name']));
      if (name && name.trim()) return name.trim();
    } catch (_) {
      // ignore parse errors
    }
  }

  if ($('title').length) {
    const t = $('title').text().trim();
    if (t) return t;
  }

  return null;
}

function priceStrToCents(priceStr) {
  if (!priceStr) return null;
  const s = String(priceStr).replace(/,/g, '').trim();
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = parseInt(m[1], 10);
  const frac = m[2] ? m[2] : '0';
  const frac2 = (frac + '00').slice(0, 2);
  return whole * 100 + parseInt(frac2, 10);
}

function extractPriceCandidatesFromText($, html) {
  const re = /(?:¥|￥)\s*([0-9]+(?:\.[0-9]{1,2})?)/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const cents = priceStrToCents(m[1]);
    if (cents !== null) out.push(cents);
  }
  if (out.length) return out;

  // fallback: scan some likely price-ish elements
  const candidates = [];
  const selectors = ['[class*="price" i]', '[id*="price" i]', '[data-price]'];
  for (const sel of selectors) {
    $(sel)
      .slice(0, 200)
      .each((_, el) => {
        const t = $(el).text().trim();
        const mm = t.match(re);
        if (mm && mm[1]) {
          const cents = priceStrToCents(mm[1]);
          if (cents !== null) candidates.push(cents);
        }
      });
  }
  return candidates;
}

function extractPriceCandidatesFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  const out = [];

  function collectOffers(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const it of node) collectOffers(it);
      return;
    }

    // offers: { price: "199.00" }
    if (node.offers && typeof node.offers === 'object') {
      if (Array.isArray(node.offers)) {
        for (const it of node.offers) collectOffers(it);
      } else {
        const p = node.offers.price ?? node.offers.lowPrice ?? node.offers.highPrice;
        const cents = priceStrToCents(String(p));
        if (cents !== null) out.push(cents);
      }
    }

    // sometimes price directly
    if (node.price !== undefined) {
      const cents = priceStrToCents(String(node.price));
      if (cents !== null) out.push(cents);
    }

    for (const v of Object.values(node)) collectOffers(v);
  }

  for (let i = 0; i < scripts.length; i++) {
    const txt = $(scripts[i]).text().trim();
    if (!txt) continue;
    try {
      const data = JSON.parse(txt);
      collectOffers(data);
    } catch (_) {
      // ignore
    }
  }

  return out;
}

function pickJdFirstPriceFromSelectors($, selectors) {
  for (const sel of selectors) {
    const raw = $(sel).first().text().replace(/\s/g, '');
    const m = raw.match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) continue;
    const cents = priceStrToCents(m[1]);
    if (cents !== null && cents > 0) return { priceCents: cents, rawPrice: m[1] };
  }
  return null;
}

function isTaobaoFamilyHtml(html) {
  return /taobao\.com|tmall\.com|item\.taobao|detail\.tmall/i.test(String(html || ''));
}

/** 天猫/淘宝商详 HTML 内嵌 JSON 里的原价字段（多为整型「分」，与实付同量级）。 */
function extractTaobaoListFromHtmlBlob(html, payCents) {
  if (!html || !payCents || payCents <= 0) return null;
  const slice = String(html).slice(0, 3200000);
  let best = 0;
  let bestRaw = null;
  const floatRe = tbOriginalPriceFloatRegex();
  let m;
  while ((m = floatRe.exec(slice)) !== null) {
    const c = priceStrToCents(m[1]);
    if (c != null && c > payCents && c > best) {
      best = c;
      bestRaw = m[1];
    }
  }
  const intRe = tbOriginalPriceIntRegex();
  while ((m = intRe.exec(slice)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= payCents) continue;
    let cand = n;
    if (n < 50000 && n > payCents / 250) {
      cand = n * 100;
    }
    if (cand <= payCents) continue;
    const cap = Math.min(Math.floor(payCents * 6), 80000000);
    if (cand >= cap) continue;
    if (cand > best) {
      best = cand;
      bestRaw = (cand / 100).toFixed(2);
    }
  }
  const near = extractTaobaoListNearPayLiteral(html, payCents);
  if (near && near.listPriceCents > best) {
    best = near.listPriceCents;
    bestRaw = near.listRawPrice;
  }
  if (best <= payCents || !bestRaw) return null;
  return { listPriceCents: best, listRawPrice: bestRaw };
}

function pickTbPriceFromCheerio($, selectors, preferHigh) {
  for (const sel of selectors) {
    const raw = $(sel).first().text().replace(/\s/g, '');
    if (!raw) continue;
    const nums = [];
    const re = /(\d+(?:\.\d{1,2})?)/g;
    let mm;
    while ((mm = re.exec(raw)) !== null) {
      const n = parseFloat(mm[1], 10);
      if (!Number.isNaN(n) && n >= 1) nums.push(n);
    }
    if (!nums.length) continue;
    const ge100 = nums.filter((n) => n >= 100);
    const pool = ge100.length ? ge100 : nums.filter((n) => n >= 10);
    const pick = preferHigh
      ? Math.max(...(pool.length ? pool : nums))
      : Math.min(...(pool.length ? pool : nums));
    const rawNum = String(pick);
    const cents = priceStrToCents(rawNum);
    if (cents !== null && cents > 0) return { priceCents: cents, rawPrice: rawNum };
  }
  return null;
}

/** Cheerio：淘宝/天猫双价（无头回退）。 */
function extractTaobaoDualFromCheerio($, html) {
  if (!isTaobaoFamilyHtml(html)) return null;
  const paySels = [
    '[class*="highlightPrice"]',
    '[class*="Price--price"]',
    '[class*="priceText--"]',
    '[class*="ItemPrice--"]',
    '[class*="itemPrice"]',
    'em.tb-rmb-num',
    '.tb-rmb-num',
    '#J_StrPriceModBox .tb-rmb-num',
    '#J_StrPrice .tb-rmb-num',
    '#J_PromoPrice .tb-rmb-num',
    '.tm-price .tm-mrmb',
    '.tm-price',
    '#J_priceStd',
  ];
  const listSels = [
    '[class*="originPrice"]',
    '[class*="OriginPrice"]',
    '[class*="originalPrice"]',
    '[class*="lineThrough"]',
    '[class*="LineThrough"]',
    '[class*="referencePrice"]',
    '[class*="marketPrice"]',
    'del .tb-rmb-num',
    's .tb-rmb-num',
  ];
  const P = pickTbPriceFromCheerio($, paySels, false);
  let L = pickTbPriceFromCheerio($, listSels, true);

  let strikeC = 0;
  let strikeRaw = null;
  $('del, s').each((_, el) => {
    const t = $(el).text().replace(/\s/g, '');
    if (!/\d/.test(t)) return;
    const re = /(\d+(?:\.\d{1,2})?)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const c = priceStrToCents(m[1]);
      if (c !== null && c > strikeC) {
        strikeC = c;
        strikeRaw = m[1];
      }
    }
  });
  if (P && strikeC > P.priceCents && strikeC > (L ? L.priceCents : 0)) {
    L = { priceCents: strikeC, rawPrice: strikeRaw };
  }

  if (P) {
    const blob = extractTaobaoListFromHtmlBlob(html, P.priceCents);
    if (blob && blob.listPriceCents > (L ? L.priceCents : 0)) {
      L = { priceCents: blob.listPriceCents, rawPrice: blob.listRawPrice };
    }
  }

  if (P && L && P.priceCents !== L.priceCents) {
    const pay = P.priceCents < L.priceCents ? P : L;
    const list = P.priceCents > L.priceCents ? P : L;
    return {
      priceCents: pay.priceCents,
      currency: 'CNY',
      rawPrice: pay.rawPrice,
      listPriceCents: list.priceCents,
      listRawPrice: list.rawPrice,
    };
  }
  if (P) return { priceCents: P.priceCents, currency: 'CNY', rawPrice: P.rawPrice };
  if (L) return { priceCents: L.priceCents, currency: 'CNY', rawPrice: L.rawPrice };
  return null;
}

/** Cheerio：与页面脚本相同的「标价 / summary」双价逻辑（无头回退）。 */
function extractJdDualFromCheerio($, html) {
  if (!html.includes('jd.com') && !html.includes('jdprice') && !html.includes('item.jd')) return null;
  const listSels = ['.p-price .price', '.p-price', '#jd-price', '#spec-price', '.price.J-price', '[class*="J_Price"]'];
  const summarySels = ['.summary-price .price', '.itemInfo-wrap .summary-price .price', '.itemInfo-wrap .price'];
  const L = pickJdFirstPriceFromSelectors($, listSels);
  const S = pickJdFirstPriceFromSelectors($, summarySels);
  if (S && L && S.priceCents !== L.priceCents) {
    const pay = S.priceCents < L.priceCents ? S : L;
    const list = S.priceCents > L.priceCents ? S : L;
    return {
      priceCents: pay.priceCents,
      currency: 'CNY',
      rawPrice: pay.rawPrice,
      listPriceCents: list.priceCents,
      listRawPrice: list.rawPrice,
    };
  }
  if (S) return { priceCents: S.priceCents, currency: 'CNY', rawPrice: S.rawPrice };
  if (L) return { priceCents: L.priceCents, currency: 'CNY', rawPrice: L.rawPrice };
  return null;
}

function extractJdPriceFromDom($, html) {
  if (!html.includes('jd.com') && !html.includes('jdprice') && !html.includes('item.jd')) return null;
  const selectors = [
    '.summary-price .price',
    '.itemInfo-wrap .summary-price .price',
    '#jd-price',
    '.p-price .price',
    '.p-price',
    '.price.J-price',
    '[class*="J_Price"]',
    '.itemInfo-wrap .price',
  ];
  for (const sel of selectors) {
    const raw = $(sel).first().text().replace(/\s/g, '');
    const m = raw.match(/(\d+(?:\.\d{1,2})?)/);
    if (m) {
      const cents = priceStrToCents(m[1]);
      if (cents !== null && cents > 0) return { priceCents: cents, currency: 'CNY', rawPrice: m[1] };
    }
  }
  return null;
}

/** 从内嵌脚本里扫价格字段；不含松散 `"p":"…"`（易匹配无关 JSON，导致 Math.min 拉到错误低价）。 */
const JD_SCRIPT_PRICE_PATTERNS = [
  { tag: '"price":"…"', re: /"price"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi },
  { tag: 'jdPrice', re: /jdPrice["']?\s*[:=]\s*(\d+(?:\.\d{1,2})?)/gi },
  { tag: '"salePrice"', re: /"salePrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi },
  { tag: '"purchasePrice"', re: /"purchasePrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi },
  { tag: '"finalPrice"', re: /"finalPrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi },
  { tag: 'cashSalePrice', re: /cashSalePrice["']?\s*[:=]\s*["']?(\d+(?:\.\d{1,2})?)/gi },
  { tag: '"jdPrice"', re: /"jdPrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi },
];

function collectJdBlobPriceMatches(html) {
  if (!html.includes('jd.com')) return [];
  const rows = [];
  for (const { tag, re } of JD_SCRIPT_PRICE_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    let m;
    while ((m = r.exec(html)) !== null) {
      const v = m[1];
      if (!v) continue;
      const cents = priceStrToCents(v);
      if (cents !== null && cents >= 1) rows.push({ tag, cents, raw: v });
    }
  }
  return rows;
}

function extractJdPriceFromScriptBlob(html) {
  if (!html.includes('jd.com')) return null;
  const chunks = [];
  for (const { re } of JD_SCRIPT_PRICE_PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    let m;
    while ((m = r.exec(html)) !== null) {
      const v = m[1];
      if (v) {
        const cents = priceStrToCents(v);
        if (cents !== null && cents >= 1) chunks.push(cents);
      }
    }
  }
  if (!chunks.length) return null;
  const priceCents = Math.min(...chunks);
  if (priceCents <= 0) return null;
  return { priceCents, currency: 'CNY', rawPrice: String(priceCents / 100) };
}

function extractPriceFromCheerio($, html, livePriceRaw = null, liveListPriceRaw = null) {
  const jdDbg =
    isJdPriceDebug() && (html.includes('jd.com') || html.includes('item.jd') || html.includes('jdprice'));
  const jlog = (...a) => {
    if (jdDbg) console.log('[jd-price-debug] cheerio path:', ...a);
  };

  if (livePriceRaw) {
    const cents = priceStrToCents(String(livePriceRaw).replace(/,/g, '').trim());
    if (cents !== null && cents > 0) {
      let listPriceCents = null;
      let listRawPrice = null;
      if (liveListPriceRaw != null && String(liveListPriceRaw).trim()) {
        const lc = priceStrToCents(String(liveListPriceRaw).replace(/,/g, '').trim());
        if (lc !== null && lc > 0 && lc !== cents) {
          listPriceCents = lc;
          listRawPrice = String(liveListPriceRaw).trim();
        }
      }
      jlog('use live payable', String(livePriceRaw).trim(), 'cents', cents, 'list', listRawPrice || '—');
      const out = {
        priceCents: cents,
        currency: 'CNY',
        rawPrice: String(livePriceRaw).trim(),
      };
      if (listPriceCents != null) {
        out.listPriceCents = listPriceCents;
        out.listRawPrice = listRawPrice;
      }
      return out;
    }
    jlog('livePriceRaw invalid, fall through:', livePriceRaw, 'parsed cents', cents);
  }

  const tbDual = extractTaobaoDualFromCheerio($, html);
  if (tbDual) return tbDual;

  const jdDual = extractJdDualFromCheerio($, html);
  if (jdDual) {
    jlog('use extractJdDualFromCheerio', jdDual);
    return jdDual;
  }

  const jdDom = extractJdPriceFromDom($, html);
  if (jdDom) {
    jlog('use extractJdPriceFromDom', jdDom);
    return jdDom;
  }

  const jdBlob = extractJdPriceFromScriptBlob(html);
  if (jdBlob) {
    if (jdDbg) {
      const matches = collectJdBlobPriceMatches(html);
      const byCents = [...new Set(matches.map((x) => x.cents))].sort((a, b) => a - b);
      jlog('use extractJdPriceFromScriptBlob (Math.min)', jdBlob, 'unique blob cents count', byCents.length);
      jlog(
        'blob match sample (max 40):',
        matches.slice(0, 40).map((x) => `${x.tag}=${x.raw}(${x.cents}c)`)
      );
    }
    return jdBlob;
  }

  // 1) meta[itemprop=price]
  const metaPrice = $('meta[itemprop="price"]').attr('content');
  if (metaPrice) {
    const cents = priceStrToCents(metaPrice);
    if (cents !== null) {
      jlog('use meta[itemprop=price]', metaPrice, '=> cents', cents);
      return { priceCents: cents, currency: 'CNY', rawPrice: metaPrice };
    }
  }

  // 2) JSON-LD offers.price
  const jsonCandidates = extractPriceCandidatesFromJsonLd($);
  if (jsonCandidates.length) {
    // heuristic: current price often appears as the smallest candidate (discounted price)
    const priceCents = Math.min(...jsonCandidates);
    jlog('use JSON-LD min', { priceCents, candidates: jsonCandidates.slice(0, 15) });
    return { priceCents, currency: 'CNY', rawPrice: String(priceCents / 100) };
  }

  // 3) text regex heuristic
  const textCandidates = extractPriceCandidatesFromText($, html);
  if (textCandidates.length) {
    const priceCents = Math.min(...textCandidates);
    jlog('use text regex min', { priceCents, candidates: textCandidates.slice(0, 15) });
    return { priceCents, currency: 'CNY', rawPrice: String(priceCents / 100) };
  }

  jlog('no price extracted');
  return null;
}

function looksLikeCaptcha(html, { hasReliablePrice, sourceUrl, landingUrl } = {}) {
  if (isJdItemUrlRedirectedAway(sourceUrl, landingUrl)) return true;
  if (isTaobaoItemUrlRedirectedAway(sourceUrl, landingUrl)) return true;

  if (hasReliablePrice) return false;

  const landing = String(landingUrl || sourceUrl || '').toLowerCase();
  if (/login\.taobao|passport\.taobao|login\.tmall|passport\.tmall/i.test(landing)) return true;

  const s = String(html).toLowerCase();
  const isTaobaoContext =
    isTaobaoFamilyUrl(sourceUrl) ||
    isTaobaoFamilyUrl(landingUrl) ||
    s.includes('item.taobao') ||
    s.includes('detail.tmall') ||
    s.includes('tmall.com');

  const isPddContext =
    isPinduoduoFamilyUrl(sourceUrl) ||
    isPinduoduoFamilyUrl(landingUrl) ||
    s.includes('yangkeduo.com') ||
    s.includes('pinduoduo.com');

  if (s.includes('活动太火爆') || s.includes('系统繁忙') || s.includes('访问过于频繁')) return true;

  const thirdPartyLib =
    s.includes('geetest') || s.includes('recaptcha') || s.includes('hcaptcha');
  if (thirdPartyLib) {
    // 淘宝/天猫商详常预加载 geetest 等脚本，单独出现不作为验证码页
    if (isTaobaoContext) {
      if (
        s.includes('滑动验证') ||
        s.includes('请按住滑块') ||
        s.includes('亲，请登录') ||
        s.includes('哎呀出错了') ||
        s.includes('访问被拒绝')
      ) {
        return true;
      }
      // 有「请完成验证」且同时像人机页时才判（避免普通文案误伤）
      if (s.includes('请完成验证') && (s.includes('滑块') || s.includes('captcha') || s.includes('验证控件'))) {
        return true;
      }
    } else if (isPddContext) {
      if (
        s.includes('滑动验证') ||
        s.includes('请按住滑块') ||
        s.includes('人机验证') ||
        s.includes('访问被拒绝') ||
        (s.includes('请完成验证') && (s.includes('滑块') || s.includes('captcha')))
      ) {
        return true;
      }
    } else {
      return true;
    }
  }

  if (s.includes('滑动验证') || s.includes('人机验证')) return true;
  if (s.includes('/punish')) return true;
  // 淘宝 HTML 里常出现 verify/security 字样的外链脚本，非淘站点才据此判拦
  if (!isTaobaoContext && !isPddContext && (s.includes('verify.html') || s.includes('securityverification')))
    return true;
  if (!isTaobaoContext && !isPddContext) {
    if (s.includes('请完成验证') || s.includes('安全验证') || s.includes('访问验证') || s.includes('请滑动'))
      return true;
  } else if (
    s.includes('请滑动') &&
    (s.includes('验证') || s.includes('unsafe') || s.includes('前方拥挤'))
  ) {
    return true;
  }

  return false;
}

/**
 * 短链/分享打开的 item.htm 常带 `price=5999`，与主标价一致；DOM 易误抓到分期/定金等小数字。
 */
function taobaoSharePriceFromItemUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const h = u.hostname.toLowerCase();
    if (!h.includes('tmall.com') && !h.includes('taobao.com')) return null;
    if (!/\/item\.htm/i.test(u.pathname) && !/\/detail\//i.test(u.pathname)) return null;
    const p = u.searchParams.get('price');
    if (p == null || !String(p).trim()) return null;
    const raw = String(p).trim().replace(/,/g, '');
    const cents = priceStrToCents(raw);
    if (cents == null || cents < 100) return null;
    return { priceCents: cents, currency: 'CNY', rawPrice: raw };
  } catch (_) {
    return null;
  }
}

function preferTaobaoSharePriceWhenDomMismatch(domPrice, finalUrl) {
  const share = taobaoSharePriceFromItemUrl(finalUrl);
  if (!share) return domPrice;
  if (!domPrice || !domPrice.priceCents) return share;
  const a = domPrice.priceCents;
  const b = share.priceCents;
  if (b <= 0) return domPrice;
  const rel = Math.abs(a - b) / b;
  if (rel > 0.12) return share;
  return domPrice;
}

async function parseProductOnce(url, { userDataDir, headful, headfulResume } = {}) {
  const { finalUrl, html, livePriceRaw, liveListPriceRaw } = await fetchHtml(url, userDataDir, headful, headfulResume);
  const $ = cheerio.load(html);
  const productName = extractProductNameFromCheerio($) || '';
  let price = extractPriceFromCheerio($, html, livePriceRaw, liveListPriceRaw);
  price = preferTaobaoSharePriceWhenDomMismatch(price, finalUrl);
  const hasReliablePrice = !!price && price.priceCents > 0;
  return {
    finalUrl,
    productName: productName.trim(),
    price,
    htmlWasCaptcha: looksLikeCaptcha(html, { hasReliablePrice, sourceUrl: url, landingUrl: finalUrl }),
  };
}

/**
 * 同一 URL 多次尝试（慢加载、首屏未出价等）。环境变量 SCRAPE_RETRIES 默认 2（共最多 3 次请求）。
 * 真验证码页重试通常无效，需 --headful 人工过验证或换网络/登录态。
 */
async function parseProduct(url, opts = {}) {
  const maxRetries = Math.max(0, Number(opts.maxRetries ?? process.env.SCRAPE_RETRIES ?? 2));
  let last = await parseProductOnce(url, opts);
  if (last.price && last.price.priceCents > 0) return last;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ms = 2000 * attempt;
    console.warn(`[scraper] no price yet, retry ${attempt}/${maxRetries} after ${ms}ms`);
    await new Promise((r) => setTimeout(r, ms));
    last = await parseProductOnce(url, opts);
    if (last.price && last.price.priceCents > 0) return last;
  }
  return last;
}

module.exports = {
  getSiteFromUrl,
  fetchHtml,
  parseProduct,
  parseProductOnce,
};

