import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { DEFAULT_IMAGE_LIMITS, inspectImage, type ImageSafetyOptions } from "../../core/index.js";
import { STABLE_PNG_OPTIONS } from "../../renderer/index.js";
import type { OcrBounds } from "./types.js";

export const MAX_OCR_PROCESSING_PIXELS = 10_000_000;

export interface OcrSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrImageTransform {
  sourceRect: OcrSourceRect;
  scale: number;
  preprocess: "none" | "invert";
  alphaBackground: "#FFFFFF";
  dimensions: { width: number; height: number };
}

export interface PreparedOcrImage {
  png: Buffer;
  inputSha256: string;
  processedSha256: string;
  originalDimensions: { width: number; height: number };
  transform: OcrImageTransform;
}

export class OcrImageError extends Error {
  public constructor(
    public readonly code:
      "OCR_INVALID_ARGUMENT" | "OCR_INPUT_CHANGED" | "OCR_IMAGE_TOO_LARGE" | "OCR_RESULT_INVALID",
    message: string
  ) {
    super(message);
    this.name = "OcrImageError";
  }
}

export async function prepareOcrImage(
  options: ImageSafetyOptions & {
    inputPath: string;
    expectedInputSha256?: string;
    region?: OcrSourceRect;
    scale?: number;
    preprocess?: "none" | "invert";
  }
): Promise<PreparedOcrImage> {
  const scale = options.scale ?? 1;
  const preprocess = options.preprocess ?? "none";
  if (
    !Number.isInteger(scale) ||
    scale < 1 ||
    scale > 4 ||
    (preprocess !== "none" && preprocess !== "invert") ||
    (options.expectedInputSha256 !== undefined &&
      !/^[a-f0-9]{64}$/iu.test(options.expectedInputSha256))
  ) {
    throw new OcrImageError(
      "OCR_INVALID_ARGUMENT",
      "Invalid OCR scale, preprocessing, or expected hash."
    );
  }
  const inspection = await inspectImage(options.inputPath, options);
  if (
    options.expectedInputSha256 !== undefined &&
    options.expectedInputSha256.toLowerCase() !== inspection.sha256
  ) {
    throw new OcrImageError(
      "OCR_INPUT_CHANGED",
      "The screenshot no longer matches the expected input hash."
    );
  }
  const canvas = inspection.dimensions;
  const requested = options.region ?? { x: 0, y: 0, ...canvas };
  if (
    ![requested.x, requested.y, requested.width, requested.height].every(Number.isFinite) ||
    requested.x < 0 ||
    requested.y < 0 ||
    requested.width <= 0 ||
    requested.height <= 0 ||
    requested.x + requested.width > canvas.width ||
    requested.y + requested.height > canvas.height
  ) {
    throw new OcrImageError(
      "OCR_INVALID_ARGUMENT",
      "OCR region must lie within the oriented screenshot."
    );
  }
  // Round outward and expose the exact extracted region in evidence.
  const x = Math.floor(requested.x);
  const y = Math.floor(requested.y);
  const sourceRect = {
    x,
    y,
    width: Math.ceil(requested.x + requested.width) - x,
    height: Math.ceil(requested.y + requested.height) - y
  };
  const dimensions = { width: sourceRect.width * scale, height: sourceRect.height * scale };
  if (dimensions.width * dimensions.height > MAX_OCR_PROCESSING_PIXELS) {
    throw new OcrImageError(
      "OCR_IMAGE_TOO_LARGE",
      "OCR processing exceeds 10 million pixels; select a smaller region or scale."
    );
  }
  const bytes = await readFile(inspection.path);
  if (createHash("sha256").update(bytes).digest("hex") !== inspection.sha256) {
    throw new OcrImageError("OCR_INPUT_CHANGED", "The screenshot changed after inspection.");
  }
  // Use a full oriented PNG before extracting so ROI coordinates are independent of EXIF storage.
  const oriented = await sharp(bytes, {
    limitInputPixels: DEFAULT_IMAGE_LIMITS.maxPixels,
    failOn: "error"
  })
    .rotate()
    .flatten({ background: "#FFFFFF" })
    .png(STABLE_PNG_OPTIONS)
    .toBuffer();
  let pipeline = sharp(oriented)
    .extract({ left: x, top: y, width: sourceRect.width, height: sourceRect.height })
    .resize(dimensions.width, dimensions.height, { kernel: "lanczos3" });
  if (preprocess === "invert") pipeline = pipeline.negate();
  const generated = await pipeline.png(STABLE_PNG_OPTIONS).toBuffer({ resolveWithObject: true });
  if (generated.info.width !== dimensions.width || generated.info.height !== dimensions.height) {
    throw new OcrImageError(
      "OCR_RESULT_INVALID",
      "The prepared OCR raster has unexpected dimensions."
    );
  }
  return {
    png: generated.data,
    inputSha256: inspection.sha256,
    processedSha256: createHash("sha256").update(generated.data).digest("hex"),
    originalDimensions: canvas,
    transform: { sourceRect, scale, preprocess, alphaBackground: "#FFFFFF", dimensions }
  };
}

export function mapOcrBoundsToSource(
  bounds: OcrBounds,
  transform: OcrImageTransform
): OcrSourceRect {
  if (
    !Number.isInteger(transform.scale) ||
    transform.scale < 1 ||
    transform.scale > 4 ||
    ![
      transform.sourceRect.x,
      transform.sourceRect.y,
      transform.sourceRect.width,
      transform.sourceRect.height
    ].every(Number.isSafeInteger) ||
    transform.sourceRect.x < 0 ||
    transform.sourceRect.y < 0 ||
    transform.sourceRect.width <= 0 ||
    transform.sourceRect.height <= 0 ||
    transform.dimensions.width !== transform.sourceRect.width * transform.scale ||
    transform.dimensions.height !== transform.sourceRect.height * transform.scale ||
    ![bounds.x0, bounds.y0, bounds.x1, bounds.y1].every(Number.isFinite) ||
    bounds.x0 < 0 ||
    bounds.y0 < 0 ||
    bounds.x1 <= bounds.x0 ||
    bounds.y1 <= bounds.y0 ||
    bounds.x1 > transform.dimensions.width ||
    bounds.y1 > transform.dimensions.height
  ) {
    throw new OcrImageError(
      "OCR_RESULT_INVALID",
      "OCR returned a text rectangle outside its input raster."
    );
  }
  return {
    x: transform.sourceRect.x + bounds.x0 / transform.scale,
    y: transform.sourceRect.y + bounds.y0 / transform.scale,
    width: (bounds.x1 - bounds.x0) / transform.scale,
    height: (bounds.y1 - bounds.y0) / transform.scale
  };
}
