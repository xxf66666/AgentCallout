# ADR-0005：Codex 使用 GitHub CLI 包 + 直接 MCP 注册

- 状态：已接受；Windows/Codex 0.151 主路径已验证
- 日期：2026-08-30
- 替代范围：[ADR-0003](0003-distribution-plugin-bootstrap.md) 中的 Codex runtime/plugin bootstrap 部分；Claude 决策不变

## 背景

Codex 0.151 能从 Git marketplace 安装 Plugin 和 Skill，但真实客户端验收发现，其本地 Plugin MCP 子进程在当前路径下以项目工作区为 `cwd`，不导出 `PLUGIN_ROOT`，也不展开 `.mcp.json` 参数里的 `${PLUGIN_ROOT}`。把 MCP Server 放在插件缓存内会在初始化前关闭；继续依赖该行为会让每个 Codex 会话等待失败的 MCP 启动。

同时，仓库根 npm 包已包含构建后的 CLI/MCP、字体和 Sharp 依赖，可以不发布到 npm registry，直接从 GitHub 安装。Codex 官方 `mcp add` 能无手写 TOML 地注册 PATH 中的 CLI。

## 考虑过的方案

| 方案                                   | 优点                                                 | 结论                                          |
| -------------------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| 继续假设 Plugin root placeholder 可用  | 两条 Plugin 命令同时带 Skill/MCP                     | 与 Codex 0.151 实测冲突；拒绝                 |
| 提交 Windows `.cmd` 或 native launcher | 可从插件相对路径启动                                 | Windows 专用、扩大签名/多平台矩阵；不作为 MVP |
| 让 Agent 自行查找插件缓存绝对路径      | 无需改包                                             | 路径不稳定、违反直接安装目标；拒绝            |
| **GitHub 全局 CLI + `codex mcp add`**  | 两条命令、跨平台 Node 路径、无需手写 TOML、同一 core | 需要全局 npm prefix；采用                     |

## 决定

Codex 的主要安装命令固定为：

```powershell
npm install --global --install-links=true git+https://github.com/xxf66666/AgentCallout.git
codex mcp add agent-callout -- agent-callout mcp
```

`--install-links=true` 是命令内的兼容覆盖：若用户 npm 配置为 `install-links=false`，npm 11 可能把 Git 包链接到随后清理的临时 clone，导致全局 bin 缺少 `dist`。显式开启后安装的是 `npm pack` 产生的九个发布文件。

Codex Plugin 保留为 **Skills-only** 可选包装，不声明本地 MCP Server；其 Skill 复用已注册的 `agent-callout` MCP。更新 CLI 不需要重写 MCP 配置：重复第一条命令即可。卸载为 `codex mcp remove agent-callout` 后 `npm uninstall --global agent-callout`。

## 后果

主安装仍只有两条命令、仍从 GitHub 工作、仍不需要模型 API Key或手写 TOML。CLI、MCP 和 Claude Plugin 继续共享同一 renderer。代价是 Codex 用户若还需要自动发现的 Skill，须额外安装可选 Plugin；全局 npm prefix 必须可写且 Node/npm 必须存在。

## 验证

在 Windows 11、Node 24.18.1、npm 11.16.0、Codex CLI 0.151.0 上：

- 首次未覆盖 `install-links=false` 的安装暴露了临时 junction 缺陷；`npm pack --dry-run` 证明包内容正确。
- 加 `--install-links=true` 后 `agent-callout --version` 为 0.1.1，doctor/self-test 通过。
- `codex mcp add` 后，真实 Codex Agent 调用 `doctor` 成功。
- 同一 Agent 流程完成 inspect/validate，并两次调用 `annotate_image`；两个输出 hash 不同，两个 PNG ImageContent 预览均被模型确认可见。
- CLI/MCP remove、npm uninstall 与最终版本重装仍须在发布收尾记录。

## 证据

- [Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex Plugin 文档](https://developers.openai.com/plugins/build/plugins)
- [兼容性与验收日志](../compatibility.md)
