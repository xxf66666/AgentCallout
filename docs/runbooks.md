# 故障恢复 Runbook

三类已知安装/运行故障的逐步恢复。每条先给判断依据，再给操作；操作后都应运行 `agent-callout doctor --self-test --json` 复核。

## 1. 修订锁残留（malformed canonical / 强杀进程）

**判断**：`revise` 报 `REVISION_RECOVERY_REQUIRED` 或 `REVISION_CONFLICT`（错误信息含持有者 pid）。锁文件为 sidecar 同目录的 `.agent-callout-lock`。

**恢复**：

1. 确认持有者进程确实不存在：错误信息中的 pid 若无对应 `agent-callout` 进程（`ps -p <pid>`），即为残留；
2. 删除锁文件：`rm <sidecar 目录>/.agent-callout-lock`；
3. 若同目录存在孤儿 `.tmp` 输出文件，可安全删除；已发布的 `.revN` PNG/JSON 成对保留；
4. 重试 revise。

**边界**：绝不要手工编辑任何 sidecar JSON 或删除已成对的 `.revN` 文件。

## 2. Windows 宿主持 Sharp DLL 导致 EBUSY/EPERM

**判断**：Windows 上 `npm install -g` 报 EBUSY/EPERM，或 doctor 报 dist/cli.js 缺失。根因是 Codex 桌面宿主自动重启并持有旧 MCP 进程的 sharp 原生模块。

**恢复**（官方流程）：

1. `codex mcp remove agent-callout`；
2. 确认无残留 `agent-callout mcp` 进程（任务管理器或 `Get-Process node`）；
3. 重新执行 `npm install -g --install-links=true ...`；
4. `codex mcp add agent-callout -- agent-callout mcp`；
5. 新开会话运行 doctor。

## 3. npm install-links=false 造成全局 bin 指向临时 clone

**判断**：全局安装后 `agent-callout --version` 失败或 dist 缺失；npm 全局目录出现临时 Git clone junction。

**恢复**：

1. `npm uninstall -g agent-callout`；
2. 用显式参数重装：`npm install -g --install-links=true git+https://github.com/xxf66666/AgentCallout.git`（或 v0.7.0 起 `npm install -g agent-callout`，见 npm 分发说明）；
3. `agent-callout doctor --self-test --json` 复核。

## 从 Git 安装迁移到 npm 安装（v0.7.0 起）

1. `npm uninstall -g agent-callout`（移除 Git 安装形态）；
2. `npm install -g agent-callout`（registry 分发）；
3. Codex 侧 `codex mcp add` 命令不变（命令仍是 `agent-callout mcp`）；
4. doctor 确认版本后即完成迁移。
