# AUTO-MOOCCTT

> 自动值守完成在线学习平台（mooc-ctt-cn）**学时任务**的 Agent Skill。
> 技能内部标识：`course-hours-autopilot`

## 这是干什么的

把「凑够平台学时」这件事，变成**配置一次、长期自动完成**。

- 你在受管浏览器里**手工登录一次**；
- 之后由确定性引擎自动播放课程 —— 被暂停自动恢复、弹窗自动关掉、一门播完自动切下一门、
  一个专题播完自动切下一个专题；浏览器崩了自动拉起，定时链断了自动修复；
- Agent 按固定节奏唤醒模型，读证据、发现异常就修（改适配器 / 改脚本 / 通知你），
  直到**平台学时真正达标**才收工。

**分工**：Skill 提供示例脚本与探测方法 → 模型探测页面并完善脚本 → 引擎做长时间稳定执行。

## 怎么用

```sh
npm i puppeteer-core                  # 唯一依赖；复用本机 Edge/Chrome，不下载浏览器

node scripts/engine/launch.js         # 1) 起受管浏览器，首次在里面手工登录一次
node scripts/probe.js credit          # 2) 侦察平台（学时面板 / 课程卡片 / 弹窗 / 导航）

# 3) 参考 assets/plan-input.example.json 填好 plan-input.json，然后排期：
node scripts/plan.js --in plan-input.json --out .

# 4) 单轮验证，确认末行 STATUS 合理：
sh scripts/run-guardian.sh --dir . --no-launch

# 5) 验证通过后，交给 Agent 的定时任务循环调用
#    （15 分钟主巡检 + 每小时一条独立兜底）
```

完整流程、STATUS 契约、无人值守部署、**每轮唤醒模型该做什么**，见 [`SKILL.md`](SKILL.md)。

## 懒得自己敲命令？把这段话发给你的 Agent

本项目本来就是给 Agent 用的，你完全可以把下面这段原样复制给支持**技能安装 + 定时任务**的 Agent（例如 WorkBuddy / DSH），让它替你配置：

```text
请帮我安装并配置这个 Skill：https://github.com/xiaoyi198/AUTO-MOOCCTT

要求：
1. 先完整读一遍仓库里的 SKILL.md 和 references/ 下的文档，按它的流程来，不要凭猜测操作。
2. 装依赖（npm i puppeteer-core），确认本机有 Edge/Chrome/Chromium 可用。
3. 起受管浏览器（node scripts/engine/launch.js），然后叫我手工登录一次目标平台。
4. 我登录完，你用 probe.js 侦察平台，核对/完善 scripts/adapters/ 里的适配器。
5. 帮我填好 plan-input.json 并跑 plan.js 排期，把 plan.md 给我确认后再开跑。
6. 先单轮验证（sh scripts/run-guardian.sh --dir . --no-launch），确认末行 STATUS 合理
   再部署定时任务；验证不过就先修，不要急着挂定时。
7. 之后按 SKILL.md 的部署方式跑：每 15 分钟一次主巡检 + 每小时一条独立兜底。
   只有 STATUS:ALL_DONE（学时真正达标）才停；TARGET_NOT_REACHED 要接着补专题或修脚本；
   NEED_HELP 先重跑一次，仍失败再来找我。
8. 需要扫码 / 验证码 / 重新登录这种我才能做的事，直接告诉我，别自己硬试。
```

Agent 会把「探测 → 完善脚本 → 单轮验证 → 定时值守」这套走完，你只需要在它叫你登录的时候露个面。

## 环境要求

- Node.js ≥ 18
- 本机已安装 Edge / Chrome / Chromium
- `puppeteer-core`

## 目录

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 技能主文档（工作流 / 铁律 / STATUS 契约 / 模型值守协议） |
| `scripts/plan.js` | 排期器（纯计算，可反复重跑） |
| `scripts/probe.js` | 平台侦察工具 |
| `scripts/engine/` | 配置解析 / CDP / 启动 / 值守引擎 |
| `scripts/adapters/` | 平台适配器（唯一与具体平台耦合的地方） |
| `scripts/run-guardian.sh` | 巡检包装（清代理 + 定位 node） |
| `references/` | 排期规则 / 无人值守运维 / 适配器指南 / 平台存档 |
| `assets/` | 排期输入样例（已脱敏，全部为占位数据） |

## 说明

- 只面向**单一特定平台**，不做通用多平台抽象。
- 运行时会生成 `browser-profile/`（内含登录态）以及状态 / 日志 / 锁文件，已全部写进 `.gitignore`，
  **请勿提交** —— 那里面带有你的登录凭证。

## 免责声明

本项目以自动化方式代替人工观看课程，属于对目标平台规则的规避。
请自行确认是否违反目标平台的用户协议以及你所在单位的相关规定；
因使用本项目产生的一切后果由使用者自负。
