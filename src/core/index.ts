import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp, { type Metadata, type OverlayOptions } from "sharp";

import {
  MAX_ANNOTATIONS,
  MAX_TOTAL_TEXT_LENGTH,
  canonicalizeSpec,
  parseAnnotationSpec,
  parseAnnotationRevisionEdits,
  resolveAnnotationSpec,
  type AnnotationRevisionEdit,
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

export const REVISION_ERROR_CODES = [
  "PARENT_SIDECAR_INVALID",
  "PARENT_OUTPUT_MISMATCH",
  "PARENT_SPEC_MISMATCH",
  "INPUT_REQUIRED",
  "INPUT_INVALID",
  "INPUT_HASH_MISMATCH",
  "REVISION_EDITS_INVALID",
  "REVISION_LIMIT_REACHED",
  "REVISION_CONFLICT",
  "REVISION_PUBLISH_FAILED",
  "REVISION_RECOVERY_REQUIRED"
] as const;

export type RevisionErrorCode = (typeof REVISION_ERROR_CODES)[number];

export class AgentCalloutRevisionError extends Error {
  public override readonly name = "AgentCalloutRevisionError";

  public constructor(
    public readonly code: RevisionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export const REVISION_FAULT_POINTS = [
  "lock-write",
  "lock-flush",
  "lock-close",
  "lock-remove",
  "temp-png-write",
  "temp-png-flush",
  "temp-png-remove",
  "temp-sidecar-write",
  "temp-sidecar-flush",
  "temp-sidecar-remove",
  "png-publish",
  "png-verify",
  "sidecar-publish",
  "sidecar-verify",
  "rollback-png"
] as const;

export type RevisionFaultPoint = (typeof REVISION_FAULT_POINTS)[number];

export interface RevisionResult extends GeneratedImageResult {
  revision: {
    number: number;
    lineageId: string;
    parentSidecarPath: string;
    editsSha256: string;
  };
  /** Post-commit transaction cleanup issues; render warnings remain sidecar-authoritative. */
  recoveryWarnings?: string[];
}

export interface CoreDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CoreDoctorReport {
  ok: boolean;
  limits: {
    maxFileBytes: number;
    maxPixels: number;
    maxAnnotations: number;
    maxTotalTextLength: number;
  };
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

export interface ReviseAnnotationArguments extends ImageSafetyOptions {
  parentSidecarPath: string;
  edits: unknown;
  inputPath?: string | undefined;
  /** Optional lower cumulative lineage byte budget for embedded/core callers. */
  maxRevisionChainBytes?: number | undefined;
  /** Test-only fault hook. CLI and MCP never expose it. */
  faultInjector?: ((point: RevisionFaultPoint) => void | Promise<void>) | undefined;
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

interface RevisionParentRecord {
  sidecar: string;
  sidecarSha256: string;
  output: string;
  outputSha256: string;
  specSha256: string;
}

interface RevisionManifestRecord {
  number: number;
  lineageId: string;
  parent: RevisionParentRecord;
  edits: AnnotationRevisionEdit[];
  editsSha256: string;
}

interface AnnotationSidecarManifest {
  manifestVersion: "1.0" | "1.1";
  operation: "annotate";
  pathSemantics: "relative-to-sidecar" | "per-input; see inputs[].pathSemantics";
  paths: {
    inputs: string[];
    output: string;
    sidecar: string;
  };
  inputs: [InputManifestRecord];
  operationSpec: unknown;
  annotationSpec: unknown;
  hashes: {
    inputSha256: string;
    specSha256: string;
    outputSha256: string;
  };
  originalDimensions: Dimensions;
  outputDimensions: Dimensions;
  annotationCount: number;
  warnings: string[];
  usesBlur: boolean;
  usesRedact: boolean;
  renderer: RendererVersions;
  security: {
    exifOrientationApplied: boolean;
    metadataStripped: boolean;
    outputReDecoded: boolean;
    blurIsSecureRedaction: boolean;
    redactUsesOpaqueOverwrite: boolean;
  };
  markdown: string;
  resolvedAnnotations?: Record<string, unknown>[] | undefined;
  revision?: RevisionManifestRecord | undefined;
}

interface FileSnapshot {
  path: string;
  sha256: string;
  mtimeNs: bigint;
  sizeBytes: bigint;
  identity: FileIdentity;
}

interface TrustedAnnotationSidecar {
  path: string;
  sha256: string;
  manifest: AnnotationSidecarManifest;
  spec: AnnotationSpec;
  specSha256: string;
  output: ImageInspection;
  sidecarSnapshot: FileSnapshot;
  outputSnapshot: FileSnapshot;
}

interface TrustedAnnotationChain {
  head: TrustedAnnotationSidecar;
  committedSnapshots: FileSnapshot[];
  entryCount: number;
  cumulativeBytes: bigint;
}

interface AppliedRevision {
  spec: AnnotationSpec;
  edits: AnnotationRevisionEdit[];
  editsSha256: string;
}

interface VerifiedRevisionInput {
  loaded: LoadedImage;
  snapshot: FileSnapshot;
}

interface RevisionLockRecord {
  version: "1.0";
  token: string;
  pid: number;
  lineageId: string;
  parentSidecarSha256: string;
  revisionNumber: number;
  output: string;
  sidecar: string;
}

const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);
const MIME_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
} as const;
const SAFE_CONTACT_COLORS = new Set(["black", "gray", "grey", "transparent", "white"]);
const MAX_REVISION_CHAIN_ENTRIES = 256;
const MAX_REVISION_CHAIN_BYTES = 512 * 1024 * 1024;

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
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === "ENOENT") return true;
  return "cause" in error && isMissingPathError((error as { cause?: unknown }).cause);
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

function revisionFailure(
  code: RevisionErrorCode,
  message: string,
  cause?: unknown
): AgentCalloutRevisionError {
  const sanitized = message
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var\/tmp)\/).*?\1/gu, "$1<path>$1")
    .replace(/[A-Za-z]:[\\/][^\s"'`,;)]+/gu, "<path>")
    .replace(/\\\\[^\\\s]+\\[^\s"'`,;)]+/gu, "<path>")
    .replace(/\/(?:Users|home|tmp|var\/tmp)\/[^\s"'`,;)]+/gu, "<path>");
  return new AgentCalloutRevisionError(
    code,
    sanitized,
    cause === undefined ? undefined : { cause }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  field: string,
  code: RevisionErrorCode = "PARENT_SIDECAR_INVALID"
): Record<string, unknown> {
  if (!isRecord(value)) throw revisionFailure(code, `${field} must be an object.`);
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  code: RevisionErrorCode = "PARENT_SIDECAR_INVALID"
): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw revisionFailure(code, `${field} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw revisionFailure("PARENT_SIDECAR_INVALID", `${field} must be boolean.`);
  }
  return value;
}

function requiredSafeInteger(
  value: unknown,
  field: string,
  minimum = 0,
  code: RevisionErrorCode = "PARENT_SIDECAR_INVALID"
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw revisionFailure(code, `${field} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function requiredSha256(
  value: unknown,
  field: string,
  code: RevisionErrorCode = "PARENT_SIDECAR_INVALID"
): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw revisionFailure(code, `${field} must be a lowercase SHA-256.`);
  }
  return value;
}

function requiredDimensions(value: unknown, field: string): Dimensions {
  const record = requiredRecord(value, field);
  assertExactKeys(record, ["width", "height"], field);
  return {
    width: requiredSafeInteger(record.width, `${field}.width`, 1),
    height: requiredSafeInteger(record.height, `${field}.height`, 1)
  };
}

function parseRendererVersions(value: unknown): RendererVersions {
  const renderer = requiredRecord(value, "renderer");
  assertExactKeys(renderer, ["name", "version", "sharp", "libvips", "font"], "renderer");
  const font = requiredRecord(renderer.font, "renderer.font");
  assertExactKeys(font, ["family", "file", "version", "sha256"], "renderer.font");
  return {
    name: requiredString(renderer.name, "renderer.name"),
    version: requiredString(renderer.version, "renderer.version"),
    sharp: requiredString(renderer.sharp, "renderer.sharp"),
    libvips: requiredString(renderer.libvips, "renderer.libvips"),
    font: {
      family: requiredString(font.family, "renderer.font.family"),
      file: requiredString(font.file, "renderer.font.file"),
      version: requiredString(font.version, "renderer.font.version"),
      sha256: requiredSha256(font.sha256, "renderer.font.sha256")
    }
  };
}

function parseSecurityRecord(value: unknown): AnnotationSidecarManifest["security"] {
  const security = requiredRecord(value, "security");
  assertExactKeys(
    security,
    [
      "exifOrientationApplied",
      "metadataStripped",
      "outputReDecoded",
      "blurIsSecureRedaction",
      "redactUsesOpaqueOverwrite"
    ],
    "security"
  );
  return {
    exifOrientationApplied: requiredBoolean(
      security.exifOrientationApplied,
      "security.exifOrientationApplied"
    ),
    metadataStripped: requiredBoolean(security.metadataStripped, "security.metadataStripped"),
    outputReDecoded: requiredBoolean(security.outputReDecoded, "security.outputReDecoded"),
    blurIsSecureRedaction: requiredBoolean(
      security.blurIsSecureRedaction,
      "security.blurIsSecureRedaction"
    ),
    redactUsesOpaqueOverwrite: requiredBoolean(
      security.redactUsesOpaqueOverwrite,
      "security.redactUsesOpaqueOverwrite"
    )
  };
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], field: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.join("\0") !== sortedExpected.join("\0")) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", `${field} contains missing or unknown fields.`);
  }
}

function parseInputManifest(value: unknown): InputManifestRecord {
  const input = requiredRecord(value, "inputs[0]");
  assertExactKeys(
    input,
    [
      "path",
      "pathSemantics",
      "format",
      "sha256",
      "sizeBytes",
      "dimensions",
      "storedDimensions",
      "orientation"
    ],
    "inputs[0]"
  );
  const pathSemantics = requiredString(input.pathSemantics, "inputs[0].pathSemantics");
  if (
    pathSemantics !== "relative-to-sidecar" &&
    pathSemantics !== "basename-only-resolve-by-sha256"
  ) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "inputs[0].pathSemantics is not supported.");
  }
  const inputPath = requiredString(input.path, "inputs[0].path");
  assertRelativeManifestPath(inputPath, "inputs[0].path");
  if (
    pathSemantics === "basename-only-resolve-by-sha256" &&
    (path.posix.basename(inputPath) !== inputPath || path.win32.basename(inputPath) !== inputPath)
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "A basename-only input reference must contain only a local filename."
    );
  }
  const format = requiredString(input.format, "inputs[0].format");
  if (!ACCEPTED_FORMATS.has(format)) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "inputs[0].format is not supported.");
  }
  const orientation = input.orientation;
  if (
    orientation !== null &&
    (!Number.isSafeInteger(orientation) ||
      (orientation as number) < 1 ||
      (orientation as number) > 8)
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "inputs[0].orientation must be null or an EXIF orientation from 1 through 8."
    );
  }
  return {
    path: inputPath,
    pathSemantics,
    format,
    sha256: requiredSha256(input.sha256, "inputs[0].sha256"),
    sizeBytes: requiredSafeInteger(input.sizeBytes, "inputs[0].sizeBytes", 1),
    dimensions: requiredDimensions(input.dimensions, "inputs[0].dimensions"),
    storedDimensions: requiredDimensions(input.storedDimensions, "inputs[0].storedDimensions"),
    orientation: orientation as number | null
  };
}

function parseRevisionManifest(value: unknown): RevisionManifestRecord {
  const revision = requiredRecord(value, "revision");
  assertExactKeys(revision, ["number", "lineageId", "parent", "edits", "editsSha256"], "revision");
  const parent = requiredRecord(revision.parent, "revision.parent");
  assertExactKeys(
    parent,
    ["sidecar", "sidecarSha256", "output", "outputSha256", "specSha256"],
    "revision.parent"
  );
  let edits: AnnotationRevisionEdit[];
  try {
    edits = parseAnnotationRevisionEdits(revision.edits);
  } catch (error) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `revision.edits is invalid: ${errorMessage(error)}`,
      error
    );
  }
  const editsSha256 = requiredSha256(revision.editsSha256, "revision.editsSha256");
  if (sha256(stableJson(edits).trimEnd()) !== editsSha256) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "revision.editsSha256 does not match the canonical edits."
    );
  }
  return {
    number: requiredSafeInteger(revision.number, "revision.number", 1),
    lineageId: requiredSha256(revision.lineageId, "revision.lineageId"),
    parent: {
      sidecar: requiredString(parent.sidecar, "revision.parent.sidecar"),
      sidecarSha256: requiredSha256(parent.sidecarSha256, "revision.parent.sidecarSha256"),
      output: requiredString(parent.output, "revision.parent.output"),
      outputSha256: requiredSha256(parent.outputSha256, "revision.parent.outputSha256"),
      specSha256: requiredSha256(parent.specSha256, "revision.parent.specSha256")
    },
    edits,
    editsSha256
  };
}

function parseRevisionLock(value: unknown): RevisionLockRecord {
  const lock = requiredRecord(value, "revision lock", "REVISION_RECOVERY_REQUIRED");
  const expected = [
    "version",
    "token",
    "pid",
    "lineageId",
    "parentSidecarSha256",
    "revisionNumber",
    "output",
    "sidecar"
  ];
  const actual = Object.keys(lock).sort();
  if (actual.join("\0") !== [...expected].sort().join("\0")) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock contains missing or unknown fields."
    );
  }
  if (lock.version !== "1.0") {
    throw revisionFailure("REVISION_RECOVERY_REQUIRED", "Revision lock version is unsupported.");
  }
  const token = requiredString(lock.token, "revision lock token", "REVISION_RECOVERY_REQUIRED");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token)) {
    throw revisionFailure("REVISION_RECOVERY_REQUIRED", "Revision lock token is invalid.");
  }
  const lineageId = requiredSha256(
    lock.lineageId,
    "revision lock lineageId",
    "REVISION_RECOVERY_REQUIRED"
  );
  const parentSidecarSha256 = requiredSha256(
    lock.parentSidecarSha256,
    "revision lock parentSidecarSha256",
    "REVISION_RECOVERY_REQUIRED"
  );
  const output = requiredString(lock.output, "revision lock output", "REVISION_RECOVERY_REQUIRED");
  const sidecar = requiredString(
    lock.sidecar,
    "revision lock sidecar",
    "REVISION_RECOVERY_REQUIRED"
  );
  if (path.basename(output) !== output || path.basename(sidecar) !== sidecar) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock output names must be local basenames."
    );
  }
  return {
    version: "1.0",
    token,
    pid: requiredSafeInteger(lock.pid, "revision lock pid", 1, "REVISION_RECOVERY_REQUIRED"),
    lineageId,
    parentSidecarSha256,
    revisionNumber: requiredSafeInteger(
      lock.revisionNumber,
      "revision lock revisionNumber",
      1,
      "REVISION_RECOVERY_REQUIRED"
    ),
    output,
    sidecar
  };
}

function parseAnnotationSidecar(bytes: Buffer): AnnotationSidecarManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `Parent sidecar is not valid JSON: ${errorMessage(error)}`,
      error
    );
  }
  const manifest = requiredRecord(parsed, "parent sidecar");
  const manifestVersion = requiredString(manifest.manifestVersion, "manifestVersion");
  if (manifestVersion !== "1.0" && manifestVersion !== "1.1") {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `Unsupported manifestVersion ${JSON.stringify(manifestVersion)}.`
    );
  }
  const manifestKeys = [
    "manifestVersion",
    "operation",
    "pathSemantics",
    "paths",
    "inputs",
    "operationSpec",
    "annotationSpec",
    "hashes",
    "originalDimensions",
    "outputDimensions",
    "annotationCount",
    "warnings",
    "usesBlur",
    "usesRedact",
    "renderer",
    "security",
    "markdown",
    "resolvedAnnotations",
    ...(manifestVersion === "1.1" ? ["revision"] : [])
  ];
  assertExactKeys(manifest, manifestKeys, "parent sidecar");
  if (manifest.operation !== "annotate") {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "Only annotate sidecars can be revised.");
  }
  const paths = requiredRecord(manifest.paths, "paths");
  assertExactKeys(paths, ["inputs", "output", "sidecar"], "paths");
  const inputPaths = paths.inputs;
  if (!Array.isArray(inputPaths) || inputPaths.length !== 1) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "An annotate sidecar must reference exactly one input path."
    );
  }
  const inputs = manifest.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "An annotate sidecar must contain exactly one input record."
    );
  }
  const input = parseInputManifest(inputs[0]);
  const pathsInput = requiredString(inputPaths[0], "paths.inputs[0]");
  if (pathsInput !== input.path) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "paths.inputs[0] does not match inputs[0].path."
    );
  }
  const hashes = requiredRecord(manifest.hashes, "hashes");
  assertExactKeys(hashes, ["inputSha256", "specSha256", "outputSha256"], "hashes");
  const warnings = manifest.warnings;
  if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== "string")) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "warnings must be an array of strings.");
  }
  const renderer = parseRendererVersions(manifest.renderer);
  const security = parseSecurityRecord(manifest.security);
  const resolvedAnnotations = manifest.resolvedAnnotations;
  if (
    resolvedAnnotations !== undefined &&
    (!Array.isArray(resolvedAnnotations) ||
      resolvedAnnotations.some((annotation) => !isRecord(annotation)))
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "resolvedAnnotations must be an array of objects when present."
    );
  }
  const revision =
    manifest.revision === undefined ? undefined : parseRevisionManifest(manifest.revision);
  if (manifestVersion === "1.0" && revision !== undefined) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "manifestVersion 1.0 cannot contain revision metadata."
    );
  }
  if (manifestVersion === "1.1" && revision === undefined) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "manifestVersion 1.1 requires revision metadata."
    );
  }
  const pathSemantics = requiredString(manifest.pathSemantics, "pathSemantics");
  if (
    pathSemantics !== "relative-to-sidecar" &&
    pathSemantics !== "per-input; see inputs[].pathSemantics"
  ) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "pathSemantics is not supported.");
  }
  const expectedPathSemantics =
    input.pathSemantics === "relative-to-sidecar"
      ? "relative-to-sidecar"
      : "per-input; see inputs[].pathSemantics";
  if (pathSemantics !== expectedPathSemantics) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "pathSemantics contradicts inputs[0].pathSemantics."
    );
  }
  const outputReference = requiredString(paths.output, "paths.output");
  const sidecarReference = requiredString(paths.sidecar, "paths.sidecar");
  assertRelativeManifestPath(outputReference, "paths.output");
  assertRelativeManifestPath(sidecarReference, "paths.sidecar");
  const usesRedact = requiredBoolean(manifest.usesRedact, "usesRedact");
  const markdown = requiredString(manifest.markdown, "markdown");
  if (markdown !== relativeMarkdown(outputReference, "AgentCallout output")) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "markdown does not match the recorded output reference."
    );
  }
  if (
    security.exifOrientationApplied !== true ||
    security.metadataStripped !== true ||
    security.outputReDecoded !== true ||
    security.blurIsSecureRedaction !== false ||
    security.redactUsesOpaqueOverwrite !== usesRedact
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "security contradicts the required annotate output guarantees."
    );
  }
  return {
    manifestVersion,
    operation: "annotate",
    pathSemantics,
    paths: {
      inputs: [pathsInput],
      output: outputReference,
      sidecar: sidecarReference
    },
    inputs: [input],
    operationSpec: manifest.operationSpec,
    annotationSpec: manifest.annotationSpec,
    hashes: {
      inputSha256: requiredSha256(hashes.inputSha256, "hashes.inputSha256"),
      specSha256: requiredSha256(hashes.specSha256, "hashes.specSha256"),
      outputSha256: requiredSha256(hashes.outputSha256, "hashes.outputSha256")
    },
    originalDimensions: requiredDimensions(manifest.originalDimensions, "originalDimensions"),
    outputDimensions: requiredDimensions(manifest.outputDimensions, "outputDimensions"),
    annotationCount: requiredSafeInteger(manifest.annotationCount, "annotationCount"),
    warnings: warnings as string[],
    usesBlur: requiredBoolean(manifest.usesBlur, "usesBlur"),
    usesRedact,
    renderer,
    security,
    markdown,
    ...(resolvedAnnotations === undefined
      ? {}
      : { resolvedAnnotations: resolvedAnnotations as Record<string, unknown>[] }),
    ...(revision === undefined ? {} : { revision })
  };
}

async function readStableFile(
  filePath: string,
  maximumBytes: number,
  code: RevisionErrorCode
): Promise<{ bytes: Buffer; snapshot: FileSnapshot }> {
  let handle: FileHandle | undefined;
  let result: { bytes: Buffer; snapshot: FileSnapshot } | undefined;
  let failure: unknown;
  try {
    handle = await open(filePath, "r");
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw revisionFailure(code, "Expected a regular file.");
    if (before.size > BigInt(maximumBytes)) {
      throw revisionFailure(code, `File exceeds the ${maximumBytes}-byte safety limit.`);
    }
    const byteLength = Number(before.size);
    const bytes = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const read = await handle.read(bytes, offset, byteLength - offset, offset);
      if (read.bytesRead === 0) {
        throw revisionFailure(code, "File changed while it was being verified.");
      }
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, byteLength)).bytesRead !== 0) {
      throw revisionFailure(code, "File changed while it was being verified.");
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw revisionFailure(code, "File changed while it was being verified.");
    }
    result = {
      bytes,
      snapshot: {
        path: filePath,
        sha256: sha256(bytes),
        mtimeNs: after.mtimeNs,
        sizeBytes: after.size,
        identity: { device: after.dev, inode: after.ino }
      }
    };
  } catch (error) {
    failure =
      error instanceof AgentCalloutRevisionError
        ? error
        : revisionFailure(code, "File could not be read and verified safely.", error);
  }
  try {
    await handle?.close();
  } catch (error) {
    failure = revisionFailure(code, "File handle could not be closed safely.", error);
  }
  if (failure instanceof AgentCalloutRevisionError) throw failure;
  if (result !== undefined) return result;
  throw revisionFailure(code, "File could not be read and verified safely.", failure);
}

function assertRelativeManifestPath(value: string, field: string): void {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", `${field} must be relative to its sidecar.`);
  }
}

async function canonicalManifestReference(
  sidecarDirectory: string,
  reference: string,
  allowedRoots: readonly string[] | undefined,
  field: string
): Promise<string> {
  assertRelativeManifestPath(reference, field);
  try {
    return await canonicalInputPath(path.resolve(sidecarDirectory, reference), allowedRoots);
  } catch (error) {
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `${field} cannot be resolved safely: ${errorMessage(error)}`,
      error
    );
  }
}

function sidecarBaseStem(sidecar: TrustedAnnotationSidecar): string {
  const filename = path.basename(sidecar.path);
  const extension = path.extname(filename);
  if (extension.toLowerCase() !== ".json") {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "Parent sidecar must use a .json extension.");
  }
  const stem = filename.slice(0, -extension.length);
  const revision = sidecar.manifest.revision;
  if (revision === undefined) {
    if (/\.rev\d+$/u.test(stem)) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "A revision-named sidecar is missing revision metadata."
      );
    }
    return stem;
  }
  const suffix = `.rev${revision.number}`;
  if (!stem.endsWith(suffix) || stem.length === suffix.length) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "Revision number does not match the parent sidecar filename."
    );
  }
  return stem.slice(0, -suffix.length);
}

async function loadTrustedAnnotationSidecar(
  sidecarPath: string,
  options: ImageSafetyOptions
): Promise<TrustedAnnotationSidecar> {
  let canonicalSidecarPath: string;
  try {
    canonicalSidecarPath = await canonicalInputPath(sidecarPath, options.allowedRoots);
  } catch (error) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `Parent sidecar cannot be opened safely: ${errorMessage(error)}`,
      error
    );
  }
  const limits = mergeLimits(options);
  const sidecarRead = await readStableFile(
    canonicalSidecarPath,
    Math.min(limits.maxFileBytes, 10 * 1024 * 1024),
    "PARENT_SIDECAR_INVALID"
  );
  const manifest = parseAnnotationSidecar(sidecarRead.bytes);
  if (manifest.paths.sidecar !== path.basename(canonicalSidecarPath)) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "paths.sidecar does not match the parent sidecar filename."
    );
  }
  if (manifest.hashes.inputSha256 !== manifest.inputs[0].sha256) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "hashes.inputSha256 does not match inputs[0].sha256."
    );
  }
  let spec: AnnotationSpec;
  let canonicalSpec: string;
  try {
    spec = parseAnnotationSpec(manifest.annotationSpec);
    canonicalSpec = canonicalizeSpec(spec);
    if (canonicalizeSpec(manifest.operationSpec) !== canonicalSpec) {
      throw revisionFailure(
        "PARENT_SPEC_MISMATCH",
        "operationSpec and annotationSpec do not describe the same canonical spec."
      );
    }
  } catch (error) {
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      `Parent annotationSpec is invalid: ${errorMessage(error)}`,
      error
    );
  }
  const specSha256 = sha256(canonicalSpec);
  if (manifest.hashes.specSha256 !== specSha256) {
    throw revisionFailure(
      "PARENT_SPEC_MISMATCH",
      "Parent canonical AnnotationSpec SHA-256 does not match its sidecar."
    );
  }
  if (manifest.annotationCount !== spec.annotations.length) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "annotationCount does not match annotationSpec.annotations."
    );
  }
  if (
    manifest.originalDimensions.width !== manifest.inputs[0].dimensions.width ||
    manifest.originalDimensions.height !== manifest.inputs[0].dimensions.height
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "originalDimensions does not match inputs[0].dimensions."
    );
  }
  const specUsesBlur = spec.annotations.some((annotation) => annotation.type === "blur");
  const specUsesRedact = spec.annotations.some((annotation) => annotation.type === "redact");
  if (manifest.usesBlur !== specUsesBlur || manifest.usesRedact !== specUsesRedact) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "usesBlur or usesRedact does not match annotationSpec."
    );
  }
  const sidecarDirectory = path.dirname(canonicalSidecarPath);
  const expectedOutputPath = path.join(
    sidecarDirectory,
    `${path.basename(canonicalSidecarPath, path.extname(canonicalSidecarPath))}.png`
  );
  const outputPath = await canonicalManifestReference(
    sidecarDirectory,
    manifest.paths.output,
    options.allowedRoots,
    "paths.output"
  );
  let canonicalExpectedOutput: string;
  try {
    canonicalExpectedOutput = await canonicalInputPath(expectedOutputPath, options.allowedRoots);
  } catch (error) {
    throw revisionFailure(
      "PARENT_OUTPUT_MISMATCH",
      `Parent output is missing or unsafe: ${errorMessage(error)}`,
      error
    );
  }
  if (outputPath !== canonicalExpectedOutput) {
    throw revisionFailure(
      "PARENT_OUTPUT_MISMATCH",
      "paths.output does not identify the PNG paired with the parent sidecar."
    );
  }
  let output: ImageInspection;
  try {
    output = await inspectImage(outputPath, options);
  } catch (error) {
    throw revisionFailure(
      "PARENT_OUTPUT_MISMATCH",
      `Parent output cannot be inspected safely: ${errorMessage(error)}`,
      error
    );
  }
  if (
    output.format !== "png" ||
    output.sha256 !== manifest.hashes.outputSha256 ||
    output.dimensions.width !== manifest.outputDimensions.width ||
    output.dimensions.height !== manifest.outputDimensions.height
  ) {
    throw revisionFailure(
      "PARENT_OUTPUT_MISMATCH",
      "Parent output format, dimensions, or SHA-256 does not match its sidecar."
    );
  }
  const outputRead = await readStableFile(
    outputPath,
    limits.maxFileBytes,
    "PARENT_OUTPUT_MISMATCH"
  );
  if (outputRead.snapshot.sha256 !== output.sha256) {
    throw revisionFailure("PARENT_OUTPUT_MISMATCH", "Parent output changed during validation.");
  }
  const sidecarIdentity = await existingFileIdentity(canonicalSidecarPath);
  const outputIdentity = await existingFileIdentity(outputPath);
  if (
    sidecarIdentity !== null &&
    outputIdentity !== null &&
    sameFileIdentity(sidecarIdentity, outputIdentity)
  ) {
    throw revisionFailure(
      "PARENT_SIDECAR_INVALID",
      "Parent sidecar and output must not alias the same file."
    );
  }
  const trusted: TrustedAnnotationSidecar = {
    path: canonicalSidecarPath,
    sha256: sidecarRead.snapshot.sha256,
    manifest,
    spec,
    specSha256,
    output,
    sidecarSnapshot: sidecarRead.snapshot,
    outputSnapshot: outputRead.snapshot
  };
  sidecarBaseStem(trusted);
  return trusted;
}

function applyAnnotationRevisionEdits(
  parentSpec: AnnotationSpec,
  value: unknown,
  code: RevisionErrorCode = "REVISION_EDITS_INVALID"
): AppliedRevision {
  let edits: AnnotationRevisionEdit[];
  try {
    edits = parseAnnotationRevisionEdits(value);
  } catch (error) {
    throw revisionFailure(code, `Revision edits are invalid: ${errorMessage(error)}`, error);
  }
  const annotations = [...parentSpec.annotations];
  const touched = new Set<string>();
  for (const [index, edit] of edits.entries()) {
    const id = edit.op === "add" ? edit.annotation.id : edit.id;
    if (touched.has(id)) {
      throw revisionFailure(
        code,
        `Revision edit ${index} touches annotation ${JSON.stringify(id)} more than once.`
      );
    }
    touched.add(id);

    if (edit.op === "add") {
      if (annotations.some((annotation) => annotation.id === id)) {
        throw revisionFailure(code, `Cannot add duplicate annotation ID ${JSON.stringify(id)}.`);
      }
      if (edit.afterId === undefined) {
        annotations.push(edit.annotation);
      } else {
        const afterIndex = annotations.findIndex((annotation) => annotation.id === edit.afterId);
        if (afterIndex === -1) {
          throw revisionFailure(
            code,
            `add.afterId ${JSON.stringify(edit.afterId)} does not identify a current annotation.`
          );
        }
        annotations.splice(afterIndex + 1, 0, edit.annotation as never);
      }
      continue;
    }

    const existingIndex = annotations.findIndex((annotation) => annotation.id === edit.id);
    if (existingIndex === -1) {
      throw revisionFailure(
        code,
        `${edit.op} references unknown annotation ID ${JSON.stringify(edit.id)}.`
      );
    }
    if (edit.op === "remove") {
      annotations.splice(existingIndex, 1);
      continue;
    }
    const existing = annotations[existingIndex];
    if (stableJson(existing) === stableJson(edit.annotation)) {
      throw revisionFailure(code, `set for annotation ${JSON.stringify(edit.id)} is a no-op.`);
    }
    annotations[existingIndex] = edit.annotation;
  }

  let spec: AnnotationSpec;
  try {
    spec = parseAnnotationSpec({ ...parentSpec, annotations });
  } catch (error) {
    throw revisionFailure(code, `Final AnnotationSpec is invalid: ${errorMessage(error)}`, error);
  }
  if (canonicalizeSpec(spec) === canonicalizeSpec(parentSpec)) {
    throw revisionFailure(code, "Revision edits produce no canonical AnnotationSpec change.");
  }
  const normalizedEdits = edits.map((edit): AnnotationRevisionEdit => {
    if (edit.op === "remove") return edit;
    const annotation = spec.annotations.find((candidate) => candidate.id === edit.annotation.id);
    if (annotation === undefined) {
      throw revisionFailure(code, "A revised annotation disappeared during final validation.");
    }
    return edit.op === "add"
      ? {
          op: "add",
          annotation,
          ...(edit.afterId === undefined ? {} : { afterId: edit.afterId })
        }
      : { op: "set", id: edit.id, annotation };
  });
  return {
    spec,
    edits: normalizedEdits,
    editsSha256: sha256(stableJson(normalizedEdits).trimEnd())
  };
}

async function loadTrustedAnnotationChain(
  parentSidecarPath: string,
  options: ImageSafetyOptions,
  maximumChainBytes: number
): Promise<TrustedAnnotationChain> {
  const head = await loadTrustedAnnotationSidecar(parentSidecarPath, options);
  const committedSnapshots = [head.sidecarSnapshot, head.outputSnapshot];
  const seenPaths = new Set([head.path]);
  const identities = new Map<string, string>();
  const registerSnapshots = (sidecar: TrustedAnnotationSidecar): void => {
    for (const [kind, snapshot] of [
      ["sidecar", sidecar.sidecarSnapshot],
      ["output", sidecar.outputSnapshot]
    ] as const) {
      const key = `${snapshot.identity.device.toString()}:${snapshot.identity.inode.toString()}`;
      const previous = identities.get(key);
      if (previous !== undefined) {
        throw revisionFailure(
          "PARENT_SIDECAR_INVALID",
          `Committed lineage files must not alias each other (${previous} and ${kind}).`
        );
      }
      identities.set(key, kind);
    }
  };
  registerSnapshots(head);
  let entryCount = 1;
  let cumulativeBytes = head.sidecarSnapshot.sizeBytes + head.outputSnapshot.sizeBytes;
  if (cumulativeBytes > BigInt(maximumChainBytes)) {
    throw revisionFailure(
      "REVISION_LIMIT_REACHED",
      `Revision lineage exceeds the ${maximumChainBytes}-byte cumulative safety limit.`
    );
  }
  let child = head;
  while (child.manifest.revision !== undefined) {
    if (entryCount >= MAX_REVISION_CHAIN_ENTRIES) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        `Revision lineage exceeds the ${MAX_REVISION_CHAIN_ENTRIES}-entry safety limit.`
      );
    }
    const revision = child.manifest.revision;
    const parentPath = await canonicalManifestReference(
      path.dirname(child.path),
      revision.parent.sidecar,
      options.allowedRoots,
      "revision.parent.sidecar"
    );
    if (seenPaths.has(parentPath)) {
      throw revisionFailure("PARENT_SIDECAR_INVALID", "Revision lineage contains a cycle.");
    }
    const parent = await loadTrustedAnnotationSidecar(parentPath, options);
    seenPaths.add(parent.path);
    registerSnapshots(parent);
    committedSnapshots.push(parent.sidecarSnapshot, parent.outputSnapshot);
    entryCount += 1;
    cumulativeBytes += parent.sidecarSnapshot.sizeBytes + parent.outputSnapshot.sizeBytes;
    if (cumulativeBytes > BigInt(maximumChainBytes)) {
      throw revisionFailure(
        "REVISION_LIMIT_REACHED",
        `Revision lineage exceeds the ${maximumChainBytes}-byte cumulative safety limit.`
      );
    }

    const parentOutputPath = await canonicalManifestReference(
      path.dirname(child.path),
      revision.parent.output,
      options.allowedRoots,
      "revision.parent.output"
    );
    if (
      parent.sha256 !== revision.parent.sidecarSha256 ||
      parent.output.sha256 !== revision.parent.outputSha256 ||
      parent.specSha256 !== revision.parent.specSha256 ||
      parent.output.path !== parentOutputPath
    ) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision parent paths or hashes do not match the recorded lineage."
      );
    }
    const parentNumber = parent.manifest.revision?.number ?? 0;
    if (revision.number !== parentNumber + 1) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision numbers are not contiguous in the parent lineage."
      );
    }
    const expectedLineageId = parent.manifest.revision?.lineageId ?? parent.sha256;
    if (revision.lineageId !== expectedLineageId) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision lineageId does not identify the base annotate sidecar."
      );
    }
    if (child.manifest.hashes.inputSha256 !== parent.manifest.hashes.inputSha256) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision lineage changed the original input SHA-256."
      );
    }
    let replay: AppliedRevision;
    try {
      replay = applyAnnotationRevisionEdits(parent.spec, revision.edits, "PARENT_SIDECAR_INVALID");
    } catch (error) {
      if (error instanceof AgentCalloutRevisionError) throw error;
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision edits cannot be replayed against their recorded parent.",
        error
      );
    }
    if (
      replay.editsSha256 !== revision.editsSha256 ||
      canonicalizeSpec(replay.spec) !== canonicalizeSpec(child.spec)
    ) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "Revision edits do not reproduce the child canonical AnnotationSpec."
      );
    }
    child = parent;
  }
  return { head, committedSnapshots, entryCount, cumulativeBytes };
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
    limitInputPixels: loaded.limits.maxPixels,
    specVersion: resolution.spec.version
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

async function resolveRevisionInput(
  chain: TrustedAnnotationChain,
  arguments_: ReviseAnnotationArguments
): Promise<VerifiedRevisionInput> {
  const inputRecord = chain.head.manifest.inputs[0];
  let requestedInputPath = arguments_.inputPath;
  if (requestedInputPath === undefined) {
    if (inputRecord.pathSemantics === "basename-only-resolve-by-sha256") {
      throw revisionFailure(
        "INPUT_REQUIRED",
        "The parent uses basename-only input semantics; provide the original bytes explicitly with inputPath."
      );
    }
    requestedInputPath = path.resolve(path.dirname(chain.head.path), inputRecord.path);
  }

  let loaded: LoadedImage;
  try {
    loaded = await loadImage(requestedInputPath, arguments_);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw revisionFailure(
        "INPUT_REQUIRED",
        "The original input is missing; provide its current path with inputPath.",
        error
      );
    }
    const detail = errorMessage(error).toLowerCase();
    throw revisionFailure(
      "INPUT_INVALID",
      detail.includes("outside the allowed roots")
        ? "The supplied original image is outside the allowed roots."
        : "The supplied original image could not be opened and validated safely.",
      error
    );
  }
  if (loaded.inspection.sha256 !== inputRecord.sha256) {
    throw revisionFailure(
      "INPUT_HASH_MISMATCH",
      "The supplied original image does not match the SHA-256 recorded by the parent sidecar."
    );
  }
  if (
    loaded.inspection.format !== inputRecord.format ||
    loaded.inspection.sizeBytes !== inputRecord.sizeBytes ||
    loaded.inspection.dimensions.width !== inputRecord.dimensions.width ||
    loaded.inspection.dimensions.height !== inputRecord.dimensions.height ||
    loaded.inspection.storedDimensions.width !== inputRecord.storedDimensions.width ||
    loaded.inspection.storedDimensions.height !== inputRecord.storedDimensions.height ||
    loaded.inspection.orientation !== inputRecord.orientation ||
    chain.head.manifest.originalDimensions.width !== inputRecord.dimensions.width ||
    chain.head.manifest.originalDimensions.height !== inputRecord.dimensions.height
  ) {
    throw revisionFailure(
      "INPUT_HASH_MISMATCH",
      "The original image metadata does not match the trusted parent input record."
    );
  }

  const inputIdentity = await existingFileIdentity(loaded.inspection.path);
  for (const snapshot of chain.committedSnapshots) {
    if (inputIdentity !== null && sameFileIdentity(inputIdentity, snapshot.identity)) {
      throw revisionFailure(
        "PARENT_SIDECAR_INVALID",
        "The original input must not alias a committed sidecar or annotation output."
      );
    }
  }
  const inputRead = await readStableFile(
    loaded.inspection.path,
    loaded.limits.maxFileBytes,
    "INPUT_HASH_MISMATCH"
  );
  if (inputRead.snapshot.sha256 !== loaded.inspection.sha256) {
    throw revisionFailure("INPUT_HASH_MISMATCH", "The original input changed during validation.");
  }
  return { loaded: { ...loaded, bytes: inputRead.bytes }, snapshot: inputRead.snapshot };
}

async function assertSnapshotsUnchanged(snapshots: readonly FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    try {
      const information = await stat(snapshot.path, { bigint: true });
      if (
        !information.isFile() ||
        information.dev !== snapshot.identity.device ||
        information.ino !== snapshot.identity.inode ||
        information.size !== snapshot.sizeBytes ||
        information.mtimeNs !== snapshot.mtimeNs
      ) {
        throw revisionFailure(
          "REVISION_CONFLICT",
          "A committed ancestor or original input changed during revision rendering."
        );
      }
      if (sha256(await readFile(snapshot.path)) !== snapshot.sha256) {
        throw revisionFailure(
          "REVISION_CONFLICT",
          "A committed ancestor or original input changed during revision rendering."
        );
      }
    } catch (error) {
      if (error instanceof AgentCalloutRevisionError) throw error;
      throw revisionFailure(
        "REVISION_CONFLICT",
        `A committed ancestor or original input could not be revalidated: ${errorMessage(error)}`,
        error
      );
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function runRevisionFault(
  arguments_: ReviseAnnotationArguments,
  point: RevisionFaultPoint
): Promise<void> {
  await arguments_.faultInjector?.(point);
}

async function writeSyncedRevisionTemp(
  filePath: string,
  bytes: Buffer,
  writePoint: RevisionFaultPoint,
  flushPoint: RevisionFaultPoint,
  arguments_: ReviseAnnotationArguments,
  onCreated: (identity: FileIdentity) => void
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "wx", 0o600);
    const information = await handle.stat({ bigint: true });
    onCreated({ device: information.dev, inode: information.ino });
    await runRevisionFault(arguments_, writePoint);
    await handle.writeFile(bytes);
    await runRevisionFault(arguments_, flushPoint);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function removeOwnedTransactionFile(
  filePath: string,
  expectedIdentity: FileIdentity
): Promise<void> {
  try {
    const information = await lstat(filePath, { bigint: true });
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.dev !== expectedIdentity.device ||
      information.ino !== expectedIdentity.inode
    ) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "A transaction file changed ownership and was left for recovery."
      );
    }
    await rm(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "A transaction file could not be removed safely.",
      error
    );
  }
}

async function removeOwnedPublishedPng(
  outputPath: string,
  sidecarPath: string,
  expectedSha256: string
): Promise<void> {
  if (await pathExists(sidecarPath)) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision sidecar appeared while rolling back its PNG; manual inspection is required."
    );
  }
  if (!(await pathExists(outputPath))) return;
  const bytes = await readFile(outputPath);
  if (sha256(bytes) !== expectedSha256) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "The orphan PNG no longer matches this transaction; it was left for manual recovery."
    );
  }
  await rm(outputPath);
}

async function removeOwnedPublishedSidecar(
  sidecarPath: string,
  expectedSha256: string
): Promise<void> {
  if (!(await pathExists(sidecarPath))) return;
  const bytes = await readFile(sidecarPath);
  if (sha256(bytes) !== expectedSha256) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "The unverified revision sidecar no longer matches this transaction."
    );
  }
  await rm(sidecarPath);
}

async function removeRevisionLock(lockPath: string, identity: FileIdentity): Promise<void> {
  try {
    if (!(await pathExists(lockPath))) return;
    const currentIdentity = await existingFileIdentity(lockPath);
    if (currentIdentity === null) return;
    if (!sameFileIdentity(currentIdentity, identity)) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "Revision lock ownership changed; the lock was left for manual recovery."
      );
    }
    await rm(lockPath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      `Revision lock could not be cleaned safely: ${errorMessage(error)}`,
      error
    );
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

async function removeOwnedRecoveryFile(filePath: string): Promise<void> {
  try {
    const information = await lstat(filePath);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "A revision recovery artifact is not an owned regular file."
      );
    }
    await rm(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return;
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "A revision recovery artifact could not be removed safely.",
      error
    );
  }
}

async function recoverExistingRevisionLock(
  lockPath: string,
  expected: {
    lineageId: string;
    parentSidecarSha256: string;
    revisionNumber: number;
    outputPath: string;
    sidecarPath: string;
  },
  options: ImageSafetyOptions
): Promise<"active" | "committed" | "recovered"> {
  try {
    const lockInformation = await lstat(lockPath);
    if (!lockInformation.isFile() || lockInformation.isSymbolicLink()) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "Revision lock is not a regular owned file."
      );
    }
  } catch (error) {
    if (isMissingPathError(error)) return "recovered";
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock could not be inspected safely.",
      error
    );
  }
  let lockRead: Awaited<ReturnType<typeof readStableFile>>;
  try {
    lockRead = await readStableFile(lockPath, 64 * 1024, "REVISION_RECOVERY_REQUIRED");
  } catch (error) {
    if (isMissingPathError(error)) return "recovered";
    if (
      error instanceof AgentCalloutRevisionError &&
      error.code === "REVISION_RECOVERY_REQUIRED" &&
      (error.message.includes("changed while it was being verified") ||
        error.message.includes("could not be read and verified safely") ||
        error.message.includes("handle could not be closed safely"))
    ) {
      return "active";
    }
    if (error instanceof AgentCalloutRevisionError) throw error;
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock could not be inspected safely.",
      error
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockRead.bytes.toString("utf8"));
  } catch {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock is incomplete or invalid and cannot be recovered automatically."
    );
  }
  const lock = parseRevisionLock(parsed);
  const matchesExpected =
    lock.lineageId === expected.lineageId &&
    lock.parentSidecarSha256 === expected.parentSidecarSha256 &&
    lock.revisionNumber === expected.revisionNumber &&
    lock.output === path.basename(expected.outputPath) &&
    lock.sidecar === path.basename(expected.sidecarPath);
  const directory = path.dirname(lockPath);
  const stagedLockPath = path.join(directory, `.${lock.lineageId}.revision-lock.${lock.token}.tmp`);
  const recordedSidecarPath = path.join(directory, lock.sidecar);
  const recordedOutputPath = path.join(directory, lock.output);
  const temporaryOutputPath = path.join(directory, `.${lock.output}.${lock.token}.tmp`);
  const temporarySidecarPath = path.join(directory, `.${lock.sidecar}.${lock.token}.tmp`);

  if (await pathExists(recordedSidecarPath)) {
    const committed = await loadTrustedAnnotationSidecar(recordedSidecarPath, options);
    if (
      committed.manifest.revision?.number !== lock.revisionNumber ||
      committed.manifest.revision.lineageId !== lock.lineageId ||
      committed.manifest.revision.parent.sidecarSha256 !== lock.parentSidecarSha256 ||
      committed.output.path !== recordedOutputPath
    ) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "Committed revision beside a stale lock does not match that lock."
      );
    }
    await removeOwnedRecoveryFile(stagedLockPath);
    await removeOwnedRecoveryFile(temporaryOutputPath);
    await removeOwnedRecoveryFile(temporarySidecarPath);
    const currentLockIdentity = await existingFileIdentity(lockPath);
    if (currentLockIdentity === null) return matchesExpected ? "committed" : "recovered";
    if (!sameFileIdentity(currentLockIdentity, lockRead.snapshot.identity)) return "active";
    await removeRevisionLock(lockPath, lockRead.snapshot.identity);
    return matchesExpected ? "committed" : "recovered";
  }

  if (processIsAlive(lock.pid)) return "active";

  if (!matchesExpected) {
    throw revisionFailure(
      "REVISION_RECOVERY_REQUIRED",
      "Revision lock does not match the requested lineage head."
    );
  }

  if (await pathExists(recordedOutputPath)) {
    if (!(await pathExists(temporarySidecarPath))) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "A stale revision lock has an orphan PNG without its owned sidecar temp."
      );
    }
    const tempSidecar = await readStableFile(
      temporarySidecarPath,
      10 * 1024 * 1024,
      "REVISION_RECOVERY_REQUIRED"
    );
    const manifest = parseAnnotationSidecar(tempSidecar.bytes);
    if (
      manifest.revision?.number !== lock.revisionNumber ||
      manifest.revision.lineageId !== lock.lineageId ||
      manifest.revision.parent.sidecarSha256 !== lock.parentSidecarSha256 ||
      manifest.paths.output !== lock.output ||
      manifest.paths.sidecar !== lock.sidecar
    ) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "A stale revision temp sidecar does not match its owning lock."
      );
    }
    const outputBytes = await readStableFile(
      recordedOutputPath,
      mergeLimits(options).maxFileBytes,
      "REVISION_RECOVERY_REQUIRED"
    );
    if (outputBytes.snapshot.sha256 !== manifest.hashes.outputSha256) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "A stale revision orphan PNG does not match its owned sidecar temp."
      );
    }
    await removeOwnedRecoveryFile(recordedOutputPath);
  }
  await removeOwnedRecoveryFile(stagedLockPath);
  await removeOwnedRecoveryFile(temporaryOutputPath);
  await removeOwnedRecoveryFile(temporarySidecarPath);
  await removeRevisionLock(lockPath, lockRead.snapshot.identity);
  return "recovered";
}

/**
 * Apply ordered, strict edits to a trusted annotate sidecar and commit a new .revN pair.
 * The PNG is published first; the sidecar is the commit marker. This is deliberately
 * not described as a power-loss-atomic two-file transaction.
 */
export async function reviseAnnotation(
  arguments_: ReviseAnnotationArguments
): Promise<RevisionResult> {
  if (
    typeof arguments_.parentSidecarPath !== "string" ||
    arguments_.parentSidecarPath.trim() === ""
  ) {
    throw revisionFailure("PARENT_SIDECAR_INVALID", "parentSidecarPath must be a non-empty path.");
  }
  const maximumChainBytes = arguments_.maxRevisionChainBytes ?? MAX_REVISION_CHAIN_BYTES;
  if (!Number.isSafeInteger(maximumChainBytes) || maximumChainBytes <= 0) {
    throw revisionFailure(
      "REVISION_LIMIT_REACHED",
      "maxRevisionChainBytes must be a positive safe integer."
    );
  }
  const chain = await loadTrustedAnnotationChain(
    arguments_.parentSidecarPath,
    arguments_,
    maximumChainBytes
  );
  if (chain.entryCount >= MAX_REVISION_CHAIN_ENTRIES) {
    throw revisionFailure(
      "REVISION_LIMIT_REACHED",
      `A lineage supports at most ${MAX_REVISION_CHAIN_ENTRIES - 1} committed revisions; start a new base annotation.`
    );
  }
  const input = await resolveRevisionInput(chain, arguments_);
  const applied = applyAnnotationRevisionEdits(chain.head.spec, arguments_.edits);
  const parentNumber = chain.head.manifest.revision?.number ?? 0;
  const revisionNumber = parentNumber + 1;
  const lineageId = chain.head.manifest.revision?.lineageId ?? chain.head.sha256;
  const baseStem = sidecarBaseStem(chain.head);
  const directory = path.dirname(chain.head.path);
  const desiredOutputPath = path.join(directory, `${baseStem}.rev${revisionNumber}.png`);
  const desiredSidecarPath = path.join(directory, `${baseStem}.rev${revisionNumber}.json`);
  let outputPath: string;
  let sidecarPath: string;
  try {
    outputPath = await canonicalOutputPath(desiredOutputPath, arguments_.allowedRoots);
    sidecarPath = await canonicalWritablePath(
      desiredSidecarPath,
      arguments_.allowedRoots,
      "Revision sidecar"
    );
  } catch (error) {
    throw revisionFailure(
      "REVISION_CONFLICT",
      "The next revision targets could not be resolved safely.",
      error
    );
  }
  if (outputPath !== desiredOutputPath || sidecarPath !== desiredSidecarPath) {
    throw revisionFailure(
      "REVISION_CONFLICT",
      "The next revision target is already an alias or symbolic link."
    );
  }
  const lockPath = path.join(directory, `.${lineageId}.revision.lock`);
  const token = randomUUID();
  const lockStagingPath = path.join(directory, `.${lineageId}.revision-lock.${token}.tmp`);
  const lockBytes = Buffer.from(
    stableJson({
      version: "1.0",
      token,
      pid: process.pid,
      lineageId,
      parentSidecarSha256: chain.head.sha256,
      revisionNumber,
      output: path.basename(outputPath),
      sidecar: path.basename(sidecarPath)
    }),
    "utf8"
  );
  let lockHandle: FileHandle | undefined;
  let lockIdentity: FileIdentity | undefined;
  for (let attempt = 0; attempt < 2 && lockHandle === undefined; attempt += 1) {
    let candidateHandle: FileHandle | undefined;
    let candidateIdentity: FileIdentity | undefined;
    let candidateCreated = false;
    try {
      candidateHandle = await open(lockStagingPath, "wx", 0o600);
      candidateCreated = true;
      const information = await candidateHandle.stat({ bigint: true });
      candidateIdentity = { device: information.dev, inode: information.ino };
      await runRevisionFault(arguments_, "lock-write");
      await candidateHandle.writeFile(lockBytes);
      await runRevisionFault(arguments_, "lock-flush");
      await candidateHandle.sync();
      try {
        await link(lockStagingPath, lockPath);
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
        try {
          await candidateHandle.close();
        } catch (closeError) {
          throw revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "A staged revision lock could not be closed after a lock conflict.",
            closeError
          );
        }
        candidateHandle = undefined;
        await removeOwnedTransactionFile(lockStagingPath, candidateIdentity);
        const recovery = await recoverExistingRevisionLock(
          lockPath,
          {
            lineageId,
            parentSidecarSha256: chain.head.sha256,
            revisionNumber,
            outputPath,
            sidecarPath
          },
          arguments_
        );
        if (recovery === "active") {
          throw revisionFailure(
            "REVISION_CONFLICT",
            "Another process is revising this annotation lineage."
          );
        }
        if (recovery === "committed") {
          throw revisionFailure(
            "REVISION_CONFLICT",
            "The requested parent is stale because its next revision is already committed."
          );
        }
        continue;
      }
      lockIdentity = candidateIdentity;
      lockHandle = candidateHandle;
      candidateHandle = undefined;
    } catch (error) {
      let cleanupError: unknown;
      if (candidateHandle !== undefined) {
        try {
          await candidateHandle.close();
        } catch (closeError) {
          cleanupError = closeError;
        }
      }
      if (candidateIdentity !== undefined) {
        try {
          await removeOwnedTransactionFile(lockStagingPath, candidateIdentity);
        } catch (removeError) {
          cleanupError ??= removeError;
        }
      }
      if (cleanupError !== undefined) {
        throw revisionFailure(
          "REVISION_RECOVERY_REQUIRED",
          "A staged revision lock could not be cleaned safely.",
          cleanupError
        );
      }
      if (candidateCreated && candidateIdentity === undefined) {
        throw revisionFailure(
          "REVISION_RECOVERY_REQUIRED",
          "A staged revision lock was created without verifiable ownership and was left for manual recovery.",
          error
        );
      }
      if (error instanceof AgentCalloutRevisionError) throw error;
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Could not stage and acquire the revision lock safely.",
        error
      );
    }
  }
  if (lockHandle === undefined || lockIdentity === undefined) {
    throw revisionFailure("REVISION_CONFLICT", "Revision lock recovery did not converge safely.");
  }

  let temporaryOutputPath: string | undefined;
  let temporarySidecarPath: string | undefined;
  let temporaryOutputIdentity: FileIdentity | undefined;
  let temporarySidecarIdentity: FileIdentity | undefined;
  let pngPublished = false;
  let publishedOutputIdentity: FileIdentity | undefined;
  let sidecarLinked = false;
  let sidecarPublished = false;
  let publishedOutputSha256: string | undefined;
  let publishedSidecarSha256: string | undefined;
  let result: RevisionResult | undefined;
  let pendingError: unknown;
  const recoveryWarnings: string[] = [];
  let cleanupIncomplete = false;
  let rollbackIncomplete = false;
  try {
    if ((await pathExists(outputPath)) || (await pathExists(sidecarPath))) {
      throw revisionFailure(
        "REVISION_CONFLICT",
        `Revision ${revisionNumber} was committed by another process.`
      );
    }

    const resolution = resolveAnnotationSpec(applied.spec, input.loaded.inspection.dimensions);
    const rendered = await renderAnnotations(input.loaded.bytes, resolution.spec.annotations, {
      limitInputPixels: input.loaded.limits.maxPixels,
      specVersion: resolution.spec.version
    });
    const warnings = [...resolution.warnings, ...rendered.warnings];
    const outputDimensions = { width: rendered.width, height: rendered.height };
    await verifyPng(rendered.buffer, outputDimensions, input.loaded.limits);
    const canonicalSpec = canonicalizeSpec(applied.spec);
    const specSha256 = sha256(canonicalSpec);
    const outputSha256 = sha256(rendered.buffer);
    publishedOutputSha256 = outputSha256;
    const sidecarDirectory = path.dirname(sidecarPath);
    const outputReference = portablePathReference(sidecarDirectory, outputPath);
    const inputReference = portablePathReference(sidecarDirectory, input.loaded.inspection.path);
    const parentSidecarReference = portablePathReference(sidecarDirectory, chain.head.path);
    const parentOutputReference = portablePathReference(sidecarDirectory, chain.head.output.path);
    const revision: RevisionManifestRecord = {
      number: revisionNumber,
      lineageId,
      parent: {
        sidecar: parentSidecarReference.path,
        sidecarSha256: chain.head.sha256,
        output: parentOutputReference.path,
        outputSha256: chain.head.output.sha256,
        specSha256: chain.head.specSha256
      },
      edits: applied.edits,
      editsSha256: applied.editsSha256
    };
    const manifest: AnnotationSidecarManifest = {
      manifestVersion: "1.1",
      operation: "annotate",
      pathSemantics:
        inputReference.semantics === "relative-to-sidecar"
          ? "relative-to-sidecar"
          : "per-input; see inputs[].pathSemantics",
      paths: {
        inputs: [inputReference.path],
        output: outputReference.path,
        sidecar: path.basename(sidecarPath)
      },
      inputs: [manifestInput(input.loaded.inspection, inputReference)],
      operationSpec: applied.spec,
      annotationSpec: applied.spec,
      hashes: {
        inputSha256: input.loaded.inspection.sha256,
        specSha256,
        outputSha256
      },
      originalDimensions: input.loaded.inspection.dimensions,
      outputDimensions,
      annotationCount: applied.spec.annotations.length,
      warnings,
      usesBlur: rendered.usesBlur,
      usesRedact: rendered.usesRedact,
      renderer: rendered.renderer,
      security: {
        exifOrientationApplied: true,
        metadataStripped: true,
        outputReDecoded: true,
        blurIsSecureRedaction: false,
        redactUsesOpaqueOverwrite: rendered.usesRedact
      },
      markdown: relativeMarkdown(outputReference.path, "AgentCallout output"),
      resolvedAnnotations: rendered.resolvedAnnotations,
      revision
    };
    const sidecarBytes = Buffer.from(stableJson(manifest), "utf8");
    const sidecarSha256 = sha256(sidecarBytes);
    const projectedChainBytes =
      chain.cumulativeBytes + BigInt(rendered.buffer.byteLength + sidecarBytes.byteLength);
    if (projectedChainBytes > BigInt(maximumChainBytes)) {
      throw revisionFailure(
        "REVISION_LIMIT_REACHED",
        `The next revision would exceed the ${maximumChainBytes}-byte cumulative lineage limit.`
      );
    }
    publishedSidecarSha256 = sidecarSha256;
    temporaryOutputPath = path.join(directory, `.${path.basename(outputPath)}.${token}.tmp`);
    temporarySidecarPath = path.join(directory, `.${path.basename(sidecarPath)}.${token}.tmp`);
    await writeSyncedRevisionTemp(
      temporaryOutputPath,
      rendered.buffer,
      "temp-png-write",
      "temp-png-flush",
      arguments_,
      (identity) => {
        temporaryOutputIdentity = identity;
      }
    );
    await writeSyncedRevisionTemp(
      temporarySidecarPath,
      sidecarBytes,
      "temp-sidecar-write",
      "temp-sidecar-flush",
      arguments_,
      (identity) => {
        temporarySidecarIdentity = identity;
      }
    );

    await assertSnapshotsUnchanged([...chain.committedSnapshots, input.snapshot]);
    if ((await pathExists(outputPath)) || (await pathExists(sidecarPath))) {
      throw revisionFailure(
        "REVISION_CONFLICT",
        `Revision ${revisionNumber} target appeared before publication.`
      );
    }
    const recheckedOutput = await canonicalOutputPath(outputPath, arguments_.allowedRoots);
    const recheckedSidecar = await canonicalWritablePath(
      sidecarPath,
      arguments_.allowedRoots,
      "Revision sidecar"
    );
    if (recheckedOutput !== outputPath || recheckedSidecar !== sidecarPath) {
      throw revisionFailure(
        "REVISION_CONFLICT",
        "Revision target directory changed before publication."
      );
    }

    await runRevisionFault(arguments_, "png-publish");
    try {
      await link(temporaryOutputPath, outputPath);
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        throw revisionFailure("REVISION_CONFLICT", "Revision PNG target already exists.");
      }
      throw error;
    }
    pngPublished = true;
    publishedOutputIdentity = temporaryOutputIdentity;
    await runRevisionFault(arguments_, "temp-png-remove");
    if (temporaryOutputIdentity === undefined) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "Revision PNG temp ownership was unavailable before cleanup."
      );
    }
    await removeOwnedTransactionFile(temporaryOutputPath, temporaryOutputIdentity);
    temporaryOutputPath = undefined;
    temporaryOutputIdentity = undefined;
    await runRevisionFault(arguments_, "png-verify");
    const verifiedPublishedOutput = await readStableFile(
      outputPath,
      input.loaded.limits.maxFileBytes,
      "REVISION_PUBLISH_FAILED"
    );
    if (
      verifiedPublishedOutput.snapshot.sha256 !== outputSha256 ||
      publishedOutputIdentity === undefined ||
      !sameFileIdentity(verifiedPublishedOutput.snapshot.identity, publishedOutputIdentity)
    ) {
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Published revision PNG failed its identity or SHA-256 verification."
      );
    }

    await runRevisionFault(arguments_, "sidecar-publish");
    await assertSnapshotsUnchanged([...chain.committedSnapshots, input.snapshot]);
    const preCommitOutput = await readStableFile(
      outputPath,
      input.loaded.limits.maxFileBytes,
      "REVISION_PUBLISH_FAILED"
    );
    if (
      preCommitOutput.snapshot.sha256 !== outputSha256 ||
      !sameFileIdentity(preCommitOutput.snapshot.identity, publishedOutputIdentity)
    ) {
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Revision PNG changed before the sidecar commit marker was published."
      );
    }
    try {
      await link(temporarySidecarPath, sidecarPath);
    } catch (error) {
      if (isFileSystemError(error, "EEXIST")) {
        throw revisionFailure("REVISION_CONFLICT", "Revision sidecar target already exists.");
      }
      throw error;
    }
    sidecarLinked = true;
    await runRevisionFault(arguments_, "sidecar-verify");
    const committedSidecar = await readStableFile(
      sidecarPath,
      10 * 1024 * 1024,
      "REVISION_PUBLISH_FAILED"
    );
    if (committedSidecar.snapshot.sha256 !== sidecarSha256) {
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Published revision sidecar failed its SHA-256 verification."
      );
    }
    const parsedCommittedSidecar = parseAnnotationSidecar(committedSidecar.bytes);
    if (
      parsedCommittedSidecar.revision?.number !== revisionNumber ||
      parsedCommittedSidecar.revision.lineageId !== lineageId ||
      parsedCommittedSidecar.revision.parent.sidecarSha256 !== chain.head.sha256
    ) {
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Published revision sidecar failed its lineage verification."
      );
    }
    const trustedCommit = await loadTrustedAnnotationSidecar(sidecarPath, arguments_);
    if (
      trustedCommit.sha256 !== sidecarSha256 ||
      trustedCommit.output.sha256 !== outputSha256 ||
      publishedOutputIdentity === undefined ||
      !sameFileIdentity(trustedCommit.outputSnapshot.identity, publishedOutputIdentity)
    ) {
      throw revisionFailure(
        "REVISION_PUBLISH_FAILED",
        "Published revision pair failed its final trusted readback."
      );
    }
    sidecarPublished = true;
    result = {
      operation: "annotate",
      outputPath,
      sidecarPath,
      markdown: markdownPath(outputPath, "AgentCallout output"),
      originalDimensions: input.loaded.inspection.dimensions,
      outputDimensions,
      annotationCount: applied.spec.annotations.length,
      warnings,
      inputSha256: input.loaded.inspection.sha256,
      specSha256,
      outputSha256,
      usesBlur: rendered.usesBlur,
      usesRedact: rendered.usesRedact,
      renderer: rendered.renderer,
      revision: {
        number: revisionNumber,
        lineageId,
        parentSidecarPath: chain.head.path,
        editsSha256: applied.editsSha256
      }
    };
    await runRevisionFault(arguments_, "temp-sidecar-remove");
    if (temporarySidecarIdentity === undefined) {
      throw revisionFailure(
        "REVISION_RECOVERY_REQUIRED",
        "Revision sidecar temp ownership was unavailable before cleanup."
      );
    }
    await removeOwnedTransactionFile(temporarySidecarPath, temporarySidecarIdentity);
    temporarySidecarPath = undefined;
    temporarySidecarIdentity = undefined;
  } catch (error) {
    pendingError = error;
    if (sidecarLinked && !sidecarPublished) {
      try {
        if (publishedSidecarSha256 === undefined) {
          throw revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "The transaction lost its expected sidecar hash during rollback."
          );
        }
        await removeOwnedPublishedSidecar(sidecarPath, publishedSidecarSha256);
        sidecarLinked = false;
      } catch (cleanupError) {
        pendingError = cleanupError;
      }
    }
    if (pngPublished && !sidecarPublished) {
      try {
        if (publishedOutputSha256 === undefined) {
          throw revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "The transaction lost its expected PNG hash during rollback."
          );
        }
        await runRevisionFault(arguments_, "rollback-png");
        await removeOwnedPublishedPng(outputPath, sidecarPath, publishedOutputSha256);
        pngPublished = false;
      } catch (cleanupError) {
        pendingError = cleanupError;
        rollbackIncomplete = true;
      }
    }
  } finally {
    let lockCloseFault: unknown;
    try {
      await runRevisionFault(arguments_, "lock-close");
    } catch (error) {
      lockCloseFault = error;
    }
    try {
      await lockHandle.close();
    } catch (error) {
      lockCloseFault ??= error;
    }
    if (lockCloseFault !== undefined) {
      cleanupIncomplete = true;
      if (sidecarPublished) {
        recoveryWarnings.push("Committed revision lock handle could not be closed cleanly.");
      } else {
        pendingError = revisionFailure(
          "REVISION_RECOVERY_REQUIRED",
          "Revision lock handle could not be closed safely.",
          lockCloseFault
        );
      }
    }
    if (rollbackIncomplete && publishedOutputSha256 !== undefined) {
      try {
        await removeOwnedPublishedPng(outputPath, sidecarPath, publishedOutputSha256);
        pngPublished = false;
        rollbackIncomplete = false;
      } catch (cleanupError) {
        cleanupIncomplete = true;
        pendingError = cleanupError;
      }
    }
    const cleanupTemporary = async (
      temporaryPath: string | undefined,
      temporaryIdentity: FileIdentity | undefined,
      faultPoint: "temp-png-remove" | "temp-sidecar-remove"
    ): Promise<boolean> => {
      if (temporaryPath === undefined) return true;
      try {
        if (temporaryIdentity === undefined) {
          if (!(await pathExists(temporaryPath))) return true;
          throw revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "A transaction temp exists without verifiable ownership."
          );
        }
        await runRevisionFault(arguments_, faultPoint);
        await removeOwnedTransactionFile(temporaryPath, temporaryIdentity);
        return true;
      } catch (cleanupError) {
        cleanupIncomplete = true;
        if (sidecarPublished) {
          recoveryWarnings.push("Committed revision left a transaction temp file for recovery.");
        } else {
          pendingError = revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "A revision temp file could not be cleaned safely.",
            cleanupError
          );
        }
        return false;
      }
    };
    if (await cleanupTemporary(temporaryOutputPath, temporaryOutputIdentity, "temp-png-remove")) {
      temporaryOutputPath = undefined;
      temporaryOutputIdentity = undefined;
    }
    if (!rollbackIncomplete) {
      if (
        await cleanupTemporary(
          temporarySidecarPath,
          temporarySidecarIdentity,
          "temp-sidecar-remove"
        )
      ) {
        temporarySidecarPath = undefined;
        temporarySidecarIdentity = undefined;
      }
    } else {
      cleanupIncomplete = true;
    }
    if (lockIdentity !== undefined && !cleanupIncomplete) {
      try {
        await removeOwnedTransactionFile(lockStagingPath, lockIdentity);
      } catch (cleanupError) {
        cleanupIncomplete = true;
        if (sidecarPublished) {
          recoveryWarnings.push("Committed revision left a staged lock file for recovery.");
        } else {
          pendingError = cleanupError;
        }
      }
    }
    if (lockIdentity === undefined) {
      if (sidecarPublished) {
        recoveryWarnings.push(
          "Committed revision lock ownership could not be verified for cleanup."
        );
      } else {
        pendingError = revisionFailure(
          "REVISION_RECOVERY_REQUIRED",
          "Revision lock identity was unavailable during cleanup."
        );
      }
    } else {
      if (cleanupIncomplete) {
        if (sidecarPublished) {
          recoveryWarnings.push(
            "Committed revision lock was retained so transaction residue can be recovered safely."
          );
        } else {
          pendingError = revisionFailure(
            "REVISION_RECOVERY_REQUIRED",
            "Revision lock was retained because transaction cleanup is incomplete."
          );
        }
      } else {
        try {
          await runRevisionFault(arguments_, "lock-remove");
          await removeRevisionLock(lockPath, lockIdentity);
        } catch (cleanupError) {
          if (sidecarPublished) {
            recoveryWarnings.push(
              "Committed revision lock could not be removed; recovery is required."
            );
          } else {
            pendingError = cleanupError;
          }
        }
      }
    }
  }

  if (result !== undefined) {
    if (recoveryWarnings.length > 0) result.recoveryWarnings = [...new Set(recoveryWarnings)];
    return result;
  }
  if (pendingError instanceof AgentCalloutRevisionError) throw pendingError;
  throw revisionFailure(
    "REVISION_PUBLISH_FAILED",
    `Revision could not be published: ${errorMessage(pendingError)}`,
    pendingError
  );
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
    limits: {
      maxFileBytes: DEFAULT_IMAGE_LIMITS.maxFileBytes,
      maxPixels: DEFAULT_IMAGE_LIMITS.maxPixels,
      maxAnnotations: MAX_ANNOTATIONS,
      maxTotalTextLength: MAX_TOTAL_TEXT_LENGTH
    },
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
