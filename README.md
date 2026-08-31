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

## 模糊和安全遮挡不是一回事

- `blur`（模糊）：只是让内容不易看清，不能保证无法恢复。
- `redact`（安全遮挡）：用完全不透明的颜色替换原像素，适合 Token、密码、私钥等敏感信息。

有安全要求时，请使用 `redact`，不要只用模糊。

## 可视化编辑纯色遮挡（试验性）

可通过本地编辑器拖拽、缩放、换色、删除和撤销多个不透明遮挡块：

```powershell
agent-callout edit .\screenshot.png
```

命令会打印一个仅监听 `127.0.0.1` 的带随机令牌链接。编辑器会保存
`screenshot.agentcallout.project.json`，并在导出时从**原图**重新渲染
`screenshot.redacted.png`；不会在旧的打码图片上移动色块。项目文件仅接受
`redact` 注释和不透明颜色，导出的 PNG 仍会以安全色块替换源像素。默认不会覆盖已有输出。

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

# 卸载
claude plugin uninstall agent-callout@agent-callout
claude plugin marketplace remove agent-callout
```

### Codex

重装或更新前先关闭正在使用 AgentCallout 的 Codex 会话。

```powershell
# 更新
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git

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
agent-callout annotate .\screenshot.png --spec .\annotations.json --output .\screenshot.annotated.png
agent-callout --help
```

</details>

<details>
<summary><strong>给开发者：MCP、Skill 和 AnnotationSpec</strong></summary>

MCP 提供 6 个工具：

- `doctor`：检查运行环境。
- `inspect_image`：读取图片尺寸、格式和哈希。
- `validate_annotation_spec`：检查批注参数和坐标。
- `annotate_image`：生成批注图和预览。
- `crop_image`：裁剪局部，便于 Agent 放大检查。
- `create_contact_sheet`：把多张图片合成联系表。

AnnotationSpec v1.0 是可重放的 JSON 批注记录，以左上角为原点，支持像素坐标和 `0..1` 标准化坐标。完整字段见 [AnnotationSpec v1.0](docs/annotation-spec.md)。

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

</details>

## 兼容性与限制

| 环境                        | 状态                        |
| --------------------------- | --------------------------- |
| Windows 11                  | 已实测                      |
| Node.js 20.10、20.19、24.18 | 已实测                      |
| Claude Code 2.1.251         | 已完成真实安装和 Agent 调用 |
| Codex CLI 0.151.0           | 已完成真实安装和 Agent 调用 |
| macOS、Linux                | 尚未完成项目级验证          |

中文和英文文字、PNG/JPEG/WebP 及 52 项自动化测试已验证。当前 MVP 不包含 OCR 自动找字、浏览器 DOM 定位、系统截图快捷键、GUI、录屏或视频编辑。

下一阶段优先改进密集说明框的自动排版，并评估可选的 OCR/DOM 定位适配器，详见[路线图](docs/roadmap.md)。

## 详细文档

[批注字段与坐标](docs/annotation-spec.md) · [安装实测记录](docs/compatibility.md) · [安全说明](docs/security.md) · [架构决策](docs/decisions.md) · [路线图](docs/roadmap.md)

## License

AgentCallout 使用 [MIT License](LICENSE)。捆绑的 Noto Sans CJK SC 字体使用 [SIL Open Font License 1.1](assets/fonts/OFL.txt)，详情见 [NOTICE](NOTICE)。
