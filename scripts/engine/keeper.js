#!/usr/bin/env node
/**
 * keeper.js —— 受管浏览器常驻守护 + 定时巡检调度（**示例 / 参考实现，按需改写**）
 *
 * 【它是什么】
 *   一个不依赖任何宿主定时器的小常驻进程。自己干三件事：
 *     1) 每 20 秒探一次 CDP 端口（cdp.probe），掉了就用 cdp.launchDetached + cdp.launchAndWait 重新拉起；
 *     2) 每 N 分钟（默认 15）跑一轮确定性巡检（子进程 guardian.js），输出重定向到文件；
 *     3) 每约 2 分钟做一次「体检」：CDP 端口在线 ≠ 浏览器能用。
 *   模型侧「读证据 → 判断 → 修复」不在这里，由**宿主 Agent 的定时能力**负责唤醒模型完成。
 *
 * 【为什么需要它（都是实测踩出来的坑）】
 *   · **端口在线 ≠ 能用**。被强杀过的浏览器会留下「半死实例」霸占 profile：CDP 握手能成功
 *     （/json/version 有响应），但任何一条命令都永久挂起（browser.pages() 永不返回）。
 *     只探端口会一直以为一切正常，实际一轮巡检都跑不动。所以体检必须**真发一条命令**验证。
 *   · **不杀干净就没法重拉**。半死实例还在占 profile 时，新进程会认为「已有实例」，
 *     把 URL 转交过去后自己退出 —— 调试端口永远不就绪，表现为「重拉无效」。所以重拉前先按
 *     browser-pid.json 记录的 pid 杀进程树。
 *   · **子进程必须把 stdout/stderr 重定向到文件**。某些受限沙箱下 Node 的 piped stdio 会
 *     EPERM（child_process.spawn 默认 'pipe' 直接失败），用文件描述符就不会碰到命名管道。
 *   · **代理变量会污染本地连接**：若环境里挂着 http_proxy，127.0.0.1 的 CDP 也会被当外网走代理，
 *     表现为「端口没开」。所有子进程环境都要剔除 *_proxy。
 *   · **某些受限环境会在一次调用结束时回收该调用启动的全部后代进程**：浏览器必须由一个长命进程
 *     持有。宿主沙箱里拉起的浏览器还可能因禁命名管道而**渲染进程冻结**（浏览器级命令毫秒级返回、
 *     页面级命令永久无响应）—— 那种情况浏览器得由用户在沙箱外启动，见 scripts/start-keeper.bat。
 *
 * 【用法】
 *   node scripts/engine/keeper.js [选项]
 *   node scripts/engine/keeper.js --help
 *
 *   --dir <路径>          运行时目录（同 config.js 语义；也可用 AUTOPILOT_DIR）
 *   --adapter <id>        平台适配器 id（对应 scripts/adapters/<id>.js）
 *   --port <端口>         CDP 调试端口（默认 9222，AUTOPILOT_CDP_PORT）
 *   --browser <exe>       浏览器可执行文件（默认自动探测 Edge/Chrome）
 *   --skill <目录>        技能根目录（默认按本文件位置推导；也可用 AUTOPILOT_SKILL）
 *   --interval <分钟>     巡检轮次间隔（默认 15，AUTOPILOT_INTERVAL_MIN）
 *   --round-timeout <分>  单轮巡检超时，超时杀掉子进程（默认 6，AUTOPILOT_ROUND_TIMEOUT_MIN）
 *   --probe <秒>          CDP 端口探测间隔（默认 20，AUTOPILOT_PROBE_SEC）
 *   --health <秒>         体检间隔（默认 120，AUTOPILOT_HEALTH_SEC）
 *   --no-round            只守护浏览器，不跑定时巡检（巡检交给宿主 Agent 的定时能力时用）
 *   --no-launch           端口掉线只告警、不自动拉起（只读排查时用）
 *   --once                立即跑一轮巡检，打印末行 STATUS 后退出（单轮验证用）
 *   --check               只做一次探测 + 体检，打印报告后退出（不写业务状态）
 *
 * 【产出文件（都在运行时目录里）】
 *   keeper.log              人类可读日志（带时间戳；超过 5MB 时启动阶段轮转为 keeper.log.1）
 *   keeper-heartbeat.json   机器可读心跳：{at, keeperPid, browserOnline, browser, lastRoundAt,
 *                           lastRoundCode, lastStatus, intervalMinutes, dir}
 *                           —— lastRoundCode 是**子进程退出码**（沿用既有实现语义）；
 *                              STATUS 码（PLAYING / ALL_DONE / NEED_HELP …）在 lastStatus 里。
 *   browser-pid.json        最近一次拉起的浏览器 pid；体检判定挂死时按它杀进程树
 *   guardian-round.log      每轮巡检子进程的原始 stdout+stderr
 *
 * 【注意】全部路径都来自 resolveConfig() 或 --skill / AUTOPILOT_SKILL，本文件不含任何
 *   本机绝对路径、用户名或平台 UUID。这是参考实现：换宿主/换平台时按需改写。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { resolveConfig, loadAdapter, argValue } = require('./config');
const cdp = require('./cdp');

/* ================================================================== */
/* 参数与常量                                                          */
/* ================================================================== */

const ARGV = process.argv.slice(2);

const DEFAULT_PROBE_SEC = 20;
const DEFAULT_HEALTH_SEC = 120;
const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_ROUND_TIMEOUT_MIN = 6;

/** 体检里每一步（连接 / 发命令）各自的超时：超过就判定挂死，不无限等 */
const HEALTH_STEP_TIMEOUT_MS = 15000;
/** 主循环节拍；真正的动作按各自的间隔触发 */
const TICK_MS = 5000;
/** 重拉锁的过期时间：重拉本身只需几秒，超过 2 分钟一定是残留锁 */
const RELAUNCH_LOCK_STALE_MS = 2 * 60 * 1000;
/** keeper.log 超过它就轮转（常驻进程比定时任务活得久，必须防止日志无限涨） */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** 重拉失败后的退避：避免每 20 秒硬撞一次 */
const BACKOFF_MIN_MS = 60 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/** guardian 自己的锁过期时间是 4 分钟（engine/guardian.js）。锁还新鲜就不重复跑轮次。 */
const GUARDIAN_LOCK_STALE_MS = 4 * 60 * 1000;

const PROXY_KEYS = [
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
];

function intArg(flag, envName, defVal, min, max) {
  const raw = argValue(ARGV, flag) || process.env[envName];
  let v = parseInt(raw, 10);
  if (!Number.isFinite(v)) v = defVal;
  return Math.min(max, Math.max(min, v));
}

function printHelp() {
  const lines = [
    'keeper.js —— 受管浏览器常驻守护 + 定时巡检调度（示例/参考实现）',
    '',
    '用法: node scripts/engine/keeper.js [选项]',
    '',
    '选项:',
    '  --dir <路径>           运行时目录（默认见 config.js；也可用 AUTOPILOT_DIR）',
    '  --adapter <id>         平台适配器 id（也可用 AUTOPILOT_ADAPTER）',
    '  --port <端口>          CDP 调试端口（默认 9222，AUTOPILOT_CDP_PORT）',
    '  --browser <exe>        浏览器可执行文件（默认自动探测，AUTOPILOT_BROWSER_EXE）',
    '  --skill <目录>         技能根目录（默认按本文件位置推导，AUTOPILOT_SKILL）',
    '  --interval <分钟>      巡检轮次间隔（默认 15，AUTOPILOT_INTERVAL_MIN）',
    '  --round-timeout <分>   单轮巡检超时，超时杀掉该子进程（默认 6，AUTOPILOT_ROUND_TIMEOUT_MIN）',
    '  --probe <秒>           CDP 端口探测间隔（默认 20，AUTOPILOT_PROBE_SEC）',
    '  --health <秒>          体检间隔（默认 120，AUTOPILOT_HEALTH_SEC）',
    '  --no-round             只守护浏览器，不跑定时巡检',
    '  --no-launch            端口掉线只告警，不自动拉起（只读排查用）',
    '  --once                 立即跑一轮巡检，打印末行 STATUS 后退出',
    '  --check                只做一次探测 + 体检，打印报告后退出',
    '  --help                 显示本帮助',
    '',
    '产出（运行时目录内）: keeper.log / keeper-heartbeat.json / browser-pid.json / guardian-round.log',
    '',
    '守护策略:',
    '  · 每 20 秒探 CDP 端口；掉线 → 杀残骸实例 → 用「最后已知学习页」作 startUrl 重拉',
    '  · 每约 2 分钟体检：connect(15s) + browser.pages()(15s)，超时判定挂死 → 杀进程树 → 重拉',
    '  · 每 15 分钟跑一轮 guardian.js；单轮超 6 分钟杀子进程，输出重定向到 guardian-round.log',
    '  · 巡检进行中不重拉、不杀浏览器（交给 guardian 自愈），避免两个进程抢同一 profile',
  ];
  console.log(lines.join('\n'));
}

/* ================================================================== */
/* 运行时状态（main() 里初始化）                                        */
/* ================================================================== */

let CFG = null;              // resolveConfig() 结果
let SKILL = null;            // 技能根目录
let GUARDIAN = null;         // scripts/engine/guardian.js
let LOG_FILE = null;
let HEARTBEAT_FILE = null;
let BROWSER_PID_FILE = null;
let ROUND_LOG = null;
let SINGLETON_LOCK = null;   // 单例锁：同一运行时目录只允许一个 keeper
let RELAUNCH_LOCK = null;    // 重拉锁：同一时刻只允许一个进程拉浏览器

let PROBE_MS = DEFAULT_PROBE_SEC * 1000;
let HEALTH_MS = DEFAULT_HEALTH_SEC * 1000;
let INTERVAL_MS = DEFAULT_INTERVAL_MIN * 60 * 1000;
let ROUND_TIMEOUT_MS = DEFAULT_ROUND_TIMEOUT_MIN * 60 * 1000;
let NO_LAUNCH = false;
let NO_ROUND = false;

/** 心跳内容。键名是**对外契约**，不要随手改名（外部靠它判断守活死活）。 */
const HB = {
  at: null,
  keeperPid: null,
  browserOnline: false,
  browser: null,
  lastRoundAt: null,
  lastRoundCode: null,
  lastStatus: null,
  intervalMinutes: DEFAULT_INTERVAL_MIN,
  dir: null,
};

const STATE = {
  browserOnline: false,
  healthOk: true,
  relaunching: false,
  shuttingDown: false,
  backoffMs: 0,
  nextRelaunchAt: 0,
  round: null,          // 正在跑的子进程
  myLocks: {},          // { 文件路径: 写入内容 }，退出时只删自己写的那份
  throttled: {},        // 重复日志抑制：{ key: 上次打印时间 }
};

/* ================================================================== */
/* 基础工具                                                            */
/* ================================================================== */

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* 目录不可写也不能崩 */ }
}

/** 同一句话最多每 minMs 打一次（端口长期不通时避免刷屏） */
function logThrottled(key, msg, minMs = 5 * 60 * 1000) {
  const now = Date.now();
  if (STATE.throttled[key] && now - STATE.throttled[key] < minMs) return;
  STATE.throttled[key] = now;
  log(msg);
}

function truncate(s, n) { return String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''); }

/**
 * 给 promise 加超时。
 * 超时后底层 promise 仍可能挂在那里，所以额外挂一个 catch 吞掉它的拒绝，避免 unhandledRejection。
 */
function withTimeout(promise, ms, label) {
  const pr = Promise.resolve(promise);
  pr.catch(() => { /* 超时后底层失败不再冒泡 */ });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    pr.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 进程是否存活。Windows 上 process.kill(pid, 0) 同样可用；EPERM 说明进程在但无权限。 */
function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/* ================================================================== */
/* 锁（都用 'wx' 原子创建）                                             */
/* ================================================================== */
/* 'wx' = 文件不存在才创建，创建本身是原子的：两个进程只有一个能成功。
   单例锁（keeper.lock）：防止两个 keeper 抢同一个 profile —— 它们会互相把对方的浏览器
     杀掉又拉起，表现为「浏览器反复重连、视频永远播不长」。
   重拉锁（keeper-relaunch.lock）：即使单例锁因残留/人为复制目录而失效，也不会有两个进程
     同时拉起同一 profile 的浏览器。 */

function acquireFileLock(file, label, staleMs) {
  const body = `${process.pid} ${new Date().toISOString()}`;
  const write = () => {
    try { fs.writeFileSync(file, body, { flag: 'wx' }); return { ok: true, body }; }
    catch (e) { return { ok: false, error: e.message }; }
  };
  const first = write();
  if (first.ok) return first;

  // 已有锁：分清「真的被活着且新鲜的进程持有」与「残留 / 超时」
  let owner = 0; let age = Infinity;
  try {
    owner = parseInt(String(fs.readFileSync(file, 'utf8')).trim().split(/\s+/)[0], 10) || 0;
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch { /* 读不到就当残留 */ }

  const alive = pidAlive(owner);
  const fresh = staleMs == null ? true : age < staleMs;   // staleMs = null ⇒ 只看进程存活
  if (alive && fresh) return { ok: false, owner, age };

  log(`${label} ${file} 是残留锁（owner=${owner || '?'} 存活=${alive} 年龄=${Number.isFinite(age) ? Math.round(age / 1000) + 's' : '?'}），接管`);
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return write();
}

function releaseFileLock(file) {
  // 只删「内容与本次写入完全一致」的锁，避免误删新进程刚写的锁
  const body = STATE.myLocks[file];
  if (!body) return;
  try { if (String(fs.readFileSync(file, 'utf8')) === body) fs.unlinkSync(file); } catch { /* ignore */ }
  delete STATE.myLocks[file];
}

/** 记下「这个锁是我写的」，退出时据此清理 */
function rememberLock(file, res) {
  if (res && res.ok && res.body) STATE.myLocks[file] = res.body;
}

/* ================================================================== */
/* 跨平台杀进程                                                        */
/* ================================================================== */
/* ⚠️ 两种杀法不能混用：
 *   · 浏览器是 cdp.launchDetached() 用 detached:true 拉起的 ⇒ 在 POSIX 上是**新进程组的组长**，
 *     所以 kill(-pid) 能一次收掉整棵树。
 *   · 巡检子进程**不是** detached ⇒ 它与 keeper 同组，对它用 kill(-pid) 会把 keeper 自己也杀掉。
 *     Windows 上则一律用 taskkill /T /F 收树。
 *   ⚠️ 某些受限沙箱里 node spawn 外部 exe 会 EBUSY（taskkill.exe 也起不来），
 *     所以 taskkill 失败后要回退到 process.kill(pid)，并在日志里说清「树可能没杀全」。 */

function killTreeByPid(pid, why) {
  if (!pid || !Number.isFinite(pid)) { log(`没有可杀的 pid（${why}）`); return false; }
  if (!pidAlive(pid)) { log(`pid ${pid} 已不存在，无需清理（${why}）`); return false; }
  log(`清理进程树 pid=${pid}（${why}）`);

  if (process.platform === 'win32') {
    let ok = false;
    try {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      ok = !!r && r.status === 0;
      if (!ok) log(`taskkill 返回非 0（status=${r ? r.status : '?'}），回退到 process.kill`);
    } catch (e) {
      log(`taskkill 起不来（${e.message}），回退到 process.kill`);
    }
    if (!ok) {
      try { process.kill(pid, 'SIGKILL'); ok = true; }
      catch (e) { log(`process.kill(${pid}) 也失败：${e.message}（该实例可能仍霸占 profile）`); }
      if (ok) log('已用 process.kill 杀掉主进程；注意：子进程可能残留，profile 锁可能没释放');
    }
    return ok;
  }

  // POSIX：浏览器是独立进程组的组长，先整组杀；失败再单杀
  try { process.kill(-pid, 'SIGKILL'); return true; }
  catch (e) {
    log(`kill(-${pid}) 失败（${e.message}），改为单杀主进程`);
    try { process.kill(pid, 'SIGKILL'); return true; }
    catch (e2) { log(`kill(${pid}) 也失败：${e2.message}`); return false; }
  }
}

/** 杀巡检子进程：它不是进程组组长，POSIX 上只能单杀（否则连 keeper 一起杀） */
function killRoundChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (r && r.status === 0) return;
    } catch (e) {
      log(`taskkill 巡检子进程失败：${e.message}`);
    }
  }
  try { child.kill('SIGKILL'); } catch (e) { log(`杀巡检子进程失败：${e.message}`); }
}

/* ================================================================== */
/* browser-pid.json                                                    */
/* ================================================================== */

function recordBrowserPid(pid, version, startUrl) {
  try {
    fs.writeFileSync(BROWSER_PID_FILE, JSON.stringify({
      pid,
      port: CFG.cdpPort,
      cdpUrl: CFG.cdpUrl,
      profile: CFG.profileDir,
      browser: version || null,
      startUrl: startUrl || null,
      startedAt: new Date().toISOString(),
      by: 'keeper',
    }, null, 2));
  } catch (e) {
    log('写 browser-pid.json 失败: ' + e.message);
  }
}

function readBrowserPidFile() {
  try { return JSON.parse(fs.readFileSync(BROWSER_PID_FILE, 'utf8')); }
  catch { return null; }
}

/** 按 browser-pid.json 的记录清理受管浏览器（绝不按进程名乱杀，避免误伤用户日常浏览器） */
function killRecordedBrowser(why) {
  const rec = readBrowserPidFile();
  if (!rec || !rec.pid) { log(`browser-pid.json 里没有 pid 记录，跳过清理（${why}）`); return false; }
  return killTreeByPid(rec.pid, why);
}

/* ================================================================== */
/* 心跳                                                                */
/* ================================================================== */

function heartbeat(patch) {
  Object.assign(HB, patch || {});
  HB.at = new Date().toISOString();
  HB.keeperPid = process.pid;
  HB.intervalMinutes = Math.round(INTERVAL_MS / 60000);
  HB.dir = CFG.dir;
  HB.browserOnline = STATE.browserOnline;
  try { fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(HB, null, 2)); } catch { /* ignore */ }
}

/* ================================================================== */
/* 子进程环境 / startUrl                                               */
/* ================================================================== */

/** 剔除代理变量：挂着 http_proxy 时，连 127.0.0.1 的 CDP 也会被当外网走代理 */
function childEnv() {
  const env = Object.assign({}, process.env);
  for (const k of PROXY_KEYS) delete env[k];
  for (const k of Object.keys(env)) {
    if (/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k];
  }
  // 让子进程和 keeper 用同一个运行时目录 / 适配器，避免两处漂移
  env.AUTOPILOT_DIR = CFG.dir;
  env.AUTOPILOT_ADAPTER = CFG.adapterId;
  return env;
}

/**
 * 重拉浏览器时用「最后已知的学习页」，避免停在 about:blank 空转。
 * 优先级：evidence/latest/status.json 的 url → learn-state.json 的 subjectUrl → about:blank。
 * 注意只接受 http(s)；subjectUrl 若是 hash（#/xxx）则用适配器 baseUrl 拼成绝对地址。
 */
function lastKnownStudyUrl() {
  try {
    const ev = JSON.parse(fs.readFileSync(path.join(CFG.dir, 'evidence', 'latest', 'status.json'), 'utf8'));
    if (ev && typeof ev.url === 'string' && /^https?:\/\//i.test(ev.url)) return ev.url;
  } catch { /* 还没有证据包 */ }

  let subjectUrl = null;
  try {
    const st = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    if (st && typeof st.subjectUrl === 'string' && st.subjectUrl) subjectUrl = st.subjectUrl;
  } catch { /* 还没有状态文件 */ }
  if (subjectUrl) {
    if (/^https?:\/\//i.test(subjectUrl)) return subjectUrl;
    try {
      const ad = loadAdapter(CFG.adapterId);
      const base = (ad.homeUrl || ad.baseUrl || '').replace(/\/+$/, '');
      if (base) return base + '/' + subjectUrl.replace(/^\/?#?\/?/, '#/');
    } catch { /* 适配器不可用时只能放弃 */ }
    log(`learn-state.json 的 subjectUrl 不是绝对 URL，无法还原成可访问地址：${truncate(subjectUrl, 60)}`);
  }
  return 'about:blank';
}

/* ================================================================== */
/* 端口探测 + 拉起                                                      */
/* ================================================================== */

/** 重拉失败后的退避：1 分钟起，翻倍到 5 分钟封顶 */
function scheduleRelaunchBackoff() {
  STATE.backoffMs = STATE.backoffMs ? Math.min(STATE.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
  STATE.nextRelaunchAt = Date.now() + STATE.backoffMs;
  log(`重拉失败，${Math.round(STATE.backoffMs / 1000)}s 后再试`);
}

function resetRelaunchBackoff() {
  STATE.backoffMs = 0;
  STATE.nextRelaunchAt = 0;
}

/**
 * 确保受管浏览器在线。
 * @param {string} reason 记日志用
 * @returns {Promise<boolean>}
 */
async function ensureBrowser(reason) {
  if (NO_LAUNCH) {
    logThrottled('no-launch', `浏览器不在线，但 --no-launch 已禁用自动拉起（${reason}）`);
    return false;
  }
  if (STATE.relaunching) {
    logThrottled('relaunch-busy', '另一次重拉正在进行，本次跳过');
    return false;
  }
  if (STATE.round) {
    // 巡检进行中就交给 guardian 自己自愈（它带自动拉起），两个进程同时拉会抢同一 profile
    logThrottled('relaunch-in-round', '巡检进行中，浏览器交由本轮巡检自愈，keeper 不重拉');
    return false;
  }
  if (Date.now() < STATE.nextRelaunchAt) {
    logThrottled('relaunch-backoff', `重拉退避中，还有 ${Math.ceil((STATE.nextRelaunchAt - Date.now()) / 1000)}s`);
    return false;
  }

  const lock = acquireFileLock(RELAUNCH_LOCK, '重拉锁', RELAUNCH_LOCK_STALE_MS);
  if (!lock.ok) {
    logThrottled('relaunch-locked', `重拉锁被占用（owner pid=${lock.owner || '?'}），跳过本次重拉`);
    return false;
  }
  rememberLock(RELAUNCH_LOCK, lock);
  STATE.relaunching = true;
  try {
    // 双检：抢锁期间可能已被别人拉起来了
    const v0 = await cdp.probe(CFG.cdpUrl);
    if (v0) {
      STATE.browserOnline = true;
      STATE.browser = v0;
      heartbeat();
      return true;
    }

    // 半死 / 残骸实例会霸占 profile：不清干净的话新进程启动后会转交 URL 然后自己退出，
    // 调试端口永远不会就绪（表现为「重拉了但一直连不上」）。
    killRecordedBrowser('重拉前清理可能霸占 profile 的残骸实例');
    await cdp.sleep(1500);

    const startUrl = lastKnownStudyUrl();
    log(`拉起受管浏览器（原因：${reason}；startUrl=${truncate(startUrl, 100)}）`);
    const r = await cdp.launchAndWait(CFG, { startUrl, cdpUrl: CFG.cdpUrl, tries: 8, stepMs: 4000 });
    if (!r.ok) {
      log(`拉起失败：${r.error || '未知'}`);
      if (r.pid) killTreeByPid(r.pid, '拉起后端口未就绪的残骸');
      STATE.browserOnline = false;
      heartbeat();
      scheduleRelaunchBackoff();
      return false;
    }
    recordBrowserPid(r.pid, r.version, startUrl);
    STATE.browserOnline = true;
    STATE.browser = r.version;
    resetRelaunchBackoff();
    log(`浏览器已就绪 ${r.version}（等待 ${r.waitedMs}ms，pid=${r.pid}）`);
    heartbeat();
    return true;
  } catch (e) {
    log('拉起浏览器出错: ' + (e && e.message ? e.message : e));
    scheduleRelaunchBackoff();
    return false;
  } finally {
    STATE.relaunching = false;
    releaseFileLock(RELAUNCH_LOCK);
  }
}

/** 每 20 秒的端口探测 */
async function probeTick() {
  const v = await cdp.probe(CFG.cdpUrl);
  if (v) {
    if (!STATE.browserOnline) log(`CDP 端口已在线：${CFG.cdpUrl} -> ${v}`);
    STATE.browserOnline = true;
    STATE.browser = v;
    resetRelaunchBackoff();
    heartbeat();
    return;
  }
  if (STATE.browserOnline) log(`CDP 端口掉线：${CFG.cdpUrl}（将尝试重新拉起）`);
  STATE.browserOnline = false;
  heartbeat();
  await ensureBrowser('端口探测不到 CDP');
}

/* ================================================================== */
/* 体检：端口在线 ≠ 能用                                                */
/* ================================================================== */

/**
 * 真的发命令验证浏览器可用。
 * 分两段判定：connect 阶段失败 = 端口层面不通（交给 probeTick）；
 * pages() 阶段超时 = 握手成功但命令挂死（半死实例），必须杀树重拉。
 */
async function browserHealth() {
  const t0 = Date.now();
  let browser = null;
  let connectMs = null;
  try {
    browser = await withTimeout(cdp.connect(CFG.cdpUrl), HEALTH_STEP_TIMEOUT_MS, 'CDP 连接');
    connectMs = Date.now() - t0;
  } catch (e) {
    return { ok: false, stage: 'connect', error: e.message, connectMs: Date.now() - t0 };
  }
  const t1 = Date.now();
  try {
    const pages = await withTimeout(browser.pages(), HEALTH_STEP_TIMEOUT_MS, 'browser.pages()');
    return { ok: true, stage: 'done', connectMs, pagesMs: Date.now() - t1, pageCount: (pages || []).length };
  } catch (e) {
    return { ok: false, stage: 'pages', error: e.message, connectMs, pagesMs: Date.now() - t1 };
  } finally {
    try { browser.disconnect(); } catch { /* 断连失败不致命，绝不用 close() */ }
  }
}

/** 每约 2 分钟的体检：能连上不等于能用 */
async function healthTick() {
  if (STATE.round) {
    logThrottled('health-in-round', '巡检进行中，跳过本轮体检（避免中途杀浏览器打断巡检）');
    return;
  }
  const h = await browserHealth();
  if (h.ok) {
    if (!STATE.healthOk) log(`体检恢复正常：连接 ${h.connectMs}ms，browser.pages() ${h.pagesMs}ms，页数 ${h.pageCount}`);
    STATE.healthOk = true;
    STATE.browserOnline = true;
    heartbeat();
    return;
  }

  STATE.healthOk = false;
  if (h.stage === 'connect') {
    // 端口层面就不通：交给 20 秒的端口探测路径统一处理，不在这里重复重拉
    logThrottled('health-connect-fail', `体检：CDP 连不上（${h.error}），交给端口探测路径处理`);
    STATE.browserOnline = false;
    heartbeat();
    return;
  }

  log(`体检不通过：${h.error}（连接 ${h.connectMs}ms 成功，但命令永久挂起）`
    + ' → 判定浏览器挂死：端口在线 ≠ 能用');
  log('原因通常是实例被强杀后留下的半死进程仍在霸占 profile。杀掉它再重拉。');
  killRecordedBrowser('CDP 握手成功但命令无响应（半死实例霸占 profile）');
  await cdp.sleep(1500);
  resetRelaunchBackoff(); // 体检判定挂死是明确故障，立即重拉，不走退避
  STATE.browserOnline = false;
  heartbeat();
  await ensureBrowser('体检判定浏览器挂死');
}

/* ================================================================== */
/* 定时巡检轮次                                                        */
/* ================================================================== */

function readEvidence() {
  try { return JSON.parse(fs.readFileSync(path.join(CFG.dir, 'evidence', 'latest', 'status.json'), 'utf8')); }
  catch { return null; }
}

/** 上一轮巡检是否仍在进行（对齐 guardian 自己的 4 分钟过期锁语义） */
function guardianLockFresh() {
  try {
    const st = fs.statSync(CFG.lockFile);
    if (Date.now() - st.mtimeMs < GUARDIAN_LOCK_STALE_MS) return true;
  } catch { /* 没锁 */ }
  return false;
}

/**
 * 跑一轮确定性巡检（子进程）。
 * ⚠️ stdout/stderr 必须重定向到**文件描述符**，不能用管道：
 *    某些受限沙箱下 Node 的 piped stdio 会 EPERM，spawn 直接失败。
 * @returns {Promise<{code:number|null, statusLine:string}>} 仅 --once 时 await
 */
function runRound(reason) {
  if (NO_ROUND) return Promise.resolve({ code: null, statusLine: '' });
  if (STATE.round) {
    log(`上一轮巡检仍在进行，跳过本轮（${reason}）`);
    return Promise.resolve({ code: null, statusLine: '' });
  }
  if (guardianLockFresh()) {
    log(`guardian.lock 仍新鲜（上轮未结束或是外部巡检在跑），跳过本轮（${reason}）`);
    return Promise.resolve({ code: null, statusLine: '' });
  }

  let fd;
  try {
    fd = fs.openSync(ROUND_LOG, 'a');
    fs.writeSync(fd, `\n===== 巡检开始 ${new Date().toISOString()} (${reason}) =====\n`);
  } catch (e) {
    log('打不开巡检日志 ' + ROUND_LOG + '：' + e.message);
    return Promise.resolve({ code: null, statusLine: '' });
  }

  const args = [GUARDIAN, '--dir', CFG.dir, '--adapter', CFG.adapterId];
  let child;
  try {
    child = spawn(process.execPath, args, {
      stdio: ['ignore', fd, fd],   // 文件描述符重定向：不用管道，避开沙箱的命名管限制
      env: childEnv(),
      windowsHide: true,
    });
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    log('spawn 巡检失败: ' + e.message);
    return Promise.resolve({ code: null, statusLine: '' });
  }
  try { fs.closeSync(fd); } catch { /* 子进程已持有自己的副本 */ }

  STATE.round = child;
  log(`开始一轮巡检（${reason}）：node ${path.basename(GUARDIAN)} --dir ${CFG.dir} --adapter ${CFG.adapterId}`
    + `（输出 → ${path.basename(ROUND_LOG)}）`);

  return new Promise(resolve => {
    let done = false;
    // 单轮超时：卡死就杀掉，别把后续轮次一起堵死
    const hardStop = setTimeout(() => {
      if (STATE.round !== child) return;
      log(`巡检超过 ${Math.round(ROUND_TIMEOUT_MS / 60000)} 分钟未结束（疑似浏览器挂死），杀掉该子进程`);
      killRoundChild(child);
    }, ROUND_TIMEOUT_MS);

    const finish = (code, note) => {
      if (done) return;
      done = true;
      clearTimeout(hardStop);
      if (STATE.round === child) STATE.round = null;
      const ev = readEvidence();
      const statusLine = (ev && ev.statusLine) ? ev.statusLine : '';
      log(`巡检结束 code=${code}${note ? '（' + note + '）' : ''} ${statusLine}`);
      HB.lastRoundAt = new Date().toISOString();
      HB.lastRoundCode = code;
      HB.lastStatus = statusLine || null;
      heartbeat();
      resolve({ code, statusLine });
    };

    child.on('exit', (code, signal) => finish(code == null ? -1 : code, signal ? 'signal=' + signal : ''));
    child.on('error', e => { log('巡检进程错误: ' + e.message); finish(null, 'spawn error'); });
  });
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

function rotateLogIfHuge() {
  try {
    if (fs.statSync(LOG_FILE).size < LOG_ROTATE_BYTES) return;
    fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    log(`keeper.log 超过 ${Math.round(LOG_ROTATE_BYTES / 1024 / 1024)}MB，已轮转为 keeper.log.1`);
  } catch { /* 首次运行没有日志文件 */ }
}

function shutdown(sig) {
  if (STATE.shuttingDown) return;
  STATE.shuttingDown = true;
  log(`收到 ${sig}，keeper 退出（受管浏览器保持运行，不主动关闭）`);
  if (STATE.round) killRoundChild(STATE.round);
  releaseFileLock(RELAUNCH_LOCK);
  releaseFileLock(SINGLETON_LOCK);
  process.exit(0);
}

async function main() {
  if (ARGV.includes('--help') || ARGV.includes('-h')) { printHelp(); process.exit(0); }

  // 配置：--dir / AUTOPILOT_DIR / config.js 默认值。skill 目录：--skill / AUTOPILOT_SKILL / 本文件位置。
  CFG = resolveConfig(ARGV);
  SKILL = path.resolve(argValue(ARGV, '--skill') || process.env.AUTOPILOT_SKILL
    || path.join(__dirname, '..', '..'));
  GUARDIAN = path.join(SKILL, 'scripts', 'engine', 'guardian.js');

  LOG_FILE = path.join(CFG.dir, 'keeper.log');
  HEARTBEAT_FILE = path.join(CFG.dir, 'keeper-heartbeat.json');
  BROWSER_PID_FILE = path.join(CFG.dir, 'browser-pid.json');
  ROUND_LOG = path.join(CFG.dir, 'guardian-round.log');
  SINGLETON_LOCK = path.join(CFG.dir, 'keeper.lock');
  RELAUNCH_LOCK = path.join(CFG.dir, 'keeper-relaunch.lock');

  PROBE_MS = intArg('--probe', 'AUTOPILOT_PROBE_SEC', DEFAULT_PROBE_SEC, 5, 3600) * 1000;
  HEALTH_MS = intArg('--health', 'AUTOPILOT_HEALTH_SEC', DEFAULT_HEALTH_SEC, 20, 24 * 3600) * 1000;
  INTERVAL_MS = intArg('--interval', 'AUTOPILOT_INTERVAL_MIN', DEFAULT_INTERVAL_MIN, 1, 24 * 60) * 60 * 1000;
  ROUND_TIMEOUT_MS = intArg('--round-timeout', 'AUTOPILOT_ROUND_TIMEOUT_MIN', DEFAULT_ROUND_TIMEOUT_MIN, 1, 120) * 60 * 1000;
  NO_LAUNCH = ARGV.includes('--no-launch');
  NO_ROUND = ARGV.includes('--no-round');

  if (!fs.existsSync(CFG.dir)) { try { fs.mkdirSync(CFG.dir, { recursive: true }); } catch { /* 下面写日志时会报 */ } }
  rotateLogIfHuge();

  if (!fs.existsSync(GUARDIAN)) {
    log(`找不到巡检引擎 ${GUARDIAN}。用 --skill <技能根目录> 指定技能位置。`);
    process.exit(1);
  }

  const singleton = acquireFileLock(SINGLETON_LOCK, '单例锁', null);
  if (!singleton.ok) {
    log(`已有 keeper 在运行（pid=${singleton.owner || '?'}，锁文件 ${SINGLETON_LOCK}），本进程退出。`
      + ' 同一运行时目录只允许一个 keeper —— 两个 keeper 会互相抢浏览器 profile。');
    process.exit(1);
  }
  rememberLock(SINGLETON_LOCK, singleton);

  log(`keeper 启动 pid=${process.pid} node=${process.version}`);
  log(`  运行时目录 : ${CFG.dir}`);
  log(`  技能目录   : ${SKILL}`);
  log(`  CDP        : ${CFG.cdpUrl}（端口探测 ${PROBE_MS / 1000}s / 体检 ${HEALTH_MS / 1000}s）`);
  log(`  巡检       : ${NO_ROUND ? '已禁用（--no-round）' : `每 ${INTERVAL_MS / 60000} 分钟一轮，单轮超时 ${ROUND_TIMEOUT_MS / 60000} 分钟`}`);
  log(`  自动拉起   : ${NO_LAUNCH ? '已禁用（--no-launch）' : '开启'}`);
  heartbeat();

  /* ---------- --check：只做一次探测 + 体检 ---------- */
  if (ARGV.includes('--check')) {
    const v = await cdp.probe(CFG.cdpUrl);
    console.log(`[探测] ${CFG.cdpUrl} -> ${v || '无响应（端口不通）'}`);
    if (!v) { log('--check：端口不通，结束'); process.exit(1); }
    const h = await browserHealth();
    if (h.ok) {
      console.log(`[体检] 通过：连接 ${h.connectMs}ms，browser.pages() ${h.pagesMs}ms，页数 ${h.pageCount}`);
      STATE.browserOnline = true;
      STATE.browser = v;
      heartbeat();
      log(`--check：在线且可用（${v}）`);
      process.exit(0);
    }
    console.log(`[体检] 不通过（阶段 ${h.stage}）：${h.error}`);
    if (h.stage === 'pages') {
      console.log('  ⇒ 浏览器级命令有响应、页面级命令无响应：渲染进程可能被冻结');
      console.log('    （受限沙箱禁命名管道会让 Chromium 内部 IPC 不通）。受管浏览器必须跑在沙箱之外。');
    }
    log(`--check：体检不通过（${h.stage}）：${h.error}`);
    process.exit(2);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 常驻进程不能被一次异常带走：记下来，继续守
  process.on('uncaughtException', e => log('!! 未捕获异常（keeper 继续运行）: ' + (e && e.stack ? e.stack : e)));
  process.on('unhandledRejection', e => log('!! 未处理的 Promise 拒绝（keeper 继续运行）: ' + (e && e.stack ? e.stack : e)));
  process.on('exit', () => {
    releaseFileLock(RELAUNCH_LOCK);
    releaseFileLock(SINGLETON_LOCK);
  });

  /* ---------- 启动自检：端口通但命令挂死时先清干净，否则整轮巡检都会卡住 ---------- */
  if (await cdp.probe(CFG.cdpUrl)) {
    const h = await browserHealth();
    if (h.ok) {
      STATE.browserOnline = true;
      log('启动自检：浏览器在线且可用');
    } else if (h.stage === 'pages') {
      log(`启动自检不通过：${h.error} → 判定半死实例，杀进程树后重拉`);
      killRecordedBrowser('启动自检判定挂死');
      await cdp.sleep(1500);
    }
    heartbeat();
  }
  await ensureBrowser('启动时确保浏览器在线');

  /* ---------- --once：立即跑一轮巡检并退出（单轮验证用） ---------- */
  if (ARGV.includes('--once')) {
    const r = await runRound('once');
    console.log(r.statusLine ? `STATUS 行: ${r.statusLine}` : '（本轮没有产出 STATUS 行，检查 guardian-round.log）');
    process.exit(r.statusLine ? 0 : 1);
  }

  /* ---------- 常驻循环 ---------- */
  if (!NO_ROUND) runRound('startup');

  let nextProbeAt = 0;
  let nextHealthAt = Date.now() + HEALTH_MS;
  let nextRoundAt = Date.now() + INTERVAL_MS;

  while (!STATE.shuttingDown) {
    await cdp.sleep(TICK_MS);
    if (STATE.shuttingDown) break;
    const now = Date.now();
    try {
      if (now >= nextProbeAt) {
        nextProbeAt = now + PROBE_MS;
        await probeTick();
      }
      if (now >= nextHealthAt) {
        nextHealthAt = now + HEALTH_MS;
        await healthTick();
      }
      if (!NO_ROUND && now >= nextRoundAt) {
        nextRoundAt = now + INTERVAL_MS;
        runRound('interval'); // 不 await：探测/心跳继续跑，轮次内部有并发与超时保护
      }
    } catch (e) {
      log('循环内部异常（继续运行）: ' + (e && e.stack ? e.stack : e));
    }
  }
}

if (require.main === module) {
  main().catch(e => {
    try { log('keeper 致命错误: ' + (e && e.stack ? e.stack : e)); } catch { /* ignore */ }
    process.exit(1);
  });
}

/* 只导出与配置无关的纯工具，方便单独复用 / 测试。
   lastKnownStudyUrl()、browserHealth()、ensureBrowser() 依赖 main() 里初始化的 CFG，
   直接 require 本文件不会启动守护进程（靠上面的 require.main 判断）。 */
module.exports = { withTimeout, pidAlive, killTreeByPid, acquireFileLock };
