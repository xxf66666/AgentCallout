# 评估：系统截图入口与轻量 GUI（2026-09-13）

结论先行：**两者均推迟实现**，当前以 CLI/MCP 为主入口的形态继续；本文记录评估依据，供后续复核。

## 系统截图入口

- 需求：让 Agent 从"批注已有截图"扩展到"先截屏再批注"，省去用户手动截屏。
- 平台现状：macOS 有 `screencapture`（系统自带）；Windows 有 Win32 PrintWindow/`snipping` URI，但多显示器与 DPR 缩放组合下坐标与清晰度问题多；Linux 依赖桌面环境（X11/Wayland 分裂，Wayland 需 xdg-desktop-portal 授权）。
- 评估结论：入口可行性高，但跨平台一致性成本高（三套适配器 + Wayland 授权流 + DPR 语义），且与"不负责系统截图"的产品边界直接冲突（README 已声明）。**推迟**；若未来实现，按 ADR-0011 的适配器模式作为可选能力，不进默认安装。
- 过渡方案（已可用）：用户手动截屏或用 Agent 自带的系统截图工具（如 Claude Code 的截图能力）产出 PNG，再走现有 inspect → annotate 流程。

## 轻量 GUI

- 需求：非 Agent 用户查看/微调批注结果。
- 现状：批注结果已经有零依赖查看路径（PNG + 普通 JSON sidecar + HANDOFF.md 入口）；修订走 CLI/MCP 的 append-only 模型，天然避免并发编辑冲突。GUI 会引入：图形工具包选型（Web/本地）、sidecar 写回的并发与事务语义、以及与 revision 模型的编辑冲突设计——每一项都是新面。
- 评估结论：**推迟**。当前"PNG + JSON + diff/revise 命令"已覆盖查看与修改需求；GUI 只有在出现明确的非 Agent 用户群反馈后再立项，且应优先做成只读查看器（写路径仍走 CLI/MCP）。

## 复核条件

- 出现多个非 Agent 用户要求可视化编辑；
- 或系统截图能力被多个上游 Agent 明确要求且愿意接受平台适配成本。
