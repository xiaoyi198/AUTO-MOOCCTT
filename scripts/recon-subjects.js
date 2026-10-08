#!/usr/bin/env node
/**
 * recon-subjects.js —— 专题库 / 专题详情**只读侦察**（示例脚本，按需改写）
 *
 * 【它是什么】
 *   写适配器、重排期之前，用它在真实页面上把「专题目录结构」和「专题详情字段」问清楚：
 *     node scripts/recon-subjects.js catalog [--pages N]     扫专题目录分页
 *     node scripts/recon-subjects.js subject <URL> [<URL> …] 读若干专题详情页
 *   结果写 <运行时目录>/recon-catalog-<时间戳>.json 或 recon-subject-<时间戳>.json，并打印摘要。
 *
 * 【为什么需要它（踩过的坑）】
 *   · **侦察最容易把正在播的视频弄停**。受管浏览器里新开/切换标签会抢走前台，学习页被挂起后
 *     SPA 可能直接跳到错误页、视频中断。所以本脚本立了两条纪律：
 *       (a) 一律用**新开的临时标签页**做侦察，**绝不导航正在播放的学习页**，用完 page.close()
 *           并把学习页 bringToFront() 还焦点；
 *       (b) 开头/结尾各打印一次学习页的视频 currentTime 自证没打断（停了要如实报出来）。
 *   · **URL 只从命令行参数取**：脚本里不硬编码任何真实专题名或 UUID。catalog 模式的入口地址
 *     优先用 --url，其次用适配器声明的 homeUrl/baseUrl 并尝试点顶部导航，避免"猜 hash 猜出白屏"。
 *   · 平台改版会让选择器失效 —— 下面的 SELECTORS 是**醒目的常量区**，
 *     **平台改版后请用 probe.js 复核**（node scripts/probe.js cards / nav / modals）。
 *
 * 【用法】
 *   node scripts/recon-subjects.js catalog [--pages 5] [--url <专题目录页 URL>]
 *   node scripts/recon-subjects.js subject <URL> [<URL> …]
 *   通用参数：--dir <运行时目录> --adapter <id> --port <端口> --browser <exe> --timeout <秒>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { resolveConfig, loadAdapter, argValue } = require('./engine/config');
const cdp = require('./engine/cdp');

/* ================================================================== */
/* 选择器常量区 —— 平台改版后请用 probe.js 复核                          */
/* ================================================================== */
/* 约定：需要跨进页面执行的，一律用**字符串**（RegExp 传不进 page.evaluate，
   要在页面里 new RegExp）。以下取值是"常见形态 + 已适配平台的实测形态"的并集，
   新平台请以 probe.js 的实际输出为准，删掉用不上的、补上缺的。 */

const SELECTORS = {
  /** 课程 / 专题卡片的容器候选（按顺序取第一个能 closest 到的） */
  card: ['.item', 'li', 'tr', '[class*=card]', '[class*=course]', '[class*=subject]'],
  /** 卡片标题候选（先看 title 属性，再看文本） */
  cardTitle: ['.title', '[class*=title]', 'h3', 'h4', 'a'],
  /** 入口按钮文本（与适配器 startTexts 语义一致） */
  entryTexts: ['开始学习', '继续学习', '去学习', '立即报名', '报名'],
  /** 完成状态文本 */
  statusTexts: ['已完成', '已学完', '学习中', '继续学习', '未开始', '未学习'],
  /** 必修 / 选修标记：捕获组 1 就是修别 */
  requiredMarkerSrc: '\\[(必修|选修)\\]|（(必修|选修)）|(必修|选修)课',
  /** 学时文本，如「学时：25.4」「共 10.5 学时」「6.1 课时」 */
  hoursSrc: '(?:学时|课时)\\s*[:：]?\\s*([\\d.]+)|([\\d.]+)\\s*(?:学时|课时|小时)',
  /** 专题名特征词（用于从一堆可见元素里挑出专题名） */
  nameHint: '专题',
  /** 详情页里的「类型 / 标签」候选容器 */
  tagSelectors: ['.tag', '.label', '.type', '[class*=tag]', '[class*=label]', '[class*=type]'],
  /** 顶部导航里指向专题目录的项 */
  catalogNavTexts: ['专题', '专题列表', '课程专题', '学习专题'],
  /** 分页「下一页」控件：可选择器，也可按文本 */
  pagerNextSelectors: [
    '.pagination .item[data-dir="next"]',
    '.pagination .next',
    '[class*=pagination] [class*=next]',
    'a[aria-label*=next i]',
    'button[aria-label*=next i]',
  ],
  pagerNextTexts: ['下一页', '下页', '>', '»', '›'],
};

const ARGV = process.argv.slice(2);
const CFG = resolveConfig();
const MODE = ARGV[0];
const TIMEOUT_MS = Math.max(5, parseInt(argValue(ARGV, '--timeout') || '45', 10) || 45) * 1000;
const MAX_PAGES = Math.max(1, Math.min(50, parseInt(argValue(ARGV, '--pages') || '1', 10) || 1));
const START_URL = argValue(ARGV, '--url') || '';

const sleep = cdp.sleep;
const say = (...a) => console.log(...a);

/** 带值的选项：解析位置参数时要跳过它们，否则 `--timeout 30 <url>` 里的 "30" 会被当成 URL */
const OPTS_WITH_VALUE = new Set([
  '--dir', '--adapter', '--port', '--browser', '--skill', '--timeout', '--pages', '--url',
]);

function positionalArgs() {
  const out = [];
  for (let i = 1; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function adapterOrNull() {
  try { return loadAdapter(CFG.adapterId); } catch (e) {
    say(`[warn] 适配器 ${CFG.adapterId} 加载失败（${e.message.split('\n')[0]}），将退回通用默认值`);
    return null;
  }
}

/** 给 promise 加超时：页面级命令挂死时不能把侦察脚本一起挂住 */
function withTimeout(promise, ms, label) {
  const pr = Promise.resolve(promise);
  pr.catch(() => { /* 超时后底层失败不再冒泡 */ });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    pr.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function writeJson(file, data) {
  fs.mkdirSync(CFG.dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** 学习页视频快照：用于自证「侦察没打断播放」 */
async function videoSnapshot(page) {
  if (!page) return null;
  try {
    return await withTimeout(page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { paused: v.paused, t: +v.currentTime.toFixed(1), d: Math.round(v.duration || 0) };
    }), TIMEOUT_MS, 'video 快照');
  } catch { return null; }
}

/** 找正在播放的学习页：按适配器 routing.course 精确匹配，绝不"取第一个" */
function pickStudyPage(pages, ad) {
  const re = (ad && ad.routing && ad.routing.course) || /course\/detail/;
  const cands = pages.filter(p => { try { return re.test(p.url()); } catch { return false; } });
  return cands.length ? cands[cands.length - 1] : null;
}

/* ================================================================== */
/* 页面内取数函数（在浏览器里执行，参数必须是可序列化的字符串/数组）        */
/* ================================================================== */

/** 读专题目录页的卡片列表 */
function extractCards(SEL) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const marker = new RegExp(SEL.requiredMarkerSrc);
  const hoursRe = new RegExp(SEL.hoursSrc);
  const out = [];
  const seen = new Set();
  const linkNodes = Array.from(document.querySelectorAll('a,button,span,div'))
    .filter(el => !el.querySelector('a,button,span,div') && SEL.entryTexts.includes(clean(el.innerText)));

  for (const a of linkNodes) {
    let card = a.parentElement;
    for (const sel of SEL.card) {
      const c = a.closest(sel);
      if (c) { card = c; break; }
    }
    if (!card) continue;
    const text = clean(card.innerText);
    if (!text || text.length < 4 || seen.has(text)) continue;
    seen.add(text);

    let name = '';
    for (const tsel of SEL.cardTitle) {
      const el = card.querySelector(tsel);
      if (!el) continue;
      const t = clean(el.getAttribute && el.getAttribute('title')) || clean(el.innerText);
      if (t && t.length <= 120) { name = t; break; }
    }
    if (!name) name = text.slice(0, 80);

    const hm = text.match(hoursRe);
    const mm = text.match(marker);
    const href = (card.querySelector('a[href]') || {}).href || '';
    out.push({
      name,
      hours: hm ? +((hm[1] || hm[2])) : null,
      required: mm ? (mm[1] || mm[2] || mm[3] || null) : null,
      status: SEL.statusTexts.find(s => text.includes(s)) || null,
      entry: SEL.entryTexts.find(s => clean(a.innerText) === s) || null,
      href: href || null,
      cardText: text.slice(0, 160),
    });
  }
  return out;
}

/** 读专题详情页的字段 */
function extractSubject(SEL) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const body = clean(document.body.innerText);
  const marker = new RegExp(SEL.requiredMarkerSrc);
  const hoursRe = new RegExp(SEL.hoursSrc, 'g');

  // 专题名：命中特征词、可见、面积最小的元素（避免命中整个容器）
  let name = '';
  if (SEL.nameHint) {
    const cands = [];
    for (const el of Array.from(document.querySelectorAll('h1,h2,h3,span,div,p,a'))) {
      if (el.querySelector('h1,h2,h3,span,div,p,a')) continue; // 只要叶子节点
      const t = clean(el.innerText);
      if (!t || t.length < 4 || t.length > 80 || !t.includes(SEL.nameHint)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10 || r.top < 0 || r.top > 900) continue;
      cands.push({ t, area: r.width * r.height });
    }
    cands.sort((a, b) => a.area - b.area);
    if (cands.length) name = cands[0].t;
  }

  // 学时：优先「学时：25.4」这类带标签的写法，其次「25.4 学时」
  const hoursList = [];
  let m;
  while ((m = hoursRe.exec(body)) !== null) {
    const v = +(m[1] || m[2]);
    if (Number.isFinite(v)) hoursList.push(v);
  }

  // 入口按钮 / 完成状态（只数叶子节点，避免父容器重复计数）
  const leafTexts = [];
  for (const el of Array.from(document.querySelectorAll('a,button,span,div'))) {
    if (el.querySelector('a,button,span,div')) continue;
    const t = clean(el.innerText);
    if (t) leafTexts.push(t);
  }
  const countOf = words => {
    const c = {};
    for (const w of words) {
      const n = leafTexts.filter(t => t === w).length;
      if (n) c[w] = n;
    }
    return c;
  };

  // 课程卡片：带入口按钮的卡片容器
  const courses = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a,button,span,div'))) {
    if (a.querySelector('a,button,span,div')) continue;
    const at = clean(a.innerText);
    if (!SEL.entryTexts.includes(at)) continue;
    let card = a.parentElement;
    for (const sel of SEL.card) {
      const c = a.closest(sel);
      if (c) { card = c; break; }
    }
    if (!card) continue;
    const text = clean(card.innerText);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const mm = text.match(marker);
    courses.push({
      cardText: text.slice(0, 160),
      required: mm ? (mm[1] || mm[2] || mm[3] || null) : null,
      entry: at,
      status: SEL.statusTexts.find(s => text.includes(s)) || null,
    });
  }

  const tags = [];
  for (const sel of SEL.tagSelectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (el.querySelector(sel)) continue;
      const t = clean(el.innerText);
      if (t && t.length <= 30 && !tags.includes(t)) tags.push(t);
      if (tags.length > 12) break;
    }
  }

  return {
    url: location.href,
    name,
    declaredHours: hoursList.length ? hoursList[0] : null,
    hoursAll: hoursList.slice(0, 8),
    type: (body.match(/专题类型\s*[:：]\s*([^\s，,。；;]+)/) || [])[1] || null,
    tags: tags.slice(0, 12),
    entryButtons: countOf(SEL.entryTexts),
    statusCounts: countOf(SEL.statusTexts),
    requiredCourses: courses.filter(c => c.required === '必修').length,
    optionalCourses: courses.filter(c => c.required === '选修').length,
    courseCards: courses.slice(0, 60),
    ratios: (body.match(/\d+\s*\/\s*\d+/g) || []).slice(0, 6),
    head: body.slice(0, 500),
  };
}

/** 点分页「下一页」，点到了返回 true */
function clickNextPage(SEL) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  for (const sel of SEL.pagerNextSelectors) {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }
  }
  const nodes = Array.from(document.querySelectorAll('a,button,span,li,div'))
    .filter(el => !el.querySelector('a,button,span,li,div') && SEL.pagerNextTexts.includes(clean(el.innerText)));
  if (nodes.length) { nodes[0].click(); return true; }
  return false;
}

/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

(async () => {
  const wantsHelp = ARGV.includes('--help') || ARGV.includes('-h');
  if (!MODE || wantsHelp) {
    say('用法:');
    say('  node scripts/recon-subjects.js catalog [--pages N] [--url <专题目录页 URL>]');
    say('  node scripts/recon-subjects.js subject <URL> [<URL> …]');
    say('通用: --dir <运行时目录> --adapter <id> --port <端口> --browser <exe> --timeout <秒>');
    say('');
    say('纪律: 只用新开的临时标签页侦察，绝不导航正在播放的学习页；用完关闭并把学习页拉回前台。');
    say('平台改版后请用 probe.js 复核脚本顶部的 SELECTORS 常量区。');
    process.exit(wantsHelp ? 0 : 1);
  }
  if (MODE !== 'catalog' && MODE !== 'subject') {
    say(`未知子命令: ${MODE}（可用: catalog | subject）`);
    process.exit(1);
  }

  const ad = adapterOrNull();
  const urls = positionalArgs();
  if (MODE === 'subject' && !urls.length) {
    say('用法: node scripts/recon-subjects.js subject <URL> [<URL> …]   （URL 由命令行给，脚本不内置任何专题）');
    process.exit(1);
  }

  /* ---------- 连接（连不上就清晰地退出，不抛栈） ---------- */
  if (!(await cdp.probe(CFG.cdpUrl))) {
    say(`[连不上] ${CFG.cdpUrl} 无响应 —— 受管浏览器没有在跑。`);
    say('  先启动它（示例）：node scripts/engine/launch.js');
    say('  若确认开着却探不到，检查 http_proxy / https_proxy 是否把 127.0.0.1 也代理了。');
    process.exit(1);
  }
  let browser;
  try { browser = await cdp.connect(CFG.cdpUrl); }
  catch (e) { say(`[连不上] CDP 连接失败：${e.message}`); process.exit(1); }

  const pages0 = await browser.pages();
  const studyPage = pickStudyPage(pages0, ad);
  const before = await videoSnapshot(studyPage);
  say(`[纪律] 侦察用临时标签页；学习页 = ${studyPage ? studyPage.url().slice(0, 100) : '(未找到)'}`);
  if (before) say(`[纪律] 侦察前学习页视频：t=${before.t}s/${before.d}s paused=${before.paused}`);

  // 临时标签页：只用它做导航与读取
  const tab = await browser.newPage();
  const report = {
    at: new Date().toISOString(),
    mode: MODE,
    adapter: CFG.adapterId,
    note: '示例侦察脚本的输出；选择器见脚本顶部 SELECTORS，平台改版后请用 probe.js 复核。',
  };

  try {
    if (MODE === 'catalog') {
      let start = START_URL || (ad && (ad.homeUrl || ad.baseUrl)) || '';
      if (!start) { say('catalog 模式需要入口地址：用 --url <专题目录页 URL>，或在适配器里声明 homeUrl/baseUrl'); process.exit(1); }
      say(`[catalog] 入口 ${start}`);
      await withTimeout(tab.goto(start, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }), TIMEOUT_MS + 5000, 'goto').catch(e => say('  goto 失败: ' + e.message));
      await sleep(6000);

      // 没给 --url 时，尝试点顶部导航进专题目录（绝不猜 hash —— 猜的 hash 会白屏）
      if (!START_URL && ad && ad.routes && ad.routes.subjectList) {
        const clicked = await withTimeout(tab.evaluate((SEL) => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          const nodes = Array.from(document.querySelectorAll('nav a,header a,nav li,header li,[class*=nav] a,[class*=menu] a'))
            .filter(el => SEL.catalogNavTexts.includes(clean(el.innerText)));
          if (!nodes.length) return false;
          nodes[0].click();
          return true;
        }, SELECTORS), TIMEOUT_MS, '点导航').catch(() => false);
        if (clicked) { say('  已点顶部导航进入专题目录'); await sleep(8000); }
        else say('  未找到专题导航入口（可直接用 --url 指定专题目录页）');
      }
      report.startUrl = tab.url();

      const all = new Map();
      let lastFirst = null;
      const pageSummaries = [];
      for (let p = 1; p <= MAX_PAGES; p++) {
        const cards = await withTimeout(tab.evaluate(extractCards, SELECTORS), TIMEOUT_MS, `第 ${p} 页读取`)
          .catch(e => { say(`  第 ${p} 页读取失败: ${e.message}`); return []; });
        for (const c of cards) all.set(c.href || (c.name + '|' + c.hours), c);
        say(`=== 第 ${p} 页：${cards.length} 张卡片（累计唯一 ${all.size}）`);
        for (const c of cards.slice(0, 12)) {
          say(`  · ${c.name} | 学时=${c.hours == null ? '?' : c.hours} | 修别=${c.required || '?'} | 状态=${c.status || '?'} | 入口=${c.entry || '?'}`);
        }
        if (cards.length > 12) say(`  … 其余 ${cards.length - 12} 张见 JSON`);
        pageSummaries.push({ page: p, count: cards.length, cards });

        const first = cards.length ? (cards[0].href || cards[0].name) : null;
        if (p > 1 && first && first === lastFirst) { say('  页内容未变化（分页没生效），停止翻页'); break; }
        lastFirst = first;
        if (p === MAX_PAGES) break;
        const clicked = await withTimeout(tab.evaluate(clickNextPage, SELECTORS), TIMEOUT_MS, '翻页').catch(() => false);
        if (!clicked) { say('  没有更多分页控件，停止翻页'); break; }
        await sleep(5000);
      }
      report.pages = pageSummaries;
      report.subjects = Array.from(all.values());
      say(`[catalog] 合计 ${report.subjects.length} 个专题`);
    }

    if (MODE === 'subject') {
      report.subjects = [];
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        say(`=== 侦察 ${i + 1}/${urls.length}: ${u}`);
        await withTimeout(tab.goto(u, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS }), TIMEOUT_MS + 5000, 'goto')
          .catch(e => say('  goto 失败: ' + e.message));
        await sleep(8000);
        const r = await withTimeout(tab.evaluate(extractSubject, SELECTORS), TIMEOUT_MS, '详情读取')
          .catch(e => ({ url: u, error: e.message }));
        if (ad && ad.loginHint && ad.loginHint.test(tab.url())) {
          r.needLogin = true;
          say('  !! 页面被带到登录页：登录态已失效，需人工登录后重跑（这类无法自愈）');
        }
        report.subjects.push(r);
        const c = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}×${v}`).join(' ') || '(无)';
        say(`  名称      : ${r.name || '(未识别)'}`);
        say(`  类型/标签 : ${r.type || '?'} ${(r.tags || []).length ? '| ' + r.tags.join(' / ') : ''}`);
        say(`  声明学时  : ${r.declaredHours == null ? '?' : r.declaredHours}${(r.hoursAll || []).length > 1 ? `（页面全部学时读数: ${r.hoursAll.join(', ')}）` : ''}`);
        say(`  必修/选修 : ${r.requiredCourses} / ${r.optionalCourses}（按卡片上的修别标记统计）`);
        say(`  入口按钮  : ${c(r.entryButtons)}`);
        say(`  完成状态  : ${c(r.statusCounts)}`);
        say(`  进度比率  : ${(r.ratios || []).join(', ') || '(无)'}`);
        if (r.error) say(`  !! 读取失败: ${r.error}`);
      }
    }
  } finally {
    // 纪律：关闭临时标签页，并把学习页拉回前台还焦点
    try { await tab.close(); } catch { /* ignore */ }
    if (studyPage) { try { await studyPage.bringToFront(); } catch { /* ignore */ } }
    const after = await videoSnapshot(studyPage);
    if (before) say(`[纪律] 侦察后学习页视频：t=${after ? after.t : '?'}s paused=${after ? after.paused : '?'}`);
    if (before && after && before.paused === false && after.paused === true) {
      say('[纪律] ⚠️ 侦察过程中学习页视频被暂停了：本轮可能被判为异常。');
      say('        侦察会短暂抢焦点，这是已知代价；重跑一轮巡检（guardian.js）即可恢复播放。');
    }
    report.videoBefore = before;
    report.videoAfter = after;
    try { browser.disconnect(); } catch { /* ignore */ }  // 绝不用 close()
  }

  const file = path.join(CFG.dir, `recon-${MODE}-${stamp()}.json`);
  writeJson(file, report);
  say(`[完成] 结果已写入 ${file}`);
  process.exit(0);
})().catch(e => {
  console.error('[recon 出错] ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
