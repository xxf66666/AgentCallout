# ADR-0004：MCP 结果兼容与 Codex 0.151 图片优先级规避

- 状态：已接受；真实客户端闭环待验证
- 日期：2026-08-30
- 关联：[决策索引](../decisions.md)、[MCP 调研](../research.md#2-mcp-协议结论)、[Codex 调研](../research.md#9-codex-专项调研)

## 背景

MCP 2026-07-28 允许一个 Tool 结果同时包含 `structuredContent`、TextContent 和 ImageContent；协议还建议为旧客户端重复提供文本序列化结果。但是“协议允许”不代表宿主转换路径等价。Codex 0.151 的当前结果转换在 `structuredContent` 非空时优先采用结构化 payload，可能使同一结果中的图片不进入模型上下文，破坏“生成后查看并修正”的核心闭环。

## 考虑过的方案

| 方案                                     | 优点                                 | 不采用的原因                                              |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| 所有客户端始终返回三种通道               | 最贴近协议理想形态                   | Codex 0.151 可能只把结构化 payload 交给模型，图片闭环失效 |
| 所有工具只返回文本路径                   | 最兼容、负载小                       | Agent 无法直接看图；远程宿主也不一定能访问本地路径        |
| 为每个宿主维护独立 MCP Server/tool 名    | 可完全定制                           | API 漂移、Skill 分叉和测试面不必要扩大                    |
| 全部图片只返回 ImageContent              | 简单直接                             | 丢失 hash、warning、sidecar、Markdown 和纯文本降级        |
| **同一 manifest + 图片工具统一安全降级** | 不依赖不稳定的客户端识别即可保住图片 | 图片工具没有协议层 structuredContent；采用                |

## 决定

1. core 只生成一个 result manifest；CLI、MCP 文本和 `structuredContent` 都由它派生，禁止分别拼装产生事实漂移。
2. `inspect_image`、`validate_annotation_spec` 等纯结构化工具声明对象型 `outputSchema`，成功时返回符合 Schema 的 `structuredContent`，并附同内容的紧凑 JSON TextContent。
3. `annotate_image`、`crop_image`、`create_contact_sheet` 等图片工具不声明协议层 `outputSchema`，并统一省略 `structuredContent`；返回同一 manifest 的 JSON TextContent、受大小限制的 ImageContent、sidecar 绝对路径、输出绝对路径和 Markdown 引用。
4. MVP 不依赖客户端名称/版本识别来选择返回形态。Codex 升级后必须重测；只有确认主流宿主都能同时保留结构化结果和图片时，才考虑恢复图片工具的 `structuredContent`。
5. 大图的 ImageContent 使用受控 PNG 预览；完整 PNG 永远落盘并通过文本 manifest 指向。base64 体积限制、预览尺寸和完整文件 hash 必须显式记录，不能静默截断。
6. 错误使用 `isError` 和可修正的 TextContent；绝不把错误包装成结构化“成功”。stdout 只输出 MCP JSON-RPC，日志和 bootstrap 信息只写 stderr。
7. MVP 不返回未经受限 `resources/read` 支持的 ResourceLink。绝对路径是同机宿主的实用降级，不宣称为远程可移植语义。

## 后果

所有图片客户端优先获得图片闭环，同时仍能从 JSON 文本读取 hash、warning、路径和 Markdown；纯结构化工具保留正式 `structuredContent`。core 无客户端分支，差异仅存在于 MCP 结果编码层。

代价是图片工具失去协议层 output schema 强制，必须在服务器内部和测试中校验 manifest；消费端需要解析 JSON TextContent。客户端行为变化后仍须维护 compatibility matrix。

## 验证状态

- 已有证据：协议允许混合内容块并建议文本兼容；本机 Codex 版本为 0.151.0；stdio/SDK 测试确认图片工具返回 JSON TextContent + 可解码、受限 ImageContent，且省略 structuredContent。
- 尚未完成：必须用真实 Codex/Claude Tool 调用证明 ImageContent 进入模型上下文、模型能检查图片并修改 spec 重渲染。完成前不得声称图片结果在所有宿主等价。

## 证据

- [MCP Tools 规范：output schema、structured content 与内容块](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP Lifecycle：initialize 与客户端信息](https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle)
- [MCP stdio 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP Resources 规范](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- [调研中的协议兼容结论](../research.md#24-兼容性风险)
- [调研中的 Codex 0.151 客户端差异](../research.md#9-codex-专项调研)
