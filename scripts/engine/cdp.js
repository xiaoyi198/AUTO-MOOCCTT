/**
 * cdp.js —— 连接 / 探测 / 拉起受管浏览器
 *
 * 三个关键约束（都是实测踩出来的，改之前先看 references/unattended-ops.md）：
 *
 * 1. 启动浏览器必须用「脱离进程树」的方式：child_process.spawn(detached:true) + unref()。
 *    用 Start-Process / WMI / schtasks 会被安全策略拦截，或在本轮工具调用结束后被连带回收。
 * 2. 访问 CDP 端口前要清掉代理变量。若环境里挂着 HTTP_PROXY，本地 127.0.0.1 也会被当外网走代理，
 *    表现为 "upstream connect failed"，极易误判成"端口没开"。所有出网探测都走 rawRequest 绕过。
 * 3. 用户当前开着的浏览器**接管不了**。Chrome/Edge 136+ 起，--remote-debugging-port 只有在
 *    同时指定非默认 --user-data-dir 时才生效。所以要另开独立 profile（可复用登录态：见下）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadPuppeteer } = require('./config');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 不带代理的 HTTP 探测。用 node:http 直连 127.0.0.1，不读 *_proxy 环境变量。
 * @returns {Promise<object|null>} /json/version 的 JSON，不可达则 null
 */
function rawVersion(cdpUrl) {
  return new Promise(resolve => {
    let http;
    try { http = require('node:http'); } catch { return resolve(null); }
    const u = new URL(cdpUrl + '/json/version');
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'GET',
      timeout: 3000,
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** 探测端口是否可用，返回浏览器版本号字符串或 null */
async function probe(cdpUrl) {
  const v = await rawVersion(cdpUrl);
  return v && v.Browser ? v.Browser : null;
}

/** 连接受管浏览器。注意收尾用 disconnect()，绝不用 close()——close 会关掉用户的窗口。 */
async function connect(cdpUrl) {
  const puppeteer = loadPuppeteer();
  return puppeteer.connect({
    browserURL: cdpUrl,
    defaultViewport: null, // 跟随真实窗口尺寸
  });
}

/**
 * 以脱离进程树的方式拉起受管浏览器（自修复用）。
 * 返回 true 只代表"已发起启动"，不代表端口已就绪——调用方必须轮询 probe() 确认。
 *
 * @param {object} cfg  resolveConfig() 的结果
 * @param {object} [opts]
 * @param {number} [opts.port]      覆盖端口（做验证实验时用独立端口，不打扰正在跑的任务）
 * @param {string} [opts.profileDir] 覆盖 profile 目录
 * @param {string} [opts.startUrl]
 */
function launchDetached(cfg, opts = {}) {
  const port = opts.port || cfg.cdpPort;
  const profileDir = opts.profileDir || cfg.profileDir;
  const startUrl = opts.startUrl || 'about:blank';
  if (!cfg.browserExe) {
    throw new Error('未找到浏览器可执行文件。请设置 AUTOPILOT_BROWSER_EXE，或确认已安装 Edge/Chrome。');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    // 关掉睡眠标签页：后台的学习页被挂起会让视频中断，并让 SPA 跳到错误页
    '--disable-features=SleepingTabs,CalculateNativeWinOcclusion',
    startUrl,
  ];
  const { spawn } = require('child_process');
  const p = spawn(cfg.browserExe, args, { detached: true, stdio: 'ignore' });
  p.unref();
  return p.pid;
}

/**
 * 拉起并轮询直到端口就绪。
 * @returns {Promise<{ok:boolean, pid?:number, version?:string, waitedMs:number, error?:string}>}
 */
async function launchAndWait(cfg, opts = {}) {
  const tries = opts.tries || 8;
  const stepMs = opts.stepMs || 4000;
  const started = Date.now();
  let pid = null;
  try {
    pid = launchDetached(cfg, opts);
  } catch (e) {
    return { ok: false, error: e.message, waitedMs: 0 };
  }
  for (let i = 0; i < tries; i++) {
    await sleep(stepMs);
    const v = await probe(opts.cdpUrl || cfg.cdpUrl);
    if (v) return { ok: true, pid, version: v, waitedMs: Date.now() - started };
  }
  return { ok: false, pid, waitedMs: Date.now() - started, error: `拉起后 ${tries * stepMs / 1000}s 内端口未就绪` };
}

/** 复制某份已有 profile 到新目录，从而继承登录态（约几百 MB，只需做一次） */
function cloneProfile(fromDir, toDir) {
  try {
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.cpSync(fromDir, toDir, { recursive: true, errorOnExist: false, force: false });
    return { ok: true, toDir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { probe, rawVersion, connect, launchDetached, launchAndWait, cloneProfile, sleep };
