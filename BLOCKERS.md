# Blockers

当前外部阻塞（2026-09-13）：

0. **npm publish 被 npm 登录阻塞**：v0.7.0 已 npm-ready（private 移除、prepublishOnly=verify、pack 清单核对、Linux 容器 gate 通过），但真实 `npm publish` 需要 `npm login`。解除后按 docs/npm-distribution.md 执行并补记 compatibility 安装形态证据。
1. **GitHub Release 补建被 gh 凭据阻塞**。需要为 v0.1.2、v0.1.3、v0.2.0、v0.3.0、v0.3.1、v0.4.0、v0.4.1 共 7 个 tag 补建 Release 页（正文取自 docs/releases/*.md，v0.1.2 无对应发布记录需先补一份简短记录）。解除条件：`gh auth login` 完成认证（或提供等效 token），随后按 roadmap「先行任务」执行。影响范围：仅发布可见性；tag 与 GitHub 安装路径均可用，CLI/MCP 主功能不受影响。
2. **Codex Skills-only Git Marketplace 30 秒 clone 超时**（历史外部阻塞）：根因为 Codex 0.151 本地 Plugin 无可用 plugin-root 子进程上下文（CODEX-003）；明确不阻塞 CLI+MCP 主路径，仅在新版 Codex 发布或有新线索时重测。

若后续出现其他凭据、远程保护规则、许可证或客户端权限阻塞，将在此记录准确证据、影响范围和不依赖该阻塞的已完成工作。
