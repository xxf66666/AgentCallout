# ADR-0006：批注采用完整性父链与 sidecar-last 的 append-only 修订

- 状态：已接受；Windows 自动化路径已验证，真实客户端回归待补
- 日期：2026-08-31

## 背景

既有 annotate 可以从完整 AnnotationSpec 生成一个 PNG/JSON 对，但 Agent 二次调整时只能另选输出、删除旧文件，或尝试 MCP 并未开放的 `overwrite`。这些做法会丢失修订历史，也无法可靠区分陈旧 parent、并发分支和移动后的原图。

修订必须保持现有 annotate/crop/contact-sheet 语义不变，并继续以原图和 canonical AnnotationSpec 为事实来源；`resolvedAnnotations` 只是审计输出，不能反推输入 spec。

## 考虑过的方案

| 方案                              | 优点                       | 结论                                         |
| --------------------------------- | -------------------------- | -------------------------------------------- |
| 覆盖原 PNG/JSON                   | 文件名固定                 | 破坏历史与并发安全；拒绝                     |
| 让调用方传完整新 spec             | 接口简单                   | 难以审计改动范围，容易改根字段；拒绝         |
| JSON Patch / merge patch          | 通用                       | `set` 语义和数组顺序不清晰，扩大攻击面；拒绝 |
| 扫描磁盘寻找同 hash 原图          | 移动后更自动               | 越出显式授权与可预测 I/O；拒绝               |
| **稳定 ID edits + 新 `.revN` 对** | 改动最小、可重放、保留历史 | 采用                                         |

## 决定

从通过严格结构、路径、hash 与父链验证的 annotate sidecar 接受有序 `add`、`set`、`remove`。`add` 必须显式新 ID，可选 `afterId`；`set` 是同 ID 的完整替换并保序；`remove` 精确命中。重复触碰、未知 ID、no-op 或最终 spec 非法使整批失败。这里的“通过验证”不等于签名或不可篡改。

每次沿 parent 指针验证 sidecar bytes、parent output/spec hash、edits hash、连续编号和 lineageId，并从原图重新渲染。相对原图缺失或使用 basename-only 语义时，只接受调用方显式给出的同 SHA-256 文件。

同一 sidecar 目录中的 lineage 使用排他 lock。完整 lock 先暂存、flush，再以 no-replace link 发布，避免其他进程观察到正常流程中的空 lock。完整 temp PNG/JSON 随后写入并 flush，以 no-replace 方式发布 PNG，最后发布 JSON；只有读回并完整验证通过的 JSON sidecar 才是提交标志。revision manifest 1.1 的 `revision` 块记录 number、lineageId、直接父 sidecar/output/spec hash、规范化 edits 与 edits hash。直接父指针使 canonical spec/edits 的完整祖先链可逐级重放；像素一致仍依赖同一原图、renderer、字体与平台。

每批最多 400 个 edits；单 sidecar 最多 10 MiB；单工作副本最多 255 个 revision、256 份链条 sidecar，累计 sidecar+输出预算为 512 MiB。达到边界时先返回 `REVISION_LIMIT_REACHED`，不能生成下一次无法读取的 revision。

## 后果

同一目录/同一 head 上的陈旧 parent 不能产生分支，16 个并发进程最多一个提交同一 `revN`。旧 sidecar、旧 PNG 和原图只读，捕获到的发布故障会清理本事务 temp 与自有 orphan PNG。把完整 lineage 复制到另一个目录会形成独立工作副本，两边可以 fork；本地 lock 不是跨目录、跨主机的全局共识。

代价是两个目录项不能构成断电级跨文件原子事务。进程强杀或掉电可能留下 lock、temp 或无 sidecar 的 PNG；dead PID、token、lineage/parent/path 与 hash 都匹配时可自动恢复，证据不完整时返回 `REVISION_RECOVERY_REQUIRED` 并保留现场。已提交后发生的 lock/temp 清理问题放在结果的 `recoveryWarnings`，不污染 sidecar 的渲染 warnings。hash 提供完整性关联，不是签名，也不能防御拥有同一目录写权限的恶意进程。

CLI 新增 `revise <parent.json>`，只接收 edits 和可选移动后 input；MCP 新增图片工具 `revise_annotation`，不暴露 output、overwrite 或 revision number，继续返回 JSON TextContent + ImageContent 且无 structuredContent。

## 验证边界

自动化覆盖 base→add→set→remove、移动/异字节 input、不可信 sidecar、非法 edits、路径/alias、16 进程竞态、所有暂存/flush/发布故障点及 core/CLI/MCP 一致性。真实 Claude/Codex 宿主仍须在客户端升级或发布前确认修订预览确实进入模型上下文；存在路径或 SDK ImageContent 不等于已完成视觉复核。
