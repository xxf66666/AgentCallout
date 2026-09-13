# AgentCallout 路线图

更新于 2026-09-13（经四视角规划与对抗评审的后续迭代计划）。版本顺序代表验收优先级；真实完成状态以 [PROGRESS](../PROGRESS.md) 和[兼容性证据](compatibility.md)为准。

## 已发布（0.1 → 0.4.1）

- **0.1–0.2.0**：十类批注、AnnotationSpec 1.0/1.1、append-only .revN 修订、CLI/MCP/Plugin 分发、changed-region 局部复核与安全 sidecar 摘要。
- **0.2.1**：密集说明框避让、折线引线、排版 warning、预览像素指标、`auto` 显示标记。
- **0.3.0**：可选本地中英文 OCR 定位（`locate-text`/`locate_text`，多候选与置信度确认门禁，截图/原图 hash 绑定）。
- **0.3.1**：`create-handoff`/`verify-handoff` 跨 AI 一键交接包（普通目录+JSON，manifest/摘要/HANDOFF.md 入口）。
- **0.4.0**：可选浏览器 DOM 定位（`locate-dom`/`locate_dom`，selector/文字/可访问性名称，截图 SHA-256 + 页面状态绑定，iframe 偏移）。
- **0.4.1**：`fork-lineage`/`diff-revisions`（working copy/fork 显式化与稳定 ID 级差异对比；自动 merge 评估后推迟）。
- **0.5.0**：真实绿灯——DOM 测试 fixture 化、DPR 防御校验、lineage/OCR 测试债补齐、ADR-0004 宿主回归；Node 支持线上移至 >=22。
- **0.5.1**：Windows 补丁——DOM 定位临时目录改用 `tmpdir()`（修复 CI 暴露的 `mkdtemp ENOENT`）；OCR 真实安装测试自包含并获专用 CI job；CI 失败匿名 issue 报告通道。
- **0.6.0**：批量批注——`annotate --batch`/`annotate_batch`（1-32 图、跨图连续编号、fail-fast/continue、聚合预览）（已发布）
- **0.6.1**：候选可视化核对 `preview-candidates`/`preview_candidates` + Chromium 多引擎（Chrome/Edge 零下载）（已发布）。
- 平台与工程：CI 三平台 × Node 20/22/24 矩阵 9/9；CLI 与 stdio MCP 14 工具；Claude Plugin 与 Codex CLI+MCP 双分发路径。

---

## 后续迭代计划

### 先行任务（立即执行，纯文档与流程，不占版本窗口）

发布可见性与文档状态信任修复——纯文档+CI 提交直接合并 main，不打新 tag、不触发重验收：

- PROGRESS.md 头部「当前状态/待完成」重写至 v0.4.1 事实；decisions.md 主表 D-001/D-003/D-008 与 ADR-0009 状态行按现有证据逐条对齐。
- 为缺失的 6 个主版本标签补建 GitHub Release（v0.1.3/v0.2.0/v0.3.0/v0.3.1/v0.4.0/v0.4.1，另核对 v0.1.2 是否补建或有意不建）；正文取自 docs/releases，附安装命令与兼容表链接。
- README 兼容表按证据三档如实更新（Linux 与 Node 20.10/20.19 维持「仅 CI 矩阵守护」表述，无新证据不改口）；GitHub topics 与 CI badge。
- 新增「任意 stdio MCP 宿主接入」文档小节，明确标注 NOT VERIFIED。
- 防漂移检查合入 CI：结构化锚定 PROGRESS「当前状态」与 decisions 状态行，比对最新 tag。
- **Node 支持线决策**（完备性评审补充）：Node 20 已 EOL，须先决策 engine floor 是否/何时上移 22，再定 v0.6.1 的回归范围；同时登记依赖升级联动流程（sharp/playwright-core 升级 → dist 重提交 + 基线重录 + compatibility 版本行）。
- 执行前置：gh 认证（Release 补建与 topics 需要）。

### v0.5.0 —— 真实绿灯：堵住「绿灯假象」测试债，为后续版本提供可信地基

- **DOM 定位测试 fixture 化（大项）**：fixture HTML 与预期状态入库 `tests/fixtures/`；删除 `/tmp/dom-rt`、`file:///private/tmp/...`、硬编码 macOS Chrome 路径；运行时与状态全部走测试临时目录。
- CI 策略：可预装 Chrome 的格子尽力真实执行（评估 playwright-core 安装成本），不可用格子显式打印 skip 原因且状态可见。
- DPR 防御校验：launch 显式 `deviceScaleFactor:1` 并断言截图实际像素==CSS viewport，不一致返回稳定错误码（防御性失败，非 DPR≠1 支持）。
- lineage 模块错误分支测试补齐（fork 源损坏、fork.json 篡改、路径规范化、目录冲突）。
- OCR 测试债同构修复：恢复 2 个长期 skip 的运行时真实安装测试；补「断网沙箱子进程」离线回归。
- **ADR-0004 回归**：Codex 0.154 下 structuredContent 与 ImageContent 同结果的真实双端重测（触发条件已满足）。
- 超大图资源边界：补渲染管线资源上限测试或 README 显式声明输入上限与稳定失败语义。

### v0.5.1 —— 整套截图一次标完：批量批注与跨图连续编号

- **`annotate --batch`（大项）**：普通 JSON 清单（逐项=图片路径+完整 spec），跨图连续编号（利用现有 number 字段）与逐图独立编号两种模式；零新增 spec 字段。
- 执行语义：逐图顺序、默认 fail-fast、`--continue` 显式继续零静默跳过；单图失败隔离、逐图汇总、无半成品残留；须定义宿主超时/中断语义（批量上限、宿主断开后服务端行为、分批建议）。
- MCP `annotate_batch`：按图片工具契约（省略 structuredContent，单一 JSON TextContent 逐图汇总 + 至多一张聚合预览）。
- 质量基线顺带采集：批量验收时统计逐图 layout warning 出现率，作为布局器改进证据。
- 文档：「一次评审整套截图→批量批注→连续编号→交付」端到端 recipe。

### v0.5.2 —— 看得见再确认：候选可视化核对 + Chromium 多引擎

- **`preview-candidates`（大项）**：把 OCR/DOM 候选 bbox 画为编号描边框，生成独立 PNG 与 512px/64KiB 预览；把「多候选/低置信度必须确认」从读 JSON 变成看图选号。
- preview 为临时核对产物：不写 sidecar、不进修订链、不自动生成批注；与 core 现有区域 preview 明确命名区分。
- Chromium 多引擎：`browser status` 枚举本机 Chrome/Edge（零下载），`locate-dom` 支持 engine 选择并记入候选证据 **engine + 主版本字段**。
- 公网证据采集（非阻塞、不作 gate 通过条件）：固定公网页面清单的人工深度验收流程，网络不可用显式跳过。
- Firefox/WebKit 仅出书面评估；文档明确可访问性名称为启发式计算。

### v0.6.0 —— 从批注到交付：报告导出与模板重放

- **`build-report`（大项）**：一个或多个已验证 sidecar → 普通 `review-report.md`（逐图 Markdown 图片引用、按稳定 ID 的批注清单、tone 语义、1.0 如实标注、layout warning 逐图、可选安全摘要章节）。
- 报告确定性：排序规则显式、同批输入重复生成逐字节一致；默认引用最新修订输出、可选修订号；不写时间戳；MCP 端仅 ≤4KiB 结构化摘要。
- **`apply-template`**：从已验证 sidecar 按稳定 ID 筛选批注组，以 normalized 坐标重放到新截图——同分辨率精确、等宽高比按比例缩放并报告系数；输出为普通 AnnotationSpec 1.1 spec 供检查后再 annotate（越界/裁边沿用 validate 语义）；不做图像特征自动对齐。
- 注意（完备性评审）：批注文字写入 Markdown 须处理转义（尖括号/HTML/链接语法）与图片路径编码；`create-handoff`（给 AI）与 `build-report`（给人）分工要在文档中一句话辨析。

### v0.6.1 —— npm 分发与安装链路加固

- **npm 正式发布（大项）**：去 private、prepublishOnly 挂 verify、元数据核对、pack 结构清单核对（tarball 内 dist 与发布 commit 逐字节一致锚定）；npm 与 GitHub 双安装路径并列；不自动 publish、无 postinstall 下载、无遥测。
- 发布级前置回归（二选一落地、另一项如实标注）：干净 Linux 环境完整发布纪律行程（无头「图片可见」操作定义动工前明确）；或 Node 支持线决策后的最低/次低版本发布级回归。
- bootstrap 加固：锁等待 stderr 可见持有者 PID 与等待时长、超时报错附恢复指引；多进程并发与同版本重装测试。
- 三类安装/残留故障 runbook 入 docs（malformed canonical、Windows EBUSY、install-links 残留）+「git 安装迁移到 npm」章节。
- 示例库扩充（可搭车或拆至 v0.7.0）：OCR 多候选确认、DOM 证据、交接包、fork/diff 协作四组端到端示例。

### v0.7.0 —— 自诊断：修订链与安装的只读诊断

- **`workdir-doctor`（大项）**：修订链只读诊断——逐环状态、首个断点定位、完好前缀与恢复建议（如「rev0–rev6 完好，可从 rev6 fork」）；不做自动修复、不重写字节、不做 merge。
- doctor 安装诊断：bin 真实路径、安装来源启发式识别（npm/git/Plugin 缓存，未知来源兜底）、dist 完整性与 Sharp 载入检测、install-links 风险与版本陈旧提示。
- 双来源（npm/GitHub 安装）诊断路径真实验证并记 compatibility。

### 依赖与并行建议

- 先行任务立即做（gh 认证是唯一前置）；v0.5.0 的 ADR-0004 回归结论是 v0.5.1 MCP 批量返回形态的前置；v0.5.1 的 CLI 批量与 v0.5.2 的 Edge 枚举可提前并行。
- v0.5.2 preview-candidates 的 DOM 半边验收依赖 v0.5.0 fixture 化；OCR 半边不依赖。
- v0.6.1 Linux 行程可与 v0.5.0 的 Linux 真机验证共用一次机器；Node 支持线决策须先于 v0.6.1 回归范围。
- v0.7.0 workdir-doctor 无硬前置、可提前设计；doctor 安装诊断依赖 npm 双来源场景成熟。

### 远期（不排期）

- fork 三方合并（ADR-0012 维持推迟；复核条件：至少两例真实跨会话 fork 收敛记录，经公开 issue 收集，严禁埋点遥测）。
- 第三个 MCP 宿主真实验收（有真实第三宿主信号时复启）。
- Firefox/WebKit 引擎适配（仅在书面评估证明可零下载复用本机浏览器时立项）。
- DPR≠1 显式坐标支持（待真实 HiDPI 用户信号）。
- 批量定位（先批量 OCR/DOM 再统一批注）；批注质量度量（以 v0.5.1 warning 基线为起点）。
- npm registry 发布之外的独立可执行程序（Sharp 原生资源与签名成本高，保留观察）。

### 外部阻塞

- Codex Skills-only Git Marketplace 30 秒 clone 超时（不阻塞 CLI+MCP 主路径，新版 Codex 发布时重测）。
- gh CLI 未登录：阻塞 Release 补建与 topics，须先认证或等效 token。
- CI runner 浏览器可得性、OCR 运行时下载可达性：v0.5.0 动工时实测，不可用格子显式 skip。
- Linux 真机/无头环境可得性（v0.6.1 回归行程资源前置）。

---

历史路线（0.1–0.4.x 各版细节）见 [PROGRESS](../PROGRESS.md)、[兼容性证据](compatibility.md)、[发布记录](releases/) 与 [ADR 索引](decisions.md)。产品边界不变：本地优先、无需模型 API Key、默认无遥测、不上传截图；OCR/DOM/截图/GUI 均为独立可选适配器。
