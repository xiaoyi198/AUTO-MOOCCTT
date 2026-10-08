#!/usr/bin/env node
/**
 * cdp-health.js —— 受管浏览器「只读体检」（**示例脚本，按需改写**）
 *
 * 【它是什么】
 *   连上受管浏览器，分别测「浏览器级」与「页面级」两类 CDP 命令，并打印每项的耗时。
 *   只读：不导航、不点击、不截图，收尾用 disconnect()（绝不用 close()，那会关掉用户的窗口）。
 *
 * 【为什么需要它（踩过的坑）】
 *   CDP 端口在线 **不等于** 浏览器能用。实测有两种「假在线」：
 *     1) 半死实例：实例被强杀后残留的进程仍霸占 profile，/json/version 有响应、握手也能成功，
 *        但任何一条命令都永久挂起（browser.pages() 永不返回）。
 *     2) 渲染进程被冻结：受限沙箱禁用命名管道，而 Chromium 的 browser↔renderer 内部 IPC 走的
 *        正是命名管道 ⇒ **浏览器级命令 6ms 就回、页面级命令永久无响应**，窗口表现为白屏。
 *        这种情况不是脚本能修的：**受管浏览器必须跑在沙箱之外**（由用户在桌面环境启动，
 *        例如双击 scripts/start-keeper.bat），客户端留在沙箱里经 127.0.0.1:9222 连接即可。
 *   本脚本一眼分辨这两种情况：浏览器级挂 = 实例问题；仅页面级挂 = 渲染进程被冻结。
 *
 * 【用法】
 *   node scripts/engine/cdp-health.js [--dir <运行时目录>] [--port <端口>] [--timeout <秒>]
 *   默认超时 12 秒/项（也可用 AUTOPILOT_HEALTH_TIMEOUT 改）。
 *
 * 【退出码】
 *   0 = 浏览器级与页面级都正常
 *   1 = 端口不通 / 连不上（浏览器没起，或代理变量污染了 127.0.0.1 的连接）
 *   2 = 浏览器级命令也挂死（半死实例 / 浏览器卡死）→ 杀掉实例重新拉起
 *   3 = 仅页面级命令挂死（渲染进程冻结）→ 受管浏览器必须跑在沙箱之外
 *
 * 【注意】本脚本会像其它脚本一样调用 resolveConfig()，因此会在运行时目录里写一份
 *   runtime.json 元数据（沿用 config.js 的既有行为）；对浏览器/页面本身是纯只读的。
 */

'use strict';

const { resolveConfig, argValue } = require('./config');
const cdp = require('./cdp');

const ARGV = process.argv.slice(2);
const CFG = resolveConfig();
const TIMEOUT_MS = Math.max(1, parseInt(argValue(ARGV, '--timeout') || process.env.AUTOPILOT_HEALTH_TIMEOUT || '12', 10) || 12) * 1000;

const results = [];

function say(msg) { console.log(msg); }

/** 给 promise 加超时。超时后底层命令仍挂着无法取消，所以额外吞掉它后续的拒绝。 */
function withTimeout(promise, ms, label) {
  const pr = Promise.resolve(promise);
  pr.catch(() => { /* 超时后底层失败不再冒泡 */ });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms（命令无响应）`)), ms);
    pr.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

function summarize(v) {
  if (v == null) return String(v);
  if (Array.isArray(v)) return `数组，长度 ${v.length}`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
  return String(v).slice(0, 120);
}

/**
 * 跑一项检查并记录结果。
 * @param {string} name  人看的名字
 * @param {'browser'|'page'} level 浏览器级 / 页面级
 * @param {Function} fn  真正要执行的 CDP 调用
 */
async function check(name, level, fn) {
  const t0 = Date.now();
  try {
    const v = await withTimeout(fn(), TIMEOUT_MS, name);
    const rec = { name, level, ok: true, ms: Date.now() - t0, detail: summarize(v) };
    results.push(rec);
    say(`  [通过] ${pad(name)} ${pad(rec.ms + 'ms')} ${rec.detail}`);
    return rec;
  } catch (e) {
    const rec = { name, level, ok: false, ms: Date.now() - t0, error: e.message };
    results.push(rec);
    say(`  [挂死] ${pad(name)} ${pad(rec.ms + 'ms')} ${e.message}`);
    return rec;
  }
}

function pad(s, n = 26) {
  const str = String(s);
  let w = 0;
  for (const ch of str) w += ch.charCodeAt(0) > 0x2000 ? 2 : 1; // 中日韩字符按 2 格宽估算
  return str + ' '.repeat(Math.max(0, n - w));
}

(async () => {
  say(`[体检] 运行时目录 ${CFG.dir}`);
  say(`[体检] CDP 地址   ${CFG.cdpUrl}（每项超时 ${TIMEOUT_MS / 1000}s）`);

  /* ---------- 0) 先做无代理的 HTTP 预检：端口不通时给出清晰提示，而不是抛栈 ---------- */
  const version = await cdp.probe(CFG.cdpUrl);
  if (!version) {
    say('');
    say(`[连不上] ${CFG.cdpUrl} 无响应 —— 受管浏览器没有在跑，或端口不对。`);
    say('  先启动它（示例）：node scripts/engine/launch.js');
    say('  若确认浏览器开着却探不到，检查是否被代理变量劫持：');
    say('    http_proxy / https_proxy / all_proxy 会让 127.0.0.1 的连接被当外网走代理，');
    say('    报错通常长得像 "upstream connect failed"，极易误判成「端口没开」。');
    say('    清掉这些变量（POSIX: unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY）再试。');
    process.exit(1);
  }
  say(`[体检] 端口在线   ${version}`);
  say('');

  /* ---------- 1) 连接 ---------- */
  let browser = null;
  const tConn = Date.now();
  try {
    browser = await withTimeout(cdp.connect(CFG.cdpUrl), TIMEOUT_MS, 'CDP 连接');
    say(`  [通过] ${pad('CDP 连接（WebSocket 握手）')} ${pad((Date.now() - tConn) + 'ms')}`);
  } catch (e) {
    say(`  [挂死] ${pad('CDP 连接（WebSocket 握手）')} ${pad((Date.now() - tConn) + 'ms')} ${e.message}`);
    say('');
    say('[结论] 端口在监听，但连不上 CDP 会话：浏览器实例异常（多半是半死实例）。');
    say('  处置（示例）：杀掉 browser-pid.json 里记录的进程树后重新拉起。');
    process.exit(2);
  }

  /* ---------- 2) 浏览器级命令 ---------- */
  say('');
  say('— 浏览器级命令（走 browser 进程，不依赖渲染进程）—');
  let targets = null;
  const rTargets = await check('browser.targets()', 'browser', async () => {
    targets = await browser.targets();
    return targets;
  });
  if (rTargets.ok) {
    await check('browser.pages()', 'browser', async () => (await browser.pages()).map(p => p.url()));
  }

  /* ---------- 3) 选一个页面做页面级命令 ---------- */
  say('');
  say('— 页面级命令（必须由渲染进程执行）—');
  let pages = [];
  try { pages = await withTimeout(browser.pages(), TIMEOUT_MS, 'browser.pages()'); } catch { /* 上面已记录 */ }
  const real = pages.filter(p => p.url() && !/^about:blank$/.test(p.url())
    && !/^(devtools|chrome|edge):/i.test(p.url()));
  const page = real[0] || pages[0] || null;

  if (!page) {
    say('  [跳过] 没有可用标签页，页面级命令无法测试（浏览器级正常，可先打开一个页面再复测）');
    finish(browser, rTargets.ok ? 0 : 2);
    return;
  }
  say(`  目标标签页: ${page.url().slice(0, 110)}`);

  const rEval = await check('page.evaluate(() => 1 + 1)', 'page',
    async () => page.evaluate(() => 1 + 1));

  // 二级证据：attach 到该 target 成功、但渲染进程侧的命令不返回 —— 说明卡在渲染进程而不是 WS 层
  const rSession = await check('createCDPSession + Page.enable', 'page', async () => {
    if (typeof page.target !== 'function') throw new Error('当前 puppeteer-core 不支持 page.target()，跳过该项');
    const session = await page.target().createCDPSession();
    try { await session.send('Page.enable'); return 'Page.enable ok'; }
    finally { try { await session.detach(); } catch { /* ignore */ } }
  });

  const browserLevelOk = rTargets.ok;
  const pageLevelOk = rEval.ok && rSession.ok;

  say('');
  say('===== 结论 =====');
  if (browserLevelOk && pageLevelOk) {
    say('[正常] 浏览器级与页面级 CDP 命令都有响应，受管浏览器可用。');
    finish(browser, 0);
    return;
  }
  if (browserLevelOk && !pageLevelOk) {
    say('[渲染进程被冻结] 浏览器级命令正常返回，页面级命令永久无响应。');
    say('  原因：某些受限沙箱禁用命名管道，而 Chromium 的 browser↔renderer 内部 IPC 走的正是它。');
    say('  症状：窗口白屏，connect() 成功，浏览器级命令毫秒级返回，页面级命令永不返回。');
    say('  ⇒ 这不是脚本能修的：**受管浏览器必须跑在沙箱之外**（由用户在桌面环境启动本技能');
    say('     的入口脚本，客户端留在沙箱里连 127.0.0.1 即可）。');
    finish(browser, 3);
    return;
  }
  say('[浏览器级也挂死] 连得上但连浏览器级命令都不返回：实例半死或浏览器卡死。');
  say('  ⇒ 杀掉 browser-pid.json 记录的进程树（Windows: taskkill /PID <pid> /T /F；');
  say('     POSIX: kill -9 -<pid>），然后重新拉起浏览器。');
  finish(browser, 2);
})().catch(e => {
  // 任何意外都给出人能看懂的一行，而不是一坨栈
  console.error('[体检出错] ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});

function finish(browser, code) {
  try { if (browser) browser.disconnect(); } catch { /* 断连失败不致命 */ }
  const ok = results.filter(r => r.ok).length;
  say('');
  say(`[体检] 共 ${results.length} 项，通过 ${ok} 项，退出码 ${code}`);
  // 挂死的 CDP 命令无法取消，socket 可能一直挂着，所以显式退出，保证脚本一定会结束
  process.exit(code);
}
