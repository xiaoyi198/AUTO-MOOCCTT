---
name: course-hours-autopilot
description: 模型辅助型学时值守 Skill（只面向 mooc.ctt.cn 一个平台）：先向用户出示免责声明并取得明示确认，再由模型探测页面、完善适配器与排期输入，单轮验证通过后交给确定性引擎无人值守执行（自动播完切下一门、被暂停自动恢复、弹窗自动关、浏览器崩了自动拉起）。之后由宿主 Agent 的定时能力周期性唤醒模型做链式自检与兜底巡检，直到平台学时真正达标。当用户要求"刷学时/挂课/自动学习/自动看完课程/凑够学时/学分任务/网课挂机/无人值守学习"时使用。
agent_created: true
---

# 学时任务全自动值守

把「凑够平台的学时指标」变成一件**用户只需登录一次并确认一次免责声明**、之后由模型辅助值守到达标的自动化任务。

> **平台范围**：本 Skill 只面向 mooc.ctt.cn（中国烟草网络学院），不做通用多平台抽象。
> 换平台请照 `references/writing-an-adapter.md` 另写适配器，并自行复核该平台的记账规则。

## 谁做什么（模型在环）

本 Skill 是**模型在环**的：不是让模型每 15 分钟自由点网页，也不是让脚本凭空完成一切。

| 角色 | 负责 |
|---|---|
| **Skill（本目录）** | 提供脚本、平台存档、探测方法、故障处理规则、值守 prompt 模板 |
| **模型** | 阶段 0 出示免责声明并取得确认 → 探测页面 → 完善适配器 / 排期输入 → 单轮验证 → 之后每轮被唤醒时读证据、诊断异常、修复脚本、必要时通知人工 |
| **确定性引擎** `engine/guardian.js` | 登录后的长时间稳定执行：播放、恢复、切课、切专题、自愈 |
| **常驻守护** `engine/keeper.js` | 把受管浏览器**一直持有住**（进程一没，浏览器就被回收），并按固定间隔自己触发上面那个引擎 |
| **宿主 Agent 的定时能力** | 周期性唤醒模型读证据、做判断、必要时修脚本或通知人 |

**铁律：执行期的一切「点击 / 等待 / 重试」由脚本完成，模型只在被唤醒时读证据、做判断、改脚本。**

## 阶段 0 · 免责声明与用户确认（硬性前置，不得跳过）

**在启动浏览器、写排期、跑任何一轮巡检之前**，先把下面这段免责声明原样出示给用户，并等待**明确确认**。

```text
【免责声明 · 请确认后再开始】

本技能会用自动化方式代替人工观看课程，属于对目标平台规则的规避行为。开始前请确认你已知悉：

1. 可能违反目标平台的用户协议，以及你所在单位的相关管理规定；
2. 可能导致账号被限制、学习记录或学时被判定无效、已获学时被撤销；
3. 平台改版、风控升级都可能导致任务中途失败，本技能不保证一定达标；
4. 运行期间会另起一个独立浏览器实例并保存登录态（含凭证），请勿把运行时目录提交到
   任何代码仓库或分享给他人；
5. 因使用本技能产生的一切后果由使用者自负。

确认后我会：先探测平台 → 完善适配器与排期 → 单轮验证 → 再挂定时任务无人值守跑到达标。
期间只有「需要你本人操作」（登录/扫码/验证码）或「物理中断」（断电/断网）才会再打扰你。

回复「确认」即表示你已阅读并接受上述内容。
```

规则：

1. **未确认 = 什么都不做**：不起浏览器、不跑 `probe`、不写 `plan-input.json`、不建定时任务。
   用户若只是询问原理，就先讲原理，不要"顺手"跑起来。
2. 确认后立刻落盘记录，**后续每一轮巡检都不再重复询问**：

   ```jsonc
   // <运行时目录>/consent.json   （样例见 assets/consent.example.json）
   {
     "disclaimerVersion": "1.0",
     "confirmedAt": "2026-01-01T00:00:00.000Z",
     "confirmedBy": "<用户标识，可留空>",
     "statement": "<用户确认的原话，可留空>",
     "scope": "mooc.ctt.cn 学时任务自动化"
   }
   ```

   每轮巡检先看这个文件：存在且 `disclaimerVersion` 与本文一致 → 直接干活，不再啰嗦。
3. **确认之后就不再征求操作许可**，包括：起/杀浏览器、点页面、切专题、改适配器、重排期、
   创建定时任务。这些都属于已授权范围，不要每步都回头问一遍——问多了会打断长时任务。
4. **只有两类事停下来找人**：需要人工凭证（登录态失效 / 验证码 / 扫码）与物理中断（断电 / 断网）。
   这两类要"准确识别 + 明确通知"，不要假装能修。
5. 免责声明文案若要修改，必须同步提升 `disclaimerVersion` —— 版本变了就当作用户尚未确认。

## 适用与不适用

**适用**：平台有可播放的视频课程、学时按课程/专题完成状态结算、需要人工登录。
典型：企业培训学院、继续教育平台、网课平台。

**不适用**（先明确说明，别硬上）：
- 需要人脸识别 / 随机答题 / 防挂机行为检测且无法绕开的
- 没有账号密码就完全无法登录的场景（本技能只能"少打扰"，不能"免登录"）

## 硬性铁律

0. **阶段 0 未确认，不得启动任何自动化。** 见上节。
1. **不要接管用户日常浏览器**。浏览器 136+ 起，`--remote-debugging-port` 只在配了非默认
   `--user-data-dir` 时才生效。必须另起独立实例；想继承登录态就复制一份 profile。
   若宿主环境有沙箱，见「执行环境」一节 —— 浏览器往往必须跑在沙箱之外。
2. **绝不用 `browser.close()`**，收尾一律 `disconnect()`。`close()` 会关掉用户的窗口。
3. **不要把选择器写进引擎**。平台差异只存在于 `scripts/adapters/<id>.js`。
4. **不要在受管浏览器里做探索性操作**。新开/切换标签会抢走前台，导致学习页被挂起、视频中断。
   侦察用 `probe.js`（或 `scripts/recon-subjects.js` 示例），能只读就只读，
   必须开标签就用临时标签并立刻关掉、把学习页还焦点。
5. **排期必须敢报缺口**。库里专题不够时输出 `shortfall` 让人知道，不要假装能完成。
6. **"有意为之"必须显式打日志**。例：留尾模式的「最后一节故意不学」、主动放弃某专题。
   否则会被自己后一轮当成故障修掉。
7. **只对修不了的做通知，对修得了的自己修**。无法自愈的只有两类：需人工凭证与物理中断。
8. **不确定平台记账规则时，先跑一个专题验证假设，再放开跑。** 见 `references/planning-rules.md`。
9. **记账规则要用数据证实，不要用直觉**。拿 `credit-history.jsonl` 的读数控出增量，与
   「这段时间里哪些专题变成了完成态」交叉比对；对不上就说明规则不是你以为的那样。
   mooc.ctt.cn 的实测结论见 `references/platform-mooc-ctt-cn.md` 第四节。

## 运行时目录约定

所有状态都落在一个目录里（默认 `~/.course-autopilot/`，用 `--dir` 或 `AUTOPILOT_DIR` 改；
放在宿主工作区内可以少受沙箱写权限限制）：

| 文件 | 作用 |
|---|---|
| `consent.json` | **阶段 0 的确认记录**，存在即视为已授权 |
| `plan-input.json` | 排期输入（你填写） |
| `plan.md` / `plan.json` | 排期结果（人看 / 机器读） |
| `subject-queue.json` | 执行队列，引擎按它推进 |
| `learn-state.json`(+`.bak`) | 当前专题、第几门、进度基线 |
| `learn-log.txt` | 巡检日志 |
| `credit-history.jsonl` | 学时面板读数历史（变化才记，用于归因） |
| `credit-baseline.json` | 基线快照，供收尾验收 |
| `evidence/latest/status.json` | **每轮证据包**（STATUS + 学时读数 + 视频状态 + 截图路径），供模型诊断 |
| `guardian.lock` | 并发锁 |
| `keeper.log` / `keeper-heartbeat.json` | 常驻守护的日志与心跳（活性判据：`at` 是否新鲜） |
| `browser-profile/` | 独立浏览器 profile（登录态在这） |

## 执行环境：长命进程、沙箱与跨平台

这一段是"能在真实机器上跑起来"的关键，踩过坑，别省。

### 1. 受管浏览器必须由长命进程持有

引擎是「跑一轮就退出」的设计，视频能连续播下去，靠的是**浏览器一直活着**。
而很多 Agent 运行环境会在**一次工具调用结束时回收该调用启动的全部后代进程** ——
表现为："调用内 CDP 就绪，下一次调用再探已离线"，于是每 15 分钟只播了几秒钟。

⇒ 用 `engine/keeper.js`（常驻）持有浏览器，再由它按间隔触发引擎。
启动方式按平台选：Windows 双击 `scripts/start-keeper.bat`；POSIX 跑 `scripts/start-keeper.sh`。
**由用户手工双击/执行还有一个额外好处：进程归桌面会话所有，不受 Agent 沙箱管辖。**

判活：`keeper-heartbeat.json` 的 `at` 超过 10 分钟没更新 = keeper 挂了，请用户重新启动它。

### 2. 沙箱会掐断 Chromium 的内部 IPC

某些沙箱禁止程序打开**命名管道**，而 Windows 上 Chromium 的 browser↔renderer 通信正走命名管道。
症状极具迷惑性：

| 现象 | 实际含义 |
|---|---|
| `connect()` 一两百毫秒就成功 | WebSocket 握手没问题 |
| 浏览器级 CDP 命令（`Browser.getVersion`）几毫秒就回 | 浏览器主进程活着 |
| **页面级命令（`Runtime.evaluate` / `Page.enable`）永久无响应** | 渲染进程被冻住 |
| 浏览器窗口一片白 | 同上，页面根本没渲染出来 |

⇒ 结论：**受管浏览器要跑在沙箱之外**（用户双击启动的 keeper 正好满足）。
反过来，**客户端可以留在沙箱里**：沙箱内进程经 TCP 连 `127.0.0.1:<port>` 一切正常。

一条命令分辨这类故障（别靠猜）：

```bash
node scripts/engine/cdp-health.js --dir <运行时目录>
```

### 3. 别用管道接子进程输出

沙箱下 Node 的 piped stdio 可能直接 `EPERM`。keeper 触发引擎时**把输出重定向到文件**
（`guardian-round.log`），不要用 `exec` / `pipe` 收 stdout。

### 4. 跨平台的 shell 差异

- 巡检包装脚本 `scripts/run-guardian.sh` 只在 POSIX 上可用；**Windows 或受限沙箱下
  Git Bash 可能根本起不来**（`couldn't create signal pipe`），这时直接调：
  ```bash
  node scripts/engine/guardian.js --dir <运行时目录> --adapter mooc-ctt-cn
  ```
  包装脚本本来就只为两件事存在：清代理变量、定位 node。环境里没代理、node 在 PATH 时，
  直接调 node 完全等价。
- 让自动化直接拼命令行容易踩到"坏 shim"（例如某个 `env` 会静默吞掉子进程：退出码 0、无任何输出）。
  诊断判据：**命令正常但毫无输出、且日志文件 mtime 未变**。

## 工作流（阶段 0 ~ 阶段 6）

### 阶段 0 · 免责声明与用户确认

见上。**这是唯一一个不能自动跳过的阶段。**

### 阶段 1 · 采集目标

打开平台的学时面板，读出**每个口径的「要求」与「已完成」**。

- 面板格式通常是「要求 / 已完成」，但**顺序不保证**。判定方法：拿一个已知的历史数据点交叉验证
  （例如"当前读数 = 历史读数 + 本次新增"能对上，才能确定首位是要求）。
- **不要把"看起来像目标"的数字当目标就开跑** —— 先和用户确认哪几个指标要凑、各要多少。
- 确认平台的记账规则：**什么情况下学时归到哪个口径**。这一步错了，后面全白跑。
  用铁律 9 的方法证实，不要照抄文档里的假设。

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
（实测细节见 `references/platform-mooc-ctt-cn.md`）。
想批量盘点专题库（重排期时要用），用示例脚本 `scripts/recon-subjects.js`。

**关键动作**：顺便量出每个专题的 `actualVideoHours`（实际播放时长）与
`eligibleHours`（真正能计入的学时）。这两个字段决定排期质量，见阶段 3。

### 阶段 3 · 排期

```bash
cp assets/plan-input.example.json <运行时目录>/plan-input.json   # 按实情填写
node scripts/plan.js --in <运行时目录>/plan-input.json --out <运行时目录>
```

产出 `plan.md`（给人看）、`subject-queue.json`（给引擎吃）、`credit-baseline.json`（验收基线）。
算法与两个易错字段（`eligibleHours`、`actualVideoHours`）见 `references/planning-rules.md`。

**把 `plan.md` 给用户看一遍再开跑** —— 排期里有假设（尤其是某个口径靠什么结算），
用户可能知道平台的实际规则，一句话就能省下几十小时。

### 阶段 4 · 部署值守（单轮验证）

```bash
node scripts/engine/guardian.js --adapter mooc-ctt-cn --dir <运行时目录> --no-launch
```

先单跑一轮，确认末行 STATUS 合理：
- 首次应是 `NEXT_STARTED`（点开第一门并起播）或 `PLAYING`
- `NEED_HELP:专题页解析不到课程列表` → 通常没登录，或适配器选择器不对

**必须人为验证"课程播完 → 切下一门"这条路径**。链路上"没走到的分支"等于"没验证过的分支"
（实测有脚本带着一个从未被执行的点击函数潜伏了 1.5 小时，直到需要自动切课时才爆）。
同理，**改过排期或切过专题后，要再单跑一轮确认新专题真的能起播**。

验证通过前**不要**挂定时任务——否则坏逻辑会被定时器反复触发，并且因为不报错而很难发现。

### 阶段 5 · 无人值守

两条腿，都要有：

1. **执行力**：常驻 keeper（`scripts/start-keeper.bat` / `.sh`）持有浏览器并按间隔触发引擎。
   先跟用户确认它已经起来、窗口不要关。
2. **判断力**：用**宿主 Agent 的定时能力**周期性唤醒模型读证据、做判断。
   按宿主能力二选一，别硬套：
   - 宿主支持分钟级间隔调度（如 `interval: 15min`）→ 直接建两条：15 分钟主巡检 + 每小时兜底。
   - 宿主只支持小时级 → 用**自续期的一次性任务链**（每环 prompt 里写明"执行完立刻再建一个
     15 分钟后的环"）+ 每小时兜底任务，防止链条断掉没人发现。
   细节与踩坑见 `references/unattended-ops.md`。

只有 `ALL_DONE` 才停止续期。`NEED_HELP` 先重跑一次（引擎自带自愈），仍失败才通知用户。

### 阶段 6 · 验收收尾

1. `node scripts/probe.js credit` 读最终学时，与目标比对。
2. 未达标时先看是不是排期时就预告的 `shortfall`（那是库不够，不是执行失败）。
3. 核对 `subject-queue.json` 的 `finished` / `failed`，确认没有静默跳过。
4. 停掉定时任务（删除所有同名自动化任务），关掉 keeper，关闭受管浏览器
   （`node scripts/engine/launch.js --kill`）。

## 模型值守与修复（每轮唤醒时做什么）

每轮被唤醒时**先读证据、再决定动作**，不要凭猜测操作页面。第一件事是看 `consent.json`
在不在——不在就先补阶段 0，别傻跑。

### 证据包（先读这个，别翻整份日志）

每轮引擎都会把观测快照写到 `<运行时目录>/evidence/latest/status.json`：

```json
{
  "at": "2026-01-01T00:00:00.000Z",
  "statusLine": "STATUS:PLAYING:示例课程 120/600s (20%) 剩余8分0秒",
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
`keeper-heartbeat.json` → `learn-log.txt` 尾部 → `learn-state.json` / `subject-queue.json`。

### 四级处置策略

| 级别 | 触发 | 动作 |
|---|---|---|
| **L0 脚本自愈** | 暂停 / 卡顿 / 弹窗 / 浏览器掉线 | 什么都不用做，引擎自己修；只看 STATUS 是否恢复 |
| **L1 重跑一次** | `NEED_HELP` / `ERROR` | 原样重跑一轮，网络抖动常能自愈 |
| **L2 模型诊断修复** | 连续 `NEED_HELP`、`TARGET_NOT_REACHED`、学时长时间不涨、页面结构改了 | 读证据 → `probe.js` 复核页面 → 改 `adapters/` 或 `engine/` → `node --check` → 单轮验证 |
| **L3 通知人工** | 登录态失效 / 扫码 / 验证码 / L2 修复失败 / keeper 心跳过期 | 明确通知用户，不假装能修 |

### 修复的规矩

1. **只改最小范围**：选择器/文案问题改适配器；只有「引擎缺抽象」才动引擎。
2. 改完必须 `node --check` + `probe` 复核 + **单轮**验证末行 STATUS 合理，
   通过后才续期；没通过就回退这一处改动再重试。
3. 正常播放中**禁止**探索性操作（不开新标签、不点菜单、不导航）——会抢前台、打断播放。
4. 「有意为之」的动作必须显式打日志（见铁律 6），否则会被后一轮当成故障「修」掉。
5. 真正无法自愈的只有两类：**需人工凭证**与**物理中断**。其余一律先尝试自愈。
6. 要动 `learn-state.json`（例如主动放弃一个对缺口无贡献的专题）时：先备份、
   在 `learn-log.txt` 写清"有意为之"的理由、并确认没有巡检正在跑（`guardian.lock` 新鲜就别动）。

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
│   ├── recon-subjects.js          专题库盘点（示例）
│   ├── run-guardian.sh            巡检包装（POSIX；内部清代理 + 定位 node）
│   ├── start-keeper.bat / .sh     常驻守护启动入口（Windows / POSIX）
│   ├── engine/
│   │   ├── config.js              配置解析（无硬编码路径）
│   │   ├── cdp.js                 CDP 连接 / 探测 / 脱离式拉起
│   │   ├── launch.js              启动 / 关闭 / 实验实例
│   │   ├── cdp-health.js          CDP 体检（分辨"浏览器级通、页面级挂"）
│   │   ├── keeper.js              常驻守护：持有浏览器 + 定时触发巡检
│   │   └── guardian.js            值守引擎（平台无关）
│   └── adapters/
│       ├── mooc-ctt-cn.js         已适配：中国烟草网络学院
│       └── _template.js           新平台模板
├── references/
│   ├── planning-rules.md          排期与记账规则
│   ├── unattended-ops.md          长时无人值守运维（故障自愈矩阵 / 定时链 / 沙箱）
│   ├── writing-an-adapter.md      新平台适配指南
│   └── platform-mooc-ctt-cn.md    已适配平台实测存档
└── assets/
    ├── plan-input.example.json    排期输入样例
    └── consent.example.json       免责声明确认记录样例
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
