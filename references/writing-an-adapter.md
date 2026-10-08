# 为新平台写适配器

引擎（`scripts/engine/guardian.js`）不含任何平台选择器。换平台 = 新增一个
`scripts/adapters/<id>.js`，引擎代码一行不改。

## 一、流程

```
1. 起受管浏览器 → 手工登录一次
      node scripts/engine/launch.js
2. 逐项侦察（每个字段都要实测，不许猜）
      node scripts/probe.js tabs / video / credit / cards / modals / nav
      # 想批量盘点专题库（重排期时要用）：
      node scripts/recon-subjects.js catalog --pages 6
      node scripts/recon-subjects.js subject "<某个专题详情页 URL>"
3. 复制模板填空
      cp scripts/adapters/_template.js scripts/adapters/<平台id>.js
4. 单轮试跑（先加 --no-launch，避免它自己开浏览器）
      node scripts/engine/guardian.js --adapter <平台id> --dir <运行时目录> --no-launch
5. 把实测细节写进 references/platform-<平台id>.md，避免下次重新探测
```

## 二、每个字段怎么测

| 字段 | 测法 |
|---|---|
| `routing.subject` / `.course` | 打开专题页和课程页，看 URL 里稳定的那一段；**不要把 uuid 写死在正则里** |
| `routing.subjectId` | 从专题 URL 里抓唯一 id 的捕获组。**必须有** —— 标签页选取靠它精确匹配 |
| `routing.fullCourse` | 从课程页 URL 里找"更完整"的判断依据，用于给标签页打分 |
| `loginHint` | 退出登录看 URL 变成什么，通常是 `/oauth` / `/login` / `/sso` |
| `startTexts` | `probe.js cards` 会把所有含"开始学习/继续学习"的入口连同祖先链列出来 |
| `cardSelectors` | 看 `probe.js cards` 输出的 `ancestors`：哪个祖先节点的 `innerText` 恰好包含"课程名 + 修别 + 入口按钮"，就是它 |
| `requiredMarker` | 看卡片文本里修别的书写形式，如 `[必修]` / `（必修）` / `必修课`。捕获组 1 必须是修别 |
| `credit.self` / `.central` | `probe.js credit` 会把所有像学时面板的节点连类名一起列出来。**必须能配 `([\d.]+)\s*\/\s*([\d.]+)` 解析出「要求 / 已完成」** |
| `confirmWords` | 触发一次弹窗，读它的按钮文案 |
| `subjectNameHint` | 专题名里稳定的字，通常是"专题" |

## 三、三个"必须"（都是血的教训）

### 1. 「打标记」不等于「点击」

`page.evaluate()` 里 `setAttribute('data-x','1')` + `scrollIntoView()` **不会触发任何点击**。
如果函数叫 `clickXxx()` 却只做了标记，UI 上表现为"脚本报告成功找到目标，但页面毫无反应"，
**且因为不报错，可以一路潜伏到关键时刻才爆**（实测潜伏了 1.5 小时，直到需要自动切下一门时才暴露）。

规矩：定位用 `evaluate`（打标记 + `scrollIntoView`），点击必须在**同一函数内**紧跟一步真实动作：
`page.click('[data-x="1"]')`（真手势，走 CDP Input 域），失败再兜底
`evaluate(() => el.click())`（原生事件，Vue/React 的 `@click` 能收到）。
用完立刻 `removeAttribute` 清标记，且**每次进入前先清一遍旧标记**，否则重试时会点到上一轮的元素。

### 2. 匹配不到目标时，**绝不 fallback 到第一个匹配项**

在"列表 → 逐项处理"场景里，fallback 会静默点到第一项（常常是已完成的项），
产生难以察觉的逻辑错误。**宁可返回 `null` 报错。**

同理，标签页选取**绝不能"取第一个匹配"**：探索时留下的废弃页会被优先选中 →
读到没有 `<video>` 的页面 → 误报 NEED_HELP；更糟的是取错专题页时，**点"开始学习"会点到别的专题去**。
正确做法是用当前专题 id 精确匹配 + 打分（`pickStudyPage`：3 = 含当前 id 且路径完整 / 2 = 含当前 id /
1 = 页面里真有 `<video>` / 0 = 其它；同分取最后一个，通常是最新打开的）。
**并且每一轮都要用最新 state 重新选一遍**——state 可能在初始化之后才生成。

### 3. 文本匹配要做空白归一化

SPA 渲染的空格很不可靠，常有全角空格。用 `norm()`（去掉所有空白含全角空格 `\u3000`）再比较。

## 四、适配器不是万能的

以下情况需要改引擎（`engine/guardian.js`），别硬塞进适配器：
- 学时面板**不是**「要求 / 已完成」格式（如顺序相反、或需要先切页签才能看到）
- 课程不是"卡片列表 + 入口按钮"结构（如树形目录、需要展开章节）
- 视频不是页面里的 `<video>`（如自研播放器 / 需要 iframe 内定位）

改之前先确认：是"引擎缺少抽象"，还是"这个平台特殊"。前者加适配器字段，后者在适配器里放
平台专属函数、由引擎按存在性调用（如 `adapter.beforeResume?.(page)`）。

## 五、"假设成立"要先验证

实测教训：某平台脚本里的 `clickCourseByName()` 从 12:07 存在到 13:25，中间 13 轮巡检全部输出
`STATUS:PLAYING` 看起来一切正常 —— 因为**那条代码路径一直没被走到**（首门课程是手动点开的）。

**链路上"没走到的分支"等于"没验证过的分支"。** 首次真实触发前不要假定它可用。
所以：新适配器上线的第一轮，务必**人为制造一次"课程播完 → 切下一门"**，确认这条路径真的通。
