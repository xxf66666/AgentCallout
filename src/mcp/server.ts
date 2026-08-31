import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AGENT_CALLOUT_VERSION,
  AgentCalloutRevisionError,
  annotateImage,
  createContactSheet,
  createImagePreview,
  cropImage,
  getCoreDoctorReport,
  inspectAnnotationSidecar,
  inspectImage,
  reviseAnnotation,
  validateSpecForImage
} from "../index.js";
import { annotationRevisionEditsSchema, annotationSpecSchema } from "../spec/index.js";

const MAX_PATH_LENGTH = 32_767;
const MAX_ALLOWED_ROOTS = 32;
const MAX_CONTACT_SHEET_INPUTS = 64;
const MAX_PREVIEW_BYTES = 64 * 1024;
const PREVIEW_SIZES = [512, 384, 256, 192, 128, 96, 64] as const;
const CLIENT_ROOT_CACHE_MS = 2_000;
const CLIENT_ROOT_TIMEOUT_MS = 2_000;
const STARTUP_ROOTS_ENV = "AGENT_CALLOUT_ALLOWED_ROOTS";

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const specSchema = annotationSpecSchema;
const coordinateSpaceSchema = z.enum(["pixel", "normalized"]);
const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  })
  .strict();
const structuredOutputSchema = z.object({}).catchall(z.unknown());
const dimensionsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict();
const annotationTypeCountSchema = z
  .object({
    rectangle: z.number().int().nonnegative().optional(),
    ellipse: z.number().int().nonnegative().optional(),
    arrow: z.number().int().nonnegative().optional(),
    text: z.number().int().nonnegative().optional(),
    callout: z.number().int().nonnegative().optional(),
    "numbered-callout": z.number().int().nonnegative().optional(),
    highlight: z.number().int().nonnegative().optional(),
    spotlight: z.number().int().nonnegative().optional(),
    blur: z.number().int().nonnegative().optional(),
    redact: z.number().int().nonnegative().optional()
  })
  .strict();
const sidecarSummaryOutputSchema = z
  .object({
    summaryVersion: z.literal("1.0"),
    valid: z.literal(true),
    artifact: z.literal("agent-callout-annotation"),
    manifestVersion: z.enum(["1.0", "1.1"]),
    annotationSpecVersion: z.enum(["1.0", "1.1"]),
    outputDimensions: dimensionsSchema,
    annotations: z
      .object({
        total: z.number().int().nonnegative(),
        byType: annotationTypeCountSchema,
        resolvedInventory: z.literal("identity-aligned")
      })
      .strict(),
    revision: z
      .object({
        number: z.number().int().nonnegative(),
        chainEntries: z.number().int().positive(),
        coordinationScope: z.literal("sidecar-directory"),
        copiedLineageMayFork: z.literal(true)
      })
      .strict(),
    warnings: z.object({ count: z.number().int().nonnegative() }).strict(),
    integrity: z
      .object({
        sidecar: z.literal("validated"),
        output: z.literal("hash-verified"),
        parentChain: z.literal("hash-verified"),
        originalInput: z.literal("record-only")
      })
      .strict(),
    safety: z
      .object({
        usesBlur: z.boolean(),
        usesRedact: z.boolean(),
        blurIsSecureRedaction: z.literal(false),
        redactUsesOpaqueOverwrite: z.boolean()
      })
      .strict(),
    portability: z
      .object({
        flattenedPngSeparatesLayers: z.literal(false),
        sidecarRequiredForAnnotationSemantics: z.literal(true)
      })
      .strict()
  })
  .strict();

const inspectInputSchema = z
  .object({
    inputPath: pathSchema.describe("PNG, JPEG, or WebP file to inspect.")
  })
  .strict();

const inspectSidecarInputSchema = z
  .object({
    sidecarPath: pathSchema.describe("AgentCallout annotate sidecar to validate.")
  })
  .strict();

const validateInputSchema = z
  .object({
    inputPath: pathSchema,
    spec: specSchema
  })
  .strict();

const annotateInputSchema = z
  .object({
    inputPath: pathSchema,
    spec: specSchema,
    outputPath: pathSchema.optional()
  })
  .strict();

const reviseAnnotationInputSchema = z
  .object({
    parentSidecarPath: pathSchema.describe("Annotate sidecar to validate and revise."),
    edits: annotationRevisionEditsSchema.describe(
      'Ordered edits. Each edits[].op must be exactly "add", "set", or "remove". To fully replace an existing stable ID, use {"op":"set","id":"...","annotation":{...}}; never use op "replace".'
    ),
    inputPath: pathSchema
      .describe("Moved original image whose SHA-256 matches the parent sidecar.")
      .optional()
  })
  .strict();

const cropInputSchema = z
  .object({
    inputPath: pathSchema,
    rect: rectSchema,
    coordinateSpace: coordinateSpaceSchema.optional().default("pixel"),
    outputPath: pathSchema.optional()
  })
  .strict();

const contactSheetInputSchema = z
  .object({
    inputPaths: z.array(pathSchema).min(1).max(MAX_CONTACT_SHEET_INPUTS),
    outputPath: pathSchema.optional(),
    columns: z.number().int().positive().max(16).optional(),
    cellWidth: z.number().int().positive().max(4096).optional(),
    cellHeight: z.number().int().positive().max(4096).optional(),
    padding: z.number().int().nonnegative().max(512).optional(),
    background: z.string().min(1).max(128).optional(),
    labels: z.boolean().optional().default(true)
  })
  .strict();

const doctorInputSchema = z.object({}).strict();

type GeneratedImageResult = Awaited<ReturnType<typeof cropImage>>;
type ImageToolResult = GeneratedImageResult | Awaited<ReturnType<typeof reviseAnnotation>>;

interface PreviewPayload {
  data: string;
  fallbackReason?: string | undefined;
  height: number;
  mode: "changed-region" | "compact-overview";
  sizeBytes: number;
  sourceRect?: { x: number; y: number; width: number; height: number } | undefined;
  width: number;
}

export interface AgentCalloutMcpServerOptions {
  fixedAllowedRoots?: string[];
  /** Test-only hook used to exercise committed-output replacement before preview encoding. */
  beforePreview?: ((result: { outputPath: string }) => void | Promise<void>) | undefined;
}

interface RootAuthority {
  roots(): Promise<string[]>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return String(error);
}

function actionableToolErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (message.toLowerCase().includes("outside the allowed roots")) {
    return `${message} Add that directory to the MCP client's file roots, pass --allow-root when starting AgentCallout MCP, or set ${STARTUP_ROOTS_ENV}.`;
  }
  if (message.includes("pass overwrite: true")) {
    return message.replace(
      /pass overwrite: true to replace it/gu,
      "choose a new outputPath; MCP does not expose overwrite authority"
    );
  }
  return message;
}

function jsonCompatible(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, nestedValue: unknown) =>
      typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
    )
  );
}

function structuredObject(value: unknown): Record<string, unknown> {
  const compatible = jsonCompatible(value);
  if (compatible === null || typeof compatible !== "object" || Array.isArray(compatible)) {
    return { result: compatible };
  }
  return compatible as Record<string, unknown>;
}

function textContent(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(jsonCompatible(value)) };
}

function structuredToolResult(value: unknown): CallToolResult {
  const structuredContent = structuredObject(value);
  return {
    content: [textContent(structuredContent)],
    structuredContent,
    isError: false
  };
}

function toolError(error: unknown): CallToolResult {
  const payload = {
    ok: false,
    error: {
      code: error instanceof AgentCalloutRevisionError ? error.code : "AGENT_CALLOUT_ERROR",
      message: actionableToolErrorMessage(error)
    }
  };
  return {
    content: [textContent(payload)],
    isError: true
  };
}

function environmentRoots(): string[] {
  const value = process.env[STARTUP_ROOTS_ENV];
  if (value === undefined || value.trim() === "") {
    return [];
  }
  return value
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root !== "");
}

function uniqueResolvedRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].slice(0, MAX_ALLOWED_ROOTS);
}

export function fileRootsFromMcpUris(uris: readonly string[]): string[] {
  const roots: string[] = [];
  for (const uri of uris) {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol === "file:") {
        roots.push(fileURLToPath(parsed));
      }
    } catch {
      // Malformed and non-file roots do not grant local filesystem authority.
    }
  }
  return uniqueResolvedRoots(roots);
}

function createRootAuthority(
  server: McpServer,
  options: AgentCalloutMcpServerOptions
): RootAuthority {
  const fixed = uniqueResolvedRoots([
    process.cwd(),
    tmpdir(),
    ...environmentRoots(),
    ...(options.fixedAllowedRoots ?? [])
  ]);
  let cachedClientRoots: string[] = [];
  let refreshAfter = 0;

  return {
    async roots(): Promise<string[]> {
      const supportsRoots = server.server.getClientCapabilities()?.roots !== undefined;
      if (supportsRoots && Date.now() >= refreshAfter) {
        refreshAfter = Date.now() + CLIENT_ROOT_CACHE_MS;
        try {
          const result = await server.server.listRoots({}, { timeout: CLIENT_ROOT_TIMEOUT_MS });
          cachedClientRoots = fileRootsFromMcpUris(result.roots.map((root) => root.uri));
        } catch {
          // Retain the prior cache; core supplies an actionable error for out-of-scope paths.
        }
      }
      return uniqueResolvedRoots([...fixed, ...cachedClientRoots]);
    }
  };
}

async function safeToolCall(operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return toolError(error);
  }
}

async function createBoundedPreview(
  result: ImageToolResult,
  requestedRoots: string[]
): Promise<PreviewPayload> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-callout-mcp-preview-"));
  try {
    const roots = [...requestedRoots, temporaryRoot];
    const allowedRoots = [...new Set(roots.map((root) => resolve(root)))];
    const review = "review" in result ? result.review : undefined;
    const sourceRect = review?.mode === "changed-region" ? review.sourceRect : undefined;
    const mode = sourceRect === undefined ? "compact-overview" : "changed-region";

    for (const size of PREVIEW_SIZES) {
      const outputPath = join(temporaryRoot, `preview-${mode}-${size}.png`);
      const preview = await createImagePreview({
        inputPath: result.outputPath,
        outputPath,
        maxWidth: size,
        maxHeight: size,
        ...(sourceRect === undefined ? {} : { sourceRect }),
        allowedRoots
      });
      if (
        preview.inputSha256 !== result.outputSha256 ||
        Array.isArray(preview.originalDimensions) ||
        preview.originalDimensions.width !== result.outputDimensions.width ||
        preview.originalDimensions.height !== result.outputDimensions.height
      ) {
        throw new Error("Preview input no longer matches the committed output hash or dimensions.");
      }
      const bytes = await readFile(preview.outputPath);
      if (bytes.byteLength <= MAX_PREVIEW_BYTES) {
        return {
          data: bytes.toString("base64"),
          ...(review?.fallbackReason === undefined
            ? {}
            : { fallbackReason: review.fallbackReason }),
          width: preview.outputDimensions.width,
          height: preview.outputDimensions.height,
          sizeBytes: bytes.byteLength,
          mode,
          ...(sourceRect === undefined ? {} : { sourceRect })
        };
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  throw new Error("Could not create a bounded PNG preview.");
}

async function imageToolResult(
  result: ImageToolResult,
  allowedRoots: string[],
  beforePreview?: (result: { outputPath: string }) => void | Promise<void>
): Promise<CallToolResult> {
  if ("review" in result && result.review.mode === "none") {
    return {
      content: [
        textContent({
          ...result,
          preview: {
            available: false,
            mode: "none",
            fallbackReason: result.review.fallbackReason,
            message:
              "Preview was suppressed because this revision may reveal pixels previously covered by blur or redact. Review the saved local output under the applicable privacy policy."
          }
        })
      ],
      isError: false
    };
  }
  try {
    await beforePreview?.(result);
    const preview = await createBoundedPreview(result, allowedRoots);
    return {
      content: [
        textContent({
          ...result,
          preview: {
            available: true,
            mode: preview.mode,
            detail: "low",
            width: preview.width,
            height: preview.height,
            sizeBytes: preview.sizeBytes,
            ...(preview.sourceRect === undefined ? {} : { sourceRect: preview.sourceRect }),
            ...(preview.fallbackReason === undefined
              ? {}
              : { fallbackReason: preview.fallbackReason }),
            fineDetailHint:
              preview.mode === "changed-region"
                ? "This image shows only the changed region; open the saved output to review global layout."
                : "Crop the saved output when small text or exact placement needs review."
          }
        }),
        {
          type: "image",
          data: preview.data,
          mimeType: "image/png",
          _meta: {
            "codex/imageDetail": "low",
            "agent-callout/previewMode": preview.mode,
            "agent-callout/previewWidth": preview.width,
            "agent-callout/previewHeight": preview.height,
            "agent-callout/previewBytes": preview.sizeBytes,
            ...(preview.sourceRect === undefined
              ? {}
              : { "agent-callout/sourceRect": preview.sourceRect })
          }
        }
      ],
      isError: false
    };
  } catch {
    const mode =
      "review" in result && result.review.mode === "changed-region"
        ? "changed-region"
        : "compact-overview";
    return {
      content: [
        textContent({
          ...result,
          preview: {
            available: false,
            mode,
            fallbackReason: "encoding-failed",
            message:
              "Output was written successfully, but its preview could not be encoded and verified safely."
          }
        })
      ],
      isError: false
    };
  }
}

export const SERVER_INSTRUCTIONS = [
  "Inspect the screenshot before annotating it. If a target is uncertain, crop the relevant area and inspect it again. Validate the AnnotationSpec, render the annotation, and examine the returned preview. A revision may return only its changed region with sourceRect metadata; use it for local overlap and text checks, and open the saved output only when global layout still needs review. Avoid an extra crop when the changed-region preview is already sufficient. Use inspect_annotation_sidecar for a path-free integrity/inventory summary when handing an existing sidecar to another AI; it does not verify the original input bytes. For a committed annotate sidecar, use revise_annotation with stable-ID edits instead of deleting files or rewriting the whole spec. Return the final absolute output path and Markdown reference only after visual review.",
  "Blur is visual weakening only. Use redact for secrets that require irreversible opaque pixel replacement. Never claim an image was visually checked when the client omitted ImageContent; use the absolute path as a fallback and say what remains unverified."
].join(" ");

export function createAgentCalloutMcpServer(options: AgentCalloutMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "agent-callout", version: AGENT_CALLOUT_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  const rootAuthority = createRootAuthority(server, options);

  server.registerTool(
    "inspect_image",
    {
      title: "Inspect image",
      description:
        "Read image format, dimensions, orientation, byte size, and SHA-256 before annotation.",
      inputSchema: inspectInputSchema,
      outputSchema: structuredOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ inputPath }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        return structuredToolResult(await inspectImage(inputPath, { allowedRoots }));
      })
  );

  server.registerTool(
    "inspect_annotation_sidecar",
    {
      title: "Inspect annotation sidecar",
      description:
        "Validate an annotate sidecar, paired output, and parent chain; return a small path-free summary without image content.",
      inputSchema: inspectSidecarInputSchema,
      outputSchema: sidecarSummaryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ sidecarPath }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        return structuredToolResult(await inspectAnnotationSidecar({ sidecarPath, allowedRoots }));
      })
  );

  server.registerTool(
    "validate_annotation_spec",
    {
      title: "Validate annotation spec",
      description:
        "Validate a versioned AnnotationSpec and resolve its coordinates against an image.",
      inputSchema: validateInputSchema,
      outputSchema: structuredOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ inputPath, spec }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        return structuredToolResult(await validateSpecForImage({ inputPath, spec, allowedRoots }));
      })
  );

  server.registerTool(
    "annotate_image",
    {
      title: "Annotate image",
      description:
        "Render a validated AnnotationSpec to a new PNG and return a bounded image preview.",
      inputSchema: annotateInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ inputPath, spec, outputPath }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        const result = await annotateImage({
          inputPath,
          spec,
          ...(outputPath === undefined ? {} : { outputPath }),
          allowedRoots
        });
        return imageToolResult(result, allowedRoots, options.beforePreview);
      })
  );

  server.registerTool(
    "revise_annotation",
    {
      title: "Revise annotation",
      description:
        'Validate an annotate sidecar, create its next append-only .revN pair, and return a changed-region preview when bounded. edits[].op must be exactly "add", "set", or "remove"; use {"op":"set","id":"...","annotation":{...}} for a full same-ID replacement, never "replace".',
      inputSchema: reviseAnnotationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ parentSidecarPath, edits, inputPath }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        const result = await reviseAnnotation({
          parentSidecarPath,
          edits,
          ...(inputPath === undefined ? {} : { inputPath }),
          allowedRoots
        });
        return imageToolResult(result, allowedRoots, options.beforePreview);
      })
  );

  server.registerTool(
    "crop_image",
    {
      title: "Crop image",
      description: "Crop a pixel or normalized rectangle for closer visual inspection.",
      inputSchema: cropInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ inputPath, rect, coordinateSpace, outputPath }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        const result = await cropImage({
          inputPath,
          rect,
          coordinateSpace,
          ...(outputPath === undefined ? {} : { outputPath }),
          allowedRoots
        });
        return imageToolResult(result, allowedRoots, options.beforePreview);
      })
  );

  server.registerTool(
    "create_contact_sheet",
    {
      title: "Create contact sheet",
      description: "Combine multiple images into a PNG contact sheet and return a bounded preview.",
      inputSchema: contactSheetInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({
      inputPaths,
      outputPath,
      columns,
      cellWidth,
      cellHeight,
      padding,
      background,
      labels
    }) =>
      safeToolCall(async () => {
        const allowedRoots = await rootAuthority.roots();
        const result = await createContactSheet({
          inputPaths,
          labels,
          ...(outputPath === undefined ? {} : { outputPath }),
          ...(columns === undefined ? {} : { columns }),
          ...(cellWidth === undefined ? {} : { cellWidth }),
          ...(cellHeight === undefined ? {} : { cellHeight }),
          ...(padding === undefined ? {} : { padding }),
          ...(background === undefined ? {} : { background }),
          allowedRoots
        });
        return imageToolResult(result, allowedRoots, options.beforePreview);
      })
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description:
        "Report the AgentCallout product version plus local renderer, Sharp/libvips, font, and runtime health.",
      inputSchema: doctorInputSchema,
      outputSchema: structuredOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () =>
      safeToolCall(async () =>
        structuredToolResult({
          product: { name: "agent-callout", version: AGENT_CALLOUT_VERSION },
          ...(await getCoreDoctorReport()),
          mcp: {
            maxPreviewBytes: MAX_PREVIEW_BYTES,
            maxPreviewDimension: PREVIEW_SIZES[0],
            previewDetail: "low",
            revisionPreviewMode: "changed-region-when-bounded"
          }
        })
      )
  );

  return server;
}

export async function startStdioMcpServer(
  options: AgentCalloutMcpServerOptions = {}
): Promise<McpServer> {
  const server = createAgentCalloutMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
