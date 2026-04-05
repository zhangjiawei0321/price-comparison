const express = require('express');
const path = require('path');

const { addUrl, startBackgroundMonitoring } = require('./monitor');
const {
  listTrackedUrls,
  deleteTrackedUrl,
  getLatestPoint,
  getPrevPoint,
  getHistoricalLowPoint,
  getMinPriceBeforeLatestTs,
  getHistory,
  listPriceAlerts,
  priceCentsToStr,
  getMonitorIntervalSeconds,
  setMonitorIntervalSeconds,
  getMonitorDropPercent,
  setMonitorDropPercent,
} = require('./db');

/** 有界面添加 + 「网页手动确认」时，由 POST /api/add/continue 调用以继续抓取 */
let webAddPendingResolve = null;

function startWebServer({ port, userDataDir, headful, backgroundMonitor = null }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const bg =
    backgroundMonitor &&
    typeof backgroundMonitor.intervalSeconds === 'number' &&
    backgroundMonitor.intervalSeconds > 0
      ? backgroundMonitor
      : null;

  const monitorDefaults = {
    intervalSeconds: bg && bg.intervalSeconds > 0 ? bg.intervalSeconds : 3600,
    dropPercent: bg && bg.dropPercent > 0 ? bg.dropPercent : 5,
  };
  const backgroundMonitorActive = bg != null;

  function effectiveMonitorSettings() {
    const intDb = getMonitorIntervalSeconds();
    const dropDb = getMonitorDropPercent();
    const intervalRaw = intDb != null ? intDb : monitorDefaults.intervalSeconds;
    const dropRaw = dropDb != null ? dropDb : monitorDefaults.dropPercent;
    return {
      intervalSeconds: Math.min(604800, Math.max(60, Math.floor(Number(intervalRaw)) || 3600)),
      dropPercent: Math.min(99, Math.max(0.1, Number(dropRaw) || 5)),
    };
  }

  app.get('/api/config', (_req, res) => {
    const eff = effectiveMonitorSettings();
    res.json({
      headful: !!headful,
      userDataDir: !!userDataDir,
      backgroundMonitor: backgroundMonitorActive,
      intervalSeconds: eff.intervalSeconds,
      dropPercent: eff.dropPercent,
    });
  });

  app.get('/api/monitor-settings', (_req, res) => {
    const eff = effectiveMonitorSettings();
    res.json({
      backgroundMonitorActive,
      intervalSeconds: eff.intervalSeconds,
      dropPercent: eff.dropPercent,
      intervalSecondsFromDb: getMonitorIntervalSeconds() != null,
      dropPercentFromDb: getMonitorDropPercent() != null,
    });
  });

  app.post('/api/monitor-settings', (req, res) => {
    const body = req.body || {};
    const hasInt =
      body.intervalSeconds !== undefined && body.intervalSeconds !== null && body.intervalSeconds !== '';
    const hasDrop =
      body.dropPercent !== undefined && body.dropPercent !== null && body.dropPercent !== '';
    if (!hasInt && !hasDrop) {
      return res.status(400).json({ ok: false, error: '请至少提交 intervalSeconds 或 dropPercent' });
    }
    try {
      if (hasInt) {
        setMonitorIntervalSeconds(body.intervalSeconds);
      }
      if (hasDrop) {
        setMonitorDropPercent(body.dropPercent);
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return res.status(400).json({ ok: false, error: msg });
    }
    const eff = effectiveMonitorSettings();
    res.json({
      ok: true,
      backgroundMonitorActive,
      intervalSeconds: eff.intervalSeconds,
      dropPercent: eff.dropPercent,
    });
  });

  app.get('/api/tracked', async (_req, res) => {
    const tracked = listTrackedUrls();
    const out = [];

    for (const t of tracked) {
      const latest = getLatestPoint(t.id);
      const prev = getPrevPoint(t.id);
      const histLowRow = getHistoricalLowPoint(t.id);
      const histLowCents = histLowRow ? histLowRow.price_cents : null;
      const histLowTs = histLowRow && histLowRow.ts != null ? histLowRow.ts : null;
      const floorBeforeLatest = latest ? getMinPriceBeforeLatestTs(t.id) : null;
      let dropVsPrevLow = null;
      if (latest && floorBeforeLatest != null && floorBeforeLatest > 0) {
        dropVsPrevLow = Number(
          (((floorBeforeLatest - latest.price_cents) / floorBeforeLatest) * 100).toFixed(2)
        );
      }
      if (latest) {
        const listC = latest.list_price_cents != null ? latest.list_price_cents : null;
        out.push({
          urlId: t.id,
          url: t.url,
          site: t.site,
          productName: t.product_name,
          latestTs: latest.ts,
          latestPriceCents: latest.price_cents,
          latestPriceStr: priceCentsToStr(latest.price_cents),
          latestListPriceCents: listC != null && listC > 0 ? listC : null,
          latestListPriceStr: listC != null && listC > 0 ? priceCentsToStr(listC) : null,
          prevPriceCents: prev ? prev.price_cents : null,
          prevPriceStr: prev ? priceCentsToStr(prev.price_cents) : null,
          histLowCents: histLowCents != null ? histLowCents : null,
          histLowTs: histLowTs != null ? String(histLowTs) : null,
          histLowStr: histLowCents != null ? priceCentsToStr(histLowCents) : null,
          dropPercent: dropVsPrevLow,
        });
      } else {
        out.push({
          urlId: t.id,
          url: t.url,
          site: t.site,
          productName: t.product_name,
          latestTs: null,
          latestPriceCents: null,
          latestPriceStr: null,
          latestListPriceCents: null,
          latestListPriceStr: null,
          prevPriceCents: prev ? prev.price_cents : null,
          prevPriceStr: prev ? priceCentsToStr(prev.price_cents) : null,
          histLowCents: histLowCents != null ? histLowCents : null,
          histLowTs: histLowTs != null ? String(histLowTs) : null,
          histLowStr: histLowCents != null ? priceCentsToStr(histLowCents) : null,
          dropPercent: null,
        });
      }
    }

    res.json(out);
  });

  app.delete('/api/tracked/:urlId', (req, res) => {
    const urlId = Number(req.params.urlId);
    const { ok } = deleteTrackedUrl(urlId);
    if (!ok) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true });
  });

  app.get('/api/alerts', (_req, res) => {
    const limit = Math.max(1, Math.min(100, Number(_req.query.limit || 30)));
    const rows = listPriceAlerts(limit);
    res.json({
      alerts: rows.map((r) => ({
        id: r.id,
        urlId: r.url_id,
        ts: r.ts,
        dropPercent: r.drop_percent,
        prevCents: r.prev_cents,
        curCents: r.cur_cents,
        productName: r.product_name,
        url: r.url,
        message: r.message,
        prevPriceStr: priceCentsToStr(r.prev_cents),
        curPriceStr: priceCentsToStr(r.cur_cents),
      })),
    });
  });

  app.get('/api/history/:urlId', async (req, res) => {
    const urlId = Number(req.params.urlId);
    const limit = Math.max(5, Math.min(200, Number(req.query.limit || 48)));
    const points = getHistory(urlId, limit);
    res.json({ urlId, points });
  });

  app.post('/api/add/continue', (_req, res) => {
    if (!webAddPendingResolve) {
      return res.status(400).json({ ok: false, error: '当前没有等待确认的有界面添加' });
    }
    const r = webAddPendingResolve;
    webAddPendingResolve = null;
    r();
    res.json({ ok: true });
  });

  app.post('/api/add', async (req, res) => {
    const url = String(req.body && req.body.url ? req.body.url : '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });

    let headfulResume = null;
    if (headful) {
      const mode = String(req.body.headfulResumeMode || 'auto').toLowerCase();
      if (mode === 'manual') {
        if (webAddPendingResolve) {
          return res.status(409).json({ ok: false, error: '已有添加任务进行中，请稍后' });
        }
        headfulResume = {
          kind: 'webPromise',
          promise: new Promise((resolve) => {
            webAddPendingResolve = resolve;
          }),
        };
      } else if (mode === 'auto') {
        const sec = Number(req.body.headfulResumeSeconds ?? 30);
        const clamped = Math.min(600, Math.max(5, Number.isFinite(sec) ? sec : 30));
        headfulResume = { kind: 'timeout', ms: clamped * 1000 };
      }
      // mode === 'terminal' 或其它：headfulResume 保持 null，走终端 Enter / HEADFUL_AUTO_WAIT_MS
    }

    try {
      const row = await addUrl(url, { userDataDir, headful, headfulResume });
      res.json({ ok: true, urlId: row.id, productName: row.product_name });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      console.error('[api/add]', msg);
      res.status(422).json({ ok: false, error: msg });
    } finally {
      if (webAddPendingResolve) {
        const r = webAddPendingResolve;
        webAddPendingResolve = null;
        r();
      }
    }
  });

  app.listen(port, () => {
    console.log(`Web UI: http://localhost:${port}`);
    console.log(`POST /api/add: userDataDir=${userDataDir ? 'on' : 'off'} headful=${headful ? 'on' : 'off'}`);
    if (bg) {
      startBackgroundMonitoring({
        userDataDir: bg.userDataDir != null ? bg.userDataDir : userDataDir,
        intervalSeconds: bg.intervalSeconds,
        dropPercent: bg.dropPercent,
        headful: !!bg.headful,
      });
      console.log('Background monitor: running in this process (same as node index.js run).');
    }
  });
}

module.exports = { startWebServer };

