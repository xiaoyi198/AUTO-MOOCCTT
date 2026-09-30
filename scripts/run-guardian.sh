#!/bin/sh
# run-guardian.sh —— 巡检包装脚本
#
# 为什么需要包装脚本，而不是让定时任务直接拼命令行：
#
# 1) 代理会污染本地连接。环境里若挂着 HTTP_PROXY，连 127.0.0.1 的 CDP 端口也会被走代理，
#    报 "upstream connect failed"，极易误判成"端口没开"。清代理要放在**自己可控的脚本内**用 unset。
#
# 2) 某些机器上 `env` 本身是坏的 shim（实测 /c/Users/<user>/.local/bin/env 会**静默吞掉子进程**：
#    退出码 0、stdout/stderr 全空、目标脚本一行都不执行）。所以**不要用 `env -u http_proxy ... node x.js`**。
#    判断方法：命令正常但毫无输出、且日志文件 mtime 未变 —— 就是撞上这个 shim 了。
#
# 用法：
#   sh run-guardian.sh [--adapter <id>] [--dir <运行时目录>] [--port <端口>]
#
# 环境变量：
#   AUTOPILOT_DIR / AUTOPILOT_ADAPTER / AUTOPILOT_CDP_PORT
#   NODE_BIN      指定 node 可执行文件（默认自动探测）

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1

# --- 清代理：必须在脚本内 unset，不能依赖 env ---
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY all_proxy ALL_PROXY

# --- 定位 node：显式指定 > PATH > WorkBuddy 托管目录 ---
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
else
  NODE=""
  for cand in "$HOME"/.workbuddy/binaries/node/versions/*/node.exe \
              "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$cand" ] && NODE="$cand" && break
  done
  if [ -z "$NODE" ]; then
    echo "STATUS:ERROR:找不到 node 可执行文件，请设置 NODE_BIN 环境变量"
    exit 0
  fi
fi

exec "$NODE" "$HERE/engine/guardian.js" "$@"
