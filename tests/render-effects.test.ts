import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { annotateImage, validateSpecForImage } from "../src/core/index.js";

async function writePattern(filePath: string, width: number, height: number): Promise<void> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 11 + y * 3) % 251;
      pixels[offset + 1] = (x * 5 + y * 13) % 241;
      pixels[offset + 2] = (x * 7 + y * 17) % 239;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

async function rgbAt(filePath: string, x: number, y: number): Promise<[number, number, number]> {
  const raw = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * raw.info.width + x) * raw.info.channels;
  return [raw.data[offset] ?? -1, raw.data[offset + 1] ?? -1, raw.data[offset + 2] ?? -1];
}

describe("Sharp annotation renderer", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-callout-render-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("renders all ten annotation types with bounded Chinese/English callouts", async () => {
    const inputPath = path.join(temporaryDirectory, "ui source.png");
    const outputPath = path.join(temporaryDirectory, "all types.png");
    await writePattern(inputPath, 640, 420);
    const longText =
      "中文说明与 English explanation wrap together, including a deliberatelyLongTokenWithoutSpaces1234567890 and <literal markup> & symbols.";
    const spec = {
      version: "1.0",
      annotations: [
        {
          id: "spot",
          type: "spotlight",
          rect: { x: 300, y: 210, width: 250, height: 150 }
        },
        {
          id: "rect",
          type: "rectangle",
          rect: { x: 290, y: 200, width: 270, height: 170 },
          style: { strokeWidth: 6, cornerRadius: 18 }
        },
        {
          id: "ellipse",
          type: "ellipse",
          rect: { x: 45, y: 35, width: 120, height: 80 }
        },
        {
          id: "arrow",
          type: "arrow",
          start: { x: 230, y: 110 },
          target: { x: 320, y: 230 },
          style: { arrowHeadSize: 24 }
        },
        {
          id: "text",
          type: "text",
          position: { x: 20, y: 135 },
          text: longText,
          style: { fontSize: 22, lineHeight: 1.4 }
        },
        {
          id: "callout",
          type: "callout",
          target: { x: 350, y: 250, width: 100, height: 45 },
          text: `点击后没有响应。${longText}`,
          placement: "auto"
        },
        {
          id: "numbered",
          type: "numbered-callout",
          target: { x: 520, y: 90 },
          number: 3,
          text: "第三处问题 / issue three",
          placement: "auto"
        },
        {
          id: "highlight",
          type: "highlight",
          rect: { x: 25, y: 335, width: 220, height: 42 },
          style: { strokeWidth: 0 }
        },
        {
          id: "blur",
          type: "blur",
          rect: { x: 40, y: 260, width: 100, height: 45 },
          sigma: 5
        },
        {
          id: "redact",
          type: "redact",
          rect: { x: 160, y: 260, width: 105, height: 45 },
          color: "#101820"
        }
      ]
    };

    const result = await annotateImage({
      inputPath,
      outputPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const decoded = await sharp(result.outputPath).metadata();
    const manifest = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
      annotationSpec: { annotations: { text?: string }[] };
    };

    expect(decoded.format).toBe("png");
    expect(decoded.width).toBe(640);
    expect(decoded.height).toBe(420);
    expect(result.annotationCount).toBe(10);
    expect(result.usesBlur).toBe(true);
    expect(result.usesRedact).toBe(true);
    expect(manifest.resolvedAnnotations.map((item) => item.type)).toEqual(
      spec.annotations.map((item) => item.type)
    );
    expect(manifest.annotationSpec.annotations[4]?.text).toBe(longText);

    for (const annotation of manifest.resolvedAnnotations) {
      const box = annotation.box as
        { x: number; y: number; width: number; height: number } | undefined;
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(640);
        expect(box.y + box.height).toBeLessThanOrEqual(420);
      }
    }
  });

  it("keeps the fixed 1.0 canonical and PNG golden unchanged", async () => {
    const inputPath = path.join(temporaryDirectory, "v1 baseline input.png");
    const outputPath = path.join(temporaryDirectory, "v1 baseline output.png");
    await writePattern(inputPath, 480, 320);
    const spec = {
      version: "1.0",
      annotations: [
        {
          id: "legacy-box",
          type: "rectangle",
          rect: { x: 255, y: 140, width: 145, height: 90 }
        },
        {
          id: "legacy-note",
          type: "numbered-callout",
          target: { x: 280, y: 150, width: 80, height: 60 },
          text: "旧版红色批注 / legacy",
          number: 2,
          placement: "left"
        },
        {
          id: "legacy-text",
          type: "text",
          position: { x: 24, y: 250 },
          text: "重放基线"
        }
      ]
    };
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec
    });
    const replay = await annotateImage({
      inputPath,
      outputPath: path.join(temporaryDirectory, "v1 baseline replay.png"),
      allowedRoots: [temporaryDirectory],
      spec
    });

    expect(result.specSha256).toBe(
      "4ed8780284eb6083556c5bb4a7635f17e21b5d132ae6ffc36f8e4342e4781bd7"
    );
    expect(replay.specSha256).toBe(result.specSha256);
    expect(replay.outputSha256).toBe(result.outputSha256);
    const verifiedWindowsRenderer =
      process.platform === "win32" &&
      result.renderer.name === "sharp-svg-pango" &&
      result.renderer.version === "0.1.2" &&
      result.renderer.sharp === "0.35.4" &&
      result.renderer.libvips === "8.18.6" &&
      result.renderer.font.sha256 ===
        "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
    if (verifiedWindowsRenderer) {
      expect(result.outputSha256).toBe(
        "d7e8bc66e2db71bd948542e1f54bb5ddc2557fbab1cfb76aab4599b1ce9949d2"
      );
    }
    expect(result.warnings).toEqual([]);
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: { style?: Record<string, unknown> }[];
    };
    const legacyStyle = sidecar.resolvedAnnotations[0]?.style ?? {};
    expect(legacyStyle).not.toHaveProperty("markerStrokeColor");
    expect(legacyStyle).not.toHaveProperty("markerFillColor");
    expect(legacyStyle).not.toHaveProperty("markerTextColor");
    expect(sidecar.resolvedAnnotations[1]).not.toHaveProperty("style");
  });

  it("renders a minimal 1.1 numbered callout with a light label and blue border/marker", async () => {
    const inputPath = path.join(temporaryDirectory, "minimal v11 source.png");
    const outputPath = path.join(temporaryDirectory, "minimal v11 output.png");
    await sharp({ create: { width: 640, height: 400, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.1",
        annotations: [
          {
            type: "numbered-callout",
            target: { x: 410, y: 175, width: 110, height: 70 },
            text: "普通说明",
            number: 1,
            placement: "left"
          }
        ]
      }
    });
    const raw = await sharp(result.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: {
        marker: { center: { x: number; y: number }; radius: number };
      }[];
    };
    const marker = sidecar.resolvedAnnotations[0]?.marker;
    expect(marker).toBeDefined();
    if (marker === undefined) throw new Error("Missing resolved marker.");
    const colors = new Map<string, number>();
    let markerBluePixels = 0;
    for (let index = 0; index < raw.data.length; index += raw.info.channels) {
      const color = `${raw.data[index]},${raw.data[index + 1]},${raw.data[index + 2]}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      const pixelIndex = index / raw.info.channels;
      const x = pixelIndex % raw.info.width;
      const y = Math.floor(pixelIndex / raw.info.width);
      if (
        x >= marker.center.x - marker.radius &&
        x < marker.center.x + marker.radius &&
        y >= marker.center.y - marker.radius &&
        y < marker.center.y + marker.radius &&
        color === "37,99,235"
      ) {
        markerBluePixels += 1;
      }
    }

    expect(result.warnings).toEqual([]);
    expect(colors.get("239,246,255") ?? 0).toBeGreaterThan(300);
    expect(colors.get("15,23,42") ?? 0).toBeGreaterThan(10);
    expect(colors.get("37,99,235") ?? 0).toBeGreaterThan(300);
    expect(markerBluePixels).toBeGreaterThan(200);
  });

  it("renders readable 1.1 labels, independent markers, bounded Chinese text, and repeatable PNGs", async () => {
    const inputPath = path.join(temporaryDirectory, "v11 source.png");
    const firstPath = path.join(temporaryDirectory, "v11 first.png");
    const secondPath = path.join(temporaryDirectory, "v11 second.png");
    await sharp({ create: { width: 720, height: 440, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const spec = {
      version: "1.1",
      defaults: { fontSize: 22, maxWidth: 168 },
      annotations: [
        {
          id: "readable-note",
          type: "numbered-callout",
          target: { x: 420, y: 190, width: 100, height: 70 },
          text: "这是一段用于验证最大宽度与中文自动换行的普通说明",
          number: 4,
          placement: "left",
          style: {
            markerStrokeColor: "#6D28D9",
            markerFillColor: "#7C3AED",
            markerTextColor: "#00E5FF"
          }
        }
      ]
    };
    const first = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const second = await annotateImage({
      inputPath,
      outputPath: secondPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const sidecar = JSON.parse(await readFile(first.sidecarPath, "utf8")) as {
      resolvedAnnotations: {
        box: { x: number; y: number; width: number; height: number };
        marker: { center: { x: number; y: number }; radius: number };
        style: Record<string, unknown>;
      }[];
    };
    const resolved = sidecar.resolvedAnnotations[0];
    expect(resolved).toBeDefined();
    if (resolved === undefined) throw new Error("Missing resolved numbered callout.");

    expect(first.outputSha256).toBe(second.outputSha256);
    expect(first.specSha256).toBe(second.specSha256);
    expect(first.warnings).toEqual([]);
    expect(resolved.box.width).toBeLessThanOrEqual(168 + 24);
    expect(resolved.box.x).toBeGreaterThanOrEqual(0);
    expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(720);
    expect(resolved.box.y).toBeGreaterThanOrEqual(0);
    expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(440);
    expect(resolved.style).toMatchObject({
      textColor: "#0f172a",
      markerStrokeColor: "#6d28d9",
      markerFillColor: "#7c3aed",
      markerTextColor: "#00e5ff",
      maxWidth: 168
    });

    const raw = await sharp(first.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const colors = new Map<string, number>();
    let markerGlyphPixels = 0;
    for (let index = 0; index < raw.data.length; index += raw.info.channels) {
      const color = `${raw.data[index]},${raw.data[index + 1]},${raw.data[index + 2]}`;
      colors.set(color, (colors.get(color) ?? 0) + 1);
      const pixelIndex = index / raw.info.channels;
      const x = pixelIndex % raw.info.width;
      const y = Math.floor(pixelIndex / raw.info.width);
      const distance = Math.hypot(x - resolved.marker.center.x, y - resolved.marker.center.y);
      if (distance <= resolved.marker.radius - 2 && color === "0,229,255") {
        markerGlyphPixels += 1;
      }
    }
    expect(colors.get("239,246,255") ?? 0).toBeGreaterThan(500);
    expect(colors.get("15,23,42") ?? 0).toBeGreaterThan(10);
    expect(colors.get("124,58,237") ?? 0).toBeGreaterThan(200);
    expect(colors.get("109,40,217") ?? 0).toBeGreaterThan(20);
    expect(markerGlyphPixels).toBeGreaterThan(5);
  });

  it("renders non-default presets and tones with their resolved callout styles", async () => {
    const inputPath = path.join(temporaryDirectory, "palette source.png");
    await sharp({ create: { width: 520, height: 280, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const cases = [
      {
        name: "docs-dark",
        preset: "docs-dark",
        expectedText: "#f8fafc",
        expectedBackground: "#1e293b"
      },
      {
        name: "high-contrast",
        preset: "high-contrast",
        expectedText: "#ffffff",
        expectedBackground: "#000000"
      },
      {
        name: "success",
        preset: "docs-light",
        tone: "success",
        expectedText: "#14532d",
        expectedBackground: "#f0fdf4"
      },
      {
        name: "warning",
        preset: "docs-light",
        tone: "warning",
        expectedText: "#78350f",
        expectedBackground: "#fffbeb"
      }
    ];

    for (const item of cases) {
      const result = await annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, `palette-${item.name}.png`),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          preset: item.preset,
          annotations: [
            {
              type: "callout",
              target: { x: 380, y: 105, width: 80, height: 55 },
              text: `Palette ${item.name}`,
              placement: "left",
              ...(item.tone === undefined ? {} : { tone: item.tone })
            }
          ]
        }
      });
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
        resolvedAnnotations: {
          box: { x: number; y: number; width: number; height: number };
          style: { textColor: string; backgroundColor: string };
        }[];
      };
      const resolved = sidecar.resolvedAnnotations[0];
      expect(resolved).toBeDefined();
      if (resolved === undefined) throw new Error(`Missing ${item.name} callout.`);
      expect(resolved.style).toMatchObject({
        textColor: item.expectedText,
        backgroundColor: item.expectedBackground
      });
      expect(result.warnings).toEqual([]);

      const raw = await sharp(result.outputPath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expectedText = item.expectedText
        .slice(1)
        .match(/.{2}/gu)
        ?.map((part) => Number.parseInt(part, 16));
      const expectedBackground = item.expectedBackground
        .slice(1)
        .match(/.{2}/gu)
        ?.map((part) => Number.parseInt(part, 16));
      let textPixels = 0;
      let backgroundPixels = 0;
      for (let y = resolved.box.y + 3; y < resolved.box.y + resolved.box.height - 3; y += 1) {
        for (let x = resolved.box.x + 3; x < resolved.box.x + resolved.box.width - 3; x += 1) {
          const offset = (y * raw.info.width + x) * raw.info.channels;
          const pixel = [raw.data[offset], raw.data[offset + 1], raw.data[offset + 2]];
          if (pixel.every((value, index) => value === expectedText?.[index])) textPixels += 1;
          if (pixel.every((value, index) => value === expectedBackground?.[index])) {
            backgroundPixels += 1;
          }
        }
      }
      expect(textPixels).toBeGreaterThan(5);
      expect(backgroundPixels).toBeGreaterThan(100);
    }
  });

  it("bounds 1.1 standalone text and plain callouts at min/max maxWidth", async () => {
    const inputPath = path.join(temporaryDirectory, "width source.png");
    await sharp({ create: { width: 620, height: 360, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const cases = [
      {
        name: "text-chinese-min",
        maxWidth: 48,
        padding: 4,
        annotation: {
          type: "text",
          position: { x: 12, y: 12 },
          text: "中文最小宽度换行验证中文最小宽度换行验证"
        }
      },
      {
        name: "text-unbreakable",
        maxWidth: 96,
        padding: 4,
        annotation: {
          type: "text",
          position: { x: 12, y: 12 },
          text: "UnbreakableTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        }
      },
      {
        name: "callout-chinese-min",
        maxWidth: 48,
        padding: 4,
        annotation: {
          type: "callout",
          target: { x: 500, y: 130, width: 70, height: 50 },
          text: "中文说明自动换行中文说明自动换行",
          placement: "left"
        }
      },
      {
        name: "callout-unbreakable-max",
        maxWidth: 4_096,
        padding: 4,
        annotation: {
          type: "callout",
          target: { x: 500, y: 130, width: 70, height: 50 },
          text: "UnbreakableTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
          placement: "left"
        }
      }
    ];

    for (const item of cases) {
      const result = await annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, `${item.name}.png`),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          annotations: [
            {
              ...item.annotation,
              style: { maxWidth: item.maxWidth, padding: item.padding }
            }
          ]
        }
      });
      const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
        resolvedAnnotations: {
          box: { x: number; y: number; width: number; height: number };
          style?: { maxWidth: number };
        }[];
      };
      const resolved = sidecar.resolvedAnnotations[0];
      expect(resolved).toBeDefined();
      if (resolved === undefined) throw new Error(`Missing ${item.name}.`);
      expect(resolved.box.width).toBeLessThanOrEqual(
        Math.min(item.maxWidth + item.padding * 2, 612)
      );
      expect(resolved.box.x).toBeGreaterThanOrEqual(0);
      expect(resolved.box.x + resolved.box.width).toBeLessThanOrEqual(620);
      expect(resolved.box.y).toBeGreaterThanOrEqual(0);
      expect(resolved.box.y + resolved.box.height).toBeLessThanOrEqual(360);
      if (item.annotation.type === "callout") {
        expect(resolved.style?.maxWidth).toBe(item.maxWidth);
      }
    }
  });

  it("fails rather than returning a glyph wider than the effective small-canvas width", async () => {
    const inputPath = path.join(temporaryDirectory, "small width source.png");
    const outputPath = path.join(temporaryDirectory, "small width output.png");
    await sharp({ create: { width: 48, height: 48, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);

    await expect(
      annotateImage({
        inputPath,
        outputPath,
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.1",
          annotations: [
            {
              type: "text",
              position: { x: 47, y: 0 },
              text: "W",
              style: { maxWidth: 48, padding: 0, fontSize: 22 }
            }
          ]
        }
      })
    ).rejects.toThrow(/cannot fit within 1x48 pixels/u);
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("does not write output when a 1.1 version, tone, maxWidth, color, or field is invalid", async () => {
    const inputPath = path.join(temporaryDirectory, "invalid source.png");
    await sharp({ create: { width: 80, height: 60, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    const invalidSpecs = [
      { version: "1.2", annotations: [] },
      {
        version: "1.1",
        annotations: [{ type: "callout", target: { x: 10, y: 10 }, text: "bad", tone: "urgent" }]
      },
      {
        version: "1.1",
        annotations: [
          {
            type: "callout",
            target: { x: 10, y: 10 },
            text: "bad",
            style: { maxWidth: 12 }
          }
        ]
      },
      { version: "1.1", defaults: { markerFillColor: "red" }, annotations: [] },
      { version: "1.1", annotations: [], unexpected: true }
    ];

    for (const [index, spec] of invalidSpecs.entries()) {
      const outputPath = path.join(temporaryDirectory, `invalid-${index}.png`);
      await expect(
        annotateImage({ inputPath, outputPath, spec, allowedRoots: [temporaryDirectory] })
      ).rejects.toThrow();
      await expect(access(outputPath)).rejects.toThrow();
      await expect(access(outputPath.replace(/\.png$/u, ".json"))).rejects.toThrow();
    }
  });

  it("dims only outside the spotlight instead of making it opaque black", async () => {
    const inputPath = path.join(temporaryDirectory, "solid.png");
    const outputPath = path.join(temporaryDirectory, "spotlight.png");
    await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 160, b: 120 } }
    })
      .png()
      .toFile(inputPath);
    await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.0",
        annotations: [{ type: "spotlight", rect: { x: 30, y: 30, width: 40, height: 40 } }]
      }
    });

    const inside = await rgbAt(outputPath, 50, 50);
    const outside = await rgbAt(outputPath, 10, 10);
    expect(inside).toEqual([200, 160, 120]);
    expect(outside[0]).toBeGreaterThan(20);
    expect(outside[0]).toBeLessThan(120);
    expect(outside[1]).toBeLessThan(inside[1]);
    expect(outside[2]).toBeLessThan(inside[2]);
  });

  it("uses Gaussian blur and replaces redact pixels with one opaque color", async () => {
    const inputPath = path.join(temporaryDirectory, "privacy source.png");
    const outputPath = path.join(temporaryDirectory, "privacy output.png");
    await writePattern(inputPath, 120, 80);
    const result = await annotateImage({
      inputPath,
      outputPath,
      allowedRoots: [temporaryDirectory],
      spec: {
        version: "1.0",
        annotations: [
          { type: "blur", rect: { x: 8, y: 8, width: 42, height: 42 }, sigma: 4 },
          { type: "redact", rect: { x: 70, y: 10, width: 30, height: 30 }, color: "#112233" }
        ]
      }
    });
    const original = await sharp(inputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rendered = await sharp(outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const redacted = new Set<string>();
    let changedBlurPixels = 0;
    const blurredValues = new Set<string>();
    for (let y = 0; y < 80; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        const offset = (y * 120 + x) * 3;
        const value = `${rendered.data[offset]},${rendered.data[offset + 1]},${rendered.data[offset + 2]}`;
        if (x >= 70 && x < 100 && y >= 10 && y < 40) redacted.add(value);
        if (x >= 8 && x < 50 && y >= 8 && y < 50) {
          blurredValues.add(value);
          if (
            rendered.data[offset] !== original.data[offset] ||
            rendered.data[offset + 1] !== original.data[offset + 1] ||
            rendered.data[offset + 2] !== original.data[offset + 2]
          ) {
            changedBlurPixels += 1;
          }
        }
      }
    }

    expect(result.usesBlur).toBe(true);
    expect(result.usesRedact).toBe(true);
    expect([...redacted]).toEqual(["17,34,51"]);
    expect(changedBlurPixels).toBeGreaterThan(500);
    expect(blurredValues.size).toBeGreaterThan(8);
  });

  it("is deterministic on the same platform and protects existing outputs", async () => {
    const inputPath = path.join(temporaryDirectory, "deterministic.png");
    const firstPath = path.join(temporaryDirectory, "first.png");
    const secondPath = path.join(temporaryDirectory, "second.png");
    await writePattern(inputPath, 280, 180);
    const spec = {
      version: "1.0",
      coordinateSpace: "normalized",
      annotations: [
        {
          id: "box",
          type: "rectangle",
          rect: { x: 0.1, y: 0.1, width: 0.4, height: 0.3 }
        },
        {
          id: "safe-text",
          type: "text",
          position: { x: 0.05, y: 0.55 },
          text: '<span foreground="#00FF00">literal, not markup</span> & 中文'
        }
      ]
    };
    const first = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const validation = await validateSpecForImage({
      inputPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });
    const firstSidecar = await readFile(first.sidecarPath);
    const second = await annotateImage({
      inputPath,
      outputPath: secondPath,
      spec,
      allowedRoots: [temporaryDirectory]
    });

    expect(first.outputSha256).toBe(second.outputSha256);
    expect(first.specSha256).toBe(second.specSha256);
    expect(first.specSha256).toBe(validation.specSha256);
    await expect(
      annotateImage({
        inputPath,
        outputPath: firstPath,
        spec,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/already exists/u);
    const overwritten = await annotateImage({
      inputPath,
      outputPath: firstPath,
      spec,
      overwrite: true,
      allowedRoots: [temporaryDirectory]
    });
    expect(overwritten.outputSha256).toBe(first.outputSha256);
    expect(await readFile(overwritten.sidecarPath)).toEqual(firstSidecar);
    expect((await sharp(overwritten.outputPath).metadata()).format).toBe("png");
    await expect(
      annotateImage({
        inputPath,
        outputPath: inputPath,
        spec,
        overwrite: true,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/must not overwrite|alias any input/u);
  });

  it("fails clearly instead of clipping text that cannot fit", async () => {
    const inputPath = path.join(temporaryDirectory, "tiny.png");
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "white" } })
      .png()
      .toFile(inputPath);
    await expect(
      annotateImage({
        inputPath,
        outputPath: path.join(temporaryDirectory, "tiny output.png"),
        allowedRoots: [temporaryDirectory],
        spec: {
          version: "1.0",
          annotations: [
            {
              type: "text",
              position: { x: 1, y: 1 },
              text: "无法容纳的中英文内容 ".repeat(200),
              style: { fontSize: 64 }
            }
          ]
        }
      })
    ).rejects.toThrow(/minimum supported font size \(6px\)/u);
  });
});
