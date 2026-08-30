# ADR-0001：核心运行时与渲染器

- 状态：已接受；Windows 产品化验证完成，干净安装与跨平台待完成
- 日期：2026-08-30
- 关联：[决策索引](../decisions.md)、[调研第 5、7 节](../research.md#5-渲染与分发相邻方案比较)

## 背景

内核必须在 Windows 优先的前提下读取 PNG/JPEG/WebP，稳定绘制中英文、几何、blur 与不可恢复 redact，并同时服务 CLI 和本地 stdio MCP。GitHub 直装还要求尽量减少用户另装 Python、Cairo、ImageMagick 或浏览器的步骤。

## 备选方案与评分

评分为 1（差）到 5（优），只用于本项目选型，不是通用性能基准。权重：Windows/安装 25%、中英文排版 20%、格式和效果 15%、单一技术栈 20%、维护性 10%、跨平台 10%。

| 方案                      | Win/安装 | 文字 | 效果 | 单栈 | 维护 | 跨平台 | 加权分 |
| ------------------------- | -------: | ---: | ---: | ---: | ---: | -----: | -----: |
| Sharp + SVG / text sprite |        5 |    5 |    5 |    5 |    4 |      5 | **98** |
| Pillow                    |        4 |    5 |    5 |    2 |    4 |      5 |     81 |
| node-canvas               |        3 |    5 |    2 |    2 |    3 |      4 |     63 |
| ImageMagick CLI           |        3 |    3 |    5 |    2 |    2 |      4 |     62 |

Pillow 本身可靠，但会引入第二套运行时和打包链；node-canvas 的 Cairo/Pango 源码回退及与 Sharp 同进程的 Windows 动态库风险不值得承担；ImageMagick 的外部二进制、字体配置和 shell 参数面扩大安装与安全成本。

## 决定

1. 项目使用 **TypeScript**，最低运行时为 **Node.js 20.10**。Sharp 元数据声明 20.9，但 20.9 实测无法解析其 JSON import attributes；20.10 doctor 与 20.19 全 gate 通过。
2. 建立不依赖 CLI 参数解析或 MCP transport 的 core；CLI 与 stdio MCP 只做输入适配、结果编码和错误边界，调用同一验证、布局、渲染及 manifest 逻辑。
3. 使用 **Sharp** 完成解码、EXIF orientation 归一化、区域提取/blur、合成、固定参数 PNG 输出和重新解码。
4. 矩形、椭圆、箭头、编号底形、highlight 与 spotlight 使用由程序生成的受控 SVG；不接受用户提供的原始 SVG。
5. 用户文字先 XML/Pango 转义，再由 Sharp 以显式 `fontfile` 生成透明 text sprite。SVG 内嵌字体不作为文字路径。
6. 仓库捆绑 **Noto Sans CJK SC Regular**，保留 SIL OFL 1.1 许可和 NOTICE；sidecar 记录 renderer、Sharp/libvips、字体版本与字体 SHA-256。
7. 同平台确定性使用固定版本、固定 PNG 编码、无时间戳/随机 UUID 的 canonical spec 和重复输出 hash 验证；跨平台只承诺语义一致与有界像素差异，不承诺逐字节一致。

## 后果

收益：core、CLI、MCP、doctor 和安装器共享一个依赖树；Sharp 在 Windows x64/ARM64 有预构建包；文字不依赖系统字体；几何 SVG 易于生成和测试，同时保留 Sharp 的像素处理能力。

成本与风险：字体约 15.7 MB；Sharp 的平台可选依赖会增加首次安装和 lockfile 验证工作；Pango/libvips 或字体升级可能改变 glyph metrics 和 golden；文字与几何分两类 sprite，需要统一坐标和合成顺序。

## 验证状态

- 已完成：Windows 11、Node.js 24.18.1、Sharp 0.35.4/libvips 8.18.6 最小实验；三种输入、中文/英文、箭头、highlight、blur、opaque redact 与 PNG 重解码通过。
- 尚未完成：实验当时使用系统字体；仓库捆绑字体加载、字体 hash、同平台重复 hash、干净 Windows 安装及 macOS/Linux CI 均须由产品代码验证。

## 证据

- [研究中的方案比较和实验结果](../research.md#5-渲染与分发相邻方案比较)
- [Sharp 安装与 Node.js 版本要求](https://sharp.pixelplumbing.com/install/)
- [Sharp composite 与指定字体文字](https://sharp.pixelplumbing.com/api-composite/)
- [Sharp blur](https://sharp.pixelplumbing.com/api-operation/)
- [Noto CJK SC 字体](https://github.com/notofonts/noto-cjk/blob/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf)与 [SIL OFL 1.1](https://github.com/googlefonts/noto-cjk/blob/main/Sans/LICENSE)
