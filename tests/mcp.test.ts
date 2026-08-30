import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createAgentCalloutMcpServer } from "../src/mcp/index.js";

describe("AgentCallout MCP server", () => {
  let directory: string;
  let inputPath: string;
  let client: Client;
  let server: ReturnType<typeof createAgentCalloutMcpServer>;
  let rootListCalls: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-callout-mcp-测试-"));
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
    server = createAgentCalloutMcpServer({ fixedAllowedRoots: [directory] });
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

  test("initializes with workflow instructions and exactly six strict tools", async () => {
    expect(client.getInstructions()).toContain("Inspect the screenshot before annotating");
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "annotate_image",
      "create_contact_sheet",
      "crop_image",
      "doctor",
      "inspect_image",
      "validate_annotation_spec"
    ]);

    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty("allowedRoots");
      if (["annotate_image", "create_contact_sheet", "crop_image"].includes(tool.name)) {
        expect(tool.inputSchema.properties).not.toHaveProperty("overwrite");
        expect(tool.outputSchema).toBeUndefined();
      } else {
        expect(tool.outputSchema?.type).toBe("object");
      }
    }

    const annotate = listed.tools.find((tool) => tool.name === "annotate_image");
    const advertisedSpec = JSON.stringify(annotate?.inputSchema.properties?.spec);
    expect(advertisedSpec).toContain('"const":"1.0"');
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
      ok: true,
      limits: { maxPixels: 40_000_000, maxAnnotations: 200 },
      mcp: { maxPreviewBytes: 128 * 1024 }
    });
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
    const text = cropped.content.find((item) => item.type === "text");
    const image = cropped.content.find((item) => item.type === "image");
    const manifest = (text?.type === "text" ? JSON.parse(text.text) : undefined) as
      Record<string, unknown> | undefined;
    expect(manifest?.outputPath).toBe(outputPath);
    expect(typeof manifest?.sidecarPath).toBe("string");
    expect(typeof manifest?.markdown).toBe("string");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") {
      throw new Error("Expected MCP image content");
    }
    expect(image.mimeType).toBe("image/png");
    const bytes = Buffer.from(image.data, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "png", width: 50, height: 40 });
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
});
