import { access, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { annotateImage, inspectAnnotationSidecar } from "../src/core/index.js";
import { createAgentCalloutMcpServer } from "../src/mcp/index.js";
import {
  NUMBERED_CALLOUT_CANVAS,
  NUMBERED_CALLOUT_V11_SPEC
} from "./fixtures/numbered-callout-v11.js";

function deterministicNoise(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let state = 0x12_34_56_78;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels[index] = state >>> 24;
  }
  return pixels;
}

function expectObjectivePixelMetricKeys(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/"[^"]*(?:token|cost|estimate|saving)[^"]*"\s*:/iu);
}

function roundedRatio(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

describe("AgentCallout MCP server", () => {
  let directory: string;
  let inputPath: string;
  let client: Client;
  let server: ReturnType<typeof createAgentCalloutMcpServer>;
  let rootListCalls: number;
  let beforePreview: ((result: { outputPath: string }) => void | Promise<void>) | undefined;
  let beforePreviewRead: ((preview: { outputPath: string }) => void | Promise<void>) | undefined;

  beforeEach(async () => {
    // Canonicalize through symlinks (macOS /var -> /private/var) to match the
    // realpath-resolved paths the product reports for inputs and outputs.
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-mcp-测试-")));
    inputPath = join(directory, "输入.png");
    await sharp({
      create: {
        width: 120,
        height: 80,
        channels: 4,
        background: { r: 200, g: 70, b: 40, alpha: 1 }
      }
    })
      .png()
      .toFile(inputPath);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    beforePreview = undefined;
    beforePreviewRead = undefined;
    server = createAgentCalloutMcpServer({
      fixedAllowedRoots: [directory],
      ocrRuntimeDirectory: join(directory, "optional-ocr-not-installed"),
      beforePreview: async (result) => beforePreview?.(result),
      beforePreviewRead: async (preview) => beforePreviewRead?.(preview)
    });
    rootListCalls = 0;
    client = new Client(
      { name: "agent-callout-test", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    client.setRequestHandler(ListRootsRequestSchema, () => {
      rootListCalls += 1;
      return { roots: [{ uri: pathToFileURL(directory).href, name: "test workspace" }] };
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("OCR remains optional and missing models never trigger installation", async () => {
    const result = await client.callTool({
      name: "locate_text",
      arguments: { inputPath, query: "Save" }
    });
    expect(result.isError).toBe(true);
    const content = result.content as { type: string; text?: string }[];
    expect(content.some((block) => block.type === "image")).toBe(false);
    expect(JSON.parse(content.find((block) => block.type === "text")?.text ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "OCR_RUNTIME_NOT_INSTALLED" }
    });
    await expect(access(join(directory, "optional-ocr-not-installed"))).rejects.toThrow();
    const injected = await client.callTool({
      name: "locate_text",
      arguments: { inputPath, query: "Save", runtimeDirectory: directory }
    });
    expect(injected.isError).toBe(true);
  });

  test("initializes with workflow instructions and exactly eleven strict tools", async () => {
    expect(client.getInstructions()).toContain("Inspect the screenshot before annotating");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "annotate_image",
      "create_contact_sheet",
      "create_handoff",
      "crop_image",
      "doctor",
      "inspect_annotation_sidecar",
      "inspect_image",
      "locate_text",
      "revise_annotation",
      "validate_annotation_spec",
      "verify_handoff"
    ]);

    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("allowedRoots");
      expect(tool.inputSchema.properties).not.toHaveProperty("runtimeDirectory");
      if (
        ["annotate_image", "create_contact_sheet", "crop_image", "revise_annotation"].includes(
          tool.name
        )
      ) {
        expect(tool.inputSchema.properties).not.toHaveProperty("overwrite");
        expect(tool.inputSchema.properties).not.toHaveProperty("revisionNumber");
        expect(tool.outputSchema).toBeUndefined();
      } else {
        expect(tool.outputSchema?.type).toBe("object");
      }
    }

    const revise = listed.tools.find((tool) => tool.name === "revise_annotation");
    expect(revise?.description).toContain('"op":"set"');
    expect(revise?.description).toContain('never "replace"');
    expect(revise?.inputSchema.properties).toHaveProperty("parentSidecarPath");
    expect(revise?.inputSchema.properties).toHaveProperty("edits");
    expect(revise?.inputSchema.properties).toHaveProperty("inputPath");
    expect(revise?.inputSchema.properties).not.toHaveProperty("outputPath");

    const inspectSidecar = listed.tools.find((tool) => tool.name === "inspect_annotation_sidecar");
    const summarySchema = inspectSidecar?.outputSchema as
      { additionalProperties?: unknown; properties?: Record<string, unknown> } | undefined;
    expect(summarySchema?.additionalProperties).toBe(false);
    const annotationsSchema = summarySchema?.properties?.annotations as
      { additionalProperties?: unknown; properties?: Record<string, unknown> } | undefined;
    expect(annotationsSchema?.additionalProperties).toBe(false);
    const byTypeSchema = annotationsSchema?.properties?.byType as
      { additionalProperties?: unknown; properties?: Record<string, unknown> } | undefined;
    expect(byTypeSchema?.additionalProperties).toBe(false);
    expect(Object.keys(byTypeSchema?.properties ?? {}).sort()).toEqual([
      "arrow",
      "blur",
      "callout",
      "ellipse",
      "highlight",
      "numbered-callout",
      "rectangle",
      "redact",
      "spotlight",
      "text"
    ]);

    const annotate = listed.tools.find((tool) => tool.name === "annotate_image");
    const advertisedSpec = JSON.stringify(annotate?.inputSchema.properties?.spec);
    expect(advertisedSpec).toContain('"const":"1.0"');
    expect(advertisedSpec).toContain('"const":"1.1"');
    expect(advertisedSpec).toContain('"docs-light"');
    expect(advertisedSpec).toContain('"classic-red"');
    expect(advertisedSpec).toContain('"neutral"');
    expect(advertisedSpec).toContain('"danger"');
    expect(advertisedSpec).toContain('"markerFillColor"');
    expect(advertisedSpec).toContain('"maxWidth"');
    expect(advertisedSpec).not.toContain('"leader"');
    expect(advertisedSpec).not.toContain('"label"');
    expect(advertisedSpec).not.toContain('"marker"');
    for (const type of [
      "rectangle",
      "ellipse",
      "arrow",
      "text",
      "callout",
      "numbered-callout",
      "highlight",
      "spotlight",
      "blur",
      "redact"
    ]) {
      expect(advertisedSpec).toContain(`"const":"${type}"`);
    }
  });

  test("calls real structured tools in memory", async () => {
    const inspected = (await client.callTool({
      name: "inspect_image",
      arguments: { inputPath }
    })) as CallToolResult;
    expect(inspected.isError).not.toBe(true);
    expect(rootListCalls).toBeGreaterThan(0);
    expect(inspected.structuredContent).toMatchObject({
      format: "png",
      dimensions: { width: 120, height: 80 }
    });
    const text = inspected.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(
      inspected.structuredContent
    );

    const validated = (await client.callTool({
      name: "validate_annotation_spec",
      arguments: {
        inputPath,
        spec: { version: "1.0", annotations: [] }
      }
    })) as CallToolResult;
    expect(validated.isError).not.toBe(true);
    expect(validated.structuredContent).toMatchObject({ valid: true });

    const doctor = (await client.callTool({ name: "doctor", arguments: {} })) as CallToolResult;
    expect(doctor.structuredContent).toMatchObject({
      product: { name: "agent-callout", version: "0.3.1" },
      ok: true,
      limits: { maxPixels: 40_000_000, maxAnnotations: 200 },
      mcp: { maxPreviewBytes: 64 * 1024, maxPreviewDimension: 512, previewDetail: "auto" }
    });
  });

  test("validates and annotates a real 1.1 tone/maxWidth spec through MCP", async () => {
    const spec = {
      version: "1.1",
      annotations: [
        {
          id: "mcp-v11",
          type: "numbered-callout",
          target: { x: 72, y: 28, width: 28, height: 24 },
          text: "v1.1",
          number: 1,
          placement: "left",
          tone: "info",
          style: { maxWidth: 48, fontSize: 8, padding: 2 }
        }
      ]
    };
    const validated = (await client.callTool({
      name: "validate_annotation_spec",
      arguments: { inputPath, spec }
    })) as CallToolResult;
    expect(validated.isError).not.toBe(true);
    expect(validated.structuredContent).toMatchObject({
      valid: true,
      spec: {
        version: "1.1",
        preset: "docs-light",
        annotations: [{ id: "mcp-v11", tone: "info", style: { maxWidth: 48 } }]
      },
      resolvedSpec: {
        version: "1.1",
        annotations: [
          {
            id: "mcp-v11",
            style: { maxWidth: 48, markerFillColor: "#2563EB" }
          }
        ]
      }
    });

    const outputPath = join(directory, "mcp-v11.png");
    const annotated = (await client.callTool({
      name: "annotate_image",
      arguments: { inputPath, outputPath, spec }
    })) as CallToolResult;
    expect(annotated.isError).not.toBe(true);
    expect(annotated.structuredContent).toBeUndefined();
    expect(annotated.content.filter((item) => item.type === "image")).toHaveLength(1);
    const text = annotated.content.find((item) => item.type === "text");
    const result = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { outputPath?: string; sidecarPath?: string } | undefined;
    expect(result?.outputPath).toBe(outputPath);
    expect(typeof result?.sidecarPath).toBe("string");
    if (result?.sidecarPath === undefined) throw new Error("Missing MCP 1.1 sidecar path.");
    const sidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      annotationSpec: {
        version: string;
        preset: string;
        annotations: { tone?: string; style?: { maxWidth?: number } }[];
      };
      resolvedAnnotations: { style?: Record<string, unknown> }[];
    };
    expect(sidecar.annotationSpec).toMatchObject({
      version: "1.1",
      preset: "docs-light",
      annotations: [{ tone: "info", style: { maxWidth: 48 } }]
    });
    expect(sidecar.resolvedAnnotations[0]?.style).toMatchObject({
      maxWidth: 48,
      markerFillColor: "#2563eb"
    });
  });

  test("creates a strict versioned revision with preview and revision-specific errors", async () => {
    const baseOutputPath = join(directory, "mcp-revision-base.png");
    const base = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: baseOutputPath,
        spec: {
          version: "1.1",
          annotations: [
            {
              id: "mcp-box",
              type: "rectangle",
              rect: { x: 10, y: 10, width: 30, height: 20 }
            }
          ]
        }
      }
    })) as CallToolResult;
    const baseText = base.content.find((item) => item.type === "text");
    const baseResult = (baseText?.type === "text" ? JSON.parse(baseText.text) : undefined) as
      { sidecarPath?: string } | undefined;
    if (baseResult?.sidecarPath === undefined) throw new Error("Missing base sidecar path");

    const revised = (await client.callTool({
      name: "revise_annotation",
      arguments: {
        parentSidecarPath: baseResult.sidecarPath,
        edits: [
          {
            op: "set",
            id: "mcp-box",
            annotation: {
              id: "mcp-box",
              type: "ellipse",
              rect: { x: 12, y: 11, width: 34, height: 24 }
            }
          }
        ]
      }
    })) as CallToolResult;
    expect(revised.isError).not.toBe(true);
    expect(revised.structuredContent).toBeUndefined();
    expect(revised.content.filter((item) => item.type === "image")).toHaveLength(1);
    const revisedText = revised.content.find((item) => item.type === "text");
    const revisedResult = (
      revisedText?.type === "text" ? JSON.parse(revisedText.text) : undefined
    ) as
      | {
          outputPath?: string;
          sidecarPath?: string;
          revision?: { number?: number };
          review?: {
            mode?: string;
            touchedCount?: number;
            affectedCount?: number;
            sourceRect?: { x: number; y: number; width: number; height: number };
          };
          preview?: {
            mode?: string;
            sourceRect?: { x: number; y: number; width: number; height: number };
            pixelMetrics?: Record<string, number>;
          };
        }
      | undefined;
    expect(revisedResult?.revision?.number).toBe(1);
    expect(revisedResult?.outputPath).toBe(join(directory, "mcp-revision-base.rev1.png"));
    expect(revisedResult?.review).toEqual({
      mode: "changed-region",
      touchedCount: 1,
      affectedCount: 1,
      sourceRect: { x: 0, y: 0, width: 71, height: 60 }
    });
    expect(revisedResult?.preview).toMatchObject({
      mode: "changed-region",
      sourceRect: revisedResult?.review?.sourceRect,
      pixelMetrics: {
        fullRasterPixelCount: 9_600,
        sourceRegionPixelCount: 4_260,
        previewRasterPixelCount: 4_260,
        sourceRegionCoverageRatio: 0.44375,
        previewToSourceRegionRatio: 1,
        previewToFullRasterRatio: 0.44375,
        previewPixelReductionRatio: 0.55625
      }
    });
    const revisedImage = revised.content.find((item) => item.type === "image");
    if (revisedImage?.type !== "image") throw new Error("Missing revision focus image");
    expect(revisedImage._meta).toMatchObject({
      "agent-callout/previewMode": "changed-region",
      "agent-callout/sourceRect": { x: 0, y: 0, width: 71, height: 60 },
      "agent-callout/pixelMetrics": revisedResult?.preview?.pixelMetrics
    });
    expect(revisedImage._meta?.["agent-callout/pixelMetrics"]).toEqual(
      revisedResult?.preview?.pixelMetrics
    );
    expectObjectivePixelMetricKeys(revisedResult?.preview?.pixelMetrics);
    const focusBytes = Buffer.from(revisedImage.data, "base64");
    const focusMetadata = await sharp(focusBytes).metadata();
    expect(focusMetadata).toMatchObject({
      width: 71,
      height: 60
    });
    expect(focusMetadata.exif).toBeUndefined();
    const [focusPixels, expectedFocusPixels] = await Promise.all([
      sharp(focusBytes).ensureAlpha().raw().toBuffer(),
      sharp(revisedResult?.outputPath as string)
        .extract({ left: 0, top: 0, width: 71, height: 60 })
        .ensureAlpha()
        .raw()
        .toBuffer()
    ]);
    expect(focusPixels).toEqual(expectedFocusPixels);
    expect(JSON.parse(await readFile(revisedResult?.sidecarPath as string, "utf8"))).toMatchObject({
      manifestVersion: "1.1",
      annotationSpec: { annotations: [{ id: "mcp-box", type: "ellipse" }] },
      revision: { number: 1 }
    });

    const stale = (await client.callTool({
      name: "revise_annotation",
      arguments: {
        parentSidecarPath: baseResult.sidecarPath,
        edits: [{ op: "remove", id: "mcp-box" }]
      }
    })) as CallToolResult;
    expect(stale.isError).toBe(true);
    const staleText = stale.content.find((item) => item.type === "text");
    const payload = (staleText?.type === "text" ? JSON.parse(staleText.text) : undefined) as
      { error?: { code?: string } } | undefined;
    expect(payload?.error?.code).toBe("REVISION_CONFLICT");

    const inspected = (await client.callTool({
      name: "inspect_annotation_sidecar",
      arguments: { sidecarPath: revisedResult?.sidecarPath }
    })) as CallToolResult;
    expect(inspected.isError).not.toBe(true);
    expect(inspected.content.filter((item) => item.type === "image")).toHaveLength(0);
    expect(inspected.structuredContent).toMatchObject({
      summaryVersion: "1.0",
      valid: true,
      annotations: { total: 1, byType: { ellipse: 1 }, resolvedInventory: "identity-aligned" },
      revision: { number: 1, chainEntries: 2, coordinationScope: "sidecar-directory" },
      integrity: { originalInput: "record-only" }
    });
    expect(inspected.structuredContent).toEqual(
      await inspectAnnotationSidecar({
        sidecarPath: revisedResult?.sidecarPath as string,
        allowedRoots: [directory]
      })
    );
    const inspectedText = JSON.stringify(inspected.structuredContent);
    expect(Buffer.byteLength(inspectedText, "utf8")).toBeLessThanOrEqual(4096);
    expect(inspectedText).not.toContain(directory);
    expect(inspectedText).not.toContain("mcp-box");
    expect(inspectedText).not.toMatch(/[0-9a-f]{64}/u);

    const invalidManifest = JSON.parse(
      await readFile(revisedResult?.sidecarPath as string, "utf8")
    ) as Record<string, unknown>;
    invalidManifest.manifestVersion = "CUSTOMER_SECRET";
    await writeFile(revisedResult?.sidecarPath as string, `${JSON.stringify(invalidManifest)}\n`);
    const invalidInspection = (await client.callTool({
      name: "inspect_annotation_sidecar",
      arguments: { sidecarPath: revisedResult?.sidecarPath }
    })) as CallToolResult;
    expect(invalidInspection.isError).toBe(true);
    const invalidText = invalidInspection.content.find((item) => item.type === "text");
    const invalidPayload = invalidText?.type === "text" ? invalidText.text : "";
    expect(invalidPayload).toContain('"code":"ANNOTATION_SIDECAR_INVALID"');
    expect(invalidPayload).toContain("Annotation sidecar validation failed.");
    expect(invalidPayload).not.toContain("CUSTOMER_SECRET");
    expect(invalidPayload).not.toContain(directory);
  });

  test("suppresses ImageContent when a revision removes redaction coverage", async () => {
    const base = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: join(directory, "sensitive-mcp.png"),
        spec: {
          version: "1.1",
          annotations: [
            {
              id: "secret",
              type: "redact",
              rect: { x: 30, y: 30, width: 40, height: 20 },
              color: "#111827"
            }
          ]
        }
      }
    })) as CallToolResult;
    const baseText = base.content.find((item) => item.type === "text");
    const baseResult = (baseText?.type === "text" ? JSON.parse(baseText.text) : undefined) as
      { sidecarPath?: string } | undefined;
    const revised = (await client.callTool({
      name: "revise_annotation",
      arguments: {
        parentSidecarPath: baseResult?.sidecarPath,
        edits: [{ op: "remove", id: "secret" }]
      }
    })) as CallToolResult;
    expect(revised.isError).not.toBe(true);
    expect(revised.content.filter((item) => item.type === "image")).toHaveLength(0);
    const text = revised.content.find((item) => item.type === "text");
    const result = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      | {
          outputPath?: string;
          review?: { mode?: string; fallbackReason?: string };
          preview?: { available?: boolean; mode?: string; fallbackReason?: string };
        }
      | undefined;
    expect(result?.review).toMatchObject({
      mode: "none",
      fallbackReason: "sensitive-coverage-changed"
    });
    expect(result?.preview).toMatchObject({
      available: false,
      mode: "none",
      fallbackReason: "sensitive-coverage-changed"
    });
    expect(result?.preview).not.toHaveProperty("pixelMetrics");
    expect(text?.type === "text" ? text.text : "").not.toContain("pixelMetrics");
    await expect(access(result?.outputPath as string)).resolves.toBeUndefined();
  });

  test("returns exactly one compact overview for dispersed revision edits", async () => {
    const largeInput = join(directory, "dispersed-mcp-input.png");
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: "white" }
    })
      .png()
      .toFile(largeInput);
    const base = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath: largeInput,
        outputPath: join(directory, "dispersed-mcp.png"),
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;
    const baseText = base.content.find((item) => item.type === "text");
    const baseResult = (baseText?.type === "text" ? JSON.parse(baseText.text) : undefined) as
      { sidecarPath?: string } | undefined;
    const revised = (await client.callTool({
      name: "revise_annotation",
      arguments: {
        parentSidecarPath: baseResult?.sidecarPath,
        edits: [
          {
            op: "add",
            annotation: {
              id: "north-west",
              type: "rectangle",
              rect: { x: 20, y: 20, width: 30, height: 24 }
            }
          },
          {
            op: "add",
            annotation: {
              id: "south-east",
              type: "rectangle",
              rect: { x: 740, y: 540, width: 30, height: 24 }
            }
          }
        ]
      }
    })) as CallToolResult;
    const imageBlocks = revised.content.filter((item) => item.type === "image");
    expect(imageBlocks).toHaveLength(1);
    const text = revised.content.find((item) => item.type === "text");
    const result = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      | {
          review?: { mode?: string; fallbackReason?: string };
          preview?: { mode?: string; fallbackReason?: string };
        }
      | undefined;
    expect(result?.review).toMatchObject({
      mode: "compact-overview",
      fallbackReason: "dispersed"
    });
    expect(result?.preview).toMatchObject({
      mode: "compact-overview",
      fallbackReason: "dispersed"
    });
    const image = imageBlocks[0];
    if (image?.type !== "image") throw new Error("Missing dispersed overview image");
    expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
      width: 512,
      height: 384
    });
  });

  test("matches core numbered target/marker/label/leader geometry through MCP", async () => {
    const publicInputPath = join(directory, "mcp-public-input.png");
    await sharp({
      create: { ...NUMBERED_CALLOUT_CANVAS, channels: 3, background: "white" }
    })
      .png()
      .toFile(publicInputPath);
    const direct = await annotateImage({
      inputPath: publicInputPath,
      outputPath: join(directory, "mcp-core-numbered.png"),
      spec: NUMBERED_CALLOUT_V11_SPEC,
      allowedRoots: [directory]
    });
    const outputPath = join(directory, "mcp-numbered.png");
    const annotated = (await client.callTool({
      name: "annotate_image",
      arguments: { inputPath: publicInputPath, outputPath, spec: NUMBERED_CALLOUT_V11_SPEC }
    })) as CallToolResult;
    const text = annotated.content.find((item) => item.type === "text");
    const result = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { sidecarPath?: string; warnings?: string[] } | undefined;
    if (result?.sidecarPath === undefined) throw new Error("Missing MCP numbered sidecar path.");
    const mcpSidecar = JSON.parse(await readFile(result.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
    };
    const coreSidecar = JSON.parse(await readFile(direct.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
    };

    expect(annotated.isError).not.toBe(true);
    expect(annotated.content.filter((item) => item.type === "image")).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(mcpSidecar.resolvedAnnotations).toEqual(coreSidecar.resolvedAnnotations);
    const resolved = mcpSidecar.resolvedAnnotations[0] as
      | {
          target?: unknown;
          marker?: { center?: unknown; radius?: unknown };
          label?: { box?: unknown; placement?: unknown };
          leader?: { start?: unknown; end?: unknown; length?: unknown };
        }
      | undefined;
    expect(resolved?.target).toEqual(NUMBERED_CALLOUT_V11_SPEC.annotations[0].target);
    expect(typeof resolved?.marker?.center).toBe("object");
    expect(typeof resolved?.marker?.radius).toBe("number");
    expect(typeof resolved?.label?.box).toBe("object");
    expect(resolved?.label?.placement).toBe("left");
    expect(typeof resolved?.leader?.start).toBe("object");
    expect(typeof resolved?.leader?.end).toBe("object");
    expect(typeof resolved?.leader?.length).toBe("number");
  });

  test("image tools omit structuredContent and return a decodable bounded PNG preview", async () => {
    const outputPath = join(directory, "裁剪输出.png");
    const cropped = (await client.callTool({
      name: "crop_image",
      arguments: {
        inputPath,
        outputPath,
        coordinateSpace: "pixel",
        rect: { x: 10, y: 8, width: 50, height: 40 }
      }
    })) as CallToolResult;

    expect(cropped.isError).not.toBe(true);
    expect(cropped.structuredContent).toBeUndefined();
    expect(cropped.content.filter((item) => item.type === "image")).toHaveLength(1);
    const text = cropped.content.find((item) => item.type === "text");
    const image = cropped.content.find((item) => item.type === "image");
    const manifest = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      Record<string, unknown> | undefined;
    expect(manifest?.outputPath).toBe(outputPath);
    expect(typeof manifest?.sidecarPath).toBe("string");
    expect(typeof manifest?.markdown).toBe("string");
    expect(manifest?.preview).toMatchObject({
      available: true,
      mode: "compact-overview",
      detail: "auto",
      pixelMetrics: {
        fullRasterPixelCount: 2_000,
        sourceRegionPixelCount: 2_000,
        previewRasterPixelCount: 2_000,
        sourceRegionCoverageRatio: 1,
        previewToSourceRegionRatio: 1,
        previewToFullRasterRatio: 1,
        previewPixelReductionRatio: 0
      }
    });
    expect(image?.type).toBe("image");
    if (image?.type !== "image") {
      throw new Error("Expected MCP image content");
    }
    expect(image.mimeType).toBe("image/png");
    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(image._meta).toMatchObject({
      "codex/imageDetail": "auto",
      "agent-callout/previewMode": "compact-overview",
      "agent-callout/pixelMetrics": (manifest?.preview as Record<string, unknown> | undefined)
        ?.pixelMetrics
    });
    expect(image._meta?.["agent-callout/pixelMetrics"]).toEqual(
      (manifest?.preview as Record<string, unknown> | undefined)?.pixelMetrics
    );
    expectObjectivePixelMetricKeys(
      (manifest?.preview as Record<string, unknown> | undefined)?.pixelMetrics
    );
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 50, height: 40 });
  });

  test("large previews stay bounded and use a Codex-supported display hint", async () => {
    const largeInputPath = join(directory, "large-input.png");
    const outputPath = join(directory, "large-output.png");
    await sharp({
      create: {
        width: 1600,
        height: 900,
        channels: 4,
        background: { r: 245, g: 245, b: 245, alpha: 1 }
      }
    })
      .png()
      .toFile(largeInputPath);
    const result = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath: largeInputPath,
        outputPath,
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
    const image = result.content.find((item) => item.type === "image");
    if (image?.type !== "image") throw new Error("Expected compact MCP preview");
    const text = result.content.find((item) => item.type === "text");
    const manifest = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { preview?: { pixelMetrics?: Record<string, number> } } | undefined;
    expect(image._meta).toMatchObject({ "codex/imageDetail": "auto" });
    expect(await sharp(Buffer.from(image.data, "base64")).metadata()).toMatchObject({
      format: "png",
      width: 512,
      height: 288
    });
    expect(manifest?.preview?.pixelMetrics).toEqual({
      fullRasterPixelCount: 1_440_000,
      sourceRegionPixelCount: 1_440_000,
      previewRasterPixelCount: 147_456,
      sourceRegionCoverageRatio: 1,
      previewToSourceRegionRatio: 0.1024,
      previewToFullRasterRatio: 0.1024,
      previewPixelReductionRatio: 0.8976
    });
    expect(image._meta?.["agent-callout/pixelMetrics"]).toEqual(manifest?.preview?.pixelMetrics);
    expect(await sharp(outputPath).metadata()).toMatchObject({ width: 1600, height: 900 });
  });

  test("reports metrics for the final high-entropy candidate after byte-budget downgrade", async () => {
    const width = 1024;
    const height = 1024;
    const noisyInputPath = join(directory, "high-entropy-input.png");
    await sharp(deterministicNoise(width, height), { raw: { width, height, channels: 3 } })
      .png()
      .toFile(noisyInputPath);
    const result = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath: noisyInputPath,
        outputPath: join(directory, "high-entropy-output.png"),
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;
    const text = result.content.find((item) => item.type === "text");
    const image = result.content.find((item) => item.type === "image");
    if (image?.type !== "image") throw new Error("Expected downgraded preview image");
    const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      | {
          preview?: {
            width?: number;
            height?: number;
            sizeBytes?: number;
            pixelMetrics?: Record<string, number>;
          };
        }
      | undefined;
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    const previewPixels = metadata.width * metadata.height;

    expect(metadata.width).toBeLessThan(512);
    expect(Buffer.from(image.data, "base64").byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(payload?.preview?.sizeBytes).toBe(Buffer.from(image.data, "base64").byteLength);
    expect(payload?.preview?.pixelMetrics).toMatchObject({
      fullRasterPixelCount: width * height,
      sourceRegionPixelCount: width * height,
      previewRasterPixelCount: previewPixels,
      sourceRegionCoverageRatio: 1,
      previewToSourceRegionRatio: roundedRatio(previewPixels, width * height),
      previewToFullRasterRatio: roundedRatio(previewPixels, width * height),
      previewPixelReductionRatio: roundedRatio(width * height - previewPixels, width * height)
    });
    expect(image._meta?.["agent-callout/pixelMetrics"]).toEqual(payload?.preview?.pixelMetrics);
    expectObjectivePixelMetricKeys(payload?.preview?.pixelMetrics);
  });

  test("returns text-only success when committed output changes before preview encoding", async () => {
    beforePreview = async (result) => {
      await sharp({
        create: { width: 120, height: 80, channels: 4, background: "black" }
      })
        .png()
        .toFile(result.outputPath);
    };
    const result = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: join(directory, "replaced-before-preview.png"),
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(0);
    const text = result.content.find((item) => item.type === "text");
    const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      | {
          preview?: {
            available?: boolean;
            mode?: string;
            fallbackReason?: string;
            message?: string;
          };
        }
      | undefined;
    expect(payload?.preview).toEqual({
      available: false,
      mode: "compact-overview",
      fallbackReason: "encoding-failed",
      message:
        "Output was written successfully, but its preview could not be encoded and verified safely."
    });
    expect(payload?.preview).not.toHaveProperty("pixelMetrics");
    // The text-only fallback keeps the annotate result contract (including
    // outputPath); only the image content and pixel metrics are omitted.
    expect(text?.type === "text" ? text.text : "").not.toContain("pixelMetrics");
  });

  test("rejects a preview candidate replaced in the final-read window", async () => {
    const replacementBytes = await sharp({
      create: { width: 7, height: 5, channels: 4, background: "magenta" }
    })
      .png()
      .toBuffer();
    const replacementBase64 = replacementBytes.toString("base64");
    beforePreviewRead = async (preview) => {
      await writeFile(preview.outputPath, replacementBytes);
    };

    const result = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: join(directory, "candidate-replaced-before-final-read.png"),
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(0);
    expect(JSON.stringify(result.content)).not.toContain(replacementBase64);
    const text = result.content.find((item) => item.type === "text");
    const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { preview?: Record<string, unknown> } | undefined;
    expect(payload?.preview).toMatchObject({
      available: false,
      mode: "compact-overview",
      fallbackReason: "encoding-failed"
    });
    expect(payload?.preview).not.toHaveProperty("pixelMetrics");
    expect(text?.type === "text" ? text.text : "").not.toContain("pixelMetrics");
  });

  test("omits metrics when preview encoding fails before committed-output verification", async () => {
    beforePreview = async (result) => {
      await unlink(result.outputPath);
    };
    const result = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: join(directory, "missing-before-preview.png"),
        spec: { version: "1.1", annotations: [] }
      }
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(0);
    const text = result.content.find((item) => item.type === "text");
    const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { preview?: Record<string, unknown> } | undefined;
    expect(payload?.preview).toMatchObject({
      available: false,
      mode: "compact-overview",
      fallbackReason: "encoding-failed"
    });
    expect(payload?.preview).not.toHaveProperty("pixelMetrics");
    expect(text?.type === "text" ? text.text : "").not.toContain("pixelMetrics");
  });

  test("returns tool-level errors with isError instead of a successful error object", async () => {
    const result = (await client.callTool({
      name: "inspect_image",
      arguments: { inputPath: join(directory, "missing.png") }
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = result.content.find((item) => item.type === "text");
    const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      { ok?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
    expect(payload?.ok).toBe(false);
    expect(payload?.error?.code).toBe("AGENT_CALLOUT_ERROR");
    expect(typeof payload?.error?.message).toBe("string");
  });

  test("strictly rejects overwrite authority for every image-writing tool", async () => {
    const calls = [
      {
        name: "annotate_image",
        outputPath: join(directory, "forbidden-annotate.png"),
        arguments: {
          inputPath,
          spec: { version: "1.0", annotations: [] },
          outputPath: join(directory, "forbidden-annotate.png"),
          overwrite: true
        }
      },
      {
        name: "crop_image",
        outputPath: join(directory, "forbidden-crop.png"),
        arguments: {
          inputPath,
          outputPath: join(directory, "forbidden-crop.png"),
          rect: { x: 0, y: 0, width: 10, height: 10 },
          overwrite: true
        }
      },
      {
        name: "create_contact_sheet",
        outputPath: join(directory, "forbidden-contact-sheet.png"),
        arguments: {
          inputPaths: [inputPath],
          outputPath: join(directory, "forbidden-contact-sheet.png"),
          overwrite: true
        }
      }
    ];

    for (const call of calls) {
      const result = (await client.callTool({
        name: call.name,
        arguments: call.arguments
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("overwrite");
      await expect(access(call.outputPath)).rejects.toThrow();
    }
  });

  test("never recommends the CLI-only overwrite switch after an MCP collision", async () => {
    const outputPath = join(directory, "mcp-existing-output.png");
    const arguments_ = {
      inputPath,
      outputPath,
      spec: { version: "1.0", annotations: [] }
    };
    expect(
      ((await client.callTool({ name: "annotate_image", arguments: arguments_ })) as CallToolResult)
        .isError
    ).not.toBe(true);
    const collision = (await client.callTool({
      name: "annotate_image",
      arguments: arguments_
    })) as CallToolResult;
    expect(collision.isError).toBe(true);
    const text = collision.content.find((item) => item.type === "text");
    const message = text?.type === "text" ? text.text : "";
    expect(message).not.toContain("pass overwrite: true");
    expect(message).toContain("MCP does not expose overwrite authority");
  });

  test("returns an actionable error when a path is outside startup and client roots", async () => {
    const outside = await mkdtemp(join(homedir(), "agent-callout-outside-roots-"));
    try {
      const outsideImage = join(outside, "outside.png");
      await sharp({
        create: {
          width: 4,
          height: 4,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
      })
        .png()
        .toFile(outsideImage);
      const result = (await client.callTool({
        name: "inspect_image",
        arguments: { inputPath: outsideImage }
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === "text");
      const payload = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
        { error?: { message?: unknown } } | undefined;
      expect(payload?.error?.message).toContain("--allow-root");
      expect(payload?.error?.message).toContain("AGENT_CALLOUT_ALLOWED_ROOTS");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("create_handoff and verify_handoff exchange a plain-directory package", async () => {
    const annotated = (await client.callTool({
      name: "annotate_image",
      arguments: {
        inputPath,
        outputPath: join(directory, "handoff-base.png"),
        spec: {
          version: "1.1",
          annotations: [
            { id: "handoff-box", type: "rectangle", rect: { x: 20, y: 20, width: 50, height: 25 } }
          ]
        }
      }
    })) as CallToolResult;
    expect(annotated.isError).not.toBe(true);
    const annotateText = annotated.content.find((item) => item.type === "text");
    const annotatePayload = (
      annotateText?.type === "text" ? JSON.parse(annotateText.text) : undefined
    ) as { outputPath?: string; sidecarPath?: string } | undefined;
    if (annotatePayload?.sidecarPath === undefined) throw new Error("Missing sidecar path.");

    const created = (await client.callTool({
      name: "create_handoff",
      arguments: { sidecarPath: annotatePayload.sidecarPath }
    })) as CallToolResult;
    expect(created.isError).not.toBe(true);
    const createdText = created.content.find((item) => item.type === "text");
    const createdPayload = (
      createdText?.type === "text" ? JSON.parse(createdText.text) : undefined
    ) as { handoffDirectory?: string; annotationCount?: number } | undefined;
    expect(createdPayload?.handoffDirectory).toBe(join(directory, "handoff-base.handoff"));
    expect(createdPayload?.annotationCount).toBe(1);

    const verified = (await client.callTool({
      name: "verify_handoff",
      arguments: { handoffDirectory: createdPayload?.handoffDirectory ?? "" }
    })) as CallToolResult;
    expect(verified.isError).not.toBe(true);
    const verifiedText = verified.content.find((item) => item.type === "text");
    const verifiedPayload = (
      verifiedText?.type === "text" ? JSON.parse(verifiedText.text) : undefined
    ) as { valid?: boolean; filesChecked?: number; issues?: unknown[] } | undefined;
    expect(verifiedPayload?.valid).toBe(true);
    expect(verifiedPayload?.filesChecked).toBe(5);
  });
});
