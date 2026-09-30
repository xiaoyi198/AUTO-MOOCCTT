#!/usr/bin/env node
/**
 * probe.js —— 平台侦察工具（写新适配器时用）
 *
 * 用途：在**不写代码、不猜**的前提下，把目标平台的结构问清楚，然后照着写适配器。
 * 全部为只读操作（shot 会截图，click 会真的点——但只点你指定的文本）。
 *
 * ⚠️ 侦察纪律（踩过坑）：
 *   在受管浏览器里做探索会抢走前台，导致后台的学习页被挂起、视频中断。
 *   所以：能只读 DOM 就只读；必须开新标签时，用完立刻 page.close() 并把学习页 bringToFront() 还焦点。
 *
 * 用法：
 *   node probe.js tabs                     列出所有标签页
 *   node probe.js video                    报告每个标签页有没有 <video> 及其状态
 *   node probe.js credit                   探测学时面板候选节点
 *   node probe.js cards                    探测课程卡片/入口按钮的容器结构
 *   node probe.js modals                   探测弹窗容器类名
 *   node probe.js nav                      探测导航项与链接
 *   node probe.js click "<文本>" [--exact]  点击「可见且在视口内、面积最小」的该文本节点
 *   node probe.js shot <名称>               截图到运行时目录
 *   node probe.js eval "<js>"               在第一个非 about:blank 页面执行只读表达式
 *
 * 通用参数：--dir <运行时目录> --port <端口> --tab <序号>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveConfig, loadAdapter } = require('./engine/config');
const cdp = require('./engine/cdp');

const CFG = resolveConfig();
const argv = process.argv.slice(2);
const cmd = argv[0];
const tabIdx = (() => { const i = argv.indexOf('--tab'); return i >= 0 ? parseInt(argv[i + 1], 10) : 0; })();

function out(o) { console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2)); }

async function pickTab(browser) {
  const pages = await browser.pages();
  const real = pages.filter(p => !/^about:blank$/.test(p.url()));
  const list = real.length ? real : pages;
  return { page: list[tabIdx] || list[0] || null, pages };
}

(async () => {
  let browser;
  try {
    browser = await cdp.connect(CFG.cdpUrl);
  } catch (e) {
    console.error(`连不上受管浏览器（${CFG.cdpUrl}）：${e.message}`);
    console.error('先启动它：node scripts/engine/launch.js   （或让 guardian 自己拉起来）');
    process.exit(1);
  }

  try {
    if (cmd === 'tabs') {
      const pages = await browser.pages();
      out(pages.map((p, i) => ({
        idx: i, url: p.url(),
        hasVideo: undefined, // 见 video 子命令
      })));
      await browser.disconnect();
      return;
    }

    const { page, pages } = await pickTab(browser);
    if (!page) { console.error('没有可用标签页'); await browser.disconnect(); process.exit(1); }

    if (cmd === 'video') {
      const rows = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const v = await p.evaluate(() => {
          const el = document.querySelector('video');
          if (!el) return null;
          return { paused: el.paused, t: +el.currentTime.toFixed(1), d: Math.round(el.duration || 0) };
        }).catch(() => null);
        rows.push({ idx: i, url: p.url().slice(0, 110), video: v });
      }
      out(rows);
      await browser.disconnect();
      return;
    }

    if (cmd === 'credit') {
      const ad = (() => { try { return loadAdapter(CFG.adapterId); } catch { return null; } })();
      const r = await page.evaluate((cur) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const res = { adapterConfigured: null, hits: [] };
        if (cur && cur.self) {
          const e = document.querySelector(cur.self);
          const c = document.querySelector(cur.central);
          res.adapterConfigured = { self: e ? clean(e.innerText) : null, central: c ? clean(c.innerText) : null };
        }
        // 兜底：全页扫描「数字 / 数字」形态且带常见字样的小节点
        const all = Array.from(document.querySelectorAll('.credit-label,.hour-label,[class*=credit],[class*=hour],[class*=Credit],[class*=Hour]'));
        for (const el of all) {
          const t = clean(el.innerText);
          if (!t || t.length > 60) continue;
          if (!/[\d.]+\s*\/\s*[\d.]+/.test(t) && !/学时|时）|\(时\)/.test(t)) continue;
          const r2 = el.getBoundingClientRect();
          res.hits.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className && String(el.className).slice(0, 80),
            text: t,
            rect: { w: Math.round(r2.width), h: Math.round(r2.height), top: Math.round(r2.top) },
          });
        }
        return res;
      }, ad).catch(e => ({ error: e.message }));
      out(r);
      await browser.disconnect();
      return;
    }

    if (cmd === 'cards') {
      const r = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const entryTexts = ['开始学习', '继续学习'];
        const links = Array.from(document.querySelectorAll('a,button,span,div'))
          .filter(el => entryTexts.includes(clean(el.innerText)));
        const seen = new Set();
        const rows = [];
        for (const a of links.slice(0, 40)) {
          const chain = [];
          let el = a;
          for (let depth = 0; depth < 5 && el; depth++) {
            chain.push({
              tag: el.tagName.toLowerCase(),
              cls: el.className && String(el.className).slice(0, 70),
            });
            el = el.parentElement;
          }
          const card = a.parentElement;
          const txt = clean(card ? card.innerText : '').slice(0, 120);
          if (seen.has(txt)) continue;
          seen.add(txt);
          rows.push({ entry: clean(a.innerText), ancestors: chain, cardText: txt });
        }
        return { count: links.length, rows: rows.slice(0, 8) };
      }).catch(e => ({ error: e.message }));
      out(r);
      await browser.disconnect();
      return;
    }

    if (cmd === 'modals') {
      const r = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const sels = ['.el-dialog', '.el-message-box', '.layui-layer', '[class*=dialog]',
          '[class*=modal]', '[class*=popup]', '[class*=mask]', '[class*=confirm]', '[class*=tip]'];
        const hits = [];
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            const r2 = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            const visible = r2.width > 120 && r2.height > 50 && st.display !== 'none'
              && st.visibility !== 'hidden' && Number(st.opacity) > 0.1;
            hits.push({
              sel, cls: String(el.className).slice(0, 80),
              rect: { w: Math.round(r2.width), h: Math.round(r2.height) },
              visible, text: clean(el.innerText).slice(0, 100),
            });
          }
        }
        return { hits: hits.slice(0, 20) };
      }).catch(e => ({ error: e.message }));
      out(r);
      await browser.disconnect();
      return;
    }

    if (cmd === 'nav') {
      const r = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const navs = Array.from(document.querySelectorAll('nav,header,[class*=nav],[class*=Nav],[class*=menu],[class*=Menu]'));
        const items = [];
        for (const n of navs) {
          for (const el of Array.from(n.querySelectorAll('a,li,span,div'))) {
            const t = clean(el.innerText);
            if (!t || t.length > 20 || el.children.length > 0) continue;
            const r2 = el.getBoundingClientRect();
            if (r2.width < 8 || r2.height < 8) continue;
            items.push({ text: t, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50) });
          }
        }
        const seen = new Set();
        return items.filter(i => { const k = i.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
      }).catch(e => ({ error: e.message }));
      out(r);
      await browser.disconnect();
      return;
    }

    if (cmd === 'click') {
      const target = argv[1];
      if (!target) { console.error('用法: node probe.js click "<文本>" [--exact]'); await browser.disconnect(); process.exit(1); }
      const exact = argv.includes('--exact');
      // 「登录」这类叶子节点：不能用 innerText 匹配父容器（会命中整个 header，rect 为 0,0）。
      // 正确做法：筛出文本匹配**且无子元素**的节点，按面积升序取最小者，再用坐标真实点击。
      const hit = await page.evaluate(({ t, exact }) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const all = Array.from(document.querySelectorAll('a,button,span,div,li'));
        const cands = all.filter(el => {
          const txt = clean(el.innerText);
          const okText = exact ? txt === t : txt.includes(t);
          if (!okText) return false;
          if (el.querySelector('a,button,span,div,li,p') && !exact) return false; // 偏向叶子节点
          return true;
        }).map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(x => x.r.width > 6 && x.r.height > 6 &&
                       x.r.top >= 0 && x.r.left >= 0 &&
                       x.r.top < window.innerHeight && x.r.left < window.innerWidth)
          .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
        if (!cands.length) return null;
        const c = cands[0];
        c.el.setAttribute('data-ap-probe', '1');
        return { text: clean(c.el.innerText), tag: c.el.tagName.toLowerCase(),
          cls: String(c.el.className).slice(0, 60),
          x: Math.round(c.r.x + c.r.width / 2), y: Math.round(c.r.y + c.r.height / 2) };
      }, { t: target, exact }).catch(() => null);
      if (!hit) { out('未找到可点击节点: ' + target); await browser.disconnect(); return; }
      out({ willClick: hit });
      await page.mouse.click(hit.x, hit.y); // 真实手势，走 CDP Input 域
      await new Promise(r => setTimeout(r, 4000));
      out('已点击。当前 URL: ' + page.url());
      await browser.disconnect();
      return;
    }

    if (cmd === 'shot') {
      const name = argv[1] || 'probe';
      const file = path.join(CFG.dir, name + '.png');
      fs.mkdirSync(CFG.dir, { recursive: true });
      await page.screenshot({ path: file, fullPage: argv.includes('--full') });
      out('已截图: ' + file);
      await browser.disconnect();
      return;
    }

    if (cmd === 'eval') {
      const js = argv[1];
      if (!js) { console.error('用法: node probe.js eval "<js 表达式>"'); await browser.disconnect(); process.exit(1); }
      const r = await page.evaluate(new Function('return (' + js + ')')).catch(e => ({ error: e.message }));
      out(r);
      await browser.disconnect();
      return;
    }

    console.error('未知子命令: ' + cmd);
    console.error('可用: tabs | video | credit | cards | modals | nav | click | shot | eval');
    await browser.disconnect();
    process.exit(1);
  } catch (e) {
    console.error('probe 出错: ' + e.message);
    try { await browser.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  }
})();
