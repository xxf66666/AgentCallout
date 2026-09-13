# ADR-0010：跨 AI 一键交接包（create-handoff）

- 日期：2026-09-13
- 状态：已接受，v0.3.1 实现中
- 依据：[路线图 0.3.1](../roadmap.md)、[ADR-0006 修订事务](0006-safe-versioned-annotation-revisions.md)、[ADR-0007 安全摘要](0007-focused-review-and-safe-sidecar-summary.md)

## 决策

交接包是一个**普通目录**，不引入压缩包、专有编码或隐藏元数据；接收方用任意编辑器和图片查看器即可读取，安装 AgentCallout 后获得校验、重渲染与修订能力。`agent-callout create-handoff <sidecar>` 从已验证的 annotate sidecar 创建：

```
<base>.handoff/
├── HANDOFF.md          # Markdown 入口：文件角色、读取顺序、验证/修订命令、隐私提示
├── manifest.json       # handoff 清单 v1：生成器版本、ISO-8601 创建时间、文件角色 + SHA-256 + 字节数
├── summary.json        # 复用 inspect_annotation_sidecar 的安全摘要（不含路径/hash/ID/文字）
├── <原名>.annotated.png    # 批注结果 PNG（保留原文件名）
├── <原名>.annotated.json   # 完整 sidecar（保留原文件名，不重写任何内部字段）
└── <原名>.png              # 原图拷贝（--no-original 可省略）
```

**保留原名是硬性决策**：sidecar 的 `paths` 使用相对引用，revision 链要求 `<stem>.revN.json` 命名与编号一致。重命名或重写 sidecar 会同时破坏两者，因此包内文件一律原样拷贝。handoff 自身新增文件固定使用 `manifest.json`、`summary.json`、`HANDOFF.md` 三个保留名；用户文件与之重名时报 `HANDOFF_NAME_CONFLICT`，要求改名后重试。

manifest 只描述**创建时快照**。包内继续 revise 会产生新 `.revN` 文件，不回写 manifest；`verify-handoff` 校验 manifest 清单内文件的 hash 与存在性，并另行运行完整 sidecar 校验（含输出 hash 与父链），修订演进由 sidecar 链本身描述。

## 原图与隐私

修订和重渲染需要原图，因此**默认拷贝原图**；`--no-original` 供只交付批注结果的场景，此时 HANDOFF.md 与 summary 明确标注"不可重渲染/修订"。原图可能含敏感内容，是否交付由调用方决定；工具不悄悄省略也不悄悄附带。blur 不是安全遮挡的提示继续由 summary 携带。

## 创建与并发

创建过程先写入同目录下的临时目录 `<target>.tmp-<随机>`，全部完成后以单次 `rename` 发布；目标目录存在且未加 `--overwrite` 时报 `HANDOFF_TARGET_EXISTS`。POSIX `rename` 的原子性使并发创建只有一方获胜，另一方收到相同错误；任何中途失败都会删除临时目录，目标路径不会出现半成品。被强杀遗留的临时目录是惰性残留，不影响目标路径与校验。创建不提供跨目录事务，也不替代修订锁。

## 校验

`verify-handoff <dir>` 输出普通 JSON：`valid`、逐文件问题（`HANDOFF_FILE_MISSING`、`HANDOFF_HASH_MISMATCH`、`HANDOFF_MANIFEST_INVALID`）与 sidecar 完整校验结果。路径安全沿用既有 allowedRoots 规则；篡改任何清单内文件都会以 hash 不匹配暴露，不声称抗恶意构造（hash 未签名，只防损坏与意外篡改）。

## 验收

测试覆盖：创建布局与确定性（除 manifest 时间戳）、`--no-original`、保留名冲突、目标已存在、中文路径、verify 的篡改/缺文件/坏 manifest、包内 revise 后 verify 仍通过、并发创建仅一方成功、失败不产出半成品。发布前完成干净安装与真实客户端交接：一个客户端创建，另一个客户端校验、修订并查看结果。
