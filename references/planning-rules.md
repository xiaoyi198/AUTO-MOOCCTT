# 排期与记账规则

本文说明「学时目标」怎么变成「一份可执行队列」。对应实现：`scripts/plan.js`。

## 一、输入格式

```jsonc
{
  "targets": [
    { "key": "selfStudy", "label": "网络自学（时）", "target": 50, "done": 12.5 },
    { "key": "central",   "label": "集中培训（时）", "target": 90, "done": 30.0 }
  ],
  "settlement": {
    "fullGoesTo": "central",          // 学完整专题 → 计入哪个口径
    "holdLastGoesTo": "selfStudy",    // 留最后一个章节不学 → 计入哪个口径
    "holdLastContribution": "whole"   // 可选：whole（默认，整专题全计）| completedOnly（只计看完的）
  },
  "catalog": [
    {
      "name": "示例专题 A",
      "hash": "#/study/subject/detail/00000000-0000-4000-8000-000000000001",
      "hours": 25.4,             // 平台标注的总学时
      "eligibleHours": 25.4,     // 实际能计入的学时；省略则等于 hours
      "requiredCourses": 15,     // 必修门数（completedOnly 口径要用）
      "actualVideoHours": 22,    // 实测播放时长，用于算性价比；未知则省略
      "preference": "auto"       // auto(默认) | full | holdLast | skip
    }
  ],
  "fallback": [ /* 同结构。主清单用尽后才启用 */ ],
  "options": {
    "minutesPerCreditHour": 50,
    "defaultCreditsPerVideoHour": 1.0,
    "checkIntervalMinutes": 15
  }
}
```

## 二、两个必须实测的字段

**`eligibleHours` ≠ `hours`，这是最容易白干的地方。**

平台常把选修门槛设成「完成 0 学时以上」——即**选修完全不用做**。但页面标题上的总学时是
必修+选修之和。实测例：某专题标注「必修2门 (6.1学时)，选修14门 (17.8学时；完成0学时以上)」，
真实可计入只有 **6.1**，不是 23.9。若照 23.9 排期，会白学 17.8 学时（约 18 小时）。

判定方法：看专题页「必修N门」那一行，若选修写「完成0学时以上」，则
`eligibleHours = 必修学时`。同时把 `requiredCourses` 填必修门数。

**`actualVideoHours` 决定性价比排序，也是"多久能跑完"的唯一可信依据。**

平台**按专题声明学时结算，与逐帧观看时长无关**（已实证：三个专题页面标注学时之和
与学时面板增量完全吻合）。所以「学时 ÷ 实际视频时长」越高的专题越划算。实测区间：

| 专题 | 学时 | 实际播放 | 比值 |
|---|---:|---:|---:|
| 示例专题甲 | 20 | 14.6 h | **1.37** 学时/小时 |
| 示例专题乙 | 5.6 | 4.9 h | 1.14 |
| 示例专题丙 | 5.6 | 5.4 h | 1.04 |

即：同样凑 50 学时，挑最优专题比最差专题能**省下约 25% 的挂机时间**。
未实测的专题留空即可，plan.js 会用 `defaultCreditsPerVideoHour` 兜底并标注"未实测"。

## 三、算法行为

1. 按缺口降序处理各口径（缺口大的先排）。
2. 每个口径只吃**归属于它**的专题：`full` 模式吃 `fullGoesTo`，`holdLast` 吃 `holdLastGoesTo`。
   专题的 `preference` 若非 `auto`，则以它为准。
3. 候选按「性价比降序 → 学时降序」排序；性价比未知的排在有数据的之后。
   **两趟推进**：先把主清单 `catalog` 吃干净，仍缺才动用 `fallback`。兜底池是储备，
   不允许被体量大的条目插队抢占。
4. 学时贡献为 0 的专题不排（学完也没用）。`preference: "skip"` 直接排除。
5. 填不满就**明确报缺口**（`shortfall`），不假装能完成。
6. 每个入选条目都带 `reason`，落选条目带 `why` —— 排期必须可解释，否则用户无法判断对错。

## 四、留尾模式（学时归集技巧）

平台常按「专题是否整体完成」把学时分流到不同口径。要让某专题走另一个口径，就
**故意留最后一个章节不学**，使专题保持未完成态。

实现要点（`engine/guardian.js` 已内置）：
- 扫描出课程列表后，**把最后一门课从待学列表里 splice 掉**。
  不要用"播到最后一节再停"——课程内章节会自动续播，播到最后一节往往来不及停。
- 两道护栏：
  ① 每轮巡检若发现页面进入了留空课程（且当前**所有待学课程名一个都不出现**，避免误伤），
     立即 `video.pause()`；
  ② 专题收尾时先暂停再切专题，防止平台自动续播。
- 该模式属于**有意为之**，必须在日志里显式写「【留尾模式】最后一节故意不学: X」。
  否则后续巡检会把它当故障误报，甚至"修"掉正确状态。

## 五、⚠️ 未验证假设：留尾贡献口径

`holdLastContribution` 的两种可能：

| 取值 | 含义 | 对应假设 |
|---|---|---|
| `whole`（默认） | 留尾专题的**全部学时**都进 `holdLastGoesTo` | H2 |
| `completedOnly` | 只计已看完那几门的学时（均摊扣掉最后一门） | H1 |

plan.js 会在 `assumptionWarning` 里标出这一点，规划书也会打印。

**首专题收尾后必须实测核对**：看学时面板增量，与预期归属比对。
- 若留尾专题学时全额进账 → `whole` 正确，继续。
- 若没进账或只进了一部分 → 改成 `completedOnly` 重跑 plan.js，并按新队列继续。

判断方法：plane 输出 `credit-baseline.json` 记了基线；引擎每轮把学时读数落盘到
`credit-history.jsonl`（变化才写，含时间戳）。拿两个时点相减即可归因。
**不要用"感觉快了"当依据。**

## 六、验收

任务结束时对照 `credit-baseline.json`：

1. 读一遍目标口径，确认 `done >= target`。
2. 若未达标，看 `shortfall` 是不是排期时就预告过的缺口（那是库不够，不是执行失败）。
3. 核对 `subject-queue.json` 的 `finished` 列表与 `failed` 列表，确认没有静默跳过。
