# AgentCallout 架构决策索引

> 决策日期：2026-08-30  
> 基线：`docs/research.md` 及 Windows 最小渲染实验  
> 说明：“已接受”表示实现应遵循该决策，不表示客户端安装或端到端验收已经通过。

## 决策状态

- **已接受（Accepted）**：已有足够证据停止横向选型并进入实现。
- **待验证（Verification pending）**：方案已定，但仍须用项目代码、干净安装或真实客户端调用关闭证据缺口。
- **被替代（Superseded）**：后续 ADR 明确取代；不得直接改写旧 ADR 隐藏历史。

## 决策准则

权重来自 MVP 的不可变目标和交付约束，用于避免按个人偏好选型；具体分数见各 ADR。

| 准则                         | 权重 | 含义                                              |
| ---------------------------- | ---: | ------------------------------------------------- |
| Agent 实际可用性             |   25 | 能形成 `inspect → annotate → 查看 → 修正` 闭环    |
| Claude Code / Codex 安装体验 |   20 | GitHub 直装、主要命令不超过两条、无需手写大段配置 |
| Windows 可靠性               |   15 | Windows 是首要验收平台，原生依赖须可预测          |
| 稳定性与安全性               |   15 | 确定性输出、真实 redact、受控路径与结果降级       |
| 实现速度                     |   10 | 能在 MVP 内完成真实功能而非脚手架                 |
| 维护成本                     |   10 | 少运行时、少重复实现、版本可固定                  |
| 跨平台扩展                   |    5 | 不把内核绑定到 Windows 或某一个 Agent             |

## 已接受决策

| ID    | 决策                                                                                                                                                                                                           | 主要取舍                                                                                       | 验证状态                                                                                                              | 记录                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-001 | 使用 **TypeScript + Node.js 20.10+**；以 **Sharp** 解码、合成、blur 和输出；受控 SVG 绘制几何，Sharp/Pango text sprite 绘制文字；捆绑 **Noto Sans CJK SC Regular**；CLI 与 MCP 共用同一 core                   | 增加约 15.7 MB 字体和 Sharp 平台依赖，换取单一技术栈、确定中文字体和 Windows 预构建支持        | Windows clean clone、Node 20.10/20.19/24、捆绑字体、doctor 和示例已验证；跨平台待验证                                 | [ADR-0001](adr/0001-core-runtime-and-renderer.md)                                                            |
| D-002 | 采用版本化、可重放的 **AnnotationSpec**，显式稳定 ID，支持左上原点的像素/0..1 标准化坐标；callout 用确定性候选评分排版，失败不隐藏而返回 warning                                                               | 启发式不保证全局最优，但比手工位置更适合 Agent 重试，也比全局求解器更容易解释和测试            | Schema、布局、长中文/英文及多 callout 自动化已通过；密集全局最优仍属路线图                                            | [ADR-0002](adr/0002-annotation-spec-and-layout.md)                                                           |
| D-003 | Claude Code 以 **Git marketplace/plugin** 为主入口；Codex 以 **GitHub 全局 CLI + `codex mcp add`** 为主入口，并提供可选 Skills-only Plugin                                                                     | 两端仍各两条主命令且不依赖 npm 发布权限；Codex Skill 成为可选层，换取真实可启动的跨平台 MCP    | Claude Plugin 与 Codex 直接 MCP 均完成真实 Agent 调用；卸载/重装和 clean clone 待关闭                                 | [ADR-0003](adr/0003-distribution-plugin-bootstrap.md)、[ADR-0005](adr/0005-codex-direct-mcp-distribution.md) |
| D-004 | MCP 结果以同一 manifest 为事实源；纯结构化工具返回 `structuredContent + TextContent`；所有图片工具统一返回 `JSON TextContent + ImageContent` 并省略 `structuredContent`，规避 Codex 0.151 的结构化结果优先问题 | 保住 Agent 看图闭环且不依赖客户端识别；代价是图片工具不能依赖协议层 output schema              | stdio/SDK 与真实 Codex/Claude 两轮图片调用均已验证；客户端升级仍需回归                                                | [ADR-0004](adr/0004-mcp-result-compatibility.md)                                                             |
| D-005 | annotate sidecar 通过稳定 ID edits 创建 append-only `.revN`；验证完整父链，从原图重渲染，以目录内排他 lock、no-replace PNG 和最后发布的已验证 JSON commit marker 阻止同工作副本并发分支                        | 保留审计历史和陈旧 parent 防护；复制到其他目录可形成 fork，强杀/断电仍可能留下需恢复的 residue | Windows 自动化、CLI UAT 与真实 Claude/Codex 两轮 revision 预览闭环已通过                                              | [ADR-0006](adr/0006-safe-versioned-annotation-revisions.md)                                                  |
| D-006 | revision 默认只返回 touched/连带重排的单张聚焦预览；分散/全局/过大回退 compact-overview，敏感覆盖削弱则零图片。另提供 path/text/hash-free 的 sidecar 校验摘要                                                  | 减少重复 crop 和默认数据披露；代价是父 spec 需本地重渲染几何，聚焦视图不能代替全局复核         | 135 tests、clean clone、CLI UAT 与真实 Claude/Codex changed-region A/B 通过；两边 crop 均为 0，安全摘要无默认排除字段 | [ADR-0007](adr/0007-focused-review-and-safe-sidecar-summary.md)                                              |

## 明确不进入本轮决策的事项

- npm registry 发布、单文件可执行程序和系统级截图入口不是 GitHub 直装 MVP 的前置条件。
- OCR、Playwright/DOM selector、录屏和完整 GUI 作为以后 locator/integration，不进入默认内核。
- MCP `ResourceLink` 在实现受限 `resources/read` 之前不启用；MVP 使用 ImageContent、JSON 文本、sidecar 和本地绝对路径。
- 跨平台逐字节 hash 相同不是承诺；确定性边界是相同输入、规范化 spec、renderer/font 版本和同一平台。

## 必须关闭的验证项

1. [x] 使用仓库捆绑字体完成中文、英文、标点和换行测试，并记录字体 hash。
2. [x] 在 Windows 干净目录执行 clone、`npm ci`、build、doctor、MCP smoke 和真实图片重生。
3. [x] 完成 Claude Plugin、Codex 直接 MCP 与可选 Skills-only Plugin 的卸载/重装验收。
4. [x] 通过真实客户端完成 `inspect_image`、`validate_annotation_spec`、`annotate_image` 和 doctor 调用；crop 已在协议集成层验证。
5. [x] 在 Codex 0.151 证明 ImageContent 进入可视上下文并完成一次修改后重渲染。
6. [x] 在 0.1.3 发布构建上通过真实 Claude/Codex 两轮 `revise_annotation` 并确认预览可驱动视觉修正。
7. [x] 在 0.2.0 发布构建上验证 changed-region 能减少额外 crop，并验证 `inspect_annotation_sidecar` 不泄漏默认排除字段。

## 证据入口

- [有边界调研：渲染方案与技术实验](research.md#5-渲染与分发相邻方案比较)
- [有边界调研：最终技术推荐](research.md#7-技术实验与最终推荐)
- [有边界调研：Claude Code](research.md#8-claude-code-专项调研)
- [有边界调研：Codex](research.md#9-codex-专项调研)
- [MCP Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Sharp 安装要求](https://sharp.pixelplumbing.com/install/)
