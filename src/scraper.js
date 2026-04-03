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

function isPinduoduoFamilyUrl(url) {
  return /pinduoduo\.com|yangkeduo\.com/i.test(String(url || ''));
}

function launchBrowserOptions(headful, useChromeChannel) {
  const stealth = {
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  if (headful) {
    return { headless: false, channel: 'chrome', ...stealth };
  }
  if (useChromeChannel) {
    return { headless: true, channel: 'chrome', ...stealth };
  }
  return { headless: true, ...stealth };
}

/**
 * 在真实 DOM 里取京东现价（含主站 iframe、常见文案行、千分位）。
 * 新版商详价格常在子 frame 或仅出现在可见文本里。
 */
async function jdExtractLivePriceFromPage(page) {
  const snippet = () => {
    const normNum = (s) => String(s || '').replace(/,/g, '').trim();
    const trySel = (sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        const t = normNum(el.textContent || '');
        const m = t.match(/(\d+(?:\.\d{1,2})?)/);
        if (m && parseFloat(m[1], 10) > 0) return m[1];
      } catch (_) {}
      return null;
    };
    const sels = [
      '.summary-price .price',
      '.itemInfo-wrap .summary-price .price',
      '#jd-price',
      '.p-price .price',
      '.p-price',
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
      '#spec-price',
    ];
    for (const s of sels) {
      const v = trySel(s);
      if (v) return v;
    }
    const dataEl = document.querySelector('[data-price]');
    if (dataEl) {
      const dp = normNum(dataEl.getAttribute('data-price'));
      if (/^\d+(\.\d{1,2})?$/.test(dp)) return dp;
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
          if (parseFloat(num, 10) >= 1) return num;
        }
        const m2 = line.match(/([\d,]+(?:\.\d{1,2})?)\s*元/);
        if (m2) {
          const num = normNum(m2[1]);
          if (parseFloat(num, 10) >= 10) return num;
        }
      }
    }
    const amounts = [];
    const re = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const x = parseFloat(normNum(m[1]), 10);
      if (!Number.isNaN(x) && x >= 1) amounts.push(x);
    }
    if (amounts.length) {
      const mx = Math.max(...amounts);
      if (mx >= 5) return String(mx);
    }
    return null;
  };

  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try {
      const v = await frames[i].evaluate(snippet);
      if (v) {
        if (process.env.SCRAPER_DEBUG === '1') {
          console.log(`[scraper] jd live price from frame[${i}]: ${v}`);
        }
        return v;
      }
    } catch (_) {
      // cross-origin frame
    }
  }
  return null;
}

/** 淘宝/天猫商详 DOM 取价（与新套件类名、老 .tb-rmb-num 等兼容） */
async function taobaoExtractLivePriceFromPage(page) {
  const snippet = () => {
    const normNum = (s) => String(s || '').replace(/,/g, '').trim();
    const trySel = (sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        const t = normNum(el.textContent || '');
        const m = t.match(/(\d+(?:\.\d{1,2})?)/);
        if (m && parseFloat(m[1], 10) > 0) return m[1];
      } catch (_) {}
      return null;
    };
    const sels = [
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
    const fromSels = [];
    for (const s of sels) {
      const v = trySel(s);
      if (v) {
        const n = parseFloat(v, 10);
        if (!Number.isNaN(n) && n > 0) fromSels.push(n);
      }
    }
    if (fromSels.length) {
      const mx = Math.max(...fromSels);
      if (mx >= 5) return String(mx);
    }
    const body = document.body?.innerText || '';
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
          if (parseFloat(num, 10) >= 1) return num;
        }
      }
    }
    const amounts = [];
    const re = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const x = parseFloat(normNum(m[1]), 10);
      if (!Number.isNaN(x) && x >= 1) amounts.push(x);
    }
    if (amounts.length) {
      const mx = Math.max(...amounts);
      if (mx >= 5) return String(mx);
    }
    return null;
  };

  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try {
      const v = await frames[i].evaluate(snippet);
      if (v) {
        if (process.env.SCRAPER_DEBUG === '1') {
          console.log(`[scraper] taobao live price from frame[${i}]: ${v}`);
        }
        return v;
      }
    } catch (_) {}
  }
  return null;
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
  if (isJd) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      await page.mouse.wheel(0, 320);
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) {}
    livePriceRaw = await jdExtractLivePriceFromPage(page);
    if (!livePriceRaw) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 400));
      } catch (_) {}
      livePriceRaw = await jdExtractLivePriceFromPage(page);
    }
  } else if (isTb) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      await page.mouse.wheel(0, 280);
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) {}
    livePriceRaw = await taobaoExtractLivePriceFromPage(page);
    if (!livePriceRaw) {
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, 400));
      } catch (_) {}
      livePriceRaw = await taobaoExtractLivePriceFromPage(page);
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

  return { finalUrl, html, livePriceRaw };
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

function extractJdPriceFromScriptBlob(html) {
  if (!html.includes('jd.com')) return null;
  const chunks = [];
  const patterns = [
    /"price"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
    /"p"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
    /jdPrice["']?\s*[:=]\s*(\d+(?:\.\d{1,2})?)/gi,
    /"salePrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
    /"purchasePrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
    /"finalPrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
    /cashSalePrice["']?\s*[:=]\s*["']?(\d+(?:\.\d{1,2})?)/gi,
    /"jdPrice"\s*:\s*"(\d+(?:\.\d{1,2})?)"/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
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

function extractPriceFromCheerio($, html, livePriceRaw = null) {
  if (livePriceRaw) {
    const cents = priceStrToCents(String(livePriceRaw).replace(/,/g, '').trim());
    if (cents !== null && cents > 0) {
      return { priceCents: cents, currency: 'CNY', rawPrice: String(livePriceRaw).trim() };
    }
  }

  const jdDom = extractJdPriceFromDom($, html);
  if (jdDom) return jdDom;

  const jdBlob = extractJdPriceFromScriptBlob(html);
  if (jdBlob) return jdBlob;

  // 1) meta[itemprop=price]
  const metaPrice = $('meta[itemprop="price"]').attr('content');
  if (metaPrice) {
    const cents = priceStrToCents(metaPrice);
    if (cents !== null) return { priceCents: cents, currency: 'CNY', rawPrice: metaPrice };
  }

  // 2) JSON-LD offers.price
  const jsonCandidates = extractPriceCandidatesFromJsonLd($);
  if (jsonCandidates.length) {
    // heuristic: current price often appears as the smallest candidate (discounted price)
    const priceCents = Math.min(...jsonCandidates);
    return { priceCents, currency: 'CNY', rawPrice: String(priceCents / 100) };
  }

  // 3) text regex heuristic
  const textCandidates = extractPriceCandidatesFromText($, html);
  if (textCandidates.length) {
    const priceCents = Math.min(...textCandidates);
    return { priceCents, currency: 'CNY', rawPrice: String(priceCents / 100) };
  }

  return null;
}

function looksLikeCaptcha(html, { hasReliablePrice, sourceUrl, landingUrl } = {}) {
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
  const { finalUrl, html, livePriceRaw } = await fetchHtml(url, userDataDir, headful, headfulResume);
  const $ = cheerio.load(html);
  const productName = extractProductNameFromCheerio($) || '';
  let price = extractPriceFromCheerio($, html, livePriceRaw);
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

