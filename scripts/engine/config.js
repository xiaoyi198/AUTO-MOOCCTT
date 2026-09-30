/**
 * config.js —— 运行时配置解析
 *
 * 设计原则：**不硬编码任何用户名路径**。所有路径都从 os.homedir() / 环境变量 / 命令行参数推导，
 * 这样 skill 换到别的机器、别的 agent、别的平台都能直接跑。
 *
 * 优先级（高 → 低）：命令行参数 > 环境变量 > 默认值
 *
 * 可用参数 / 环境变量：
 *   --dir <路径>            AUTOPILOT_DIR          运行时目录（状态、日志、锁、浏览器 profile 都在这）
 *   --adapter <id>          AUTOPILOT_ADAPTER      平台适配器 id（对应 scripts/adapters/<id>.js）
 *   --port <端口>           AUTOPILOT_CDP_PORT     CDP 调试端口，默认 9222
 *   --browser <exe 路径>    AUTOPILOT_BROWSER_EXE  浏览器可执行文件（留空则自动探测 Edge/Chrome）
 *   --node <node 路径>      AUTOPILOT_NODE_BIN     指定 node 可执行文件（包装脚本用）
 *
 * 硬性约束（踩过坑，别改）：
 *   - 运行时目录**必须和用户日常浏览器的 profile 分开**。136+ 的 Chrome/Edge 只有在
 *     --user-data-dir 指向非默认目录时才会真正开启远程调试端口。
 *   - 也**不要复用正在跑其它任务的目录**：锁、状态文件会互相踩。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

/** 在常见安装位置里探测浏览器可执行文件 */
function detectBrowserExe() {
  const cands = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : [
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/**
 * 定位 puppeteer-core。按以下顺序尝试，任一命中即可：
 *   1. 常规 require 解析（项目内 node_modules / NODE_PATH）
 *   2. WorkBuddy 托管目录 ~/.workbuddy/binaries/node/workspace/node_modules
 *   3. AUTOPILOT_PUPPETEER 指定的绝对路径
 * 不下载浏览器：puppeteer-core 复用本机已装的 Edge/Chrome。
 */
function loadPuppeteer() {
  const tries = [];
  if (process.env.AUTOPILOT_PUPPETEER) tries.push(process.env.AUTOPILOT_PUPPETEER);
  tries.push('puppeteer-core');
  tries.push(path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'puppeteer-core'));
  for (const t of tries) {
    try { return require(t); } catch { /* 继续试下一个 */ }
  }
  throw new Error(
    '找不到 puppeteer-core。请任选一种方式安装：\n' +
    '  · 在运行时目录执行  npm i puppeteer-core --no-audit --no-fund\n' +
    '  · 或设置环境变量 AUTOPILOT_PUPPETEER=<puppeteer-core 绝对路径>\n' +
    '注意用 puppeteer-core（不下载浏览器），不要用 puppeteer。'
  );
}

function resolveConfig(argv = process.argv.slice(2)) {
  const dir = path.resolve(
    argValue(argv, '--dir') || process.env.AUTOPILOT_DIR ||
    path.join(os.homedir(), '.workbuddy', 'course-autopilot')
  );
  const adapterId = argValue(argv, '--adapter') || process.env.AUTOPILOT_ADAPTER || 'mooc-ctt-cn';
  const cdpPort = parseInt(argValue(argv, '--port') || process.env.AUTOPILOT_CDP_PORT || '9222', 10);

  const browserExe = argValue(argv, '--browser') || process.env.AUTOPILOT_BROWSER_EXE || detectBrowserExe();

  const cfg = {
    dir,
    adapterId,
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    browserExe,
    profileDir: path.join(dir, 'browser-profile'),
    stateFile: path.join(dir, 'learn-state.json'),
    queueFile: path.join(dir, 'subject-queue.json'),
    logFile: path.join(dir, 'learn-log.txt'),
    lockFile: path.join(dir, 'guardian.lock'),
    shotFile: path.join(dir, 'guardian-shot.png'),
    creditLog: path.join(dir, 'credit-history.jsonl'),
    // 退出码语义：0 = 正常（含 BUSY/NEED_HELP，调用方看 STATUS 行判断）
    keepBrowserOnExit: true,
  };

  // 元数据落盘，便于事后排查"这份状态是哪个平台/端口产生的"
  try {
    fs.mkdirSync(cfg.dir, { recursive: true });
    fs.writeFileSync(path.join(cfg.dir, 'runtime.json'), JSON.stringify({
      adapterId, cdpPort, cdpUrl: cfg.cdpUrl, browserExe,
      platform: process.platform, node: process.version,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch { /* 目录不可写时不致命，后续写状态时再报 */ }

  return cfg;
}

/** 加载适配器。适配器缺失 / 字段不全时尽早失败，别等到跑挂了才发现。 */
function loadAdapter(adapterId) {
  const p = path.join(__dirname, '..', 'adapters', adapterId + '.js');
  let adapter;
  try {
    adapter = require(p);
  } catch (e) {
    throw new Error(`加载适配器失败 ${p}: ${e.message}\n可用的适配器见 scripts/adapters/ 目录。`);
  }
  const required = ['id', 'label', 'baseUrl', 'routing', 'credit', 'startTexts'];
  const missing = required.filter(k => adapter[k] == null);
  if (missing.length) throw new Error(`适配器 ${adapterId} 缺字段: ${missing.join(', ')}`);
  return adapter;
}

module.exports = { resolveConfig, loadAdapter, loadPuppeteer, detectBrowserExe, argValue };
