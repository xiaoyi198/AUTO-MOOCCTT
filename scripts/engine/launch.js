#!/usr/bin/env node
/**
 * launch.js —— 启动/检查受管浏览器
 *
 * 用法：
 *   node launch.js              启动（已在线则只报告）并等待端口就绪
 *   node launch.js --status     只探测，不启动
 *   node launch.js --kill       关闭受管浏览器（按 profile 目录精确匹配进程，不误伤日常浏览器）
 *   node launch.js --experiment 用独立端口 + 独立 profile 起一个做实验（不打扰正在跑的任务）
 *
 * 为什么需要这个文件：`--remote-debugging-port` 必须配 `--user-data-dir` 指向非默认目录才生效，
 * 所以**无法接管用户当前开着的浏览器**。要自动化就必须另起一个独立实例。
 * 想继承登录态：先把日常 profile 复制一份到本目录（见 cloneProfile），或在新实例里手工登录一次。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('./config');
const cdp = require('./cdp');

const CFG = resolveConfig();
const argv = process.argv.slice(2);

(async () => {
  if (argv.includes('--status')) {
    const v = await cdp.probe(CFG.cdpUrl);
    console.log(v ? `[在线] ${CFG.cdpUrl} -> ${v}` : `[离线] ${CFG.cdpUrl} 无响应`);
    process.exit(v ? 0 : 1);
  }

  if (argv.includes('--experiment')) {
    const port = 9333;
    const profileDir = path.join(CFG.dir, 'browser-profile-experiment');
    console.log(`实验模式：端口 ${port}，profile ${profileDir}`);
    const r = await cdp.launchAndWait({ ...CFG, browserExe: CFG.browserExe }, {
      port, profileDir, cdpUrl: `http://127.0.0.1:${port}`,
    });
    console.log(r.ok ? `[就绪] ${r.version}，等待 ${r.waitedMs}ms（pid=${r.pid}）` : `[失败] ${r.error}`);
    console.log('实验完记得关掉它，避免长期占资源。');
    process.exit(r.ok ? 0 : 1);
  }

  if (argv.includes('--kill')) {
    // 只杀「命令行里带本目录 profile 路径」的进程，绝不误伤用户日常浏览器
    let killed = 0;
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        const needle = CFG.profileDir.replace(/\\/g, '\\\\');
        const ps = `Get-CimInstance Win32_Process -Filter "Name like '%msedge%' or Name like '%chrome%'" `
          + `| Where-Object { $_.CommandLine -like '*${CFG.profileDir}*' } `
          + `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
        const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
        killed = out.trim().split(/\s+/).filter(Boolean).length;
        void needle;
      } else {
        const out = execSync(`pgrep -f ${JSON.stringify(CFG.profileDir)} || true`, { encoding: 'utf8' });
        for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
          try { process.kill(+pid, 'SIGTERM'); killed++; } catch { /* ignore */ }
        }
      }
    } catch (e) {
      console.log('[warn] 关闭时出错（可能本来就没在跑）: ' + e.message);
    }
    console.log(`已关闭 ${killed} 个受管浏览器进程（profile=${CFG.profileDir}）`);
    process.exit(0);
  }

  const v0 = await cdp.probe(CFG.cdpUrl);
  if (v0) {
    console.log(`[已在线] ${CFG.cdpUrl} -> ${v0}，无需重复启动`);
    process.exit(0);
  }
  if (!CFG.browserExe) {
    console.error('未找到浏览器可执行文件。设置 AUTOPILOT_BROWSER_EXE 指向 msedge/chrome 再试。');
    process.exit(1);
  }
  console.log(`启动受管浏览器：${CFG.browserExe}`);
  console.log(`  profile : ${CFG.profileDir}`);
  console.log(`  端口    : ${CFG.cdpPort}`);
  const r = await cdp.launchAndWait(CFG);
  if (r.ok) {
    console.log(`[就绪] ${r.version}，等待 ${r.waitedMs}ms（pid=${r.pid}）`);
    console.log('首次使用请在该窗口里手工完成一次登录，之后登录态会留在这个独立 profile 里。');
  } else {
    console.error(`[失败] ${r.error || '未知'}`);
    process.exit(1);
  }
})().catch(e => { console.error('launch.js 出错: ' + e.message); process.exit(1); });

void fs;
