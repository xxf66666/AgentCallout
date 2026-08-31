import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions } from "sharp";

import { annotateImage, createContactSheet } from "../src/core/index.js";
import { circleOverlapsTarget } from "../src/layout/index.js";
import {
  BUNDLED_FONT_SHA256,
  STABLE_PNG_OPTIONS,
  resolveBundledFontPath
} from "../src/renderer/index.js";
import { parseAnnotationSpec } from "../src/spec/index.js";

interface TextItem {
  text: string;
  left: number;
  top: number;
  width: number;
  fontSize?: number;
  color?: string;
}

interface ExampleDefinition {
  slug: "ui-bug" | "numbered-review" | "privacy";
  title: string;
  description: string;
  width: number;
  height: number;
  svgBody: string;
  text: TextItem[];
  spec: unknown;
}

interface ResolvedNumberedExample {
  id: string;
  type: "numbered-callout";
  target: { x: number; y: number; width?: number; height?: number };
  marker: {
    center: { x: number; y: number };
    radius: number;
    paintedRadius: number;
    bounds: { x: number; y: number; width: number; height: number };
  };
  label: {
    box: { x: number; y: number; width: number; height: number };
    paintedBounds: { x: number; y: number; width: number; height: number };
  };
  leader: {
    start: { x: number; y: number };
    end: { x: number; y: number };
    length: number;
    bounds: { x: number; y: number; width: number; height: number };
  };
}

const UNAFFECTED_BASELINE_HASHES = {
  "ui-bug": {
    output: "bb3d3b9faf8c249b3fefafb44b74c8a579c13868a2a191d544cf0511c5a46bf6",
    sidecar: "c5ac3712fbf7a2d635279313f553a9848b6aa37cb8295425d12bc57504216d0a"
  },
  privacy: {
    output: "c3e52a99d622a3c5cad5eda7c7a0e86bcca0d5e5a543e29f3961476032c727b6",
    sidecar: "a9f8a532734fd01ac6ad827c5cf5207076381dda6ec543fd1846bb936cdfe3f2"
  }
} as const;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const examplesRoot = path.join(repositoryRoot, "examples");
const fontPath = await resolveBundledFontPath();

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function textOverlay(item: TextItem): Promise<OverlayOptions> {
  const fontSize = item.fontSize ?? 22;
  const buffer = await sharp({
    text: {
      text: `<span foreground="${item.color ?? "#263238"}">${escapeMarkup(item.text)}</span>`,
      font: `Noto Sans CJK SC ${fontSize}`,
      fontfile: fontPath,
      width: item.width,
      rgba: true,
      wrap: "word-char"
    }
  })
    .png(STABLE_PNG_OPTIONS)
    .toBuffer();
  return { input: buffer, left: item.left, top: item.top };
}

async function createSyntheticScreenshot(definition: ExampleDefinition, inputPath: string) {
  const geometry = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${definition.width}" height="${definition.height}" viewBox="0 0 ${definition.width} ${definition.height}">${definition.svgBody}</svg>`
  );
  const overlays = await Promise.all(definition.text.map(textOverlay));
  const image = await sharp(geometry).composite(overlays).png(STABLE_PNG_OPTIONS).toBuffer();
  await writeFile(inputPath, image);
}

function exampleReadme(definition: ExampleDefinition): string {
  const base = `examples/${definition.slug}`;
  return `# ${definition.title}

${definition.description}

## Generate

\`\`\`powershell
node dist/cli.js annotate ${base}/input.png --spec ${base}/annotations.json --output ${base}/output.png --allow-root . --overwrite
\`\`\`

## Files

- Original: [input.png](input.png)
- AnnotationSpec: [annotations.json](annotations.json)
- Generated PNG: [output.png](output.png)
- Replay sidecar: [output.json](output.json)

![${definition.title}](output.png)
`;
}

const definitions: ExampleDefinition[] = [
  {
    slug: "ui-bug",
    title: "UI bug annotation",
    description:
      "A synthetic release-settings screen using AnnotationSpec 1.1 danger tone only for a real validation failure.",
    width: 1000,
    height: 640,
    svgBody: `
      <rect width="1000" height="640" fill="#EEF2F7"/>
      <rect x="55" y="42" width="890" height="555" rx="22" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="2"/>
      <rect x="55" y="42" width="890" height="72" rx="22" fill="#16324F"/>
      <rect x="120" y="166" width="630" height="64" rx="10" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="2"/>
      <rect x="120" y="268" width="630" height="64" rx="10" fill="#FFF5F5" stroke="#FCA5A5" stroke-width="2"/>
      <rect x="120" y="387" width="630" height="64" rx="10" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="2"/>
      <rect x="775" y="498" width="135" height="58" rx="11" fill="#2563EB"/>
      <circle cx="91" cy="78" r="10" fill="#EF4444"/>
      <circle cx="121" cy="78" r="10" fill="#F59E0B"/>
      <circle cx="151" cy="78" r="10" fill="#10B981"/>
    `,
    text: [
      {
        text: "发布设置 / Release settings",
        left: 190,
        top: 62,
        width: 500,
        fontSize: 27,
        color: "#FFFFFF"
      },
      { text: "版本名称", left: 120, top: 136, width: 200, fontSize: 18, color: "#475569" },
      { text: "AgentCallout 0.1", left: 142, top: 184, width: 520, fontSize: 22 },
      { text: "回调地址", left: 120, top: 238, width: 200, fontSize: 18, color: "#475569" },
      { text: "https://example.test/hooks", left: 142, top: 286, width: 520, fontSize: 21 },
      {
        text: "格式无效，请检查路径",
        left: 120,
        top: 339,
        width: 400,
        fontSize: 17,
        color: "#DC2626"
      },
      { text: "发布说明", left: 120, top: 357, width: 200, fontSize: 18, color: "#475569" },
      { text: "修复截图批注的自动布局", left: 142, top: 404, width: 520, fontSize: 21 },
      { text: "保存", left: 815, top: 514, width: 80, fontSize: 23, color: "#FFFFFF" }
    ],
    spec: {
      version: "1.1",
      preset: "docs-light",
      defaults: { fontSize: 25, padding: 14, maxWidth: 280 },
      annotations: [
        {
          id: "invalid-field",
          type: "rectangle",
          rect: { x: 110, y: 258, width: 650, height: 84 },
          tone: "danger",
          style: { strokeWidth: 6, cornerRadius: 12 }
        },
        {
          id: "save-arrow",
          type: "arrow",
          start: { x: 605, y: 472 },
          target: { x: 790, y: 506 },
          tone: "danger",
          style: { strokeWidth: 7, arrowHeadSize: 22 }
        },
        {
          id: "save-note",
          type: "callout",
          target: { x: 790, y: 548 },
          text: "点击后没有响应",
          placement: "left",
          tone: "danger"
        }
      ]
    }
  },
  {
    slug: "numbered-review",
    title: "Numbered review",
    description:
      "A synthetic operations dashboard showing visible boundary-to-boundary numbered leaders without covering reviewed targets.",
    width: 1100,
    height: 700,
    svgBody: `
      <rect width="1100" height="700" fill="#F1F5F9"/>
      <rect x="38" y="30" width="1024" height="640" rx="20" fill="#FFFFFF" stroke="#D5DDE8" stroke-width="2"/>
      <rect x="38" y="30" width="210" height="640" rx="20" fill="#172554"/>
      <rect x="82" y="118" width="120" height="18" rx="9" fill="#60A5FA"/>
      <rect x="82" y="164" width="96" height="15" rx="7" fill="#64748B"/>
      <rect x="82" y="205" width="108" height="15" rx="7" fill="#64748B"/>
      <rect x="290" y="122" width="325" height="190" rx="16" fill="#EFF6FF" stroke="#BFDBFE" stroke-width="2"/>
      <rect x="655" y="122" width="350" height="190" rx="16" fill="#FFF7ED" stroke="#FED7AA" stroke-width="2"/>
      <rect x="290" y="350" width="715" height="250" rx="16" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="2"/>
      <path d="M330 535 L420 485 L510 515 L600 435 L690 472 L780 405 L915 445" fill="none" stroke="#2563EB" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="330" y="175" width="220" height="22" rx="11" fill="#93C5FD"/>
      <rect x="330" y="220" width="150" height="52" rx="12" fill="#DBEAFE"/>
      <rect x="700" y="180" width="250" height="18" rx="9" fill="#FDBA74"/>
      <rect x="700" y="220" width="210" height="18" rx="9" fill="#FED7AA"/>
      <circle cx="915" cy="445" r="10" fill="#1D4ED8"/>
    `,
    text: [
      {
        text: "质量评审 / Quality review",
        left: 290,
        top: 55,
        width: 620,
        fontSize: 30,
        color: "#0F172A"
      },
      { text: "Overview", left: 82, top: 76, width: 130, fontSize: 20, color: "#FFFFFF" },
      { text: "一次通过率", left: 330, top: 145, width: 220, fontSize: 20, color: "#1E3A8A" },
      { text: "92.4%", left: 350, top: 231, width: 140, fontSize: 34, color: "#1D4ED8" },
      { text: "待处理告警", left: 700, top: 145, width: 220, fontSize: 20, color: "#9A3412" },
      { text: "趋势 / Trend", left: 330, top: 374, width: 220, fontSize: 20, color: "#334155" }
    ],
    spec: {
      version: "1.1",
      preset: "docs-light",
      defaults: { fontSize: 22, maxWidth: 290 },
      annotations: [
        {
          id: "review-1",
          type: "numbered-callout",
          target: { x: 580, y: 245 },
          number: 1,
          text: "一次通过率低于目标",
          placement: "bottom",
          tone: "neutral"
        },
        {
          id: "review-2",
          type: "numbered-callout",
          target: { x: 970, y: 270 },
          number: 2,
          text: "告警缺少责任人",
          placement: "bottom",
          tone: "warning"
        },
        {
          id: "review-3",
          type: "numbered-callout",
          target: { x: 960, y: 550 },
          number: 3,
          text: "趋势峰值需要说明",
          placement: "top",
          tone: "info"
        }
      ]
    }
  },
  {
    slug: "privacy",
    title: "Privacy-safe output",
    description:
      "A synthetic account screen using an ordinary info note for blur and danger only for irreversible token redaction.",
    width: 1000,
    height: 600,
    svgBody: `
      <rect width="1000" height="600" fill="#ECFDF5"/>
      <rect x="90" y="55" width="820" height="490" rx="24" fill="#FFFFFF" stroke="#A7F3D0" stroke-width="2"/>
      <circle cx="165" cy="142" r="42" fill="#0F766E"/>
      <rect x="250" y="112" width="470" height="32" rx="9" fill="#D1FAE5"/>
      <rect x="250" y="158" width="330" height="20" rx="10" fill="#E2E8F0"/>
      <rect x="235" y="243" width="570" height="58" rx="12" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="2"/>
      <rect x="235" y="363" width="570" height="62" rx="12" fill="#FFF7ED" stroke="#FDBA74" stroke-width="2"/>
      <rect x="235" y="469" width="180" height="46" rx="10" fill="#0F766E"/>
    `,
    text: [
      { text: "AC", left: 139, top: 124, width: 60, fontSize: 29, color: "#FFFFFF" },
      {
        text: "测试账号 / Demo account",
        left: 270,
        top: 114,
        width: 430,
        fontSize: 26,
        color: "#065F46"
      },
      {
        text: "仅用于可再分发的演示数据",
        left: 270,
        top: 158,
        width: 430,
        fontSize: 17,
        color: "#64748B"
      },
      { text: "邮箱 Email", left: 235, top: 211, width: 200, fontSize: 18, color: "#475569" },
      { text: "alex.chen@example.test", left: 263, top: 258, width: 480, fontSize: 22 },
      {
        text: "访问令牌 Access token",
        left: 235,
        top: 331,
        width: 280,
        fontSize: 18,
        color: "#9A3412"
      },
      {
        text: "tok_demo_NOT_REAL_7F3A91C2",
        left: 263,
        top: 379,
        width: 500,
        fontSize: 22,
        color: "#7C2D12"
      },
      { text: "保存更改", left: 270, top: 480, width: 120, fontSize: 20, color: "#FFFFFF" }
    ],
    spec: {
      version: "1.1",
      preset: "docs-light",
      defaults: { fontSize: 20, maxWidth: 260 },
      annotations: [
        {
          id: "email-note",
          type: "callout",
          target: { x: 255, y: 250, width: 500, height: 44 },
          text: "普通隐私：视觉弱化",
          placement: "right",
          tone: "info"
        },
        {
          id: "token-note",
          type: "callout",
          target: { x: 255, y: 372, width: 515, height: 46 },
          text: "Token：不可恢复遮挡",
          placement: "top",
          tone: "danger"
        },
        {
          id: "email-blur",
          type: "blur",
          rect: { x: 255, y: 250, width: 500, height: 44 },
          sigma: 12
        },
        {
          id: "token-redact",
          type: "redact",
          rect: { x: 255, y: 372, width: 515, height: 46 },
          color: "#111827"
        }
      ]
    }
  }
];

await mkdir(examplesRoot, { recursive: true });
const summaries = [];

for (const definition of definitions) {
  const directory = path.join(examplesRoot, definition.slug);
  const inputPath = path.join(directory, "input.png");
  const specPath = path.join(directory, "annotations.json");
  const outputPath = path.join(directory, "output.png");
  await mkdir(directory, { recursive: true });
  await createSyntheticScreenshot(definition, inputPath);
  const parsedSpec = parseAnnotationSpec(definition.spec);
  await writeFile(specPath, `${JSON.stringify(parsedSpec, null, 2)}\n`, "utf8");

  const first = await annotateImage({
    inputPath,
    outputPath,
    spec: parsedSpec,
    overwrite: true,
    allowedRoots: [examplesRoot]
  });
  const firstSidecar = await readFile(first.sidecarPath);
  const second = await annotateImage({
    inputPath,
    outputPath,
    spec: parsedSpec,
    overwrite: true,
    allowedRoots: [examplesRoot]
  });
  const secondSidecar = await readFile(second.sidecarPath);
  if (first.outputSha256 !== second.outputSha256 || !firstSidecar.equals(secondSidecar)) {
    throw new Error(`${definition.slug} is not deterministic on this platform.`);
  }
  if (second.warnings.length > 0) {
    throw new Error(`${definition.slug} emitted warnings: ${second.warnings.join(" | ")}`);
  }

  const sidecarSha256 = createHash("sha256").update(secondSidecar).digest("hex");
  const isVerifiedWindowsBaseline =
    process.platform === "win32" &&
    second.renderer.name === "sharp-svg-pango" &&
    second.renderer.version === "0.1.3" &&
    second.renderer.sharp === "0.35.4" &&
    second.renderer.libvips === "8.18.6" &&
    second.renderer.font.sha256 === BUNDLED_FONT_SHA256;
  if (
    isVerifiedWindowsBaseline &&
    (definition.slug === "ui-bug" || definition.slug === "privacy")
  ) {
    const baseline = UNAFFECTED_BASELINE_HASHES[definition.slug];
    if (second.outputSha256 !== baseline.output || sidecarSha256 !== baseline.sidecar) {
      throw new Error(
        `${definition.slug} changed outside the numbered-callout scope: PNG ${second.outputSha256}, sidecar ${sidecarSha256}.`
      );
    }
  }

  if (definition.slug === "numbered-review") {
    const sidecar = JSON.parse(secondSidecar.toString("utf8")) as {
      outputDimensions: { width: number; height: number };
      resolvedAnnotations: ResolvedNumberedExample[];
    };
    for (const annotation of sidecar.resolvedAnnotations) {
      if (annotation.type !== "numbered-callout") continue;
      if (annotation.leader.length < 24) {
        throw new Error(
          `${annotation.id} has only ${annotation.leader.length}px of visible numbered leader.`
        );
      }
      if (
        circleOverlapsTarget(
          { center: annotation.marker.center, radius: annotation.marker.paintedRadius },
          annotation.target
        )
      ) {
        throw new Error(`${annotation.id} marker overlaps its reviewed target.`);
      }
      if (
        circleOverlapsTarget(
          { center: annotation.marker.center, radius: annotation.marker.paintedRadius },
          annotation.label.paintedBounds
        )
      ) {
        throw new Error(`${annotation.id} painted marker overlaps its painted label.`);
      }
      const { bounds } = annotation.marker;
      const box = annotation.label.paintedBounds;
      const leaderBounds = annotation.leader.bounds;
      if (
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > sidecar.outputDimensions.width ||
        bounds.y + bounds.height > sidecar.outputDimensions.height ||
        box.x < 0 ||
        box.y < 0 ||
        box.x + box.width > sidecar.outputDimensions.width ||
        box.y + box.height > sidecar.outputDimensions.height ||
        leaderBounds.x < 0 ||
        leaderBounds.y < 0 ||
        leaderBounds.x + leaderBounds.width > sidecar.outputDimensions.width ||
        leaderBounds.y + leaderBounds.height > sidecar.outputDimensions.height
      ) {
        throw new Error(
          `${annotation.id} marker, label, or leader escaped the numbered-review canvas.`
        );
      }
    }
  }

  if (definition.slug === "privacy") {
    const redact = { x: 255, y: 372, width: 515, height: 46 };
    const raw = await sharp(second.outputPath).removeAlpha().raw().toBuffer({
      resolveWithObject: true
    });
    const values = new Set<string>();
    for (let y = redact.y; y < redact.y + redact.height; y += 1) {
      for (let x = redact.x; x < redact.x + redact.width; x += 1) {
        const offset = (y * raw.info.width + x) * raw.info.channels;
        values.add(`${raw.data[offset]},${raw.data[offset + 1]},${raw.data[offset + 2]}`);
      }
    }
    if (values.size !== 1 || !values.has("17,24,39")) {
      throw new Error(
        `Privacy redact pixels are not one opaque replacement color: ${[...values].join(", ")}`
      );
    }
  }

  await writeFile(path.join(directory, "README.md"), exampleReadme(definition), "utf8");
  summaries.push({
    example: definition.slug,
    annotations: parsedSpec.annotations.length,
    outputSha256: second.outputSha256,
    sidecarSha256,
    warnings: second.warnings
  });
}

await createContactSheet({
  inputPaths: definitions.map((definition) =>
    path.join(examplesRoot, definition.slug, "output.png")
  ),
  outputPath: path.join(examplesRoot, "contact-sheet.png"),
  columns: 3,
  cellWidth: 420,
  cellHeight: 300,
  padding: 10,
  labels: false,
  overwrite: true,
  allowedRoots: [examplesRoot]
});

await writeFile(
  path.join(examplesRoot, "README.md"),
  `# AgentCallout examples

All screenshots are synthetic and generated locally by \`npm run examples\`. The public examples use AnnotationSpec 1.1 readable defaults; the automated test suite retains a fixed 1.0 replay golden. Each example includes its original PNG, validated AnnotationSpec, generated PNG, replay sidecar, Markdown preview, and exact CLI command.

- [UI bug](ui-bug/README.md)
- [Numbered review](numbered-review/README.md)
- [Privacy](privacy/README.md)

![All AgentCallout examples](contact-sheet.png)
`,
  "utf8"
);

process.stdout.write(`${JSON.stringify({ examples: summaries }, null, 2)}\n`);
