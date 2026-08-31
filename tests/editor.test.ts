import { link, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createRedactionProject,
  parseRedactionProject,
  startRedactionEditor
} from "../src/editor/index.js";

describe("redaction editor", () => {
  let directory: string;
  let inputPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agent-callout-editor-"));
    inputPath = join(directory, "source.png");
    await sharp({
      create: {
        width: 80,
        height: 50,
        channels: 4,
        background: { r: 33, g: 99, b: 177, alpha: 1 }
      }
    })
      .png()
      .toFile(inputPath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("accepts only fully opaque redact annotations", () => {
    expect(createRedactionProject("a".repeat(64))).toMatchObject({
      version: "1.0",
      annotationSpec: { annotations: [] }
    });
    expect(() =>
      parseRedactionProject({
        version: "1.0",
        source: { sha256: "a".repeat(64) },
        annotationSpec: {
          version: "1.0",
          annotations: [
            {
              id: "unsafe",
              type: "redact",
              rect: { x: 1, y: 1, width: 4, height: 4 },
              color: "#000000",
              style: { opacity: 0.5 }
            }
          ]
        }
      })
    ).toThrow(/opacity must be 1/u);
  });

  test("rejects a project path that aliases the input image", async () => {
    const projectPath = join(directory, "unsafe.json");
    await link(inputPath, projectPath);
    await expect(
      startRedactionEditor({
        inputPath,
        outputPath: join(directory, "output.png"),
        projectPath
      })
    ).rejects.toThrow(/must not alias the input image/u);
  });

  test("normalizes EXIF orientation for the browser preview", async () => {
    const rotatedInput = join(directory, "rotated.jpg");
    await sharp(inputPath).jpeg().withMetadata({ orientation: 6 }).toFile(rotatedInput);
    const session = await startRedactionEditor({
      inputPath: rotatedInput,
      outputPath: join(directory, "rotated.redacted.png"),
      projectPath: join(directory, "rotated.agentcallout.project.json")
    });
    try {
      const imageUrl = new URL(session.url);
      imageUrl.pathname = "/api/image";
      const response = await fetch(imageUrl);
      expect(response.headers.get("content-type")).toContain("image/png");
      expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
        format: "png",
        width: 50,
        height: 80
      });
    } finally {
      await session.close();
    }
  });

  test("serves a localhost editor, persists the project, and exports opaque pixels", async () => {
    const outputPath = join(directory, "source.redacted.png");
    const projectPath = join(directory, "source.agentcallout.project.json");
    const session = await startRedactionEditor({ inputPath, outputPath, projectPath });
    try {
      const page = await fetch(session.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("可编辑纯色遮挡");

      const stateUrl = session.url.replace("/?", "/api/state?");
      const state = (await (await fetch(stateUrl)).json()) as {
        project: ReturnType<typeof createRedactionProject>;
      };
      state.project.annotationSpec.annotations.push({
        id: "secret",
        type: "redact",
        rect: { x: 10, y: 8, width: 20, height: 12 },
        color: "#A1B2C3"
      });
      const save = await fetch(session.url.replace("/?", "/api/project?"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.project)
      });
      expect(save.status).toBe(200);

      const exported = await fetch(session.url.replace("/?", "/api/export?"), { method: "POST" });
      expect(exported.status).toBe(200);
      expect(await readFile(projectPath, "utf8")).toContain("#A1B2C3");
      const decoded = await sharp(outputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let y = 8; y < 20; y += 1) {
        for (let x = 10; x < 30; x += 1) {
          const offset = (y * decoded.info.width + x) * decoded.info.channels;
          expect([...decoded.data.subarray(offset, offset + 4)]).toEqual([161, 178, 195, 255]);
        }
      }
    } finally {
      await session.close();
    }
  });
});
