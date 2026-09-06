import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapOcrBoundsToSource, prepareOcrImage } from "../src/locator/ocr/image.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-callout-ocr-image-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function source(width = 20, height = 12): Promise<string> {
  const file = path.join(directory, "input.png");
  await sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } }
  })
    .png()
    .toFile(file);
  return file;
}

describe("OCR source raster and coordinate evidence", () => {
  it("uses full resolution, binds source bytes, and leaves the input unchanged", async () => {
    const inputPath = await source(1600, 900);
    const before = await readFile(inputPath);
    const first = await prepareOcrImage({ inputPath, allowedRoots: [directory] });
    const second = await prepareOcrImage({ inputPath, allowedRoots: [directory] });
    expect(first.originalDimensions).toEqual({ width: 1600, height: 900 });
    expect(first.transform.dimensions).toEqual({ width: 1600, height: 900 });
    expect(first.inputSha256).toBe(createHash("sha256").update(before).digest("hex"));
    expect(first.processedSha256).toBe(createHash("sha256").update(first.png).digest("hex"));
    expect(first.png.equals(second.png)).toBe(true);
    expect(await readFile(inputPath)).toEqual(before);
  });

  it("maps a fractional ROI through exposed outward rounding and scale", async () => {
    const inputPath = await source();
    const result = await prepareOcrImage({
      inputPath,
      allowedRoots: [directory],
      region: { x: 3.2, y: 2.4, width: 7.3, height: 4.1 },
      scale: 4
    });
    expect(result.transform.sourceRect).toEqual({ x: 3, y: 2, width: 8, height: 5 });
    expect(result.transform.dimensions).toEqual({ width: 32, height: 20 });
    expect(mapOcrBoundsToSource({ x0: 2, y0: 3, x1: 14, y1: 11 }, result.transform)).toEqual({
      x: 3.5,
      y: 2.75,
      width: 3,
      height: 2
    });
  });

  it("extracts after EXIF orientation and removes stored orientation", async () => {
    const inputPath = path.join(directory, "rotated.jpg");
    const input = await sharp({
      create: { width: 12, height: 8, channels: 3, background: "white" }
    })
      .composite([
        {
          input: await sharp({ create: { width: 6, height: 8, channels: 3, background: "red" } })
            .png()
            .toBuffer(),
          left: 0,
          top: 0
        }
      ])
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toBuffer();
    await writeFile(inputPath, input);
    const result = await prepareOcrImage({
      inputPath,
      allowedRoots: [directory],
      region: { x: 0, y: 0, width: 8, height: 4 }
    });
    expect(result.originalDimensions).toEqual({ width: 8, height: 12 });
    const decoded = await sharp(result.png).removeAlpha().raw().toBuffer();
    expect(decoded[0]).toBeGreaterThan(240);
    expect(decoded[1]).toBeLessThan(20);
    expect((await sharp(result.png).metadata()).orientation).toBeUndefined();
  });

  it("flattens transparency to white and records explicit inversion", async () => {
    const inputPath = path.join(directory, "transparent.png");
    await sharp({
      create: { width: 4, height: 3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .png()
      .toFile(inputPath);
    const plain = await prepareOcrImage({ inputPath, allowedRoots: [directory] });
    const inverse = await prepareOcrImage({
      inputPath,
      allowedRoots: [directory],
      preprocess: "invert"
    });
    expect([...(await sharp(plain.png).removeAlpha().raw().toBuffer())]).toEqual(
      Array(36).fill(255)
    );
    expect([...(await sharp(inverse.png).removeAlpha().raw().toBuffer())]).toEqual(
      Array(36).fill(0)
    );
    expect(inverse.transform).toMatchObject({ preprocess: "invert", alphaBackground: "#FFFFFF" });
    expect(inverse.inputSha256).toBe(plain.inputSha256);
    expect(inverse.processedSha256).not.toBe(plain.processedSha256);
  });

  it("rejects a changed source hash and outside-root input", async () => {
    const inputPath = await source();
    await expect(
      prepareOcrImage({ inputPath, allowedRoots: [directory], expectedInputSha256: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "OCR_INPUT_CHANGED" });
    await mkdir(path.join(directory, "other"));
    await expect(
      prepareOcrImage({ inputPath, allowedRoots: [path.join(directory, "other")] })
    ).rejects.toThrow("outside the allowed roots");
  });

  it("rejects invalid ROI and over-budget scaling without silent downsampling", async () => {
    const inputPath = await source(1600, 900);
    await expect(
      prepareOcrImage({ inputPath, allowedRoots: [directory], scale: 4 })
    ).rejects.toMatchObject({ code: "OCR_IMAGE_TOO_LARGE" });
    for (const region of [
      { x: -1, y: 0, width: 2, height: 2 },
      { x: 1599, y: 0, width: 2, height: 2 },
      { x: 0, y: 0, width: NaN, height: 2 }
    ]) {
      await expect(
        prepareOcrImage({ inputPath, allowedRoots: [directory], region })
      ).rejects.toMatchObject({ code: "OCR_INVALID_ARGUMENT" });
    }
    await expect(
      prepareOcrImage({ inputPath, allowedRoots: [directory], scale: 1.5 })
    ).rejects.toMatchObject({ code: "OCR_INVALID_ARGUMENT" });
  });

  it("rejects invalid engine rectangles and forged coordinate transforms", async () => {
    const prepared = await prepareOcrImage({
      inputPath: await source(),
      allowedRoots: [directory]
    });
    for (const bounds of [
      { x0: -1, y0: 1, x1: 3, y1: 4 },
      { x0: 1, y0: 1, x1: 30, y1: 4 },
      { x0: 1, y0: 1, x1: NaN, y1: 4 }
    ]) {
      expect(() => mapOcrBoundsToSource(bounds, prepared.transform)).toThrow();
    }
    expect(() =>
      mapOcrBoundsToSource({ x0: 1, y0: 1, x1: 3, y1: 4 }, { ...prepared.transform, scale: 0 })
    ).toThrow();
  });
});
