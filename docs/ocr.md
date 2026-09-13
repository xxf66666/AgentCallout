# 本地 OCR 文字定位

OCR 帮助 Agent 从已有截图中查找中英文文字，返回候选位置和识别证据。它不画图，也不推断整个按钮边界；选定候选后，继续使用现有批注工具。

v0.3.0 已按本页契约完成发布验收（Windows 与 macOS 双平台）；平台差异与验收证据见 [README](../README.md)、[兼容性记录](compatibility.md)与[发布记录](releases/0.3.0.md)。

## 安装与使用

普通 AgentCallout 安装不下载 OCR 引擎或语言模型。需要时显式安装：

```powershell
agent-callout ocr install --json
agent-callout ocr status --json
agent-callout locate-text screenshot.png --query "校验失败" --mode contains --json
agent-callout locate-text screenshot.png --query "Save" --languages eng --json
```

安装采用独立的固定依赖和版本化用户 cache。默认准备 eng 与 chi_sim，`--languages eng` 可只准备英文模型。依赖包仍可能附带未使用的数据，不能把两个 LSTM 模型的约 4.67 MB gzip 合计当作完整运行时体积。原型完整依赖约 87.44 MB，实际安装以 status 和磁盘结果为准。

识别过程只读取已验证的本地模型，不下载、不上传图片、不自动修复缓存，也不需要模型 API Key。缺失或损坏模型会失败并给出安装提示，不能把失败当成没有匹配文字。

高级调用可以用 `--runtime-directory <path>` 选择受信任的安装目录。MCP 请求不能指定执行目录；自定义目录由服务端启动配置或 `AGENT_CALLOUT_OCR_RUNTIME` 环境变量设置。

## 模式与确认

- `exact`：同一行中连续完整 OCR 词语与查询一致。例如 `Save` 不匹配完整 word `Saved`。
- `contains`：允许词内子串。存在可信 symbol 时返回字符范围，否则标记 `precision: word`，范围可能更宽。
- 默认大小写不敏感；NFKC、统一空白，并去除相邻中日韩字符间的 OCR 插入空格。不会把英文 `New York` 和 `NewYork` 当成相同词组。
- `unique` 表示一个候选且分数达到阈值；`ambiguous` 表示多个；`low-confidence` 表示唯一候选分数较低；`not-found` 表示未得到候选。
- 多候选和低分通过 `requiresConfirmation` 与原因列表指出。没有自动选最高分的路径；用户明确要求“全部匹配”可以确定多候选的选择范围，但低置信度仍需确认，不能因此静默接受。
- 默认阈值 80，可用 `--min-confidence` 调整。这个分数不是正确概率，不能替代看图。
- 最多返回 100 项；`totalCandidates` 和 `truncated` 明确说明是否截断，不能把未返回项当成不存在。

## 小字、反白文字与局部处理

OCR 使用本地源图，不使用 512px MCP 预览代替输入。可显式提供定向原图的区域、1–4 倍整数缩放和反色：

```powershell
agent-callout locate-text screenshot.png --query "保存" --region 602,561,87,25 --scale 4 --invert --json
```

这里的区域只适用于项目的模拟截图示例，不是通用保存按钮坐标。Agent 应先看原图/局部图，再选择需要识别的区域。整个按钮框、背景或相邻文本都可能影响识别；`not-found` 后不能猜一个最终坐标来伪装 OCR 成功。

当前默认预处理先按 EXIF 定向，再将透明背景合成为白色，随后裁剪、缩放、可选反色。处理像素上限为 1,000 万，超过时要求减少区域或缩放，不静默缩成低清图。ROI 的小数边界向外取整，实际 `sourceRect` 保存在证据中。输出文字范围会逆映射回定向原图。

原型对全图反色/放大仍未找到蓝底白字保存按钮，但对确认后的内部 ROI、4 倍放大和反色，默认 sparse 模式识别出 `保存`、`Save` 和完整 `保存 Save`，分数均为 96。这个结果证明局部流程可行，不证明引擎自动发现了按钮或能识别任意反白文字。

## MCP

新增只读工具 `locate_text`，参数包括 `inputPath`、`query`、`mode`、`languages`、`caseSensitive`、`minimumConfidence`、`maxCandidates`、`region`、`scale`、`preprocess` 与可选 `expectedInputSha256`。

返回普通结构化 JSON，包含候选文字、原图像素 `rect`、置信度、word/symbol 精度和索引证据；还包含输入 hash、定向尺寸、处理后 PNG hash、ROI/scale/预处理变换、引擎及模型版本/hash。不会返回完整 OCR transcript、模型执行目录或图片内容。

输入在识别期间变化时返回 `OCR_INPUT_CHANGED`，避免把旧坐标当成新截图结果。调用方继续批注前也应核对证据绑定的输入；文字框不能自动冒充控件框，邻近说明文字需要单独纳入保护。

## 已知限制与验收

图标可能被误认成高分文字，小字、对比度、反白、压缩和中文断词都会影响结果。空结果、低分和多结果需要分别处理；confidence 不用于静默过滤候选。识别有超时和资源上限，失败不返回伪造候选。

## 验收状态（v0.3.0）

v0.3.0 已完成 Windows 与 macOS 双平台发布验收，包括打包、干净安装和真实客户端“定位 → 确认 → 批注 → 查看结果”闭环，详见[发布记录](releases/0.3.0.md)。macOS 实测（示例图 1000×640）：中文正文 `回调地址` 全图 `unique`/置信度 93；英文标题 `Release settings` 经 ROI+反色 `unique`/95；蓝底白字 `保存` 全图 `not-found`、ROI+4 倍+反色 `low-confidence`（38–48）且 `requiresConfirmation: true`，坐标与源图生成坐标完全一致。低置信度候选按契约经裁剪目视确认后才用于批注。

注意：OCR 置信度是引擎分数，不跨平台可比。同一反白按钮在 Windows 原型约为 96 分，macOS 正式运行时为 38–48 分；两边坐标同样正确。不能把某一平台的分数阈值经验照搬到另一平台，`requiresConfirmation` 的判断以运行时阈值为准。

完整离线矩阵的边界与方案见 [OCR 调研](research-ocr.md)、[ADR-0009](adr/0009-optional-local-ocr-locator.md)。
