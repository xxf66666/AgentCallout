# ADR-0011：浏览器 DOM 定位器

- 日期：2026-09-13
- 状态：已接受，v0.4.0 实现中
- 依据：[路线图 0.4.0](../roadmap.md)、[ADR-0009 的可选运行时模式](0009-optional-local-ocr-locator.md)

## 决策

DOM 定位是独立的可选 locator：默认安装不包含浏览器运行库，需要时由 `agent-callout browser install` 显式安装。运行时为固定版本的 `playwright-core`（独立 lockfile，npm ci --ignore-scripts）+ 用户已安装的 Chrome（channel `chrome`，或显式可执行路径），**不下载 Chromium**；定位在受控子进程中执行。

定位输入为 `url` 与三选一的 locator：CSS selector、文字（复用 OCR 的归一化思想：NFKC、统一空白、CJK 空白折叠、大小写不敏感、exact/contains）、可访问性名称（role + name）。返回候选列表（默认上限 100，超出截断并报告 `totalCandidates`/`truncated`）：每个候选包含顶层页面 CSS 像素 `rect`、frame 蕗径、标签、文字、role/name 证据。

## 坐标语义与证据绑定

- 浏览器上下文固定 `deviceScaleFactor: 1`：全页截图像素坐标 == CSS 页面坐标，不引入 DPR 换算分歧。
- 候选 `rect` 与截图在同一阶段计算：`getBoundingClientRect` 逐层累加 iframe 在父页面中的偏移与滚动，换算到顶层页面坐标；iframe 内候选附完整 frame 路径。
- 每次定位同时产出全页 PNG 截图与其 SHA-256；候选 rect、页面状态（URL、标题、视口、scrollX/Y）与截图 hash 绑定在一起。**页面任何变化后旧坐标即失效**：批注必须使用当次截图作为输入图，工具不提供绕过截图复用旧坐标的路径；调用方核对证据中的 hash 与 URL 后才可标注。
- fixed 元素绑定当前滚动位置：rect 描述"截图那一刻"的可见位置，页面滚动后即随截图 hash 失效。

## 交互与验收边界

- 定位是只读操作：不点击、不提交、不注入持久脚本；等待元素可见时使用显式超时，超时返回 not-found 类结果而非部分猜测。
- 多候选必须由 AI 确认，语义与 OCR 一致；DOM 候选框同样不自动冒充"整个控件"的语义边界，文字候选仍需人工确认控件范围。
- 不把网页内容当指令执行；`locator` 只用于选择元素。
- 浏览器不可用、版本不匹配、页面崩溃均显式失败，不伪造候选。

## 验收

单元覆盖坐标换算（iframe/滚动/fixed）与证据绑定；集成测试在本机存在 Chrome 时以本地 fixture 页面运行（无 Chrome 的环境自动跳过并明确报告）。发布前完成打包、干净安装，以及 Claude Code 与 Codex 各一次真实"定位 → 批注 → 查看结果"。
