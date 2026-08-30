# ADR-0003：Git marketplace、插件与 Sharp runtime bootstrap

- 状态：已接受；manifest/bootstrap 已验证，GitHub 客户端安装待完成
- 日期：2026-08-30
- 关联：[决策索引](../decisions.md)、[Claude 调研](../research.md#8-claude-code-专项调研)、[Codex 调研](../research.md#9-codex-专项调研)

## 背景

MVP 必须从 GitHub 在 Claude Code 与 Codex 中直接安装，不能依赖 npm 发布权限，也不能让用户手工复制大段 JSON/TOML。插件还需同时承载 Skill 工作流和同一个 stdio MCP Server。关键差异是：Claude Code 安装含 package/lockfile 的插件时会执行受限依赖安装，而 Codex Git marketplace 当前只物化/缓存插件文件，不代为安装 Sharp。

## 考虑过的方案

| 方案                                        | 优点                                      | 取舍/结论                                                                             |
| ------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| npm/npx 唯一入口                            | 命令短、生态成熟                          | 依赖 registry 发布权限，不满足 GitHub 必须独立可用；可以后附加，不能作为 MVP 唯一路径 |
| clone + build + `mcp add`                   | 机制透明                                  | 超过两条主要命令，用户需管理绝对路径和更新，不作为主体验                              |
| 为每个平台发布独立 executable               | 用户无需 Node 依赖安装                    | Sharp 原生资源、签名和多平台 release 流程扩大 MVP；保留为路线图                       |
| 分别维护两套插件/renderer                   | 可针对宿主定制                            | 漂移和测试成本翻倍，违反共享内核目标                                                  |
| **同仓库双 marketplace + 共享插件 payload** | 两条命令、可带 Skill/MCP、无 npm 发布权限 | 需要提交 dist，并为 Codex 处理运行时依赖；采用                                        |

## 决定

1. GitHub 仓库同时提供 Claude Code 与 Codex 所需的 marketplace、plugin manifest、Skill 和 `.mcp.json`，两个宿主最终启动同一个 MCP 入口。
2. 项目自有 TypeScript 在发布前构建；插件提交可直接由 `node` 执行的自包含 JavaScript 和字体/Schema 等运行资产，不要求用户现场编译，也不依赖 `prepare`。
3. Sharp/libvips 是平台相关 runtime，不能伪装成已打进单个 JS。插件提供小型、幂等 bootstrap：
   - 先检查插件本地、版本匹配的 Sharp runtime；存在且 smoke test 通过则立即启动 MCP；
   - 缺失时按提交的 lockfile 安装固定依赖，输出只写 stderr，随后验证 Sharp 可加载、版本正确并执行 doctor；
   - 安装使用参数数组，不拼 shell 字符串；同一插件版本重复启动不得重复安装；失败返回可操作错误，不静默改全局 Node/npm 配置。
4. Codex marketplace 不安装依赖，因此 bootstrap 是其 GitHub 直装路径的必要部分。Claude Code 安装若已准备依赖，bootstrap 退化为快速校验；否则使用同一受控路径。
5. marketplace 更新负责获取新的 Git snapshot/plugin 版本；bootstrap 以版本化 runtime 目录避免把旧 native 依赖误用于新版本。插件卸载不修改用户其他 MCP 配置；缓存清理由各宿主卸载语义和明确的项目卸载命令处理。

目标主安装体验保持两条命令：

```powershell
claude plugin marketplace add https://github.com/xxf66666/AgentCallout.git
claude plugin install agent-callout@agent-callout
```

```powershell
codex plugin marketplace add xxf66666/AgentCallout
codex plugin add agent-callout@agent-callout
```

这些是已调研的目标命令；只有在仓库实现后按 README 从干净环境跑通，才能标记 VERIFIED。

## 后果

收益：无需 npm 包发布即可从 GitHub 分发；Skill 和 MCP 同步版本；Claude/Codex 不复制 renderer；用户不手写配置。提交 dist 也让插件不依赖 install hook 编译项目代码。

成本与风险：首次 Codex 启动通常需要网络和可用 npm registry；bootstrap 的并发锁、原子安装、超时、代理、只读缓存目录和 Sharp optional dependency 行为必须测试；dist 会增大仓库并要求 CI 检查“源码与构建产物一致”。离线安装或独立 executable 不是本 ADR 的已解决能力。

## 验证状态

官方格式和本机 Claude Code 2.1.251 / Codex 0.151.0 CLI 命令已调研，但以下仍待真实验证：两个 marketplace manifest、首次 Sharp bootstrap、带空格/Unicode Windows 路径、重复安装、升级、卸载、首次启动超时和干净 clone。macOS/Linux 只可在对应 CI/主机通过后标记 VERIFIED。

## 证据

- [Claude Code Plugin 参考](https://code.claude.com/docs/en/plugins-reference)与[Marketplace 文档](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)
- [Codex Build plugins](https://learn.chatgpt.com/docs/build-plugins)与[插件打包文档](https://developers.openai.com/plugins/build/plugins)
- [Sharp 平台依赖与安装说明](https://sharp.pixelplumbing.com/install/)
- [调研中的分发风险与客户端差异](../research.md#54-分发相邻影响)
