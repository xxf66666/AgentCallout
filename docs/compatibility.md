# AgentCallout 兼容性与验证记录

## 兼容性矩阵

状态只使用三种：**VERIFIED** 表示对应范围已在所列环境真实执行并留有结果；**PARTIALLY VERIFIED** 表示只验证了版本、子能力、技术实验或命令面；**NOT VERIFIED** 表示尚无项目级运行证据。一个组件的版本存在不代表 AgentCallout 已安装或可调用。

| 范围                       | 当前环境/目标                                                         | 状态         | 已有证据                                                                                                                  | 尚待执行                                                     |
| -------------------------- | --------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Windows                    | Windows 11 Enterprise x64 `10.0.26200`（build 26200）                 | **VERIFIED** | 干净 clone、全 gate、GitHub 安装、CLI/MCP、双客户端 Agent、Unicode 路径和 hard-link 防覆盖通过                            | 不外推到其他 Windows build 或非 Windows                      |
| Node.js 当前环境           | Node `v24.18.1`，npm `11.16.0`                                        | **VERIFIED** | 当前工作树依赖安装、lint、typecheck、test、build、CLI doctor 与 MCP 启动均真实执行                                        | 只覆盖当前工作树；clean clone 另列                           |
| Node.js 支持下限           | `>=20.10.0`                                                           | **VERIFIED** | Node 20.10 doctor 通过；Node 20.19 的 52 tests、typecheck、build、dist 复现和 self-test 通过                              | Node 20.9 实测因 Sharp JSON import attributes 无法解析而排除 |
| Sharp/libvips              | Sharp `0.35.4` / libvips `8.18.6`                                     | **VERIFIED** | 正式 core、lockfile、doctor、三种输入、十类批注、blur/redact、重解码、Node 20/24 和同平台确定性通过                       | 非 Windows 仍待验收                                          |
| 捆绑中文字体               | Noto Sans CJK SC `2.004`                                              | **VERIFIED** | 官方 OTF/OFL 已捆绑；SHA-256、Pango 中英文渲染、示例和 doctor 通过                                                        | 非 Windows 字体渲染待验收                                    |
| MCP 协议映射               | stdio、严格 Tool schema、TextContent、ImageContent、structuredContent | **VERIFIED** | 构建产物完成 initialize、六工具发现、doctor 调用；SDK 测试覆盖结构化结果、图片预览、严格参数错误与 roots                  | 这里只验证协议/进程，不代替 Claude/Codex Agent               |
| AgentCallout CLI           | Windows 首要，跨平台目标                                              | **VERIFIED** | GitHub 全局安装、`--version`、doctor/self-test 及全部 CLI 自动测试通过；sidecar/redact 像素已验证                         | 非 Windows 待验收                                            |
| AgentCallout MCP 调用      | 本地 stdio                                                            | **VERIFIED** | SDK + 构建产物 + Claude/Codex 真实 Agent 调用通过；两客户端均完成两次 annotate 并确认两张预览可见                         | 客户端升级与非 Windows 需回归                                |
| Claude Code 客户端         | Claude Code `2.1.251`                                                 | **VERIFIED** | GitHub Plugin/Skill/MCP 被发现；doctor、inspect 和两次 annotate 成功，模型给出第二轮视觉评价                              | 非 Windows 与客户端升级待回归                                |
| Claude Code 安装/升级/卸载 | Git marketplace + plugin                                              | **VERIFIED** | 两命令安装、0.1.0 → 0.1.1 → 0.1.2 update、完整 uninstall/marketplace remove 和 0.1.2 重装通过                             | 非 Windows 待验收                                            |
| Codex 客户端               | Codex CLI `0.151.0`                                                   | **VERIFIED** | 直接 MCP doctor/inspect/validate/two annotate 成功；两张 ImageContent 均被模型确认可见                                    | 非 Windows 与客户端升级待回归                                |
| Codex 安装/升级/卸载       | GitHub 全局 CLI + `codex mcp add`                                     | **VERIFIED** | 安装、0.1.1 → 0.1.2 update、MCP remove/npm uninstall、命令缺失确认和同两命令重装通过                                      | 更新前须关闭持有 Sharp DLL 的活跃会话                        |
| Codex 可选 Skill Plugin    | Git marketplace + Skills-only Plugin                                  | **VERIFIED** | marketplace add、plugin add/upgrade/remove；最终 0.1.2 无 MCP runtime 声明，显式 `$agent-callout` 调用成功                | 非 Windows 待验收                                            |
| 三组模拟示例               | ui-bug、numbered-review、privacy                                      | **VERIFIED** | 项目脚本生成 input/spec/output/sidecar；重复 hash 一致；privacy redact 为单一不透明像素值；人工查看通过                   | 非 Windows 重生 hash 不作跨平台字节承诺                      |
| 项目构建与测试             | clean clone、lint、typecheck、test、build、doctor                     | **VERIFIED** | GitHub clean clone `npm ci`、52 tests、lint、typecheck、build、三份 dist 复现、examples clean diff、doctor/MCP smoke 通过 | npm mirror 不支持 audit；官方 registry audit 为 0 漏洞       |

## 证据日志

| ID          | 日期       | 操作/来源                                                      | 结果                                                                                                                               | 证据边界                                                              |
| ----------- | ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ENV-001     | 2026-08-30 | `Get-CimInstance Win32_OperatingSystem` 与 .NET OSArchitecture | Windows 11 Enterprise `10.0.26200` build `26200`，x64                                                                              | 只确认当前主机，不代表其他 Windows 版本兼容                           |
| ENV-002     | 2026-08-30 | `node --version`、`npm --version`                              | Node `v24.18.1`，npm `11.16.0`                                                                                                     | 只确认工具存在；尚未在仓库 install/build                              |
| ENV-003     | 2026-08-30 | `claude --version`、`codex --version`                          | Claude Code `2.1.251`；Codex CLI `0.151.0`                                                                                         | 只确认客户端版本，不代表 AgentCallout 已安装或调用                    |
| SPIKE-001   | 2026-08-30 | Windows Sharp 技术实验，详见 `research.md`                     | Sharp `0.35.4` / libvips `8.18.6` 成功处理三种输入；输出可重新解码；redact 区域只剩 `17,17,17` RGB；中英文与箭头人工查看正常       | 独立选型实验，不是仓库 core、CLI、MCP、installer 或捆绑字体验收       |
| MCP-001     | 2026-08-30 | 当前 MCP Tools/stdio/resources 官方规范调研                    | 确认 schema、structuredContent、ImageContent、stdio stdout 约束和路径安全要求                                                      | 规范能力不等于 AgentCallout Server 或任一宿主实现已通过               |
| CLAUDE-001  | 2026-08-30 | Claude Code 2.1.251 当前 CLI/官方文档调研                      | 确认 stdio MCP、Skill、Plugin、Git marketplace 的当前命令形态及 plugin validate 路径                                               | 尚未安装 AgentCallout plugin；无 tool invocation 或二次渲染证据       |
| CODEX-001   | 2026-08-30 | Codex 0.151.0 当前 CLI/官方文档与客户端结果路径调研            | 确认 MCP/plugin 命令面、Git plugin bootstrap 限制及 structuredContent/image caveat                                                 | 尚未安装 AgentCallout plugin；该兼容策略仍需真实 tool invocation 验证 |
| REPO-001    | 2026-08-30 | 本文创建时的项目进度审计                                       | 尚未记录正式 `npm ci`、build、test、CLI/MCP 或客户端安装调用结果                                                                   | 所有这些项目均保持 NOT VERIFIED/PENDING，后续只能用真实命令更新       |
| CORE-001    | 2026-08-30 | 正式 core/renderer 自动化与人工示例检查                        | PNG/JPEG/WebP、十类批注、中文、layout、blur、opaque redact、EXIF、重解码、hash、hard-link 防覆盖通过；三图人工查看正常             | 当前 Windows/Node 24，不外推跨平台                                    |
| CLI-001     | 2026-08-30 | `node dist/cli.js doctor --self-test --json`                   | Sharp/libvips/font hash/text render 正常；临时图片、sidecar 解码和 redact RGBA 像素检查通过                                        | 直接构建产物，不等于 GitHub 全局安装                                  |
| MCP-002     | 2026-08-30 | `node scripts/smoke-mcp.mjs dist/mcp.js`                       | stdio initialize、server instructions、六工具发现、结构化 doctor 成功；stderr 为空                                                 | 不等于 Claude/Codex 模型看到 ImageContent                             |
| PLUGIN-001  | 2026-08-30 | Plugin/Skill validators 与 `bootstrap.mjs` 两次 stdio smoke    | Codex/Claude/Skill manifest 校验通过；首次固定依赖安装成功，第二次跳过；plugin MCP doctor 成功                                     | 尚未通过客户端 marketplace 安装                                       |
| EXAMPLE-001 | 2026-08-30 | `npm run examples`、输出 hash/像素脚本与人工查看               | 三组 input/spec/output/sidecar 生成两次一致；privacy redact 为 `17,24,39,255`；无绝对开发机路径                                    | 只覆盖当前平台生成                                                    |
| CLAUDE-002  | 2026-08-30 | README 两命令 GitHub 安装、update、headless stream-json        | Plugin 0.1.1、Skill 和 MCP connected；doctor 成功；两次 annotate 输出 `864b…1d30`/`f6cc…3db8`，两个预览可见并有视觉评价            | 0.1.2 完整卸载/Marketplace remove/重装与 doctor 已通过                |
| CODEX-002   | 2026-08-30 | GitHub 全局安装 + `codex mcp add` + `codex exec --json`        | doctor/inspect/validate 成功；两次 annotate 输出 `e084…9430`/`59d9…cc83`，ImageContent 41,281 bytes，两个预览可见                  | 0.1.2 MCP remove/npm uninstall/重装与 doctor 已通过                   |
| CODEX-003   | 2026-08-30 | Codex Plugin MCP 子进程诊断                                    | 实际 `cwd` 为项目目录，`PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` 均为空，`${PLUGIN_ROOT}` 参数未展开；runtime Plugin 方案被 ADR-0005 替代 | 结论限 Codex 0.151 本地 Git Plugin                                    |
| NPM-001     | 2026-08-30 | npm 11 Git 全局安装                                            | 用户配置 `install-links=false` 会留下临时 clone junction；同命令显式 `--install-links=true` 后九文件包正确复制且 CLI 可运行        | README 已固化兼容参数                                                 |
| CLEAN-001   | 2026-08-30 | GitHub depth-1 clean clone `40208ad`                           | `npm ci`、完整 verify、examples 重生后 clean diff、CLI self-test、stdio MCP smoke 全通过                                           | Windows/Node 24                                                       |
| NODE-001    | 2026-08-30 | 临时 Node 20.9/20.10/20.19 运行                                | 20.9 解析 Sharp import attributes 失败；20.10 doctor 通过；20.19 的 52 tests/typecheck/build/dist/self-test 通过                   | engine floor 已修正为 20.10                                           |
| AUDIT-001   | 2026-08-30 | `npm audit --omit=dev --registry=https://registry.npmjs.org`   | production 依赖 5 个；info/low/moderate/high/critical 均为 0                                                                       | 配置的 npmmirror 不实现 audit endpoint，故只对官方 registry 有效      |

## Codex 0.151.0：structuredContent 与 image caveat

MCP 协议允许同一个 Tool 结果同时包含 `structuredContent` 和 `content` 中的 ImageContent；这不意味着每个宿主都会把两者都交给模型。对 Codex CLI `0.151.0` 的当前结果转换路径调研显示：当 `structuredContent` 非空时，客户端会优先形成结构化 payload，同一结果中的 image 内容块可能不会进入模型上下文。

因此 MVP 采用明确的版本兼容策略：

- 图片工具 `annotate_image`、`crop_image`、`create_contact_sheet` 不声明 `outputSchema`，也不返回 `structuredContent`；它们返回 JSON TextContent + ImageContent + 输出绝对路径 + sidecar/Markdown 信息。
- 纯结构化工具 `inspect_image`、`validate_annotation_spec` 保留 `structuredContent`，同时提供文本序列化降级。
- 如果当前模型不接受图片或宿主因体积省略 ImageContent，绝对路径、JSON 文本和 sidecar 仍是事实来源；这只是功能降级，不能记录为“图片查看 VERIFIED”。
- Claude Code 2.1.251 与 Codex 0.151 已用真实两轮 annotate 调用确认 Tool 图片进入模型；客户端升级后仍须重测，不能只从 MCP 协议能力推断。

这是一项针对 Codex `0.151.0` 的兼容措施，不是永久协议设计。客户端升级后应重新运行同一集成测试；只有确认新版本能同时保留结构化结果和图片时，才可调整返回形态。

## 已验证安装形态

Claude Code 2.1.251 已执行：

```powershell
claude plugin marketplace add https://github.com/xxf66666/AgentCallout.git
claude plugin install agent-callout@agent-callout
```

Codex 0.151.0 已执行：

```powershell
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
codex mcp add agent-callout -- agent-callout mcp
```

Codex 的 Git Plugin 保留为可选 Skills-only 包；当前 0.151 不为本地 Plugin MCP 提供可用 plugin-root 子进程上下文，故 runtime 使用直接 MCP 注册。`--install-links=true` 用于覆盖 npm 的 `install-links=false` 配置，避免全局 bin 指向临时 Git clone。

## 验收记录模板

每次更新兼容状态必须追加：日期、OS/架构、Node/npm、Sharp/libvips、客户端版本、仓库 commit、精确命令、exit code、关键输出、生成文件 SHA-256，以及是否人工/Agent 查看结果。状态只能按对应证据提升：

- install 成功不能替代 tool invocation；
- tool 被列出不能替代真实生成图片；
- MCP SDK 测试不能替代 Claude Code/Codex 宿主调用；
- 首次生成不能替代修改 spec 后的二次渲染；
- 当前工作树通过不能替代干净 clone；
- 配置级验证不能标记为端到端 VERIFIED。
