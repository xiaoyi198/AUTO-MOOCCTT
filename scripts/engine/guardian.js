#!/usr/bin/env node
/**
 * guardian.js —— 学时值守引擎（平台无关）
 *
 * 语义：**每次运行完成一轮「检查 → 自愈 → 报告」，不常驻。**
 * 由外部定时器（自续期的一次性任务链 + 每小时兜底）周期调用，见 references/unattended-ops.md。
 *
 * 平台差异全部由 scripts/adapters/<id>.js 提供，本文件不出现任何具体平台的选择器。
 *
 * 输出契约（末行必为其中之一，调用方按此判断，不要去猜）：
 *   STATUS:PLAYING:<课程名> <当前>/<总长>s (<百分比>) 剩余<X分Y秒>
 *   STATUS:RESUMED:<说明>            曾暂停/卡住，已自救恢复
 *   STATUS:COURSE_DONE:<已完成课程>|下一门=<名称>|播放中=<bool>
 *   STATUS:NEXT_STARTED:<课程名>|播放中=<bool>
 *   STATUS:NEXT_SUBJECT:<新专题>|第一门=<名称>|播放中=<bool>|队列剩余=<n>
 *   STATUS:ALL_DONE:达标|<学时面板读数>   队列跑完**且实际学时已达标** —— 只有这时才停续期
 *   STATUS:TARGET_NOT_REACHED:<明细>     队列跑完但学时未达标（缺口/失败专题/兜底剩余）→ 需补专题或修脚本
 *   STATUS:BUSY:上一轮尚未结束，本轮跳过
 *   STATUS:NEED_HELP:<原因>          需要人工（登录态失效 / 弹窗关不掉 / 恢复播放失败 …）
 *   STATUS:ERROR:<原因>              脚本自身异常
 *
 * 退出码恒为 0（BUSY / NEED_HELP 也返回 0），调用方一律读 STATUS 行。
 * 每轮还会把观测快照写到 <运行时目录>/evidence/latest/status.json，供下一轮/模型诊断。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveConfig, loadAdapter } = require('./config');
const cdp = require('./cdp');

/* ================================================================== */
/* 启动准备                                                            */
/* ================================================================== */

const CFG = resolveConfig();
const AD = loadAdapter(CFG.adapterId);
const sleep = cdp.sleep;

/** 最近一次观测快照。finish() 会把它的可序列化部分连同 STATUS 一起落成证据包，
 *  供下一轮（很可能是被唤醒的模型）直接读取，不必翻整份日志。 */
const LAST = {};

const argOnce = process.argv.includes('--once');
void argOnce; // 当前实现每轮都是"跑一轮就退出"，该参数保留给调用方做语义标注

/**
 * --no-launch：连不上就只报错，绝不自己拉起浏览器。
 * 做只读排查、或在用户机器上试跑时**务必带上**——否则会自动开出一个新浏览器窗口，
 * 抢走前台焦点，可能把别的正在跑的挂机任务的学习页顶到后台导致播放中断。
 */
const NO_LAUNCH = process.argv.includes('--no-launch');

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CFG.logFile, line + '\n'); } catch { /* ignore */ }
}

/**
 * 输出 STATUS 行并退出。所有出口都走这里，保证契约不破。
 * 同时把「本轮快照」落成 evidence/latest/status.json，供模型/下一轮诊断直接读。
 */
function finish(statusLine, evidence) {
  console.log(statusLine);
  try { log('>>> ' + statusLine.slice(0, 400)); } catch { /* ignore */ }
  try {
    const dir = path.join(CFG.dir, 'evidence', 'latest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      at: new Date().toISOString(),
      statusLine,
      screenshot: CFG.shotFile,
      ...JSON.parse(JSON.stringify(LAST)),
      ...(evidence || {}),
    }, null, 2));
  } catch { /* 证据写不出来不致命 */ }
  process.exit(0);
}

/* ================================================================== */
/* 并发锁                                                             */
/* ================================================================== */
/* 链式任务与每小时兜底任务可能撞在同一分钟。引擎**不是并发安全的**：
   两个进程同时判定"本门播完"会各自把索引 +1，直接跳掉一门课。 */

const LOCK_STALE_MS = 4 * 60 * 1000;
let MY_LOCK = null;

/** 进程是否存活。Windows 上 process.kill(pid,0) 同样可用；EPERM 说明进程在但无权限。 */
function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

function tryAtomicLock() {
  MY_LOCK = `${process.pid} ${new Date().toISOString()}`;
  try {
    // 'wx'：文件不存在才创建，创建本身是原子的，两个进程只有一个能成功
    fs.writeFileSync(CFG.lockFile, MY_LOCK, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

function acquireLock() {
  // 先原子抢占：成功则一定是本轮持锁
  try {
    if (tryAtomicLock()) return true;
  } catch { return false; }

  // 已有锁：判断是「真并发」还是「残留 / 超时」
  try {
    const st = fs.statSync(CFG.lockFile);
    const ownerPid = parseInt(fs.readFileSync(CFG.lockFile, 'utf8').trim().split(/\s+/)[0], 10);
    const age = Date.now() - st.mtimeMs;
    if (age < LOCK_STALE_MS && pidAlive(ownerPid)) return false; // 持锁进程活着且未超时 → 本轮让路
    if (!pidAlive(ownerPid)) {
      log(`锁持有进程 ${ownerPid} 已不存在（上轮被强杀留下残留锁），立即接管，不必等满 4 分钟`);
    } else {
      log(`锁已超时（${Math.round(age / 1000)}s），强制接管`);
    }
    fs.unlinkSync(CFG.lockFile);
  } catch { return false; }

  // 清掉残留后重新原子抢占（可能与另一个进程再抢一次，仍只有一个能成功）
  try { return tryAtomicLock(); } catch { return false; }
}

process.on('exit', () => {
  // 只删「内容与本次写入完全一致」的锁，避免误删新进程刚写的锁
  try {
    if (MY_LOCK && fs.readFileSync(CFG.lockFile, 'utf8').trim() === MY_LOCK) fs.unlinkSync(CFG.lockFile);
  } catch { /* ignore */ }
});

/* ================================================================== */
/* 状态与队列持久化                                                     */
/* ================================================================== */

function loadState() {
  try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch {
    // 自修复：主文件写坏（断电、并发写）时从 .bak 恢复
    try {
      const bak = JSON.parse(fs.readFileSync(CFG.stateFile + '.bak', 'utf8'));
      log('learn-state.json 损坏，已从 .bak 自动恢复');
      return bak;
    } catch { return null; }
  }
}

function saveState(s) {
  const txt = JSON.stringify(s, null, 2);
  const tmp = CFG.stateFile + '.tmp';
  try {
    // 先写 .bak 再原子替换正式文件：任一时刻至少有一份完整可读
    fs.writeFileSync(CFG.stateFile + '.bak', txt);
    fs.writeFileSync(tmp, txt);
    fs.renameSync(tmp, CFG.stateFile);
  } catch (e) {
    // 不再静默吞掉：写不进去意味着状态会丢失，必须留痕
    log('!! 状态保存失败（磁盘/权限？）: ' + e.message);
  }
}

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(CFG.queueFile, 'utf8')); }
  catch { return { subjects: [], todoFallback: [], finished: [], failed: [] }; }
}

function saveQueue(q) {
  try { fs.writeFileSync(CFG.queueFile, JSON.stringify(q, null, 2)); } catch { /* ignore */ }
}

/* ================================================================== */
/* 页面基础操作（通用）                                                 */
/* ================================================================== */

/**
 * 反暂停注入：即使标签页被推到后台，也让页面认为自己始终可见。
 * ⚠️ 页面重载后会失效，**每一轮巡检都要重新注入**。
 */
async function keepAlive(page) {
  return page.evaluate(() => {
    try {
      Object.defineProperty(Document.prototype, 'hidden', { get() { return false; }, configurable: true });
      Object.defineProperty(Document.prototype, 'visibilityState', { get() { return 'visible'; }, configurable: true });
      if (!window.__apVA) {
        window.__apVA = true;
        // 平台若监听这两个事件来暂停，直接掐断传播
        document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
        window.addEventListener('blur', e => e.stopImmediatePropagation(), true);
      }
      window.__apLastAct = Date.now(); // 重置 idle 计时
      return true;
    } catch { return false; }
  }).catch(() => false);
}

/** 微小鼠标移动，制造"用户在场"信号。只移动不点击——点击会切换暂停状态。 */
async function jiggleMouse(page) {
  try {
    const vp = page.viewport() || { width: 1280, height: 800 };
    const x = Math.round(vp.width * (0.4 + Math.random() * 0.2));
    const y = Math.round(vp.height * (0.4 + Math.random() * 0.2));
    await page.mouse.move(x, y, { steps: 3 });
    await page.mouse.move(x + 2, y + 2, { steps: 2 });
  } catch { /* ignore */ }
}

async function readVideo(page) {
  const v = await page.evaluate(() => {
    const el = document.querySelector('video');
    if (!el) return null;
    let bufEnd = 0;
    try { if (el.buffered.length) bufEnd = +el.buffered.end(el.buffered.length - 1).toFixed(1); } catch { /* ignore */ }
    return {
      paused: el.paused,
      t: +el.currentTime.toFixed(1),
      d: Math.round(el.duration || 0),
      ended: el.ended,
      muted: el.muted,
      readyState: el.readyState,
      networkState: el.networkState,
      bufEnd,
    };
  }).catch(() => null);
  try { LAST.url = page.url(); LAST.video = v; } catch { /* ignore */ }
  return v;
}

/** 探测是否有可见弹窗（含"是否还在看"类确认框），返回其文本片段 */
async function detectModal(page, extraSelectors = []) {
  return page.evaluate((extra) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const sels = [
      '.el-dialog', '.el-message-box', '.layui-layer',
      '[class*=dialog]', '[class*=Dialog]', '[class*=modal]', '[class*=Modal]',
      '[class*=popup]', '[class*=Popup]', '[class*=mask]', '[class*=confirm]', '[class*=tip]',
      ...extra,
    ];
    const out = [];
    for (const sel of sels) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width > 120 && r.height > 50 && r.width < 1800 &&
            st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.1) {
          const t = clean(el.innerText);
          if (t) out.push(t.slice(0, 300));
        }
      }
    }
    const seen = new Set();
    const uniq = [];
    for (const t of out) {
      const k = t.slice(0, 50);
      if (!k || seen.has(k)) continue;
      seen.add(k); uniq.push(t);
    }
    return uniq.slice(0, 5);
  }, extraSelectors).catch(() => []);
}

/**
 * 在弹窗里找一个"确认/继续"语义的按钮并打标记（不点击，由调用方真点）。
 * ⚠️ 必须限制"可见 + 在视口内"，否则会点到隐藏的模板节点。
 */
async function markModalButton(page, words) {
  return page.evaluate((ws) => {
    const clean = s => (s || '').replace(/\s+/g, '').trim();
    const all = Array.from(document.querySelectorAll('a,button,div,span,input'));
    for (const w of ws) {
      const hit = all.filter(el => clean(el.innerText || el.textContent || el.value) === w)
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 8 && x.r.height > 8 &&
                     x.r.top >= 0 && x.r.left >= 0 &&
                     x.r.top < window.innerHeight && x.r.left < window.innerWidth)
        .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0];
      if (hit) { hit.el.setAttribute('data-ap-modal', '1'); return w; }
    }
    return null;
  }, words);
}

async function clickModalButton(page) {
  try {
    await page.click('[data-ap-modal="1"]', { delay: 40 });
  } catch {
    await page.evaluate(() => {
      const el = document.querySelector('[data-ap-modal="1"]');
      if (el) el.click();
    }).catch(() => {});
  } finally {
    await page.evaluate(() => {
      const el = document.querySelector('[data-ap-modal="1"]');
      if (el) el.removeAttribute('data-ap-modal');
    }).catch(() => {});
  }
}

/**
 * 恢复播放，四级兜底。返回是否已恢复播放。
 * 静音续播：长时间挂机不扰民。若平台因静音不计时，把 muted 关掉。
 */
async function resume(page, opts = {}) {
  const mute = opts.mute !== false;

  // 1) 直接 play()
  await page.evaluate((m) => {
    const v = document.querySelector('video');
    if (!v) return;
    if (m) v.muted = true;
    try { v.play(); } catch { /* ignore */ }
  }, mute).catch(() => {});
  await sleep(1800);
  let st = await readVideo(page);
  if (st && !st.paused) return true;

  // 2) 真实鼠标手势点视频区域（可绕开自动播放限制）
  const box = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }).catch(() => null);
  if (box) {
    await page.mouse.click(box.x, box.y).catch(() => {});
    await sleep(2200);
    st = await readVideo(page);
    if (st && !st.paused) return true;
  }

  // 3) 点疑似播放按钮（取面积最小者，避免点到整个播放器容器）
  const btn = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('[class*=play],[class*=Play],button[aria-label*=play]'));
    const p = cands.map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => x.r.width > 5 && x.r.height > 5)
      .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0];
    return p ? { x: Math.round(p.r.x + p.r.width / 2), y: Math.round(p.r.y + p.r.height / 2) } : null;
  }).catch(() => null);
  if (btn) {
    await page.mouse.click(btn.x, btn.y).catch(() => {});
    await sleep(2200);
    st = await readVideo(page);
    if (st && !st.paused) return true;
  }

  // 4) 末尾卡死 / 缓冲异常：微调进度后重播
  await page.evaluate((m) => {
    const v = document.querySelector('video');
    if (!v) return;
    try {
      if (v.duration && v.currentTime >= v.duration - 1.2) v.currentTime = Math.max(0, v.duration - 8);
      else v.currentTime = Math.max(0, v.currentTime - 0.8);
      if (m) v.muted = true;
      v.play();
    } catch { /* ignore */ }
  }, mute).catch(() => {});
  await sleep(2500);
  st = await readVideo(page);
  return !!(st && !st.paused);
}

/* ================================================================== */
/* 平台相关操作（全部经适配器）                                          */
/* ================================================================== */

/** 从专题页解析专题名称 */
async function readSubjectName(page) {
  const hint = AD.subjectNameHint ? new RegExp(AD.subjectNameHint) : null;
  return page.evaluate((hintSrc) => {
    const re = hintSrc ? new RegExp(hintSrc) : null;
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const cands = [];
    for (const el of document.querySelectorAll('h1,h2,h3,span,div,p')) {
      const t = clean(el.innerText);
      if (!t || t.length < 6 || t.length > 80) continue;
      if (re && !re.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 12 || r.top < 0 || r.top > 700) continue;
      cands.push({ t, area: r.width * r.height });
    }
    cands.sort((a, b) => a.area - b.area);
    return cands.length ? cands[0].t : '';
  }, hint ? hint.source : null).catch(() => '');
}

/**
 * 在专题页按课程名找到入口按钮 → 打标记 → **真实点击**。
 *
 * ⚠️ 两条血泪教训：
 *   1. 「打标记」不等于「点击」。早期版本只 setAttribute + scrollIntoView，UI 上表现为
 *      "报告成功找到目标但页面毫无反应"，且不报错，能潜伏很久才在关键节点爆掉。
 *   2. 匹配不到目标时**绝不 fallback 到第一个链接**——在"列表逐项处理"场景里会静默点到
 *      已完成的第一项，产生难以察觉的逻辑错误。宁可返回 null 报错。
 */
async function clickCourseByName(page, name, texts) {
  const cards = AD.cardSelectors || ['.item', 'li', 'tr'];
  const info = await page.evaluate(({ nm, ts, cards }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const norm = s => clean(s).replace(/[\s\u3000]/g, ''); // 归一化空白（含全角空格），SPA 渲染不可靠
    // 每次进入前先清掉上一轮的标记，否则重试会点到旧元素
    document.querySelectorAll('[data-ap-start]').forEach(el => el.removeAttribute('data-ap-start'));
    const links = Array.from(document.querySelectorAll('a,button,span,div'))
      .filter(el => ts.includes(clean(el.innerText)));
    let target = null;
    for (const a of links) {
      let card = a.parentElement;
      for (const sel of cards) {
        const c = a.closest(sel);
        if (c) { card = c; break; }
      }
      if (card && nm && norm(card.innerText).includes(norm(nm))) { target = a; break; }
    }
    if (!target) return null;
    target.setAttribute('data-ap-start', '1');
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    const card = target.closest(cards.join(',')) || target.parentElement;
    return clean(card ? card.innerText : target.innerText).slice(0, 80);
  }, { nm: name, ts: texts, cards });

  if (!info) return null;

  let clicked = false;
  try {
    await page.click('[data-ap-start="1"]', { delay: 40 }); // 真手势，走 CDP Input 域
    clicked = true;
  } catch {
    // 兜底：页面内派发原生 click（Vue/React 的 @click 能收到）
    clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-ap-start="1"]');
      if (!el) return false;
      el.click();
      return true;
    }).catch(() => false);
  }
  await page.evaluate(() => {
    const el = document.querySelector('[data-ap-start="1"]');
    if (el) el.removeAttribute('data-ap-start');
  }).catch(() => {});
  log(clicked ? `已点击课程入口: ${info.slice(0, 50)}` : `课程入口点击失败: ${info.slice(0, 50)}`);
  return info;
}

/** 扫描专题页课程列表 → [{ name, req }]，req 为 '必修' | '选修' | null */
async function scanCourses(page, texts) {
  const cards = AD.cardSelectors || ['.item', 'li', 'tr'];
  const markerSrc = (AD.requiredMarker || '\\[(必修|选修)\\]').toString();
  const entryTexts = AD.entryTexts || ['开始学习', '继续学习', '学习中', '已完成', '未开始'];
  return page.evaluate(({ ts, cards, markerSrc, entryTexts }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const marker = new RegExp(markerSrc);
    const links = Array.from(document.querySelectorAll('a,button,span,div'))
      .filter(el => ts.includes(clean(el.innerText)));
    const seen = new Set();
    const out = [];
    for (const a of links) {
      let card = a.parentElement;
      for (const sel of cards) {
        const c = a.closest(sel);
        if (c) { card = c; break; }
      }
      if (!card) continue;
      const txt = clean(card.innerText);
      const reqM = txt.match(marker);
      const req = reqM ? reqM[1] : null;
      let name = txt.replace(/^课程\s*/, '').replace(marker, '');
      for (const t of entryTexts) name = name.split(t).join('');
      name = clean(name);
      if (!name || name.length > 120) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, req });
    }
    return out;
  }, { ts: texts, cards, markerSrc, entryTexts }).catch(() => []);
}

/**
 * 只保留必修课。
 * 平台常把选修门槛设成"完成 0 学时以上"——即选修完全不用做。
 * 盲学全部会白耗大量时间（实测某专题必修 2 门 6.1 学时 / 选修 14 门 17.8 学时）。
 */
function requiredOnly(list) {
  if (AD.onlyRequired === false) return list;
  const req = list.filter(c => c.req !== '选修');
  return req.length ? req : list;
}

/**
 * 读学时面板。格式约定为「要求 / 已完成」，例如 网络自学 50 / 12.5、集中培训 90 / 30.0。
 * 这两个节点通常在全局页头里，**学习页/专题页都能读到，零打扰**：不用点头像、不开新页。
 */
async function readCredit(page) {
  if (!page) return null;
  const sel = AD.credit || {};
  const out = await page.evaluate(({ selfSel, centralSel }) => {
    const pick = s => {
      if (!s) return null;
      const e = document.querySelector(s);
      return e ? (e.innerText || '').replace(/\s+/g, ' ').trim() : null;
    };
    const parse = t => {
      const m = (t || '').match(/([\d.]+)\s*\/\s*([\d.]+)/);
      return m ? { target: +m[1], done: +m[2] } : null;
    };
    const self = parse(pick(selfSel));
    const central = parse(pick(centralSel));
    if (!self && !central) return null;
    const r = {};
    if (self) r.self = self;
    if (central) r.central = central;
    return r;
  }, { selfSel: sel.self, centralSel: sel.central }).catch(() => null);
  if (out) LAST.credit = out;
  return out;
}

/** 平台学分字段(self/central) → 排期目标 key。适配器可用 credit.keys 覆盖。 */
function creditKeys() {
  const k = (AD.credit && AD.credit.keys) || {};
  return { self: k.self || 'selfStudy', central: k.central || 'central' };
}

/** 展示用标签。适配器可用 credit.labels 覆盖。 */
function creditLabels() {
  const l = (AD.credit && AD.credit.labels) || {};
  return { self: l.self || '网络自学（时）', central: l.central || '集中培训（时）' };
}

/** 把 readCredit 的读数按「目标 key」聚起来（而不是写死 self/central） */
function creditByKey(c) {
  const keys = creditKeys();
  const out = {};
  if (c && c.self) out[keys.self] = c.self;
  if (c && c.central) out[keys.central] = c.central;
  return out;
}

function fmtCredit(c) {
  if (!c) return '(未读到学时面板)';
  const lb = creditLabels();
  const f = x => (x ? `${x.done} / ${x.target}` : '?');
  const gap = x => (x ? (x.target - x.done).toFixed(1) : '?');
  const parts = [];
  if (c.self) parts.push(`${lb.self} ${f(c.self)}（缺 ${gap(c.self)}）`);
  if (c.central) parts.push(`${lb.central} ${f(c.central)}（缺 ${gap(c.central)}）`);
  return parts.length ? parts.join(' | ') : '(未读到学时面板)';
}

/** 从 subject-queue.json 读目标；读不到就用适配器声明兜底。 */
function loadTargets() {
  const q = loadQueue();
  const t = q.creditTargets || {};
  if (Object.keys(t).length) return t;
  const keys = creditKeys();
  const lb = creditLabels();
  return {
    [keys.self]: { target: null, done: null, label: lb.self },
    [keys.central]: { target: null, done: null, label: lb.central },
  };
}

/**
 * 把「实际读数」与「目标」比对。这是 ALL_DONE 的**唯一**依据：
 * 队列空 ≠ 完成，只有实际学时达标才算完成。读数缺失一律视为未达标（宁可多跑一轮）。
 */
function targetReport(credit) {
  const targets = loadTargets();
  const byKey = creditByKey(credit);
  const rows = [];
  let allMet = true, anyUnknown = false;
  for (const key of Object.keys(targets)) {
    const t = targets[key] || {};
    const r = byKey[key];
    const target = (typeof t.target === 'number') ? t.target : null;
    if (!r || target == null) {
      anyUnknown = true; allMet = false;
      rows.push({ key, label: t.label || key, target, done: r ? r.done : null, met: false, known: false });
      continue;
    }
    const met = r.done >= target - 1e-9;
    if (!met) allMet = false;
    rows.push({ key, label: t.label || key, target, done: r.done, met, known: true });
  }
  const unmet = rows.filter(x => !x.met)
    .map(x => `${x.label}缺${x.known ? (x.target - x.done).toFixed(1) : '?'}`);
  const summary = rows.map(x => `${x.label}${x.known ? `${x.done}/${x.target}` : '?'}`).join(' | ');
  return { rows, allMet, anyUnknown, unmet, summary };
}

let lastCreditStr = null;
async function logCreditIfChanged(page) {
  const c = await readCredit(page);
  if (!c) return null;
  const s = fmtCredit(c);
  if (s !== lastCreditStr) {
    lastCreditStr = s;
    log(`【学时】${s}`);
    try {
      fs.appendFileSync(CFG.creditLog, JSON.stringify({
        at: new Date().toISOString(),
        selfDone: c.self ? c.self.done : null, selfTarget: c.self ? c.self.target : null,
        centralDone: c.central ? c.central.done : null, centralTarget: c.central ? c.central.target : null,
        text: s,
      }) + '\n');
    } catch { /* ignore */ }
  }
  return c;
}

/* ================================================================== */
/* 标签页选取                                                          */
/* ================================================================== */
/* 血泪教训：**绝不能「取第一个匹配」**。
   探索时留下的废弃 course/detail 页会被优先选中 → 读到没有 <video> 的页面 → 误报 NEED_HELP；
   更糟的是取错专题页时，点"开始学习"会点到别的专题去。必须用当前专题 id 精确匹配 + 打分。 */

function idFromUrl(url) {
  const re = AD.routing && AD.routing.subjectId;
  if (!re) return '';
  const m = (url || '').match(re);
  return m ? m[1] : '';
}

function pickSubjectPage(pages, state) {
  const want = idFromUrl(state && state.subjectUrl);
  if (want) {
    // 已经知道当前专题 id：只认它。找不到就返回 null，交给上层去新建/重建页面，
    // 绝不退回「第一个专题页」——那会点到别的专题，是本项目反复强调的血泪教训。
    return pages.find(p => idFromUrl(p.url()) === want) || null;
  }
  const re = (AD.routing && AD.routing.subject) || /subject\/detail/;
  return pages.find(p => re.test(p.url())) || null;
}

/**
 * 学习页打分：
 *   3 = URL 含当前专题 id 且是完整课程路径
 *   2 = URL 含当前专题 id
 *   1 = 页面里真的有 <video>
 *   0 = 其它同类页（几乎肯定是废弃页）
 * 同分取最后一个（通常是最新打开的）。
 */
async function pickStudyPage(pages, state) {
  const courseRe = (AD.routing && AD.routing.course) || /course\/detail/;
  const fullRe = AD.routing && AD.routing.fullCourse;
  const cands = pages.filter(p => courseRe.test(p.url()));
  if (!cands.length) return null;
  const want = idFromUrl(state && state.subjectUrl);
  const scored = [];
  for (const p of cands) {
    const u = p.url();
    let s;
    if (want && u.includes(want)) {
      s = fullRe && fullRe.test(u) ? 3 : 2;
    } else {
      const has = await p.evaluate(() => !!document.querySelector('video')).catch(() => false);
      s = has ? 1 : 0;
    }
    scored.push({ p, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0].s;
  const top = scored.filter(x => x.s === best).map(x => x.p);
  return top[top.length - 1];
}

/* ================================================================== */
/* 队列推进：切下一个专题                                                */
/* ================================================================== */

function subjectUrlOf(hash) {
  if (!hash) return AD.homeUrl || AD.baseUrl;
  if (/^https?:\/\//.test(hash)) return hash;
  return AD.baseUrl.replace(/\/$/, '') + '/' + hash.replace(/^\/?#?\/?/, '#/');
}

/**
 * 切到队列里的下一个专题。
 * @returns {Promise<{ok:true, state:object, first:string, playing:boolean, queueLeft:number}
 *                  | {ok:false, allDone?:boolean, reason?:string, name?:string}>}
 */
async function startNextSubject(browser, subjectPage, state) {
  const q = loadQueue();

  // 自修复：队列空了但学时还没达标 → 从兜底池按缺口类型补一个。
  // 缺口类型以队列自带的 settlement 为准（执行时的唯一真源），
  // 不再依赖适配器里可能漂移的 holdLastFills。
  if ((!q.subjects || !q.subjects.length) && (q.todoFallback || []).length) {
    const cred = await readCredit(subjectPage);
    const byKey = creditByKey(cred);
    const targets = loadTargets();
    const st = q.settlement || {};
    const keys = creditKeys();
    const holdKey = st.holdLastGoesTo || keys.self;
    const fullKey = st.fullGoesTo || keys.central;
    const needOf = k => {
      const t = targets[k];
      const r = byKey[k];
      return !!(t && typeof t.target === 'number' && (!r || r.done < t.target));
    };
    const needHold = needOf(holdKey);
    const needFull = needOf(fullKey);
    if (needHold || needFull) {
      const want = needHold ? 'holdLast' : 'full';
      let idx = q.todoFallback.findIndex(x => (x.mode || 'full') === want);
      if (idx < 0) idx = q.todoFallback.findIndex(x => (x.mode || 'full') !== want);
      if (idx < 0) idx = 0;
      const chosen = q.todoFallback.splice(idx, 1)[0];
      q.subjects = [chosen];
      saveQueue(q);
      log(`队列已空但学时未达标（${fmtCredit(cred)}），自动从兜底池补入: ${chosen.name}（模式 ${chosen.mode || 'full'}）`);
    }
  }

  if (!q.subjects || !q.subjects.length) return { ok: false, allDone: true };

  // 只看不 shift：解析成功前不记账，避免「记了完成却什么也没干」
  const next = q.subjects[0];
  log(`拟切专题: ${next.name}（模式 ${next.mode || 'full'}，来源 ${next.source || 'catalog'}）`);

  await subjectPage.goto(subjectUrlOf(next.hash), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(9000);

  let list = await scanCourses(subjectPage, AD.startTexts);
  if (!list.length) list = await scanCourses(subjectPage, AD.startTexts);
  let courses = requiredOnly(list);

  // 解析不到课程列表：跳过并记 failed（不改动 finished），链条继续
  if (!courses.length) {
    q.subjects.shift();
    q.failed = (q.failed || []).concat([{
      name: next.name, hash: next.hash, at: new Date().toISOString(), reason: 'empty-course-list',
    }]);
    saveQueue(q);
    log(`新专题解析不到课程列表，已跳过并入 failed: ${next.name}`);
    return { ok: false, reason: 'empty', name: next.name, queueLeft: q.subjects.length };
  }

  // 「留尾模式」：故意留最后一门课不看，让专题保持「未完成」态。
  // 只有一门课时**无法安全留尾**——不静默退化成 full，而是记 failed 交给人/模型处理。
  let heldBack = null;
  if (next.mode === 'holdLast') {
    if (courses.length > 1) {
      heldBack = courses[courses.length - 1].name;
      courses = courses.slice(0, -1);
      log(`【留尾模式】最后一节故意不学: ${heldBack}`);
    } else {
      q.subjects.shift();
      q.failed = (q.failed || []).concat([{
        name: next.name, hash: next.hash, at: new Date().toISOString(),
        reason: 'holdLast-impossible(仅1门课，无法留尾)',
      }]);
      saveQueue(q);
      log(`【留尾模式】专题仅 ${courses.length} 门必修，无法安全留尾，已记 failed 待处理: ${next.name}`);
      return { ok: false, reason: 'holdLast-impossible', name: next.name, queueLeft: q.subjects.length };
    }
  }

  // 到这里才认定「上一个专题真的收尾了」，记账
  q.subjects.shift();
  q.finished = (q.finished || []).concat([{
    name: state.subjectName || '(未命名专题)',
    url: state.subjectUrl || '',
    courses: (state.courses || []).length,
    finishedAt: new Date().toISOString(),
  }]);
  saveQueue(q);
  log(`本专题完成 → 切下一个专题: ${next.name}`);
  log(`【学时·切专题前】${fmtCredit(await readCredit(subjectPage))}`);

  const ns = {
    subjectUrl: subjectPage.url(),
    subjectName: next.name,
    mode: next.mode || 'full',
    heldBack,
    courses: courses.map(c => ({ name: c.name, req: c.req, done: false })),
    current: 0,
    history: (state.history || []).concat([{
      name: state.subjectName || '(未命名专题)', url: state.subjectUrl,
      finishedAt: new Date().toISOString(),
    }]),
    startedAt: new Date().toISOString(),
    checks: 0,
  };
  saveState(ns);
  LAST.subject = ns.subjectName;
  LAST.course = ns.courses[0] ? ns.courses[0].name : null;
  log(`新专题 ${next.name}: 共 ${ns.courses.length} 门`
    + `（${courses.filter(c => c.req === '必修').length} 必修 / ${courses.filter(c => c.req === '选修').length} 选修）`
    + (heldBack ? `，留空 1 门` : ''));

  await subjectPage.bringToFront().catch(() => {});
  await sleep(2000);
  const clicked = await clickCourseByName(subjectPage, ns.courses[0].name, AD.startTexts);
  await sleep(9000);
  const np = await pickStudyPage(await browser.pages(), ns);
  let playing = false;
  if (np) {
    await keepAlive(np);
    await resume(np);
    const nv = await readVideo(np);
    playing = !!(nv && !nv.paused);
    await np.screenshot({ path: CFG.shotFile }).catch(() => {});
  }
  log(`已进入新专题第一门: ${ns.courses[0].name} 点击=${clicked} 播放=${playing}`);
  return { ok: true, state: ns, first: ns.courses[0].name, playing, queueLeft: q.subjects.length };
}

/**
 * 收尾判定：只有**实际学时达标**才是 ALL_DONE。
 * 队列跑完但没达标 → TARGET_NOT_REACHED（并把缺口/失败/兜底剩余写进证据），
 * 让下一轮被唤醒的模型知道要补专题或修脚本，而不是误以为任务完成。
 */
async function conclude(browser, subjectPage, studyPage, note) {
  const c = (await readCredit(subjectPage)) || (await readCredit(studyPage));
  const rep = targetReport(c);
  const q = loadQueue();
  const failedCount = (q.failed || []).length;
  const fallbackLeft = (q.todoFallback || []).length;
  const evidence = {
    credit: c,
    targets: rep.rows,
    unmet: rep.unmet,
    failedSubjects: (q.failed || []).map(x => x.name),
    failedCount,
    fallbackLeft,
    note: note || null,
  };
  log(`【学时·收尾】${rep.summary}${failedCount ? ` | 失败专题 ${failedCount}` : ''}`
    + `${fallbackLeft ? ` | 兜底剩余 ${fallbackLeft}` : ''}`);

  try { await browser.disconnect(); } catch { /* ignore */ }

  if (rep.allMet) {
    finish(`STATUS:ALL_DONE:达标|${rep.summary}`, evidence);
  }
  const parts = [
    `未达标(${rep.summary})`,
    failedCount ? `失败专题${failedCount}个` : null,
    fallbackLeft ? `兜底剩余${fallbackLeft}` : null,
    rep.anyUnknown ? '部分学时读数未知' : null,
  ].filter(Boolean).join('，');
  finish(`STATUS:TARGET_NOT_REACHED:${parts}`, evidence);
}

/** 索引自校正：用户手动点课会让 state.current 错位。用页面正文反查课程名，唯一命中时校正。 */
async function syncCurrentByTitle(page, state) {
  try {
    const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
    const matches = state.courses
      .map((c, i) => ({ i, n: c.name }))
      .filter(x => x.n && txt.includes(x.n));
    if (matches.length === 1 && matches[0].i !== state.current) {
      log(`索引校正: ${state.current} -> ${matches[0].i} (${matches[0].n})`);
      state.current = matches[0].i;
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 检测是否被带到登录页 → 这类**无法自愈**（没有账号密码），必须明确告知人工 */
async function looksLoggedOut(browser) {
  const re = AD.loginHint || /oauth|login/i;
  const pages = await browser.pages();
  return pages.some(p => re.test(p.url()));
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

(async () => {
  if (!acquireLock()) finish('STATUS:BUSY:上一次巡检仍在进行，本轮跳过');

  let browser;
  try {
    browser = await cdp.connect(CFG.cdpUrl);
  } catch (e) {
    // 自修复：连不上就自己拉起来（浏览器崩了 / 被关 / 更新后重启）
    log('无法连接浏览器: ' + e.message);
    if (NO_LAUNCH) {
      finish(`STATUS:NEED_HELP:无法连接受管浏览器（--no-launch 已禁自动拉起）`
        + ` —— 端口 ${CFG.cdpPort}。请先启动它：node scripts/engine/launch.js`);
    }
    log('尝试自动拉起受管浏览器…');
    const r = await cdp.launchAndWait(CFG);
    if (r.ok) {
      try { browser = await cdp.connect(CFG.cdpUrl); } catch { /* 见下 */ }
    }
    if (!browser) {
      finish('STATUS:NEED_HELP:无法连接浏览器（已尝试自动拉起仍失败）'
        + ` —— 端口 ${CFG.cdpPort}${r.error ? '，' + r.error : ''}`
        + '。可手动启动受管浏览器后重试，见 references/unattended-ops.md');
    }
    log(`自动拉起受管浏览器成功（${r.version}，等待 ${r.waitedMs}ms）`);
  }

  let pages = await browser.pages();
  let state = loadState();
  let subjectPage = pickSubjectPage(pages, state);
  let studyPage = await pickStudyPage(pages, state);

  // ---------- 首次初始化 ----------
  if (!state) {
    if (!subjectPage) {
      subjectPage = await browser.newPage();
      await subjectPage.goto(subjectUrlOf(null), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(6000);
    }
    const list = requiredOnly(await scanCourses(subjectPage, AD.startTexts));
    if (!list.length) {
      const loggedOut = await looksLoggedOut(browser);
      await subjectPage.screenshot({ path: CFG.shotFile }).catch(() => {});
      finish('STATUS:NEED_HELP:专题页解析不到课程列表 —— '
        + (loggedOut ? '页面被带到登录页，登录态已失效，需人工登录后重跑'
                     : '可能未登录或页面未加载完成'));
    }
    state = {
      subjectUrl: subjectPage.url(),
      subjectName: await readSubjectName(subjectPage),
      courses: list.map(c => ({ name: c.name, req: c.req, done: false })),
      current: 0,
      history: [],
      startedAt: new Date().toISOString(),
      checks: 0,
    };
    saveState(state);
    log(`初始化 state，共 ${list.length} 门：${list.map(c => c.name).join(' / ')}`);
  }
  if (!state.subjectName && subjectPage) state.subjectName = await readSubjectName(subjectPage);

  // 用最新 state 重新精确选页（避免被探索时留下的标签带偏）
  pages = await browser.pages();
  subjectPage = pickSubjectPage(pages, state) || subjectPage;
  studyPage = await pickStudyPage(pages, state);

  state.checks = (state.checks || 0) + 1;
  state.lastCheck = new Date().toISOString();
  if (!state.subjectUrl && subjectPage) state.subjectUrl = subjectPage.url();

  const remaining = state.courses.filter(c => !c.done);

  // ---------- 确保专题页存在 ----------
  if (!subjectPage) {
    subjectPage = await browser.newPage();
    await subjectPage.goto(state.subjectUrl || subjectUrlOf(null), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(5000);
  }

  // ---------- 本专题已全部学完 → 接下一个专题 ----------
  if (!remaining.length) {
    // 留尾护栏：先把视频冻住，防止切专题前平台自动往下播到留空的那门
    if (state.heldBack && studyPage) {
      const did = await studyPage.evaluate(() => {
        const v = document.querySelector('video');
        if (v && !v.paused) { v.pause(); return true; }
        return false;
      }).catch(() => false);
      log(`【留尾护栏】已暂停${did ? '' : '（本就未在播）'}，确保留空的《${state.heldBack}》不被播放`);
    }

    saveState(state);
    const r = await startNextSubject(browser, subjectPage, state);
    if (r.ok) {
      await browser.disconnect();
      finish(`STATUS:NEXT_SUBJECT:${r.state.subjectName}|第一门=${r.first}|播放中=${r.playing}|队列剩余=${r.queueLeft}`);
    }
    await conclude(browser, subjectPage, studyPage, r.reason ? `切专题未成功(${r.reason})` : null);
  }

  // ---------- 情况 A：在学习页 ----------
  if (studyPage) {
    // A0) 防 Edge「睡眠标签页」把后台学习页挂起（会直接跳错误页、视频中断）
    //     ⚠️ 不能只因"失焦"就抢焦点：用户在用别的窗口时必然失焦，每轮都抢会持续打断他。
    //     必须「失焦」且「视频确实异常」两个条件同时成立才拉回前台。
    const pre = await studyPage.evaluate(() => {
      const v = document.querySelector('video');
      return { focused: document.hasFocus(), hasVideo: !!v, paused: v ? v.paused : true };
    }).catch(() => ({ focused: true, hasVideo: true, paused: false }));
    if (!pre.focused && (!pre.hasVideo || pre.paused)) {
      log(`学习页失焦且视频异常(hasVideo=${pre.hasVideo} paused=${pre.paused})，拉回前台`);
      await studyPage.bringToFront().catch(() => {});
      await sleep(1200);
    }
    await keepAlive(studyPage);

    // A0.5) 留尾护栏：平台若自动跳进我们故意留空的那门课，立刻冻住。
    //       判据要"页面出现留空课程名，且当前所有待学课程名一个都不出现"，避免误伤正常课程。
    if (state.heldBack && remaining.length) {
      const onHeld = await studyPage.evaluate((hb, names) => {
        const t = (document.body.innerText || '').replace(/\s+/g, ' ');
        if (!t.includes(hb)) return false;
        return !names.some(n => n && t.includes(n));
      }, state.heldBack, remaining.map(c => c.name)).catch(() => false);
      if (onHeld) {
        const did = await studyPage.evaluate(() => {
          const v = document.querySelector('video');
          if (v && !v.paused) { v.pause(); return true; }
          return false;
        }).catch(() => false);
        log(`【留尾护栏】平台自动进入了留空课程《${state.heldBack}》，已暂停${did ? '' : '（本就未在播）'}`);
      }
    }

    // A1) 弹窗处理（含"是否还在看"）
    const modals = await detectModal(studyPage, AD.modalSelectors);
    if (modals.length) {
      const joined = modals.join(' | ');
      log('检测到弹窗: ' + joined.slice(0, 200));
      let closed = null;
      for (let i = 0; i < 3 && !closed; i++) {
        const word = await markModalButton(studyPage, AD.confirmWords);
        if (!word) break;
        await clickModalButton(studyPage);
        closed = word;
        log('已点击弹窗按钮: ' + word);
        await sleep(2500);
      }
      if (!closed) {
        const still = await detectModal(studyPage, AD.modalSelectors);
        if (still.length) {
          await studyPage.screenshot({ path: CFG.shotFile }).catch(() => {});
          saveState(state);
          await browser.disconnect();
          finish('STATUS:NEED_HELP:学习页出现弹窗且无法自动关闭 → ' + joined.slice(0, 150));
        }
      }
    }

    // A2) 索引校正
    await syncCurrentByTitle(studyPage, state);

    let v = await readVideo(studyPage);

    // A3) 学习页没有 video：通常是标签页被挂起后 SPA 跳到了错误页，或被换成了别的内容。
    //     处理：用专题页重新点一次当前课程入口，最多 2 轮。
    if (!v) {
      const diag = await studyPage.evaluate(
        () => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)
      ).catch(() => '');
      log(`学习页无视频元素（URL=${studyPage.url().slice(0, 120)}），尝试自动恢复: ${diag.slice(0, 120)}`);

      let recovered = false;
      for (let attempt = 1; attempt <= 2 && !recovered; attempt++) {
        await subjectPage.bringToFront().catch(() => {});
        await subjectPage.goto(state.subjectUrl || subjectUrlOf(null), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(8000);
        const cur2 = state.courses[state.current];
        if (cur2) await clickCourseByName(subjectPage, cur2.name, AD.startTexts);
        await sleep(7000);
        const np = await pickStudyPage(await browser.pages(), state);
        if (np) {
          await keepAlive(np);
          const nv = await readVideo(np);
          if (nv) {
            studyPage = np; v = nv; recovered = true;
            log(`自动恢复成功（第 ${attempt} 轮）：${nv.t}/${nv.d}s paused=${nv.paused}`);
          }
        }
      }

      if (!recovered) {
        await studyPage.screenshot({ path: CFG.shotFile }).catch(() => {});
        saveState(state);
        const loggedOut = await looksLoggedOut(browser);
        await browser.disconnect();
        finish('STATUS:NEED_HELP:学习页无视频元素且自动恢复失败 —— '
          + (loggedOut ? '登录态已失效，需人工重新登录' : '页面可能被挂起或平台异常')
          + ' | ' + diag.slice(0, 150));
      }
    }

    const ratio = v.d > 0 ? v.t / v.d : 0;

    // A4) 课程完成判定
    if (v.ended || ratio >= 0.995) {
      const cur = state.courses[state.current];
      if (cur) { cur.done = true; cur.doneAt = new Date().toISOString(); }
      state.current += 1;
      state.lastT = 0;
      saveState(state);
      log(`课程完成: ${cur ? cur.name : '?'} (${Math.round(ratio * 100)}%)`);

      await studyPage.close().catch(() => {});
      await sleep(1500);

      if (state.current >= state.courses.length) {
        saveState(state);
        const r = await startNextSubject(browser, subjectPage, state);
        if (r.ok) {
          await browser.disconnect();
          finish(`STATUS:NEXT_SUBJECT:${r.state.subjectName}|第一门=${r.first}|播放中=${r.playing}|队列剩余=${r.queueLeft}`);
        }
        await conclude(browser, subjectPage, studyPage, r.reason ? `切专题未成功(${r.reason})` : null);
      }

      // 进入下一门：点击最多重试 3 次，每次等新标签页出现
      const next = state.courses[state.current];
      await subjectPage.bringToFront().catch(() => {});
      await sleep(1500);
      let np = null;
      for (let attempt = 1; attempt <= 3 && !np; attempt++) {
        await clickCourseByName(subjectPage, next.name, AD.startTexts).catch(() => null);
        await sleep(attempt === 1 ? 7000 : 9000);
        np = await pickStudyPage(await browser.pages(), state);
        if (!np) log(`第 ${attempt} 次尝试打开《${next.name}》未成功，继续重试`);
      }

      if (np) {
        await keepAlive(np);
        await resume(np);
        const nv = await readVideo(np);
        await np.screenshot({ path: CFG.shotFile }).catch(() => {});
        saveState(state);
        await browser.disconnect();
        finish(`STATUS:COURSE_DONE:${cur ? cur.name : ''}|下一门=${next.name}|播放中=${!!(nv && !nv.paused)}`);
      }
      saveState(state);
      await browser.disconnect();
      finish('STATUS:NEED_HELP:切换下一门失败，未打开课程页 | 目标=' + next.name);
    }

    // A5) 卡住判定：未暂停但进度不前进（缓冲 / 被限流），比"暂停"更隐蔽
    const now = Date.now();
    const stalled = !v.paused && state.lastT != null && state.lastTAt &&
      Math.abs(v.t - state.lastT) < 1.5 && (now - state.lastTAt) > 60000;
    const stuckLoading = !v.paused && v.readyState < 2 && (now - (state.lastTAt || now)) > 60000;

    // A6) 暂停 / 卡住 → 恢复
    if (v.paused || stalled || stuckLoading) {
      const reason = v.paused ? '暂停' : (stalled ? '进度停滞' : '加载停滞');
      log(`检测到${reason}，尝试恢复 (${v.t}/${v.d}s readyState=${v.readyState} net=${v.networkState})`);
      // 卡住往往就是被挂到后台了——此时抢焦点是必要的，先拉回前台再恢复
      await studyPage.bringToFront().catch(() => {});
      await sleep(800);
      await keepAlive(studyPage);
      await jiggleMouse(studyPage);
      const ok = await resume(studyPage);
      const nv = await readVideo(studyPage);
      await studyPage.screenshot({ path: CFG.shotFile }).catch(() => {});
      state.lastT = nv ? nv.t : v.t;
      state.lastTAt = Date.now();
      saveState(state);
      if (ok) {
        log(`恢复播放 ${nv.t}/${nv.d}`);
        await browser.disconnect();
        finish(`STATUS:RESUMED:已恢复播放 (${nv.t}/${nv.d}s)`);
      }
      // 再等一轮缓冲，仍不动才求助
      await sleep(8000);
      const nv2 = await readVideo(studyPage);
      if (nv2 && !nv2.paused && Math.abs(nv2.t - nv.t) > 0.5) {
        state.lastT = nv2.t;
        state.lastTAt = Date.now();
        saveState(state);
        log(`延迟恢复 ${nv2.t}/${nv2.d}s`);
        await browser.disconnect();
        finish(`STATUS:RESUMED:延迟后恢复播放 (${nv2.t}/${nv2.d}s)`);
      }
      await browser.disconnect();
      finish('STATUS:NEED_HELP:视频暂停/卡住且多次尝试恢复失败');
    }

    // A7) 正常播放
    await jiggleMouse(studyPage);
    await studyPage.screenshot({ path: CFG.shotFile }).catch(() => {});
    state.lastT = v.t;
    state.lastTAt = now;
    saveState(state);

    const leftSec = Math.max(0, v.d - v.t);
    const leftTxt = v.d ? `${Math.floor(leftSec / 60)}分${Math.round(leftSec % 60)}秒` : '未知';
    await logCreditIfChanged(studyPage);
    const curName = state.courses[state.current] ? state.courses[state.current].name : '';
    log(`播放中 ${v.t}/${v.d}s 剩余${leftTxt}`);
    await browser.disconnect();
    finish(`STATUS:PLAYING:${curName} ${v.t}/${v.d}s (${Math.round(ratio * 100)}%) 剩余${leftTxt}`);
  }

  // ---------- 情况 B：在专题页 → 启动当前课程 ----------
  await subjectPage.bringToFront().catch(() => {});
  await sleep(1500);

  const cur = state.courses[state.current];
  const clicked = await clickCourseByName(subjectPage, cur.name, AD.startTexts);
  if (!clicked) {
    saveState(state);
    await browser.disconnect();
    finish('STATUS:NEED_HELP:专题页找不到课程入口按钮 | 目标=' + cur.name);
  }
  log(`点击课程入口: ${clicked}`);

  let np = null;
  for (let attempt = 1; attempt <= 3 && !np; attempt++) {
    if (attempt > 1) await clickCourseByName(subjectPage, cur.name, AD.startTexts).catch(() => null);
    await sleep(attempt === 1 ? 8000 : 9000);
    np = await pickStudyPage(await browser.pages(), state);
    if (!np) log(`第 ${attempt} 次尝试打开《${cur.name}》未成功，继续重试`);
  }

  if (np) {
    await keepAlive(np);
    await resume(np);
    const nv = await readVideo(np);
    state.lastT = nv ? nv.t : 0;
    state.lastTAt = Date.now();
    await np.screenshot({ path: CFG.shotFile }).catch(() => {});
    saveState(state);
    log(`已启动课程: ${cur.name} 播放=${!!(nv && !nv.paused)}`);
    await browser.disconnect();
    finish(`STATUS:NEXT_STARTED:${cur.name}|播放中=${!!(nv && !nv.paused)}`);
  }
  saveState(state);
  await browser.disconnect();
  finish('STATUS:NEED_HELP:点击课程入口后未打开课程页 | 目标=' + cur.name);
})().catch(e => {
  try { log('ERROR ' + (e && e.stack ? e.stack : e)); } catch { /* ignore */ }
  console.log('STATUS:ERROR:' + (e && e.message ? e.message : String(e)));
  process.exit(0);
});
