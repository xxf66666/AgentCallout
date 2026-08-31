import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { Command, CommanderError, InvalidArgumentError } from "commander";
import sharp from "sharp";

import {
  AGENT_CALLOUT_VERSION,
  annotateImage,
  createContactSheet,
  cropImage,
  getCoreDoctorReport,
  inspectImage,
  validateSpecForImage
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

function formatGenerated(action: string, result: Awaited<ReturnType<typeof cropImage>>): string {
  const value = result as unknown as Record<string, unknown>;
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  return [
    `${action} complete.`,
    `Output: ${scalarText(value.outputPath)}`,
    `Sidecar: ${scalarText(value.sidecarPath)}`,
    `Markdown: ${scalarText(value.markdown)}`,
    `SHA-256: ${scalarText(value.outputSha256)}`,
    ...warningLines(warnings)
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
    `\nAnnotationSpec:\n  Use AnnotationSpec 1.1 for new specs. Replay existing 1.0 sidecars unchanged when compatibility matters.\n\nExamples:\n  agent-callout inspect screenshot.png --json\n  agent-callout validate screenshot.png --spec annotations.json --json\n  agent-callout annotate screenshot.png --spec-json '{"version":"1.1","annotations":[]}'\n  agent-callout crop screenshot.png --rect 20,30,400,240 -o crop.png\n`
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
