# ADR-0012：working copy、fork 与 revision diff

- 日期：2026-09-13
- 状态：已接受，v0.4.1 实现中
- 依据：[ADR-0006 修订事务](0006-safe-versioned-annotation-revisions.md)、[路线图 0.4.x](../roadmap.md)

## 决策

目录副本的语义此前只是文档约定（ADR-0006：复制的 lineage 是可分叉的独立 working copy）。本决策把它变成显式命令，且**不重写任何已验证 sidecar 字节**——所有修订链 hash/父链校验原样保留：

- `fork-lineage <sidecar> <target-dir>`：把整个 lineage（base 与全部 `.revN` 的 JSON+PNG、原图）拷贝到目标目录，并写入 `fork.json`（源 lineage 身份、模式、时间戳、逐文件 SHA-256 清单）。`--mode working-copy` 记录副本意图为协作副本；默认 `fork` 记录分叉意图。两者文件操作相同，语义差别只在记录与后续 diff 报告。
- `diff-revisions <sidecarA> <sidecarB>`：对两个已验证 sidecar 的 `resolvedAnnotations` 做稳定 ID 级对比（added/removed/changed），并报告 lineage 关系（same-lineage / forked / unrelated）。对 fork 场景，`fork.json` 参与关系判定；不尝试内容级合并。

## 为什么不重写 lineageId

修订引擎对 lineageId 的推导是 `parent.revision?.lineageId ?? parent.sha256`：重写副本 lineageId 需要同时改写 revision 记录并保持命名与父链一致，收益仅是身份隔离，而这已由"不同目录 lock 互不相干 + diff 的关系判定"覆盖。自动 merge 的评估结论是**推迟**：合并分叉 lineage 需要 base/fork/other 三方语义与逐 ID 冲突规则，当前 `fork-lineage` + `diff-revisions` 已覆盖"分叉后看清差异、手工 revise 收敛"的工作流。

## 交付边界

- fork.json 未签名，只防丢失与意外篡改；diff 为只读操作，不渲染、不猜语义。
- 逐 ID 对比基于 resolvedAnnotations 的深层相等；changed 报告变化字段与新旧值（截断长文本），不承诺字段级 diff 完备性。
- 测试覆盖：全链拷贝与 fork.json 证据、working-copy 模式、diff 的 added/removed/changed 与关系判定、跨 fork 对比、中文路径。
