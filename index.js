require('dotenv').config({ quiet: true });
const winConsole = require('./src/win-console-gbk');
winConsole.trySetConsoleCodePage65001();
winConsole.tryEnableWinConsoleGbk();

const { hideBin } = require('yargs/helpers');
const yargs = require('yargs/yargs');

const { addUrl, listUrls, startMonitoring } = require('./src/monitor');
const { startWebServer } = require('./src/server');
const { deleteTrackedUrl, listTrackedUrls } = require('./src/db');
const { parseProductOnce } = require('./src/scraper');

/** CLI `--userDataDir` 优先；否则读环境变量 PRICE_USER_DATA_DIR 或 USER_DATA_DIR（见 .env）。 */
function resolveUserDataDir(cliValue) {
  const fromCli = cliValue != null && String(cliValue).trim();
  if (fromCli) return String(cliValue).trim();
  const fromEnv = (process.env.PRICE_USER_DATA_DIR || process.env.USER_DATA_DIR || '').trim();
  return fromEnv || null;
}

function withAsync(fn) {
  return (...args) => {
    try {
      const maybePromise = fn(...args);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        return maybePromise.catch((e) => {
          console.error(e && e.stack ? e.stack : e);
          process.exit(1);
        });
      }
      return maybePromise;
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    }
  };
}

function resolveInitUrl(site, url) {
  const direct = url != null && String(url).trim();
  if (direct) return String(url).trim();
  const s = String(site || 'jd').trim().toLowerCase();
  if (s === 'tb' || s === 'taobao' || s === 'tmall') return 'https://www.taobao.com';
  if (s === 'pdd' || s === 'pinduoduo') return 'https://mobile.yangkeduo.com';
  return 'https://www.jd.com';
}

yargs(hideBin(process.argv))
  .scriptName('price_monitor')
  .command(
    'login:init',
    'Open headful browser once to initialize/refresh login profile',
    (y) => {
      y.option('site', {
        type: 'string',
        default: 'jd',
        describe: 'Target site for login bootstrap: jd | taobao | pdd',
      });
      y.option('url', {
        type: 'string',
        describe: 'Optional URL to open directly (overrides --site)',
      });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('waitSeconds', {
        type: 'number',
        default: 180,
        describe: 'Auto wait seconds in headful mode before scraping check',
      });
    },
    withAsync(async (argv) => {
      const userDataDir = resolveUserDataDir(argv.userDataDir);
      if (!userDataDir) {
        throw new Error('Missing userDataDir. Please pass --userDataDir or set PRICE_USER_DATA_DIR in .env');
      }
      const waitSeconds = Math.min(1800, Math.max(10, Math.floor(Number(argv.waitSeconds) || 180)));
      const targetUrl = resolveInitUrl(argv.site, argv.url);
      const r = await parseProductOnce(targetUrl, {
        userDataDir,
        headful: true,
        headfulResume: { kind: 'timeout', ms: waitSeconds * 1000 },
      });
      console.log('[login:init] result:', {
        targetUrl,
        finalUrl: r.finalUrl,
        htmlWasCaptcha: r.htmlWasCaptcha,
        hasPrice: !!(r.price && r.price.priceCents > 0),
        productName: r.productName || '',
      });
      if (r.htmlWasCaptcha) {
        console.warn(
          '[login:init] still looks blocked/login-required. Re-run with longer --waitSeconds or open a product page and finish login/verify in the browser.'
        );
      } else {
        console.log('[login:init] profile looks usable.');
      }
      process.exit(0);
    })
  )
  .command(
    'login:check',
    'Quickly check login/risk status for tracked URLs',
    (y) => {
      y.option('id', {
        type: 'string',
        describe: 'Check only specific tracked id(s), e.g. --id 3 or --id 3,8,15',
      });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('limit', {
        type: 'number',
        default: 5,
        describe: 'Check first N tracked URLs (default 5)',
      });
      y.option('headful', {
        type: 'boolean',
        default: false,
        describe: 'Open Chrome while checking',
      });
    },
    withAsync(async (argv) => {
      const userDataDir = resolveUserDataDir(argv.userDataDir);
      const rows = listTrackedUrls();
      if (!rows.length) {
        console.log('[login:check] no tracked urls.');
        process.exit(0);
      }
      let picked = [];
      const idArg = String(argv.id || '').trim();
      if (idArg) {
        const idSet = new Set(
          idArg
            .split(',')
            .map((x) => Number(String(x).trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
        );
        if (!idSet.size) {
          throw new Error('Invalid --id, expected positive integer(s), e.g. --id 3 or --id 3,8');
        }
        picked = rows.filter((r) => idSet.has(Number(r.id)));
        if (!picked.length) {
          console.log(`[login:check] no tracked rows matched --id ${idArg}`);
          process.exit(1);
        }
      } else {
        const limit = Math.min(50, Math.max(1, Math.floor(Number(argv.limit) || 5)));
        picked = rows.slice(0, limit);
      }
      let blocked = 0;
      for (const t of picked) {
        const r = await parseProductOnce(t.url, {
          userDataDir,
          headful: argv.headful,
        });
        const ok = !r.htmlWasCaptcha;
        if (!ok) blocked += 1;
        console.log(
          `[login:check] id=${t.id} site=${t.site} ok=${ok ? 'yes' : 'no'} finalUrl=${r.finalUrl || t.url}`
        );
      }
      console.log(`[login:check] checked=${picked.length} blocked=${blocked}`);
      process.exit(blocked > 0 ? 2 : 0);
    })
  )
  .command(
    'add <url>',
    'Add a product url to monitor',
    (y) => {
      y.positional('url', { type: 'string', describe: 'Product url (JD/Taobao/PDD)' });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('headful', { type: 'boolean', default: false, describe: 'Show Chrome window (system channel), easier for JD verify' });
    },
    withAsync(async (argv) => {
      await addUrl(argv.url, { userDataDir: resolveUserDataDir(argv.userDataDir), headful: argv.headful });
      process.exit(0);
    })
  )
  .command(
    'list',
    'List tracked urls',
    () => {},
    withAsync(async () => {
      await listUrls();
      process.exit(0);
    })
  )
  .command(
    'remove <id>',
    'Remove a tracked url by id (also deletes price history and alerts)',
    (y) => {
      y.positional('id', { type: 'number', describe: 'tracked_urls.id' });
    },
    withAsync(async (argv) => {
      const { ok } = deleteTrackedUrl(argv.id);
      if (!ok) {
        console.error(`No tracked url with id=${argv.id}`);
        process.exit(1);
      }
      console.log(`[remove] ok id=${argv.id}`);
      process.exit(0);
    })
  )
  .command(
    'debug-jd <url>',
    'Print JD price extraction diagnostics (enables JD_PRICE_DEBUG + SCRAPER_DEBUG)',
    (y) => {
      y.positional('url', { type: 'string', describe: 'JD item URL' });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('headful', {
        type: 'boolean',
        default: false,
        describe: 'Show Chrome (recommended if page needs login/verify)',
      });
    },
    withAsync(async (argv) => {
      process.env.JD_PRICE_DEBUG = '1';
      process.env.SCRAPER_DEBUG = '1';
      const r = await parseProductOnce(argv.url, {
        userDataDir: resolveUserDataDir(argv.userDataDir),
        headful: argv.headful,
      });
      console.log('[debug-jd] parseProductOnce result:', {
        finalUrl: r.finalUrl,
        productName: r.productName,
        price: r.price,
        htmlWasCaptcha: r.htmlWasCaptcha,
      });
      process.exit(0);
    })
  )
  .command(
    'debug-tb <url>',
    'Print Taobao/Tmall price extraction diagnostics (enables SCRAPER_DEBUG)',
    (y) => {
      y.positional('url', { type: 'string', describe: 'Taobao or Tmall item URL' });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('headful', {
        type: 'boolean',
        default: false,
        describe: 'Show Chrome (recommended for login/slider verify)',
      });
    },
    withAsync(async (argv) => {
      process.env.SCRAPER_DEBUG = '1';
      const r = await parseProductOnce(argv.url, {
        userDataDir: resolveUserDataDir(argv.userDataDir),
        headful: argv.headful,
      });
      console.log('[debug-tb] parseProductOnce result:', {
        finalUrl: r.finalUrl,
        productName: r.productName,
        price: r.price,
        htmlWasCaptcha: r.htmlWasCaptcha,
      });
      process.exit(0);
    })
  )
  .command(
    'run',
    'Start monitor loop (hourly)',
    (y) => {
      y.option('userDataDir', {
        type: 'string',
        describe: 'Reuse browser profile dir (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('intervalSeconds', { type: 'number', default: 3600, describe: 'Fetch interval in seconds' });
      y.option('dropPercent', { type: 'number', default: 5, describe: 'Alert when drop >= this percent' });
      y.option('headful', { type: 'boolean', default: false, describe: 'Show Chrome window on each fetch' });
    },
    withAsync(async (argv) => {
      await startMonitoring({
        userDataDir: resolveUserDataDir(argv.userDataDir),
        intervalSeconds: argv.intervalSeconds,
        dropPercent: argv.dropPercent,
        headful: argv.headful,
      });
    })
  )
  .command(
    'web',
    'Start local web UI',
    (y) => {
      y.option('port', { type: 'number', default: 8000, describe: 'Local server port' });
      y.option('userDataDir', {
        type: 'string',
        describe: 'Browser profile for /api/add (default: PRICE_USER_DATA_DIR in .env)',
      });
      y.option('headful', { type: 'boolean', default: false, describe: 'Show Chrome when adding via web UI' });
      y.option('monitor', {
        type: 'boolean',
        default: false,
        describe: 'Also run scheduled fetch in this process (no second terminal)',
      });
      y.option('intervalSeconds', {
        type: 'number',
        default: 3600,
        describe: 'With --monitor: seconds between ticks',
      });
      y.option('dropPercent', {
        type: 'number',
        default: 5,
        describe: 'With --monitor: alert threshold vs previous record',
      });
      y.option('monitorHeadful', {
        type: 'boolean',
        default: false,
        describe: 'With --monitor: open Chrome on each tick (usually keep false)',
      });
    },
    withAsync(async (argv) => {
      const userDataDir = resolveUserDataDir(argv.userDataDir);
      await startWebServer({
        port: argv.port,
        userDataDir,
        headful: argv.headful,
        backgroundMonitor: argv.monitor
          ? {
              userDataDir,
              intervalSeconds: argv.intervalSeconds,
              dropPercent: argv.dropPercent,
              headful: argv.monitorHeadful,
            }
          : null,
      });
    })
  )
  .demandCommand(1)
  .help()
  .parse();

