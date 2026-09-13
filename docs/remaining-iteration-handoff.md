# AgentCallout 剩余迭代接力清单

更新日期：2026-09-13（第二轮接力完成后）

## 当前状态

- 已发布：`v0.2.1` → `v0.3.0`（OCR）→ `v0.3.1`（交接包）→ `v0.4.0`（DOM 定位）；远端 `main` 为 `8c65654`。
- CI：GitHub Actions 三平台 × Node 20/22/24 矩阵已交付且 9/9 通过（`1beb408`）；失败日志自动推送 `ci-logs-<os>-<node>` 分支（匿名可读）。
- 本轮由单一 Agent 顺序完成 v0.3.0 收口、v0.3.1、v0.4.0 与 CI 矩阵；每个版本均经完整 gate、干净 clone/安装、真实双客户端验收并打双标签（`vX.Y.Z` + `agent-callout--vX.Y.Z`）。
- 后续不使用 BMAD。

## 证据与文档入口

- 发布记录：`docs/releases/0.3.0.md`、`0.3.1.md`、`0.4.0.md`；兼容性证据：`docs/compatibility.md`（各版 VERIFIED/NOT VERIFIED 分列）。
- ADR-0009（OCR）、ADR-0010（交接包）、ADR-0011（DOM 定位）；进度：`PROGRESS.md`。
- 本机注意：远端用 SSH 推送（HTTPS 无凭据）；`gh` CLI 未登录，CI 结果经匿名 GitHub API（`/actions/runs`）验证。

## 待完成（从固定 commit `8c65654` 建独立 `codex/` 分支并行认领）

1. **working copy / fork / revision diff**：目录副本 fork 的显式记录与两个 revN 之间的差异对比（ADR-0006 已立场：只记录不自动合并）；自动 merge 先评估再决定。
2. **Codex Skills-only Marketplace 30 秒 clone 超时**：外部客户端阻塞，历史记录明确不阻塞 CLI+MCP 主路径；仅在有新线索时处理。
3. **系统截图入口与轻量 GUI 评估**：评估性任务，复用现有 core/Spec/sidecar，最后进行。
4. **DOM 深化（可选）**：Firefox/WebKit 引擎、公网深度场景、DPR≠1 的显式用例（当前固定 DPR=1 规避）。

## 纪律（沿用）

每个版本只有在完整测试、干净安装、真实客户端验收、正常提交和推送后，才能标记完成。禁止 force push、覆盖现有改动或把工具可见当成端到端通过。测试夹具须隔离环境状态（勿依赖用户级缓存，参见 MCP DOM 夹具的教训）。
