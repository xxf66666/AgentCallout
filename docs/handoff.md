# 跨 AI 一键交接包（create-handoff）

交接包把"批注 PNG + 完整批注 JSON + manifest + 安全摘要 + Markdown 入口"打包成一个**普通目录**，让接收方 AI 不安装 AgentCallout 也能准确区分原图内容与后加批注；安装 AgentCallout 后还可以校验、重渲染和继续修订。设计决策见 [ADR-0010](adr/0010-cross-ai-handoff-package.md)。

## 创建与校验

```powershell
agent-callout create-handoff .\screenshot.annotated.json --json
agent-callout verify-handoff .\screenshot.annotated.handoff --json
```

默认在 sidecar 旁创建 `screenshot.annotated.handoff/`；`--output-dir <path>` 可指定目标目录。包内文件：

| 文件               | 角色                                     |
| ------------------ | ---------------------------------------- |
| `HANDOFF.md`       | Markdown 入口：读取顺序、命令、隐私提示  |
| `manifest.json`    | 创建时快照：文件角色、SHA-256、字节数    |
| `summary.json`     | 安全摘要（不含路径、hash、ID、批注文字） |
| `*.annotated.png`  | 批注结果（保留原文件名，已压平）         |
| `*.annotated.json` | 完整机器可读批注记录（保留原文件名）     |
| 原图               | 默认一并拷贝；`--no-original` 可省略     |

**保留原文件名是刻意的**：sidecar 内部使用相对路径引用输出与原图，修订链要求 `<stem>.revN.json` 命名一致；不改名意味着包内可以直接继续 `revise`。handoff 自身只新增 `manifest.json`、`summary.json`、`HANDOFF.md` 三个保留名，用户文件与之重名时报 `HANDOFF_NAME_CONFLICT`。

## 原图与可修订性

修订和重渲染需要原图，因此默认拷贝；`--no-original` 交付的包会在 `HANDOFF.md` 与 `manifest.json`（`originalIncluded: false`）中明确标注**不可重渲染/修订**。原图可能含敏感内容，是否随包交付由调用方决定。

## 语义与边界

- `manifest.json` 只描述创建时快照。包内继续修订会新增 `.revN` 文件，不回写 manifest；`verify-handoff` 校验清单内文件的 hash，并另行完整校验打包的 sidecar 与输出 hash，新增的修订文件由 sidecar 链描述。
- 校验能发现意外损坏与篡改（hash 不匹配、缺文件、坏 manifest），但 hash 未签名，不承诺对抗恶意构造。
- 创建先写同目录临时目录再原子 `rename` 发布：并发创建只有一方成功（另一方 `HANDOFF_TARGET_EXISTS`），中途失败不留半成品；被强杀遗留的临时目录是惰性残留。
- 目标目录已存在时需要显式 `--overwrite`。

## MCP

安装方也可以用 `create_handoff`（参数 `sidecarPath`、可选 `outputDirectory`、`includeOriginal`、`overwrite`）与只读工具 `verify_handoff` 完成同一流程；参数与 CLI 一致，路径同样受 allowedRoots 约束。

## 验收状态（v0.3.1）

自动化覆盖：包布局与 sidecar 字节一致、`--no-original`、保留名冲突、目标已存在与 `--overwrite`、缺原图失败不留半成品、中文路径、verify 的篡改/缺文件/坏 manifest、包内 `revise` 后 verify 仍通过、并发创建仅一方成功、CLI 双命令。发布验收（一个客户端创建、另一个客户端校验并修订）见 [发布记录](releases/0.3.1.md)。
