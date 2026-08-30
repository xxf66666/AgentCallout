# AgentCallout 兼容性与验证记录

## 兼容性矩阵

状态只使用三种：**VERIFIED** 表示对应范围已在所列环境真实执行并留有结果；**PARTIALLY VERIFIED** 表示只验证了版本、子能力、技术实验或命令面；**NOT VERIFIED** 表示尚无项目级运行证据。一个组件的版本存在不代表 AgentCallout 已安装或可调用。

| 范围                       | 当前环境/目标                                                         | 状态                   | 已有证据                                                                                                  | 尚待执行                                                       |
| -------------------------- | --------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Windows                    | Windows 11 Enterprise x64 `10.0.26200`（build 26200）                 | **PARTIALLY VERIFIED** | 当前工作树 lint、typecheck、52 项测试、构建、CLI、stdio MCP、Unicode 路径和 hard-link 防覆盖通过          | **PENDING：** 干净 clone、GitHub 正式安装和客户端端到端        |
| Node.js 当前环境           | Node `v24.18.1`，npm `11.16.0`                                        | **VERIFIED**           | 当前工作树依赖安装、lint、typecheck、test、build、CLI doctor 与 MCP 启动均真实执行                        | 只覆盖当前工作树；clean clone 另列                             |
| Node.js 支持下限           | 目标 `>=20.9`                                                         | **NOT VERIFIED**       | Sharp 上游声明 Node 20.9+；这是选型依据，不是本项目运行证据                                               | **PENDING：** Node 20.9/20 LTS 和当前 LTS CI/干净安装矩阵      |
| Sharp/libvips              | Sharp `0.35.4` / libvips `8.18.6`                                     | **VERIFIED**           | 正式 core、lockfile、doctor、三种输入、十类批注、blur/redact、重解码和同平台确定性测试通过                | 非 Windows 与 Node 20 仍待验收                                 |
| 捆绑中文字体               | Noto Sans CJK SC `2.004`                                              | **VERIFIED**           | 官方 OTF/OFL 已捆绑；SHA-256、Pango 中英文渲染、示例和 doctor 通过                                        | 非 Windows 字体渲染待验收                                      |
| MCP 协议映射               | stdio、严格 Tool schema、TextContent、ImageContent、structuredContent | **VERIFIED**           | 构建产物完成 initialize、六工具发现、doctor 调用；SDK 测试覆盖结构化结果、图片预览、严格参数错误与 roots  | 这里只验证协议/进程，不代替 Claude/Codex Agent                 |
| AgentCallout CLI           | Windows 首要，跨平台目标                                              | **VERIFIED**           | inspect/validate/annotate/crop/contact-sheet/doctor 自动测试；构建产物 self-test 验证 sidecar/redact 像素 | GitHub 全局安装和非 Windows 待验收                             |
| AgentCallout MCP 调用      | 本地 stdio                                                            | **PARTIALLY VERIFIED** | 构建产物真实 stdio initialize/doctor；SDK 调用 inspect/validate/crop 并解码受限 PNG，六工具集成测试通过   | Claude/Codex 宿主 Agent、图片进入模型和二次渲染待验收          |
| Claude Code 客户端         | Claude Code `2.1.251`                                                 | **PARTIALLY VERIFIED** | 本机版本、命令面、Skill/Plugin/MCP manifest 严格校验通过                                                  | **PENDING：** GitHub 安装、真实调用、查看图片、二次渲染        |
| Claude Code 安装/升级/卸载 | Git marketplace + plugin                                              | **NOT VERIFIED**       | 两命令安装形态已实现；plugin/marketplace strict validate 通过                                             | **PENDING：** 正式 marketplace add/install/update/uninstall    |
| Codex 客户端               | Codex CLI `0.151.0`                                                   | **PARTIALLY VERIFIED** | 本机版本、命令面、MCP 图片 caveat、Plugin/Skill/首次 bootstrap 均在本地协议层验证                         | **PENDING：** GitHub 安装、真实 Agent 调用、图片查看和二次渲染 |
| Codex 安装/升级/卸载       | Git marketplace + plugin                                              | **NOT VERIFIED**       | Marketplace/Plugin 已实现；bootstrap 首次安装 2 秒、重复启动跳过依赖，本地 stdio doctor 通过              | **PENDING：** Codex plugin add/upgrade/remove 与 clean profile |
| 三组模拟示例               | ui-bug、numbered-review、privacy                                      | **VERIFIED**           | 项目脚本生成 input/spec/output/sidecar；重复 hash 一致；privacy redact 为单一不透明像素值；人工查看通过   | 非 Windows 重生 hash 不作跨平台字节承诺                        |
| 项目构建与测试             | lint、typecheck、test、build、doctor                                  | **PARTIALLY VERIFIED** | 当前工作树 52 项测试、lint、typecheck、构建、三份 dist 字节复现、doctor/self-test 通过                    | **PENDING：** 干净 clone `npm ci` 与同一完整 gate              |

## 证据日志

| ID          | 日期       | 操作/来源                                                      | 结果                                                                                                                         | 证据边界                                                              |
| ----------- | ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| ENV-001     | 2026-08-30 | `Get-CimInstance Win32_OperatingSystem` 与 .NET OSArchitecture | Windows 11 Enterprise `10.0.26200` build `26200`，x64                                                                        | 只确认当前主机，不代表其他 Windows 版本兼容                           |
| ENV-002     | 2026-08-30 | `node --version`、`npm --version`                              | Node `v24.18.1`，npm `11.16.0`                                                                                               | 只确认工具存在；尚未在仓库 install/build                              |
| ENV-003     | 2026-08-30 | `claude --version`、`codex --version`                          | Claude Code `2.1.251`；Codex CLI `0.151.0`                                                                                   | 只确认客户端版本，不代表 AgentCallout 已安装或调用                    |
| SPIKE-001   | 2026-08-30 | Windows Sharp 技术实验，详见 `research.md`                     | Sharp `0.35.4` / libvips `8.18.6` 成功处理三种输入；输出可重新解码；redact 区域只剩 `17,17,17` RGB；中英文与箭头人工查看正常 | 独立选型实验，不是仓库 core、CLI、MCP、installer 或捆绑字体验收       |
| MCP-001     | 2026-08-30 | 当前 MCP Tools/stdio/resources 官方规范调研                    | 确认 schema、structuredContent、ImageContent、stdio stdout 约束和路径安全要求                                                | 规范能力不等于 AgentCallout Server 或任一宿主实现已通过               |
| CLAUDE-001  | 2026-08-30 | Claude Code 2.1.251 当前 CLI/官方文档调研                      | 确认 stdio MCP、Skill、Plugin、Git marketplace 的当前命令形态及 plugin validate 路径                                         | 尚未安装 AgentCallout plugin；无 tool invocation 或二次渲染证据       |
| CODEX-001   | 2026-08-30 | Codex 0.151.0 当前 CLI/官方文档与客户端结果路径调研            | 确认 MCP/plugin 命令面、Git plugin bootstrap 限制及 structuredContent/image caveat                                           | 尚未安装 AgentCallout plugin；该兼容策略仍需真实 tool invocation 验证 |
| REPO-001    | 2026-08-30 | 本文创建时的项目进度审计                                       | 尚未记录正式 `npm ci`、build、test、CLI/MCP 或客户端安装调用结果                                                             | 所有这些项目均保持 NOT VERIFIED/PENDING，后续只能用真实命令更新       |
| CORE-001    | 2026-08-30 | 正式 core/renderer 自动化与人工示例检查                        | PNG/JPEG/WebP、十类批注、中文、layout、blur、opaque redact、EXIF、重解码、hash、hard-link 防覆盖通过；三图人工查看正常       | 当前 Windows/Node 24，不外推跨平台                                    |
| CLI-001     | 2026-08-30 | `node dist/cli.js doctor --self-test --json`                   | Sharp/libvips/font hash/text render 正常；临时图片、sidecar 解码和 redact RGBA 像素检查通过                                  | 直接构建产物，不等于 GitHub 全局安装                                  |
| MCP-002     | 2026-08-30 | `node scripts/smoke-mcp.mjs dist/mcp.js`                       | stdio initialize、server instructions、六工具发现、结构化 doctor 成功；stderr 为空                                           | 不等于 Claude/Codex 模型看到 ImageContent                             |
| PLUGIN-001  | 2026-08-30 | Plugin/Skill validators 与 `bootstrap.mjs` 两次 stdio smoke    | Codex/Claude/Skill manifest 校验通过；首次固定依赖安装成功，第二次跳过；plugin MCP doctor 成功                               | 尚未通过客户端 marketplace 安装                                       |
| EXAMPLE-001 | 2026-08-30 | `npm run examples`、输出 hash/像素脚本与人工查看               | 三组 input/spec/output/sidecar 生成两次一致；privacy redact 为 `17,24,39,255`；无绝对开发机路径                              | 只覆盖当前平台生成                                                    |

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

Codex marketplace 只缓存插件文件，不替插件执行 `npm install`；因此首次启动由幂等、锁定依赖的 bootstrap 准备 Sharp runtime。该 bootstrap 已在独立插件目录完成首次安装和第二次跳过验证；Codex 实际缓存目录、超时、升级和卸载仍待 marketplace 验收。

## 验收记录模板

每次更新兼容状态必须追加：日期、OS/架构、Node/npm、Sharp/libvips、客户端版本、仓库 commit、精确命令、exit code、关键输出、生成文件 SHA-256，以及是否人工/Agent 查看结果。状态只能按对应证据提升：

- install 成功不能替代 tool invocation；
- tool 被列出不能替代真实生成图片；
- MCP SDK 测试不能替代 Claude Code/Codex 宿主调用；
- 首次生成不能替代修改 spec 后的二次渲染；
- 当前工作树通过不能替代干净 clone；
- 配置级验证不能标记为端到端 VERIFIED。
