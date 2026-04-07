'use strict';

/**
 * 在同一控制台会话中尝试切换到 UTF-8（65001），便于正确显示 UTF-8 日志（子进程是否生效因宿主终端而异）。
 * 不需要时设 PRICE_CONSOLE_CHCP=0。
 */
function trySetConsoleCodePage65001() {
  if (process.platform !== 'win32') return;
  if (String(process.env.PRICE_CONSOLE_CHCP ?? '').trim() === '0') return;
  if (!process.stdout.isTTY) return;
  try {
    const { execFileSync } = require('child_process');
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {}
}

/**
 * Windows 控制台编码与 Node 默认 UTF-8 不一致时会乱码。
 *
 * - 默认：不转码（UTF-8），适合 Cursor / Windows Terminal / 已 chcp 65001 的环境。
 * - 经典 CMD（代码页 936）仍乱码时：在 .env 设 PRICE_CONSOLE_GBK=1，强制按 GBK 输出。
 * - PRICE_CONSOLE_GBK=auto：启动时执行 chcp，仅当活动代码页为 936/54936 时转 GBK（仍可能误判，可改用手动 1/0）。
 */

function getActiveCodePage() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = String(out).match(/(\d{3,5})/g);
    if (!m || !m.length) return null;
    return parseInt(m[m.length - 1], 10);
  } catch {
    return null;
  }
}

function shouldEncodeToGbk() {
  if (process.platform !== 'win32') return false;
  const raw = String(process.env.PRICE_CONSOLE_GBK ?? '').trim().toLowerCase();

  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'utf8') return false;
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes' || raw === 'gbk') return true;

  if (raw === 'auto') {
    const cp = getActiveCodePage();
    if (cp === 65001) return false;
    if (cp === 936 || cp === 54936) return true;
    return false;
  }

  // 未设置：默认 UTF-8，不转 GBK（避免在已是 UTF-8 的终端里「二次编码」导致乱码）
  if (raw === '') return false;

  return false;
}

function tryEnableWinConsoleGbk() {
  if (!shouldEncodeToGbk()) return;

  let iconv;
  try {
    iconv = require('iconv-lite');
  } catch (_) {
    return;
  }

  function wrapStream(stream) {
    if (!stream || typeof stream.write !== 'function') return;
    if (!stream.isTTY) return;
    const origWrite = stream.write.bind(stream);
    stream.write = function (chunk, encoding, cb) {
      let enc = encoding;
      let callback = cb;
      if (typeof encoding === 'function') {
        callback = encoding;
        enc = undefined;
      }
      if (typeof chunk === 'string') {
        const asUtf8 = enc === undefined || enc === null || enc === 'utf8';
        if (asUtf8) {
          try {
            const buf = iconv.encode(chunk, 'gbk');
            return origWrite(buf, callback);
          } catch (_) {
            return origWrite(chunk, enc, callback);
          }
        }
      }
      return origWrite(chunk, enc, callback);
    };
  }

  wrapStream(process.stdout);
  wrapStream(process.stderr);
}

module.exports = {
  trySetConsoleCodePage65001,
  tryEnableWinConsoleGbk,
  getActiveCodePage,
  shouldEncodeToGbk,
};
