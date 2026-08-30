# ADR-0002：AnnotationSpec 与确定性自动排版

- 状态：已接受；Schema、布局和渲染测试已完成
- 日期：2026-08-30
- 关联：[决策索引](../decisions.md)、[调研第 3、5 节](../research.md#3-snipaste-与-pixpin-批注体验)

## 背景

Agent 需要保存、修改并重放批注，而不是只执行一次性的绘图命令。不同截图尺寸需要标准化坐标；多条中文/英文 callout 还必须避免越界、尽量不遮挡目标，并在无法完美放置时给出可修正证据。

## 考虑过的方案

| 方案                           | 优点                                            | 不采用的原因                                        |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------- |
| CLI 专用参数、无 sidecar       | 实现最快                                        | 无法稳定重放、删除单个标注、记录 hash 或供 MCP 共用 |
| 带随机 ID/时间戳的可变 scene   | 接近桌面编辑器内部模型                          | 相同输入不产生 canonical spec，破坏重复 hash 和审计 |
| 全部位置由调用者给定           | 算法最简单                                      | Agent 必须猜文字框，无法满足自动防越界/防遮挡目标   |
| 全局优化/约束求解              | 可能得到更优布局                                | MVP 复杂、难解释，参数微调可能导致大幅跳变          |
| **版本化 spec + 确定性启发式** | 可重放、可测试、可解释、Agent 可按 warning 重试 | 不保证所有密集场景的全局最优；接受该取舍            |

## 决定

### AnnotationSpec

- 根对象带 `version: "1.0"`；`annotations` 是有序数组。
- 每条 annotation 必须有调用者提供或确定性派生的稳定 `id`、受支持的 `type`、对应的点/矩形字段、`coordinateSpace` 和受控 `style`；禁止把当前时间或随机 UUID 注入 canonical 输入。
- 坐标原点固定为左上角；支持 `pixel` 和 0..1 的 `normalized` 坐标。解析后保留原始坐标，并在 sidecar 写入最终整数像素坐标。
- MVP 类型为 rectangle、ellipse、arrow、text、callout、numbered callout、highlight、spotlight、blur 和 redact。编号是显式数据或由稳定数组顺序确定，不依赖跨调用全局计数器。
- Schema 拒绝非有限数、非法尺寸和未知字段/类型。完全越界 target 是 error；与画布相交的矩形会确定性裁边并返回 warning，不得静默伪装成功。布局退化属于 warning，输入无效属于 error。
- canonical JSON、输入图 hash、规范化 spec hash、输出 hash、resolved layout、warning、renderer/font 版本一起写入 sidecar，使 CLI 与 MCP 产物可重放。

### 自动排版

1. 先用实际捆绑字体测量并换行：中文允许字符边界，英文优先单词边界，超长单词允许字符级回退。
2. 对自动 callout 以固定顺序生成上、右、下、左候选；每个候选使用相同 padding、gap 和 leader 规则。
3. 依次惩罚画布越界、遮挡自身 target、与已放置 label 重叠、leader 过长；排序相同时按固定候选顺序和 annotation 顺序决定。
4. 箭头/leader 从 label 边界连接目标边界，而不是穿过文字框中心。
5. 若无零冲突位置，仍选择代价最低的可见位置，并返回包含 annotation ID 与冲突原因的 warning；绝不静默删除批注。
6. 用户明确给定位置时尊重其意图，但仍执行边界验证并报告 warning/error。

## 后果

同一 spec 可由 CLI、MCP、Skill 和未来 locator adapter 共用，Agent 能只修改一个稳定 ID 后重渲染。确定性候选序和明确 warning 使布局测试、缺陷复现与审计简单。

代价是 sidecar 同时保存输入意图和解析结果，Schema 迁移必须版本化；密集标注可能仍重叠，MVP 应提示 crop、缩短文字或显式改位，而不是引入不可解释的随机优化。

## 验证状态

已通过：严格 Schema、像素/normalized 转换、越界、中文/英文长文本、多个 callout、稳定编号、相同输入重复 hash、布局 warning、十类渲染与像素断言。密集场景的全局最优和非 Windows golden 仍属于后续验证范围。

## 证据

- [Snipaste/PixPin 体验及结构化转译](../research.md#3-snipaste-与-pixpin-批注体验)
- [推荐渲染流水线](../research.md#53-推荐渲染流水线)
- [现有方案的 stable ID、sidecar 与布局缺口](../research.md#41-现有方案共同缺口)
- [PixPin 序列号](https://pixpin.cn/docs/mark/serial)与[文字标注](https://pixpin.cn/docs/mark/text)
