# v0.3.0 本地 OCR 有界技术验证

日期：2026-09-06。状态：**原型验证，未实现 v0.3.0 产品接口，未提交发布**。

可继续采用 Tesseract.js 作为可选本地 locator。Windows 上已经用真实截图字节识别出中英文、坐标、置信度和重复候选，识别阶段的网络调用拦截记录为零。它仍会漏识别蓝底白字，也会把图标识别成文字；因此输出必须是可核查的候选，不能把“最高分”自动当成正确目标。

本次只在独立临时目录安装依赖和运行脚本，主仓库的源代码、package.json、lockfile 与现有渲染接口均未因本验证修改。公开依赖及语言包通过 npm 下载；图片仅在本地读取，没有上传。

## 1. 选定方案与官方依据

使用 `tesseract.js@7.0.0`、`tesseract.js-core@7.0.0`，加载 `eng` 与 `chi_sim` 的 `4.0.0_best_int` LSTM 模型。采用现有 Node/Sharp 环境，避免为可选 locator 增加另一种主运行时。v7 的 Node worker 从本地 npm 包加载 WASM core；Node 分支并不使用浏览器的 core CDN 路径。[v7 release](https://github.com/naptha/tesseract.js/releases/tag/v7.0.0)、[Node getCore 源码](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/node/getCore.js)。

`recognize` 需要显式开启 `blocks` 才能得到细粒度结构。原型沿 `blocks → paragraphs → lines → words → symbols` 提取文本及 bbox；正常空结果不代表引擎抛错。[v7 API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md)、[v7 类型定义](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/index.d.ts)。

本次没有继续横向比较云 OCR、Python 包或原生可执行程序；已经获得足够的正向结果与失败证据，后续重点应是 locator 契约和真实用例覆盖。

## 2. 如何避免识别时自动联网

**只设置 `cacheMethod: "readOnly"` 不等于离线。** 官方加载逻辑在缓存缺失时继续尝试语言加载；未给出 `langPath` 时会构造 jsDelivr 地址。Node 的明确本地 `langPath` 则走文件读取。[本地安装说明](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/local-installation.md)、[语言加载源码](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/index.js)。

本次实际成功的入口如下。`modelDirectory` 是已经校验存在、尺寸和 SHA-256 的本地绝对目录，内含两个解压后的 `.traineddata` 文件；`workerPath` 指向已安装包的本地 Node worker。

```js
const worker = await createWorker(["eng", "chi_sim"], OEM.LSTM_ONLY, {
  workerPath: localWorkerPath,
  langPath: modelDirectory,
  cacheMethod: "none",
  gzip: false
});
await worker.setParameters({
  tessedit_pageseg_mode: PSM.SPARSE_TEXT,
  user_defined_dpi: "96"
});
const { data } = await worker.recognize(localImageBuffer, {}, { text: true, blocks: true });
```

实验在主进程和 worker 中拦截 `fetch`、HTTP/HTTPS 请求及 socket connect，拦截时先记录 API 名再抛错。首轮初始化和四次识别成功，记录为 `networkAttempts: []`。这证明本次固定版本、路径和输入下无需请求网络；它不是操作系统级网络隔离证明。

另外故意省略 `langPath`、关闭缓存，验证默认路径：两次独立尝试均被 `fetch` 拦截，未发出网络请求。错误回调收到 `SPIKE_NETWORK_DISABLED: fetch`；等待创建 worker 的 promise 未及时结束，第二次由实验的 8 秒 deadline 退出，耗时 8006ms。产品接入需要受控 worker 生命周期和 deadline，不能只记录 error callback 后继续等。

曾尝试官方类型中公开的 `Lang[]` / `{ code, data }` 字节入口，**在这个固定版本实际失败**。初始化源码把对象的 `data` 拼成语言名，导致模型字节被展开到错误输出，随后出现 `Cannot read properties of undefined (reading 'resolve')`。因此当前建议使用已经跑通的字符串语言名加本地 `langPath`，不采用该字节入口，也不修改上游包来掩盖失败。[对应初始化源码](https://github.com/naptha/tesseract.js/blob/v7.0.0/src/worker-script/index.js)。

产品建议将模型获取与识别明确分开：用户主动安装 OCR 能力或语言模型时可以下载；普通识别只接受已验证本地文件。缺模型时在启动 worker 前返回可操作的“模型未安装”错误，不能自动回退 CDN。本次缺失文件的预检查得到 `ENOENT`，未启动 worker。

## 3. 模型体积与目录策略

| 文件                  | gzip 字节数 | 解压后字节数 | 本次来源                                          |
| --------------------- | ----------: | -----------: | ------------------------------------------------- |
| `eng.traineddata`     |   2,952,873 |    5,199,098 | `@tesseract.js-data/eng@1.0.0/4.0.0_best_int`     |
| `chi_sim.traineddata` |   1,718,768 |    2,471,033 | `@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int` |
| 合计                  |   4,671,641 |    7,670,131 | 仅本次实际使用的两个模型                          |

这两个 npm 语言包还附带未使用的 legacy 模型；完整包展开分别占 13,876,967 和 21,879,575 字节。Tesseract.js 包占 1,411,341 字节，core 包占 45,262,431 字节；本次临时 `node_modules` 合计 87,435,734 字节。上表模型合计不能用来冒充完整安装体积。来源包指向官方 [naptha/tessdata](https://github.com/naptha/tessdata)。本次只读包 metadata 中，JS/core 为 Apache-2.0、语言 npm 包声明 MIT；正式分发前仍应记录实际模型来源及其归属说明。

实际模型 SHA-256：

| 语言    | gzip SHA-256                                                       | 解压后 SHA-256                                                     |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| eng     | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` | `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747` |
| chi_sim | `b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c` | `9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6` |

建议使用独立、版本化的本地模型目录和 manifest，记录语言、模型版本、字节上限及 hash；可由启动配置指定 `modelDirectory`。读取前验证真实路径和文件完整性；模型缺失、损坏或超限直接报错。原型对 gzip 解压设置了 32 MiB 上限。正常调用不写语言缓存，不从当前业务目录隐式寻找 `.traineddata`。是否独立分发 OCR runtime 尚未实现，不能把这里的建议写成可用安装命令。

## 4. 实际输入、版本和延迟

基线是本仓库脚本生成的 1280×800 合成 UI，包含中文订单、英文下拉框、两个复选框、红色错误文字、蓝底白字保存按钮、角落图标：`.agent-callout/dense-acceptance/input.png`。SHA-256 为 `22716c039465e57fd5232eed97906a0e11ad35b1dc2fa6eb3a65a456d8358cd3`。

运行环境为 Windows x64、Node 24.18.1、Sharp 0.35.4。Tesseract.js/core npm 版本均为 7.0.0，OCR 返回的内部引擎版本为 `5.1.0-288-g2a9c1`。只测了这台电脑；以下单次耗时不代表 p95、跨平台或不同硬件性能。

| 步骤                                      |   实测耗时 | 结果                                                   |
| ----------------------------------------- | ---------: | ------------------------------------------------------ |
| 新 worker 初始化，加载本地两语言模型      |  253.013ms | 成功；不含 npm 下载或模型解压准备                      |
| 原图首次识别                              |  514.804ms | 得到中英文；漏掉保存按钮                               |
| 同一 worker 再识别原图                    |  443.021ms | 本轮文本和已查询候选与首次相同                         |
| 原图左右复制为 2560×800                   |  937.155ms | 重复文字分别返回两个候选；两个保存按钮只识别出右侧一个 |
| 缩至 512×320                              |  368.301ms | 页面分数降至 35；所查的 Normal、保存、校验失败均未命中 |
| 全图 2 倍、保留彩色                       | 1293.445ms | Normal/错误等仍可识别；保存仍漏识别                    |
| 全图 2 倍、灰度 normalise                 |  954.502ms | 结果显著变差；不采用为默认预处理                       |
| 已知保存按钮内区 4 倍放大、反色、单行模式 |   42.727ms | 识别出 `保存 Save`                                     |

首次到缩略图四次运行的进程 RSS 快照为 192,561,152–218,775,552 字节，包含主进程、Sharp 和 worker，未测峰值。上述已知内区由测试输入坐标提供，**不证明 OCR 自动发现了按钮**。带外框的较宽区域反色试验也曾错误识别为 `[ 550 |`，说明预处理与区域选择都不能凭直觉保证有效。

## 5. 文字匹配、重复候选与坐标证据

原型在 OCR 结果上演示两种匹配。为了处理本例被 OCR 插入的中文空格，临时规则是 NFKC、移除空白、大小写敏感；没有模糊字替换。这个规则尚未冻结为产品默认，移除英文空格可能造成语义合并，需要显式契约和回归样本。

- **exact**：同一行内连续 OCR word 的归一化文字必须完整等于查询。返回参与 word 的 bbox 并集。
- **contains**：在同一行的 symbol 序列中查找查询，返回命中 symbol 的 bbox 并集与对应 word 索引。
- 两者均返回原始识别文字、原始行文字、block/line/word 索引及置信度。原型候选置信度取支持 word 的最小值；它是引擎分数，不是正确率。

| 实际查询                     | 输入         | 候选及证据                                                                                                       |
| ---------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| exact `Normal`               | 原图         | 1 个；`{x:653,y:357,width:54,height:13}`；96                                                                     |
| contains `校验失败`          | 原图         | 1 个；`{x:431,y:472,width:77,height:33}`；92；原始行是带空格的中文                                               |
| exact `Normal`               | 左右复制图   | 2 个；第二个 x=1933，其余尺寸相同；两者均为 96                                                                   |
| contains `校验失败`          | 左右复制图   | 2 个；x=431 与 1711；两者均为 92                                                                                 |
| exact `Sav` / contains `Sav` | 左右复制图   | exact 为 0；contains 为 1，命中右侧 Save 的前三字符                                                              |
| exact `保存` / `Save`        | 原图         | 都为 0，不能据此声称截图中不存在保存按钮                                                                         |
| `保存` / `Save`              | 已知保存内区 | 文字框映回原图分别为 `{x:608.5,y:565.25,width:31,height:16}` / `{x:645,y:567,width:34.25,height:12.25}`；94 / 95 |
| exact `不存在的按钮`         | 原图及复制图 | 0 个，保持空候选                                                                                                 |

缩放和 ROI 的逆映射必须保留 `scale`、`offsetX`、`offsetY`，按 `xOriginal=xOcr/scale+offsetX` 转换；随后使用统一核心做有限值、画布约束及最终整数坐标处理。OCR bbox 是文字范围，**不能自动冒充整个按钮 bbox**；本例高分中文也存在重叠/偏高的子框，需要保留原始证据供复核。

两个高分候选都必须保留。原型用“多结果或任一候选低于 80”演示 `requiresConfirmation`；80 没有经过校准，不是已接受产品门槛。零结果需要独立 `not-found` 状态，不能由 `requiresConfirmation=false` 推导出成功。图标被识别成“一”“口”“回”等也是实际观察到的假文字；高分不能代替看图。

## 6. 对 v0.3.0 的具体落地建议

1. 新增可选 locator 层，按需加载 OCR runtime。现有 annotate/revise/render 不引入 OCR 或默认联网。
2. 输入已有图片、语言、查询、exact/contains、可选用户指定区域。复用 core 的输入限制和 EXIF 处理；OCR 使用完整本地源图，不使用 MCP 的 512px 预览代替源图。
3. 输出 `not-found / unique / ambiguous / low-confidence` 等明确状态与候选数组。多候选、低置信度由 AI 展示/确认后选取；没有“默选最高分”的路径。
4. 定位证据绑定输入 hash、定向画布尺寸、engine/model 版本、预处理变换、匹配规则、原始候选文字及 OCR bbox。图片变化后失效，不能沿用旧坐标。
5. 只把已选择候选变成普通 AnnotationSpec target，并继续调用当前渲染器。可选外扩只作为明确的几何操作；不得据文字框偷偷推断控件边界。
6. 随后补真实离线、缺/坏模型、初始化失败和取消、重复文字、中文断词、透明图、小字/反白、EXIF/缩放映射及两个客户端调用的验收。本次没有证明这些产品级矩阵全部通过。

## 7. 本地证据与复现范围

临时目录位于 `%TEMP%/agent-callout-ocr-spike-2f38432b2acb4d679ee2a64454beb0d9/`，保留 `package-lock.json`、`spike.mjs`、网络拦截 wrapper、四次完整原始 JSON、`results.json`、预处理脚本/结果和 `default-network-result.json`。临时 lockfile SHA-256 为 `fabc9e89daced8da6a8ac5c0562c9118d7d082bdfe1addd133bc3fa5b545ee0a`。它们未加入主仓库或发布包，临时目录清理后应重新生成实验材料。

安装命令实际在该空临时目录运行：

```powershell
npm install --save-exact --ignore-scripts --no-audit --no-fund tesseract.js@7.0.0 '@tesseract.js-data/eng@1.0.0' '@tesseract.js-data/chi_sim@1.0.0'
```

这里的证据支持“本地可选 OCR 方案可继续实施”，不支持“v0.3.0 已完成”或“保存按钮在任意截图中都能自动定位”。下一步可开始接口与模型管理实现，无需继续无边界选型。

## 8. 实现阶段补充实验

主线程按生产图片准备流程先合成白色背景，再对全图做反色 1×、反色 2×、灰度反色 2×，没有使用任何目标坐标。这三种方案均仍未识别保存按钮，Normal 和校验失败仍能命中，分数分别为 96 和 92，因此不把全图反色当成可靠的自动兜底。

对示例已确认的内部区域 `{x:602,y:561,width:87,height:25}`，白底合成、4×、反色后，默认 SPARSE_TEXT 模式识别出 `保存`、`Save`、完整 `保存 Save`，三者置信度均为 96；SINGLE_LINE 得到相同几何，分数 94/95。生产默认 sparse 模式足以支持这一显式 ROI 流程，无须增加一个未经必要性验证的分段模式参数。

补充实验最初直接对带 alpha 的全图调用反色，得到全空结果；更正为与生产流程一致的先白底合成后，才得到上述有效结果。未把这次错误预处理当成 OCR 准确性的证据。代码与结果留在本地 `.agent-callout/full-preprocess-spike.mjs`、`full-preprocess-opaque-results.json` 和 `ocr-roi-validation.mjs`，没有上传业务截图。
