#!/usr/bin/env node
/**
 * plan.js —— 学时任务排期器
 *
 * 职责：把「学时目标 + 专题清单」算成「一份可执行的队列 + 排期理由」。
 * 纯计算：不连浏览器、不发网络请求、不改线上状态。可反复重跑，结果确定。
 *
 * 用法：
 *   node plan.js --in plan-input.json --out ./run
 *   node plan.js --demo                    # 用内置样例跑一遍，看输出长什么样
 *   node plan.js --in x.json --json        # 只把 plan.json 打到 stdout
 *
 * 产出（--out 目录下）：
 *   plan.md              人类可读的规划书（给用户看）
 *   plan.json            机器可读分配结果（含每个专题入选/落选的理由）
 *   subject-queue.json   直接喂给 engine/guardian.js 的队列
 *   credit-baseline.json 基线快照，供收尾验收比对
 *
 * 输入格式见 references/planning-rules.md；样例见 assets/plan-input.example.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ */
/* 默认参数                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  // 一门课的实际播放时长 ≈ 声明学时 × 该系数（分钟）。实测区间 40~55。
  minutesPerCreditHour: 50,
  // 未实测过视频时长的专题，用这个「学时/小时」比值估效率（越大越划算）
  defaultCreditsPerVideoHour: 1.0,
  // 留尾模式的贡献口径：
  //   'whole'         —— 整专题学时全部计入（对应假设 H2，默认）
  //   'completedOnly' —— 只计已看完那几门的学时（对应假设 H1）
  holdLastContribution: 'whole',
  // 巡检间隔（分钟）。引擎靠「自续期的一次性任务链」实现，见 references/unattended-ops.md
  checkIntervalMinutes: 15,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const num = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round1 = v => Math.round(v * 10) / 10;

function fail(msg) {
  console.error('plan.js 错误: ' + msg);
  process.exit(2);
}

/**
 * 归一化一条专题记录，补齐派生字段。
 * eligibleHours 与 actualVideoHours 都只算「必须要学的课」（必修；选修门槛为 0 学时时应剔除）。
 */
function normalizeSubject(raw) {
  const hours = num(raw.hours, 0);
  const eligibleHours = num(raw.eligibleHours, hours) ?? hours;
  const actualVideoHours = num(raw.actualVideoHours, null);
  const requiredCourses = num(raw.requiredCourses, null);
  const preference = raw.preference || 'auto';
  if (!raw.name) fail('专题缺少 name 字段');
  if (!['auto', 'full', 'holdLast', 'skip'].includes(preference)) {
    fail(`专题「${raw.name}」的 preference 非法: ${preference}`);
  }
  return {
    ...raw,
    hours,
    eligibleHours,
    actualVideoHours,
    requiredCourses,
    preference,
    // 性价比：每看 1 小时视频能换到多少学时
    efficiency: actualVideoHours && actualVideoHours > 0
      ? round1((eligibleHours / actualVideoHours) * 100) / 100
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* 核心：把目标 + 清单算成队列                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} input
 * @param {Array<{key:string,label:string,target:number,done:number}>} input.targets
 * @param {{fullGoesTo:string, holdLastGoesTo:string, holdLastContribution?:string}} input.settlement
 * @param {Array<object>} input.catalog   可用的未完成专题
 * @param {Array<object>} [input.fallback] 兜底池（主清单不够时启用）
 * @param {object} [input.options]
 * @returns {object} plan
 */
function buildPlan(input) {
  const opt = { ...DEFAULTS, ...(input.options || {}) };
  const settlement = input.settlement || {};
  const fullGoesTo = settlement.fullGoesTo || 'central';
  const holdLastGoesTo = settlement.holdLastGoesTo || 'selfStudy';
  const holdLastContribution = settlement.holdLastContribution || opt.holdLastContribution;

  if (fullGoesTo === holdLastGoesTo) {
    fail('settlement.fullGoesTo 与 holdLastGoesTo 相同：两种模式归到同一口径，留尾就失去意义了');
  }
  const targets = (input.targets || []).map(t => ({
    key: t.key,
    label: t.label || t.key,
    target: num(t.target, 0) ?? 0,
    done: num(t.done, 0) ?? 0,
    gap: Math.max(0, round1((num(t.target, 0) ?? 0) - (num(t.done, 0) ?? 0))),
  }));
  if (!targets.length) fail('targets 为空');

  const catalog = (input.catalog || []).map(normalizeSubject);
  const fallback = (input.fallback || []).map(normalizeSubject);
  if (!catalog.length && !fallback.length) fail('专题清单为空');

  // 目标是哪个口径 -> 需要该口径的专题用哪种模式
  const modeForTarget = {};
  modeForTarget[fullGoesTo] = 'full';
  modeForTarget[holdLastGoesTo] = 'holdLast';
  // 目标口径与两种模式都不匹配 -> 无法用本算法满足，明确报出来
  const unmappedTargets = targets.filter(t => !modeForTarget[t.key] && t.gap > 0);

  // 一条专题以某模式计入时，实际贡献多少学时
  const contribute = (s, mode) => {
    if (mode === 'holdLast' && holdLastContribution === 'completedOnly' && s.requiredCourses > 0) {
      // 只算看完的那几门：均摊后扣掉最后一门
      return round1(s.eligibleHours * (s.requiredCourses - 1) / s.requiredCourses);
    }
    return s.eligibleHours;
  };

  const used = new Set();
  const assignments = [];
  const remainingGap = {};
  targets.forEach(t => { remainingGap[t.key] = t.gap; });

  // 先满足缺口大的目标；同缺口时按「网络自学」优先（留尾专题通常体量更大，先定下来更稳）
  const orderedTargets = targets
    .filter(t => t.gap > 0 && modeForTarget[t.key])
    .sort((a, b) => b.gap - a.gap);

  // 候选筛选：未用、偏好兼容、且确定性归属该模式
  const candidatesFor = (list, src, mode) => list
    .filter(s => !used.has(s.name))
    .filter(s => s.preference !== 'skip')
    .filter(s => (s.preference === 'auto' ? mode : s.preference) === mode)
    .map(s => ({ s, src }))
    // 性价比高的优先；未知性价比排最后；同档取体量大的（少切专题、少失败点）
    .sort((a, b) => {
      const ea = a.s.efficiency == null ? -1 : a.s.efficiency;
      const eb = b.s.efficiency == null ? -1 : b.s.efficiency;
      if (eb !== ea) return eb - ea;
      return b.s.eligibleHours - a.s.eligibleHours;
    });

  for (const t of orderedTargets) {
    const mode = modeForTarget[t.key];
    let need = remainingGap[t.key];

    // 两趟：先把「主清单」吃干净，只有还缺才动用「兜底池」。
    // 兜底池是留给主清单用尽后的储备，不能被体量大的条目插队抢占。
    for (const src of ['catalog', 'fallback']) {
      if (need <= 0) break;
      const list = src === 'catalog' ? catalog : fallback;
      for (const { s } of candidatesFor(list, src, mode)) {
        if (need <= 0) break;
        const gain = contribute(s, mode);
        if (gain <= 0) continue;    // 0 学时专题不排（学完也没用）
        used.add(s.name);
        need = round1(need - gain);
        assignments.push({
          name: s.name,
          hash: s.hash,
          mode,
          hours: s.eligibleHours,
          gain,
          targetKey: t.key,
          targetLabel: t.label,
          source: src,
          efficiency: s.efficiency,
          reason: `补「${t.label}」缺口，${mode === 'holdLast' ? '留尾（保未完成态）' : '学完'}，贡献 ${gain} 学时`
            + (s.efficiency ? `，性价比 ${s.efficiency} 学时/小时` : '，性价比未实测')
            + (src === 'fallback' ? '（主清单已用尽，启用兜底池）' : ''),
        });
      }
    }
    remainingGap[t.key] = Math.max(0, need);
  }

  // 落选清单：说明为什么没用
  const skipped = []
    .concat(catalog.map(s => ({ s, src: 'catalog' })))
    .concat(fallback.map(s => ({ s, src: 'fallback' })))
    .filter(({ s }) => !used.has(s.name))
    .map(({ s, src }) => {
      let why;
      if (s.preference === 'skip') why = 'preference=skip，主动排除';
      else if (s.eligibleHours <= 0) why = '可计入学时为 0（例如选修门槛为 0 学时）';
      else {
        const settlesTo = s.preference === 'holdLast' ? holdLastGoesTo
          : s.preference === 'full' ? fullGoesTo : null;
        if (settlesTo) {
          const tt = targets.find(x => x.key === settlesTo);
          why = remainingGap[settlesTo] <= 0
            ? `「${tt ? tt.label : settlesTo}」缺口已由更划算的专题填满`
            : `「${tt ? tt.label : settlesTo}」缺口虽未满，但已有更划算的专题顶上`;
        } else {
          const anyGapLeft = targets.some(x => remainingGap[x.key] > 0);
          if (!anyGapLeft) why = '所有目标已达标，无需启用';
          else why = src === 'fallback'
            ? '主清单已够用，兜底池无需启用'
            : '同口径下排序落后于更划算的专题，未被选中';
        }
      }
      return { name: s.name, hours: s.eligibleHours, mode: s.preference, source: src, why };
    });

  // 仍缺口的告警
  const shortfall = targets
    .filter(t => remainingGap[t.key] > 0)
    .map(t => ({ key: t.key, label: t.label, stillNeed: remainingGap[t.key] }));

  // 工时与值守规模估算
  const queued = assignments.filter(a => a.source === 'catalog');
  const held = assignments.filter(a => a.source === 'fallback');
  const videoHoursOf = list => round1(list.reduce((acc, a) => {
    const s = [...catalog, ...fallback].find(x => x.name === a.name);
    const vh = s && s.actualVideoHours
      ? s.actualVideoHours
      : a.hours / opt.defaultCreditsPerVideoHour;
    return acc + vh;
  }, 0));

  const totalVideoHours = videoHoursOf(assignments);
  const estWallHours = round1(totalVideoHours * (1 + 0.15)); // 留 15% 余量给缓冲/卡顿/切页

  const plan = {
    generatedAt: new Date().toISOString(),
    options: opt,
    settlement: { fullGoesTo, holdLastGoesTo, holdLastContribution },
    assumptionWarning: holdLastContribution === 'whole'
      ? '「留尾 → 整专题学时全部计入」是待验证假设（H2）。首专题收尾后必须核对学时面板：'
        + '若留尾专题的学时没有全额进账，把 settlement.holdLastContribution 改成 completedOnly 重跑。'
      : null,
    targets,
    // queue 保留主清单，供规划书展示；executionQueue 才是实际执行顺序，
    // 包含主清单与本次已经选中的兜底专题，避免“规划选中了但执行时丢失”。
    queue: assignments.filter(a => a.source === 'catalog'),
    executionQueue: assignments,
    fallbackUsed: held,
    skipped,
    shortfall,
    unmappedTargets: unmappedTargets.map(t => ({
      key: t.key, label: t.label, need: t.gap,
      why: '该口径既不是 fullGoesTo 也不是 holdLastGoesTo，本算法不知道用哪种模式补',
    })),
    estimate: {
      subjects: assignments.length,
      credits: round1(assignments.reduce((a, x) => a + x.gain, 0)),
      videoHours: totalVideoHours,
      wallHours: estWallHours,
      wallDays: round1(estWallHours / 24),
      checks: Math.ceil(estWallHours * 60 / opt.checkIntervalMinutes),
      checkIntervalMinutes: opt.checkIntervalMinutes,
    },
  };
  return plan;
}

/* ------------------------------------------------------------------ */
/* 输出：队列文件（直接喂 guardian）                                    */
/* ------------------------------------------------------------------ */

function toQueue(plan) {
  return {
    note: '由 plan.js 生成。数组顺序即学习顺序，删掉某条即跳过。'
      + 'mode=holdLast 表示故意留最后一个章节不看（学时计入指定口径）；full 表示学完全部。',
    createdAt: plan.generatedAt,
    generatedBy: 'course-hours-autopilot/scripts/plan.js',
    settlement: plan.settlement,
    creditTargets: Object.fromEntries(plan.targets.map(t => [t.key, {
      target: t.target, done: t.done, label: t.label,
    }])),
    subjects: (plan.executionQueue || plan.queue).map(a => ({
      name: a.name, hash: a.hash, mode: a.mode, source: a.source,
      hours: a.hours, expectedGain: a.gain,
    })),
    todoFallback: plan.skipped
      .filter(s => s.source === 'fallback' && s.mode !== 'skip')
      .map(s => ({ name: s.name, hours: s.hours, mode: s.mode, when: s.why })),
    finished: [],
    failed: [],
  };
}

/* ------------------------------------------------------------------ */
/* 输出：规划书（给人看）                                              */
/* ------------------------------------------------------------------ */

function toMarkdown(plan) {
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  let sec = 0;
  const h = t => `## ${CN[sec++] || (sec)}、${t}`;
  const labelOf = key => {
    const t = plan.targets.find(x => x.key === key);
    return t ? t.label : key;
  };
  const L = [];
  L.push('# 学时任务规划书', '');
  L.push(`> 生成时间：${new Date(plan.generatedAt).toLocaleString('zh-CN')}`);
  L.push('> 由 `course-hours-autopilot/scripts/plan.js` 确定性生成', '');

  L.push(h('目标与缺口'), '');
  L.push('| 口径 | 要求 | 已完成 | 缺口 |');
  L.push('|---|---:|---:|---:|');
  for (const t of plan.targets) L.push(`| ${t.label} | ${t.target} | ${t.done} | ${t.gap} |`);
  L.push('');

  L.push(h('记账规则'), '');
  L.push(`- **学完整专题** → 计入「${labelOf(plan.settlement.fullGoesTo)}」`);
  L.push(`- **留最后一个章节不学**（专题保持未完成态） → 计入「${labelOf(plan.settlement.holdLastGoesTo)}」`);
  L.push(`- 留尾贡献口径：\`${plan.settlement.holdLastContribution}\``);
  if (plan.assumptionWarning) L.push(`- ⚠️ ${plan.assumptionWarning}`);
  L.push('');

  L.push(h('执行队列'), '');
  if (!plan.queue.length) {
    L.push('（队列为空——所有目标都已达标，或库里没有可动用的专题）', '');
  } else {
    L.push('| # | 专题 | 学时 | 模式 | 计入 | 性价比(学时/视频小时) |');
    L.push('|---:|---|---:|---|---|---:|');
    plan.queue.forEach((a, i) => {
      L.push(`| ${i + 1} | ${a.name} | ${a.hours} | ${a.mode === 'holdLast' ? '留尾' : '学完'} `
        + `| ${a.targetLabel} | ${a.efficiency == null ? '未实测' : a.efficiency} |`);
    });
    L.push('');
    L.push('入选理由（逐条）：', '');
    plan.queue.forEach((a, i) => L.push(`${i + 1}. **${a.name}** —— ${a.reason}`));
    L.push('');
  }

  if (plan.fallbackUsed.length) {
    L.push(h('主清单用尽后启用的兜底专题'), '');
    L.push('| 专题 | 学时 | 模式 | 理由 |');
    L.push('|---|---:|---|---|');
    for (const a of plan.fallbackUsed) L.push(`| ${a.name} | ${a.hours} | ${a.mode} | ${a.reason} |`);
    L.push('');
  }

  L.push(h('未采用的专题（及原因）'), '');
  if (!plan.skipped.length) L.push('（无）', '');
  else {
    L.push('| 专题 | 学时 | 来源 | 原因 |');
    L.push('|---|---:|---|---|');
    for (const s of plan.skipped) {
      L.push(`| ${s.name} | ${s.hours} | ${s.source === 'catalog' ? '主清单' : '兜底池'} | ${s.why} |`);
    }
  }
  L.push('');

  L.push(h('工作量与值守规模'), '');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  L.push(`| 专题数 | ${plan.estimate.subjects} |`);
  L.push(`| 预计新增学时 | ≈ ${plan.estimate.credits} |`);
  L.push(`| 折算视频时长 | ≈ ${plan.estimate.videoHours} 小时 |`);
  L.push(`| 折算挂机时长（含 15% 余量） | ≈ ${plan.estimate.wallHours} 小时 ≈ ${plan.estimate.wallDays} 天 |`);
  L.push(`| 巡检次数（每 ${plan.estimate.checkIntervalMinutes} 分钟一次） | ≈ ${plan.estimate.checks} 次 |`);
  L.push('');

  if (plan.shortfall.length) {
    L.push(h('⚠️ 缺口未填满'), '');
    L.push('| 口径 | 仍缺 |', '|---|---:|');
    for (const s of plan.shortfall) L.push(`| ${s.label} | ${s.stillNeed} |`);
    L.push('');
    L.push('库里现有专题不够。需补充专题来源（去平台「课程」频道按单课补，或放宽口径）后重跑本脚本。', '');
  }
  if (plan.unmappedTargets.length) {
    L.push(h('算法无法处理的目标'), '');
    for (const t of plan.unmappedTargets) L.push(`- ${t.label}（缺 ${t.need}）：${t.why}`);
    L.push('');
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function demoInput() {
  return {
    targets: [
      { key: 'selfStudy', label: '网络自学（时）', target: 50, done: 12.5 },
      { key: 'central', label: '集中培训（时）', target: 90, done: 30.0 },
    ],
    settlement: { fullGoesTo: 'central', holdLastGoesTo: 'selfStudy' },
    catalog: [
      { name: '示例专题 A', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000001', hours: 25.4, requiredCourses: 15, actualVideoHours: 22 },
      { name: '示例专题 B', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000002', hours: 26.4, requiredCourses: 16, actualVideoHours: 19 },
      { name: '示例专题 C', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000003', hours: 7.3, requiredCourses: 20, actualVideoHours: 6.5 },
      { name: '示例专题 D', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000004', hours: 6.3 },
      { name: '示例专题 E', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000005', hours: 6.9 },
      { name: '示例专题 F', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000006', hours: 6.5 },
      { name: '示例专题 G', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000007', hours: 23.9, eligibleHours: 6.1, requiredCourses: 2 },
      { name: '示例专题 H', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000008', hours: 4 },
    ],
    fallback: [
      { name: '示例专题 I', hash: '#/study/subject/detail/00000000-0000-4000-8000-000000000009', hours: 5.4, preference: 'full' },
      { name: '示例专题 J', hash: '#/study/subject/detail/00000000-0000-4000-8000-00000000000a', hours: 16.3, preference: 'holdLast' },
    ],
  };
}

function main() {
  const argv = process.argv.slice(2);
  const get = flag => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const asJson = argv.includes('--json');
  const demo = argv.includes('--demo');
  const inPath = get('--in');
  const outDir = get('--out') || process.cwd();

  let input;
  if (demo) input = demoInput();
  else if (inPath) {
    try { input = JSON.parse(fs.readFileSync(inPath, 'utf8')); }
    catch (e) { fail('读不到输入文件 ' + inPath + ': ' + e.message); }
  } else {
    fail('缺少 --in <plan-input.json>（或用 --demo 看样例）');
  }

  const plan = buildPlan(input);
  const queue = toQueue(plan);

  if (asJson) { console.log(JSON.stringify(plan, null, 2)); return; }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(outDir, 'plan.md'), toMarkdown(plan));
  fs.writeFileSync(path.join(outDir, 'subject-queue.json'), JSON.stringify(queue, null, 2));
  fs.writeFileSync(path.join(outDir, 'credit-baseline.json'), JSON.stringify({
    at: plan.generatedAt,
    targets: plan.targets.map(t => ({ key: t.key, label: t.label, target: t.target, done: t.done })),
  }, null, 2));

  console.log(`已生成排期：${path.resolve(outDir)}`);
  console.log(`  队列 ${plan.queue.length} 条 + 兜底 ${plan.fallbackUsed.length} 条 + 未采用 ${plan.skipped.length} 条`);
  console.log(`  预计新增 ${plan.estimate.credits} 学时 ≈ 挂机 ${plan.estimate.wallHours} 小时（${plan.estimate.wallDays} 天）`);
  if (plan.shortfall.length) {
    console.log('  ⚠️ 缺口未填满：' + plan.shortfall.map(s => `${s.label} 仍缺 ${s.stillNeed}`).join('，'));
  }
  if (plan.queue.length) console.log('  首项：' + plan.queue[0].name + '（' + plan.queue[0].mode + '）');
}

if (require.main === module) main();

module.exports = { buildPlan, toQueue, toMarkdown, normalizeSubject, DEFAULTS };
