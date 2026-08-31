---
title: '可见且不遮挡目标的编号引线'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: '427c8606c752f7a67ec8358ca5e2afad97e6f966'
context:
  - '{project-root}/docs/annotation-spec.md'
  - '{project-root}/docs/adr/0002-annotation-spec-and-layout.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 1.1 numbered-callout 仍把 target 同时当作编号圆中心和标签排版基准；marker 会盖住小控件，约 14px 引线又常被 marker 完全遮住，用户看不出指向关系。

**Approach:** 为 1.1 增加版本感知的自动三段几何：target 保持业务目标，marker 贴在 label 朝向目标的一侧，leader 从 marker 圆边连接到 target 边界；1.0 继续逐字节走旧渲染路径。

## Boundaries & Constraints

**Always:** 1.0 canonical/spec hash、resolved geometry/style 和同平台 PNG 必须不变；1.1 的 target、marker、label、leader 分开记录且均在画布内；可行时外露 leader 不少于 24px，端点落在 marker/target 边界，不穿 label 或编号字形；布局、warning 和输出保持确定性。

**Ask First:** 任何新增公开 AnnotationSpec 字段、改变 1.0、改变 blur/redact 语义或引入外部依赖的方案。

**Never:** 本目标不实现全局 Layout v2、折线/曲线编辑、显式 label/leader 坐标、GUI、批量 API 或版本升级；不得提交私有 ERP 截图，也不得宣称所有历史 warning 清零。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 旧版重放 | 1.0 numbered-callout | 旧 marker、gap、绘制顺序和 hash 完全一致 | 旧 warning 语义不变 |
| 新版常规 | 1.1 point/小矩形/普通矩形 target；auto/四方向 | marker 不覆盖 target；leader 边界相连且可见 | 正常渲染 |
| 坐标适配 | pixel/normalized，长中英文 label | 解析后几何一致、文字不越界 | 无静默裁剪 |
| 紧张空间 | 靠边、小画布、多 callout | 确定性 clamp/换位；全部留在画布 | 不可满足时返回明确 warning |
| 公共入口 | 同一 spec 经 core、CLI、MCP | PNG/sidecar 几何一致；输入 Schema 不新增字段 | 失败不写半成品 |

</frozen-after-approval>

## Code Map

- `src/core/index.ts:706-735` -- 将 resolved spec 版本传给 renderer；默认/旧调用仍按 1.0。
- `src/renderer/index.ts:314-342,477-615,902-955` -- 复用 target 边界、文字测量和 marker 绘制，新增 1.1 三段几何及 leader→label→marker 合成顺序。
- `src/layout/index.ts:19-143,246-301` -- 复用确定性候选评分；抽取边界连线辅助，不改 1.0 候选算法。
- `tests/layout.test.ts`、`tests/render-effects.test.ts` -- 覆盖 target/placement/边缘/碰撞、像素可见杆、sidecar 几何与 1.0 golden。
- `tests/cli.test.ts`、`tests/mcp.test.ts` -- 用同一 1.1 fixture 证明公共入口一致且 Schema 无新增字段。
- `scripts/generate-examples.ts`、`examples/numbered-review/**` -- 重生公开编号示例；ui-bug/privacy 保持既有 hash。
- `docs/annotation-spec.md`、`docs/adr/0002-annotation-spec-and-layout.md`、Skill/reference -- 记录 1.1 自动几何和人工复核边界。

## Tasks & Acceptance

**Execution:**
- [x] `src/core/index.ts`、`src/renderer/index.ts` -- 增加版本化三段几何与可审计 resolved 输出，保留 1.0 路径。
- [x] `src/layout/index.ts` -- 提供确定性的形状边界连线与空间不足 warning。
- [x] `tests/*.test.ts` -- 覆盖矩阵、像素可见性、公共入口和 1.0 固定基线。
- [x] `scripts/generate-examples.ts`、`examples/` -- 重生编号示例并验证其余示例 hash 不变。
- [x] `docs/**`、Skill/reference -- 同步真实行为、限制和视觉复核规则。

**Acceptance Criteria:**
- Given 固定 1.0 fixture，when 解析并渲染，then canonical/spec SHA、完整 resolved 数据和 Windows PNG SHA 与 `427c860` 基线一致。
- Given 1.1 numbered-callout 的 point/rect target，when 使用任一 placement，then marker 与 target 不相交，leader 可见段在可行画布上至少 24px，端点误差不超过 2px。
- Given normalized 与 pixel 等价 spec，when 重复渲染，then resolved geometry 等价且 hash 各自稳定。
- Given 靠边、小画布或多标签冲突，when 无法满足理想几何，then 输出仍可解码且 warning 明确指向 annotation ID，不静默隐藏。
- Given 同一 1.1 fixture 通过 core、CLI、MCP，when 检查 sidecar，then target/marker/label/leader 几何一致且公共输入 Schema 未增加字段。
- Given 公开示例重生，when 自动与人工查看，then numbered-review 引线清晰且不遮内容、warning 为 0；ui-bug/privacy hash 与 `427c860` 相同，redact 验证继续通过。

## Spec Change Log

## Design Notes

1.1 自动 marker 固定在 label 朝向 target 的边缘外侧；leader 从 marker 圆边到 target 点或矩形边界。可见长度按边界间线段计算，不以中心距冒充。显式位置和 line/arrow 样式留给 Layout v2。

## Verification

**Commands:**
- `npm run verify` -- format、lint、typecheck、全部测试、build、dist 复现通过。
- `npm run examples` -- 示例重复生成字节稳定、零 warning、privacy oracle 通过。

**Manual checks (if no CLI):**
- 原尺寸查看 numbered-review 和 contact sheet；私有 ERP 只做本机抽检，不进入仓库或完成声明。

**Recorded evidence (2026-08-31, Windows):**
- `npm run verify`：Prettier、ESLint、TypeScript、96 项测试、build、三份 dist 可复现全部通过。
- `npm run examples` 重生后 diff hash 保持 `bcec6a5eb6fb6d29d2558bdde52abc4f3bab46f4`，三例 warning 均为 0。
- numbered-review PNG `ab32f6458acd099f454301f02fee31f7a1bea2230e5531c7249f5d681f1561bc`，sidecar `419cf0e9030b227f454b89ff49ec743067447b1474bc91dca83cf0c849dded9b`。
- 主线程查看原尺寸 numbered-review/contact sheet；三条 leader 均为 28px，marker 与 target 分离且内容无遮挡。

## Suggested Review Order

**1.1 三段几何入口**

- 版本专用 resolver 统一生成 label、marker、leader 和审计数据。
  [`index.ts:1111`](../../src/renderer/index.ts#L1111)

- Core 显式传入 spec 版本，1.0 默认路径不漂移。
  [`index.ts:706`](../../src/core/index.ts#L706)

**布局与碰撞边界**

- 圆到点/矩形边界连接以实际外露长度为准。
  [`index.ts:185`](../../src/layout/index.ts#L185)

- 候选评分纳入朝向 decoration，保持确定性顺序。
  [`index.ts:84`](../../src/layout/index.ts#L84)

- Final candidate 使用真实 painted geometry 和 grouped occupancy。
  [`index.ts:1192`](../../src/renderer/index.ts#L1192)

- 透明、舍入零宽和零长 leader 不绘制也不占位。
  [`index.ts:521`](../../src/renderer/index.ts#L521)

**公共契约与示例**

- 权威规范区分 1.0 legacy 与 1.1 自动几何。
  [`annotation-spec.md:140`](../../docs/annotation-spec.md#L140)

- ADR 记录组合占位和 leader→label→marker 绘制顺序。
  [`0002-annotation-spec-and-layout.md:40`](../../docs/adr/0002-annotation-spec-and-layout.md#L40)

- 生成器验证 marker、label、leader 均在画布且长度合格。
  [`generate-examples.ts:432`](../../scripts/generate-examples.ts#L432)

**回归与边界验证**

- point/rect × auto/四方向验证目标可见和像素引线。
  [`render-effects.test.ts:329`](../../tests/render-effects.test.ts#L329)

- 极小画布、透明线、边缘 clipping 和真实碰撞均有回归。
  [`render-effects.test.ts:629`](../../tests/render-effects.test.ts#L629)

- Layout helper 覆盖重叠、边界连接与 decoration overflow。
  [`layout.test.ts:173`](../../tests/layout.test.ts#L173)
