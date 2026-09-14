# npm 分发（v0.7.0 起，npm-ready）

自 v0.7.0 起包已具备 registry 发布条件：`private` 已移除、`prepublishOnly` 挂完整 verify gate、`publishConfig` 锁定官方 registry、`files` 清单只含 dist/字体/运行时资产/许可文件。

## 发布状态

**已具备、待执行**：真实 `npm publish` 需要 npm 账号登录（`npm login` + `npm whoami`），当前发布机未配置凭据，见 [BLOCKERS](../BLOCKERS.md)。执行命令：

```bash
npm whoami                # 确认登录
npm publish               # prepublishOnly 自动跑完整 verify
```

发布后：compatibility.md 增记 npm 安装形态证据（干净机器 `npm install -g agent-callout` → doctor）。

## 安装双路径（发布后生效）

```bash
# registry 路径（v0.7.0 起推荐）
npm install -g agent-callout
# GitHub 路径（保持可用）
npm install -g --install-links=true git+https://github.com/xxf66666/AgentCallout.git
```

Codex/Claude 的 MCP 注册命令与两条路径无关（都是 `agent-callout mcp`）。从 Git 安装迁移到 npm 安装的步骤见 [runbooks](runbooks.md)。

## 约束

- 不做 CI 自动 publish（发布始终人工触发）；
- 无 postinstall 网络下载、无遥测；
- 首次发布必须人工核对 `npm pack --dry-run` 清单（dist/字体/OCR 与 DOM 运行时资产/许可文件，无源码与测试泄漏）。
