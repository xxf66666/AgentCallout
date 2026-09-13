import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { renderCandidatePreview } from "../src/locator/preview.js";

describe("AgentCallout candidate preview", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-preview-测试-")));
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#F0F4F8" } })
      .png()
      .toFile(join(directory, "页面.png"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("draws numbered outline boxes at candidate positions", async () => {
    const result = await renderCandidatePreview({
      inputPath: join(directory, "页面.png"),
      allowedRoots: [directory],
      candidates: [
        { rect: { x: 30, y: 40, width: 90, height: 30 }, label: "候选一" },
        { rect: { x: 180, y: 120, width: 80, height: 26 } }
      ]
    });
    expect(result.operation).toBe("candidate-preview");
    expect(result.candidateCount).toBe(2);
    expect(result.outputPath).toBe(join(directory, "页面.candidates.png"));

    // Pixel assertions: the box stroke color appears inside both candidate
    // rectangles, and the badge fill appears at the first box corner.
    const { data, info } = await sharp(result.outputPath)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number): [number, number, number] => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
    };
    expect(at(75, 40)).toEqual([255, 59, 48]); // top stroke of box 1
    expect(at(180, 133)).toEqual([255, 59, 48]); // left stroke of box 2
    expect(at(33, 18)).toEqual([255, 59, 48]); // badge fill corner of candidate 1
  });

  test("rejects empty candidate lists and over-limit counts", async () => {
    await expect(
      renderCandidatePreview({
        inputPath: join(directory, "页面.png"),
        allowedRoots: [directory],
        candidates: []
      })
    ).rejects.toThrow(/at least one/u);
    const tooMany = Array.from({ length: 101 }, () => ({
      rect: { x: 1, y: 1, width: 10, height: 10 }
    }));
    await expect(
      renderCandidatePreview({
        inputPath: join(directory, "页面.png"),
        allowedRoots: [directory],
        candidates: tooMany
      })
    ).rejects.toThrow(/at most 100/u);
  });
});
