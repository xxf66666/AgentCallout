# AgentCallout 进度

最后更新：2026-08-31（Asia/Singapore）

## 当前状态

- 阶段：MVP 已完成；0.1.3 迭代候选正在发布验收
- GitHub：`https://github.com/xxf66666/AgentCallout`（公开仓库，`main` 已推送）
- 本地分支：`main`
- 阻塞：无；0.1.3 尚未提交、推送和完成真实 Claude/Codex revision 回归

## 已完成

- [x] 读取并接受项目目标与完成定义
- [x] 检查本地 Git 仓库、CodeGraph 索引和工作区状态
- [x] 确认远程仓库为空且未设置默认分支
- [x] 将本地仓库连接到正式 GitHub 远程
- [x] 确认本机安装 Node.js、npm、pnpm、Git、GitHub CLI、Claude Code 和 Codex CLI
- [x] 启动 Claude Code、Codex、MCP 与竞品的并行证据调研
- [x] 完成 `docs/research.md`、五份 ADR、兼容性、安全和路线图基线
- [x] 完成 Windows Sharp 技术实验：中文/英文换行、箭头、highlight、blur、opaque redact、PNG/JPEG/WebP 和重解码
- [x] 记录首个 Git 里程碑 `c71eed4`
- [x] 用官方 scaffold 建立 Codex Plugin、Skill 和 repo marketplace，并通过初始结构校验
- [x] 完成 AnnotationSpec v1、十类批注、自动排版和 Sharp 渲染/安全核心
- [x] 完成 CLI、六工具 stdio MCP、128 KiB 受限预览和 doctor/self-test
- [x] 捆绑 Noto Sans CJK SC 字体、OFL、hash 和幂等 Plugin runtime bootstrap
- [x] 完成 Claude Code Plugin；完成 Codex 直接 MCP 主路径和可选 Skills-only Plugin
- [x] 生成并人工查看 `ui-bug`、`numbered-review`、`privacy` 三组示例
- [x] 当前工作树完整 gate：format、lint、typecheck、52 tests、build、dist 复现通过
- [x] 构建产物 CLI doctor、自检、stdio MCP 和 plugin bootstrap smoke 通过
- [x] 记录实现里程碑 `541bafe`、`7bccda0`、`895237c`、`1151936`、`46ce988`
- [x] GitHub `main` 推送并完成 Claude 两命令 Plugin 安装、更新、卸载和重装
- [x] 完成 Codex 两命令 GitHub CLI + MCP 安装、更新、卸载和重装
- [x] Claude/Codex 均完成 doctor、inspect 和两次 annotate；两个模型均确认两张预览可见
- [x] Codex 可选 Skills-only Plugin 0.1.2 安装并由 `$agent-callout` 调用 MCP doctor
- [x] GitHub clean clone 完成 `npm ci`、完整 gate、示例重生 clean diff、doctor 与 MCP smoke
- [x] Node 20.10 doctor 与 Node 20.19 完整 gate 通过；生产依赖 audit 为 0 漏洞
- [x] 最终验证文档提交后，GitHub clean clone 在 `833490b` 再次通过完整 gate
- [x] 准备并推送 `v0.1.2` 版本标签
- [x] AnnotationSpec 1.1 增加可读 preset/defaults/tone，普通说明不再默认红底白字；1.0 golden 保持
- [x] numbered-callout 使用目标外 marker 与可见边界引线，示例三条引线均通过 24 px 门禁
- [x] 增加 append-only `.revN` 修订：严格 add/set/remove、父链/hash、移动或 basename-only 原图、CLI/MCP 入口
- [x] 修订事务增加完整 lock 发布、no-replace PNG/sidecar、最终可信读回、强杀残留恢复、15 个故障点与 16 进程竞态
- [x] 增加 255 revision/256 sidecar 与 512 MiB 累计链预算；拒绝生成下一次无法读取的版本
- [x] MCP 默认改为 512 px/64 KiB/low-detail 紧凑总览，并引导用局部 crop 检查小字以降低图片 token
- [x] README/Skill 说明跨 AI 交付必须附 PNG + 普通 JSON sidecar；只读 JSON 不要求安装 AgentCallout
- [x] 0.1.3 当前工作树完整 gate：117 tests、build、三份 dist 复现；三组示例重生且 PNG 基线稳定
- [x] 构建后 CLI base→rev1→rev2→rev3 真实运行，旧 input/base PNG/base JSON hash 与 mtime 不变，无 lock/temp residue
- [x] 根 dist 与 Plugin dist 均完成七工具 stdio smoke；npm pack dry-run 仅包含 9 个预期文件

## 进行中

- [ ] 0.1.3 最终文档一致性、Git 提交与推送
- [ ] 从已推送精确 commit/tag 完成 clean clone、全局 GitHub 安装及 Claude/Codex `revise_annotation` 预览回归

## 待完成

- [ ] 非 Windows 平台回归（不阻塞 Windows-first MVP）
- [ ] 跨目录复制 lineage 的 fork 只记录不自动合并；后续评估显式 branch/merge 模型

## 验证日志

| 时间       | 检查                                 | 结果                                                                                                  |
| ---------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 2026-08-30 | `gh repo view xxf66666/AgentCallout` | 仓库存在、公开、空仓库、管理员权限                                                                    |
| 2026-08-30 | 本机工具链                           | Node `v24.18.1`、npm `11.16.0`、pnpm `11.19.0`、Claude Code `2.1.251`、Codex CLI `0.151.0`            |
| 2026-08-30 | Sharp 技术实验                       | PNG/JPEG/WebP 解码、中文/英文换行、箭头、blur、redact、PNG 重解码通过；redact 区域为单一不透明 RGB 值 |
| 2026-08-30 | Plugin/Skill 初始校验                | `quick_validate.py`、`validate_plugin.py`、`claude plugin validate --strict` 通过；尚未安装或调用     |
| 2026-08-30 | 完整仓库 gate                        | Prettier、ESLint、TypeScript、Vitest `52/52`、build、3 份 dist 逐字节复现全部通过                     |
| 2026-08-30 | CLI/MCP smoke                        | doctor/self-test、opaque redact 像素、stdio initialize、六工具发现和结构化 doctor 通过                |
| 2026-08-30 | Plugin bootstrap                     | 首次固定依赖安装成功，第二次幂等跳过；Plugin MCP doctor 通过                                          |
| 2026-08-30 | 三组示例                             | 重复渲染 hash 一致、无 warning、sidecar 无绝对开发机路径；privacy redact 为单一不透明 RGBA            |
| 2026-08-30 | Claude Code 2.1.251                  | GitHub install/update/uninstall/reinstall；doctor + 两次 annotate；预览可见，输出 hash 已复核         |
| 2026-08-30 | Codex CLI 0.151.0                    | GitHub CLI + mcp add/remove/reinstall；doctor/inspect/validate + 两次 annotate；预览可见              |
| 2026-08-30 | Clean clone                          | `npm ci`、verify、examples clean diff、doctor、MCP smoke；最终验证 commit `833490b`                   |
| 2026-08-30 | Node 20 / audit                      | 20.10 doctor；20.19 52 tests/typecheck/build/dist/self-test；官方 registry production audit 0 漏洞    |
| 2026-08-31 | 0.1.3 完整仓库 gate                  | Prettier、ESLint、TypeScript、Vitest `117/117`、build、3 份 dist 逐字节复现全部通过                   |
| 2026-08-31 | 修订并发/恢复                        | 16 进程竞态连续 3 轮各仅一方提交；强杀、完整 lock、15 个故障点、chain limit 与 cleanup 通过           |
| 2026-08-31 | 紧凑 MCP 预览                        | 1600×900 完整 PNG 落盘，ImageContent 512×288、<=64 KiB、low detail；根/Plugin 七工具 smoke 通过       |
| 2026-08-31 | 构建后 CLI 修订 UAT                  | rev1/2/3、稳定 lineage、旧文件 hash/mtime 不变、6 个完整新文件、无 lock/temp residue                  |
