/**
 * 适配器：中国烟草网络学院（mooc.ctt.cn）
 *
 * 本文件是「引擎 ↔ 平台」的唯一结合面。换平台 = 换/新增一个本目录下的适配器，
 * 引擎代码不需要改。字段含义与探测方法见 references/writing-an-adapter.md。
 *
 * 本适配器的所有取值均为 2026-09-30 在本机实测所得，不是猜的。
 */

'use strict';

module.exports = {
  id: 'mooc-ctt-cn',
  label: '中国烟草网络学院',
  baseUrl: 'https://mooc.ctt.cn/',
  homeUrl: 'https://mooc.ctt.cn/',

  /* ---------- URL 识别 ---------- */
  routing: {
    // 专题页
    subject: /subject\/detail/,
    // 专题页里的专题 id（UUID），用于精确匹配标签页，绝不"取第一个"
    subjectId: /subject\/detail\/([0-9a-fA-F-]{36})/,
    // 课程学习页
    course: /course\/detail/,
    // 完整课程路径，用于给标签页打分（比只含 course/detail 的可信）
    fullCourse: /course\/detail\/[^/]+\/\d+\/\d+\//,
  },

  // URL 命中即判定"登录态失效" —— 这类无法自愈，只能通知人工
  loginHint: /oauth|login/i,

  /* ---------- 文案库 ---------- */
  // 课程卡片上的入口按钮。未学 = 开始学习，学过一半 = 继续学习
  startTexts: ['开始学习', '继续学习'],
  // 卡片文本里要剥掉的入口/状态词，剥完才是课程名
  entryTexts: ['开始学习', '继续学习', '学习中', '已完成', '未开始'],
  // 弹窗里表示"我还在 / 继续"的按钮，命中即点击
  confirmWords: [
    '继续学习', '继续观看', '继续播放', '继续', '重新学习', '重新播放',
    '我知道了', '知道了', '确定', '确认', '好的', '好', '关闭', '取消',
  ],

  /* ---------- DOM 选择器 ---------- */
  // 课程卡片的容器候选（按顺序取第一个能 closest 到的）
  cardSelectors: ['.item', 'li', 'tr'],
  // 卡片文本里的必修/选修标记。捕获组 1 即修别
  requiredMarker: '\\[(必修|选修)\\]',
  // 专题页里专题名称的特征词
  subjectNameHint: '专题',
  // 本平台额外需要识别的弹窗容器。实测"是否还在看"确认框是常规 dialog 类名，
  // 通用选择器已覆盖，这里留空备用。
  modalSelectors: [],

  /* ---------- 学时面板（全局页头，零打扰直读） ---------- */
  // 格式为「要求 / 已完成」，例如：网络自学 50 / 12.5、集中培训 90 / 30.0
  credit: {
    self: '.credit-label',
    central: '.hour-label',
    // 执行器用它把平台字段映射到 plan-input / subject-queue 的目标 key。
    keys: { self: 'selfStudy', central: 'central' },
    labels: { self: '网络自学（时）', central: '集中培训（时）' },
  },

  /* ---------- 记账规则 ---------- */
  // 只学必修：本平台选修多数标注"完成 0 学时以上"，门槛为 0，完全不用做
  onlyRequired: true,
  // 留尾（专题保持未完成）的学时归到哪个口径。引擎靠它决定兜底池补哪种模式的专题。
  // 注意：完整的结算映射（fullGoesTo / holdLastGoesTo）由排期产物 subject-queue.json 携带，
  //       那里是执行时的唯一真源。此处不再重复声明，避免两处漂移。
  holdLastFills: 'selfStudy',

  /* ---------- 路由备忘（导航一律点顶部导航，不要手改 hash：猜的 hash 会白屏） ---------- */
  routes: {
    subjectList: { how: '点顶部导航「专题」', hash: '#/study/subject/index' },
    courseList: { how: '点顶部导航「课程」', hash: '#/study/course/index' },
    center: { how: '头像下拉「学习中心」', hash: '#/center/index' },
    home: { how: '直接访问', hash: '#/home' },
    invalid: ['#/subject/list', '#/course/list'],
  },
};
