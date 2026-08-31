---
title: '可读的批注默认样式'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 0
baseline_commit: 'b54e41f34b7815da54b9e432b58e516bbac3e822'
context:
  - '{project-root}/docs/annotation-spec.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 普通说明框几乎全部继承红底白字，看起来像严重告警；逐条重复样式也让 spec 冗长。直接修改 1.0 默认值会破坏既有 sidecar 重放。

**Approach:** 严格保留 AnnotationSpec 1.0 的解析、canonical JSON、默认值和像素输出；新增 1.1，以克制的文档风格为默认，并支持 preset、语义 tone、根级 defaults、独立 marker 配色及 maxWidth。

## Boundaries & Constraints

**Always:** 1.0 的 canonical、resolved style/geometry 和同平台 PNG 必须不变；1.1 优先级为 `annotation.style > tone > root defaults > preset/type defaults`；红色仅由 `danger` 或 `classic-red` 产生；redact 安全约束高于主题；两版均严格拒绝未知字段。

**Ask First:** 改变 1.0 输出、删除旧版本支持、改变 blur/redact 语义或新增外部运行依赖。

**Never:** 不修改引线/布局，不加入批量、修订、语义包、OCR/DOM、GUI 或随机配色；不得更新旧 golden 掩盖 1.0 回归。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 旧版重放 | 合法 1.0 spec | canonical、resolved style 和输出 hash 与基线一致 | 1.1 字段继续拒绝 |
| 新版默认 | 最小 1.1 spec | `docs-light`：浅底深字、蓝色边框/marker | 正常渲染 |
| 多级覆盖 | preset、defaults、tone、局部 style 并存 | 每个字段按固定优先级确定 | 非法枚举/颜色按字段失败 |
| 长中文/错误输入 | 设置 `maxWidth` 或给出非法版本/字段 | 合法值换行且不越界 | 非法值不写输出 |

</frozen-after-approval>

## Code Map

- `src/spec/index.ts:69-699` -- 建立严格 1.0/1.1 分支，解析新样式并产出完整 resolved style。
- `src/renderer/index.ts:168,461-586` -- 复用既有渲染，接入 maxWidth 与独立 marker 配色；不改变 gap。
- `tests/spec.test.ts` -- 双版本严格解析、canonical 基线、四 preset/五 tone、覆盖优先级、redact 和边界值。
- `tests/render-effects.test.ts` -- 固化 1.0 PNG/hash；验证 1.1 标签、marker 对比度及重复渲染确定性。
- `scripts/generate-examples.ts`、`examples/` -- 示例迁移到 1.1，保留 1.0 回归 fixture。
- `docs/annotation-spec.md`、`plugins/agent-callout/skills/agent-callout/**` -- 记录迁移和用法，让 Agent 默认使用 1.1 且普通说明不用 danger。

## Tasks & Acceptance

**Execution:**
- [x] `src/spec/index.ts` -- 添加双版本 Schema 与新样式字段。
- [x] `src/renderer/index.ts` -- 接入 resolved label/marker 色彩和宽度，保持 1.0 路径不变。
- [x] `tests/*.test.ts` -- 先记录 1.0 基线，再覆盖 1.1 正常与错误路径。
- [x] `scripts/generate-examples.ts`、`examples/` -- 重生并查看三组 1.1 示例。
- [x] `docs/annotation-spec.md`、Skill/reference -- 同步双版本契约和语义色规则。

**Acceptance Criteria:**
- Given 现有 1.0 fixture，when 解析并渲染，then canonical、resolved style/geometry 和 PNG SHA-256 与基线一致。
- Given 无显式样式的 1.1 numbered-callout，when 渲染，then 标签浅底深字、marker/边框为蓝色，且正文对比度不低于 4.5:1。
- Given preset、defaults、tone 和 annotation style 同时存在，when resolve，then 最终字段逐项符合优先级且重复运行相同。
- Given 非法版本、tone、preset、maxWidth、颜色或未知字段，when validate，then 对应字段失败且不写输出。
- Given 三组公开示例重生，when 自动检查并人工查看，then 中文可读、普通说明非 danger 红底、无新增 warning，privacy redact 像素验证继续通过。

## Spec Change Log

## Verification

**Commands:**
- `npm run format:check && npm run lint && npm run typecheck && npm run test` -- 全部通过且 1.0 golden 不变。
- `npm run build && npm run check:dist` -- 构建产物可复现、Plugin 无漂移。
- `npm run examples` -- 示例、sidecar、redact 和重解码检查通过。

**Manual checks (if no CLI):**
- 查看三组示例和联系表，确认普通说明不再满屏红底，亮/暗背景下标签与编号均清楚。

**Recorded evidence (2026-08-31, Windows):**
- `npm run verify`：Prettier、ESLint、TypeScript、70 项测试、build、三份 dist 可复现全部通过。
- `npm run examples` 重生后 diff hash 保持 `f9bdbd24e5ed68f442c307219eb01d8dd060cc9e`，三例 warning 均为 0。
- 输出 SHA-256：ui-bug `bb3d3b9faf8c249b3fefafb44b74c8a579c13868a2a191d544cf0511c5a46bf6`；numbered-review `21e426c854bf47d99a593ab2cb2523d3ab63ab8afbb42188ec3ff8f11b5dc721`；privacy `c3e52a99d622a3c5cad5eda7c7a0e86bcca0d5e5a543e29f3961476032c727b6`。
- 主线程逐张查看三张原尺寸输出和 contact sheet；普通说明非红底，目标文字无遮挡，privacy redact 为不透明覆盖。

## Suggested Review Order

**版本化样式契约**

- 严格分流 1.0 与 1.1，保住旧 canonical 行为。
  [`index.ts:395`](../../src/spec/index.ts#L395)

- 冻结四套 preset 与五种 tone 的完整色板。
  [`index.ts:601`](../../src/spec/index.ts#L601)

- 逐字段合并 preset、defaults、tone 与局部 style。
  [`index.ts:974`](../../src/spec/index.ts#L974)

**渲染边界**

- 文字测量失败时安全缩字或拒绝，不产生超宽输出。
  [`index.ts:409`](../../src/renderer/index.ts#L409)

- 标签与编号 marker 使用独立且可审计的颜色。
  [`index.ts:562`](../../src/renderer/index.ts#L562)

**公共入口与示例**

- CLI 新建示例默认 1.1，同时保留 1.0 重放说明。
  [`program.ts:507`](../../src/cli/program.ts#L507)

- 权威规范记录双版本、优先级、限制与迁移方式。
  [`annotation-spec.md:1`](../../docs/annotation-spec.md#L1)

- 生成器统一产出零 warning 的 1.1 公开示例。
  [`generate-examples.ts:141`](../../scripts/generate-examples.ts#L141)

**验证与工程卫生**

- 固定 1.0 golden，并验证 1.1 像素与宽度边界。
  [`render-effects.test.ts:152`](../../tests/render-effects.test.ts#L152)

- 全字段优先级和所有内置色板对比度均受保护。
  [`spec.test.ts:230`](../../tests/spec.test.ts#L230)

- MCP 真实执行 1.1 validate 与 annotate 公共路径。
  [`mcp.test.ts:139`](../../tests/mcp.test.ts#L139)

- 本地 BMAD 目录不再污染产品 lint/format 门禁。
  [`eslint.config.mjs:9`](../../eslint.config.mjs#L9)
