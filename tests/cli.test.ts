import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { CliIo, CliWritable } from "../src/cli/index.js";
import { runCli } from "../src/cli/index.js";
import { annotateImage } from "../src/core/index.js";
import {
  NUMBERED_CALLOUT_CANVAS,
  NUMBERED_CALLOUT_V11_SPEC
} from "./fixtures/numbered-callout-v11.js";

class BufferWriter implements CliWritable {
  public value = "";

  public write(chunk: string): void {
    this.value += chunk;
  }
}

function captureIo(): { io: CliIo; stdout: BufferWriter; stderr: BufferWriter } {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  return { io: { stdout, stderr }, stdout, stderr };
}

async function makeImage(path: string, color: { r: number; g: number; b: number }): Promise<void> {
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 4,
      background: { ...color, alpha: 1 }
    }
  })
    .png()
    .toFile(path);
}

describe("AgentCallout CLI", () => {
  let directory: string;
  let inputPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-callout-cli-测试-"));
    inputPath = join(directory, "截图 示例.png");
    await makeImage(inputPath, { r: 40, g: 100, b: 180 });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("inspect emits exactly one JSON document", async () => {
    const capture = captureIo();
    const code = await runCli(
      ["node", "agent-callout", "inspect", inputPath, "--allow-root", directory, "--json"],
      capture.io
    );

    expect(code).toBe(0);
    expect(capture.stderr.value).toBe("");
    const result = JSON.parse(capture.stdout.value) as Record<string, unknown>;
    expect(result.format).toBe("png");
    expect(result.dimensions).toEqual({ width: 96, height: 64 });
  });

  test("validate accepts a spec file and annotate accepts inline JSON", async () => {
    const spec = { version: "1.0", annotations: [] };
    const specPath = join(directory, "批注.json");
    await writeFile(specPath, JSON.stringify(spec), "utf8");

    const validation = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "validate",
          inputPath,
          "--spec",
          specPath,
          "--allow-root",
          directory,
          "--json"
        ],
        validation.io
      )
    ).toBe(0);
    expect(JSON.parse(validation.stdout.value)).toMatchObject({ valid: true });

    const outputPath = join(directory, "已批注.png");
    const annotation = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "annotate",
          inputPath,
          "--spec-json",
          JSON.stringify(spec),
          "--output",
          outputPath,
          "--allow-root",
          directory,
          "--json"
        ],
        annotation.io
      )
    ).toBe(0);
    const generated = JSON.parse(annotation.stdout.value) as Record<string, unknown>;
    expect(generated.outputPath).toBe(outputPath);
    expect((await sharp(outputPath).metadata()).format).toBe("png");
  });

  test("help recommends 1.1 for new specs while retaining 1.0 replay guidance", async () => {
    const capture = captureIo();
    expect(await runCli(["node", "agent-callout", "--help"], capture.io)).toBe(0);

    expect(capture.stderr.value).toBe("");
    expect(capture.stdout.value).toContain("Use AnnotationSpec 1.1 for new specs.");
    expect(capture.stdout.value).toContain("Replay existing 1.0 sidecars unchanged");
    expect(capture.stdout.value).toContain(
      `agent-callout annotate screenshot.png --spec-json '{"version":"1.1","annotations":[]}'`
    );
  });

  test("validate and annotate exercise AnnotationSpec 1.1 through the real CLI", async () => {
    const spec = {
      version: "1.1",
      preset: "docs-light",
      defaults: { strokeWidth: 2 },
      annotations: [
        {
          id: "cli-info",
          type: "rectangle",
          rect: { x: 8, y: 9, width: 32, height: 20 },
          tone: "info"
        }
      ]
    };
    const specPath = join(directory, "1.1-批注.json");
    await writeFile(specPath, JSON.stringify(spec), "utf8");

    const validation = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "validate",
          inputPath,
          "--spec",
          specPath,
          "--allow-root",
          directory,
          "--json"
        ],
        validation.io
      )
    ).toBe(0);
    expect(JSON.parse(validation.stdout.value)).toMatchObject({
      valid: true,
      spec: { version: "1.1", preset: "docs-light" },
      annotationCount: 1
    });

    const outputPath = join(directory, "1.1-已批注.png");
    const annotation = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "annotate",
          inputPath,
          "--spec-json",
          JSON.stringify(spec),
          "--output",
          outputPath,
          "--allow-root",
          directory,
          "--json"
        ],
        annotation.io
      )
    ).toBe(0);
    const generated = JSON.parse(annotation.stdout.value) as {
      outputPath: string;
      sidecarPath: string;
    };
    expect(generated.outputPath).toBe(outputPath);
    expect((await sharp(outputPath).metadata()).format).toBe("png");

    const sidecar = JSON.parse(await readFile(generated.sidecarPath, "utf8")) as {
      annotationSpec: {
        version: string;
        preset?: string;
        annotations: { id: string; tone?: string }[];
      };
      resolvedAnnotations: { style?: { strokeColor?: string } }[];
    };
    expect(sidecar.annotationSpec).toMatchObject({
      version: "1.1",
      preset: "docs-light",
      annotations: [{ id: "cli-info", tone: "info" }]
    });
    expect(sidecar.resolvedAnnotations[0]?.style).toMatchObject({ strokeColor: "#2563eb" });
  });

  test("matches core numbered target/marker/label/leader geometry through the CLI", async () => {
    const publicInputPath = join(directory, "公共入口输入.png");
    await sharp({
      create: { ...NUMBERED_CALLOUT_CANVAS, channels: 3, background: "white" }
    })
      .png()
      .toFile(publicInputPath);
    const outputPath = join(directory, "cli-numbered.png");
    const capture = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "annotate",
          publicInputPath,
          "--spec-json",
          JSON.stringify(NUMBERED_CALLOUT_V11_SPEC),
          "--output",
          outputPath,
          "--allow-root",
          directory,
          "--json"
        ],
        capture.io
      )
    ).toBe(0);
    const generated = JSON.parse(capture.stdout.value) as {
      sidecarPath: string;
      warnings: string[];
    };
    const direct = await annotateImage({
      inputPath: publicInputPath,
      outputPath: join(directory, "core-numbered.png"),
      spec: NUMBERED_CALLOUT_V11_SPEC,
      allowedRoots: [directory]
    });
    const cliSidecar = JSON.parse(await readFile(generated.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
    };
    const coreSidecar = JSON.parse(await readFile(direct.sidecarPath, "utf8")) as {
      resolvedAnnotations: Record<string, unknown>[];
    };

    expect(capture.stderr.value).toBe("");
    expect(generated.warnings).toEqual([]);
    expect(cliSidecar.resolvedAnnotations).toEqual(coreSidecar.resolvedAnnotations);
    const resolved = cliSidecar.resolvedAnnotations[0] as
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

  test("crop and contact-sheet create decodable outputs", async () => {
    const cropPath = join(directory, "局部.png");
    const crop = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "crop",
          inputPath,
          "--rect",
          '{"x":4,"y":5,"width":30,"height":20}',
          "--output",
          cropPath,
          "--allow-root",
          directory,
          "--json"
        ],
        crop.io
      )
    ).toBe(0);
    expect(await sharp(cropPath).metadata()).toMatchObject({
      width: 30,
      height: 20,
      format: "png"
    });

    const secondPath = join(directory, "第二张.webp");
    await sharp(inputPath).webp().toFile(secondPath);
    const sheetPath = join(directory, "联络表.png");
    const sheet = captureIo();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "contact-sheet",
          inputPath,
          secondPath,
          "--output",
          sheetPath,
          "--allow-root",
          directory,
          "--no-labels",
          "--json"
        ],
        sheet.io
      )
    ).toBe(0);
    expect((await sharp(sheetPath).metadata()).format).toBe("png");
  });

  test("doctor self-test exercises real image I/O without leaking temporary paths", async () => {
    const capture = captureIo();
    const code = await runCli(
      ["node", "agent-callout", "doctor", "--self-test", "--json"],
      capture.io
    );
    expect(code).toBe(0);
    const result = JSON.parse(capture.stdout.value) as Record<string, unknown>;
    expect(result.selfTest).toMatchObject({ passed: true });
    expect(capture.stdout.value).not.toContain("agent-callout-self-test-");
  });

  test("reports friendly errors on stderr and returns nonzero", async () => {
    const capture = captureIo();
    const missing = join(directory, "不存在.png");
    const code = await runCli(
      ["node", "agent-callout", "inspect", missing, "--allow-root", directory, "--json"],
      capture.io
    );
    expect(code).toBe(1);
    expect(capture.stdout.value).toBe("");
    expect(capture.stderr.value).toContain("AgentCallout error:");
    expect(capture.stderr.value).not.toContain(" at ");
  });
});
