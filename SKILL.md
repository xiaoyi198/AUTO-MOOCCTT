---
name: course-hours-autopilot
description: 模型辅助型学时值守 Skill（面向单一特定平台）：Skill 提供示例脚本与探测方法，模型先探测页面、按实况完善适配器与排期输入、单轮验证通过后再交给确定性引擎无人值守执行（自动播完切下一门、被暂停自动恢复、弹窗自动关、浏览器崩了自动拉起）。之后由宿主 Agent 的定时能力每隔 15 分钟唤醒模型做链式自检、每小时做独立兜底巡检；期间任何异常或链条中断都会唤醒模型修复，直到平台学时真正达标。当用户要求"刷学时/挂课/自动学习/自动看完课程/凑够学时/学分任务/网课挂机/无人值守学习"时使用。
agent_created: true
---

# 学时任务全自动值守

把「凑够平台的学时指标」变成一件**用户只需登录一次**、之后由模型辅助值守到达标的自动化任务。

## 谁做什么（模型在环）

本 Skill 是**模型在环**的：不是让模型每 15 分钟自由点网页，也不是让脚本凭空完成一切。

| 角色 | 负责 |
|---|---|
| **Skill（本目录）** | 提供示例脚本、平台存档、探测方法、故障处理规则、值守 prompt 模板 |
| **模型** | 首次探测页面 → 按实况完善适配器 / 排期输入 → 单轮验证 → 之后每轮被唤醒时读证据、诊断异常、修复脚本、必要时通知人工 |
| **确定性引擎** `engine/guardian.js` | 登录后的长时间稳定执行：播放、恢复、切课、切专题、自愈 |
| **宿主 Agent 的定时能力** | 每 15 分钟唤醒一次主巡检 + 每小时一条独立兜底，防链条断裂 |

**铁律：执行期的一切「点击 / 等待 / 重试」由脚本完成，模型只在被唤醒时读证据、做判断、改脚本。**

## 适用与不适用

**适用**：平台有可播放的视频课程、学时按课程/专题完成状态结算、需要人工登录。
典型：企业培训学院、继续教育平台、网课平台。

**不适用**（先明确说明，别硬上）：
- 需要人脸识别 / 随机答题 / 防挂机行为检测且无法绕开的
- 没有账号密码就完全无法登录的场景（本技能只能"少打扰"，不能"免登录"）

## 硬性铁律

1. **不要接管用户日常浏览器**。浏览器 136+ 起，`--remote-debugging-port` 只在配了非默认
   `--user-data-dir` 时才生效。必须另起独立实例；想继承登录态就复制一份 profile。
2. **绝不用 `browser.close()`**，收尾一律 `disconnect()`。`close()` 会关掉用户的窗口。
3. **不要把选择器写进引擎**。平台差异只存在于 `scripts/adapters/<id>.js`。
4. **不要在受管浏览器里做探索性操作**。新开/切换标签会抢走前台，导致学习页被挂起、视频中断。
   侦察用 `probe.js`，能只读就只读，必须开标签就立刻关掉并还焦点。
5. **排期必须敢报缺口**。库里专题不够时输出 `shortfall` 让人知道，不要假装能完成。
6. **"有意为之"必须显式打日志**。例：留尾模式的「最后一节故意不学」。否则会被自己后一轮当成故障修掉。
7. **只对修不了的做通知，对修得了的自己修**。无法自愈的只有两类：需人工凭证（登录态失效、
   验证码、扫码）与物理中断（断电、断网）。这两类要"准确识别 + 明确通知"，不是假装能修。
8. **不确定平台记账规则时，先跑一个专题验证假设，再放开跑。** 见 `references/planning-rules.md` 第五节。

## 运行时目录约定

所有状态都落在一个目录里（默认 `~/.workbuddy/course-autopilot/`，用 `--dir` 或 `AUTOPILOT_DIR` 改）：

| 文件 | 作用 |
|---|---|
| `plan-input.json` | 排期输入（你填写） |
| `plan.md` / `plan.json` | 排期结果（人看 / 机器读） |
| `subject-queue.json` | 执行队列，引擎按它推进 |
| `learn-state.json`(+`.bak`) | 当前专题、第几门、进度基线 |
| `learn-log.txt` | 巡检日志 |
| `credit-history.jsonl` | 学时面板读数历史（变化才记，用于归因） |
| `credit-baseline.json` | 基线快照，供收尾验收 |
| `evidence/latest/status.json` | **每轮证据包**（STATUS + 学时读数 + 视频状态 + 截图路径），供模型诊断 |
| `guardian.lock` | 并发锁 |
| `browser-profile/` | 独立浏览器 profile（登录态在这） |

## 六阶段工作流

### 阶段 1 · 采集目标

打开平台的学时面板，读出**每个口径的「要求」与「已完成」**。

- 面板格式通常是「要求 / 已完成」，但**顺序不保证**。判定方法：拿一个已知的历史数据点交叉验证
  （例如"当前读数 = 历史读数 + 本次新增"能对上，才能确定首位是要求）。
- **不要把"看起来像目标"的数字当目标就开跑** —— 先和用户确认哪几个指标要凑、各要多少。
- 确认平台的记账规则：**什么情况下学时归到哪个口径**。这一步错了，后面全白跑。

### 阶段 2 · 侦察平台并写适配器

```bash
node scripts/engine/launch.js                 # 起受管浏览器，首次手工登录一次
node scripts/probe.js credit                  # 学时面板选择器
node scripts/probe.js cards                   # 课程卡片结构与入口按钮
node scripts/probe.js modals                  # 弹窗容器
node scripts/probe.js nav                     # 导航项
cp scripts/adapters/_template.js scripts/adapters/<平台id>.js   # 填实测值
```

字段实测方法见 `references/writing-an-adapter.md`。已有适配器：`mooc-ctt-cn`
（中国烟草网络学院，实测细节见 `references/platform-mooc-ctt-cn.md`）。

**关键动作**：顺便量出每个专题的 `actualVideoHours`（实际播放时长）与
`eligibleHours`（真正能计入的学时）。这两个字段决定排期质量，见阶段 3。

### 阶段 3 · 排期

```bash
cp assets/plan-input.example.json <运行时目录>/plan-input.json   # 按实情填写
node scripts/plan.js --in <运行时目录>/plan-input.json --out <运行时目录>
```

产出 `plan.md`（给人看）、`subject-queue.json`（给引擎吃）、`credit-baseline.json`（验收基线）。
算法与两个易错字段（`eligibleHours`、`actualVideoHours`）见 `references/planning-rules.md`。

**把 `plan.md` 给用户看一遍再开跑** —— 排期里有假设（尤其是留尾贡献口径），
用户可能知道平台的实际规则，一句话就能省下几十小时。

### 阶段 4 · 部署值守（单轮验证）

```bash
node scripts/engine/guardian.js --adapter <平台id> --dir <运行时目录> --no-launch
```

先单跑一轮，确认末行 STATUS 合理：
- 首次应是 `NEXT_STARTED`（点开第一门并起播）或 `PLAYING`
- `NEED_HELP:专题页解析不到课程列表` → 通常没登录，或适配器选择器不对

**必须人为验证"课程播完 → 切下一门"这条路径**。链路上"没走到的分支"等于"没验证过的分支"
（实测有脚本带着一个从未被执行的点击函数潜伏了 1.5 小时，直到需要自动切课时才爆）。

验证通过前**不要**挂定时任务——否则坏逻辑会被定时器反复触发，并且因为不报错而很难发现。

### 阶段 5 · 无人值守

按 `references/unattended-ops.md` 部署**自续期的一次性任务链**（15 分钟精度）
+ **一条每小时兜底循环任务**。每环 prompt 四步：执行 → 按 STATUS 分派 → 续期 → 自清理过期环
（**必须先建下一环再删过期环**，顺序反了会断链）。

只有 `ALL_DONE` 才停止续期。`NEED_HELP` 先重跑一次（引擎自带自愈），仍失败才通知用户。

### 阶段 6 · 验收收尾

1. `node scripts/probe.js credit` 读最终学时，与目标比对。
2. 未达标时先看是不是排期时就预告的 `shortfall`（那是库不够，不是执行失败）。
3. 核对 `subject-queue.json` 的 `finished` / `failed`，确认没有静默跳过。
4. 停掉定时链（删除所有同名自动化任务），关闭受管浏览器（`node scripts/engine/launch.js --kill`）。

## 模型值守与修复（每轮唤醒时做什么）

每轮被唤醒时**先读证据、再决定动作**，不要凭猜测操作页面。

### 证据包（先读这个，别翻整份日志）

每轮引擎都会把观测快照写到 `<运行时目录>/evidence/latest/status.json`：

```json
{
  "at": "2026-09-30T09:00:00.000Z",
  "statusLine": "STATUS:PLAYING:课程A 120/600s (20%) 剩余8分0秒",
  "credit": { "self": { "target": 50, "done": 12.5 }, "central": { "target": 90, "done": 30.0 } },
  "targets": [ { "key": "selfStudy", "target": 50, "done": 12.5, "met": false } ],
  "video": { "paused": false, "t": 120.0, "d": 600, "ended": false },
  "url": "https://<平台>/course/detail/...",
  "subject": "示例专题 A",
  "course": "第 2 章 ……",
  "screenshot": "<运行时目录>/guardian-shot.png"
}
```

读取顺序：`evidence/latest/status.json` →（异常时）`guardian-shot.png` →
`learn-log.txt` 尾部 → `learn-state.json` / `subject-queue.json`。

### 四级处置策略

| 级别 | 触发 | 动作 |
|---|---|---|
| **L0 脚本自愈** | 暂停 / 卡顿 / 弹窗 / 浏览器掉线 | 什么都不用做，引擎自己修；只看 STATUS 是否恢复 |
| **L1 重跑一次** | `NEED_HELP` / `ERROR` | 原样重跑一轮，网络抖动常能自愈 |
| **L2 模型诊断修复** | 连续 `NEED_HELP`、`TARGET_NOT_REACHED`、学时长时间不涨、页面结构改了 | 读证据 → `probe.js` 复核页面 → 改 `adapters/` 或 `engine/` → `node --check` → 单轮验证 |
| **L3 通知人工** | 登录态失效 / 扫码 / 验证码 / L2 修复失败 | 明确通知用户，不假装能修 |

### 修复的规矩

1. **只改最小范围**：选择器/文案问题改适配器；只有「引擎缺抽象」才动引擎。
2. 改完必须 `node --check` + `probe` 复核 + **单轮** `sh run-guardian.sh` 验证末行 STATUS 合理，
   通过后才续期；没通过就回退这一处改动再重试。
3. 正常播放中**禁止**探索性操作（不开新标签、不点菜单、不导航）——会抢前台、打断播放。
4. 「有意为之」的动作必须显式打日志（见铁律 6），否则会被后一轮当成故障「修」掉。
5. 真正无法自愈的只有两类：**需人工凭证**（登录态失效 / 验证码 / 扫码）与**物理中断**（断电 / 断网）。
   这两类要"准确识别 + 明确通知"，其余一律先尝试自愈。

## 目录结构

```
course-hours-autopilot/
├── SKILL.md
├── README.md
├── LICENSE
├── package.json
├── .gitignore
├── scripts/
│   ├── plan.js                    排期器（纯计算，可反复重跑）
│   ├── probe.js                   平台侦察工具
│   ├── run-guardian.sh            巡检包装（内部清代理 + 定位 node）
│   ├── engine/
│   │   ├── config.js              配置解析（无硬编码路径）
│   │   ├── cdp.js                 CDP 连接 / 探测 / 脱离式拉起
│   │   ├── launch.js              启动 / 关闭 / 实验实例
│   │   └── guardian.js            值守引擎（平台无关）
│   └── adapters/
│       ├── mooc-ctt-cn.js         已适配：中国烟草网络学院
│       └── _template.js           新平台模板
├── references/
│   ├── planning-rules.md          排期与记账规则
│   ├── unattended-ops.md          长时无人值守运维（故障自愈矩阵 / 定时链）
│   ├── writing-an-adapter.md      新平台适配指南
│   └── platform-mooc-ctt-cn.md    已适配平台实测存档
└── assets/
    └── plan-input.example.json    排期输入样例
```

## 引擎的 STATUS 契约

调用方**只读末行**判断，不要去猜：

| STATUS | 含义 | 应对 |
|---|---|---|
| `PLAYING` / `RESUMED` | 正常播放 / 曾异常已自救 | 一句话汇报进度 |
| `COURSE_DONE` / `NEXT_STARTED` | 一门完成已切换 / 已启动某门 | 正常 |
| `NEXT_SUBJECT` | 上个专题收尾，已切下一个 | 注意留尾是**有意设计**，不是失败 |
| `ALL_DONE` | 队列跑完**且实际学时已达标**（唯一的完成判据） | **停止续期**，报出学时面板读数 |
| `TARGET_NOT_REACHED` | 队列跑完但学时未达标（缺口 / 失败专题 / 兜底剩余） | 唤醒模型补专题或修脚本，**不要停续期** |
| `BUSY` | 上轮未结束，本轮跳过 | 正常（说明锁生效了） |
| `NEED_HELP:<原因>` | 需人工 | 先重跑一次；仍失败才通知用户 |
| `ERROR:<原因>` | 脚本异常 | 重跑一次；仍报错按 NEED_HELP 处理 |
