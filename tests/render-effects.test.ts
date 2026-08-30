import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    ).rejects.toThrow(/cannot fit|shorten it|larger canvas/u);
  });
});
