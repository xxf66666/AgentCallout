# AgentCallout · AI 截图批注笔

**给 AI 一支截图批注笔：让 Claude Code、Codex 为已有截图加红框、箭头、编号、说明、高亮和安全遮挡。**

_Give AI agents a pen for screenshots._

![AgentCallout 示例](examples/contact-sheet.png)

AgentCallout 在本机处理 PNG、JPEG、WebP，不上传截图，也不需要 OpenAI、Anthropic 或其他模型 API Key。它把图片处理包装成 Agent 能执行的“检查 → 批注 → 查看 → 修正”流程，你只要说清楚想标哪里、说明什么。

## 先看这里

- 标重点：矩形、椭圆、箭头、文字、说明框、编号。
- 突出区域：高亮、聚光灯。
- 保护隐私：普通内容可模糊；Token、密码等用不可恢复的纯色遮挡。
- 方便交付：生成批注 PNG、可再次修改的 JSON 和 Markdown 图片引用。
- 可选 OCR：安装本地中英文模型后，可按截图文字查找候选位置。

它只负责**批注已有截图**，不负责系统截图、录屏、视频编辑或完整桌面 GUI。

## 安装

需要 Node.js `>=20.10.0`、Git，并能访问 GitHub 和 npm。

- 只用 Claude Code：只执行 Claude 的两条命令。
- 只用 Codex：只执行 Codex 的两条命令。
- 两边都用：两组都执行。

### Claude Code

```powershell
claude plugin marketplace add https://github.com/xxf66666/AgentCallout.git
claude plugin install agent-callout@agent-callout
```

新开一个 Claude Code 会话，然后说：

```text
调用 AgentCallout doctor，告诉我是否正常。
```

第一次启动可能需要下载 Sharp 图片运行库，因此会比之后稍慢。

### Codex

```powershell
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
codex mcp add agent-callout -- agent-callout mcp
```

新开一个 Codex 会话，然后说：

```text
调用 AgentCallout doctor，告诉我是否正常。
```

也可以在 PowerShell 中验证：

```powershell
agent-callout doctor --self-test --json
```

> **以 doctor 通过为准。** `codex mcp get agent-callout` 只能说明配置存在，不能证明程序安装完整。
>
> Windows 重装或更新前请先关闭正在使用 AgentCallout 的 Codex 会话。否则 Sharp 的 DLL 可能被占用，npm 会报告 `EPERM` 或 `EBUSY`。如果 doctor 报 `dist/cli.js` 找不到，说明上次 npm 安装没有完成，请关闭相关会话后重新执行上面的 npm 安装命令。

## 怎么用

安装后，可以直接对 Claude Code 或 Codex 说：

```text
把这张截图中的保存按钮用红框标出来，用箭头指向它，
添加文字“点击后没有响应”，生成批注图片并给我 Markdown。
```

Agent 会检查图片、必要时放大局部、生成批注、查看结果，并在遮挡或偏移时重新调整。

假设原图是 `screenshot.png`，默认会生成：

- `screenshot.annotated.png`：最终批注图片。
- `screenshot.annotated.json`：可再次修改和重渲染的批注记录。
- Markdown 图片引用：可直接放进报告或文档。

原图默认不会被覆盖。

继续修改时，Agent 会生成 `.rev1`、`.rev2` 等新版本，保留原图和历史结果。

工具每次最多返回一张 512 px / 64 KiB 的预览，完整图片会保存在本机。修改后优先查看变化区域；小字看不清时再放大局部。变更涉及移除或修改隐私遮挡时，不会自动发送图片。预览尺寸和像素缩减比例可用于比较传输量，不能直接换算为 token 或费用。修订、预览和异常处理的完整规则见[接口文档](docs/annotation-spec.md#revising-a-committed-annotation)。

## 可选：按文字自动定位

v0.3.0 增加本地中英文 OCR。默认安装不下载 OCR 引擎或模型；确实需要按文字定位时再显式安装：

```powershell
agent-callout ocr install --json
agent-callout ocr status --json
agent-callout locate-text .\screenshot.png --query "校验失败" --mode contains --json
```

OCR 只返回文字候选框，不会自动把文字框扩成整个按钮。多候选或低置信度结果必须先查看确认；`not-found` 也不表示文字一定不存在。完整参数、ROI 放大和反白文字处理见[本地 OCR 文档](docs/ocr.md)。

## 把结果交给另一个 AI

把下面两份文件一起交付，另一个 AI 才能明确区分原图内容和后加批注：

- `*.annotated.png`：给人和视觉模型看的结果；
- 同名 `*.annotated.json`：记录每条批注的文字、类型、位置和修订关系。

另一个 AI **不必安装 AgentCallout 才能读 JSON**。安装后还能校验文件、生成安全摘要、重新渲染和继续修订。分享前请检查 JSON 中的批注文字与文件信息；需要提供原图时，也先检查其中的敏感内容。仅凭一张压平 PNG，无法可靠还原批注层。

Markdown 交付可同时链接两份文件：

```markdown
![批注结果](./screenshot.annotated.png)
[机器可读批注层](./screenshot.annotated.json)
```

## 模糊和安全遮挡不是一回事

- `blur`（模糊）：只是让内容不易看清，不能保证无法恢复。
- `redact`（安全遮挡）：用完全不透明的颜色替换原像素，适合 Token、密码、私钥等敏感信息。

有安全要求时，请使用 `redact`，不要只用模糊。

## 示例

所有示例都是项目生成的模拟界面，不含真实账号或 Token。

| 示例     | 内容                          | 文件                                       |
| -------- | ----------------------------- | ------------------------------------------ |
| UI bug   | 红框、箭头、中文说明          | [查看](examples/ui-bug/README.md)          |
| 编号评审 | 用 1、2、3 标出三个问题       | [查看](examples/numbered-review/README.md) |
| 隐私保护 | 邮箱模糊、模拟 Token 安全遮挡 | [查看](examples/privacy/README.md)         |

## 需要时再看

<details>
<summary><strong>更新或卸载</strong></summary>

### Claude Code

```powershell
# 更新
claude plugin marketplace update agent-callout
claude plugin update agent-callout@agent-callout
# 更新后新开会话，再运行 doctor

# 卸载
claude plugin uninstall agent-callout@agent-callout
claude plugin marketplace remove agent-callout
```

### Codex

重装或更新前先关闭正在使用 AgentCallout 的 Codex 会话。Codex 桌面版可能自动重启 MCP 子进程；此时先用官方命令临时移除该 MCP，安装后再原样添加，可避免 Sharp DLL 被占用。

```powershell
# 更新
codex mcp remove agent-callout
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
codex mcp add agent-callout -- agent-callout mcp
agent-callout --version
# 更新后新开 Codex 会话，再运行 doctor

# 卸载
codex mcp remove agent-callout
npm uninstall --global agent-callout
```

</details>

<details>
<summary><strong>直接使用命令行（CLI）</strong></summary>

```powershell
agent-callout doctor --self-test --json
agent-callout inspect .\screenshot.png --json
agent-callout inspect-sidecar .\screenshot.annotated.json --json
agent-callout annotate .\screenshot.png --spec .\annotations.json --output .\screenshot.annotated.png
agent-callout revise .\screenshot.annotated.json --edits .\edits.json
agent-callout --help
```

`edits.json` 使用 `add`、`set`、`remove` 修改批注；`set` 表示完整替换同一 ID 的批注。[字段、示例与修订规则](docs/annotation-spec.md#revising-a-committed-annotation)。

</details>

<details>
<summary><strong>给开发者：MCP、Skill 和 AnnotationSpec</strong></summary>

MCP 提供 9 个工具：

- `doctor`：检查运行环境。
- `inspect_image`：读取图片尺寸、格式和哈希。
- `inspect_annotation_sidecar`：校验批注 sidecar/输出/父链并返回路径与文字脱敏的紧凑摘要。
- `validate_annotation_spec`：检查批注参数和坐标。
- `annotate_image`：生成批注图和预览。
- `revise_annotation`：从已验证 annotate sidecar 按稳定 ID 创建下一版本，并在安全时返回变更区域聚焦预览。
- `crop_image`：裁剪局部，便于 Agent 放大检查。
- `create_contact_sheet`：把多张图片合成联系表。
- `locate_text`：使用可选本地 OCR 返回与原图 hash 绑定的文字候选、坐标和置信度。

新建批注请使用 AnnotationSpec 1.1，它提供可读的默认样式、preset 和语义 tone；已有的 AnnotationSpec 1.0 sidecar 仍受支持。需要保持 canonical JSON 或像素兼容时，请保持其 1.0 版本原样重放。两个版本都以左上角为原点，支持像素坐标和 `0..1` 标准化坐标。完整字段见 [AnnotationSpec 1.0 和 1.1](docs/annotation-spec.md)。

可选的 Codex Skill 会教 Agent 按“检查 → 批注 → 查看 → 修正”的流程工作；它不替代 MCP 安装：

```powershell
# 安装
codex plugin marketplace add xxf66666/AgentCallout
codex plugin add agent-callout@agent-callout

# 更新
codex plugin marketplace upgrade agent-callout

# 卸载
codex plugin remove agent-callout@agent-callout
codex plugin marketplace remove agent-callout
```

安装后可对 Codex 说：`使用 $agent-callout 给这张截图添加批注。`

> Codex CLI 0.151 在部分 Windows 机器上会把 Git Marketplace clone 固定限制为 30 秒；即使 checkout 已到 100%，也可能返回 timeout。这个可选 Skill 更新失败时，继续使用上面已验证的全局 CLI+MCP 主路径，不要手改 Codex 插件缓存。

</details>

## 兼容性与限制

| 环境                 | 状态                                     |
| -------------------- | ---------------------------------------- |
| Windows 11           | 0.3.0 开发测试与 OCR 实测                |
| macOS 26 arm64       | 本版发布验收：CLI/MCP/OCR 与双客户端闭环 |
| Node.js 24.18、24.21 | 本版已实测                               |
| Node.js 20.10、20.19 | 旧版已实测，本版待回归                   |
| Codex CLI 0.154.0    | MCP 0.3.0 OCR 定位与批注（macOS）        |
| Claude Code 2.1.260  | 0.2.1 Plugin 已验收；0.3.0 合并后更新    |
| Linux                | 尚未完成项目级验证                       |

v0.2.1 已发布：密集说明框避让、目标保护、折线引线、排版告警和预览像素指标通过了 179 项测试、干净安装及双客户端视觉 A/B。完整证据见[发布记录](docs/releases/0.2.1.md)。

v0.3.0 已发布：可选本地中英文 OCR 定位通过 Windows 与 macOS 双平台 222 项测试、干净安装、生产依赖 0 漏洞，以及 Claude Code 与 Codex 真实“识别文字 → 确认 → 批注 → 查看结果”验收。多候选或低置信度必须确认，`not-found` 不代表文字不存在；平台间置信度分数不可比。完整证据见[发布记录](docs/releases/0.3.0.md)与[本地 OCR 文档](docs/ocr.md)。

自动避让保护的是传入的目标区域。复选框旁的说明文字也需要保留时，应一起框入目标；即使 warning 为空，也要查看是否遮住了其他源内容。

浅色说明框、独立编号配色和语义 tone 已可用：普通说明使用默认 `docs-light` 或 `info`，错误使用 `danger`。旧版 1.0 批注仍保留原有样式。

后续依次开发一键交接包、浏览器 DOM 定位和协作能力，详见[路线图](docs/roadmap.md)。系统截图、GUI 和视频尚未实现。

## 详细文档

[批注字段与坐标](docs/annotation-spec.md) · [安装实测记录](docs/compatibility.md) · [安全说明](docs/security.md) · [架构决策](docs/decisions.md) · [路线图](docs/roadmap.md)

## License

AgentCallout 使用 [MIT License](LICENSE)。捆绑的 Noto Sans CJK SC 字体使用 [SIL Open Font License 1.1](assets/fonts/OFL.txt)，详情见 [NOTICE](NOTICE)。
