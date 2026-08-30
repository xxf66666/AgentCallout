# AgentCallout 路线图

> 路线图描述产品边界和验收顺序，不代表功能已经实现。真实状态与运行证据以 `PROGRESS.md` 和 [`compatibility.md`](compatibility.md) 为准。

## 范围总览

| 能力                                                      | MVP 0.1：已有截图批注 | Next 0.2：定位适配器    | Later         |
| --------------------------------------------------------- | --------------------- | ----------------------- | ------------- |
| PNG/JPEG/WebP 已有截图输入                                | **是**                | 维护                    | 维护          |
| rectangle、ellipse、arrow、text/callout、numbered callout | **是**                | 改进布局                | 编辑器交互    |
| highlight、spotlight、blur、安全 redact                   | **是**                | 改进检测与验证          | 更多视觉效果  |
| 像素/归一化坐标、sidecar、hash、warning、可重放           | **是**                | 适配器继续输出同一 spec | 跨媒体 spec   |
| CLI + 本地 stdio MCP                                      | **是**                | 维护兼容                | 更多宿主集成  |
| Claude Code/Codex GitHub 直接安装                         | **是**                | 持续回归                | 更多 Agent    |
| OCR 文字定位                                              | **否**                | **可选本地 adapter**    | 语言/版面扩展 |
| Playwright/DOM selector 定位                              | **否**                | **可选 DOM adapter**    | 更多 UI 框架  |
| 完整桌面 GUI                                              | **否**                | 否                      | **以后**      |
| 系统截图快捷键/桌面捕屏                                   | **否**                | 否                      | **以后**      |
| GIF/录屏/视频编辑                                         | **否**                | 否                      | **以后**      |
| 云同步、账号、计费                                        | **否**                | 否                      | 未承诺        |

## MVP 0.1：给 Agent 一支“截图批注笔”

MVP 只解决一个闭环：Agent 对用户已有的截图执行 `inspect → 必要时 crop → validate → annotate → 查看结果 → 修改 spec → 重渲染 → 插入 Markdown`。它不是截图软件、浏览器自动化框架或桌面图片编辑器。

### 核心与数据模型

- TypeScript + Node.js 20.9+；Sharp 负责图片解码、合成、blur 和 PNG 输出。
- 受控 SVG 只绘制几何图形；文字使用捆绑 Noto Sans CJK SC，经 Sharp/Pango 生成独立 sprite。
- 版本化 AnnotationSpec，包含稳定 annotation ID、左上角原点、像素与 `0..1` 归一化坐标、样式、输入/spec hash 和边界校验。
- 确定性的上/右/下/左 callout 候选评分，处理画布越界、目标遮挡和已放置标签碰撞；无法理想排版时返回 warning，不能静默丢弃。

### MVP 批注能力

- 说明重点：rectangle、ellipse、text、callout、numbered callout。
- 指向目标：arrow，及 callout 到目标的连接。
- 强调区域：highlight 与 spotlight，二者语义保持独立。
- 隐私处理：blur 仅视觉弱化；redact 执行不可透明恢复的像素覆盖并通过重解码像素测试。
- 输入支持 PNG、JPEG、WebP；输出固定为可直接查看的 PNG 与可修改的 JSON sidecar。

### 工具与交付

- 一个纯 core 同时服务 CLI 与 stdio MCP，MCP 首批工具为 `inspect_image`、`validate_annotation_spec`、`annotate_image`、`crop_image`。
- 返回原图/输出尺寸、annotation 数量、warning、输入/输出 hash、renderer/font 版本、输出绝对路径、Markdown 引用和 sidecar。
- 图片工具在兼容宿主中返回受控 ImageContent；不支持时仍有 JSON TextContent、本地路径和 Markdown 降级。
- Claude Code 与 Codex 各提供最多两条主要命令的 GitHub marketplace 安装路径，以及 doctor/self-test、升级和卸载。
- 提供 `ui-bug`、`numbered-review`、`privacy` 三组由项目自身真实生成的可再分发示例。

### MVP 发布门槛

只有以下证据齐备才发布 0.1：干净 clone 安装成功；lint/typecheck/test/build 通过；CLI 真实生成并重新解码图片；MCP Server 启动及 tool 调用成功；三组示例可重放；中英文和自动布局通过视觉检查；redact 通过像素验证；Claude Code/Codex 安装、发现、调用、二次渲染和卸载按兼容矩阵完成。未验证项必须保留为 NOT VERIFIED，不能用文档或 mock 替代。

## Next 0.2：可插拔定位，而不是扩大渲染内核

MVP 稳定后，下一项优先工作是让 Agent 更可靠地获得目标 bbox。适配器只产生同一个 AnnotationSpec 的坐标/目标区域，不能复制渲染器。

### OCR locator adapter

- 可选、完全本地的 OCR 包；默认安装不下载语言模型。
- `locate_text` 返回候选 bbox、文字、语言、confidence 和可追踪来源，低置信度必须要求 crop/查看确认。
- 首先验证中英文 UI、DPI 缩放、小字体和多候选歧义，再决定 Tesseract.js 或替代实现。
- OCR 只帮助定位，不自动把识别文字写入日志，也不能被宣传为安全敏感信息检测。

### DOM/Playwright adapter

- 从 Playwright locator、CSS selector 或 accessibility reference 获取 bbox，并把截图与坐标交给 core。
- Chromium/Playwright 是可选 integration，不进入默认运行依赖，也不让任意网页脚本进入渲染进程。
- 处理 viewport、device scale factor、滚动、iframe、元素遮挡和截图时序，并保存定位证据供重放。

### 同阶段体验改进

- contact sheet/局部放大镜，帮助 Agent 在多个 crop 间选择目标。
- 更好的多 callout 全局碰撞评分、引线绕行和密集区域 warning。
- 在实现安全、受限的 `resources/read` 后评估 ResourceLink；在此之前继续使用 ImageContent + 路径降级。
- 对更多宿主和 Node LTS/操作系统建立 CI 与兼容性回归。

## Later：桌面创作与时间媒体

以下能力明确不进入 MVP，也不与 0.2 的定位适配器捆绑：

1. **系统截图入口**：Windows/macOS/Linux 截图快捷键、窗口/区域捕获及多屏/DPI 处理。它应是调用同一 core 的平台 adapter。
2. **轻量 GUI**：打开 sidecar、拖动/缩放/删除批注、调整样式并保存 spec。GUI 不能产生与 CLI/MCP 不兼容的私有格式。
3. **录屏与视频**：GIF/MP4、时间轴标注、逐帧 redact、字幕和导出。视频需要单独的性能、音频、codec、隐私与文件体积设计，不能通过对单帧循环渲染草率实现。
4. **协作与云能力**：云同步、共享评论、账号和计费目前没有承诺；任何引入都必须重新评审“本地优先、无遥测”的产品承诺。

## 优先级规则

路线图按以下顺序取舍：真实 Agent 可用性、Claude Code/Codex 安装体验、Windows 稳定性、redact 安全性、可复现输出、跨平台扩展、维护成本。新功能只有在不破坏 AnnotationSpec 兼容性、不增加默认云依赖并拥有可运行证据时才进入发布范围。
