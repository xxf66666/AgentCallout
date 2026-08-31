# AgentCallout 安全模型

> 状态：MVP 安全基线。本文中的“必须”是实现与发布约束，不代表相关检查已经通过；当前验证状态以 [`compatibility.md`](compatibility.md) 为准。

## 1. 安全边界

AgentCallout 处理的截图、AnnotationSpec、路径和批注文字都视为不可信输入。安全目标是：在用户明确允许的本地目录内读取已有图片、生成新文件，并避免数据外传、目录越界、静默覆盖和不安全的“假脱敏”。

AgentCallout 的渲染核心、CLI 和 stdio MCP Server 默认：

- 完全在本机运行，不调用云端图片、OCR 或模型服务；
- 不需要 OpenAI、Anthropic 或其他模型 API Key；
- 不包含遥测、广告、崩溃上报或后台更新检查；
- 不读取截图、spec 和显式配置之外的业务文件；
- 不在渲染过程中访问网络。

安装和升级是单独的信任边界：用户主动安装或升级时，Git 和 npm 可以访问 GitHub/npm registry 获取仓库及锁定依赖。这个有限网络行为不得被描述为“离线安装”，也不得扩展到正常渲染路径。

“AgentCallout 不上传截图”只描述本项目自身。Claude Code、Codex 或其他宿主可能依据其隐私设置把 MCP 的 ImageContent 或文本发送给模型服务；AgentCallout 无法替宿主作出保证。高度敏感图片应先在本地完成安全 redact，并根据宿主政策决定是否把结果交给 Agent。

## 2. 文件系统与允许根目录

### 2.1 Allowed roots

Server 启动时必须得到一个或多个明确的输入/输出允许根目录。插件场景默认只应授权当前工作区及 AgentCallout 自己的受控运行目录，不能默认授权整个用户目录、磁盘根目录或任意 UNC 共享。

- 输入图片及输入 sidecar 必须位于输入允许根目录内。
- 输出 PNG、JSON sidecar 和临时文件必须位于输出允许根目录内。
- AnnotationSpec 不能通过嵌套字段另行指定任意读取路径。
- MCP tool 每次调用不能扩大 Server 启动时的权限范围。
- 若确需增加根目录，应由用户在启动配置中显式完成，而不是根据请求路径自动推断。

### 2.2 规范化与目录穿越防护

路径检查必须以文件系统真实路径为依据，而不是字符串前缀比较：

1. 拒绝空路径、NUL、Windows 设备路径、alternate data stream，以及未显式允许的 UNC 路径。
2. 使用平台路径 API 解析绝对路径；输入文件使用 `realpath`，尚未存在的输出文件先对父目录使用 `realpath`。
3. 在 Windows 上按不区分大小写的文件系统语义比较，并正确处理驱动器号、分隔符、短文件名、符号链接和 junction。
4. 使用 `path.relative(root, candidate)` 等边界判断，拒绝 `..`、绝对逃逸和“同前缀不同目录”（例如 `C:\work` 与 `C:\workspace-evil`）。
5. 打开输入及提交输出前再次检查父目录，降低校验后替换链接造成的 TOCTOU 风险。

图片扩展名不是信任依据。实现根据解码器识别的实际格式只接受 PNG、JPEG、WebP，并拒绝多帧、动画或超出产品限制的异常输入。

### 2.3 输出与覆盖

- 原图永不作为输出目标。
- 默认拒绝已存在的输出 PNG 或 sidecar，不能静默递增文件名后假装使用了请求路径。
- 只有直接 CLI 提供显式 `--overwrite`；MCP 工具不暴露覆盖参数。即使显式覆盖，输出 PNG/sidecar 仍不得与任何输入文件形成相同路径、符号链接或硬链接别名。
- 非覆盖模式以排他写入创建 PNG 和 sidecar；sidecar 写入失败时回滚本次新建 PNG，不把半成品报告为成功。
- 显式 CLI 覆盖时 PNG 与 sidecar 的双文件替换尚不是跨文件事务；这是已知限制。高风险自动化应写入新路径，再由调用方完成受控替换。

### 2.4 版本化批注修订

`revise` / `revise_annotation` 只接受通过 AgentCallout 结构与完整性校验的 annotate sidecar、严格的稳定 ID edits，以及原图移动或 parent 使用 basename-only 语义时显式提供的同字节 input。这里的“可信”不是数字签名、文件系统只读或对同目录恶意写者的防护。接口不接收 output、overwrite、revision number、JSON Patch 或 spec 根字段。开始渲染前必须验证：

- parent JSON 可完整解析，manifest 版本受支持，operation 为 `annotate`；
- `annotationSpec` 与 `operationSpec` 的 canonical 结果一致，spec hash、annotation count 一致；
- parent sidecar 文件名、输出引用、输出尺寸及输出 SHA-256 一致；
- 原图引用语义明确，输入 metadata 与 SHA-256 一致；basename-only 引用不得扫盘猜测，必须显式给 input；
- 已有 revision 的直接父路径、sidecar/output/spec hash、edits hash、连续编号和 lineageId 能逐级重放到 base sidecar；
- 原图、sidecar、所有祖先输出互不形成相同路径、符号链接或硬链接别名。

edits 按数组顺序执行。`add` 必须带当前不存在的 ID，可选 `afterId`；`set` 必须以同一 ID 完整替换并保持位置；`remove` 必须命中现有 ID。同一批中重复触碰 ID、未知 ID、无变化的 `set`、最终无变化或最终 AnnotationSpec 非法都会整批拒绝。每批限制 1–400 个 edits；parent sidecar 限 10 MiB；一条工作副本最多 255 个 revision、完整链最多 256 份 sidecar，累计 sidecar+输出读取预算为 512 MiB。达到边界时在生成不可再次读取的新版本以前返回 `REVISION_LIMIT_REACHED`。

同一 sidecar 目录中的 lineage 使用排他 lock，完整 lock 先在临时文件写入并同步，再以 no-replace link 发布；下一编号只能来自当前 parent。目标 PNG/JSON 同样 no-replace：PNG 先发布，经过同步且最终读回验证的 JSON 最后发布并作为提交标志。发布 JSON 以前的可捕获故障会清理本事务的 temp 和自有 orphan PNG；已有有效 sidecar 的 revision 永不自动删除。

进程被强制终止或断电仍可能留下 lock、temp 或无 sidecar 的 orphan PNG。只有 dead-PID lock、token、revision/lineage/parent/path 和文件 hash 全部能证明归属时才自动清理；不完整 lock、归属不明或内容矛盾时返回 `REVISION_RECOVERY_REQUIRED` 并保留证据。若 sidecar 已提交而后续清理失败，成功结果通过独立的 `recoveryWarnings` 报告，不改写 sidecar 中只描述渲染的 `warnings`。这一机制不是跨文件断电级原子事务。

Lock 是目录内协调，不是跨机器或跨目录的全局共识。把完整 lineage 复制到另一个目录后，两份工作副本可以各自继续并形成 fork；合并或选定权威 head 由交付流程负责，AgentCallout 不应声称阻止这种显式复制后的分叉。

MCP 不暴露 overwrite；已有普通图片输出冲突时应要求新 `outputPath`，不得建议 MCP 调用方传入不存在的 `overwrite` 参数。修订失败使用稳定错误码（例如 `REVISION_CONFLICT`、`INPUT_INVALID`、`INPUT_HASH_MISMATCH`、`REVISION_LIMIT_REACHED`、`REVISION_RECOVERY_REQUIRED`），错误结果仍不得记录 sidecar 全文、批注文字或绝对路径到 stderr 持久日志。

### 2.5 聚焦预览与 sidecar 摘要

聚焦预览是新的高细节出口，必须晚于 parent/spec/output/父链验证：

- 父 spec 与新 spec 都以同一原图和当前 renderer 在本地解析几何；父 spec 重渲染 hash 必须与已验证父输出一致，否则不能生成局部聚焦图。
- 只裁剪本次已提交、SHA-256/尺寸重新验证的当前输出 PNG；不裁剪原图、父 revision 输出，不扫描目录猜测文件。
- touched 与连带自动排版迁移共同决定候选；父/子实际 RGBA 像素差异再与几何范围合并，以覆盖宽描边、箭头头部和 alpha-only 变化。外扩/clamp 后只有一个连通簇且最终面积不超过画布 50%才聚焦。其他情况返回 low-detail compact-overview。
- 每次最多一张 ImageContent、最长边 512 px、PNG 最多 64 KiB；focus 编码失败返回 text-only 成功结果，不回滚 revision，也不偷偷发送整图。
- 只要直接父版本或修订后 spec 含 blur/redact，默认不自动放大局部。父版本敏感覆盖被删除或任一字段变化时返回 `review.mode=none`，不发送任何图片。`none` 是隐私抑制，不是渲染失败。
- changed-region 必须返回原画布 `sourceRect`，Agent 不得把局部判断表述为完整画布已复核。

`inspect-sidecar` / `inspect_annotation_sidecar` 是只读过滤器。它复用完整 sidecar/output/父链门禁，不打开原图、不修复/重写文件、不返回 ImageContent，且结果序列化不超过 4 KiB。默认公开字段只含 manifest/spec 版本、输出尺寸、批注 type 计数与 resolved inventory 身份对齐状态、revision 深度与目录协调边界、warning 数量、验证状态、blur/redact 布尔值和压平 PNG 的可移植性事实；明确排除所有路径/文件名/Markdown、hash/lineage/parent/edits、annotation ID/文字/style/raw warning/resolved geometry、renderer/font 指纹。任何验证失败只返回错误，不得返回部分成功摘要。

## 3. 资源限制

图片压缩体积很小并不代表解码成本很小。实现必须在进入 Sharp/libvips 的昂贵路径前后分别设限，并且不能允许单个 AnnotationSpec 关闭硬上限。

| 限制                             | 必须执行的位置                                   | 当前状态                                   |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| 输入文件字节数                   | 打开/读取前检查文件大小                          | **50 MiB**                                 |
| 单边最大宽高                     | 由受限解码与总像素共同约束；MVP 不另设独立单边值 | **总像素门限内**                           |
| 解码后总像素                     | Sharp `limitInputPixels` 与应用层同时约束        | **40,000,000 像素**                        |
| crop 与输出总像素                | 坐标转换后、渲染前再次计算                       | **40,000,000 像素**                        |
| annotation 数量与单条/总文字长度 | Schema 验证阶段                                  | **200 条；单条 10,000、合计 100,000 字符** |
| contact sheet 输入               | Schema/核心双重校验                              | **64 张；16 列**                           |
| MCP ImageContent/预览            | base64 前逐级缩小；完整 PNG 仍保留在本地路径     | **64 KiB；最长边 512 px；默认 low detail** |
| sidecar 公共摘要                 | 完整校验后构造独立过滤 DTO                       | **4 KiB；零 ImageContent**                 |

数值必须集中定义、由 doctor 输出，并在 README 与错误信息中保持一致。发布门槛是：每一种限制都有恰好位于边界、超过边界、畸形 metadata 和资源释放测试；在这些数值确定以前，不得把大图防护标记为 VERIFIED。

## 4. 渲染输入安全

### 4.1 SVG、XML 与 Pango 文字

AgentCallout 只生成受控的几何 SVG。用户不能提交原始 SVG、元素名、属性片段、CSS、URL、外部资源或 data URI。颜色、线宽、坐标和枚举必须经过 Schema 与有限值检查；`NaN`、无穷大和极端数值均应拒绝。

所有用户文字都作为纯文本处理：

- 对 XML/SVG 与 Pango markup 的 `& < > " '` 及控制字符进行正确转义；
- 不把文字拼接到 SVG/XML 属性中；
- 不允许用户开启 Pango markup、插入标签、引用字体文件或加载外部资源；
- 文字由指定的捆绑字体生成独立 sprite，再与受控几何图层合成。

测试必须包含 `</text>`、`<span>`、实体、引号、双向文字、换行、超长单词以及中英文混排，证明它们只作为可见文字处理，不能改变渲染结构。

### 4.2 Metadata 策略

解码时应用 EXIF orientation，随后以 Agent 实际看到的画布尺寸进行坐标转换。输出 PNG 默认剥离 EXIF、XMP、ICC 注释、源文件名和其他非必要 metadata；不得把 AnnotationSpec、绝对输入路径或批注文字写入图片 metadata。只有渲染结果 sidecar 保存审计字段。

Sidecar 本身可能包含绝对路径、批注文字和可关联文件的 hash，应按敏感交付物处理。它只能写入允许的输出根目录，也不能被复制进日志。

### 4.3 Blur 与 redact

`blur` 只降低视觉可读性。原始像素的统计特征仍可能残留，且弱模糊可能被推断或增强，所以 blur **不得**用于 Token、密码、私钥或其他必须不可恢复的秘密。

`redact` 是安全遮挡：

- 对目标矩形的所有颜色通道和 alpha 执行完全不透明的像素替换，不使用透明度、滤镜、马赛克或仅覆盖 metadata；
- 不把原始区域作为隐藏图层、可撤销对象或嵌入资源保留在最终 PNG 中；
- 输出后重新解码，验证 redact mask 内没有任何原始像素残留且 alpha 为不透明；
- privacy golden test 必须对原始区域和输出区域做像素级比较，而不能只凭肉眼判断。

Redact 只能保护指定区域；坐标错误、漏选区域或输出前后又叠加含秘密的文字仍会泄漏。Agent 必须查看结果并确认覆盖范围。

## 5. MCP、stdout 与日志

stdio MCP 的 stdout 是 JSON-RPC 专用信道。启动 banner、进度、doctor 输出、Sharp 警告和调试信息全部只能写入 stderr；core 代码不得直接调用 `console.log`。自动化测试必须解析完整 stdout，证明首尾没有额外字节。

默认不创建持久日志。stderr 日志只允许包含：稳定错误码、请求 ID、图片尺寸、批注数量、耗时和成功/失败状态。默认不得记录：

- 图片字节、base64 或像素样本；
- AnnotationSpec 全文或批注文字；
- Token、环境变量、凭据或客户端配置内容；
- 完整绝对路径和 sidecar 内容；
- 未清洗的异常对象或生产堆栈。

Tool 的显式结果可以按接口返回输出绝对路径、Markdown 引用和 hash，这是功能数据而不是日志。错误应返回可修正的结构化错误码；详细堆栈只在用户主动开启本地 debug 时写 stderr，且仍须清洗敏感字段。

## 6. 配置、插件与 bootstrap

安装器和插件 bootstrap 拥有修改客户端配置、执行 Node/npm 的能力，因此必须遵守：

- 优先调用 Claude Code/Codex 官方 plugin 或 MCP 管理命令，不手工重写整个配置文件。
- 若确需直接修改 JSON/TOML，先做带时间与 hash 的同目录备份，校验原文件可解析，只修改 AgentCallout 自己的键，临时文件验证后原子替换；失败自动恢复。
- 支持 dry-run、重复安装、升级和卸载；卸载只删除本项目创建的条目和受控运行目录，不删除用户其他 MCP/Plugin 配置。
- 不读取、输出或写入凭据；不请求管理员权限，不修改系统级 PATH，不执行用户输入拼接出的 shell 字符串。
- 子进程使用固定 executable 与参数数组；校验 Node 版本和所有路径，避免 PowerShell/cmd 注入。
- Codex Git marketplace 首次启动所需的 Sharp runtime bootstrap 必须幂等、有并发锁、失败可重试，并在依赖已存在且完整时立即 no-op。
- bootstrap 只按提交的 lockfile 安装固定依赖，禁用 lifecycle scripts；不得下载并执行任意脚本、跟随可变分支或静默切换 registry。
- 安装/更新期间的 GitHub/npm 网络访问必须明确显示；普通 render、inspect、validate、crop 和 doctor 不得触网。

## 7. 依赖与发布供应链

- `package.json` 使用精确版本，提交 lockfile；CI 和 bootstrap 使用 `npm ci`，不能用浮动的 `latest`。
- 对 Sharp 的平台可选包、MCP SDK、Schema 验证器和捆绑字体记录版本、来源、许可证与完整性 hash。
- 发布构建必须从干净 clone 复现，运行 dependency audit、license 检查、lint、typecheck、test、build 和产物清单检查。
- `.npmrc`、测试夹具、日志、sidecar 和示例不得包含 Token、用户截图、绝对个人路径或私有 registry 凭据。
- 更新不得自动发生；用户显式执行升级后，仍应运行 doctor/self-test。

依赖扫描告警需要人工判断影响面，但不能通过删除 lockfile、跳过脚本或放宽测试来制造“通过”。

## 8. 发布前安全验证门槛

以下证据全部完成后，安全状态才可从规划提升为 VERIFIED：

- Windows 大小写、`..`、同前缀目录、UNC、设备路径、ADS、symlink/junction 和输出父目录逃逸测试；
- 输入字节、边长、总像素、文字和 ImageContent 上限的边界测试；
- 原图/sidecar 已存在、同路径输出、并发写入和失败回滚测试；
- metadata stripping 与输出重新解码测试；
- XML/Pango 注入与畸形数值测试；
- redact 原像素消失、alpha 不透明及 blur 安全说明测试；
- MCP stdout 零污染和日志敏感字段测试；
- 安装 dry-run、备份、幂等、并发 bootstrap、升级和卸载不破坏既有配置测试；
- 干净 clone 使用 lockfile 完成安装、build、test 和 doctor。

## 9. 剩余风险

即使上述门槛通过，仍存在以下边界外或无法完全消除的风险：

- 恶意图片可能利用 Sharp/libvips 或格式解码器的未知漏洞；依赖需要及时更新。
- GitHub、npm registry、上游包或发布账号被攻破属于供应链风险；lockfile 只能降低漂移，不能消除源头失陷。
- 本机同一用户权限下的其他进程、备份软件或云同步目录可以读取输出；AgentCallout 不提供磁盘加密或 DLP。
- Sidecar 与 hash 会泄漏路径、批注文字或文件关联；分享 PNG 时不应默认同时分享 sidecar。
- 路径检查与最终打开之间仍可能存在很小的链接替换竞态；受控根目录的写权限决定该风险大小。
- Redact 的安全性依赖覆盖坐标准确；未选中的秘密、缩略图、窗口阴影或批注文字不会自动被发现。
- Blur 永远不是安全删除。
- 宿主客户端如何保存、传输或训练使用 Tool 结果不由 AgentCallout 控制。
