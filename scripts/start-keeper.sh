#!/bin/sh
# start-keeper.sh —— POSIX 入口：启动 keeper.js（常驻守护）
#
# 【它是什么】
#   scripts/engine/keeper.js 的启动包装。做三件事：清代理变量 → 定位 node → exec 守护进程。
#   这是**示例/参考实现**，按你的部署方式改写即可。
#
# 【为什么需要包装脚本，而不是让定时任务直接拼命令行】
#   1) 代理会污染本地连接：环境里若挂着 http_proxy，连 127.0.0.1 的 CDP 端口也会被走代理，
#      报 "upstream connect failed"，极易误判成"端口没开"。清代理要用**自己可控的** unset。
#   2) 某些机器上 `env` 本身是坏的 shim（会静默吞掉子进程：退出码 0、输出全空、目标一行都不执行）。
#      所以**不要写 `env -u http_proxy ... node x.js`**，要在脚本内 unset。
#   3) 某些受限沙箱会禁命名管道，导致浏览器渲染进程冻结（窗口白屏、页面级 CDP 命令永不返回）。
#      那种环境下要让受管浏览器跑在沙箱之外（由用户在桌面环境启动），本包装脚本留在沙箱内即可：
#      它由 TCP 连 127.0.0.1 的 CDP，不受影响。用 cdp-health.js 可以一眼分辨这类故障。
#
# 【用法】
#   sh scripts/start-keeper.sh [传给 keeper.js 的额外参数]
#   AUTOPILOT_DIR=/path/to/runtime sh scripts/start-keeper.sh
#
# 【环境变量】
#   AUTOPILOT_DIR    运行时目录（默认 = $HOME/.course-autopilot，与 config.js 一致；
#                    若宿主沙箱只允许写工作区，就把它指到工作区里，例如 ./run）
#   AUTOPILOT_ADAPTER / AUTOPILOT_INTERVAL_MIN 等：见 keeper.js --help
#   NODE_BIN         指定 node 可执行文件（默认 PATH 上的 node）
#
# 产出（运行时目录内）：keeper.log / keeper-heartbeat.json / browser-pid.json / guardian-round.log

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1

# --- 清代理：必须在脚本内 unset，不能依赖 env ---
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY

# --- 运行时目录：默认与 config.js 一致（~/.course-autopilot），可用 AUTOPILOT_DIR 覆盖 ---
AUTOPILOT_DIR=${AUTOPILOT_DIR:-$HOME/.course-autopilot}
export AUTOPILOT_DIR

# --- 定位 node：显式指定 > PATH ---
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
else
  echo "start-keeper: 找不到 node 可执行文件，请安装 Node.js 18+ 或设置 NODE_BIN" >&2
  exit 1
fi

KEEPER="$HERE/engine/keeper.js"
if [ ! -f "$KEEPER" ]; then
  echo "start-keeper: 找不到 $KEEPER（请从技能的 scripts 目录运行本脚本）" >&2
  exit 1
fi

echo "start-keeper: node=$NODE"
echo "start-keeper: keeper=$KEEPER"
echo "start-keeper: dir=$AUTOPILOT_DIR"
echo "start-keeper: 前台常驻；日志见 $AUTOPILOT_DIR/keeper.log，中断用 Ctrl-C"

exec "$NODE" "$KEEPER" --dir "$AUTOPILOT_DIR" "$@"
