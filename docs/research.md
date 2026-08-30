# AgentCallout 有边界调研

> 调研日期：2026-08-30  
> 调研状态：完成；实现与客户端验收状态另见 `docs/compatibility.md`  
> 项目定位：**Give AI agents a pen for screenshots.**

## 1. 范围与停止规则

本轮调研只回答会直接影响 MVP 架构和交付的六个问题：

1. MCP 工具能否同时返回结构化结果、图片和本地输出引用；如何兼容不同客户端。
2. Snipaste、PixPin 哪些批注体验应转译成 Agent 可编程能力。
3. 现有 MCP、Playwright 和图片 CLI 已覆盖什么，仍缺什么。
4. Sharp + SVG、Canvas、Pillow、ImageMagick 哪种内核最适合 Windows 优先、跨平台扩展和中文批注。
5. 哪些能力应进入轻量内核，哪些应作为 OCR/DOM 定位适配器延后。
6. 在没有 npm 发布权限时，哪种技术组合仍适合从 GitHub 直接安装。

资料优先级为官方规范、官方产品文档和项目上游仓库；不以聚合站、营销转载或搜索摘要作为关键结论依据。每个决策问题获得足以区分方案的一到两个一手证据后即停止，不进行无穷尽项目枚举。当前结论仍需由最小技术实验、Windows 干净安装以及 Claude Code/Codex 真实调用验证；调研结论本身不等于兼容性已通过。

## 2. MCP 协议结论

### 2.1 当前协议基线

MCP `latest` 当前指向 **2026-07-28**。新版 [Tools 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)规定：

- `inputSchema` 是 JSON Schema，根类型必须为 `object`；无参数工具推荐明确拒绝额外属性。
- Tool 可声明 `outputSchema`，成功结果中的 `structuredContent` 必须符合该 Schema。
- `CallToolResult.content` 是内容块数组，可同时包含 text、image、audio、resource link 和 embedded resource。
- `ImageContent` 使用 base64 数据和 MIME 类型，例如 `image/png`。
- `structuredContent` 在 2026-07-28 中可以是任意 JSON 值；为兼容旧客户端，规范仍建议同时返回其文本序列化形式。
- 现代协议结果还包含 `resultType` 等新字段；较早客户端采用旧式初始化和连接语义。实现不应手写版本分支，而应交给官方 SDK 协商，并以真实宿主测试为准。

因此，AgentCallout 的成功结果应采用“多通道、同一事实源”设计：

1. `structuredContent` 返回尺寸、路径、hash、warning、sidecar、Markdown 引用等机器可读 manifest。
2. TextContent 返回简短 JSON 摘要、绝对路径和 Markdown 引用，作为旧客户端和纯文本客户端的降级结果。
3. ImageContent 返回最终 PNG，使支持图片工具结果的 Agent 能立即查看并决定是否重排。
4. 大图超过产品限制时，ImageContent 返回受控预览图，完整文件仍写入本地并由路径指向。

虽然新版允许非对象 `structuredContent`，MVP 仍应固定为对象，以兼容使用较旧 MCP 类型定义的客户端和 SDK。

### 2.2 stdio 约束

[stdio transport 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)明确要求：客户端启动 Server 子进程；stdin/stdout 传递逐行 JSON-RPC；stdout 不得出现任何非 MCP 输出；日志可写入 stderr；stdin 关闭是可移植的优雅退出信号。

这对实现有直接约束：

- 启动 banner、doctor 信息、调试日志全部写 stderr，绝不能污染 stdout。
- Server 应在 stdin EOF 后快速退出，避免客户端卸载或重启时残留进程。
- MCP 与 CLI 复用核心库，但必须保留两个入口；普通 CLI 输出不能被 MCP stdio 入口继承。
- Windows 路径、Unicode 路径和含空格路径必须通过参数数组传递，不能依赖 shell 字符串拼接。

### 2.3 图片、本地路径与 ResourceLink

[Resources 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)允许 `file://` URI 和 base64 二进制内容，并要求 Server 验证 URI、检查权限、正确编码二进制数据、阻止目录穿越。Tool 返回的 ResourceLink 也不保证出现在 `resources/list` 中。

需要区分三件事：

- ImageContent 是“把图片内容直接交给客户端/模型”。
- ResourceLink 是“Server 声明自己能够读取的资源引用”，不是客户端必然可以直接访问操作系统路径的保证。
- TextContent 中的绝对路径是本地同机客户端的实用降级，但不是 MCP 对远程客户端的可移植语义。

MVP 可先稳定交付 ImageContent + structuredContent + 文本路径。只有同时实现受限的 `resources/read`、使用标准文件 URI 生成函数并将读取范围限制在输入/输出允许目录后，才增加 ResourceLink；不得简单拼接 `file://C:\...`。

### 2.4 兼容性风险

- “协议允许图片”不等于每个宿主都会把图片展示给 Agent。必须保留 PNG 绝对路径和 Markdown 引用。
- base64 会增加约三分之一传输体积，必须限制输入像素、输出字节和预览尺寸。
- 新版规范与旧客户端存在时代差异；应固定官方 SDK 版本，记录协商结果，并分别在 Claude Code、Codex 和协议测试客户端验收。
- 如果声明 `outputSchema`，所有非错误成功分支都必须提供符合 Schema 的 `structuredContent`；错误应使用 `isError` 结果，让模型能看到并修正参数。

## 3. Snipaste 与 PixPin 批注体验

[Snipaste 官方功能页](https://www.snipaste.com/)覆盖矩形、椭圆、折线、箭头、铅笔、荧光笔、文字、马赛克、Gaussian blur、橡皮擦和撤销/重做。它证明基础体验不只是“画矩形”，而是同时服务说明重点、指向目标和隐藏信息。

[PixPin 标注文档](https://pixpin.cn/docs/mark/base-use)的工具面更接近 AgentCallout 目标：几何图形、箭头、序列号、荧光笔、马赛克/模糊、文字和聚光灯，并支持撤销、重做与大部分对象的二次调整。几项尤其值得转译为结构化能力：

- [序列号](https://pixpin.cn/docs/mark/serial)可附文字和导向箭头，还定义了删除中间编号后的重排行为。AgentCallout 应将其实现为稳定 ID、显式 `number` 和可预测编号策略，而非全局可变计数器。
- [文字标注](https://pixpin.cn/docs/mark/text)及[标注配置](https://pixpin.cn/docs/configuration/mark)包含自动换行、任意位置换行和优先单词边界换行。MVP 必须同时处理中文字符边界、英文单词和过长单词。
- [聚光灯](https://pixpin.cn/blog/articles/highlight-key-information/)通过弱化非目标区域突出主要焦点，与在目标内部叠加半透明颜色的 highlight 是两种不同语义，Schema 不应混为一种效果。
- [马赛克、模糊与智能擦除](https://pixpin.cn/docs/mark/mosaic)主要解决视觉隐藏。AgentCallout 必须额外提供语义明确的 opaque redact，并说明只有 redact 用于安全遮挡。
- [放大镜](https://pixpin.cn/docs/mark/magnifier)说明局部放大很有价值，但 MVP 可用 `crop_image` 先满足 Agent 检查闭环，放大镜排版留到后续。

桌面应用的“二次编辑”在 Agent 产品中应对应：保存 AnnotationSpec sidecar、保留稳定 annotation ID、允许修改/删除单个对象并重渲染，而不是实现完整 GUI。颜色记忆和快捷键属于人工操作效率，不应占用 MVP 核心时间。

## 4. 现有项目比较

| 项目                                                                                                                           | 已覆盖能力                                                                                                                      | 对 AgentCallout 的启示与缺口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [annotation-mcp](https://github.com/aschokinatgmail/annotation-mcp)                                                            | 对现有图片画 bbox、箭头、highlight、callout、文字和圆；支持像素/归一化坐标、ImageContent、structured manifest、OCR、条码与 crop | 是最直接基准，但没有 blur、redact、spotlight 和完整 ellipse；未保存可编辑 sidecar、输入/输出 hash、Markdown 或 renderer version。[源码](https://github.com/aschokinatgmail/annotation-mcp/blob/main/src/annotation_mcp/models.py)为每次运行生成随机 UUID 和当前时间，不满足 manifest 可复现；[字体代码](https://github.com/aschokinatgmail/annotation-mcp/blob/main/src/annotation_mcp/draw_utils.py)仅尝试 Helvetica 后回退 Pillow 默认字体，不能保证中文；固定坐标绘制也没有多 callout 防碰撞和长文本换行。README 还明确说明默认不去除 EXIF。 |
| [mcp-screenshot-server](https://github.com/aamar-shahzad/mcp-screenshot-server)                                                | 捕屏与现有图片、批量批注、编号、blur/pixelate、WebP、边界自动调整及大量图片编辑工具                                             | 功能广但工具面和会话状态较重，文档主要面向 Cursor；上游说明未展示稳定 sidecar、hash、renderer version、Claude/Codex 直接安装和不可恢复 redact 验证。其将 blur/pixelate 放在 PII redaction 场景下，AgentCallout 应避免这种安全语义混淆。                                                                                                                                                                                                                                                                                                         |
| [Visual Annotation MCP](https://github.com/mstocker1/Visual_Annotation_MCP)                                                    | Playwright DOM 检查、元素 bbox、智能对比色、自动 label 方向、上下文 crop、背景 blur 和 MCP                                      | 面向 URL/DOM 及 Chromium，不是任意既有图片的轻量内核；无编号 spec、安全 redact 和跨 Claude/Codex 分发。其“候选方向 + 对比度采样”适合借鉴到布局评分。                                                                                                                                                                                                                                                                                                                                                                                            |
| [Showreel](https://github.com/HeyRenan/showreel)                                                                               | Claude Code Plugin；CSS selector 精确定位、像素自检、callout、spotlight、blur/redact、GIF/MP4 和 contact sheet                  | 对实时网页视觉文档很强，但无 MCP、依赖 Chromium，且不能处理脱离 DOM 的普通截图。最重要的启示是“解析位置—渲染—自检失败即报错”的闭环，而不是复制其录制功能。                                                                                                                                                                                                                                                                                                                                                                                      |
| [screenshot-annotator](https://github.com/arjunkai/screenshot-annotator)                                                       | Playwright selector、DOM overlay、JSON replay spec、多 viewport、稳定截图设置和 selector mask                                   | JSON sidecar/replay 是可借鉴模式；仍要求可访问网页和 Chromium，不提供通用图片内核、MCP/Codex 或完整隐私语义。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) 与 [Playwright CLI](https://github.com/microsoft/playwright-cli) | Accessibility snapshot、元素引用、DOM bbox、locator、highlight 和 screenshot                                                    | 适合作为未来 DOM locator adapter，直接产出目标 bbox；不应成为离线批注内核。官方也强调 snapshot 比依赖截图坐标更适合浏览器操作。                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [ImageMagick CLI](https://imagemagick.org/command-line-options/)                                                               | `-draw`、`-annotate`、`-region`、blur 和多格式转换；有[官方 Windows portable/installer](https://imagemagick.org/download/)      | 原语充分，但外部二进制、字体环境、Windows shell 转义和安全策略增加安装面；没有 AnnotationSpec、自动布局、sidecar 或 MCP。适合作为调试参考，不适合作为默认内核。                                                                                                                                                                                                                                                                                                                                                                                 |
| [Tesseract.js](https://github.com/naptha/tesseract.js)                                                                         | 本地 OCR、100 多种语言、TSV/hOCR/box 与 bbox 数据；支持中文模型                                                                 | 可作为以后 `locate_text` 适配器，但中文模型下载、首次延迟和误识别不应拖重基础安装。MVP 先依赖 Agent 看图、crop 放大和坐标重试。                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 4.1 现有方案共同缺口

没有一个已调研项目同时满足以下组合：

- 任意已有 PNG/JPEG/WebP，而不是只能访问实时网页或屏幕会话；
- 一个可版本化、可重放、可修改的 AnnotationSpec；
- 中英文确定性字体和自动换行；
- 多 callout 防越界、防遮挡和可解释 warning；
- blur 与不可恢复 redact 的严格区分及像素测试；
- PNG、sidecar、hash、Markdown、ImageContent 和文本路径同时交付；
- 同一内核同时服务 CLI、MCP、Claude Code 和 Codex；
- GitHub 直接安装、doctor、升级与卸载；
- Windows 首要验证且不依赖云端、模型 Key、浏览器或系统 OCR。

这就是 AgentCallout 的可辩护差异，不需要通过重新实现系统截图快捷键或完整桌面编辑器竞争。

## 5. 渲染与分发相邻方案比较

| 方案                           | Windows 与安装                                                                                                                                                 | 中文与排版                                                                                                                                                                                                     | Blur / Redact / WebP                                                                                                                                                                                         | 判断                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| **Sharp + 生成式 SVG overlay** | [Sharp 安装文档](https://sharp.pixelplumbing.com/install/)提供 Windows x64/ARM64 预构建二进制，要求 Node.js 20.9+；JPEG、PNG、WebP 和 SVG 输入均由预构建包支持 | [Sharp composite](https://sharp.pixelplumbing.com/api-composite/)的 `input.text.fontfile`可指定绝对字体文件并使用 Pango 换行；但官方明确说明嵌入 SVG 字体不受支持。因此几何用 SVG、文字用指定字体的独立 sprite | 原生 [Gaussian blur](https://sharp.pixelplumbing.com/api-operation/)；区域裁剪后可合成回原图；不透明 overlay 可做 redact；[PNG/WebP 输出](https://sharp.pixelplumbing.com/api-output/)完整，且默认移除元数据 | **首选**：一个 Node 技术栈即可服务 core、CLI、MCP 和安装器                          |
| `node-canvas`                  | [上游 README](https://github.com/Automattic/node-canvas)提供 Windows x64 预构建；缺少预构建时需 Cairo/Pango 等源码依赖                                         | `registerFont()`可明确注册字体，Canvas 2D API 画图直观                                                                                                                                                         | README 主要文档化 PNG/JPEG/PDF；区域 blur 仍需额外像素算法或 Sharp。Sharp 官方还记录两者在 Windows 同进程可能发生动态库冲突                                                                                  | 不选：为了 Canvas API 增加 Windows 原生依赖风险，不值得                             |
| Pillow                         | [官方安装文档](https://pillow.readthedocs.io/en/stable/installation/basic-installation.html)提供 Windows x86/x64/ARM64 wheels；常见可选格式库随 wheel 提供     | [ImageDraw](https://pillow.readthedocs.io/en/stable/reference/ImageDraw.html)支持 TrueType/OpenType、测量和多行文字，指定字体后中文可靠                                                                        | [GaussianBlur](https://pillow.readthedocs.io/en/stable/reference/ImageFilter.html)和 [WebP 读写](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html)完整                               | 技术可行的第二选择；但需要 Python 运行时和第二套打包/注册链，降低 GitHub 直装简洁度 |
| ImageMagick CLI                | Windows 官方提供 installer、winget 与 portable 包                                                                                                              | 依赖外部字体配置，复杂文本布局需额外脚本                                                                                                                                                                       | 效果和格式能力全面                                                                                                                                                                                           | 不作为内核：外部执行文件、安全策略、参数转义和版本漂移扩大维护面                    |

### 5.1 中文字体

系统字体可让 Windows 上的中文“看起来能用”，却不能保证 Linux/macOS 或干净 CI 上拥有相同字体，也不能保证换行和 golden image 稳定。建议捆绑 [Noto Sans CJK SC Regular](https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)并通过 `fontfile` 显式加载。该文件约 15.7 MB，包含拉丁字符和简体中文所需覆盖；[SIL Open Font License 1.1](https://github.com/googlefonts/noto-cjk/blob/main/Sans/LICENSE)允许随软件捆绑，但仓库必须保留许可文本和 NOTICE。

如果后续安装体积成为实际问题，可实验官方 region-specific subset；在未完成常用中文、英文、标点、数字和生僻字符 smoke test 前，不为减小包体牺牲字体确定性。

### 5.2 确定性边界

上述渲染器都没有承诺不同操作系统之间逐字节相同。AgentCallout 的确定性应定义为：相同输入字节、规范化后的 spec、renderer/font 版本和同一运行平台重复执行，输出像素与 hash 一致。实现应：

- 固定 Sharp、libvips 和字体版本，并将版本/字体 hash 写入 sidecar；
- 使用固定 PNG 编码参数，不使用调色板量化和随机抖动；
- AnnotationSpec 使用稳定 ID，canonical JSON 不包含当前时间或随机 UUID；
- 同平台运行两次做精确 SHA-256 测试；跨平台用关键区域像素断言或明确容差的 golden 测试；
- 输出后重新解码，验证尺寸、格式和 redact 区域。

### 5.3 推荐渲染流水线

1. 解码并应用 EXIF orientation，得到 Agent 实际看到的画布尺寸。
2. 校验路径、图片格式、最大边长、总像素和 AnnotationSpec。
3. 将 normalized 坐标转换为整数像素；保留两套坐标到 manifest。
4. 用确定性启发式布局 callout：按上、右、下、左等固定候选顺序生成位置，对越界、目标遮挡和已放置标签重叠计分；无理想位置时选择代价最低者并返回 warning。
5. 对 blur 区域从原图提取、模糊并合成；对 redact 区域进行完全不透明覆盖。
6. 生成只含受控几何元素的 SVG overlay；用户文字必须 XML/Pango 转义，不接受任意原始 SVG。
7. 使用捆绑字体把文字渲染为透明 sprite，再与几何 overlay 一起合成。
8. 固定输出为全彩 PNG，默认不保留 EXIF/XMP；写入临时文件后原子改名，默认不覆盖原图或已有输出。
9. 重新解码输出，计算 SHA-256，写 JSON sidecar，并构造 Markdown 和 MCP 结果。

### 5.4 分发相邻影响

Node + Sharp 允许核心、CLI、MCP Server、doctor 和安装器共享一个依赖树。即使没有 npm 发布权限，也可以从 GitHub clone 后由 PowerShell/Bash 安装器执行固定的 `npm ci`、build 和客户端注册；无需再安装 Python、Tesseract、Chromium、Cairo 或 ImageMagick。

需要在实现阶段验证的分发风险：

- Sharp 使用平台可选依赖；其文档提醒跨平台共享 npm lockfile 可能受 npm 可选依赖问题影响。Windows 干净克隆和目标平台 CI 都必须执行真实安装。
- GitHub clone 安装应锁定 commit/版本，安装器修改配置前备份，并提供幂等 install/update/uninstall。
- 不把 OCR 或浏览器依赖放入默认包；它们应以后以 locator adapter 或独立 integration 提供。
- 最终 Claude Code/Codex 命令必须以各自当前官方文档和本机实测为准，不能从其他客户端配置类推。

## 6. 差异化定位

AgentCallout 不应定位为又一个截图软件，而应定位为：

> **面向 AI Agent 的通用 post-capture annotation ABI：把任何来源的已有截图转换为可复现、可复查、可安全脱敏的批注交付物。**

核心差异包括：

- 一个版本化 AnnotationSpec 同时驱动 CLI 和 MCP；
- 任意图片来源，不要求浏览器、DOM、桌面会话或 OCR；
- stable ID、输入/spec/输出 hash、sidecar、warning 和 renderer version；
- 中文/英文捆绑字体、自动换行和多 callout 布局；
- blur 与安全 redact 分离，并用像素级测试证明 redact 后不保留原区域；
- `inspect → crop → validate → annotate → 查看 → 修改 spec → 重渲染` 的 Agent 闭环；
- ImageContent、结构化结果、绝对路径和 Markdown 多路兼容输出；
- Claude Code 与 Codex 的直接安装、doctor、升级和卸载，而不是只提供图片处理库。

DOM selector 和 OCR 并非竞争定位的必要条件。它们应作为“定位器”向同一坐标/区域 Schema 产出结果；渲染内核不感知目标来自视觉模型、Playwright、OCR 还是用户手工坐标。

## 7. 技术实验与最终推荐

2026-08-30 在 Windows 11、Node.js `v24.18.1`、Sharp `0.35.4` / libvips `8.18.6` 上完成最小渲染实验。实验用同一张 960 × 600 模拟 UI 生成 PNG、JPEG、WebP 三种输入，并完成：

- 红框、箭头和半透明 highlight；
- 中文与英文混排、`word-char` 自动换行；
- 局部 Gaussian blur；
- 完全不透明 redact；
- 固定参数 PNG 输出和重新解码。

三种输入均被识别为 960 × 600；输出重新解码为有效 PNG；文字 sprite 为 312 × 67，未出现 tofu 或越界；redact 目标区域重新读取后只有 `17,17,17` 一种 RGB 值。实验输出已人工查看，箭头、中文、换行和覆盖位置正常。该实验使用 Windows 系统字体验证 Pango 路径，产品实现仍必须改用捆绑字体并把字体 hash 写入 sidecar。

因此最终采用：

- **语言与运行时**：TypeScript，Node.js 20.9+。
- **图片内核**：Sharp。
- **形状渲染**：受控 SVG overlay；箭头使用显式 line/polygon，spotlight 使用全画布遮罩和目标孔洞。
- **文字渲染**：Sharp Pango text sprite + 仓库捆绑 Noto Sans CJK SC，不依赖系统字体。
- **输出**：PNG + JSON sidecar；JPEG/WebP 作为输入，WebP 输出留作可选项。
- **隐私**：blur 仅视觉弱化；redact 使用不透明覆盖并做重解码/像素验证。
- **结构**：纯核心库，上层分别为 CLI 和本地 stdio MCP；Skill/Plugin 只负责工作流指导和安装体验，不重写渲染逻辑。
- **MCP 工具面**：优先 `inspect_image`、`validate_annotation_spec`、`annotate_image`、`crop_image` 四个稳定工具；contact sheet 仅在示例或迭代验证确有需求时加入。
- **兼容输出**：非图片工具返回 structuredContent + TextContent；图片工具统一返回受限 ImageContent + JSON TextContent、sidecar 和本地路径，并省略 structuredContent 以兼容 Codex 0.151。ResourceLink 延后到安全实现 `resources/read` 后。
- **定位功能**：MVP 不捆绑 Chromium/Tesseract；Playwright DOM bbox 和 OCR 作为后续 adapter。

捆绑字体同平台重复 hash、完整功能测试和真实 MCP 客户端调用是实现验收项，而不是继续扩大选型搜索的理由。

## 8. Claude Code 专项调研

本机安装 Claude Code `2.1.251`。当前 [MCP 文档](https://code.claude.com/docs/en/mcp)和 CLI 实测一致：stdio 添加形式为 `claude mcp add [options] <name> -- <command> [args...]`；可用 `list/get/remove` 管理。默认 scope 为当前项目的 local；user 作用域写入用户配置；项目 `.mcp.json` 需要信任/审批。

[Skills 文档](https://code.claude.com/docs/en/skills)规定 Skill 为含 `SKILL.md` 的目录，插件内 Skill 位于 `skills/<name>/SKILL.md`，由 description 自动匹配，也可显式调用。AgentCallout Skill 应只指导 `inspect → crop → annotate → 查看 → 修改 → 重渲染`，不重复实现渲染器。

[Plugin 参考](https://code.claude.com/docs/en/plugins-reference)与本机 `claude plugin init/validate` 证明当前插件使用 `.claude-plugin/plugin.json`、根级 MCP 配置和插件根路径变量。Marketplace 可从 GitHub 安装；[Marketplace 文档](https://code.claude.com/docs/en/plugin-marketplaces)支持仓库内相对 plugin source。正式安装目标为两条命令：

```powershell
claude plugin marketplace add https://github.com/xxf66666/AgentCallout.git
claude plugin install agent-callout@agent-callout
```

使用 HTTPS 全地址可避开 `owner/repo` 可能走 SSH 的差异。插件安装会在含 `package.json`/lockfile 时执行 `npm ci --ignore-scripts`，因此必须提交已构建的 JavaScript，且 MCP 命令直接使用 `node`，不能依赖 install/prepare 脚本。Windows 上还应避免裸 `npx` 的 `.cmd` 启动差异。

更新使用 marketplace update + plugin update；卸载使用 plugin uninstall，必要时再移除 marketplace。实际命令、重启要求和最终验证证据由 `docs/compatibility.md` 记录。

MCP 结果还受 Claude Code 输出上限约束；完整截图可能过大，故 ImageContent 应提供受控预览，完整 PNG 以绝对路径和 Markdown 返回。真实验收应使用 [headless/stream-json](https://code.claude.com/docs/en/headless)观察精确 `tool_use`/`tool_result`、输出 SHA 和二次重渲染，而不能只用“插件已列出”替代调用成功。

## 9. Codex 专项调研

本机安装 Codex CLI `0.151.0`。官方 [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)和 CLI 实测一致：

```powershell
codex mcp add agent-callout -- agent-callout mcp
codex mcp list
codex mcp get agent-callout --json
codex mcp remove agent-callout
```

stdio 配置写入 `~/.codex/config.toml` 的 `[mcp_servers.<name>]`，命令与 args 分开保存；CLI 方式优于让用户手写 TOML。Codex 会读取 MCP initialize 返回的 server instructions。

[Build skills](https://learn.chatgpt.com/docs/build-skills)说明 Skill 必须含 `SKILL.md` 的 `name` 与 `description`；本地可从 `.agents/skills` 发现。[Build plugins](https://learn.chatgpt.com/docs/build-plugins)和[插件打包文档](https://developers.openai.com/plugins/build/plugins)规定 `.codex-plugin/plugin.json`、`skills/`、`.mcp.json` 与 Git marketplace。当前 CLI 已实测支持可选 Skills-only Plugin：

```powershell
codex plugin marketplace add xxf66666/AgentCallout
codex plugin add agent-callout@agent-callout
```

最终 runtime 主路径仍是两条命令：

```powershell
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
codex mcp add agent-callout -- agent-callout mcp
```

Git marketplace 只物化并缓存插件文件，不替插件执行 `npm install`。进一步真实验收发现，Codex 0.151 的本地 Plugin MCP 子进程没有可用的 plugin-root `cwd`、环境变量或参数展开，因此不能可靠定位缓存内的 bootstrap。AgentCallout 最终选择后者：用 GitHub 全局 npm 包安装 runtime，再以 `codex mcp add agent-callout -- agent-callout mcp` 注册；Plugin 只承载 Skill。该变化及实测理由见 [ADR-0005](adr/0005-codex-direct-mcp-distribution.md)。

升级可用 `codex plugin marketplace upgrade agent-callout`，当前版本会刷新 Git snapshot 并重新安装已配置插件；卸载为 plugin remove，若不再保留来源再 marketplace remove。实际安装、首次依赖获取、Skill/MCP 发现、调用、二次重渲染和卸载仍必须逐项实测。

一个必须在实现中处理的当前客户端差异是：Codex `0.151.0` 支持 MCP `image` 内容块，但其结果转换路径在 `structuredContent` 非空时优先返回结构化 payload，可能使同一结果中的图片不进入模型上下文。因此图片工具不声明 output schema，并统一省略 `structuredContent`，改为返回 JSON TextContent + sidecar + 绝对路径 + ImageContent；inspect/validate/doctor 等纯结构化工具仍正常返回 structuredContent。若模型本身不支持图片输入，Codex 会插入省略说明，此时路径和 crop/sidecar 降级仍可用。该差异必须记录为客户端兼容策略，不能伪称协议能力在所有宿主中等价。

## 10. 调研停止结论

现有证据和 Windows 技术实验已足以锁定 Node/TypeScript + Sharp、几何 SVG 与指定字体文字 sprite 分离、CLI 与 stdio MCP 共用核心、Claude/Codex Plugin 包装的方案。继续扩大横向搜索不会改变实现优先级，因此在此停止调研，转入 ADR、实现、自动化测试和真实客户端验收。
