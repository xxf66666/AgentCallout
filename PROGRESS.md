# AgentCallout 进度

最后更新：2026-09-13（Asia/Singapore）

## 当前状态

- 阶段：MVP、0.1.3、0.2.0 与 0.2.1 已发布；下一阶段为可选本地 OCR
- GitHub：`https://github.com/xxf66666/AgentCallout`（公开仓库，`main` 已推送）
- 发布分支：`main`；0.2.1 核心 `9384df7`，显示兼容修复 `a3812a5`
- 当前发布门槛：0.2.1 完整 gate、干净安装和双客户端 A/B 已通过，见 [发布记录](docs/releases/0.2.1.md)
- 已知外部限制：Codex 可选 Skills-only Marketplace 曾受客户端固定 30 秒 clone 超时影响；CLI+MCP 主路径已验证

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
- [x] MCP 默认改为 512 px/64 KiB/low-detail 紧凑总览，并引导用局部 crop 检查小字，限制传输像素和重复图片轮次
- [x] README/Skill 说明跨 AI 交付必须附 PNG + 普通 JSON sidecar；只读 JSON 不要求安装 AgentCallout
- [x] 0.1.3 当前工作树完整 gate：117 tests、build、三份 dist 复现；三组示例重生且 PNG 基线稳定
- [x] 构建后 CLI base→rev1→rev2→rev3 真实运行，旧 input/base PNG/base JSON hash 与 mtime 不变，无 lock/temp residue
- [x] 根 dist 与 Plugin dist 均完成七工具 stdio smoke；npm pack dry-run 仅包含 9 个预期文件
- [x] 推送 `427c860`、`9e9ea0f`、`c75ce96` 三个迭代里程碑到 GitHub `main`
- [x] GitHub `c75ce96` clean clone 完成 `npm ci`、117 tests/全 gate、示例 clean diff、doctor/self-test 与 MCP smoke
- [x] 停止 12 个旧 MCP 子进程后，从 GitHub 精确 commit 全局安装 0.1.3；doctor、revise help 与七工具通过
- [x] Claude Plugin 0.1.2→0.1.3 更新成功；真实 rev1 视觉否决、局部 crop、rev2 修正并确认中文/无遮挡
- [x] Codex 全局 MCP 0.1.3 完成 rev1 视觉否决、rev2 修正并确认中文/无遮挡
- [x] Node 20.10 构建后 CLI 完成 annotate→revise；Node 20.19 revision/MCP 28 tests 通过
- [x] 创建并推送 `v0.1.3` annotated tag（release commit `7016356`）
- [x] revision 自动聚合 touched 与连带重排几何；单一簇返回 changed-region，分散/过大/全局效果回退 compact-overview
- [x] 父版本 blur/redact 覆盖被删除或任一字段变化时 `review.mode=none`，MCP 不返回 ImageContent
- [x] 增加 `inspectAnnotationSidecar`、CLI `inspect-sidecar` 与 MCP `inspect_annotation_sidecar`；摘要 ≤4 KiB 且默认排除路径/hash/ID/文字/style
- [x] 0.2 当前工作树 135 tests、全 gate、三份 dist 复现；renderer 保持 0.1.3，三组示例 PNG/sidecar hash 均未变化
- [x] 构建后 CLI 0.2 UAT：focus sourceRect `540,446,384,162`；sidecar 摘要 1,012 bytes，零目录/annotation ID
- [x] Claude bootstrap 增加 pinned Sharp/native PNG probe 与跨进程安装锁；干净副本首次、幂等、双进程并发及损坏 marker 真实修复通过
- [x] GitHub `a09735e` clean clone 完成 npm ci、135 tests/全 gate、examples clean、doctor/self-test、root/Plugin 8 工具 smoke 与 production audit
- [x] 从精确 commit 全局安装 0.2.0；Codex 桌面自动重启 MCP 导致的 EBUSY 已用官方 remove→install→add 流程闭环
- [x] 真实 Codex 首轮发现 `op:"replace"` 歧义；工具契约改为自描述 `op:"set"` 并由 doctor 直接报告 product 0.2.0（`12edc01`）
- [x] Claude/Codex 0.2.0 均以两张 384×162 changed-region 完成“发现遮挡→left 修正”，预览 5,512/6,600 B，crop 均为 0；最终 sidecar 安全摘要通过
- [x] 最终证据 commit `c28974f` 再经 GitHub clean clone、135 tests/全 gate、examples clean、doctor/self-test 与八工具 smoke；发布 `v0.2.0` 和 `agent-callout--v0.2.0` annotated tags

## 0.2.1 已完成

- [x] 1.1 密集布局核心：提前保护全部目标、多候选避让、折线引线及结构化布局问题；1.0 保留旧渲染路径
- [x] 实现预览 `pixelMetrics`，仅报告像素数量/比例；图片发送前重新校验最终字节，失败不返回图片或指标
- [x] 建立普通/编号/混合 1、3、6、10 项测试，增加长文字、固定文字障碍、边角小目标及折线路径像素检查
- [x] 修复编号引线、marker 边界与超大箭头头部碰撞回归；补强箭头头部离开引线的真实像素断言
- [x] 完整 format/lint/typecheck、179 tests、build、3 份 dist 复现；三组示例确定性/视觉检查通过
- [x] 精简 README，同步路由/warning/像素指标文档与 Skill；Plugin/Skill/Claude manifest 校验通过
- [x] 构建后 doctor/self-test、root/Plugin 八工具 smoke、npm pack 9 文件与生产 audit 0 漏洞
- [x] 准备 1280×800 / 10 项混合真实控件 A/B 素材；旧版 baseline 与新版候选均已通过 CLI 生成并查看，新版无布局 warning
- [x] 干净 clone、GitHub 安装、doctor、CLI/MCP/Plugin 验证；Claude 官方更新后 cache dist 与本地一致，保留用户禁用设置
- [x] Claude/Codex 真实 10 项密集批注与修订视觉 A/B；两边同一初图/统一修订像素一致
- [x] Codex 0.153.4 实测发现旧 `low` hint 不支持，改 `auto` 后两客户端直接展示成功；已更新 Claude 安装缓存也完成真实 annotate→revise
- [x] 合并 main、提交并推送 0.2.1；发布标签 `v0.2.1` 和 `agent-callout--v0.2.1`

## 0.3.0 已完成（2026-09-13）

- 分支 `codex/ocr-locator`：功能 `d338dc8`（Windows 222/222 全 gate 与中英文真实识别）+ 跨平台测试修复 `17cb5c7`。
- [x] 固定 Tesseract.js 本地中英文原型，记录全文失败、局部反白文字识别和离线行为
- [x] 原图 hash/EXIF/ROI/缩放/透明背景准备与映射，7 项定向测试通过
- [x] exact/contains、CJK 空白、重复候选、低置信度、原始证据与资源预算，15 项匹配测试通过
- [x] `locateText`、CLI `ocr install/status` 与 `locate-text`、MCP `locate_text` 已接入；上层/CLI/MCP 定向 33 项通过
- [x] 完成可选运行时边界修复；Windows 固定中英文运行时 status 与双语言真实识别通过
- [x] macOS 24.21 完整 gate：220 passed + 2 skipped（222）、format/lint/typecheck/build、3 份 dist 逐字节复现（本地与 GitHub 干净 clone）
- [x] 跨平台测试修复：tmpdir realpath 规范化、删除仅 Windows 成立的路徤断言、文字度量金标准按 verifiedWindowsRenderer 先例平台化
- [x] macOS OCR 运行时安装与真实定位：中文 unique/93、英文 ROI+反色 unique/95、反白按钮低置信度 38–48（坐标与源图一致，`requiresConfirmation` 生效）
- [x] 打包与干净安装：pack 14 文件、生产 audit 0 漏洞、精确 commit 全局安装 0.3.0、doctor/self-test 通过
- [x] Claude Code 真实“定位 → 确认 → 批注 → 查看”；Codex CLI 0.154.0 `codex exec` 真实闭环，另验证 not-found 不猜坐标与 ENOENT 结构化错误
- [ ] 合并 main、推送并发布 `v0.3.0` 与 `agent-callout--v0.3.0` 标签；Claude Plugin marketplace 0.3.0 更新验收

## 待完成

- [ ] 0.3.1：`create-handoff` 一键 PNG/sidecar/安全摘要/Markdown 交接包
- [ ] 0.4.0：DOM selector/文本/可访问性名称定位，处理 DPR/缩放/滚动/iframe 与截图关联证据
- [ ] 0.4.x：显式 working copy/fork/revision diff、分支合并评估及系统截图/轻量 GUI 评估
- [ ] 非 Windows 平台回归（不阻塞 Windows-first MVP）
- [ ] 跨目录复制 lineage 的 fork 只记录不自动合并；后续评估显式 branch/merge 模型
- [ ] 解决或规避 Codex Git Marketplace 内部 30 秒 clone 超时（不阻塞 CLI+MCP 主路径）

## 验证日志

| 时间       | 检查                                 | 结果                                                                                                                                                               |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-30 | `gh repo view xxf66666/AgentCallout` | 仓库存在、公开、空仓库、管理员权限                                                                                                                                 |
| 2026-08-30 | 本机工具链                           | Node `v24.18.1`、npm `11.16.0`、pnpm `11.19.0`、Claude Code `2.1.251`、Codex CLI `0.151.0`                                                                         |
| 2026-08-30 | Sharp 技术实验                       | PNG/JPEG/WebP 解码、中文/英文换行、箭头、blur、redact、PNG 重解码通过；redact 区域为单一不透明 RGB 值                                                              |
| 2026-08-30 | Plugin/Skill 初始校验                | `quick_validate.py`、`validate_plugin.py`、`claude plugin validate --strict` 通过；尚未安装或调用                                                                  |
| 2026-08-30 | 完整仓库 gate                        | Prettier、ESLint、TypeScript、Vitest `52/52`、build、3 份 dist 逐字节复现全部通过                                                                                  |
| 2026-08-30 | CLI/MCP smoke                        | doctor/self-test、opaque redact 像素、stdio initialize、六工具发现和结构化 doctor 通过                                                                             |
| 2026-08-30 | Plugin bootstrap                     | 首次固定依赖安装成功，第二次幂等跳过；Plugin MCP doctor 通过                                                                                                       |
| 2026-08-30 | 三组示例                             | 重复渲染 hash 一致、无 warning、sidecar 无绝对开发机路径；privacy redact 为单一不透明 RGBA                                                                         |
| 2026-08-30 | Claude Code 2.1.251                  | GitHub install/update/uninstall/reinstall；doctor + 两次 annotate；预览可见，输出 hash 已复核                                                                      |
| 2026-08-30 | Codex CLI 0.151.0                    | GitHub CLI + mcp add/remove/reinstall；doctor/inspect/validate + 两次 annotate；预览可见                                                                           |
| 2026-08-30 | Clean clone                          | `npm ci`、verify、examples clean diff、doctor、MCP smoke；最终验证 commit `833490b`                                                                                |
| 2026-08-30 | Node 20 / audit                      | 20.10 doctor；20.19 52 tests/typecheck/build/dist/self-test；官方 registry production audit 0 漏洞                                                                 |
| 2026-08-31 | 0.1.3 完整仓库 gate                  | Prettier、ESLint、TypeScript、Vitest `117/117`、build、3 份 dist 逐字节复现全部通过                                                                                |
| 2026-08-31 | 修订并发/恢复                        | 16 进程竞态连续 3 轮各仅一方提交；强杀、完整 lock、15 个故障点、chain limit 与 cleanup 通过                                                                        |
| 2026-08-31 | 紧凑 MCP 预览                        | 1600×900 完整 PNG 落盘，ImageContent 512×288、<=64 KiB、low detail；根/Plugin 七工具 smoke 通过                                                                    |
| 2026-08-31 | 构建后 CLI 修订 UAT                  | rev1/2/3、稳定 lineage、旧文件 hash/mtime 不变、6 个完整新文件、无 lock/temp residue                                                                               |
| 2026-08-31 | GitHub clean clone 0.1.3             | `c75ce96`：`npm ci`、117 tests、dist 复现、examples clean、doctor/self-test、七工具 smoke 全通过                                                                   |
| 2026-08-31 | GitHub 全局安装 0.1.3                | 关闭旧 MCP 后安装成功；version/doctor/revise/全局 stdio MCP 通过，无 `EPERM`/`EBUSY`                                                                               |
| 2026-08-31 | Codex 0.151.0 真实修订               | rev1 判定遮挡；rev2 bottom 后确认 512×328 low-detail 总览中中文清晰、按钮无遮挡                                                                                    |
| 2026-08-31 | Claude Code 2.1.251 真实修订         | Plugin 0.1.3；rev1 判定遮挡并 crop；rev2 left 后确认中文清晰、按钮无遮挡                                                                                           |
| 2026-08-31 | Codex 可选 Skill 0.1.3               | manifest/Skill 本地校验通过；Git marketplace checkout 100% 后仍因客户端 30 秒 clone timeout 判失败                                                                 |
| 2026-08-31 | Node 20 迭代回归                     | 20.10 doctor/self-test + CLI annotate/revise；20.19 revision/MCP 28 tests 全通过                                                                                   |
| 2026-08-31 | v0.1.3 发布                          | 验收文档 commit `7016356`；annotated tag `v0.1.3` 已推送 GitHub                                                                                                    |
| 2026-08-31 | 0.2 自动化 gate                      | 135 tests；实际像素覆盖、连带重排、隐私抑制、单图 MCP、4 KiB 摘要、完整 lineage no-write 与 dist 复现全部通过                                                      |
| 2026-08-31 | 0.2 CLI UAT                          | changed-region `540,446,384,162`；摘要 1,012 B、父链/输出已验证、无路径/hash/ID/文字                                                                               |
| 2026-08-31 | 0.2 Plugin bootstrap                 | 干净副本真实 npm 首装/二次幂等、两个 MCP 并发仅一次安装、损坏 Sharp marker 自动修复；8 工具 doctor 均通过                                                          |
| 2026-08-31 | GitHub clean clone 0.2               | `a09735e`：npm ci、135 tests/全 gate、dist 复现、examples clean、doctor/self-test、8 工具 bootstrap smoke、audit 0                                                 |
| 2026-08-31 | 全局安装与 MCP 恢复 0.2              | 精确 commit 安装；Codex 桌面自动重启旧 MCP 曾复现 EBUSY，官方 remove→install→add 后 version/doctor/8 工具通过                                                      |
| 2026-08-31 | revise 契约真实修正                  | 首次 Codex 无 Skill 测试误用 `replace`；`12edc01` 明示 `set` JSON/禁用 `replace`，下一次真实调用首轮即正确                                                         |
| 2026-08-31 | Codex 0.151.0 真实 0.2 A/B           | doctor 0.2.0；rev1/2 changed-region 384×162、5,512/6,600 B；遮挡→left 无遮挡；inspect summary 通过；crop 0                                                         |
| 2026-08-31 | Claude Code 2.1.251 真实 0.2 A/B     | Plugin 0.2.0 缓存 hash 与 main 一致；同上两轮视觉结论与字节数；inspect summary 通过；crop 0                                                                        |
| 2026-08-31 | 最终 GitHub clean clone 0.2          | `c28974f`：npm ci、135 tests/全 gate、dist 复现、examples clean、doctor/self-test、八工具 smoke 与 clean diff 通过                                                 |
| 2026-08-31 | v0.2.0 发布                          | main 已推送；`v0.2.0` 与 Claude Plugin `agent-callout--v0.2.0` annotated tags 指向本次最终发布提交并推送                                                           |
| 2026-09-13 | macOS 24.21 完整 gate 与干净 clone   | `17cb5c7`：220 passed + 2 skipped（222）、format/lint/typecheck/build、3 份 dist 复现；pack 14 文件、生产 audit 0 漏洞、精确 commit 全局安装 doctor/self-test 通过 |
| 2026-09-13 | macOS OCR 安装与真实定位             | eng+chi_sim 固定模型安装并 ready；中文 unique/93、英文 ROI+反色 unique/95、反白按钮 low-confidence 38–48 坐标精确，确认门禁生效                                    |
| 2026-09-13 | 双客户端 OCR 真实验收                | Claude Code 与 Codex 0.154.0 各自完成"定位→确认→批注→查看"；Codex 另验证 not-found 不猜坐标与 ENOENT 结构化错误；产物经人工查看                                    |
