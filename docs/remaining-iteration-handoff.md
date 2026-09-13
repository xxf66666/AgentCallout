# AgentCallout 剩余迭代接力清单

更新日期：2026-09-13

## 当前状态

- 已发布：`v0.2.1`，远端 `main` 为 `a311066`。
- 开发中：`v0.3.0` OCR，当前分支 `codex/ocr-locator`，本地 HEAD `550e2e9`。
- OCR 工作树还有未提交改动，不能重置、覆盖或从 `main` 重新开发。
- 后续不使用 BMAD。

## 1. v0.3.0：完成 OCR 并发布

- 收口现有中英文 OCR、精确/包含匹配、多候选、置信度、ROI 和离线运行时。
- 多候选或低置信度必须让 AI 确认，不能自动猜坐标。
- 精简 README，补齐 OCR、兼容性、安全和发布文档。
- 重跑完整测试、构建、打包、干净安装。
- Claude Code 和 Codex 都完成真实的“识别文字 → 批注 → 查看结果”。
- 提交并推送分支，合并 `main`，发布 `v0.3.0`。

## 2. v0.3.1：跨 AI 一键交接包

- 增加 `create-handoff`。
- 输出批注 PNG、完整 JSON、manifest、安全摘要和 Markdown 入口。
- 接收方不安装 AgentCallout 也能读取；安装后可以验证、重渲染和修订。
- 使用普通目录和 JSON，不发明专有压缩或解码格式。
- 测试篡改、缺文件、重名、中文路径、并发和失败恢复。

## 3. v0.4.0：浏览器 DOM 定位

- 根据 selector、文本或可访问性名称定位网页元素。
- 正确处理 DPR、缩放、滚动、固定元素和 iframe。
- 定位结果必须绑定截图 hash 和页面状态，页面变化后旧坐标失效。
- DOM 只负责输出 bbox，继续复用现有批注渲染器。
- Claude Code 和 Codex 各完成一次真实网页定位批注。

## 4. v0.4.x：协作与平台完善

- 增加 working copy、fork 和 revision diff；自动 merge 先评估再决定。
- CI 覆盖 Windows、macOS、Linux 和 Node 20/22/24。
- 继续处理 Codex Marketplace 30 秒 clone 超时。
- 最后评估系统截图入口和轻量 GUI。

## 执行顺序

先由一个 Agent 独占当前工作树完成并推送 `v0.3.0`。之后其他 Agent 从固定 commit 建独立 `codex/` 分支，再并行处理 `v0.3.1`、`v0.4.0` 和 `v0.4.x`。

每个版本只有在完整测试、干净安装、真实客户端验收、正常提交和推送后，才能标记完成。禁止 force push、覆盖现有改动或把工具可见当成端到端通过。
