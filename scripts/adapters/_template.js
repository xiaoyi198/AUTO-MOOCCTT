/**
 * 适配器模板 —— 复制本文件为 <平台id>.js 后填空
 *
 * 使用步骤：
 *   1. cp _template.js <平台id>.js
 *   2. 用 `node scripts/probe.js <子命令>` 把下面每个字段的取值**实测出来**，不要猜
 *   3. `node scripts/engine/guardian.js --adapter <平台id>` 单轮试跑
 *   4. 把实测细节写进 references/platform-<平台id>.md，避免下次重新探测
 *
 * 判据：所有取值都来自页面实测，任何"我觉得应该是"的字段都必须标 TODO 并去验证。
 * 详细方法见 references/writing-an-adapter.md
 */

'use strict';

module.exports = {
  /* ---------- 身份 ---------- */
  id: 'CHANGE-ME',                 // 必须与文件名一致
  label: 'CHANGE-ME',              // 人类可读名称
  baseUrl: 'https://CHANGE-ME/',   // 结尾带 /
  homeUrl: 'https://CHANGE-ME/',   // 没有专题页时打开这个，用来触发登录/落地

  /* ---------- URL 识别（决定哪些标签页算"专题页"/"学习页"） ---------- */
  routing: {
    subject: /CHANGE-ME/,                                   // 专题/课程列表页
    subjectId: /CHANGE-ME\/([0-9a-fA-F-]{36})/,             // 从中提取专题唯一 id（用于精确选页）
    course: /CHANGE-ME/,                                    // 视频学习页
    fullCourse: /CHANGE-ME/,                                // 更完整的课程路径（选页时打分更高）
  },
  // 命中即判定"登录态失效"。通常 /oauth|login|sso/i
  loginHint: /oauth|login|sso/i,

  /* ---------- 文案库（全部实测，别凭想象补） ---------- */
  startTexts: ['开始学习', '继续学习'],   // 卡片上的入口按钮文字
  entryTexts: ['开始学习', '继续学习', '学习中', '已完成', '未开始'], // 剥掉后得到课程名
  confirmWords: [
    '继续学习', '继续观看', '继续播放', '继续', '重新学习', '重新播放',
    '我知道了', '知道了', '确定', '确认', '好的', '好', '关闭', '取消',
  ],

  /* ---------- DOM 选择器 ---------- */
  cardSelectors: ['.item', 'li', 'tr'],   // 课程卡片容器候选，按顺序 closest
  requiredMarker: '\\[(必修|选修)\\]',    // 卡片文本里的修别标记，捕获组 1
  subjectNameHint: '专题',                // 专题名称里通常含有的字
  modalSelectors: [],                     // 通用弹窗选择器之外需要的额外类名

  /* ---------- 学时面板 ---------- */
  // 面板文字需能被 /([\d.]+)\s*\/\s*([\d.]+)/ 解析出「要求 / 已完成」。
  // 若平台顺序相反或结构不同，改 readCredit（engine/guardian.js）或在此声明，别硬套。
  credit: {
    self: '.CHANGE-ME',      // 例如「网络自学（时）」
    central: '.CHANGE-ME',   // 例如「集中培训（时）」
  },

  /* ---------- 记账规则 ---------- */
  onlyRequired: true,                 // 只学必修（选修门槛常为 0，不用做）
  holdLastFills: 'selfStudy',         // 留尾学时的归属口径（引擎据此决定兜底池补哪种模式）
  // 完整的结算映射由排期产物 subject-queue.json 携带，此处不要重复声明，避免两处漂移

  /* ---------- 路由备忘（填成实测的进入方式，供后续会话参考） ---------- */
  routes: {},
};
