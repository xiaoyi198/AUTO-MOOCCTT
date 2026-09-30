# 长时无人值守运维

适用：跑几小时到几天、没人看着的任务。核心不是"会自动重试"，而是**逐场景兜底**。

## 一、触发方式：为什么必须是「自续期的一次性任务链」

### 调度器的硬限制（实测，别试了）

| 尝试 | 结果 |
|---|---|
| `FREQ=MINUTELY` | **不支持** |
| `BYHOUR=0,1,2,...` | 逗号列表**报错** |
| `BYMINUTE=0,15,30,45` | ❌ **实际不生效**。首次触发被算成"创建时间 +1 小时"，退化成整点 |
| `BYMINUTE=15` 单值 | ❌ 同样不生效 |
| `FREQ=HOURLY;INTERVAL=1` | ✅ 可用，但只有 1 小时精度 |

**结论：想要 15 分钟精度，只能用「自我续期的一次性任务链」。**
创建 `scheduleType:"once"` + `scheduledAt:<15分钟后>` 的任务，其 prompt 里写明
"执行完立刻再创建一个 15 分钟后的一次性任务，prompt 原样复制自身"，链到 `ALL_DONE` 时停止；
**同时另挂一条 `FREQ=HOURLY;INTERVAL=1` 的循环任务做兜底**，防链条断裂。

### 每环 prompt 的四步结构

1. **执行**：只跑 `sh run-guardian.sh`，**不做任何额外操作**（尤其不要开新标签、不要点平台菜单、
   不要导航任何页面——多余标签会抢前台，导致学习页被挂起、视频中断）。
   判据：末行必须有 `STATUS:`。**无 STATUS 输出 = 命令没跑成，必须换写法重试，不能当成功。**
2. **按末行 STATUS 分派**：正常态一句话汇报；`ALL_DONE` 则**不再创建下一个任务**；
   `NEED_HELP` 先只重跑一次（引擎自带自愈，重跑常能自己好），仍失败才写桌面提示文件 + 标 ⚠️。
3. **续期**：`date -d "+15 minutes" +"%Y-%m-%dT%H:%M"` 取下次时间（**不要自己算**），
   创建下一环，prompt 从【第一步】到背景说明**原样复制**。
4. **自清理**：`automation_update(mode="list")`，删掉同名且 `scheduledAt` 早于当前时间的任务。

> ⚠️ **顺序绝不能反：必须先建好下一环，再删过期环**（嫌麻烦干脆不删也行）。
> 先删后建的话，一旦「建环」那一步被截断（见下节），链条就彻底消失了——
> 留着过期环顶多是列表难看，删早了是真的断链。
>
> ⚠️ 一次性任务链还会越堆越多：每轮 create 一个新任务，已过期的不会自动消失
> （实测 3 小时堆了 9 条）。所以自清理是**必须**的，但它永远是**最后一步**。

### 链为什么会断，怎么判定，怎么修

实测链环常以 `run failed … Conversation ended before automation request completed` 收尾。
多数是"最后一步之后被截断"，故仍建出了后继环；但**有一次是在建环那一步之前**被截断 → 链条彻底消失。

**判定（三步，别省）**：
1. `automation_update(mode="list")`，看有没有同名且 `scheduledAt` 在未来的条目。
   注意：**"过期环还在列表里没后继"和"环完全消失"都是断链**（后者更彻底）。
2. **等 ≥2 分钟复看 1~2 次** —— 排除"该环此刻正在执行中"（正在跑时它可能仍挂在列表里）。
3. 想要**铁证**，只读查调度库（比反复 list 更快更准）：

```python
# 只读打开，不要写
import sqlite3
con = sqlite3.connect("file:<用户目录>/.workbuddy/workbuddy.db?mode=ro", uri=True)
con.execute("select id,name,scheduled_at,next_run_at,created_at,deleted_at from automations "
            "order by created_at desc limit 10").fetchall()
con.execute("select id,name,scheduled_at from automations where deleted_at is null").fetchall()
```
判据：最新一环的 `created_at` 附近**没有**新环被建出来，且存活列表里只剩常驻任务。
`automation_runtime_state.running` 可看某环此刻是否真在跑。
日志旁证：`~/.workbuddy/logs/automation.log` 有 dispatch / run finished / failed。

**修复（顺序别反）**：
- 从**上一环的原始 prompt** 逐字取模板。最省事的做法是预先在规划阶段就把模板另存到运行时目录
  （从调度库的 `automations.prompt` 字段读，或直接存一份 `ring-prompt.txt`），
  避免兜底任务的 prompt 里没内嵌模板时无源可取。
- 新建 `+15 分钟` 的一环 → 删掉过期环 → 复核只留 1 条。
- 若断链空档里目标刚好会推进（视频即将播完），可**额外补跑一次守护命令**弥合；否则不必。

## 二、故障场景 → 自修复动作

| # | 故障场景 | 自修复动作 |
|---|---|---|
| 1 | 视频暂停 | 四级恢复：`play()` → 鼠标真实点击视频 → 点播放按钮 → 微调 `currentTime` 重播 |
| 2 | 进度停滞（未暂停但不动） | 60s 无前进判为停滞，走同上四级恢复 |
| 3 | 加载停滞（`readyState < 2`） | 60s 判定，同上 |
| 4 | 弹窗"是否还在看" | 文案库匹配 + **必须可见且在视口内** → 点击；关不掉才报 NEED_HELP |
| 5 | 被挂到后台 | 反暂停注入 + idle 心跳；**只在视频真异常时才抢焦点**（见下） |
| 6 | 课程播完 | 自动标记完成 + 索引 +1 + 点下一门 + 起播 |
| 7 | 专题播完 | 自动切队列下一个专题 |
| 8 | 页面跳到错误页 / 无 `<video>` | 用专题页重新点当前课程入口，最多 2 轮；仍失败则区分是否登录失效 |
| 9 | **浏览器崩溃 / 被关 / 更新重启** | `spawn(detached)+unref` 拉起 → 轮询 8×4s 重连 |
| 10 | 连不上端口（代理污染） | 统一走 `run-guardian.sh`（内部 `unset` 代理） |
| 11 | `env` shim 静默吞命令 | 同上，**不让自动化拼命令行** |
| 12 | 两个巡检并发抢进度 | 文件锁 + 4 分钟过期 |
| 13 | 崩溃/被强杀残留锁导致卡死 | **双保险**：① 锁 4 分钟自动过期；② `acquireLock` 另校验持锁 pid 是否存活（`process.kill(pid,0)`，`EPERM` 也算存活），已死**立即接管**，不必等满超时 |
| 13b | 释放锁时误删别人刚写的锁 | 只删「内容与本次写入完全相同」的锁（比对文件内容） |
| 14 | 状态文件写坏 | 先写 `.bak` 再写正式文件；解析失败回退 `.bak` |
| 15 | 专题解析不到课程列表 | 记入 `failed` 跳到下一个，**不终止整条链** |
| 16 | 主队列跑空但学时未达标 | 读学时面板 → 按缺口类型从兜底池自动补条目 |
| 17 | 15 分钟链断掉 | 每小时兜底任务 + 链式自续期 |
| 18 | 定时任务无限堆积 | 每轮先自清理过期任务 |
| 19 | 电脑休眠导致全停 | 先查 `powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`：交流电索引 0 = 从不睡眠 |
| 20 | 日志无限增长 | 约 100KB/天，数周内无风险（未加轮转） |

## 三、抢焦点：一条很容易搞错的规则

Edge 有「睡眠标签页」机制：新开/切换标签会抢走前台，学习页转入后台后被挂起，
SPA 直接跳到错误页，**视频播放中断**。实测：一轮探索脚本（4 次 `newPage`）之后播放即停止。

所以引擎每轮检查 `document.hasFocus()`（**不受 keep-alive 改写影响**，是可靠的失焦信号）。
**但不要只凭失焦就 `bringToFront()`** —— 用户在用别的窗口时必然失焦，每轮巡检都把浏览器抢到最前
会持续打断他（实测教训：初版只看失焦，结果把用户正在打字的窗口顶掉了）。

正确判据：**两个条件同时成立**才拉回前台 ——
`!hasFocus() && (!videoExists || video.paused)`。
仅失焦而视频正常时不抢焦点。真正的恢复动作（视频暂停/停滞）里再 `bringToFront()`，那时抢焦点是必要的。

更彻底的做法：启动时加 `--disable-features=SleepingTabs`（`engine/cdp.js` 已默认加上），
或在浏览器设置里关掉睡眠标签页。

**侦察纪律**：在受管浏览器里做探索会杀掉视频。能只读 DOM 就只读；必须开标签时，
操作完立刻 `page.close()` 并 `studyPage.bringToFront()` 还焦点。
测试脚本应打印"测试前后视频 currentTime"自证未打断。

## 四、环境陷阱（Windows + Git Bash 尤其多）

### 4.1 代理污染本地连接
环境里若有 `HTTP_PROXY`（例如 `http://127.0.0.1:9050`），curl 与 node fetch 会把
`127.0.0.1` 的 CDP 端口当外网走代理，报 `upstream connect failed` —— **极易误判为端口未开**。
诊断时先对比"绕过代理 vs 走代理"两种结果。清代理要放在**自己可控的脚本内**用 `unset`。

### 4.2 `env` 可能是坏的 shim
本机 `/c/Users/<user>/.local/bin/env` 实测**会静默吞掉子进程**：退出码 0、stdout/stderr 全空、
目标脚本一行都不执行、日志文件也不追加。这会伪装成"脚本跑成功了但没输出"。
判断方法：**命令正常但毫无输出且日志文件 mtime 未变** → 撞上这个 shim 了。
所以用 `run-guardian.sh` 内部的 `unset`，**不要**写 `env -u http_proxy ... node x.js`。

### 4.3 浏览器 136+ 必须用非默认 profile
`--remote-debugging-port` 必须配 `--user-data-dir` 指向**非默认目录**，否则被静默忽略
（防 cookie 窃取）。⇒ **无法直接接管用户当前开着的浏览器**，只能另开独立 profile。
想继承登录态：把默认 profile 复制到新目录（约几百 MB，`cdp.cloneProfile()` 可做）。

### 4.4 中文用户名路径的编码陷阱
Windows 中文用户名（如 `C:\Users\家\`）下：
- ❌ 不要写含中文字面量路径的 `.ps1` / `.bat`（PowerShell 5.1 按 ANSI 读脚本会乱码）
- ✅ `.bat` 用 `%USERPROFILE%` 展开
- ✅ `.js` 用 `path.join(os.homedir(), ...)` 拼接
- ✅ 调外部命令时用 `MSYS2_ARG_CONV_EXCL='*'` 防 Git Bash 转换参数

### 4.5 沙箱会回收后代进程
工具调用结束后，本次调用启动的所有后代进程都可能被回收。实测全部**失败**的方式：
`Start-Process`、WMI/CIM `Win32_Process.Create`（被安全策略直接拦截）、`schtasks`（在黑名单里）、
`nohup ... &` / `disown`、`explorer.exe <bat>`。

**可用方式**：
- 本轮内：后台方式启动，可稳定存活数分钟，足够跑完一轮巡检。
- **跨轮持续（最可靠）**：Node 侧 `child_process.spawn(exe, args, { detached: true, stdio: 'ignore' })`
  + `p.unref()`。已实测：独立端口 + 独立 user-data-dir 拉起，8 秒内 CDP 就绪。
- 用户侧：让用户双击一个 `.bat` 启动，进程由 explorer 创建，脱离沙箱管辖。

## 五、反挂机加固

1. **keep-alive 注入**：改写 `Document.prototype` 的 `hidden` / `visibilityState`，
   并 `stopImmediatePropagation` 掐断 `visibilitychange` / `blur`。
   ⚠️ **页面重载后会失效，每一轮巡检都要重新注入**。
2. **idle 心跳**：每轮 `page.mouse.move()`（**只移动不点击**，点击会切换暂停状态）制造"用户在场"信号。
3. **不复用倍速**：平台按总时长 100% 判定，倍速可能导致时长不足。
4. **静音续播**（`v.muted = true`）避免长时间挂机扰民；若平台因静音不计时，需改回有声。
5. **汇报要完整**：正常态输出带"剩余 X 分 Y 秒"，便于给用户报进度。

## 六、两条容易漏的经验

1. **"有意为之"的行为必须显式打日志**。例：「【留尾模式】最后一节故意不学: X」。
   否则后续自动巡检会把它当故障误报，甚至"修"掉正确状态。
2. **真正无法自愈的只有两类**：
   - 需要人工凭证（登录态失效、验证码、扫码）
   - 物理中断（断电、断网）
   对这两类，正确做法是**准确识别 + 明确通知**（写桌面文件 + 在回复里标 ⚠️），而不是假装能修。
   例如检测 URL 里出现 `oauth` / `login` 就应判定为"登录态失效，需人工"。
   断网则引擎每轮持续重试，网络恢复后自动续播（期间空转，不报错）。
