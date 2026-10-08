# AUTO-MOOCCTT

> 自动值守完成在线学习平台（mooc-ctt-cn）**学时任务**的 Agent Skill。
> 技能内部标识：`course-hours-autopilot`，**只面向 mooc.ctt.cn 一个平台**。

## 这是干什么的

把「凑够平台学时」这件事，变成**配置一次、长期自动完成**。

- 你先确认一次免责声明，再在受管浏览器里**手工登录一次**；
- 之后由确定性引擎自动播放课程 —— 被暂停自动恢复、弹窗自动关掉、一门播完自动切下一门、
  一个专题播完自动切下一个专题；浏览器崩了自动拉起，定时链断了自动修复；
- Agent 按固定节奏唤醒模型，读证据、发现异常就修（改适配器 / 改脚本 / 通知你），
  直到**平台学时真正达标**才收工。

**分工**：Skill 提供脚本与探测方法 → 模型探测页面并完善脚本 → 引擎做长时间稳定执行。

## ⚠️ 免责声明（首次运行必读）

本技能用自动化方式代替人工观看课程，属于对目标平台规则的规避行为：

1. 可能违反目标平台的用户协议，以及你所在单位的相关管理规定；
2. 可能导致账号被限制、学习记录或学时被判定无效、已获学时被撤销；
3. 平台改版或风控升级可能导致任务中途失败，本技能不保证一定达标；
4. 运行时会另起独立浏览器实例并保存登录态（含凭证）——**运行时目录请勿提交到仓库或分享**；
5. 因使用本技能产生的一切后果由使用者自负。

**Agent 在开始前会先把这段声明出示给你并要求确认**（见 `SKILL.md` 阶段 0）。
未确认前它不会启动浏览器、不会排期、不会挂定时任务。确认之后它就不再反复征求操作许可，
只在「需要你本人登录/扫码」或「断电断网」时才会来找你。

## 怎么用

```sh
npm i puppeteer-core                  # 唯一依赖；复用本机 Edge/Chrome，不下载浏览器

# 0) 先确认免责声明 —— Agent 会出示，你回复「确认」即可（会记到 consent.json）

node scripts/engine/launch.js         # 1) 起受管浏览器，首次在里面手工登录一次
node scripts/probe.js credit          # 2) 侦察平台（学时面板 / 课程卡片 / 弹窗 / 导航）

# 3) 参考 assets/plan-input.example.json 填好 plan-input.json，然后排期：
node scripts/plan.js --in plan-input.json --out .

# 4) 单轮验证，确认末行 STATUS 合理：
node scripts/engine/guardian.js --dir . --adapter mooc-ctt-cn

# 5a) 让浏览器"有人一直拿着"（否则跑完一轮进程一退，浏览器就被回收）：
#     Windows 双击 scripts/start-keeper.bat；macOS/Linux 跑 sh scripts/start-keeper.sh
# 5b) 再交给宿主 Agent 的定时任务周期性唤醒模型（15 分钟主巡检 + 每小时兜底）
```

完整流程、STATUS 契约、无人值守部署、**每轮唤醒模型该做什么**，见 [`SKILL.md`](SKILL.md)；
沙箱/长命进程/跨平台这些容易卡住的地方见 SKILL.md「执行环境」一节与
[`references/unattended-ops.md`](references/unattended-ops.md)。

## 懒得自己敲命令？把这段话发给你的 Agent

本项目本来就是给 Agent 用的，你完全可以把下面这段原样复制给支持**技能安装 + 定时任务**的 Agent，
让它替你配置：

```text
请帮我安装并配置这个 Skill：https://github.com/xiaoyi198/AUTO-MOOCCTT

要求：
1. 先把免责声明原样出示给我，等我回复「确认」之后再动手；并把确认记录写到运行时目录的
   consent.json（之后不要再反复问我同类许可）。
2. 完整读一遍仓库里的 SKILL.md 和 references/ 下的文档，按它的流程来，不要凭猜测操作。
3. 装依赖（npm i puppeteer-core），确认本机有 Edge/Chrome/Chromium 可用。
4. 起受管浏览器（node scripts/engine/launch.js），然后叫我手工登录一次目标平台。
5. 我登录完，你用 probe.js 侦察平台，核对/完善 scripts/adapters/ 里的适配器。
6. 帮我填好 plan-input.json 并跑 plan.js 排期，把 plan.md 给我确认后再开跑。
   排期前先按 SKILL.md 铁律 9 用学时读数历史证实平台的记账规则，不要照抄文档里的假设。
7. 先单轮验证（node scripts/engine/guardian.js --dir . --adapter mooc-ctt-cn），
   确认末行 STATUS 合理再部署；验证不过就先修，不要急着挂定时。
8. 把常驻 keeper 起起来（Windows 双击 scripts/start-keeper.bat），告诉我那个窗口不要关；
   如果本机有沙箱/权限限制导致浏览器起不来，按 SKILL.md「执行环境」一节处理。
9. 之后按 SKILL.md 的部署方式跑：每 15 分钟一次主巡检 + 每小时一条独立兜底。
   只有 STATUS:ALL_DONE（学时真正达标）才停；TARGET_NOT_REACHED 要接着补专题或修脚本；
   NEED_HELP 先重跑一次，仍失败再来找我。
10. 需要扫码 / 验证码 / 重新登录这种我才能做的事，直接告诉我，别自己硬试。
```

## 环境要求

- Node.js ≥ 18
- 本机已安装 Edge / Chrome / Chromium
- `puppeteer-core`
- Windows 上建议直接双击 `.bat` 启动常驻守护（进程归桌面会话，不受 Agent 沙箱管辖）

## 目录

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 技能主文档（免责声明确认 / 工作流 / 铁律 / STATUS 契约 / 模型值守协议） |
| `scripts/plan.js` | 排期器（纯计算，可反复重跑） |
| `scripts/probe.js` | 平台侦察工具 |
| `scripts/recon-subjects.js` | 专题库盘点示例（重排期时用） |
| `scripts/engine/` | 配置解析 / CDP / 启动 / CDP 体检 / 常驻守护 / 值守引擎 |
| `scripts/start-keeper.bat` `.sh` | 常驻守护启动入口 |
| `scripts/adapters/` | 平台适配器（唯一与具体平台耦合的地方） |
| `scripts/run-guardian.sh` | 巡检包装（POSIX；清代理 + 定位 node） |
| `references/` | 排期规则 / 无人值守运维 / 适配器指南 / 平台存档 |
| `assets/` | 排期输入样例、免责声明确认记录样例（全部为占位数据） |

## 说明

- 只面向**单一特定平台**，不做通用多平台抽象。
- 运行时会生成 `browser-profile/`（内含登录态）、`consent.json` 以及状态 / 日志 / 锁文件，
  已全部写进 `.gitignore`，**请勿提交** —— 那里面带有你的登录凭证。
