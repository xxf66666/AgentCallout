import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp, { type OverlayOptions, type PngOptions } from "sharp";

import { placeCallout } from "../layout/index.js";

export const RENDERER_NAME = "sharp-svg-pango";
export const RENDERER_VERSION = "0.1.2";
export const BUNDLED_FONT_FILENAME = "NotoSansCJKsc-Regular.otf";
export const BUNDLED_FONT_SHA256 =
  "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";

export const STABLE_PNG_OPTIONS: PngOptions = Object.freeze({
  adaptiveFiltering: false,
  compressionLevel: 9,
  force: true,
  palette: false,
  progressive: false
});

export interface PixelPoint {
  x: number;
  y: number;
}

export interface PixelRect extends PixelPoint {
  width: number;
  height: number;
}

export interface RendererVersions {
  name: string;
  version: string;
  sharp: string;
  libvips: string;
  font: {
    family: string;
    file: string;
    version: string;
    sha256: string;
  };
}

export interface RenderAnnotationsOptions {
  fontPath?: string;
  limitInputPixels?: number;
}

export interface RenderAnnotationsResult {
  buffer: Buffer;
  width: number;
  height: number;
  warnings: string[];
  usesBlur: boolean;
  usesRedact: boolean;
  resolvedAnnotations: Record<string, unknown>[];
  renderer: RendererVersions;
}

interface RenderStyle {
  strokeColor: string;
  fillColor: string;
  textColor: string;
  backgroundColor: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  padding: number;
  blurSigma: number;
  maxWidth: number;
  cornerRadius: number;
  lineHeight: number;
  arrowHeadSize: number;
}

interface RenderableAnnotation {
  id: string;
  type:
    | "rectangle"
    | "ellipse"
    | "arrow"
    | "text"
    | "callout"
    | "numbered-callout"
    | "highlight"
    | "spotlight"
    | "blur"
    | "redact";
  rect?: PixelRect;
  position?: PixelPoint;
  start?: PixelPoint;
  target?: PixelPoint | PixelRect;
  text?: string;
  number?: number;
  placement?: "auto" | "top" | "right" | "bottom" | "left";
  style: RenderStyle;
}

interface TextSprite {
  buffer: Buffer;
  width: number;
  height: number;
  fontSize: number;
  wasShrunk: boolean;
}

const DEFAULT_STROKE = "#ff2d20";
const DEFAULT_TEXT = "#ffffff";
const DEFAULT_BACKGROUND = "#d7263d";
const TRANSPARENT = "#00000000";
const SAFE_NAMED_COLORS = new Set([
  "black",
  "blue",
  "gray",
  "green",
  "grey",
  "orange",
  "purple",
  "red",
  "transparent",
  "white",
  "yellow"
]);

let bundledFontPathPromise: Promise<string> | undefined;
let bundledFontInfoPromise: Promise<RendererVersions["font"]> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = finite(value);
  return numeric === undefined ? fallback : Math.min(maximum, Math.max(minimum, numeric));
}

function safeColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const candidate = value.trim().toLowerCase();
  if (/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}(?:[0-9a-f]{2})?)$/.test(candidate)) {
    return candidate;
  }
  return SAFE_NAMED_COLORS.has(candidate) ? candidate : fallback;
}

function opaqueColor(value: string): string {
  if (/^#[0-9a-f]{8}$/i.test(value)) {
    return value.slice(0, 7);
  }
  if (/^#[0-9a-f]{4}$/i.test(value)) {
    return value.slice(0, 4);
  }
  return value === "transparent" ? "#000000" : value;
}

function normalizeStyle(
  annotation: Record<string, unknown>,
  type: RenderableAnnotation["type"]
): RenderStyle {
  const style = asRecord(annotation.style) ?? {};
  const defaultFill =
    type === "highlight" ? "#ffeb3b" : type === "redact" ? "#000000" : TRANSPARENT;
  const defaultOpacity = type === "highlight" ? 0.36 : type === "spotlight" ? 0.62 : 1;
  return {
    strokeColor: safeColor(style.strokeColor ?? style.color, DEFAULT_STROKE),
    fillColor: safeColor(annotation.color ?? style.fillColor ?? style.fill, defaultFill),
    textColor: safeColor(style.textColor, DEFAULT_TEXT),
    backgroundColor: safeColor(style.backgroundColor, DEFAULT_BACKGROUND),
    strokeWidth: boundedNumber(style.strokeWidth, 4, 0, 64),
    fontSize: boundedNumber(style.fontSize, 22, 6, 256),
    opacity: boundedNumber(style.opacity, defaultOpacity, 0, 1),
    padding: boundedNumber(style.padding, 10, 0, 128),
    blurSigma: boundedNumber(annotation.sigma ?? style.blurSigma ?? style.sigma, 10, 0.3, 1_000),
    maxWidth: boundedNumber(style.maxWidth, 360, 48, 4096),
    cornerRadius: boundedNumber(style.cornerRadius, 6, 0, 256),
    lineHeight: boundedNumber(style.lineHeight, 1.25, 1, 3),
    arrowHeadSize: boundedNumber(style.arrowHeadSize, 12, 1, 128)
  };
}

function pointFrom(value: unknown): PixelPoint | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = finite(record.x);
  const y = finite(record.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function rectFrom(value: unknown): PixelRect | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  return x === undefined || y === undefined || width === undefined || height === undefined
    ? undefined
    : { x, y, width, height };
}

function normalizeType(value: unknown): RenderableAnnotation["type"] | undefined {
  if (typeof value !== "string") return undefined;
  const type = value.trim().replaceAll("_", "-").toLowerCase();
  if (type === "numberedcallout" || type === "number-callout") return "numbered-callout";
  if (
    type === "rectangle" ||
    type === "ellipse" ||
    type === "arrow" ||
    type === "text" ||
    type === "callout" ||
    type === "numbered-callout" ||
    type === "highlight" ||
    type === "spotlight" ||
    type === "blur" ||
    type === "redact"
  ) {
    return type;
  }
  return undefined;
}

function normalizePlacement(value: unknown): RenderableAnnotation["placement"] | undefined {
  return value === "auto" ||
    value === "top" ||
    value === "right" ||
    value === "bottom" ||
    value === "left"
    ? value
    : undefined;
}

function normalizeAnnotation(value: unknown, index: number): RenderableAnnotation {
  const annotation = asRecord(value);
  if (!annotation) {
    throw new Error(`Annotation at index ${index} must be an object.`);
  }
  const type = normalizeType(annotation.type);
  if (!type) {
    throw new Error(`Annotation at index ${index} has an unsupported type.`);
  }
  const geometry = asRecord(annotation.geometry) ?? {};
  const targetValue = annotation.target ?? geometry.target;
  const target = rectFrom(targetValue) ?? pointFrom(targetValue);
  const rawNumber = finite(annotation.number ?? geometry.number);
  const text = annotation.text ?? geometry.text;
  const result: RenderableAnnotation = {
    id:
      typeof annotation.id === "string" && annotation.id.length > 0
        ? annotation.id
        : `annotation-${index + 1}`,
    type,
    style: normalizeStyle(annotation, type)
  };
  const rect = rectFrom(annotation.rect) ?? rectFrom(geometry.rect) ?? rectFrom(geometry);
  const position =
    pointFrom(annotation.position) ??
    pointFrom(geometry.position) ??
    (type === "text" ? pointFrom(geometry) : undefined);
  const start = pointFrom(annotation.start) ?? pointFrom(geometry.start);
  const placement = normalizePlacement(annotation.placement ?? geometry.placement);
  if (rect) result.rect = rect;
  if (position) result.position = position;
  if (start) result.start = start;
  if (target) result.target = target;
  if (typeof text === "string") result.text = text;
  if (rawNumber !== undefined) result.number = Math.max(1, Math.round(rawNumber));
  if (placement) result.placement = placement;
  return result;
}

function pointInCanvas(point: PixelPoint, width: number, height: number): PixelPoint {
  return {
    x: Math.min(width - 1, Math.max(0, Math.round(point.x))),
    y: Math.min(height - 1, Math.max(0, Math.round(point.y)))
  };
}

function integerRect(rect: PixelRect, width: number, height: number): PixelRect {
  const left = Math.min(width - 1, Math.max(0, Math.round(rect.x)));
  const top = Math.min(height - 1, Math.max(0, Math.round(rect.y)));
  const right = Math.min(width, Math.max(left + 1, Math.round(rect.x + rect.width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.round(rect.y + rect.height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function targetPoint(target: PixelPoint | PixelRect | undefined): PixelPoint | undefined {
  if (!target) return undefined;
  return isPixelRect(target)
    ? { x: target.x + target.width / 2, y: target.y + target.height / 2 }
    : target;
}

function targetRect(target: PixelPoint | PixelRect | undefined): PixelRect | undefined {
  if (!target) return undefined;
  return isPixelRect(target) ? target : { x: target.x - 2, y: target.y - 2, width: 4, height: 4 };
}

function isPixelRect(value: PixelPoint | PixelRect): value is PixelRect {
  return "width" in value && "height" in value;
}

function arrowEndpointOnRect(start: PixelPoint, rect: PixelRect): PixelPoint {
  const center = targetPoint(rect);
  if (!center) return start;
  const vectorX = start.x - center.x;
  const vectorY = start.y - center.y;
  if (vectorX === 0 && vectorY === 0) return center;
  const halfWidth = Math.max(0.5, rect.width / 2);
  const halfHeight = Math.max(0.5, rect.height / 2);
  const scale = 1 / Math.max(Math.abs(vectorX) / halfWidth, Math.abs(vectorY) / halfHeight);
  return {
    x: center.x + vectorX * scale,
    y: center.y + vectorY * scale
  };
}

function escapePango(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Cannot encode a non-finite SVG number.");
  return Number(value.toFixed(3)).toString();
}

function controlledSvg(width: number, height: number, body: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
  );
}

function rectangleBody(rect: PixelRect, style: RenderStyle, radius = 0): string {
  return `<rect x="${svgNumber(rect.x)}" y="${svgNumber(rect.y)}" width="${svgNumber(rect.width)}" height="${svgNumber(rect.height)}" rx="${svgNumber(radius)}" fill="${style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}"/>`;
}

function ellipseBody(rect: PixelRect, style: RenderStyle): string {
  return `<ellipse cx="${svgNumber(rect.x + rect.width / 2)}" cy="${svgNumber(rect.y + rect.height / 2)}" rx="${svgNumber(rect.width / 2)}" ry="${svgNumber(rect.height / 2)}" fill="${style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}"/>`;
}

function arrowBody(start: PixelPoint, end: PixelPoint, style: RenderStyle): string {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(style.arrowHeadSize, style.strokeWidth * 2);
  const wing = Math.PI / 7;
  const first = {
    x: end.x - headLength * Math.cos(angle - wing),
    y: end.y - headLength * Math.sin(angle - wing)
  };
  const second = {
    x: end.x - headLength * Math.cos(angle + wing),
    y: end.y - headLength * Math.sin(angle + wing)
  };
  return `<path d="M ${svgNumber(start.x)} ${svgNumber(start.y)} L ${svgNumber(end.x)} ${svgNumber(end.y)}" fill="none" stroke="${style.strokeColor}" stroke-opacity="${svgNumber(style.opacity)}" stroke-width="${svgNumber(style.strokeWidth)}" stroke-linecap="round"/><path d="M ${svgNumber(end.x)} ${svgNumber(end.y)} L ${svgNumber(first.x)} ${svgNumber(first.y)} L ${svgNumber(second.x)} ${svgNumber(second.y)} Z" fill="${style.strokeColor}" fill-opacity="${svgNumber(style.opacity)}"/>`;
}

function spotlightBody(width: number, height: number, rect: PixelRect, style: RenderStyle): string {
  const pathData = `M 0 0 H ${width} V ${height} H 0 Z M ${svgNumber(rect.x)} ${svgNumber(rect.y)} H ${svgNumber(rect.x + rect.width)} V ${svgNumber(rect.y + rect.height)} H ${svgNumber(rect.x)} Z`;
  return `<path d="${pathData}" fill="${style.fillColor === TRANSPARENT ? "#000000A6" : style.fillColor}" fill-opacity="${svgNumber(style.opacity)}" fill-rule="evenodd" clip-rule="evenodd"/>`;
}

async function compositeStable(base: Buffer, overlays: OverlayOptions[]): Promise<Buffer> {
  return sharp(base).composite(overlays).png(STABLE_PNG_OPTIONS).toBuffer();
}

function estimateTextWidth(text: string, fontSize: number): number {
  let widest = 0;
  for (const line of text.split(/\r?\n/u)) {
    let width = 0;
    for (const character of [...line]) {
      width += (character.codePointAt(0) ?? 0) <= 0xff ? fontSize * 0.58 : fontSize;
    }
    widest = Math.max(widest, width);
  }
  return Math.ceil(widest + 4);
}

async function renderTextSprite(
  text: string,
  style: RenderStyle,
  fontPath: string,
  maximumWidth: number,
  maximumHeight: number
): Promise<TextSprite> {
  const minimumFontSize = 6;
  const safeMaximumWidth = Math.max(1, Math.floor(maximumWidth));
  const safeMaximumHeight = Math.max(1, Math.floor(maximumHeight));
  const requestedFontSize = style.fontSize;
  let fontSize = Math.min(style.fontSize, Math.max(minimumFontSize, safeMaximumHeight));
  for (;;) {
    const desiredWidth = Math.min(
      safeMaximumWidth,
      Math.max(Math.min(64, safeMaximumWidth), estimateTextWidth(text, fontSize))
    );
    const rendered = await sharp({
      text: {
        align: "left",
        font: `Noto Sans CJK SC ${fontSize}`,
        fontfile: fontPath,
        rgba: true,
        spacing: Math.max(0, Math.round(fontSize * (style.lineHeight - 1))),
        text: `<span foreground="${style.textColor}">${escapePango(text)}</span>`,
        width: Math.max(1, Math.floor(desiredWidth)),
        wrap: "word-char"
      }
    })
      .png(STABLE_PNG_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    if (rendered.info.height <= safeMaximumHeight) {
      const buffer =
        style.opacity < 1
          ? await sharp(rendered.data)
              .ensureAlpha()
              .linear([1, 1, 1, style.opacity], [0, 0, 0, 0])
              .png(STABLE_PNG_OPTIONS)
              .toBuffer()
          : rendered.data;
      return {
        buffer,
        width: rendered.info.width,
        height: rendered.info.height,
        fontSize,
        wasShrunk: fontSize < requestedFontSize
      };
    }
    if (fontSize <= minimumFontSize) {
      throw new Error(
        `Text cannot fit within ${safeMaximumWidth}x${safeMaximumHeight} pixels even at the minimum supported font size (${minimumFontSize}px); shorten it, crop the image, or use a larger canvas.`
      );
    }
    fontSize = Math.max(minimumFontSize, fontSize - 2);
  }
}

function clampLabelBox(rect: PixelRect, width: number, height: number, margin: number): PixelRect {
  const maximumX = Math.max(margin, width - margin - rect.width);
  const maximumY = Math.max(margin, height - margin - rect.height);
  return {
    x: Math.round(Math.min(maximumX, Math.max(margin, rect.x))),
    y: Math.round(Math.min(maximumY, Math.max(margin, rect.y))),
    width: Math.min(rect.width, Math.max(1, width - margin * 2)),
    height: Math.min(rect.height, Math.max(1, height - margin * 2))
  };
}

async function renderCallout(
  base: Buffer,
  annotation: RenderableAnnotation,
  width: number,
  height: number,
  fontPath: string,
  occupied: PixelRect[],
  warnings: string[]
): Promise<{ buffer: Buffer; box?: PixelRect; resolved: Record<string, unknown> }> {
  const target = targetRect(annotation.target ?? annotation.rect);
  if (!target) {
    throw new Error(`Callout ${annotation.id} is missing a target.`);
  }
  const safeTarget = integerRect(target, width, height);
  const text = annotation.text ?? "";
  const padding = Math.round(annotation.style.padding);
  const maximumTextWidth = Math.max(
    1,
    Math.min(annotation.style.maxWidth, width - padding * 2 - 8)
  );
  const maximumTextHeight = Math.max(1, height - padding * 2 - 8);
  const sprite = await renderTextSprite(
    text,
    annotation.style,
    fontPath,
    maximumTextWidth,
    maximumTextHeight
  );
  if (sprite.wasShrunk) {
    warnings.push(
      `Callout ${annotation.id} font size was reduced from ${annotation.style.fontSize}px to ${sprite.fontSize}px to keep all text inside the canvas.`
    );
  }
  const labelWidth = Math.min(width - 8, sprite.width + padding * 2);
  const labelHeight = Math.min(height - 8, sprite.height + padding * 2);
  const chosen = placeCallout({
    canvas: { width, height },
    target: safeTarget,
    box: { width: labelWidth, height: labelHeight },
    occupied,
    placement: annotation.placement ?? "auto",
    margin: 4,
    gap: 14
  });
  warnings.push(...chosen.warnings.map((warning) => `Callout ${annotation.id}: ${warning}`));
  const backgroundStyle: RenderStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    opacity: annotation.style.opacity
  };
  const geometry = controlledSvg(
    width,
    height,
    `${arrowBody(chosen.anchor, chosen.targetAnchor, annotation.style)}${rectangleBody(chosen.box, backgroundStyle, annotation.style.cornerRadius)}`
  );
  const textLeft = Math.max(0, Math.round(chosen.box.x + padding));
  const textTop = Math.max(0, Math.round(chosen.box.y + padding));
  const rendered = await compositeStable(base, [
    { input: geometry, left: 0, top: 0 },
    { input: sprite.buffer, left: textLeft, top: textTop }
  ]);
  return {
    buffer: rendered,
    box: chosen.box,
    resolved: {
      id: annotation.id,
      type: annotation.type,
      target: safeTarget,
      box: chosen.box,
      anchor: chosen.anchor,
      targetAnchor: chosen.targetAnchor,
      placement: chosen.placement,
      text,
      fontSize: sprite.fontSize
    }
  };
}

async function renderNumberMarker(
  base: Buffer,
  annotation: RenderableAnnotation,
  number: number,
  width: number,
  height: number,
  fontPath: string
): Promise<{ buffer: Buffer; center: PixelPoint; radius: number; radiusReduced: boolean }> {
  const point = targetPoint(annotation.target ?? annotation.rect ?? annotation.position);
  if (!point) throw new Error(`Numbered callout ${annotation.id} is missing a target.`);
  const desiredRadius = Math.max(13, Math.round(annotation.style.fontSize * 0.72));
  const radius = Math.max(
    3,
    Math.min(desiredRadius, Math.floor((Math.min(width, height) - 2) / 2))
  );
  const center = {
    x: Math.min(width - radius - 1, Math.max(radius + 1, Math.round(point.x))),
    y: Math.min(height - radius - 1, Math.max(radius + 1, Math.round(point.y)))
  };
  const markerStyle: RenderStyle = {
    ...annotation.style,
    fillColor: annotation.style.backgroundColor,
    opacity: annotation.style.opacity
  };
  const markerRect = {
    x: center.x - radius,
    y: center.y - radius,
    width: radius * 2,
    height: radius * 2
  };
  const textStyle = { ...annotation.style, fontSize: Math.max(10, radius), maxWidth: radius * 2 };
  const sprite = await renderTextSprite(
    String(number),
    textStyle,
    fontPath,
    radius * 2,
    radius * 2
  );
  const geometry = controlledSvg(width, height, ellipseBody(markerRect, markerStyle));
  const rendered = await compositeStable(base, [
    { input: geometry, left: 0, top: 0 },
    {
      input: sprite.buffer,
      left: Math.round(center.x - sprite.width / 2),
      top: Math.round(center.y - sprite.height / 2)
    }
  ]);
  return { buffer: rendered, center, radius, radiusReduced: radius < desiredRadius };
}

export async function resolveBundledFontPath(): Promise<string> {
  bundledFontPathPromise ??= (async () => {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDirectory, "../assets/fonts", BUNDLED_FONT_FILENAME),
      path.resolve(moduleDirectory, "../../assets/fonts", BUNDLED_FONT_FILENAME)
    ];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next package layout. Source and bundled builds have different depths.
      }
    }
    throw new Error(
      `Bundled font ${BUNDLED_FONT_FILENAME} was not found beside the AgentCallout package.`
    );
  })();
  return bundledFontPathPromise;
}

function decodeUtf16Be(buffer: Buffer): string {
  const swapped = Buffer.allocUnsafe(buffer.length - (buffer.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = buffer[index + 1] ?? 0;
    swapped[index + 1] = buffer[index] ?? 0;
  }
  return swapped.toString("utf16le").replaceAll("\u0000", "").trim();
}

function readOpenTypeVersion(buffer: Buffer): string {
  if (buffer.length < 12) return "unknown";
  const tableCount = buffer.readUInt16BE(4);
  let nameOffset = -1;
  let nameLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > buffer.length) break;
    if (buffer.toString("ascii", recordOffset, recordOffset + 4) === "name") {
      nameOffset = buffer.readUInt32BE(recordOffset + 8);
      nameLength = buffer.readUInt32BE(recordOffset + 12);
      break;
    }
  }
  if (nameOffset < 0 || nameOffset + nameLength > buffer.length || nameLength < 6) {
    return "unknown";
  }
  const count = buffer.readUInt16BE(nameOffset + 2);
  const stringsOffset = nameOffset + buffer.readUInt16BE(nameOffset + 4);
  const candidates: { priority: number; value: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const recordOffset = nameOffset + 6 + index * 12;
    if (recordOffset + 12 > nameOffset + nameLength) break;
    const platform = buffer.readUInt16BE(recordOffset);
    const language = buffer.readUInt16BE(recordOffset + 4);
    const nameId = buffer.readUInt16BE(recordOffset + 6);
    const length = buffer.readUInt16BE(recordOffset + 8);
    const relativeOffset = buffer.readUInt16BE(recordOffset + 10);
    if (nameId !== 5) continue;
    const start = stringsOffset + relativeOffset;
    const end = start + length;
    if (start < 0 || end > buffer.length) continue;
    const bytes = buffer.subarray(start, end);
    const value =
      platform === 0 || platform === 3 ? decodeUtf16Be(bytes) : bytes.toString("latin1").trim();
    if (value.length > 0) {
      const priority = platform === 3 && language === 0x0409 ? 0 : platform === 3 ? 1 : 2;
      candidates.push({ priority, value });
    }
  }
  candidates.sort((first, second) => first.priority - second.priority);
  return candidates[0]?.value ?? "unknown";
}

export async function getBundledFontInfo(fontPath?: string): Promise<RendererVersions["font"]> {
  if (fontPath) {
    const bytes = await readFile(fontPath);
    return {
      family: "Noto Sans CJK SC",
      file: path.basename(fontPath),
      version: readOpenTypeVersion(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }
  bundledFontInfoPromise ??= (async () => {
    const resolvedPath = await resolveBundledFontPath();
    return getBundledFontInfo(resolvedPath);
  })();
  return bundledFontInfoPromise;
}

export async function getRendererVersions(fontPath?: string): Promise<RendererVersions> {
  return {
    name: RENDERER_NAME,
    version: RENDERER_VERSION,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    font: await getBundledFontInfo(fontPath)
  };
}

export async function renderAnnotations(
  input: Buffer,
  annotations: readonly unknown[],
  options: RenderAnnotationsOptions = {}
): Promise<RenderAnnotationsResult> {
  const limitInputPixels = options.limitInputPixels ?? 40_000_000;
  const normalized = await sharp(input, { failOn: "error", limitInputPixels })
    .autoOrient()
    .toColourspace("srgb")
    .png(STABLE_PNG_OPTIONS)
    .toBuffer({ resolveWithObject: true });
  const width = normalized.info.width;
  const height = normalized.info.height;
  const fontPath = options.fontPath ?? (await resolveBundledFontPath());
  const renderable = annotations.map(normalizeAnnotation);
  const warnings: string[] = [];
  const resolvedAnnotations: Record<string, unknown>[] = [];
  const occupied: PixelRect[] = [];
  let current: Buffer<ArrayBufferLike> = normalized.data;
  let usesBlur = false;
  let usesRedact = false;

  for (let index = 0; index < renderable.length; index += 1) {
    const annotation = renderable[index];
    if (!annotation) continue;
    const style = annotation.style;
    if (
      annotation.type === "rectangle" ||
      annotation.type === "ellipse" ||
      annotation.type === "highlight" ||
      annotation.type === "spotlight" ||
      annotation.type === "blur" ||
      annotation.type === "redact"
    ) {
      if (!annotation.rect) throw new Error(`${annotation.type} ${annotation.id} is missing rect.`);
      const rect = integerRect(annotation.rect, width, height);
      if (annotation.type === "blur") {
        const blurred = await sharp(current)
          .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
          .blur(style.blurSigma)
          .png(STABLE_PNG_OPTIONS)
          .toBuffer();
        current = await compositeStable(current, [{ input: blurred, left: rect.x, top: rect.y }]);
        usesBlur = true;
      } else if (annotation.type === "redact") {
        const overlay = await sharp({
          create: {
            width: rect.width,
            height: rect.height,
            channels: 4,
            background: opaqueColor(style.fillColor)
          }
        })
          .png(STABLE_PNG_OPTIONS)
          .toBuffer();
        current = await compositeStable(current, [{ input: overlay, left: rect.x, top: rect.y }]);
        usesRedact = true;
      } else {
        const body =
          annotation.type === "ellipse"
            ? ellipseBody(rect, style)
            : annotation.type === "spotlight"
              ? spotlightBody(width, height, rect, style)
              : rectangleBody(rect, style, style.cornerRadius);
        current = await compositeStable(current, [
          { input: controlledSvg(width, height, body), left: 0, top: 0 }
        ]);
      }
      resolvedAnnotations.push({ id: annotation.id, type: annotation.type, rect, style });
      continue;
    }

    if (annotation.type === "arrow") {
      const rawTarget = annotation.target ?? annotation.rect;
      const center = targetPoint(rawTarget);
      if (!center) throw new Error(`Arrow ${annotation.id} is missing target.`);
      const safeStart = pointInCanvas(
        annotation.start ?? {
          x: center.x - Math.min(120, width / 4),
          y: center.y - Math.min(90, height / 4)
        },
        width,
        height
      );
      const resolvedTarget =
        rawTarget && isPixelRect(rawTarget) ? integerRect(rawTarget, width, height) : rawTarget;
      const safeEnd = pointInCanvas(
        resolvedTarget && isPixelRect(resolvedTarget)
          ? arrowEndpointOnRect(safeStart, resolvedTarget)
          : (resolvedTarget ?? center),
        width,
        height
      );
      current = await compositeStable(current, [
        {
          input: controlledSvg(width, height, arrowBody(safeStart, safeEnd, style)),
          left: 0,
          top: 0
        }
      ]);
      resolvedAnnotations.push({
        id: annotation.id,
        type: annotation.type,
        start: safeStart,
        target: resolvedTarget,
        end: safeEnd,
        style
      });
      continue;
    }

    if (annotation.type === "text") {
      if (!annotation.position) throw new Error(`Text ${annotation.id} is missing position.`);
      const position = pointInCanvas(annotation.position, width, height);
      const maximumWidth = Math.max(
        1,
        Math.min(style.maxWidth, width - position.x - style.padding * 2)
      );
      const maximumHeight = Math.max(1, height - position.y - style.padding * 2);
      const sprite = await renderTextSprite(
        annotation.text ?? "",
        style,
        fontPath,
        maximumWidth,
        maximumHeight
      );
      if (sprite.wasShrunk) {
        warnings.push(
          `Text ${annotation.id} font size was reduced from ${style.fontSize}px to ${sprite.fontSize}px to keep all text inside the canvas.`
        );
      }
      const box = clampLabelBox(
        {
          x: position.x,
          y: position.y,
          width: Math.min(width, sprite.width + style.padding * 2),
          height: Math.min(height, sprite.height + style.padding * 2)
        },
        width,
        height,
        0
      );
      if (box.x !== position.x || box.y !== position.y) {
        warnings.push(
          `Text ${annotation.id} was moved from (${position.x}, ${position.y}) to (${box.x}, ${box.y}) to keep all text inside the canvas.`
        );
      }
      const backgroundStyle = {
        ...style,
        fillColor: style.backgroundColor,
        opacity: style.backgroundColor === "transparent" ? 0 : style.opacity
      };
      const overlays: OverlayOptions[] = [];
      if (backgroundStyle.opacity > 0) {
        overlays.push({
          input: controlledSvg(
            width,
            height,
            rectangleBody(box, backgroundStyle, style.cornerRadius)
          ),
          left: 0,
          top: 0
        });
      }
      overlays.push({
        input: sprite.buffer,
        left: Math.round(box.x + style.padding),
        top: Math.round(box.y + style.padding)
      });
      current = await compositeStable(current, overlays);
      occupied.push(box);
      resolvedAnnotations.push({
        id: annotation.id,
        type: annotation.type,
        position,
        box,
        text: annotation.text ?? "",
        fontSize: sprite.fontSize
      });
      continue;
    }

    if (annotation.type === "numbered-callout") {
      const number = annotation.number ?? index + 1;
      const marker = await renderNumberMarker(current, annotation, number, width, height, fontPath);
      const requestedMarkerPoint = targetPoint(
        annotation.target ?? annotation.rect ?? annotation.position
      );
      if (
        requestedMarkerPoint &&
        (marker.center.x !== Math.round(requestedMarkerPoint.x) ||
          marker.center.y !== Math.round(requestedMarkerPoint.y))
      ) {
        warnings.push(
          `Numbered callout ${annotation.id} marker was moved to stay inside the canvas.`
        );
      }
      if (marker.radiusReduced) {
        warnings.push(
          `Numbered callout ${annotation.id} marker radius was reduced to fit the canvas.`
        );
      }
      const markerBox = {
        x: marker.center.x - marker.radius,
        y: marker.center.y - marker.radius,
        width: marker.radius * 2,
        height: marker.radius * 2
      };
      occupied.push(markerBox);
      current = marker.buffer;
      if ((annotation.text ?? "").length > 0) {
        const callout = await renderCallout(
          current,
          annotation,
          width,
          height,
          fontPath,
          occupied,
          warnings
        );
        current = callout.buffer;
        if (callout.box) occupied.push(callout.box);
        resolvedAnnotations.push({
          ...callout.resolved,
          number,
          marker: { center: marker.center, radius: marker.radius }
        });
      } else {
        resolvedAnnotations.push({
          id: annotation.id,
          type: annotation.type,
          number,
          marker: { center: marker.center, radius: marker.radius }
        });
      }
      continue;
    }

    const callout = await renderCallout(
      current,
      annotation,
      width,
      height,
      fontPath,
      occupied,
      warnings
    );
    current = callout.buffer;
    if (callout.box) occupied.push(callout.box);
    resolvedAnnotations.push(callout.resolved);
  }

  const decoded = await sharp(current, { failOn: "error", limitInputPixels }).metadata();
  if (decoded.format !== "png" || decoded.width !== width || decoded.height !== height) {
    throw new Error("Renderer output failed PNG re-decode validation.");
  }
  return {
    buffer: current,
    width,
    height,
    warnings,
    usesBlur,
    usesRedact,
    resolvedAnnotations,
    renderer: await getRendererVersions(fontPath)
  };
}
