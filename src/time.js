const BEIJING_TZ = 'Asia/Shanghai';

function pad3(n) {
  return String(n).padStart(3, '0');
}

/**
 * Format an instant as Beijing (UTC+8) wall time: YYYY-MM-DDTHH:mm:ss.sss+08:00
 */
function formatBeijingIso(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = get('year');
  const mo = get('month');
  const da = get('day');
  const h = get('hour');
  const mi = get('minute');
  const se = get('second');
  const ms = pad3(d.getMilliseconds());
  return `${y}-${mo}-${da}T${h}:${mi}:${se}.${ms}+08:00`;
}

function beijingNowIso() {
  return formatBeijingIso(new Date());
}

module.exports = {
  BEIJING_TZ,
  formatBeijingIso,
  beijingNowIso,
};
