const path = require('path');
const Database = require('better-sqlite3');
const { beijingNowIso } = require('./time');

const DB_PATH = (() => {
  const raw = String(process.env.PRICE_DB_PATH || '').trim();
  if (raw) return path.resolve(raw);
  return path.join(__dirname, '..', 'prices.db');
})();

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      site TEXT,
      product_name TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      raw_price TEXT,
      FOREIGN KEY(url_id) REFERENCES tracked_urls(id)
    );

    CREATE INDEX IF NOT EXISTS idx_price_points_url_ts ON price_points(url_id, ts);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url_id INTEGER NOT NULL,
      ts TEXT NOT NULL,
      drop_percent REAL NOT NULL,
      prev_cents INTEGER NOT NULL,
      cur_cents INTEGER NOT NULL,
      product_name TEXT,
      url TEXT,
      message TEXT NOT NULL,
      FOREIGN KEY(url_id) REFERENCES tracked_urls(id)
    );

    CREATE INDEX IF NOT EXISTS idx_price_alerts_ts ON price_alerts(ts);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  const cols = db.prepare('PRAGMA table_info(price_points)').all();
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('list_price_cents')) {
    db.exec('ALTER TABLE price_points ADD COLUMN list_price_cents INTEGER');
  }
  if (!colNames.has('list_raw_price')) {
    db.exec('ALTER TABLE price_points ADD COLUMN list_raw_price TEXT');
  }
  return db;
}

function priceCentsToStr(cents) {
  const v = cents / 100;
  return `¥${v.toFixed(2)}`;
}

function insertTrackedUrl({ url, site, productName }) {
  const db = openDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tracked_urls (url, site, product_name, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(url, site, productName || null, beijingNowIso());

  const row = db
    .prepare('SELECT id, url, site, product_name, created_at FROM tracked_urls WHERE url = ?')
    .get(url);
  db.close();
  return row;
}

function updateProductNameIfEmpty(urlId, productName) {
  if (!productName) return;
  const db = openDb();
  db.prepare(`
    UPDATE tracked_urls
    SET product_name = COALESCE(NULLIF(TRIM(product_name), ''), ?)
    WHERE id = ?
  `).run(productName, urlId);
  db.close();
}

function listTrackedUrls() {
  const db = openDb();
  const rows = db
    .prepare(`
      SELECT id, url, site, product_name, created_at
      FROM tracked_urls
      ORDER BY id DESC
      LIMIT 200
    `)
    .all();
  db.close();
  return rows;
}

function getLatestPoint(urlId) {
  const db = openDb();
  const row = db
    .prepare(
      `
      SELECT ts, price_cents, currency, raw_price, list_price_cents, list_raw_price
      FROM price_points
      WHERE url_id = ?
      ORDER BY ts DESC
      LIMIT 1
      `
    )
    .get(urlId);
  db.close();
  return row || null;
}

function getPrevPoint(urlId) {
  const db = openDb();
  const row = db
    .prepare(
      `
      SELECT ts, price_cents, currency, raw_price, list_price_cents, list_raw_price
      FROM price_points
      WHERE url_id = ?
      ORDER BY ts DESC
      LIMIT 1 OFFSET 1
      `
    )
    .get(urlId);
  db.close();
  return row || null;
}

/**
 * 有记录以来的全局最低价及**首次**采到该价的时间（多条同价取时间最早的一条）。
 */
function getHistoricalLowPoint(urlId) {
  const db = openDb();
  const row = db
    .prepare(
      `
      SELECT ts, price_cents
      FROM price_points
      WHERE url_id = ? AND price_cents > 0
        AND price_cents = (
          SELECT MIN(price_cents) FROM price_points WHERE url_id = ? AND price_cents > 0
        )
      ORDER BY ts ASC
      LIMIT 1
      `
    )
    .get(urlId, urlId);
  db.close();
  if (!row) return null;
  const ts = row.ts ?? row.TS;
  const cents = row.price_cents ?? row.PRICE_CENTS;
  if (cents == null || !Number.isFinite(Number(cents)) || Number(cents) <= 0) return null;
  if (ts == null || String(ts).trim() === '') return null;
  return { ts: String(ts), price_cents: Number(cents) };
}

/**
 * 严格早于「当前最新一条」时间戳的采样里，出现过的不含税最低价天花板（用于表格「降幅」分子基准）。
 * 只有 1 条价格记录时返回 null。
 */
function getMinPriceBeforeLatestTs(urlId) {
  const db = openDb();
  const latest = db
    .prepare(
      `
      SELECT ts
      FROM price_points
      WHERE url_id = ? AND price_cents > 0
      ORDER BY ts DESC
      LIMIT 1
      `
    )
    .get(urlId);
  if (!latest || latest.ts == null) {
    db.close();
    return null;
  }
  const row = db
    .prepare(
      `
      SELECT MIN(price_cents) AS m
      FROM price_points
      WHERE url_id = ? AND price_cents > 0 AND ts < ?
      `
    )
    .get(urlId, latest.ts);
  db.close();
  return row && row.m != null ? row.m : null;
}

function insertPricePoint({ urlId, ts, priceCents, currency, rawPrice, listPriceCents, listRawPrice }) {
  const db = openDb();
  const listC =
    listPriceCents != null && Number.isFinite(Number(listPriceCents)) && Number(listPriceCents) > 0
      ? Math.round(Number(listPriceCents))
      : null;
  const listR = listC != null && listRawPrice != null && String(listRawPrice).trim() ? String(listRawPrice).trim() : null;
  db.prepare(
    `
    INSERT INTO price_points (url_id, ts, price_cents, currency, raw_price, list_price_cents, list_raw_price)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(urlId, ts, priceCents, currency, rawPrice || null, listC, listR);
  db.close();
}

function insertPriceAlert({
  urlId,
  ts,
  dropPercent,
  prevCents,
  curCents,
  productName,
  url,
  message,
}) {
  const db = openDb();
  db.prepare(
    `
    INSERT INTO price_alerts (url_id, ts, drop_percent, prev_cents, cur_cents, product_name, url, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(urlId, ts, dropPercent, prevCents, curCents, productName || null, url || null, message);
  db.close();
}

function listPriceAlerts(limit = 50) {
  const db = openDb();
  const rows = db
    .prepare(
      `
      SELECT id, url_id, ts, drop_percent, prev_cents, cur_cents, product_name, url, message
      FROM price_alerts
      ORDER BY id DESC
      LIMIT ?
      `
    )
    .all(Math.max(1, Math.min(200, limit)));
  db.close();
  return rows;
}

function deleteTrackedUrl(urlId) {
  const id = Number(urlId);
  if (!Number.isInteger(id) || id < 1) return { ok: false };

  const db = openDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM price_points WHERE url_id = ?').run(id);
    db.prepare('DELETE FROM price_alerts WHERE url_id = ?').run(id);
    return db.prepare('DELETE FROM tracked_urls WHERE id = ?').run(id);
  });
  const info = run();
  db.close();
  return { ok: info.changes > 0 };
}

function getHistory(urlId, limit = 48) {
  const db = openDb();
  const rows = db
    .prepare(
      `
      SELECT ts, price_cents, list_price_cents, list_raw_price
      FROM price_points
      WHERE url_id = ?
      ORDER BY ts DESC
      LIMIT ?
      `
    )
    .all(urlId, limit);
  db.close();

  // reverse to ascending time for chart
  return rows.reverse().map((r) => ({
    ts: r.ts,
    priceCents: r.price_cents,
    priceStr: priceCentsToStr(r.price_cents),
    listPriceCents: r.list_price_cents != null ? r.list_price_cents : null,
    listPriceStr:
      r.list_price_cents != null && r.list_price_cents > 0 ? priceCentsToStr(r.list_price_cents) : null,
  }));
}

function getAppSetting(key) {
  const db = openDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : null;
}

function setAppSetting(key, value) {
  const db = openDb();
  db.prepare(
    `
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
  ).run(key, String(value));
  db.close();
}

/** @returns {number|null} 秒；未设置时 null */
function getMonitorIntervalSeconds() {
  const raw = getAppSetting('monitor_interval_seconds');
  if (raw == null || raw === '') return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return n;
}

function setMonitorIntervalSeconds(seconds) {
  const n = Math.floor(Number(seconds));
  if (!Number.isFinite(n) || n < 60 || n > 604800) {
    throw new Error('抓取间隔须在 60 秒～7 天（604800 秒）之间');
  }
  setAppSetting('monitor_interval_seconds', String(n));
}

/** @returns {number|null} */
function getMonitorDropPercent() {
  const raw = getAppSetting('monitor_drop_percent');
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function setMonitorDropPercent(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0.1 || n > 99) {
    throw new Error('降价告警阈值须在 0.1%～99% 之间');
  }
  setAppSetting('monitor_drop_percent', String(Number(n.toFixed(2))));
}

module.exports = {
  DB_PATH,
  beijingNowIso,
  priceCentsToStr,
  insertTrackedUrl,
  updateProductNameIfEmpty,
  listTrackedUrls,
  deleteTrackedUrl,
  getLatestPoint,
  getPrevPoint,
  getHistoricalLowPoint,
  getMinPriceBeforeLatestTs,
  insertPricePoint,
  insertPriceAlert,
  listPriceAlerts,
  getHistory,
  getMonitorIntervalSeconds,
  setMonitorIntervalSeconds,
  getMonitorDropPercent,
  setMonitorDropPercent,
};

