import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Command, CommanderError, InvalidArgumentError } from "commander";
import sharp from "sharp";

import {
  AGENT_CALLOUT_VERSION,
  AgentCalloutRevisionError,
  annotateImage,
  createContactSheet,
  createHandoffPackage,
  cropImage,
  DomRuntimeError,
  getCoreDoctorReport,
  installBrowserRuntime,
  inspectBrowserRuntime,
  installOcrRuntime,
  inspectOcrRuntime,
  inspectAnnotationSidecar,
  inspectImage,
  locateDom,
  locateText,
  OcrImageError,
  OcrRuntimeError,
  reviseAnnotation,
  validateSpecForImage,
  verifyHandoffPackage
} from "../index.js";
import { startStdioMcpServer } from "../mcp/server.js";

export interface CliWritable {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: CliWritable;
  stderr: CliWritable;
}

interface CommonOptions {
  allowRoot?: string[];
  json?: boolean;
}

interface SpecOptions extends CommonOptions {
  spec?: string;
  specJson?: string;
}

interface OutputOptions extends CommonOptions {
  output?: string;
  overwrite?: boolean;
}

interface AnnotateOptions extends SpecOptions, OutputOptions {}

interface RevisionOptions extends CommonOptions {
  edits?: string;
  editsJson?: string;
  input?: string;
}

interface CropOptions extends OutputOptions {
  coordinateSpace: "pixel" | "normalized";
  rect: string;
}

interface ContactSheetOptions extends OutputOptions {
  background?: string;
  cellHeight?: number;
  cellWidth?: number;
  columns?: number;
  labels?: boolean;
  padding?: number;
}

interface DoctorOptions {
  json?: boolean;
  selfTest?: boolean;
}

interface OcrOptions extends CommonOptions {
  runtimeDirectory?: string;
  languages?: ("eng" | "chi_sim")[];
}

interface HandoffOptions extends CommonOptions {
  outputDir?: string;
  original?: boolean;
  overwrite?: boolean;
}

type BrowserOptions = OcrOptions;

interface LocateDomOptions extends BrowserOptions {
  selector?: string;
  text?: string;
  accessible?: string;
  exact?: boolean;
  role?: string;
  screenshot: string;
  viewport?: { width: number; height: number };
  timeout?: number;
  maxCandidates: number;
  browserExecutable?: string;
}

interface LocateOptions extends OcrOptions {
  query: string;
  mode: "exact" | "contains";
  caseSensitive?: boolean;
  minConfidence: number;
  maxCandidates: number;
  region?: string;
  scale: number;
  invert?: boolean;
  expectedInputSha256?: string;
}

function parseOcrLanguages(value: string): ("eng" | "chi_sim")[] {
  const languages = value.split(",").map((language) => language.trim());
  if (
    languages.length === 0 ||
    new Set(languages).size !== languages.length ||
    languages.some((language) => language !== "eng" && language !== "chi_sim")
  ) {
    throw new InvalidArgumentError("OCR languages must be eng, chi_sim, or eng,chi_sim.");
  }
  return languages as ("eng" | "chi_sim")[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

class ReportedCliFailure extends Error {
  public constructor(public readonly exitCode: number) {
    super("Command reported an unsuccessful result");
  }
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr
};

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return parsed;
}

function parseRect(value: string): Rect {
  let candidate: unknown;
  try {
    candidate = value.trimStart().startsWith("{")
      ? JSON.parse(value)
      : (() => {
          const values = value.split(",").map((part) => Number(part.trim()));
          if (values.length !== 4) {
            return undefined;
          }
          const [x, y, width, height] = values;
          return { x, y, width, height };
        })();
  } catch (error) {
    throw new InvalidArgumentError(`Invalid rectangle JSON: ${errorMessage(error)}`);
  }

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new InvalidArgumentError(
      "Rectangle must be x,y,width,height or a JSON object with those four fields."
    );
  }
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "height,width,x,y") {
    throw new InvalidArgumentError("Rectangle must contain only x, y, width, and height.");
  }

  const rect: Rect = {
    x: Number(record.x),
    y: Number(record.y),
    width: Number(record.width),
    height: Number(record.height)
  };
  if (!Object.values(rect).every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new InvalidArgumentError("Rectangle values must be finite and width/height must be > 0.");
  }
  return rect;
}

function errorMessage(error: unknown): string {
  if (
    error instanceof AgentCalloutRevisionError ||
    error instanceof DomRuntimeError ||
    error instanceof OcrImageError ||
    error instanceof OcrRuntimeError
  ) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return String(error);
}

function writeLine(stream: CliWritable, value = ""): void {
  stream.write(`${value}\n`);
}

function jsonText(value: unknown, pretty: boolean): string {
  return JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue,
    pretty ? 2 : undefined
  );
}

function writeResult(
  io: CliIo,
  value: unknown,
  options: CommonOptions | DoctorOptions,
  friendly: () => string
): void {
  writeLine(io.stdout, options.json === true ? jsonText(value, true) : friendly());
}

function resolvedRoots(options: CommonOptions): string[] | undefined {
  const roots = options.allowRoot?.map((root) => resolve(root)) ?? [];
  return roots.length === 0 ? undefined : roots;
}

async function loadSpec(options: SpecOptions): Promise<unknown> {
  if ((options.spec === undefined) === (options.specJson === undefined)) {
    throw new Error("Provide exactly one of --spec <file> or --spec-json <json>.");
  }

  const source =
    options.specJson ?? (await readFile(resolve(options.spec as string), { encoding: "utf8" }));
  try {
    return JSON.parse(source);
  } catch (error) {
    const origin = options.specJson === undefined ? resolve(options.spec as string) : "--spec-json";
    throw new Error(`Could not parse AnnotationSpec from ${origin}: ${errorMessage(error)}`);
  }
}

async function loadRevisionEdits(options: RevisionOptions): Promise<unknown> {
  if ((options.edits === undefined) === (options.editsJson === undefined)) {
    throw new Error("Provide exactly one of --edits <file> or --edits-json <json>.");
  }

  const source =
    options.editsJson ?? (await readFile(resolve(options.edits as string), { encoding: "utf8" }));
  try {
    return JSON.parse(source);
  } catch (error) {
    const origin =
      options.editsJson === undefined ? resolve(options.edits as string) : "--edits-json";
    throw new Error(`Could not parse revision edits from ${origin}: ${errorMessage(error)}`);
  }
}

function formatDimensions(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.width === "number" && typeof record.height === "number") {
      return `${record.width} x ${record.height}`;
    }
  }
  return "unknown";
}

function scalarText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return "unknown";
  }
}

function warningLines(warnings: unknown[]): string[] {
  if (warnings.length === 0) {
    return ["Warnings: 0"];
  }
  return [`Warnings: ${warnings.length}`, ...warnings.map((warning) => `- ${scalarText(warning)}`)];
}

function formatInspection(result: Awaited<ReturnType<typeof inspectImage>>): string {
  const value = result as unknown as Record<string, unknown>;
  return [
    `Image: ${scalarText(value.path ?? value.inputPath)}`,
    `Format: ${scalarText(value.format ?? value.mime)}`,
    `Dimensions: ${formatDimensions(value.dimensions)}`,
    `Size: ${scalarText(value.sizeBytes)} bytes`,
    `SHA-256: ${scalarText(value.sha256)}`
  ].join("\n");
}

function formatSidecarInspection(
  result: Awaited<ReturnType<typeof inspectAnnotationSidecar>>
): string {
  return [
    "Annotation sidecar is valid.",
    `Manifest: ${result.manifestVersion}; AnnotationSpec: ${result.annotationSpecVersion}`,
    `Output dimensions: ${result.outputDimensions.width}x${result.outputDimensions.height}`,
    `Annotations: ${result.annotations.total} (${
      Object.entries(result.annotations.byType)
        .map(([type, count]) => `${type}=${count}`)
        .join(", ") || "none"
    })`,
    `Revision: ${result.revision.number}; chain entries: ${result.revision.chainEntries}`,
    `Warnings: ${result.warnings.count}`,
    `Original input: ${result.integrity.originalInput}`,
    `Safety: blur=${String(result.safety.usesBlur)}, redact=${String(result.safety.usesRedact)}`
  ].join("\n");
}

function formatGenerated(action: string, result: Awaited<ReturnType<typeof cropImage>>): string {
  const value = result as unknown as Record<string, unknown>;
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  const recoveryWarnings = Array.isArray(value.recoveryWarnings) ? value.recoveryWarnings : [];
  return [
    `${action} complete.`,
    `Output: ${scalarText(value.outputPath)}`,
    `Sidecar: ${scalarText(value.sidecarPath)}`,
    `Markdown: ${scalarText(value.markdown)}`,
    `SHA-256: ${scalarText(value.outputSha256)}`,
    ...warningLines(warnings),
    ...recoveryWarnings.map((warning) => `Recovery warning: ${scalarText(warning)}`)
  ].join("\n");
}

function doctorIsHealthy(report: unknown): boolean {
  if (report === null || typeof report !== "object") {
    return true;
  }
  const record = report as Record<string, unknown>;
  if (typeof record.ok === "boolean") {
    return record.ok;
  }
  if (typeof record.healthy === "boolean") {
    return record.healthy;
  }
  if (typeof record.status === "string") {
    return !["error", "failed", "unhealthy"].includes(record.status.toLowerCase());
  }
  return true;
}

async function runSelfTest(): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), "agent-callout-self-test-"));
  try {
    const inputPath = join(directory, "输入-自检.png");
    const outputPath = join(directory, "redact-output.png");
    await sharp({
      create: {
        width: 24,
        height: 16,
        channels: 4,
        background: { r: 30, g: 90, b: 180, alpha: 1 }
      }
    })
      .png()
      .toFile(inputPath);

    const inspection = await inspectImage(inputPath, { allowedRoots: [directory] });
    const generated = await annotateImage({
      inputPath,
      outputPath,
      spec: {
        version: "1.0",
        annotations: [
          {
            id: "doctor-redact",
            type: "redact",
            rect: { x: 4, y: 4, width: 8, height: 6 },
            color: "#000000"
          }
        ]
      },
      allowedRoots: [directory]
    });
    const decoded = await sharp(generated.outputPath).ensureAlpha().raw().toBuffer({
      resolveWithObject: true
    });
    if (decoded.info.width !== 24 || decoded.info.height !== 16 || decoded.info.channels !== 4) {
      throw new Error("Self-test annotated output could not be decoded with expected dimensions.");
    }
    for (let y = 4; y < 10; y += 1) {
      for (let x = 4; x < 12; x += 1) {
        const offset = (y * decoded.info.width + x) * decoded.info.channels;
        if (
          decoded.data[offset] !== 0 ||
          decoded.data[offset + 1] !== 0 ||
          decoded.data[offset + 2] !== 0 ||
          decoded.data[offset + 3] !== 255
        ) {
          throw new Error("Self-test redact region retained a non-opaque source pixel.");
        }
      }
    }
    const sidecar = JSON.parse(await readFile(generated.sidecarPath, "utf8")) as unknown;
    if (sidecar === null || typeof sidecar !== "object" || Array.isArray(sidecar)) {
      throw new Error("Self-test sidecar was not a JSON object.");
    }

    return {
      passed: true,
      input: {
        format: inspection.format,
        dimensions: inspection.dimensions,
        sha256: inspection.sha256
      },
      annotation: {
        dimensions: generated.outputDimensions,
        outputSha256: generated.outputSha256,
        sidecarDecoded: true,
        redactPixelsVerified: true,
        usesRedact: generated.usesRedact
      }
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--allow-root <path>", "Allowed input/output root (repeatable)", collectValue, [])
    .option("--json", "Write one JSON value to stdout");
}

function addOutputOptions(command: Command): Command {
  return addCommonOptions(command)
    .option("-o, --output <path>", "Output PNG path")
    .option("--overwrite", "Allow replacing an existing non-input output");
}

function addSpecOptions(command: Command): Command {
  return command
    .option("-s, --spec <file>", "AnnotationSpec JSON file")
    .option("--spec-json <json>", "Inline AnnotationSpec JSON");
}

export function createCliProgram(io: CliIo = defaultIo): Command {
  const program = new Command();
  program
    .name("agent-callout")
    .description("Give AI agents a pen for screenshots.")
    .version(AGENT_CALLOUT_VERSION)
    .showSuggestionAfterError(true)
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => io.stderr.write(text)
    });

  addCommonOptions(
    program.command("inspect <input>").description("Inspect an image safely.")
  ).action(async (input: string, options: CommonOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await inspectImage(input, allowedRoots === undefined ? {} : { allowedRoots });
    writeResult(io, result, options, () => formatInspection(result));
  });

  const ocr = program
    .command("ocr")
    .description("Manage the optional local OCR engine and models.");
  ocr
    .command("install")
    .description("Explicitly download and verify the pinned OCR engine and language models.")
    .option("--runtime-directory <path>", "Trusted runtime cache directory")
    .option("--languages <list>", "Comma-separated eng/chi_sim models", parseOcrLanguages)
    .option("--json", "Write one JSON value to stdout")
    .action(async (options: OcrOptions) => {
      const result = await installOcrRuntime({
        ...(options.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: options.runtimeDirectory }),
        ...(options.languages === undefined ? {} : { languages: options.languages })
      });
      writeResult(
        io,
        result,
        options,
        () => `OCR runtime ${result.status}; models: ${result.installedLanguages.join(", ")}.`
      );
    });
  ocr
    .command("status")
    .description("Inspect local OCR installation without downloading or starting recognition.")
    .option("--runtime-directory <path>", "Trusted runtime cache directory")
    .option("--json", "Write one JSON value to stdout")
    .action(async (options: OcrOptions) => {
      const result = await inspectOcrRuntime(
        options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory }
      );
      writeResult(
        io,
        result,
        options,
        () =>
          `OCR runtime ${result.status}; models: ${result.installedLanguages.join(", ") || "none"}.`
      );
    });

  const browser = program
    .command("browser")
    .description("Manage the optional browser runtime for DOM locating.");
  browser
    .command("install")
    .description("Explicitly install the pinned browser runtime (playwright-core).")
    .option("--runtime-directory <path>", "Trusted runtime cache directory")
    .option("--json", "Write one JSON value to stdout")
    .action(async (options: OcrOptions) => {
      const result = await installBrowserRuntime(
        options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory }
      );
      writeResult(io, result, options, () => `Browser runtime ${result.status}.`);
    });
  browser
    .command("status")
    .description("Inspect the browser runtime without installing or launching anything.")
    .option("--runtime-directory <path>", "Trusted runtime cache directory")
    .option("--json", "Write one JSON value to stdout")
    .action(async (options: OcrOptions) => {
      const result = await inspectBrowserRuntime(
        options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory }
      );
      writeResult(io, result, options, () => `Browser runtime ${result.status}.`);
    });

  const parseViewport = (value: string): { width: number; height: number } => {
    const match = /^(\d+)x(\d+)$/u.exec(value);
    if (match === null) {
      throw new InvalidArgumentError("Viewport must look like 1280x800.");
    }
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 240) {
      throw new InvalidArgumentError("Viewport must be at least 320x240.");
    }
    return { width, height };
  };

  addCommonOptions(
    program
      .command("locate-dom <url>")
      .description(
        "Locate a web element by selector, text or accessible name and bind it to a screenshot."
      )
      .requiredOption("--screenshot <path>", "Full-page screenshot output path (PNG)")
      .option("--selector <css>", "CSS selector to locate")
      .option("--text <text>", "Text content to locate")
      .option("--accessible <name>", "Accessible name to locate")
      .option("--exact", "Require exact text/name matching")
      .option("--role <role>", "Filter accessible matches by role")
      .option("--viewport <WxH>", "Browser viewport (default 1280x800)", parseViewport)
      .option(
        "--max-candidates <count>",
        "Maximum candidates returned (1-100)",
        parsePositiveInteger,
        100
      )
      .option("--timeout <ms>", "Navigation and locate timeout", parsePositiveInteger, 15000)
      .option("--runtime-directory <path>", "Trusted runtime cache directory")
      .option("--browser-executable <path>", "Explicit Chrome executable path")
  ).action(async (url: string, options: LocateDomOptions) => {
    const locatorCount = [options.selector, options.text, options.accessible].filter(
      (value) => value !== undefined
    ).length;
    if (locatorCount !== 1) {
      throw new InvalidArgumentError("Pass exactly one of --selector, --text or --accessible.");
    }
    const result = await locateDom({
      url,
      locator:
        options.selector !== undefined
          ? { kind: "selector", value: options.selector }
          : options.text !== undefined
            ? { kind: "text", value: options.text, exact: options.exact ?? false }
            : {
                kind: "accessible",
                value: options.accessible ?? "",
                exact: options.exact ?? false,
                role: options.role
              },
      screenshotPath: options.screenshot,
      ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
      ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
      ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
      ...(options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory }),
      ...(options.browserExecutable === undefined
        ? {}
        : { browserExecutablePath: options.browserExecutable })
    });
    writeResult(io, result, options, () =>
      [
        `Located ${result.candidates.length} candidate(s) (${result.totalCandidates} total) on ${result.page.url}.`,
        ...result.candidates
          .slice(0, 5)
          .map(
            (candidate, index) =>
              `  ${index + 1}. ${candidate.tag}${candidate.role ? ` [${candidate.role}]` : ""} @ ${candidate.rect.x},${candidate.rect.y} ${candidate.rect.width}x${candidate.rect.height}`
          ),
        `screenshot: ${result.screenshot.path} (sha256 ${result.screenshot.sha256.slice(0, 12)}…)`
      ].join("\n")
    );
  });

  addCommonOptions(
    program
      .command("locate-text <input>")
      .description(
        "Locate local image text and return candidates; does not annotate or download models."
      )
      .requiredOption("--query <text>", "Text to find")
      .option(
        "--mode <mode>",
        "exact or contains",
        (value: string) => {
          if (value !== "exact" && value !== "contains")
            throw new InvalidArgumentError("Mode must be exact or contains.");
          return value;
        },
        "exact"
      )
      .option("--case-sensitive", "Require matching letter case")
      .option(
        "--min-confidence <score>",
        "Confirmation threshold from 0 to 100 (not a probability)",
        (value: string) => {
          const score = Number(value);
          if (!Number.isFinite(score) || score < 0 || score > 100)
            throw new InvalidArgumentError("Confidence must be 0 to 100.");
          return score;
        },
        80
      )
      .option(
        "--max-candidates <count>",
        "Maximum candidates returned (1-100)",
        parsePositiveInteger,
        100
      )
      .option("--languages <list>", "Comma-separated eng/chi_sim languages", parseOcrLanguages)
      .option("--runtime-directory <path>", "Trusted runtime cache directory")
      .option("--region <x,y,width,height|json>", "Optional region in oriented source pixels")
      .option("--scale <factor>", "Explicit OCR scale, integer 1-4", parsePositiveInteger, 1)
      .option("--invert", "Explicitly invert the prepared OCR raster")
      .option("--expected-input-sha256 <hash>", "Reject a screenshot changed since inspection")
  ).action(async (input: string, options: LocateOptions) => {
    const result = await locateText({
      inputPath: input,
      query: options.query,
      mode: options.mode,
      caseSensitive: options.caseSensitive ?? false,
      minimumConfidence: options.minConfidence,
      maxCandidates: options.maxCandidates,
      scale: options.scale,
      preprocess: options.invert === true ? "invert" : "none",
      ...(options.region === undefined ? {} : { region: parseRect(options.region) }),
      ...(options.languages === undefined ? {} : { languages: options.languages }),
      ...(options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory }),
      ...(options.expectedInputSha256 === undefined
        ? {}
        : { expectedInputSha256: options.expectedInputSha256 }),
      ...(resolvedRoots(options) === undefined ? {} : { allowedRoots: resolvedRoots(options) })
    });
    writeResult(
      io,
      result,
      options,
      () =>
        `${result.status}: ${result.candidates.length} of ${result.totalCandidates} candidates; confirmation required: ${result.requiresConfirmation}.\n${jsonText(result.candidates, true)}`
    );
  });

  addCommonOptions(
    program
      .command("inspect-sidecar <sidecar>")
      .description("Validate an annotation sidecar and print a path-free summary.")
  ).action(async (sidecar: string, options: CommonOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await inspectAnnotationSidecar({
      sidecarPath: sidecar,
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () => formatSidecarInspection(result));
  });

  addSpecOptions(
    addCommonOptions(
      program
        .command("validate <input>")
        .description("Validate an AnnotationSpec against an image.")
    )
  ).action(async (input: string, options: SpecOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await validateSpecForImage({
      inputPath: input,
      spec: await loadSpec(options),
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () => {
      const value = result as unknown as Record<string, unknown>;
      const warnings = Array.isArray(value.warnings) ? value.warnings : [];
      return ["AnnotationSpec is valid.", ...warningLines(warnings)].join("\n");
    });
  });

  addSpecOptions(
    addOutputOptions(
      program.command("annotate <input>").description("Render annotations onto an image.")
    )
  ).action(async (input: string, options: AnnotateOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await annotateImage({
      inputPath: input,
      spec: await loadSpec(options),
      ...(options.output === undefined ? {} : { outputPath: options.output }),
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () => formatGenerated("Annotation", result));
  });

  addCommonOptions(
    program
      .command("revise <parentSidecar>")
      .description("Validate a sidecar and create its next append-only annotation revision.")
      .option("--edits <file>", "Ordered add/set/remove edits JSON file")
      .option("--edits-json <json>", "Inline ordered add/set/remove edits JSON")
      .option("--input <path>", "Moved or basename-only original with the parent-recorded SHA-256")
  ).action(async (parentSidecar: string, options: RevisionOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await reviseAnnotation({
      parentSidecarPath: parentSidecar,
      edits: await loadRevisionEdits(options),
      ...(options.input === undefined ? {} : { inputPath: options.input }),
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () => formatGenerated("Revision", result));
  });

  addCommonOptions(
    program
      .command("create-handoff <parentSidecar>")
      .description(
        "Create a plain-directory handoff package (PNG + full JSON + manifest + summary + entry)."
      )
      .option("--output-dir <path>", "Target handoff directory")
      .option(
        "--no-original",
        "Omit the original image; the package cannot be re-rendered or revised"
      )
      .option("--overwrite", "Replace an existing handoff directory at the target path")
  ).action(async (parentSidecar: string, options: HandoffOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await createHandoffPackage({
      sidecarPath: parentSidecar,
      ...(options.outputDir === undefined ? {} : { outputDirectory: options.outputDir }),
      ...(options.original === undefined ? {} : { includeOriginal: options.original }),
      ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () =>
      [
        `Handoff package: ${result.handoffDirectory}`,
        `  annotations: ${result.annotationCount}${result.revisionNumber === undefined ? "" : ` (revision ${result.revisionNumber})`}`,
        `  verify: agent-callout verify-handoff ${result.handoffDirectory}`
      ].join("\n")
    );
  });

  addCommonOptions(
    program
      .command("verify-handoff <handoffDirectory>")
      .description("Verify a handoff package manifest, file hashes and packaged sidecar.")
  ).action(async (handoffDirectory: string, options: HandoffOptions) => {
    const allowedRoots = resolvedRoots(options);
    const result = await verifyHandoffPackage({
      handoffDirectory,
      ...(allowedRoots === undefined ? {} : { allowedRoots })
    });
    writeResult(io, result, options, () =>
      result.valid
        ? `Handoff package OK: ${result.filesChecked} files verified.`
        : `Handoff package INVALID:\n${result.issues
            .map((issue) => `  [${issue.code}] ${issue.path ?? ""} ${issue.detail}`.trimEnd())
            .join("\n")}`
    );
  });

  addOutputOptions(
    program.command("crop <input>").description("Crop an image for close inspection.")
  )
    .requiredOption(
      "--rect <x,y,width,height|json>",
      "Crop rectangle in pixels or normalized coordinates"
    )
    .option(
      "--coordinate-space <space>",
      "Coordinate space: pixel or normalized",
      (value: string) => {
        if (value !== "pixel" && value !== "normalized") {
          throw new InvalidArgumentError("Coordinate space must be pixel or normalized.");
        }
        return value;
      },
      "pixel"
    )
    .action(async (input: string, options: CropOptions) => {
      const allowedRoots = resolvedRoots(options);
      const result = await cropImage({
        inputPath: input,
        rect: parseRect(options.rect),
        coordinateSpace: options.coordinateSpace,
        ...(options.output === undefined ? {} : { outputPath: options.output }),
        ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
        ...(allowedRoots === undefined ? {} : { allowedRoots })
      });
      writeResult(io, result, options, () => formatGenerated("Crop", result));
    });

  addOutputOptions(
    program.command("contact-sheet <inputs...>").description("Combine images into a contact sheet.")
  )
    .option("--columns <count>", "Number of columns", parsePositiveInteger)
    .option("--cell-width <pixels>", "Cell width", parsePositiveInteger)
    .option("--cell-height <pixels>", "Cell height", parsePositiveInteger)
    .option("--padding <pixels>", "Cell padding", parseNonNegativeInteger)
    .option("--background <color>", "Background color")
    .option("--no-labels", "Do not render source filename labels")
    .action(async (inputs: string[], options: ContactSheetOptions) => {
      const allowedRoots = resolvedRoots(options);
      const result = await createContactSheet({
        inputPaths: inputs,
        ...(options.output === undefined ? {} : { outputPath: options.output }),
        ...(options.columns === undefined ? {} : { columns: options.columns }),
        ...(options.cellWidth === undefined ? {} : { cellWidth: options.cellWidth }),
        ...(options.cellHeight === undefined ? {} : { cellHeight: options.cellHeight }),
        ...(options.padding === undefined ? {} : { padding: options.padding }),
        ...(options.background === undefined ? {} : { background: options.background }),
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
        ...(allowedRoots === undefined ? {} : { allowedRoots })
      });
      writeResult(io, result, options, () => formatGenerated("Contact sheet", result));
    });

  program
    .command("doctor")
    .description("Check runtime health and optionally exercise real image I/O.")
    .option("--self-test", "Generate, inspect, resize, and decode a temporary image")
    .option("--json", "Write one JSON value to stdout")
    .action(async (options: DoctorOptions) => {
      const core = await getCoreDoctorReport();
      const result: Record<string, unknown> = { core };
      if (options.selfTest === true) {
        result.selfTest = await runSelfTest();
      }
      writeResult(io, result, options, () => {
        const selfTest = options.selfTest === true ? " Self-test passed." : "";
        return `AgentCallout ${AGENT_CALLOUT_VERSION} doctor completed.${selfTest}`;
      });
      if (!doctorIsHealthy(core)) {
        writeLine(io.stderr, "AgentCallout doctor found an unhealthy core dependency.");
        throw new ReportedCliFailure(1);
      }
    });

  program
    .command("mcp")
    .description("Run the local stdio MCP server (stdout is JSON-RPC only).")
    .option(
      "--allow-root <path>",
      "Startup-fixed MCP filesystem root (repeatable)",
      collectValue,
      []
    )
    .action(async (options: { allowRoot?: string[] }) => {
      const roots = options.allowRoot?.map((root) => resolve(root)) ?? [];
      await startStdioMcpServer(roots.length === 0 ? {} : { fixedAllowedRoots: roots });
    });

  program.addHelpText(
    "after",
    `\nAnnotationSpec:\n  Use AnnotationSpec 1.1 for new specs. Replay existing 1.0 sidecars unchanged when compatibility matters.\n\nExamples:\n  agent-callout inspect screenshot.png --json\n  agent-callout validate screenshot.png --spec annotations.json --json\n  agent-callout annotate screenshot.png --spec-json '{"version":"1.1","annotations":[]}'\n  agent-callout revise screenshot.annotated.json --edits edits.json\n  agent-callout crop screenshot.png --rect 20,30,400,240 -o crop.png\n`
  );
  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  io: CliIo = defaultIo
): Promise<number> {
  const program = createCliProgram(io);
  program.exitOverride();
  try {
    await program.parseAsync([...argv], { from: "node" });
    return 0;
  } catch (error) {
    if (error instanceof ReportedCliFailure) {
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      return error.exitCode === 0 ? 1 : error.exitCode;
    }
    writeLine(io.stderr, `AgentCallout error: ${errorMessage(error)}`);
    return 1;
  }
}

export function defaultOutputName(inputPath: string, suffix: string): string {
  const name = basename(inputPath);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${suffix}.png`;
}
