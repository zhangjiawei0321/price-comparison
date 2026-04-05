const crypto = require('crypto');
const {
  listTrackedUrls,
  insertTrackedUrl,
  updateProductNameIfEmpty,
  getLatestPoint,
  insertPricePoint,
  insertPriceAlert,
  getMonitorIntervalSeconds,
  getMonitorDropPercent,
} = require('./db');
const { parseProduct, getSiteFromUrl } = require('./scraper');
const { beijingNowIso } = require('./time');

const env = process.env;

/** DB 优先，否则 CLI 传入值；单位秒，约束在 60～604800 */
function resolveMonitorIntervalSeconds(cliDefault) {
  const fromDb = getMonitorIntervalSeconds();
  if (fromDb != null && fromDb >= 60 && fromDb <= 604800) return fromDb;
  const d = Math.floor(Number(cliDefault));
  if (Number.isFinite(d) && d > 0) return Math.min(604800, Math.max(60, d));
  return 3600;
}

function resolveMonitorDropPercent(cliDefault) {
  const fromDb = getMonitorDropPercent();
  if (fromDb != null && fromDb >= 0.1 && fromDb <= 99) return fromDb;
  const d = Number(cliDefault);
  if (Number.isFinite(d) && d > 0 && d <= 99) return d;
  return 5;
}

/**
 * 钉钉自定义机器人「加签」：签名为 Base64(HMAC-SHA256(secret, timestamp + "\n" + secret))，
 * 与官方示例一致。见 https://open.dingtalk.com/document/orgapp/custom-robot-access
 */
function appendDingTalkSign(webhookUrl, secret) {
  const key = String(secret || '').trim();
  if (!key) return webhookUrl;
  const u = new URL(webhookUrl);
  u.searchParams.delete('timestamp');
  u.searchParams.delete('sign');
  const ts = Date.now();
  const stringToSign = `${ts}\n${key}`;
  const sign = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  u.searchParams.set('timestamp', String(ts));
  u.searchParams.set('sign', sign);
  return u.toString();
}

function priceCentsToStr(cents) {
  return `¥${(cents / 100).toFixed(2)}`;
}

function buildAlertText({ productName, site, prevCents, curCents, dropPct, url }) {
  const title = '价格告警';
  const name = productName ? productName : '(未知商品)';
  return [
    `【${title}】${name}`,
    `站点：${site}`,
    `上次：${priceCentsToStr(prevCents)}`,
    `当前：${priceCentsToStr(curCents)}`,
    `降幅：${dropPct.toFixed(2)}%`,
    `链接：${url}`,
  ].join('\n');
}

function buildWebhookBody(format, text) {
  const f = (format || 'wecom').toLowerCase();
  if (f === 'plain') return { body: text, contentType: 'text/plain; charset=utf-8' };
  let payload;
  if (f === 'dingtalk') {
    payload = { msgtype: 'text', text: { content: text } };
  } else if (f === 'feishu' || f === 'lark') {
    payload = { msg_type: 'text', content: { text } };
  } else {
    payload = { msgtype: 'text', text: { content: text } };
  }
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}

async function postWebhook(url, format, text) {
  const f = (format || 'wecom').toLowerCase();
  let requestUrl = url;
  if (f === 'dingtalk') {
    const sec = (env.DINGTALK_SECRET || '').trim();
    if (sec) requestUrl = appendDingTalkSign(url, sec);
  }
  const { body, contentType } = buildWebhookBody(format, text);
  const res = await fetch(requestUrl, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Webhook failed (${format}): ${res.status} ${t}`.slice(0, 400));
  }
  return true;
}

async function sendExternalAlerts(text) {
  const wecomUrl = (env.WECHAT_WEBHOOK_URL || '').trim();
  const genericUrl = (env.ALERT_WEBHOOK_URL || '').trim();
  const genericFmt = (env.ALERT_WEBHOOK_FORMAT || 'dingtalk').trim();

  const results = [];

  if (wecomUrl) {
    await postWebhook(wecomUrl, 'wecom', text);
    results.push('wecom');
  }

  if (genericUrl && genericUrl !== wecomUrl) {
    await postWebhook(genericUrl, genericFmt, text);
    results.push(`webhook:${genericFmt}`);
  }

  if ((env.ALERT_DESKTOP || '').trim() === '1' || (env.ALERT_DESKTOP || '').toLowerCase() === 'true') {
    try {
      const notifier = require('node-notifier');
      notifier.notify({
        title: '价格告警',
        message: text.length > 220 ? `${text.slice(0, 220)}…` : text,
        wait: false,
      });
      results.push('desktop');
    } catch (e) {
      console.warn('[alert] desktop notify skipped:', e && e.message ? e.message : e);
    }
  }

  return results;
}

const riskNotifyLastMs = new Map();

function riskNotifyCooldownKey(payload) {
  if (payload.urlId != null && payload.urlId !== '') return `id:${payload.urlId}`;
  return `u:${String(payload.url || '').trim()}`;
}

function buildRiskControlAlertText({ urlId, productName, url, site, from }) {
  const name = productName ? productName : '(未知商品)';
  const lines = [
    '【价格风控提醒】抓取判定为登录/验证码或拦截页，本次未写入新价格。',
    `商品：${name}`,
    `站点：${site || 'unknown'}`,
    `链接：${url}`,
  ];
  if (urlId != null && urlId !== '') lines.splice(1, 0, `监控ID：${urlId}`);
  if (from === 'add') lines.push('来源：添加商品');
  lines.push('建议：--headful 登录或过验证；确认用户数据目录未被其它 Chrome 占用。');
  return lines.join('\n');
}

/**
 * 风控/验证码时推送钉钉、飞书、企业微信、桌面通知（与降价共用 sendExternalAlerts）。
 * RISK_WEBHOOK_COOLDOWN_SECONDS：同一监控 ID 或同一 URL 的最小间隔秒数，默认 3600；设为 0 不限制。
 */
async function notifyRiskControlWebhook(payload) {
  const rawCd = env.RISK_WEBHOOK_COOLDOWN_SECONDS;
  let cooldownSec = 3600;
  if (rawCd !== undefined && rawCd !== '') {
    const n = Number(rawCd);
    cooldownSec = Number.isFinite(n) ? Math.max(0, n) : 3600;
  }
  const key = riskNotifyCooldownKey(payload);
  if (cooldownSec > 0) {
    const last = riskNotifyLastMs.get(key) || 0;
    if (Date.now() - last < cooldownSec * 1000) return;
    riskNotifyLastMs.set(key, Date.now());
  }
  const text = buildRiskControlAlertText(payload);
  try {
    const ch = await sendExternalAlerts(text);
    if (ch.length) console.log(`[risk] webhook urlId=${payload.urlId != null ? payload.urlId : 'new'} channels=${ch.join(',')}`);
  } catch (e) {
    console.error('[risk] notify failed', e && e.message ? e.message : e);
  }
}

/** 避免未登录等原因落地到电商首页却仍写入「假商品」 */
function assertAddLandingIsProductPage(originalUrl, finalUrl) {
  const orig = String(originalUrl || '').trim();
  const fin = String(finalUrl || orig).trim();
  let uo;
  let uf;
  try {
    uo = new URL(orig);
    uf = new URL(fin);
  } catch (_) {
    return;
  }
  const host = uf.hostname.toLowerCase();
  const path = (uf.pathname || '/').replace(/\/+$/, '') || '/';
  const isRoot = path === '/' || path === '/index.html';

  if (
    host === 'www.taobao.com' ||
    host === 'taobao.com' ||
    host === 'world.taobao.com' ||
    host.endsWith('.taobao.com')
  ) {
    if (isRoot) {
      const fromList = uo.pathname.includes('/list/item/');
      throw new Error(
        fromList
          ? '「淘宝 list 商品」链接打开后落到首页，未进入商品详情（通常未登录）。请用 --headful 登录后再添加，并适当加大自动等待秒数；可先删除网页里错误的监控条目。'
          : '打开链接后落在淘宝首页，未停留在商品页（常见原因：未登录）。请使用 --headful 登录淘宝后再添加。'
      );
    }
  }

  if (host === 'www.tmall.com' || host === 'tmall.com' || host.endsWith('.tmall.com')) {
    if (isRoot) {
      throw new Error(
        '打开链接后落在天猫首页，未停留在商品页。请使用 --headful 登录后再试。'
      );
    }
  }

  if (host.includes('jd.com') && (host === 'www.jd.com' || host === 'jd.com' || host.endsWith('.jd.com'))) {
    if (isRoot && !String(uf.search || '').includes('sku')) {
      throw new Error(
        '打开链接后落在京东首页，未停留在商品页。请使用 --headful 或检查登录态后再试。'
      );
    }
  }

  const loginish =
    /\/login|passport|\/signin/i.test(uf.pathname + uf.search) ||
    /(^|\.)login\.taobao\.|(^|\.)passport\.taobao\.|(^|\.)login\.tmall\.|(^|\.)passport\.tmall\./i.test(
      host
    );
  if (loginish) {
    throw new Error('当前停在登录/通行证页面。请先使用 --headful 完成登录后再添加商品。');
  }
}

async function addUrl(url, { userDataDir, headful, headfulResume } = {}) {
  const site = getSiteFromUrl(url);
  const parsed = await parseProduct(url, { userDataDir, headful, headfulResume });

  if (parsed.htmlWasCaptcha) {
    const landing = parsed.finalUrl || url;
    await notifyRiskControlWebhook({
      urlId: null,
      url: landing,
      productName: parsed.productName || '',
      site: site || getSiteFromUrl(landing),
      from: 'add',
    });
    throw new Error(
      'Still looks like login/captcha/block page. Try --headful, press Enter after the page is OK, or close Chrome using this profile and retry.'
    );
  }
  assertAddLandingIsProductPage(url, parsed.finalUrl);
  if (!parsed.productName) {
    console.warn('[addUrl] productName empty, continue');
  }
  const row = insertTrackedUrl({
    url: parsed.finalUrl,
    site: site || getSiteFromUrl(parsed.finalUrl),
    productName: parsed.productName,
  });
  if (parsed.productName) updateProductNameIfEmpty(row.id, parsed.productName);

  if (parsed.price && parsed.price.priceCents > 0) {
    insertPricePoint({
      urlId: row.id,
      ts: beijingNowIso(),
      priceCents: parsed.price.priceCents,
      currency: parsed.price.currency || 'CNY',
      rawPrice: parsed.price.rawPrice,
      listPriceCents: parsed.price.listPriceCents,
      listRawPrice: parsed.price.listRawPrice,
    });
  }

  const pstr =
    parsed.price && parsed.price.priceCents > 0 ? priceCentsToStr(parsed.price.priceCents) : 'none';
  const listStr =
    parsed.price && parsed.price.listPriceCents > 0 ? ` 标价${priceCentsToStr(parsed.price.listPriceCents)}` : '';
  console.log(
    `[add] urlId=${row.id} site=${row.site} price=${pstr}${listStr} productName=${row.product_name || parsed.productName || '(empty)'}`
  );
  return row;
}

async function listUrls() {
  const rows = listTrackedUrls();
  if (!rows.length) {
    console.log('No urls yet. Use: node index.js add <url>');
    return;
  }
  for (const r of rows) {
    console.log(`[${r.id}] ${r.site} | ${r.product_name || '(empty)'}`);
    console.log(`     ${r.url}`);
  }
}

async function monitorOnce({ userDataDir, dropPercent, headful }) {
  const tracked = listTrackedUrls();
  for (const t of tracked) {
    const urlId = t.id;
    const prev = getLatestPoint(urlId);
    let parsed;
    try {
      parsed = await parseProduct(t.url, { userDataDir, headful });
    } catch (e) {
      console.error(`[monitor] parse failed urlId=${urlId}`, e && e.stack ? e.stack : e);
      continue;
    }

    if (parsed.htmlWasCaptcha) {
      console.warn(`[warn] maybe blocked/captcha urlId=${urlId}`);
      await notifyRiskControlWebhook({
        urlId,
        url: parsed.finalUrl || t.url,
        productName: parsed.productName || t.product_name,
        site: t.site,
        from: 'monitor',
      });
      continue;
    }
    if (!parsed.price) {
      console.warn(`[warn] price not found urlId=${urlId}`);
      continue;
    }

    const ts = beijingNowIso();
    insertPricePoint({
      urlId,
      ts,
      priceCents: parsed.price.priceCents,
      currency: parsed.price.currency || 'CNY',
      rawPrice: parsed.price.rawPrice,
      listPriceCents: parsed.price.listPriceCents,
      listRawPrice: parsed.price.listRawPrice,
    });

    const prevCents = prev ? prev.price_cents : null;
    if (prevCents && prevCents > 0) {
      const curCents = parsed.price.priceCents;
      const drop = ((prevCents - curCents) / prevCents) * 100;
      if (drop >= dropPercent) {
        const finalUrl = parsed.finalUrl || t.url;
        const pname = parsed.productName || t.product_name;
        const message = buildAlertText({
          productName: pname,
          site: t.site || 'unknown',
          prevCents,
          curCents,
          dropPct: drop,
          url: finalUrl,
        });

        insertPriceAlert({
          urlId,
          ts,
          dropPercent: drop,
          prevCents,
          curCents,
          productName: pname,
          url: finalUrl,
          message,
        });

        try {
          const channels = await sendExternalAlerts(message);
          console.log(
            `[alert] urlId=${urlId} drop=${drop.toFixed(2)}% ${priceCentsToStr(prevCents)} -> ${priceCentsToStr(
              curCents
            )} channels=${channels.length ? channels.join(',') : 'none'}`
          );
        } catch (e) {
          console.error(`[alert] send failed urlId=${urlId}`, e && e.stack ? e.stack : e);
        }
      }
    }
  }
}

function summarizeAlertChannels() {
  const parts = [];
  if ((env.WECHAT_WEBHOOK_URL || '').trim()) parts.push('WeCom');
  if ((env.ALERT_WEBHOOK_URL || '').trim())
    parts.push(`Webhook(${env.ALERT_WEBHOOK_FORMAT || 'dingtalk'})`);
  if (['1', 'true'].includes((env.ALERT_DESKTOP || '').toLowerCase())) parts.push('Desktop');
  parts.push('Web UI alerts (local DB)');
  return parts.join(' + ');
}

async function startMonitoring({ userDataDir, intervalSeconds, dropPercent, headful }) {
  console.log(`Starting monitor: intervalSeconds=${intervalSeconds} dropPercent=${dropPercent}%`);
  console.log(`Alerts: ${summarizeAlertChannels()}`);

  while (true) {
    const dropPct = resolveMonitorDropPercent(dropPercent);
    const sleepSec = resolveMonitorIntervalSeconds(intervalSeconds);
    console.log(
      `\n[run] tick at ${beijingNowIso()} urls=${listTrackedUrls().length} sleepNext=${sleepSec}s dropPct=${dropPct}`
    );
    try {
      await monitorOnce({ userDataDir, dropPercent: dropPct, headful });
    } catch (e) {
      console.error('[run] monitorOnce failed', e && e.stack ? e.stack : e);
    }
    await new Promise((r) => setTimeout(r, sleepSec * 1000));
  }
}

/**
 * 与 startMonitoring 相同的抓取节奏，但不阻塞调用方（供与 Web 同进程运行）。
 * 在每次间隔 sleeping 时让出事件循环，Express 可正常处理请求。
 */
function startBackgroundMonitoring({ userDataDir, intervalSeconds, dropPercent, headful }) {
  console.log(`Background monitor: intervalSeconds=${intervalSeconds} dropPercent=${dropPercent}%`);
  console.log(`Alerts: ${summarizeAlertChannels()}`);

  (async () => {
    while (true) {
      const dropPct = resolveMonitorDropPercent(dropPercent);
      const sleepSec = resolveMonitorIntervalSeconds(intervalSeconds);
      console.log(
        `\n[run] tick at ${beijingNowIso()} urls=${listTrackedUrls().length} sleepNext=${sleepSec}s dropPct=${dropPct}`
      );
      try {
        await monitorOnce({ userDataDir, dropPercent: dropPct, headful });
      } catch (e) {
        console.error('[run] monitorOnce failed', e && e.stack ? e.stack : e);
      }
      await new Promise((r) => setTimeout(r, sleepSec * 1000));
    }
  })().catch((e) => console.error('[run] background monitor fatal', e && e.stack ? e.stack : e));
}

module.exports = {
  addUrl,
  listUrls,
  startMonitoring,
  startBackgroundMonitoring,
};

