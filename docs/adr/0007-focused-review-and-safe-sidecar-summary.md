# ADR-0007：修订返回单张变更区域预览，sidecar 检查只公开过滤摘要

- 状态：已接受；自动化通过，真实客户端 A/B 待发布验收
- 日期：2026-08-31

## 背景

0.1.3 把整图预览限制到 512 px/64 KiB/low detail，已能让 Claude Code 和 Codex 发现遮挡；但 Claude 为确认同一按钮区域又调用一次 `crop_image`。同时，另一个 AI 虽可直接读取普通 JSON sidecar，却缺少一个能先验证 sidecar、配对输出和完整父链、又不会默认泄漏路径、文字和稳定标识的入口。

图片 token 由宿主和模型决定，不能仅从 base64 字节推断。产品能控制的是：减少不必要的图片轮次、限制像素范围、每次最多返回一张图，并明确何时没有完成全局视觉复核。

## 决定

### 修订聚焦预览

`revise_annotation` 输入保持不变。Core 用同一原图和当前 renderer 重渲染父 spec，并先确认重渲染 hash 与已验证父输出一致；随后把父/子输出的实际 RGBA 像素差异与 resolved geometry 一起计算复核区域：

- `add` 使用子版本几何；`remove` 使用父版本几何；`set` 使用父子并集；
- 未直接 touched、但因自动排版发生几何迁移的批注也计入 affected；
- 实际像素差异兜住宽描边、箭头头部和 alpha-only 变化，避免只看逻辑框时裁掉已改变像素；
- 每个 affected 几何外扩至少 24 px 并 clamp，再与像素差异范围合并；一个连通簇且最终面积不超过画布 50% 才返回 `changed-region`；
- 分散、过大、无可靠几何、spotlight 等全局效果或父输出无法由当前 renderer 像素等价重放时返回 `compact-overview`；
- 父版本 blur/redact 覆盖被删除或任一字段修改时返回 `none`，不发送 ImageContent；只要直接父版本或修订后 spec 含 blur/redact，也不自动放大局部，而是保留低细节 compact-overview；
- MCP 只裁剪 hash/尺寸已验证的当前新输出，不裁剪原图或祖先输出；每次最多一个 ImageContent，最长边 512 px、PNG 不超过 64 KiB。

review-scope 元数据只公开 touched/affected 数量、mode、sourceRect 和固定 fallback reason，不回显 annotation ID；MCP `preview` 另含 detail、宽高和编码字节数。focus 编码失败不回滚已提交 revision，也不偷偷降级发送整图；返回成功结果和 `preview.available=false`。

### Sidecar 安全摘要

新增只读 Core/CLI/MCP：

- `inspectAnnotationSidecar({ sidecarPath, ...limits })`；
- `agent-callout inspect-sidecar <sidecar>`；
- `inspect_annotation_sidecar({ sidecarPath })`。

它复用 revision 的严格 FileHandle 读取、manifest/spec/security、配对 output、parent 连续性、256 entries/512 MiB 门禁，并核对 resolved inventory 与 spec 的 ID/type/order一一对应。检查不打开原图，不扫描磁盘，不修改任何文件，因此明确报告 `originalInput: record-only`。任一验证失败统一映射为 `ANNOTATION_SIDECAR_INVALID` 和固定消息，不返回部分摘要或底层 cause。

公开摘要固定不超过 4 KiB，只含版本、输出尺寸、按 type 计数、resolved inventory 身份对齐状态、revision number/chain entries、warning 数量、完整性状态、blur/redact 布尔值、目录级协调边界和压平 PNG 的可移植性事实。默认排除所有路径/文件名/Markdown、hash/lineage/parent/edits、annotation ID/文字/style/raw warning/resolved geometry、renderer/font 指纹，也不返回 ImageContent。

普通 sidecar 仍是开放 JSON；别的 AI 不安装 AgentCallout 也能读取完整语义。安装工具提供的是校验、重渲染和修订能力，不是专有解码许可。

## 版本后果

这是 additive API 与预览编码变化，包/Plugin/Skill 升为 0.2.0。批注渲染像素算法和 AnnotationSpec 未变，因此 renderer 保持 0.1.3；既有示例 PNG/sidecar hash 不应变化。发布同步脚本分别校验产品版本与 renderer 语义版本，不能再强迫二者同步递增。

## 边界

- changed-region 只证明局部变更可见，不能替代完整画布复核；返回 sourceRect 是为避免误读。
- compact-overview/changed-region 都会把最终输出交给宿主模型；高度敏感图片仍受宿主隐私政策约束。
- 目录 lock 不是跨目录全局 head；摘要必须继续声明复制后可能 fork。
- 真实 Claude/Codex A/B 只能证明所测版本中判断与图片轮次变化，不能把总 usage 的变化全部归因为图片 token。
