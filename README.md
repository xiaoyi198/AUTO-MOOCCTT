# course-hours-autopilot

模型辅助型「学时自动化值守」Skill。

- **平台定位**：面向**单一特定平台**（见 `scripts/adapters/`），不做通用多平台抽象。
- **分工**：Skill 提供示例脚本 + 探测方法 + 故障处理规则；**模型**负责首次探测、完善脚本、异常修复；
  **确定性引擎**（`scripts/engine/guardian.js`）负责长时间稳定执行。
- **调度**：由宿主 Agent 的定时能力驱动「15 分钟主巡检 + 1 小时兜底巡检」，
  期间任何异常都会唤醒模型修复，直到平台学时**真正达标**才停止。

完整说明见 **[SKILL.md](SKILL.md)**。

> ⚠️ **免责声明**
> 本 Skill 以自动化方式代替人工观看课程，属于对目标平台规则的规避。
> 请自行确认是否违反目标平台的用户协议以及你所在单位的相关规定。
> 因使用本 Skill 产生的一切后果由使用者自负。

## 目录

| 路径 | 作用 |
|---|---|
| `SKILL.md` | 技能主文档（工作流 / 铁律 / STATUS 契约） |
| `scripts/plan.js` | 排期器（纯计算，可反复重跑） |
| `scripts/probe.js` | 平台侦察工具 |
| `scripts/engine/` | 配置解析 / CDP / 启动 / 值守引擎 |
| `scripts/adapters/` | 平台适配器（唯一与具体平台耦合的地方） |
| `scripts/run-guardian.sh` | 巡检包装（清代理 + 定位 node） |
| `references/` | 排期规则 / 无人值守运维 / 适配器指南 / 平台存档 |
| `assets/` | 排期输入样例（**已脱敏**，全部为占位数据） |

## 环境要求

- Node.js ≥ 18
- 本机已安装 Edge / Chrome / Chromium（本 Skill **不下载**浏览器）
- `npm i puppeteer-core`

## 快速开始

```sh
npm i puppeteer-core
node scripts/engine/launch.js     # 起受管浏览器，首次手工登录一次
node scripts/probe.js credit      # 探测学时面板
# 按实情填写 plan-input.json（参考 assets/plan-input.example.json）后排期
node scripts/plan.js --in plan-input.json --out .
# 单轮验证
sh scripts/run-guardian.sh --dir . --no-launch
```

详细流程、STATUS 契约与无人值守部署见 [`SKILL.md`](SKILL.md) 与 `references/`。
