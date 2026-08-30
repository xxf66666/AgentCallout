# AgentCallout 兼容性与验证记录

## 兼容性矩阵

状态只使用三种：**VERIFIED** 表示对应范围已在所列环境真实执行并留有结果；**PARTIALLY VERIFIED** 表示只验证了版本、子能力、技术实验或命令面；**NOT VERIFIED** 表示尚无项目级运行证据。一个组件的版本存在不代表 AgentCallout 已安装或可调用。

| 范围 | 当前环境/目标 | 状态 | 已有证据 | 尚待执行 |
| --- | --- | --- | --- | --- |
| Windows | Windows 11 Enterprise x64 `10.0.26200`（build 26200） | **PARTIALLY VERIFIED** | 本机版本确认；Sharp 最小实验在 Windows 完成 | **PENDING：** 干净 clone、正式安装、build、完整测试、路径/字体/安装器回归 |
| Node.js 当前环境 | Node `v24.18.1`，npm `11.16.0` | **PARTIALLY VERIFIED** | 可执行文件与版本已确认；Sharp 最小实验使用该 Node | **PENDING：** 仓库 `npm ci`、lint、typecheck、test、build、CLI/MCP 启动 |
| Node.js 支持下限 | 目标 `>=20.9` | **NOT VERIFIED** | Sharp 上游声明 Node 20.9+；这是选型依据，不是本项目运行证据 | **PENDING：** Node 20.9/20 LTS 和当前 LTS CI/干净安装矩阵 |
| Sharp/libvips | Sharp `0.35.4` / libvips `8.18.6` | **PARTIALLY VERIFIED** | 独立技术实验解码 PNG/JPEG/WebP、生成并重解码 PNG、渲染中英文/箭头/highlight、blur 和 opaque redact | **PENDING：** 正式 core 集成、lockfile/bootstrap、捆绑字体、全量自动化与跨平台测试 |
| 捆绑中文字体 | Noto Sans CJK SC（计划） | **NOT VERIFIED** | 技术实验使用 Windows 系统字体，只证明 Pango 路径可行 | **PENDING：** 字体文件、许可证/hash、中文 golden、干净环境无系统字体依赖测试 |
| MCP 协议映射 | stdio、Tool input schema、TextContent、ImageContent、structuredContent | **PARTIALLY VERIFIED** | 已按当前 MCP 规范完成接口调研与兼容策略 | **PENDING：** AgentCallout Server build/start、initialize 协商、Inspector/SDK tool invocation、stdout 零污染 |
| AgentCallout CLI | Windows 首要，跨平台目标 | **NOT VERIFIED** | 尚无项目 CLI 运行证据 | **PENDING：** inspect/validate/annotate/crop 真实调用、错误码、Unicode/空格路径、输出重解码 |
| AgentCallout MCP 调用 | 本地 stdio | **NOT VERIFIED** | 尚无项目 MCP tool 调用证据 | **PENDING：** 四个 tools 的协议与图片结果调用、EOF 退出、超限预览与路径降级 |
| Claude Code 客户端 | Claude Code `2.1.251` | **PARTIALLY VERIFIED** | 本机版本已确认；当前 MCP/plugin 命令面及 plugin validate 能力已调研 | **PENDING：** 从本仓库安装 AgentCallout、发现 Skill/MCP、真实调用、查看图片、二次渲染 |
| Claude Code 安装/升级/卸载 | Git marketplace + plugin | **NOT VERIFIED** | 拟定命令来自当前官方格式；AgentCallout plugin 尚未实装验收 | **PENDING：** marketplace add、plugin install/update/uninstall、重启要求、配置保全和 clean profile 测试 |
| Codex 客户端 | Codex CLI `0.151.0` | **PARTIALLY VERIFIED** | 本机版本已确认；当前 MCP/plugin 命令面与结果转换 caveat 已调研 | **PENDING：** 从本仓库安装 AgentCallout、Skill/MCP 发现、真实 tool 调用、图片进入模型、二次渲染 |
| Codex 安装/升级/卸载 | Git marketplace + plugin | **NOT VERIFIED** | CLI 支持 marketplace/plugin 路径；Git plugin 不自动安装 Sharp 的限制已确认 | **PENDING：** plugin add、首次 pinned bootstrap、重复安装、upgrade/remove、clean profile 测试 |
| 项目构建与测试 | `npm ci`、lint、typecheck、test、build、doctor | **NOT VERIFIED** | 截至本记录尚无正式仓库运行结果 | **PENDING：** 全部命令在当前工作树和干净 clone 各运行一次并记录 exit code/摘要 |

## 证据日志

| ID | 日期 | 操作/来源 | 结果 | 证据边界 |
| --- | --- | --- | --- | --- |
| ENV-001 | 2026-08-30 | `Get-CimInstance Win32_OperatingSystem` 与 .NET OSArchitecture | Windows 11 Enterprise `10.0.26200` build `26200`，x64 | 只确认当前主机，不代表其他 Windows 版本兼容 |
| ENV-002 | 2026-08-30 | `node --version`、`npm --version` | Node `v24.18.1`，npm `11.16.0` | 只确认工具存在；尚未在仓库 install/build |
| ENV-003 | 2026-08-30 | `claude --version`、`codex --version` | Claude Code `2.1.251`；Codex CLI `0.151.0` | 只确认客户端版本，不代表 AgentCallout 已安装或调用 |
| SPIKE-001 | 2026-08-30 | Windows Sharp 技术实验，详见 `research.md` | Sharp `0.35.4` / libvips `8.18.6` 成功处理三种输入；输出可重新解码；redact 区域只剩 `17,17,17` RGB；中英文与箭头人工查看正常 | 独立选型实验，不是仓库 core、CLI、MCP、installer 或捆绑字体验收 |
| MCP-001 | 2026-08-30 | 当前 MCP Tools/stdio/resources 官方规范调研 | 确认 schema、structuredContent、ImageContent、stdio stdout 约束和路径安全要求 | 规范能力不等于 AgentCallout Server 或任一宿主实现已通过 |
| CLAUDE-001 | 2026-08-30 | Claude Code 2.1.251 当前 CLI/官方文档调研 | 确认 stdio MCP、Skill、Plugin、Git marketplace 的当前命令形态及 plugin validate 路径 | 尚未安装 AgentCallout plugin；无 tool invocation 或二次渲染证据 |
| CODEX-001 | 2026-08-30 | Codex 0.151.0 当前 CLI/官方文档与客户端结果路径调研 | 确认 MCP/plugin 命令面、Git plugin bootstrap 限制及 structuredContent/image caveat | 尚未安装 AgentCallout plugin；该兼容策略仍需真实 tool invocation 验证 |
| REPO-001 | 2026-08-30 | 本文创建时的项目进度审计 | 尚未记录正式 `npm ci`、build、test、CLI/MCP 或客户端安装调用结果 | 所有这些项目均保持 NOT VERIFIED/PENDING，后续只能用真实命令更新 |

## Codex 0.151.0：structuredContent 与 image caveat

MCP 协议允许同一个 Tool 结果同时包含 `structuredContent` 和 `content` 中的 ImageContent；这不意味着每个宿主都会把两者都交给模型。对 Codex CLI `0.151.0` 的当前结果转换路径调研显示：当 `structuredContent` 非空时，客户端会优先形成结构化 payload，同一结果中的 image 内容块可能不会进入模型上下文。

因此 MVP 采用明确的版本兼容策略：

- 图片工具 `annotate_image`、`crop_image` 不声明 `outputSchema`，也不返回 `structuredContent`；它们返回 JSON TextContent + ImageContent + 输出绝对路径 + sidecar/Markdown 信息。
- 纯结构化工具 `inspect_image`、`validate_annotation_spec` 保留 `structuredContent`，同时提供文本序列化降级。
- 如果当前模型不接受图片或宿主因体积省略 ImageContent，绝对路径、JSON 文本和 sidecar 仍是事实来源；这只是功能降级，不能记录为“图片查看 VERIFIED”。
- Claude Code 也必须用真实调用确认 Tool 图片展示和输出大小限制，不能从 MCP 协议能力推断。

这是一项针对 Codex `0.151.0` 的兼容措施，不是永久协议设计。客户端升级后应重新运行同一集成测试；只有确认新版本能同时保留结构化结果和图片时，才可调整返回形态。

## 计划安装形态（尚未验收）

以下命令是当前架构目标，全部仍为 **NOT VERIFIED/PENDING**，在实际运行、记录结果并完成卸载前不能复制到“已验证安装”栏目。

Claude Code 目标：

```powershell
claude plugin marketplace add https://github.com/xxf66666/AgentCallout.git
claude plugin install agent-callout@agent-callout
```

Codex 目标：

```powershell
codex plugin marketplace add xxf66666/AgentCallout
codex plugin add agent-callout@agent-callout
```

Codex marketplace 只缓存插件文件，不替插件执行 `npm install`；因此首次启动必须由幂等、锁定依赖的 bootstrap 准备 Sharp runtime。这个 bootstrap、超时、失败恢复、重复安装和卸载均未验证。

## 验收记录模板

每次更新兼容状态必须追加：日期、OS/架构、Node/npm、Sharp/libvips、客户端版本、仓库 commit、精确命令、exit code、关键输出、生成文件 SHA-256，以及是否人工/Agent 查看结果。状态只能按对应证据提升：

- install 成功不能替代 tool invocation；
- tool 被列出不能替代真实生成图片；
- MCP SDK 测试不能替代 Claude Code/Codex 宿主调用；
- 首次生成不能替代修改 spec 后的二次渲染；
- 当前工作树通过不能替代干净 clone；
- 配置级验证不能标记为端到端 VERIFIED。

