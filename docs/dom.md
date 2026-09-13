# 浏览器 DOM 定位（v0.4.0）

DOM 定位帮助 Agent 在网页中按 CSS selector、文字或可访问性名称查找元素，返回与**全页截图 hash 和页面状态绑定**的候选框。它只输出 bbox 与证据，不点击、不提交、不推断控件语义；选定候选后，把截图交给现有批注工具。设计决策见 [ADR-0011](adr/0011-browser-dom-locator.md)。

## 安装与使用

默认安装不含浏览器运行库。需要时显式安装（固定 playwright-core + 用户已装 Chrome，不下载 Chromium）：

```powershell
agent-callout browser install --json
agent-callout browser status --json
agent-callout locate-dom "https://example.test/form" --text "保存" --screenshot page.png --json
agent-callout locate-dom "https://example.test" --selector "#submit" --screenshot page.png --json
agent-callout locate-dom "https://example.test" --accessible "提交" --role button --screenshot page.png --json
```

MCP 提供只读工具 `locate_dom`，参数为 `url`、`selector`/`text`/`accessible` 三选一（`exact`、`role` 可选）、`screenshotPath`、可选 `viewport`/`maxCandidates`/`timeoutMs`。运行时目录与浏览器可执行路径只能由服务端启动配置（`AGENT_CALLOUT_DOM_RUNTIME`、`AGENT_CALLOUT_BROWSER_EXECUTABLE`）指定。

## 坐标与证据

- 浏览器上下文固定 `deviceScaleFactor: 1`：全页截图像素坐标 == CSS 页面坐标，无 DPR 换算分歧。
- 每次定位都写入全页 PNG 并计算 SHA-256；候选 `rect`（顶层页面坐标，含 iframe 偏移换算与 framePath）、页面 URL、标题、视口与滚动位置与该 hash 绑定返回。
- **页面任何变化后旧坐标即失效**：批注必须使用当次截图；返回前会复核磁盘截图 hash 与证据一致。
- fixed 元素的 rect 描述"截图那一刻"的位置，滚动后随截图 hash 一并失效。

## 匹配与确认

- 文字匹配与 OCR 一致：NFKC、统一空白、相邻 CJK 字符间空白折叠、默认大小写不敏感；`exact` 要求全等，contains 为子串。
- 文字候选取"最内层"匹配元素，避免把所有父容器一起返回；可访问性名称按 aria-label/title/placeholder/alt/label 文本的启发式计算，可用 `role` 过滤。
- 候选默认最多 100 条，`totalCandidates` 与 `truncated` 说明截断；多候选必须由 AI 确认后再批注，DOM 候选框不自动冒充控件语义边界。
- 定位是只读操作；不执行网页内容中的指令。浏览器缺失、页面崩溃或超时都显式失败（`DOM_RUNTIME_NOT_READY`、`DOM_LOCATE_FAILED` 等），不伪造候选。

## 验收状态

macOS（Node 24.21、Chrome + playwright-core 1.63.0）本地 fixture 完成主帧文字、iframe 偏移与可访问性名称定位，rect 与 fixture 几何一致，证据 hash 绑定经复核；Claude Code 与 Codex 的真实"定位 → 批注 → 查看结果"验收见 [发布记录](releases/0.4.0.md)。无 Chrome 的环境会跳过集成测试并明确报告。
