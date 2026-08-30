import { link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createContactSheet,
  createImagePreview,
  cropImage,
  getCoreDoctorReport,
  inspectImage
} from "../src/core/index.js";
import { BUNDLED_FONT_SHA256 } from "../src/renderer/index.js";

async function writeGradient(filePath: string, width = 200, height = 100): Promise<void> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = x % 256;
      pixels[offset + 1] = y % 256;
      pixels[offset + 2] = (x * 3 + y * 5) % 256;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

describe("core image I/O and security", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-callout-core-"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("inspects PNG, JPEG, and WebP by decoded content", async () => {
    const pngPath = path.join(temporaryDirectory, "source.png");
    const jpegPath = path.join(temporaryDirectory, "source.jpg");
    const webpPath = path.join(temporaryDirectory, "source.webp");
    await writeGradient(pngPath, 80, 48);
    await sharp(pngPath).jpeg({ quality: 90 }).toFile(jpegPath);
    await sharp(pngPath).webp({ quality: 90 }).toFile(webpPath);

    const results = await Promise.all(
      [pngPath, jpegPath, webpPath].map((inputPath) =>
        inspectImage(inputPath, { allowedRoots: [temporaryDirectory] })
      )
    );

    expect(results.map((result) => result.format)).toEqual(["png", "jpeg", "webp"]);
    for (const result of results) {
      expect(result.dimensions).toEqual({ width: 80, height: 48 });
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(path.isAbsolute(result.path)).toBe(true);
    }
  });

  it("applies EXIF orientation and strips metadata from generated PNG", async () => {
    const inputPath = path.join(temporaryDirectory, "oriented.jpg");
    const outputPath = path.join(temporaryDirectory, "oriented-preview.png");
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "#336699" }
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(inputPath);

    const inspection = await inspectImage(inputPath, { allowedRoots: [temporaryDirectory] });
    expect(inspection.storedDimensions).toEqual({ width: 40, height: 20 });
    expect(inspection.dimensions).toEqual({ width: 20, height: 40 });
    expect(inspection.orientation).toBe(6);

    const preview = await createImagePreview({
      inputPath,
      outputPath,
      maxWidth: 100,
      maxHeight: 100,
      allowedRoots: [temporaryDirectory]
    });
    const metadata = await sharp(preview.outputPath).metadata();
    expect(preview.outputDimensions).toEqual({ width: 20, height: 40 });
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it("enforces byte and pixel limits before processing", async () => {
    const inputPath = path.join(temporaryDirectory, "bounded.png");
    await writeGradient(inputPath, 32, 32);

    await expect(
      inspectImage(inputPath, {
        allowedRoots: [temporaryDirectory],
        maxFileBytes: 16
      })
    ).rejects.toThrow(/limit/u);
    await expect(
      inspectImage(inputPath, {
        allowedRoots: [temporaryDirectory],
        maxPixels: 100
      })
    ).rejects.toThrow(/decode|limit|pixel/u);
  });

  it("accepts spaces and Unicode while rejecting traversal and symlink escape", async () => {
    const allowed = path.join(temporaryDirectory, "允许 root with spaces");
    const outside = path.join(temporaryDirectory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const safePath = path.join(allowed, "截图 示例.png");
    const outsidePath = path.join(outside, "secret.png");
    await writeGradient(safePath, 24, 16);
    await writeGradient(outsidePath, 24, 16);

    const safe = await inspectImage(safePath, { allowedRoots: [allowed] });
    expect(safe.dimensions).toEqual({ width: 24, height: 16 });
    await expect(inspectImage(outsidePath, { allowedRoots: [allowed] })).rejects.toThrow(
      /outside the allowed roots/u
    );

    const escapeLink = path.join(allowed, "linked-outside");
    await symlink(outside, escapeLink, process.platform === "win32" ? "junction" : "dir");
    await expect(
      inspectImage(path.join(escapeLink, "secret.png"), { allowedRoots: [allowed] })
    ).rejects.toThrow(/outside the allowed roots/u);
  });

  it("creates crop, preview, and contact sheet PNGs with portable sidecars", async () => {
    const firstPath = path.join(temporaryDirectory, "第一 张.png");
    const secondPath = path.join(temporaryDirectory, "第二 张 &.png");
    await writeGradient(firstPath, 200, 100);
    await writeGradient(secondPath, 100, 200);

    const crop = await cropImage({
      inputPath: firstPath,
      rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      coordinateSpace: "normalized",
      outputPath: path.join(temporaryDirectory, "crop output.png"),
      allowedRoots: [temporaryDirectory]
    });
    const preview = await createImagePreview({
      inputPath: firstPath,
      outputPath: path.join(temporaryDirectory, "preview output.png"),
      maxWidth: 50,
      maxHeight: 50,
      allowedRoots: [temporaryDirectory]
    });
    const contactSheet = await createContactSheet({
      inputPaths: [firstPath, secondPath],
      outputPath: path.join(temporaryDirectory, "contact output.png"),
      columns: 2,
      cellWidth: 80,
      cellHeight: 60,
      padding: 4,
      labels: true,
      allowedRoots: [temporaryDirectory]
    });

    expect(crop.outputDimensions).toEqual({ width: 100, height: 50 });
    expect(preview.outputDimensions).toEqual({ width: 50, height: 25 });
    expect(contactSheet.outputDimensions).toEqual({ width: 172, height: 68 });
    for (const result of [crop, preview, contactSheet]) {
      const metadata = await sharp(result.outputPath).metadata();
      const sidecar = await readFile(result.sidecarPath, "utf8");
      expect(metadata.format).toBe("png");
      expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(path.isAbsolute(result.outputPath)).toBe(true);
      expect(result.markdown).toContain(result.outputPath.split(path.sep).join("/"));
      expect(sidecar).toContain('"pathSemantics": "relative-to-sidecar"');
      expect(sidecar).not.toContain(temporaryDirectory);
      expect(sidecar).not.toContain(temporaryDirectory.split(path.sep).join("/"));
    }
  });

  it("never overwrites an input image even when overwrite is requested", async () => {
    const inputPath = path.join(temporaryDirectory, "keep-original.png");
    await writeGradient(inputPath, 40, 24);
    const common = {
      inputPath,
      outputPath: inputPath,
      overwrite: true,
      allowedRoots: [temporaryDirectory]
    };

    await expect(createImagePreview({ ...common, maxWidth: 20, maxHeight: 20 })).rejects.toThrow(
      /must not overwrite|alias any input/u
    );
    await expect(
      cropImage({ ...common, rect: { x: 0, y: 0, width: 20, height: 12 } })
    ).rejects.toThrow(/must not overwrite|alias any input/u);
    await expect(
      createContactSheet({
        inputPaths: [inputPath],
        outputPath: inputPath,
        overwrite: true,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/must not overwrite|alias any input/u);

    const originalBytes = await readFile(inputPath);
    const hardLinkOutput = path.join(temporaryDirectory, "hard-link-output.png");
    await link(inputPath, hardLinkOutput);
    await expect(
      createImagePreview({
        inputPath,
        outputPath: hardLinkOutput,
        overwrite: true,
        maxWidth: 20,
        maxHeight: 20,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/must not overwrite|alias any input/u);
    expect(await readFile(inputPath)).toEqual(originalBytes);

    const sidecarAttackOutput = path.join(temporaryDirectory, "sidecar-attack.png");
    await link(inputPath, path.join(temporaryDirectory, "sidecar-attack.json"));
    await expect(
      createImagePreview({
        inputPath,
        outputPath: sidecarAttackOutput,
        overwrite: true,
        maxWidth: 20,
        maxHeight: 20,
        allowedRoots: [temporaryDirectory]
      })
    ).rejects.toThrow(/must not overwrite|alias any input/u);
    expect(await readFile(inputPath)).toEqual(originalBytes);
    expect((await sharp(inputPath).metadata()).format).toBe("png");
  });

  it("marks cross-volume basename fallbacks for SHA-256 resolution", async () => {
    if (
      path.parse(process.cwd()).root.toLowerCase() ===
      path.parse(temporaryDirectory).root.toLowerCase()
    ) {
      return;
    }
    const sourceDirectory = await mkdtemp(path.join(process.cwd(), ".agent-callout-cross-volume-"));
    try {
      const inputPath = path.join(sourceDirectory, "portable-source.png");
      await writeGradient(inputPath, 40, 24);
      const result = await createImagePreview({
        inputPath,
        outputPath: path.join(temporaryDirectory, "cross-volume-preview.png"),
        maxWidth: 20,
        maxHeight: 20,
        allowedRoots: [sourceDirectory, temporaryDirectory]
      });
      const sidecarText = await readFile(result.sidecarPath, "utf8");
      const sidecar = JSON.parse(sidecarText) as {
        pathSemantics: string;
        inputs: { path: string; pathSemantics: string; sha256: string }[];
      };
      expect(sidecar.pathSemantics).toBe("per-input; see inputs[].pathSemantics");
      expect(sidecar.inputs[0]?.path).toBe("portable-source.png");
      expect(sidecar.inputs[0]?.pathSemantics).toBe("basename-only-resolve-by-sha256");
      expect(sidecar.inputs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(sidecarText).not.toContain(sourceDirectory);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it("reports the real Sharp/libvips and bundled font health", async () => {
    const report = await getCoreDoctorReport();
    expect(report.ok).toBe(true);
    expect(report.renderer?.sharp).toBe(sharp.versions.sharp);
    expect(report.renderer?.libvips).toBe(sharp.versions.vips);
    expect(report.renderer?.font.sha256).toBe(BUNDLED_FONT_SHA256);
    expect(report.limits).toMatchObject({
      maxFileBytes: 50 * 1024 * 1024,
      maxPixels: 40_000_000,
      maxAnnotations: 200,
      maxTotalTextLength: 100_000
    });
    expect(report.checks.find((check) => check.name === "text-render")?.ok).toBe(true);
  });
});
