# ADR-0006：本地可编辑纯色遮挡使用浏览器画布与 Sharp 导出

- 状态：已接受；Windows 本地编辑闭环已验证
- 日期：2026-08-31

## 背景

`redact` 已能以不透明纯色替换输出像素，且 AnnotationSpec 可重放，但用户需要直接拖拽、缩放和换色。直接在已导出的 PNG 上修改色块会使几何状态与实际像素脱节；若把原图隐藏在可编辑文档中，又会破坏安全导出的边界。

## 决定

新增 `agent-callout edit <input>`：命令启动一个仅绑定 `127.0.0.1`、使用随机会话令牌的本地网页。浏览器使用 Konva 的矩形和 Transformer 提供移动与八方向缩放；项目 JSON 只接受已有 AnnotationSpec 中的 `redact` 类型和不透明颜色。

编辑器保存独立的 `*.agentcallout.project.json`，不修改已生成 PNG 的 manifest。每次导出都由现有 Sharp renderer 以原图和当前 spec 重渲染新的 PNG；不在旧输出上叠加或移动色块。网页预览在返回前应用 EXIF orientation 并转为 PNG，使可见坐标与 renderer 的坐标一致。

## 后果

- 保留当前 `redact` 的像素级安全属性、原图不覆盖和输出 sidecar 审计记录。
- 增加 Konva 10.3.2 浏览器 bundle 与 MIT notice；不会为 Node 加入 canvas/native 图形依赖。
- 编辑器项目路径必须是常规 `.json` 文件，且不得与原图同路径、symlink 或 hard-link 别名。
- 这是本地人工编辑入口，不改变 MCP 的工具集；Agent 仍可通过 AnnotationSpec 完成无界面批注。

## 验证

- 自动化测试覆盖不透明 schema、localhost API、项目保存和导出区域的 RGBA 像素检查。
- 在 Windows 上实际打开编辑页，确认选择、移动、Transformer 手柄和安全导出；浏览器 console 无错误。
