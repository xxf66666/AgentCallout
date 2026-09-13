# working copy、fork 与 revision diff（v0.4.1）

多个 AI 协作修改同一批注时的语义支持：目录副本显式化为 working copy 或 fork，任意两个 sidecar 之间按稳定 ID 对比差异。设计决策见 [ADR-0012](adr/0012-working-copy-fork-diff.md)。

## 命令

```powershell
agent-callout fork-lineage .\screenshot.annotated.json .\collaborator-copy --mode working-copy --json
agent-callout diff-revisions .\screenshot.annotated.json .\collaborator-copy\screenshot.annotated.json --json
```

- `fork-lineage` 把整个 lineage（base 与全部 `.revN` 的 JSON+PNG、原图）拷贝到目标目录，并写入 `fork.json`：源 lineage 身份（lineageId 与源 sidecar SHA-256）、模式（`fork` 分叉意图 / `working-copy` 协作副本）、时间戳、逐文件 SHA-256。**不重写任何 sidecar 字节**——修订链 hash 与父链校验原样保留。
- `diff-revisions` 对两个已验证 sidecar 的 `resolvedAnnotations` 做稳定 ID 对比：`added`、`removed`、`changed`（含变化字段与新旧值，长文本截断），并报告 lineage 关系：`same-lineage`（同目录演化）、`forked`（不同目录且有 fork.json 记录）、`unrelated`。
- MCP 等价工具：`fork_lineage`、`diff_revisions`（工具总数 14）。

## 协作工作流

1. 发起方把 lineage fork（或声明 working copy）给协作者；
2. 双方各自 `revise`，互不干扰（不同目录的锁互不相干）；
3. 随时 `diff-revisions` 查看双方分歧，按稳定 ID 用手工 `revise` 收敛。

## 边界

- fork.json 未签名，只防丢失与意外篡改；不是签名、加密或原图验证。
- 不自动 merge：合并分叉 lineage 需要三方语义与逐 ID 冲突规则，评估结论为推迟（ADR-0012）；`diff-revisions` + 手工 `revise` 覆盖当前需求。
- diff 是只读操作，基于 resolvedAnnotations 的深层相等，不渲染、不猜测控件语义。
