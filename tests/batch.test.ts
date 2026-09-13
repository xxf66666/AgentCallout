import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli } from "../src/cli/index.js";
import { annotateBatch, MAX_BATCH_ITEMS } from "../src/core/batch.js";

describe("AgentCallout batch annotate", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-batch-测试-")));
    for (const name of ["图A.png", "图B.png", "图C.png"]) {
      await sharp({ create: { width: 200, height: 140, channels: 3, background: "#204060" } })
        .png()
        .toFile(join(directory, name));
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("rejects empty batches and over-limit item counts", async () => {
    await expect(annotateBatch({ items: [], allowedRoots: [directory] })).rejects.toThrow(
      /non-empty/u
    );
    const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({
      input: join(directory, "图A.png"),
      spec: { version: "1.1", annotations: [] }
    }));
    await expect(annotateBatch({ items: tooMany, allowedRoots: [directory] })).rejects.toThrow(
      /at most 32/u
    );
  });

  test("continuous numbering renumbers numbered-callouts across images", async () => {
    const spec = (text: string) => ({
      version: "1.1",
      annotations: [
        {
          id: "n",
          type: "numbered-callout",
          target: { x: 20, y: 20, width: 60, height: 30 },
          text
        },
        { id: "r", type: "rectangle", rect: { x: 120, y: 90, width: 40, height: 20 } }
      ]
    });
    const result = await annotateBatch({
      allowedRoots: [directory],
      numbering: "continuous",
      items: [
        { input: join(directory, "图A.png"), spec: spec("A1") },
        { input: join(directory, "图B.png"), spec: spec("B1") },
        { input: join(directory, "图C.png"), spec: spec("C1") }
      ]
    });
    expect(result.failureCount).toBe(0);
    expect(result.okCount).toBe(3);
    const numbers = result.results.map((itemResult) => {
      void itemResult;
      return 0;
    });
    void numbers;
    // Numbering is verified through the rendered sidecars below.
    const { readFile } = await import("node:fs/promises");
    for (const [offset, itemResult] of result.results.entries()) {
      const sidecar = JSON.parse(await readFile(itemResult.sidecarPath, "utf8")) as {
        resolvedAnnotations: { id: string; number?: number }[];
      };
      const numbered = sidecar.resolvedAnnotations.find((a) => a.id === "n");
      expect(numbered?.number).toBe(offset + 1);
    }
  });

  test("fail-fast aborts with completed prefix; continue collects failures", async () => {
    const good = (id: string) => ({
      version: "1.1",
      annotations: [{ id, type: "rectangle", rect: { x: 10, y: 10, width: 40, height: 20 } }]
    });
    const bad = {
      version: "1.1",
      annotations: [{ id: "x", type: "rectangle", rect: { x: -500, y: 10, width: 40, height: 20 } }]
    };
    // fail-fast (default)
    await expect(
      annotateBatch({
        allowedRoots: [directory],
        items: [
          {
            input: join(directory, "图A.png"),
            spec: good("ok-1"),
            output: join(directory, "ff-a.png")
          },
          { input: join(directory, "图B.png"), spec: bad },
          { input: join(directory, "图C.png"), spec: good("ok-3") }
        ]
      })
    ).rejects.toThrow(/Batch aborted at item 1/u);

    // continue mode
    const continued = await annotateBatch({
      allowedRoots: [directory],
      continueOnError: true,
      items: [
        {
          input: join(directory, "图A.png"),
          spec: good("ok-1"),
          output: join(directory, "cc-a.png")
        },
        { input: join(directory, "图B.png"), spec: bad },
        {
          input: join(directory, "图C.png"),
          spec: good("ok-3"),
          output: join(directory, "cc-c.png")
        }
      ]
    });
    expect(continued.okCount).toBe(2);
    expect(continued.failureCount).toBe(1);
    expect(continued.failures[0]?.index).toBe(1);
    expect(continued.results.map((r) => r.index)).toEqual([0, 2]);
  });

  test("specPath items load relative specs", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(directory, "spec-c.json"),
      JSON.stringify({
        version: "1.1",
        annotations: [
          { id: "c-1", type: "rectangle", rect: { x: 30, y: 30, width: 50, height: 25 } }
        ]
      })
    );
    const result = await annotateBatch({
      allowedRoots: [directory],
      manifestDirectory: directory,
      items: [
        {
          input: join(directory, "图C.png"),
          specPath: "spec-c.json",
          output: join(directory, "sp-c.png")
        }
      ]
    });
    expect(result.okCount).toBe(1);
  });

  test("CLI annotate --batch runs a manifest and reports per-item results", async () => {
    const { writeFile } = await import("node:fs/promises");
    const manifest = {
      numbering: "continuous",
      items: [
        {
          input: join(directory, "图A.png"),
          spec: {
            version: "1.1",
            annotations: [
              {
                id: "n",
                type: "numbered-callout",
                target: { x: 20, y: 20, width: 60, height: 30 },
                text: "编号一"
              }
            ]
          }
        },
        {
          input: join(directory, "图B.png"),
          specPath: "spec-b.json"
        }
      ]
    };
    await writeFile(
      join(directory, "spec-b.json"),
      JSON.stringify({
        version: "1.1",
        annotations: [
          {
            id: "n2",
            type: "numbered-callout",
            target: { x: 20, y: 20, width: 60, height: 30 },
            text: "编号二"
          }
        ]
      })
    );
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const stdout: string[] = [];
    const stderr: string[] = [];
    void stderr;
    const io = {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) }
    };
    const code = await runCli(
      [
        "node",
        "agent-callout",
        "annotate",
        "--batch",
        join(directory, "manifest.json"),
        "--json",
        "--allow-root",
        directory
      ],
      io
    );
    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join("")) as {
      okCount: number;
      results: { sidecarPath: string }[];
    };
    expect(payload.okCount).toBe(2);
    const { readFile: read } = await import("node:fs/promises");
    const sidecarB = JSON.parse(await read(payload.results[1]?.sidecarPath ?? "", "utf8")) as {
      resolvedAnnotations: { id: string; number?: number }[];
    };
    expect(sidecarB.resolvedAnnotations.find((a) => a.id === "n2")?.number).toBe(2);
  });
});
