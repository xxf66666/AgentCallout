import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { annotateImage, reviseAnnotation } from "../src/core/index.js";
import { diffRevisions, forkLineage } from "../src/lineage/index.js";

describe("AgentCallout lineage fork and diff", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-lineage-测试-")));
    await sharp({ create: { width: 120, height: 80, channels: 3, background: "#204060" } })
      .png()
      .toFile(join(directory, "示例 截图.png"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function annotateFixture(): Promise<string> {
    const result = await annotateImage({
      inputPath: join(directory, "示例 截图.png"),
      outputPath: join(directory, "示例 截图.annotated.png"),
      allowedRoots: [directory],
      spec: {
        version: "1.1",
        annotations: [
          { id: "box-1", type: "rectangle", rect: { x: 10, y: 10, width: 40, height: 20 } },
          { id: "box-old", type: "rectangle", rect: { x: 90, y: 50, width: 20, height: 12 } }
        ]
      }
    });
    return result.sidecarPath;
  }

  test("fork copies the whole chain and records fork.json", async () => {
    const sidecarPath = await annotateFixture();
    const rev1 = await reviseAnnotation({
      parentSidecarPath: sidecarPath,
      allowedRoots: [directory],
      edits: [
        {
          op: "add",
          annotation: {
            id: "box-2",
            type: "rectangle",
            rect: { x: 50, y: 40, width: 30, height: 20 }
          }
        }
      ]
    });

    const forked = await forkLineage({
      sidecarPath: rev1.sidecarPath,
      targetDirectory: join(directory, "接交副本"),
      allowedRoots: [directory]
    });

    const entries = (await readdir(forked.forkDirectory)).sort();
    expect(entries).toEqual([
      "fork.json",
      "示例 截图.annotated.json",
      "示例 截图.annotated.png",
      "示例 截图.annotated.rev1.json",
      "示例 截图.annotated.rev1.png",
      "示例 截图.png"
    ]);
    expect(forked.mode).toBe("fork");
    expect(forked.copiedFiles).toBe(5);
    const forkJson = JSON.parse(
      await readFile(join(forked.forkDirectory, "fork.json"), "utf8")
    ) as {
      forkVersion: string;
      mode: string;
      source: { lineageId: string; sidecarSha256: string };
      files: { path: string; sha256: string; sizeBytes: number }[];
    };
    expect(forkJson.forkVersion).toBe("1.0");
    expect(forkJson.mode).toBe("fork");
    expect(forkJson.source.lineageId).toMatch(/^[0-9a-f]{64}$/);
    expect(forkJson.source.sidecarSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(forkJson.files).toHaveLength(5);
    for (const file of forkJson.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.sizeBytes).toBeGreaterThan(0);
    }
  });

  test("working-copy mode records the cooperative intent", async () => {
    const sidecarPath = await annotateFixture();
    const forked = await forkLineage({
      sidecarPath,
      targetDirectory: join(directory, "协作副本"),
      mode: "working-copy",
      allowedRoots: [directory]
    });
    expect(forked.mode).toBe("working-copy");
    const forkJson = JSON.parse(
      await readFile(join(forked.forkDirectory, "fork.json"), "utf8")
    ) as { mode: string };
    expect(forkJson.mode).toBe("working-copy");
  });

  test("diff reports added, removed and changed annotations by stable ID", async () => {
    const sidecarPath = await annotateFixture();
    const rev1 = await reviseAnnotation({
      parentSidecarPath: sidecarPath,
      allowedRoots: [directory],
      edits: [
        {
          op: "add",
          annotation: {
            id: "box-2",
            type: "rectangle",
            rect: { x: 50, y: 40, width: 30, height: 20 }
          }
        },
        {
          op: "set",
          id: "box-1",
          annotation: {
            id: "box-1",
            type: "rectangle",
            rect: { x: 12, y: 12, width: 44, height: 20 }
          }
        },
        { op: "remove", id: "box-old" }
      ]
    });
    void rev1;

    const baseSidecar = join(directory, "示例 截图.annotated.json");
    const rev1Sidecar = join(directory, "示例 截图.annotated.rev1.json");
    const diff = await diffRevisions({
      sidecarPathA: baseSidecar,
      sidecarPathB: rev1Sidecar,
      allowedRoots: [directory]
    });

    expect(diff.lineageRelation).toBe("same-lineage");
    expect(diff.added).toEqual(["box-2"]);
    expect(diff.removed).toEqual(["box-old"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.id).toBe("box-1");
    const change = diff.changed[0] as { changes: { field: string }[] };
    expect(change.changes.map((entry) => entry.field).sort()).toEqual(["rect"]);
  });

  test("diff across a fork reports the forked relation", async () => {
    const sidecarPath = await annotateFixture();
    const rev1 = await reviseAnnotation({
      parentSidecarPath: sidecarPath,
      allowedRoots: [directory],
      edits: [
        {
          op: "add",
          annotation: {
            id: "box-2",
            type: "rectangle",
            rect: { x: 50, y: 40, width: 30, height: 20 }
          }
        }
      ]
    });
    const forked = await forkLineage({
      sidecarPath: rev1.sidecarPath,
      targetDirectory: join(directory, "分叉副本"),
      allowedRoots: [directory]
    });
    const forkRev = await reviseAnnotation({
      parentSidecarPath: join(forked.forkDirectory, "示例 截图.annotated.rev1.json"),
      allowedRoots: [directory],
      edits: [{ op: "remove", id: "box-1" }]
    });
    expect(forkRev.revision.number).toBe(2);

    const diff = await diffRevisions({
      sidecarPathA: join(directory, "示例 截图.annotated.rev1.json"),
      sidecarPathB: forkRev.sidecarPath,
      allowedRoots: [directory]
    });
    expect(diff.lineageRelation).toBe("forked");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual(["box-1"]);
  });

  test("fork and diff reject invalid sources, targets and out-of-roots paths", async () => {
    const sidecarPath = await annotateFixture();

    // A directory that does not exist as the fork target parent.
    await expect(
      forkLineage({
        sidecarPath,
        targetDirectory: join(directory, "不存在的父级", "副本"),
        allowedRoots: [directory]
      })
    ).rejects.toThrow(/LINEAGE_TARGET_INVALID/u);

    // Removing the original image makes the lineage unforkable.
    await rm(join(directory, "示例 截图.png"));
    await expect(
      forkLineage({
        sidecarPath,
        targetDirectory: join(directory, "副本"),
        allowedRoots: [directory]
      })
    ).rejects.toThrow(/LINEAGE_SOURCE_INVALID/u);

    // diff against a non-sidecar file must fail loudly.
    await expect(
      diffRevisions({
        sidecarPathA: join(directory, "示例 截图.annotated.json"),
        sidecarPathB: join(directory, "示例 截图.png"),
        allowedRoots: [directory]
      })
    ).rejects.toThrow();
  });

  test("a tampered fork.json degrades the relation instead of crashing the diff", async () => {
    const sidecarPath = await annotateFixture();
    const forked = await forkLineage({
      sidecarPath,
      targetDirectory: join(directory, "被篡改副本"),
      allowedRoots: [directory]
    });
    await writeFile(join(forked.forkDirectory, "fork.json"), "{corrupted", "utf8");

    const diff = await diffRevisions({
      sidecarPathA: sidecarPath,
      sidecarPathB: join(forked.forkDirectory, "示例 截图.annotated.json"),
      allowedRoots: [directory]
    });
    expect(diff.lineageRelation).toBe("same-lineage");
    expect(diff.added).toEqual([]);
  });
});
