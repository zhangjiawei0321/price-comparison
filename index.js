require('dotenv').config({ quiet: true });

const { hideBin } = require('yargs/helpers');
const yargs = require('yargs/yargs');

const { addUrl, listUrls, startMonitoring } = require('./src/monitor');
const { startWebServer } = require('./src/server');
const { deleteTrackedUrl } = require('./src/db');

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

yargs(hideBin(process.argv))
  .scriptName('price_monitor')
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

