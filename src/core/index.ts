import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp, { type Metadata, type OverlayOptions } from "sharp";

import {
  canonicalizeSpec,
  parseAnnotationSpec,
  resolveAnnotationSpec,
  type AnnotationSpec,
  type Rect,
  type ResolvedAnnotationSpec
} from "../spec/index.js";
import {
  BUNDLED_FONT_SHA256,
  STABLE_PNG_OPTIONS,
  getBundledFontInfo,
  getRendererVersions,
  renderAnnotations,
  resolveBundledFontPath,
  type RendererVersions
} from "../renderer/index.js";

export const DEFAULT_IMAGE_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1024 * 1024,
  maxPixels: 40_000_000
});

export interface Dimensions {
  width: number;
  height: number;
}

export interface ImageLimits {
  maxFileBytes: number;
  maxPixels: number;
}

export interface ImageSafetyOptions {
  allowedRoots?: readonly string[] | undefined;
  limits?: Partial<ImageLimits> | undefined;
  maxFileBytes?: number | undefined;
  maxPixels?: number | undefined;
}

export interface ImageInspection {
  path: string;
  format: "png" | "jpeg" | "webp";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  dimensions: Dimensions;
  storedDimensions: Dimensions;
  orientation: number | null;
  pages: number;
  hasAlpha: boolean;
  sha256: string;
}

export interface SpecValidationResult {
  valid: true;
  input: ImageInspection;
  spec: AnnotationSpec;
  resolvedSpec: ResolvedAnnotationSpec;
  annotationCount: number;
  warnings: string[];
  inputSha256: string;
  specSha256: string;
  usesBlur: boolean;
  usesRedact: boolean;
}

export interface GeneratedImageResult {
  operation: "annotate" | "crop" | "contact-sheet" | "preview";
  outputPath: string;
  sidecarPath: string;
  markdown: string;
  originalDimensions: Dimensions | Dimensions[];
  outputDimensions: Dimensions;
  annotationCount: number;
  warnings: string[];
  inputSha256: string;
  specSha256: string;
  outputSha256: string;
  usesBlur: boolean;
  usesRedact: boolean;
  renderer: RendererVersions;
}

export interface CoreDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CoreDoctorReport {
  ok: boolean;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  renderer: RendererVersions | null;
  expectedFontSha256: string;
  checks: CoreDoctorCheck[];
  warnings: string[];
}

export interface ValidateSpecForImageArguments extends ImageSafetyOptions {
  inputPath: string;
  spec: unknown;
}

export interface AnnotateImageArguments extends ValidateSpecForImageArguments {
  outputPath?: string | undefined;
  overwrite?: boolean | undefined;
}

export interface CropImageArguments extends ImageSafetyOptions {
  inputPath: string;
  rect: Rect;
  coordinateSpace?: "pixel" | "normalized" | undefined;
  outputPath?: string | undefined;
  overwrite?: boolean | undefined;
}

export interface CreateContactSheetArguments extends ImageSafetyOptions {
  inputPaths: string[];
  outputPath?: string | undefined;
  columns?: number | undefined;
  cellWidth?: number | undefined;
  cellHeight?: number | undefined;
  padding?: number | undefined;
  background?: string | undefined;
  labels?: boolean | undefined;
  overwrite?: boolean | undefined;
}

export interface CreateImagePreviewArguments extends ImageSafetyOptions {
  inputPath: string;
  outputPath?: string | undefined;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  overwrite?: boolean | undefined;
}

interface LoadedImage {
  inspection: ImageInspection;
  bytes: Buffer;
  limits: ImageLimits;
}

interface InputManifestRecord {
  path: string;
  pathSemantics: "relative-to-sidecar" | "basename-only-resolve-by-sha256";
  format: string;
  sha256: string;
  sizeBytes: number;
  dimensions: Dimensions;
  storedDimensions: Dimensions;
  orientation: number | null;
}

interface FileIdentity {
  device: bigint;
  inode: bigint;
}

interface PortablePathReference {
  path: string;
  semantics: "relative-to-sidecar" | "basename-only-resolve-by-sha256";
}

interface FinalizeGeneratedArguments {
  operation: GeneratedImageResult["operation"];
  outputPath: string;
  overwrite: boolean;
  allowedRoots?: readonly string[] | undefined;
  output: Buffer;
  outputDimensions: Dimensions;
  inputs: ImageInspection[];
  originalDimensions: Dimensions | Dimensions[];
  operationSpec: unknown;
  parsedAnnotationSpec?: AnnotationSpec | undefined;
  canonicalSpecSha256?: string | undefined;
  resolvedAnnotations?: Record<string, unknown>[] | undefined;
  annotationCount: number;
  warnings: string[];
  usesBlur: boolean;
  usesRedact: boolean;
  renderer: RendererVersions;
  limits: ImageLimits;
}

const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);
const MIME_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
} as const;
const SAFE_CONTACT_COLORS = new Set(["black", "gray", "grey", "transparent", "white"]);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mergeLimits(options: ImageSafetyOptions): ImageLimits {
  const maxFileBytes =
    options.maxFileBytes ?? options.limits?.maxFileBytes ?? DEFAULT_IMAGE_LIMITS.maxFileBytes;
  const maxPixels =
    options.maxPixels ?? options.limits?.maxPixels ?? DEFAULT_IMAGE_LIMITS.maxPixels;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new RangeError("maxFileBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new RangeError("maxPixels must be a positive safe integer.");
  }
  return { maxFileBytes, maxPixels };
}

function requestedRoots(allowedRoots: readonly string[] | undefined): string[] {
  const roots =
    allowedRoots && allowedRoots.length > 0 ? [...allowedRoots] : [process.cwd(), tmpdir()];
  if (roots.length > 64) throw new RangeError("At most 64 allowed roots may be supplied.");
  if (roots.some((root) => typeof root !== "string" || root.trim() === "")) {
    throw new TypeError("Allowed roots must be non-empty paths.");
  }
  return roots;
}

async function canonicalRoots(allowedRoots: readonly string[] | undefined): Promise<string[]> {
  const roots = await Promise.all(
    requestedRoots(allowedRoots).map(async (root) => {
      const canonical = await realpath(path.resolve(root));
      const information = await stat(canonical);
      if (!information.isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
      return canonical;
    })
  );
  return [...new Set(roots)];
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertInsideRoots(candidate: string, roots: readonly string[], description: string): void {
  if (!roots.some((root) => isInsideRoot(candidate, root))) {
    throw new Error(`${description} is outside the allowed roots.`);
  }
}

async function canonicalInputPath(
  inputPath: string,
  allowedRoots: readonly string[] | undefined
): Promise<string> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new TypeError("inputPath must be a non-empty path.");
  }
  const roots = await canonicalRoots(allowedRoots);
  const canonical = await realpath(path.resolve(inputPath));
  assertInsideRoots(canonical, roots, "Input path");
  const information = await stat(canonical);
  if (!information.isFile()) throw new Error("Input path must identify a regular file.");
  return canonical;
}

async function canonicalOutputPath(
  outputPath: string,
  allowedRoots: readonly string[] | undefined
): Promise<string> {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new TypeError("outputPath must be a non-empty path.");
  }
  const absolute = path.resolve(outputPath);
  if (path.extname(absolute).toLowerCase() !== ".png") {
    throw new Error("AgentCallout outputs must use a .png extension.");
  }
  return canonicalWritablePath(absolute, allowedRoots, "Output");
}

async function canonicalWritablePath(
  absolutePath: string,
  allowedRoots: readonly string[] | undefined,
  description: string
): Promise<string> {
  const roots = await canonicalRoots(allowedRoots);
  const parent = await realpath(path.dirname(absolutePath));
  assertInsideRoots(parent, roots, `${description} directory`);
  const candidate = path.join(parent, path.basename(absolutePath));
  try {
    const existing = await realpath(candidate);
    assertInsideRoots(existing, roots, `${description} path`);
    return existing;
  } catch (error) {
    if (isMissingPathError(error)) {
      try {
        const linkInformation = await lstat(candidate);
        if (linkInformation.isSymbolicLink()) {
          throw new Error(`${description} path is a broken symbolic link.`);
        }
      } catch (linkError) {
        if (!isMissingPathError(linkError)) throw linkError;
      }
      return candidate;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function existingFileIdentity(candidate: string): Promise<FileIdentity | null> {
  try {
    const information = await stat(candidate, { bigint: true });
    return { device: information.dev, inode: information.ino };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function assertTargetsDoNotAliasInputs(
  targets: readonly string[],
  inputs: readonly ImageInspection[]
): Promise<void> {
  const inputIdentities = await Promise.all(
    inputs.map(async (input) => ({
      path: input.path,
      identity: await existingFileIdentity(input.path)
    }))
  );
  const targetIdentities = await Promise.all(
    targets.map(async (target) => ({
      path: target,
      identity: await existingFileIdentity(target)
    }))
  );

  for (const target of targetIdentities) {
    for (const input of inputIdentities) {
      if (
        target.path === input.path ||
        (target.identity !== null &&
          input.identity !== null &&
          sameFileIdentity(target.identity, input.identity))
      ) {
        throw new Error("Output and sidecar paths must not overwrite or alias any input image.");
      }
    }
  }

  const [output, sidecar] = targetIdentities;
  if (
    output?.identity !== null &&
    output?.identity !== undefined &&
    sidecar?.identity !== null &&
    sidecar?.identity !== undefined &&
    sameFileIdentity(output.identity, sidecar.identity)
  ) {
    throw new Error("Output and sidecar paths must not alias the same file.");
  }
}

function defaultOutputPath(inputPath: string, suffix: string): string {
  const extension = path.extname(inputPath);
  const stem = path.basename(inputPath, extension);
  return path.join(path.dirname(inputPath), `${stem}.${suffix}.png`);
}

async function metadataFor(bytes: Buffer, limits: ImageLimits): Promise<Metadata> {
  try {
    return await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxPixels
    }).metadata();
  } catch (error) {
    throw new Error(`Could not decode image safely: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : String(error);
}

async function loadImage(inputPath: string, options: ImageSafetyOptions): Promise<LoadedImage> {
  const limits = mergeLimits(options);
  const canonicalPath = await canonicalInputPath(inputPath, options.allowedRoots);
  const information = await stat(canonicalPath);
  if (information.size > limits.maxFileBytes) {
    throw new Error(
      `Input image is ${information.size} bytes; the limit is ${limits.maxFileBytes} bytes.`
    );
  }
  const bytes = await readFile(canonicalPath);
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new Error(
      `Input image is ${bytes.byteLength} bytes; the limit is ${limits.maxFileBytes} bytes.`
    );
  }
  const metadata = await metadataFor(bytes, limits);
  if (!ACCEPTED_FORMATS.has(metadata.format)) {
    throw new Error(
      `Unsupported image format ${JSON.stringify(metadata.format)}; expected PNG, JPEG, or WebP.`
    );
  }
  const pages = metadata.pages ?? 1;
  if (pages !== 1) throw new Error("Animated or multi-page images are not supported.");
  const storedPixels = metadata.width * metadata.height;
  if (!Number.isSafeInteger(storedPixels) || storedPixels > limits.maxPixels) {
    throw new Error(`Input image has ${storedPixels} pixels; the limit is ${limits.maxPixels}.`);
  }
  const format = metadata.format as ImageInspection["format"];
  const inspection: ImageInspection = {
    path: canonicalPath,
    format,
    mimeType: MIME_TYPES[format],
    sizeBytes: bytes.byteLength,
    dimensions: {
      width: metadata.autoOrient.width,
      height: metadata.autoOrient.height
    },
    storedDimensions: { width: metadata.width, height: metadata.height },
    orientation: metadata.orientation ?? null,
    pages,
    hasAlpha: metadata.hasAlpha,
    sha256: sha256(bytes)
  };
  return { inspection, bytes, limits };
}

async function normalizedPng(
  bytes: Buffer,
  limits: ImageLimits
): Promise<{ data: Buffer; dimensions: Dimensions }> {
  const result = await sharp(bytes, {
    failOn: "error",
    limitInputPixels: limits.maxPixels
  })
    .autoOrient()
    .toColourspace("srgb")
    .png(STABLE_PNG_OPTIONS)
    .toBuffer({ resolveWithObject: true });
  return {
    data: result.data,
    dimensions: { width: result.info.width, height: result.info.height }
  };
}

async function verifyPng(bytes: Buffer, expected: Dimensions, limits: ImageLimits): Promise<void> {
  const metadata = await sharp(bytes, {
    failOn: "error",
    limitInputPixels: limits.maxPixels
  }).metadata();
  if (
    metadata.format !== "png" ||
    metadata.width !== expected.width ||
    metadata.height !== expected.height
  ) {
    throw new Error("Generated image failed PNG re-decode validation.");
  }
}

function sortJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) sorted[key] = sortJson(nested);
    }
    return sorted;
  }
  throw new TypeError(`Cannot serialize ${typeof value} in a deterministic manifest.`);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function portablePathReference(sidecarDirectory: string, target: string): PortablePathReference {
  const relative = path.relative(sidecarDirectory, target);
  if (path.isAbsolute(relative)) {
    return {
      path: path.basename(target),
      semantics: "basename-only-resolve-by-sha256"
    };
  }
  return {
    path: (relative || path.basename(target)).split(path.sep).join("/"),
    semantics: "relative-to-sidecar"
  };
}

function markdownPath(target: string, alt: string): string {
  const portable = target.split(path.sep).join("/");
  return `![${alt}](<${portable}>)`;
}

function relativeMarkdown(target: string, alt: string): string {
  return `![${alt}](<${target}>)`;
}

function manifestInput(
  inspection: ImageInspection,
  reference: PortablePathReference
): InputManifestRecord {
  return {
    path: reference.path,
    pathSemantics: reference.semantics,
    format: inspection.format,
    sha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes,
    dimensions: inspection.dimensions,
    storedDimensions: inspection.storedDimensions,
    orientation: inspection.orientation
  };
}

async function finalizeGenerated(
  arguments_: FinalizeGeneratedArguments
): Promise<GeneratedImageResult> {
  const outputPath = await canonicalOutputPath(arguments_.outputPath, arguments_.allowedRoots);
  const sidecarPath = path.join(
    path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.json`
  );
  const canonicalSidecarPath = await canonicalWritablePath(
    sidecarPath,
    arguments_.allowedRoots,
    "Sidecar"
  );
  await assertTargetsDoNotAliasInputs([outputPath, canonicalSidecarPath], arguments_.inputs);
  if (!arguments_.overwrite) {
    if (await pathExists(outputPath)) {
      throw new Error(`Output already exists; pass overwrite: true to replace it: ${outputPath}`);
    }
    if (await pathExists(canonicalSidecarPath)) {
      throw new Error(
        `Sidecar already exists; pass overwrite: true to replace it: ${canonicalSidecarPath}`
      );
    }
  }
  await verifyPng(arguments_.output, arguments_.outputDimensions, arguments_.limits);

  const operationSpecJson = stableJson(arguments_.operationSpec).trimEnd();
  const specSha256 = arguments_.canonicalSpecSha256 ?? sha256(operationSpecJson);
  const inputSha256 =
    arguments_.inputs.length === 1
      ? (arguments_.inputs[0]?.sha256 ?? sha256(""))
      : sha256(stableJson(arguments_.inputs.map((input) => input.sha256)).trimEnd());
  const outputSha256 = sha256(arguments_.output);
  const sidecarDirectory = path.dirname(canonicalSidecarPath);
  const outputReference = portablePathReference(sidecarDirectory, outputPath);
  const inputReferences = arguments_.inputs.map((input) =>
    portablePathReference(sidecarDirectory, input.path)
  );
  const allInputsAreSidecarRelative = inputReferences.every(
    (reference) => reference.semantics === "relative-to-sidecar"
  );
  const manifest: Record<string, unknown> = {
    manifestVersion: "1.0",
    operation: arguments_.operation,
    pathSemantics: allInputsAreSidecarRelative
      ? "relative-to-sidecar"
      : "per-input; see inputs[].pathSemantics",
    paths: {
      inputs: inputReferences.map((reference) => reference.path),
      output: outputReference.path,
      sidecar: path.basename(canonicalSidecarPath)
    },
    inputs: arguments_.inputs.map((input, index) =>
      manifestInput(input, inputReferences[index] as PortablePathReference)
    ),
    operationSpec: arguments_.operationSpec,
    hashes: {
      inputSha256,
      specSha256,
      outputSha256
    },
    originalDimensions: arguments_.originalDimensions,
    outputDimensions: arguments_.outputDimensions,
    annotationCount: arguments_.annotationCount,
    warnings: arguments_.warnings,
    usesBlur: arguments_.usesBlur,
    usesRedact: arguments_.usesRedact,
    renderer: arguments_.renderer,
    security: {
      exifOrientationApplied: true,
      metadataStripped: true,
      outputReDecoded: true,
      blurIsSecureRedaction: false,
      redactUsesOpaqueOverwrite: arguments_.usesRedact
    },
    markdown: relativeMarkdown(outputReference.path, "AgentCallout output")
  };
  if (arguments_.parsedAnnotationSpec) {
    manifest.annotationSpec = arguments_.parsedAnnotationSpec;
  }
  if (arguments_.resolvedAnnotations) {
    manifest.resolvedAnnotations = arguments_.resolvedAnnotations;
  }
  const sidecarBytes = Buffer.from(stableJson(manifest), "utf8");
  const flag = arguments_.overwrite ? "w" : "wx";
  if (arguments_.overwrite) {
    await writeFile(outputPath, arguments_.output, { flag });
    await writeFile(canonicalSidecarPath, sidecarBytes, { flag });
  } else {
    await writeFile(outputPath, arguments_.output, { flag });
    try {
      await writeFile(canonicalSidecarPath, sidecarBytes, { flag });
    } catch (error) {
      await rm(outputPath, { force: true });
      throw error;
    }
  }

  return {
    operation: arguments_.operation,
    outputPath,
    sidecarPath: canonicalSidecarPath,
    markdown: markdownPath(outputPath, "AgentCallout output"),
    originalDimensions: arguments_.originalDimensions,
    outputDimensions: arguments_.outputDimensions,
    annotationCount: arguments_.annotationCount,
    warnings: arguments_.warnings,
    inputSha256,
    specSha256,
    outputSha256,
    usesBlur: arguments_.usesBlur,
    usesRedact: arguments_.usesRedact,
    renderer: arguments_.renderer
  };
}

export async function inspectImage(
  inputPath: string,
  options: ImageSafetyOptions = {}
): Promise<ImageInspection> {
  return (await loadImage(inputPath, options)).inspection;
}

export async function validateSpecForImage(
  arguments_: ValidateSpecForImageArguments
): Promise<SpecValidationResult> {
  const loaded = await loadImage(arguments_.inputPath, arguments_);
  const spec = parseAnnotationSpec(arguments_.spec);
  const resolution = resolveAnnotationSpec(spec, loaded.inspection.dimensions);
  const canonical = canonicalizeSpec(spec);
  return {
    valid: true,
    input: loaded.inspection,
    spec,
    resolvedSpec: resolution.spec,
    annotationCount: resolution.spec.annotations.length,
    warnings: resolution.warnings,
    inputSha256: loaded.inspection.sha256,
    specSha256: sha256(canonical),
    usesBlur: resolution.spec.annotations.some((annotation) => annotation.type === "blur"),
    usesRedact: resolution.spec.annotations.some((annotation) => annotation.type === "redact")
  };
}

export async function annotateImage(
  arguments_: AnnotateImageArguments
): Promise<GeneratedImageResult> {
  const loaded = await loadImage(arguments_.inputPath, arguments_);
  const spec = parseAnnotationSpec(arguments_.spec);
  const resolution = resolveAnnotationSpec(spec, loaded.inspection.dimensions);
  const rendered = await renderAnnotations(loaded.bytes, resolution.spec.annotations, {
    limitInputPixels: loaded.limits.maxPixels
  });
  const warnings = [...resolution.warnings, ...rendered.warnings];
  return finalizeGenerated({
    operation: "annotate",
    outputPath: arguments_.outputPath ?? defaultOutputPath(loaded.inspection.path, "annotated"),
    overwrite: arguments_.overwrite ?? false,
    allowedRoots: arguments_.allowedRoots,
    output: rendered.buffer,
    outputDimensions: { width: rendered.width, height: rendered.height },
    inputs: [loaded.inspection],
    originalDimensions: loaded.inspection.dimensions,
    operationSpec: spec,
    parsedAnnotationSpec: spec,
    canonicalSpecSha256: sha256(canonicalizeSpec(spec)),
    resolvedAnnotations: rendered.resolvedAnnotations,
    annotationCount: resolution.spec.annotations.length,
    warnings,
    usesBlur: rendered.usesBlur,
    usesRedact: rendered.usesRedact,
    renderer: rendered.renderer,
    limits: loaded.limits
  });
}

function resolveCropRect(
  rect: Rect,
  coordinateSpace: "pixel" | "normalized",
  dimensions: Dimensions
): Rect {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    throw new RangeError("Crop rectangle values must be finite numbers.");
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RangeError("Crop rectangle width and height must be greater than zero.");
  }
  if (coordinateSpace === "normalized") {
    if (
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width > 1 ||
      rect.height > 1 ||
      rect.x + rect.width > 1 ||
      rect.y + rect.height > 1
    ) {
      throw new RangeError("Normalized crop rectangle must fit entirely within 0..1.");
    }
  }
  const raw =
    coordinateSpace === "normalized"
      ? {
          x: rect.x * dimensions.width,
          y: rect.y * dimensions.height,
          width: rect.width * dimensions.width,
          height: rect.height * dimensions.height
        }
      : rect;
  const left = Math.floor(raw.x);
  const top = Math.floor(raw.y);
  const right = Math.ceil(raw.x + raw.width);
  const bottom = Math.ceil(raw.y + raw.height);
  if (
    left < 0 ||
    top < 0 ||
    right > dimensions.width ||
    bottom > dimensions.height ||
    right <= left ||
    bottom <= top
  ) {
    throw new RangeError(
      `Crop rectangle must fit within the ${dimensions.width}x${dimensions.height} image.`
    );
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function cropImage(arguments_: CropImageArguments): Promise<GeneratedImageResult> {
  const loaded = await loadImage(arguments_.inputPath, arguments_);
  const normalized = await normalizedPng(loaded.bytes, loaded.limits);
  const coordinateSpace = arguments_.coordinateSpace ?? "pixel";
  const rect = resolveCropRect(arguments_.rect, coordinateSpace, normalized.dimensions);
  const output = await sharp(normalized.data)
    .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
    .png(STABLE_PNG_OPTIONS)
    .toBuffer();
  return finalizeGenerated({
    operation: "crop",
    outputPath: arguments_.outputPath ?? defaultOutputPath(loaded.inspection.path, "crop"),
    overwrite: arguments_.overwrite ?? false,
    allowedRoots: arguments_.allowedRoots,
    output,
    outputDimensions: { width: rect.width, height: rect.height },
    inputs: [loaded.inspection],
    originalDimensions: loaded.inspection.dimensions,
    operationSpec: { coordinateSpace, rect },
    annotationCount: 0,
    warnings: [],
    usesBlur: false,
    usesRedact: false,
    renderer: await getRendererVersions(),
    limits: loaded.limits
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return candidate;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return candidate;
}

function safeContactColor(value: string | undefined): string {
  const candidate = (value ?? "#f3f4f6").trim().toLowerCase();
  if (/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(candidate)) return candidate;
  if (SAFE_CONTACT_COLORS.has(candidate)) return candidate;
  throw new Error("Contact sheet background must be #RRGGBB, #RRGGBBAA, or a safe named color.");
}

function escapePango(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function createContactSheet(
  arguments_: CreateContactSheetArguments
): Promise<GeneratedImageResult> {
  if (!Array.isArray(arguments_.inputPaths) || arguments_.inputPaths.length === 0) {
    throw new TypeError("inputPaths must contain at least one image path.");
  }
  if (arguments_.inputPaths.length > 64) {
    throw new RangeError("A contact sheet may contain at most 64 images.");
  }
  const loaded = await Promise.all(
    arguments_.inputPaths.map((inputPath) => loadImage(inputPath, arguments_))
  );
  const limits = mergeLimits(arguments_);
  const columns = positiveInteger(
    arguments_.columns,
    Math.ceil(Math.sqrt(loaded.length)),
    "columns"
  );
  if (columns > 16) throw new RangeError("columns must not exceed 16.");
  const cellWidth = positiveInteger(arguments_.cellWidth, 320, "cellWidth");
  const cellHeight = positiveInteger(arguments_.cellHeight, 240, "cellHeight");
  const padding = nonNegativeInteger(arguments_.padding, 12, "padding");
  const labels = arguments_.labels ?? true;
  const labelHeight = labels ? 28 : 0;
  const innerWidth = cellWidth - padding * 2;
  const innerHeight = cellHeight - padding * 2 - labelHeight;
  if (innerWidth <= 0 || innerHeight <= 0) {
    throw new RangeError("Contact sheet padding and label area leave no room for image content.");
  }
  const rows = Math.ceil(loaded.length / columns);
  const outputDimensions = {
    width: columns * cellWidth + (columns + 1) * padding,
    height: rows * cellHeight + (rows + 1) * padding
  };
  const outputPixels = outputDimensions.width * outputDimensions.height;
  if (!Number.isSafeInteger(outputPixels) || outputPixels > limits.maxPixels) {
    throw new Error(
      `Contact sheet would contain ${outputPixels} pixels; the limit is ${limits.maxPixels}.`
    );
  }
  const background = safeContactColor(arguments_.background);
  const fontPath = await resolveBundledFontPath();
  const overlays: OverlayOptions[] = [];
  for (let index = 0; index < loaded.length; index += 1) {
    const item = loaded[index];
    if (!item) continue;
    const normalized = await normalizedPng(item.bytes, item.limits);
    const thumbnail = await sharp(normalized.data)
      .resize({
        width: innerWidth,
        height: innerHeight,
        fit: "contain",
        background,
        kernel: "lanczos3"
      })
      .png(STABLE_PNG_OPTIONS)
      .toBuffer();
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = padding + column * (cellWidth + padding) + padding;
    const top = padding + row * (cellHeight + padding) + padding;
    overlays.push({ input: thumbnail, left, top });
    if (labels) {
      const label = await sharp({
        text: {
          text: `<span foreground="#1f2937">${escapePango(path.basename(item.inspection.path))}</span>`,
          font: "Noto Sans CJK SC 13",
          fontfile: fontPath,
          width: innerWidth,
          height: labelHeight,
          align: "center",
          rgba: true,
          wrap: "word-char"
        }
      })
        .png(STABLE_PNG_OPTIONS)
        .toBuffer();
      overlays.push({ input: label, left, top: top + innerHeight });
    }
  }
  const output = await sharp({
    create: {
      width: outputDimensions.width,
      height: outputDimensions.height,
      channels: 4,
      background
    }
  })
    .composite(overlays)
    .png(STABLE_PNG_OPTIONS)
    .toBuffer();
  const firstInput = loaded[0];
  if (!firstInput) throw new Error("Contact sheet input disappeared unexpectedly.");
  return finalizeGenerated({
    operation: "contact-sheet",
    outputPath:
      arguments_.outputPath ??
      path.join(path.dirname(firstInput.inspection.path), "contact-sheet.png"),
    overwrite: arguments_.overwrite ?? false,
    allowedRoots: arguments_.allowedRoots,
    output,
    outputDimensions,
    inputs: loaded.map((item) => item.inspection),
    originalDimensions: loaded.map((item) => item.inspection.dimensions),
    operationSpec: {
      columns,
      cellWidth,
      cellHeight,
      padding,
      background,
      labels
    },
    annotationCount: 0,
    warnings: [],
    usesBlur: false,
    usesRedact: false,
    renderer: await getRendererVersions(fontPath),
    limits
  });
}

export async function createImagePreview(
  arguments_: CreateImagePreviewArguments
): Promise<GeneratedImageResult> {
  const loaded = await loadImage(arguments_.inputPath, arguments_);
  const maxWidth = positiveInteger(arguments_.maxWidth, 1280, "maxWidth");
  const maxHeight = positiveInteger(arguments_.maxHeight, 1280, "maxHeight");
  const normalized = await normalizedPng(loaded.bytes, loaded.limits);
  const resized = await sharp(normalized.data)
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      kernel: "lanczos3",
      withoutEnlargement: true
    })
    .png(STABLE_PNG_OPTIONS)
    .toBuffer({ resolveWithObject: true });
  const outputDimensions = { width: resized.info.width, height: resized.info.height };
  return finalizeGenerated({
    operation: "preview",
    outputPath: arguments_.outputPath ?? defaultOutputPath(loaded.inspection.path, "preview"),
    overwrite: arguments_.overwrite ?? false,
    allowedRoots: arguments_.allowedRoots,
    output: resized.data,
    outputDimensions,
    inputs: [loaded.inspection],
    originalDimensions: loaded.inspection.dimensions,
    operationSpec: { maxWidth, maxHeight },
    annotationCount: 0,
    warnings: [],
    usesBlur: false,
    usesRedact: false,
    renderer: await getRendererVersions(),
    limits: loaded.limits
  });
}

export async function getCoreDoctorReport(): Promise<CoreDoctorReport> {
  const checks: CoreDoctorCheck[] = [];
  const warnings: string[] = [];
  let renderer: RendererVersions | null = null;
  try {
    renderer = await getRendererVersions();
    checks.push({
      name: "sharp",
      ok: typeof sharp.versions.sharp === "string" && typeof sharp.versions.vips === "string",
      detail: `Sharp ${sharp.versions.sharp}; libvips ${sharp.versions.vips}`
    });
  } catch (error) {
    checks.push({ name: "sharp", ok: false, detail: errorMessage(error) });
  }
  try {
    const fontPath = await resolveBundledFontPath();
    const font = await getBundledFontInfo(fontPath);
    const matches = font.sha256 === BUNDLED_FONT_SHA256;
    checks.push({
      name: "bundled-font",
      ok: matches,
      detail: `${font.file}; ${font.version}; SHA-256 ${font.sha256}`
    });
    if (!matches) warnings.push("Bundled font hash does not match NOTICE.");
    const sample = await sharp({
      text: {
        text: '<span foreground="#000000">AI 截图批注笔 AgentCallout</span>',
        font: "Noto Sans CJK SC 18",
        fontfile: fontPath,
        width: 360,
        rgba: true,
        wrap: "word-char"
      }
    })
      .png(STABLE_PNG_OPTIONS)
      .toBuffer();
    const decoded = await sharp(sample).metadata();
    checks.push({
      name: "text-render",
      ok: decoded.format === "png" && decoded.width > 0 && decoded.height > 0,
      detail: `Rendered and decoded ${decoded.width}x${decoded.height} Chinese/English text sprite.`
    });
  } catch (error) {
    checks.push({ name: "bundled-font", ok: false, detail: errorMessage(error) });
  }
  return {
    ok: checks.length > 0 && checks.every((check) => check.ok),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    renderer,
    expectedFontSha256: BUNDLED_FONT_SHA256,
    checks,
    warnings
  };
}
