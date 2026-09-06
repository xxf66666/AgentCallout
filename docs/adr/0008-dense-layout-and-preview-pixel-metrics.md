# ADR-0008：1.1 密集布局、完整路径与客观预览像素指标

- 日期：2026-09-06
- 状态：已接受；v0.2.1 实现与回归进行中，尚未发布
- 补充：[ADR-0002](0002-annotation-spec-and-layout.md)、[ADR-0007](0007-focused-review-and-safe-sidecar-summary.md)
- 契约：[AnnotationSpec](../annotation-spec.md#dense-layout-and-resolved-geometry-v021)

## 背景

逐条放置说明框只能看见先前已经占据的区域。后续目标、编号外圈、固定文字和箭头头部容易被遗漏；端点之间的一条直线也无法绕开居中的说明框。用户已经报告短箭头和密集批注可读性问题，并要求失败时给出明确 warning。

聚焦预览能够减少发送的图像面积，但客户端的图片计费和 token 处理不由 AgentCallout 决定。需要提供可复算的栅格指标，并让指标对应真正发送的图片字节。

## 决策

### 1. 只改变 AnnotationSpec 1.1 的渲染路径

保持输入 Schema 版本为 1.1，将 renderer 版本提升到 0.2.1。先测量全部 text/callout/numbered-callout，再批量选择说明框位置，最后规划路由并按原始数组顺序绘制。

说明框候选包含逻辑框、实际描边外扩和编号占位。全部 callout 和独立 arrow 的目标在规划开始前进入保护集合，显式 text 作为固定障碍。编号优先位于面向目标的说明框外侧；必要时选择可行的其他边。直线或正交折线路由考虑说明框、编号、固定文字、其他目标、实际线宽和箭头头部。连接自己的目标以及相同几何的共享目标不算错误穿越。

AnnotationSpec 1.0 保留旧的逐条排版和绘制分支，不增加新默认值、结构化布局字段或裁切行为。固定 PNG 回归只在已记录的相同平台、字体、Sharp/libvips 环境下证明兼容；跨平台逐字节相同仍不是承诺。

### 2. 用有界搜索和明确诊断处理不可行布局

密集布局最多接受 200 个说明框。每项最多 128 个候选，beam 默认 96、最大 128；大批量输入缩小预算。路由通道同样受限。低层布局参数检查有限值与相对画布的上界，不能用极大数值绕过预算。

评分优先保护目标、避免说明框重叠和画布外溢，再比较位置偏好和连接距离。它是确定性启发式，不承诺全局最优，也不保证所有合法输入都有无冲突解。无解时保留输出并标记 `layout.status=degraded`，以稳定 code 说明问题。核心诊断包括 `LEADER_TOO_SHORT`、`TARGET_COVERED`、`CALLOUT_OVERLAP`、`LEADER_ROUTE_BLOCKED` 和 `INSUFFICIENT_SPACE`。

1.1 说明框的文字先换行、缩小；6px 仍装不下时有限裁切，并报告 `TEXT_CLIPPED` 和实际省略的非透明文字像素数。完整文字留在 sidecar。独立 text 和 1.0 延续无法容纳时失败的行为。字号或几何缩减通过 `TEXT_SIZE_REDUCED` / `GEOMETRY_CLIPPED` 公开。

### 3. 记录真正绘制的路径

说明框的 `leader` 与独立箭头的 `path` 记录 `kind`、`start`、`end`、`points`、`segments`、`pathLength`、`bendCount`、描边范围及有效 `strokeWidth`。原有 `length` 仍表示两端的直线距离。零线段省略 `bounds`；未清除的障碍记录为 `collisionIds`。箭头头部另外记录 `tip`、两个 `wings` 点和 `bounds`。

这些是 resolved output，不加入 AnnotationSpec 输入。修订聚焦范围必须覆盖完整折线、箭头头部、说明框和编号的实际像素范围，并继续合并真实 RGBA 差异。不能把折线当成直线，也不能把 shaft bounds 当成包含箭头头部的范围。

### 4. 只报告栅格像素指标

`createImagePreview` 返回七字段 `pixelMetrics`：完整定向画布像素数、源区域像素数、最终预览像素数，以及区域/完整、预览/区域、预览/完整和相对完整图的像素缩减比例。比例保留六位小数并限定在 `[0, 1]`，计算发生在 EXIF、裁剪和最终缩放之后。

成功发送 MCP 图片时，JSON TextContent 的 `preview.pixelMetrics` 与 ImageContent `_meta["agent-callout/pixelMetrics"]` 完全相同。不发送图片就不返回这些指标；它们不写入 AnnotationSpec 或持久 preview sidecar。像素比例不等价于细节保留率、图片 token、费用或压缩比。

MCP 先确认预览输入匹配已提交输出的 hash/尺寸，再对最终读取的预览字节比对生成 hash，并检查 PNG 单页 metadata、尺寸和字节/像素预算。发送的是经过这些检查的同一个 Buffer。绑定失败按 `encoding-failed` 返回 text-only 成功结果，保留已提交文件，不发送替换图片或像素指标。

## 取舍与范围

- 批量规划会使一次文字修改带动其他说明框移动；revision 的 affected 范围需要追踪这种连带变化。
- 大批量输入缩小候选预算，可能找不到存在但未搜索到的解；warning 必须保留，用户或 Agent 仍需查看结果。
- 显式 placement 是偏好，安全的可行位置可能在另一侧。显式 text/blur/redact 等位置保持其各自语义，布局器不做 OCR 或自动发现原图内容。
- 同平台确定性不要求跨 renderer 的 1.1 像素一致。旧 sidecar 应保留 renderer/font 元数据；父图无法由当前 renderer 重现时，revision 聚焦仍按既有规则回退。
- 本轮不加入 OCR、DOM locator、PNG 隐藏图层或专有交接编码；后续适配器继续输出普通 AnnotationSpec 坐标。

## 验证要求与当前状态

现有分支已经包含密集布局/渲染、像素指标及 MCP 绑定回归。该 ADR 不把测试文件存在等同于通过，也不记录尚未完成的发布结论。发布前必须关闭：

1. plain、numbered、mixed 的 1/3/6/10 场景，未来目标、边角和小目标、固定 text、多行文字及不可行场景。
2. 说明框与目标的几何检查、路由/箭头头部真实像素检查、确定性 hash/geometry/warnings，以及 AnnotationSpec 1.0 固定 PNG 基线。
3. 超预算与极端有限值拒绝、完整文字保留、裁切像素计数、warning 代码，以及 revision 裁剪覆盖整条路由。
4. EXIF/crop/resize 后指标可复算，所有无图片分支无指标，最终预览/输出被替换时不发送图片。
5. 完整本地门禁、干净安装、doctor/MCP 与真实 Claude/Codex 密集批注视觉 A/B。

实际结果以 [PROGRESS](../../PROGRESS.md) 和 [compatibility](../compatibility.md) 为准。
