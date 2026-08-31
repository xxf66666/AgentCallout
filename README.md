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

如果 Agent 需要调整一份已经提交的批注，它会从可信 sidecar 创建不可覆盖的新版本：

- `screenshot.annotated.rev1.png/.json`、`rev2`、`rev3`……按父链递增；
- `add`、`set`、`remove` 按稳定 ID 有序执行，`set` 是完整替换，不是字段合并；
- 每次都从原图重渲染，旧 PNG、JSON 和原图不会被改写；
- 只有存在且完整校验通过的 JSON sidecar 才是提交标志。PNG 已发布但 sidecar 未成功时不算已提交，也不能把双文件发布描述为断电级原子事务。
- 若版本已提交、但 lock/temp 清理不完整，结果会单独返回 `recoveryWarnings`；这类告警不能当成普通排版 warning 忽略。

MCP 默认返回最长边 512 px、最多 64 KiB 的低细节总览，旨在通常降低整张截图反复进入模型的 token 消耗；实际成本仍取决于宿主和模型。总览看不清小字或精确位置时，Agent 应裁剪已保存的输出局部再看，而不是反复请求整图高细节。sidecar、hash 和成功返回仍不能代替视觉复核。

## 把结果交给另一个 AI

不要只交一张已经“压平”的 PNG。单看像素，任何 AI 都无法可靠判断哪些内容来自原图、哪些是后加批注。应同时交付：

- `*.annotated.png`：给人和视觉模型看的结果；
- 同名 `*.annotated.json`：机器可读的批注层，包含原图/输出 hash、AnnotationSpec、稳定 ID、解析后位置、warning 和修订父链；
- 需要复核来源时，再附原图。原图含秘密时先按安全策略处理，不要为了做 diff 而泄露它。

另一个 AI **不必安装 AgentCallout 才能读 JSON**；sidecar 是普通、版本化的 JSON。只有在需要校验 hash、重渲染、继续修订或生成预览时，才需要 CLI/MCP。Sidecar 不是签名或加密证明，也可能包含批注文字和文件关联信息，分享前应按敏感文档检查。

修订 lock 只协调 sidecar 所在目录。复制完整 PNG/JSON lineage 到另一个目录会创建可独立继续、也可能分叉的工作副本；它不是跨目录或跨机器的全局 head。

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

重装或更新前先关闭正在使用 AgentCallout 的 Codex 会话。

```powershell
# 更新
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
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
agent-callout annotate .\screenshot.png --spec .\annotations.json --output .\screenshot.annotated.png
agent-callout revise .\screenshot.annotated.json --edits .\edits.json
agent-callout --help
```

`edits.json` 是严格数组。例如：

```json
[
  {
    "op": "set",
    "id": "save-button",
    "annotation": {
      "id": "save-button",
      "type": "rectangle",
      "rect": { "x": 120, "y": 80, "width": 160, "height": 48 }
    }
  }
]
```

`add` 必须带新 ID，可用 `afterId` 指定插入位置；`remove` 只接收现有 ID。若原图移动，追加 `--input <新路径>`，工具会核对父 sidecar 记录的 SHA-256。命令没有 `--output`、`--overwrite` 或修订号参数。

</details>

<details>
<summary><strong>给开发者：MCP、Skill 和 AnnotationSpec</strong></summary>

MCP 提供 7 个工具：

- `doctor`：检查运行环境。
- `inspect_image`：读取图片尺寸、格式和哈希。
- `validate_annotation_spec`：检查批注参数和坐标。
- `annotate_image`：生成批注图和预览。
- `revise_annotation`：从可信 annotate sidecar 按稳定 ID 创建下一版本并返回预览。
- `crop_image`：裁剪局部，便于 Agent 放大检查。
- `create_contact_sheet`：把多张图片合成联系表。

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

| 环境                        | 状态                      |
| --------------------------- | ------------------------- |
| Windows 11                  | 已实测                    |
| Node.js 20.10、20.19、24.18 | 已实测                    |
| Claude Code 2.1.251         | Plugin 0.1.3 两轮修订闭环 |
| Codex CLI 0.151.0           | MCP 0.1.3 两轮修订闭环    |
| macOS、Linux                | 尚未完成项目级验证        |

中文和英文文字、PNG/JPEG/WebP、版本化修订及自动化安全矩阵已在 GitHub `c75ce96` 的 Windows clean clone 验证；0.1.3 全局 GitHub 安装、Claude Plugin 更新及两边真实“发现遮挡 → 再修订”预览闭环也已完成。Codex 的可选 Skills-only Git Marketplace 更新仍可能触发客户端固定 30 秒 clone 超时，不影响已验证的全局 CLI+MCP 主路径，详见[兼容性记录](docs/compatibility.md)。当前 MVP 不包含 OCR 自动找字、浏览器 DOM 定位、系统截图快捷键、GUI、录屏或视频编辑。

下一阶段优先生成“变更区域聚焦预览”，减少修订后额外 crop 与图片 token；随后提供 sidecar 校验/摘要入口并继续改进密集说明框排版，详见[路线图](docs/roadmap.md)。

## 详细文档

[批注字段与坐标](docs/annotation-spec.md) · [安装实测记录](docs/compatibility.md) · [安全说明](docs/security.md) · [架构决策](docs/decisions.md) · [路线图](docs/roadmap.md)

## License

AgentCallout 使用 [MIT License](LICENSE)。捆绑的 Noto Sans CJK SC 字体使用 [SIL Open Font License 1.1](assets/fonts/OFL.txt)，详情见 [NOTICE](NOTICE)。
