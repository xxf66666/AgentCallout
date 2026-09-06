import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions } from "sharp";

import { inspectImage, validateSpecForImage } from "../src/core/index.js";
import { resolveBundledFontPath, STABLE_PNG_OPTIONS } from "../src/renderer/index.js";
import { parseAnnotationSpec, resolveAnnotationSpec } from "../src/spec/index.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TargetDefinition {
  id: string;
  meaning: string;
  visibleContent: string;
  rect: Rect;
  note: string;
  type: "callout" | "numbered-callout";
}

interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  color?: string;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canvas = { width: 1280, height: 800 };

// Every target below names a control or text region drawn in createInputImage.
// The screenshot is entirely synthetic and contains no user or customer data.
const targets: readonly TargetDefinition[] = [
  {
    id: "navigation-menu",
    meaning: "左上角的导航菜单按钮，距画布上边和左边各 8px",
    visibleContent: "Three-line menu icon",
    rect: { x: 8, y: 8, width: 24, height: 24 },
    note: "导航入口 / Menu",
    type: "callout"
  },
  {
    id: "corner-help",
    meaning: "右上角的帮助按钮，距画布上边和右边各 8px",
    visibleContent: "?",
    rect: { x: 1248, y: 8, width: 24, height: 24 },
    note: "帮助按钮 / Help",
    type: "numbered-callout"
  },
  {
    id: "order-heading",
    meaning: "中央卡片中的工程订单标题",
    visibleContent: "工程订单 DEMO-042",
    rect: { x: 430, y: 245, width: 280, height: 32 },
    note: "核对订单标题",
    type: "callout"
  },
  {
    id: "owner-field",
    meaning: "负责人选择框",
    visibleContent: "Demo operator",
    rect: { x: 430, y: 350, width: 180, height: 32 },
    note: "确认负责人 / Owner",
    type: "numbered-callout"
  },
  {
    id: "priority-field",
    meaning: "优先级选择框",
    visibleContent: "Normal",
    rect: { x: 642, y: 350, width: 180, height: 32 },
    note: "优先级选择",
    type: "callout"
  },
  {
    id: "attachment-checkbox",
    meaning: "附带文件的 14px 未选中复选框，目标仅为方框本身",
    visibleContent: "Empty checkbox beside 附带文件",
    rect: { x: 436, y: 409, width: 14, height: 14 },
    note: "附带文件（14px）",
    type: "numbered-callout"
  },
  {
    id: "notification-checkbox",
    meaning: "通知复核人的 14px 选中复选框，目标仅为方框本身",
    visibleContent: "Checked checkbox beside Notify reviewer",
    rect: { x: 648, y: 409, width: 14, height: 14 },
    note: "通知复核人",
    type: "callout"
  },
  {
    id: "validation-message",
    meaning: "卡片内的模拟校验错误文字",
    visibleContent: "校验失败：请补齐订单信息",
    rect: { x: 430, y: 472, width: 330, height: 28 },
    note: "错误说明保持可见",
    type: "numbered-callout"
  },
  {
    id: "save-action",
    meaning: "卡片底部的蓝色保存按钮",
    visibleContent: "保存 Save",
    rect: { x: 598, y: 555, width: 96, height: 36 },
    note: "保存前复核 / Save",
    type: "callout"
  },
  {
    id: "retry-action",
    meaning: "保存按钮右侧的重试按钮",
    visibleContent: "Retry",
    rect: { x: 710, y: 555, width: 96, height: 36 },
    note: "失败后重试 / Retry",
    type: "numbered-callout"
  }
];

function parseOutputDirectory(args: string[]): string | undefined {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(
      "Usage: npx tsx scripts/prepare-dense-acceptance.ts [--output-dir <new-directory>]\n" +
        "Default: .agent-callout/dense-acceptance/ beneath the repository root.\n" +
        "The output directory must not already exist. No client is invoked.\n"
    );
    return undefined;
  }
  if (args.length === 0) return path.join(repositoryRoot, ".agent-callout", "dense-acceptance");
  if (args.length === 2 && args[0] === "--output-dir" && args[1]?.trim()) {
    return path.resolve(args[1]);
  }
  throw new Error("Expected no arguments or --output-dir <new-directory>. Use --help for usage.");
}

function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rectangle(rect: Rect, fill: string, stroke = "none", radius = 0): string {
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function targetRect(id: string): Rect {
  const target = targets.find((candidate) => candidate.id === id);
  if (target === undefined) throw new Error(`Unknown screenshot target ${id}.`);
  return target.rect;
}

async function textOverlay(item: TextItem, fontPath: string): Promise<OverlayOptions> {
  const rendered = await sharp({
    text: {
      text: `<span foreground="${item.color ?? "#334155"}">${escapeMarkup(item.text)}</span>`,
      font: `Noto Sans CJK SC ${item.size}`,
      fontfile: fontPath,
      width: item.width,
      rgba: true,
      wrap: "word-char"
    }
  })
    .png(STABLE_PNG_OPTIONS)
    .toBuffer({ resolveWithObject: true });
  if (
    item.x + rendered.info.width > canvas.width ||
    item.y + rendered.info.height > canvas.height
  ) {
    throw new Error(`Synthetic text exceeds the canvas: ${item.text}`);
  }
  return { input: rendered.data, left: item.x, top: item.y };
}

async function createInputImage(): Promise<Buffer> {
  const shapes = [
    rectangle({ x: 0, y: 0, ...canvas }, "#F1F5F9"),
    rectangle({ x: 0, y: 0, width: canvas.width, height: 48 }, "#FFFFFF"),
    '<path d="M 0 48 H 1280" stroke="#CBD5E1"/>',
    rectangle(targetRect("navigation-menu"), "#F8FAFC", "#CBD5E1", 4),
    '<path d="M 14 15 H 26 M 14 20 H 26 M 14 25 H 26" stroke="#334155" stroke-width="2"/>',
    rectangle(targetRect("corner-help"), "#F8FAFC", "#CBD5E1", 4),
    rectangle({ x: 390, y: 200, width: 500, height: 444 }, "#FFFFFF", "#CBD5E1", 12),
    '<path d="M 414 306 H 866" stroke="#E2E8F0"/>',
    rectangle(targetRect("owner-field"), "#F8FAFC", "#94A3B8", 5),
    rectangle(targetRect("priority-field"), "#F8FAFC", "#94A3B8", 5),
    '<path d="M 590 363 L 595 368 L 600 363 M 802 363 L 807 368 L 812 363" fill="none" stroke="#64748B" stroke-width="2"/>',
    rectangle(targetRect("attachment-checkbox"), "#FFFFFF", "#64748B", 2),
    rectangle(targetRect("notification-checkbox"), "#2563EB", "#2563EB", 2),
    '<path d="M 651 416 L 654 419 L 659 412" fill="none" stroke="#FFFFFF" stroke-width="2"/>',
    rectangle({ x: 420, y: 462, width: 412, height: 48 }, "#FFF1F2", "#FECDD3", 6),
    rectangle(targetRect("save-action"), "#2563EB", "#1D4ED8", 6),
    rectangle(targetRect("retry-action"), "#FFFFFF", "#94A3B8", 6)
  ];
  const text: TextItem[] = [
    { text: "Workshop / 生产工作台", x: 50, y: 10, width: 540, size: 20 },
    { text: "?", x: 1255, y: 10, width: 12, size: 18 },
    { text: "工程订单复核", x: 390, y: 118, width: 500, size: 28, color: "#0F172A" },
    { text: "Synthetic UI · all values are demo data", x: 390, y: 163, width: 500, size: 15 },
    { text: "工程订单 DEMO-042", x: 430, y: 245, width: 280, size: 23, color: "#0F172A" },
    { text: "负责人 / Owner", x: 430, y: 323, width: 180, size: 15 },
    { text: "优先级 / Priority", x: 642, y: 323, width: 180, size: 15 },
    { text: "Demo operator", x: 440, y: 357, width: 145, size: 16 },
    { text: "Normal", x: 652, y: 357, width: 140, size: 16 },
    { text: "附带文件", x: 460, y: 406, width: 150, size: 16 },
    { text: "Notify reviewer", x: 672, y: 406, width: 155, size: 16 },
    { text: "校验失败：请补齐订单信息", x: 430, y: 476, width: 330, size: 18, color: "#BE123C" },
    { text: "保存 Save", x: 608, y: 565, width: 82, size: 16, color: "#FFFFFF" },
    { text: "Retry", x: 738, y: 565, width: 64, size: 16 },
    { text: "Local demo / 无真实订单数据", x: 28, y: 763, width: 500, size: 14, color: "#64748B" }
  ];
  const fontPath = await resolveBundledFontPath();
  const overlays = await Promise.all(text.map((item) => textOverlay(item, fontPath)));
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${shapes.join("")}</svg>`
    )
  )
    .composite(overlays)
    .png(STABLE_PNG_OPTIONS)
    .toBuffer();
}

function createSpec() {
  return parseAnnotationSpec({
    version: "1.1",
    coordinateSpace: "pixel",
    preset: "docs-light",
    defaults: { fontSize: 16, maxWidth: 176, padding: 7, strokeWidth: 2 },
    annotations: targets.map((target, index) => ({
      id: target.id,
      type: target.type,
      target: target.rect,
      text: target.note,
      placement: "auto",
      tone: target.id === "validation-message" ? "warning" : "info",
      ...(target.type === "numbered-callout" ? { number: index + 1 } : {})
    }))
  });
}

function clientPrompt(client: "claude" | "codex", directory: string): string {
  const clientName = client === "claude" ? "Claude Code" : "Codex";
  const clientDirectory = path.join(directory, client);
  const revision = {
    op: "set",
    id: "save-action",
    annotation: {
      id: "save-action",
      type: "callout",
      target: targetRect("save-action"),
      text: "确认无误后保存 / Save",
      placement: "auto",
      tone: "info"
    }
  };
  return `# ${clientName} 密集批注独立视觉验收输入

这是 AgentCallout v0.2.1 的实际客户端验收。输入由本地脚本绘制，是可再分发的模拟界面；没有真实订单、个人数据或既定通过结论。不要使用 BMAD。独立完成本次验收，不读取另一个客户端的产物或结论。

输入截图：${JSON.stringify(path.join(directory, "input.png"))}
统一初始 spec：${JSON.stringify(path.join(directory, "spec.json"))}
目标说明：${JSON.stringify(path.join(directory, "inputs.json"))}
本客户端首次输出：${JSON.stringify(path.join(clientDirectory, "annotated.png"))}
本客户端报告目录：${JSON.stringify(clientDirectory)}

1. 发现实际可用的 AgentCallout MCP 工具，调用 doctor 并记录实际 renderer、Sharp、字体版本。若工具不可调用，记录错误与未验证状态，不把 CLI 替代执行写成 MCP 通过，也不升级或修改安装配置。
2. 调用 inspect_image 检查输入，然后实际查看原图。读取统一 spec 和目标说明，确认 10 个 target 对应截图中的控件或文字。初次 annotate_image 必须使用这份 spec 原样内容，输出到本客户端路径；不要改变输入或覆盖已有输出。可以调用 validate_annotation_spec。
3. 实际查看 annotate_image 的 ImageContent，并检查 10 个说明框的文字、编号、目标可见性、引线、边角菜单/帮助按钮与两个 14px 复选框。图像的缩略预览可能不足以判断小字；只有需要时再打开保存的完整 PNG 或 crop_image。记录究竟查看了 ImageContent、完整图还是 crop。路径、sidecar、几何或 warning 为空都不能代替视觉判断。
4. 无论初图是否需要修正，至少调用一次 revise_annotation，parent 使用首次结果的 sidecarPath，edits 使用以下同一条完整 set：

\`\`\`json
${JSON.stringify([revision], null, 2)}
\`\`\`

5. 实际查看 revision 返回图，确认保存说明已改成新文字，并评估其连带布局变化。changed-region 只证明局部；已有局部图足够时无需重复 crop。需要全局结论时查看保存的完整输出。若仍有问题，可继续用稳定 ID edits 修正，并分别保留首次结果、统一修订和后续修订的判断；不要更改渲染器或删掉失败批注来取得通过。
6. 每轮记录 MCP 是否真的返回 ImageContent、是否实际可见、原始 warnings、preview.mode、sourceRect、七项 pixelMetrics、额外 crop 次数和真实视觉问题。无 ImageContent、客户端无法看图或编码失败都要明确说明；不要估算 token 或费用，也不要将几何测试结果写成客户端视觉验收通过。
7. 在本客户端目录写 report.md 和 report.json，包含实际客户端/模型（可知时）、doctor 结果、工具调用次数、每轮路径与上述记录、逐项目标的可见性、未验证内容。最终回答提供产物路径和观察到的结果。不要读取或引用另一客户端的报告。

本输入包只准备了材料。它没有执行 MCP，没有生成批注结果，也没有认定任何客户端通过。
`;
}

async function main(): Promise<void> {
  const outputDirectory = parseOutputDirectory(process.argv.slice(2));
  if (outputDirectory === undefined) return;
  const spec = createSpec();
  resolveAnnotationSpec(spec, canvas);
  const input = await createInputImage();
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  // Refuse even a pre-existing empty directory, so a rerun cannot mix acceptance runs.
  await mkdir(outputDirectory);
  await mkdir(path.join(outputDirectory, "claude"));
  await mkdir(path.join(outputDirectory, "codex"));
  const inputPath = path.join(outputDirectory, "input.png");
  await writeFile(inputPath, input, { flag: "wx" });
  await writeFile(path.join(outputDirectory, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`, {
    flag: "wx"
  });
  await writeFile(
    path.join(outputDirectory, "inputs.json"),
    `${JSON.stringify(
      {
        scenario: "dense-mixed-controls-v1",
        provenance: "Procedurally generated fictional UI; no third-party screenshot or real data.",
        redistribution:
          "Synthetic UI is provided under the repository MIT license; font attribution is in NOTICE.",
        input: "input.png",
        spec: "spec.json",
        dimensions: canvas,
        coordinateSpace: "pixel",
        targets: targets.map(({ id, meaning, visibleContent, rect, type }) => ({
          id,
          meaning,
          visibleContent,
          rect,
          annotationType: type
        })),
        status: "Inputs prepared only; no client invocation or visual acceptance performed."
      },
      null,
      2
    )}\n`,
    { flag: "wx" }
  );
  for (const client of ["claude", "codex"] as const) {
    await writeFile(
      path.join(outputDirectory, client, "prompt.md"),
      clientPrompt(client, outputDirectory),
      {
        flag: "wx"
      }
    );
  }
  const image = await inspectImage(inputPath, { allowedRoots: [outputDirectory] });
  const validation = await validateSpecForImage({
    inputPath,
    spec,
    allowedRoots: [outputDirectory]
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "prepared",
        outputDirectory,
        input: {
          path: inputPath,
          format: image.format,
          dimensions: image.dimensions,
          sha256: image.sha256
        },
        specValid: validation.valid,
        annotations: validation.annotationCount,
        coordinateWarnings: validation.warnings,
        clientInvocations: 0,
        visualAcceptance: "not performed"
      },
      null,
      2
    )}\n`
  );
}

await main();
