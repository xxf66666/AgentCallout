import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OcrRuntimeModule from "../src/locator/ocr/runtime.js";

const engine = vi.hoisted(() => ({ recognize: vi.fn(), inspect: vi.fn() }));
vi.mock("../src/locator/ocr/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OcrRuntimeModule>()),
  recognizeOcrImage: engine.recognize,
  inspectOcrRuntime: engine.inspect
}));

import { locateText } from "../src/locator/ocr/index.js";
import type { OcrEngineDocument } from "../src/locator/ocr/types.js";

let directory: string;
let inputPath: string;
const document: OcrEngineDocument = {
  engineVersion: "fixture-engine",
  lines: [
    {
      text: "Save UNRELATED_PRIVATE_TRANSCRIPT",
      words: [{ text: "Save", confidence: 94, bbox: { x0: 4, y0: 6, x1: 16, y1: 14 } }]
    }
  ]
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-callout-ocr-locator-"));
  inputPath = path.join(directory, "input.png");
  await sharp({ create: { width: 100, height: 80, channels: 3, background: "white" } })
    .png()
    .toFile(inputPath);
  engine.recognize.mockReset().mockResolvedValue(document);
  engine.inspect.mockReset().mockResolvedValue({
    ready: true,
    runtimeVersion: "v1",
    tesseractVersion: "fixture",
    runtimeDirectory: "PRIVATE_RUNTIME_DIRECTORY",
    models: [
      { language: "eng", version: "fixture", sizeBytes: 12, sha256: "e".repeat(64) },
      { language: "chi_sim", version: "fixture", sizeBytes: 13, sha256: "c".repeat(64) }
    ]
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("locator orchestration with controlled OCR engine output", () => {
  it("maps candidates into source pixels, carries evidence, and excludes private transcript/runtime paths", async () => {
    const result = await locateText({
      inputPath,
      query: "save",
      languages: ["eng"],
      region: { x: 10, y: 20, width: 20, height: 10 },
      scale: 2,
      allowedRoots: [directory]
    });
    expect(result.status).toBe("unique");
    expect(result.requiresConfirmation).toBe(false);
    expect(result.candidates[0]).toMatchObject({
      rect: { x: 12, y: 23, width: 6, height: 4 },
      confidence: 94,
      precision: "word",
      evidence: { processedBounds: document.lines[0]?.words[0]?.bbox }
    });
    expect(result.source.dimensions).toEqual({ width: 100, height: 80 });
    expect(result.source.transform.dimensions).toEqual({ width: 40, height: 20 });
    expect(result.engine.models).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /UNRELATED_PRIVATE_TRANSCRIPT|PRIVATE_RUNTIME_DIRECTORY/u
    );
    expect(engine.recognize).toHaveBeenCalledWith(expect.any(Buffer), { languages: ["eng"] });
    const replay = await locateText({
      inputPath,
      query: "save",
      languages: ["eng"],
      region: { x: 10, y: 20, width: 20, height: 10 },
      scale: 2,
      allowedRoots: [directory]
    });
    expect(replay).toEqual(result);
  });

  it("preserves ambiguity and low-confidence flags rather than selecting a candidate", async () => {
    engine.recognize.mockResolvedValue({
      engineVersion: "fixture",
      lines: [
        {
          text: "Save Save",
          words: [
            document.lines[0]?.words[0],
            { text: "Save", confidence: 42, bbox: { x0: 30, y0: 6, x1: 44, y1: 14 } }
          ]
        }
      ]
    });
    const result = await locateText({
      inputPath,
      query: "Save",
      maxCandidates: 1,
      allowedRoots: [directory]
    });
    expect(result).toMatchObject({
      status: "ambiguous",
      requiresConfirmation: true,
      confirmationReasons: ["multiple-candidates", "low-confidence"],
      totalCandidates: 2,
      truncated: true
    });
    expect(result).not.toHaveProperty("selectedCandidate");
  });

  it("reports not-found separately and validates a query before starting the engine", async () => {
    expect(
      await locateText({ inputPath, query: "Missing", allowedRoots: [directory] })
    ).toMatchObject({ status: "not-found", candidates: [], totalCandidates: 0 });
    engine.recognize.mockClear();
    await expect(locateText({ inputPath: "does-not-exist", query: "   " })).rejects.toThrow(
      "non-whitespace"
    );
    expect(engine.recognize).not.toHaveBeenCalled();
  });

  it("rejects a screenshot replaced during recognition", async () => {
    engine.recognize.mockImplementation(async () => {
      await sharp({ create: { width: 100, height: 80, channels: 3, background: "black" } })
        .png()
        .toFile(inputPath);
      return document;
    });
    await expect(
      locateText({ inputPath, query: "Save", allowedRoots: [directory] })
    ).rejects.toMatchObject({ code: "OCR_INPUT_CHANGED" });
  });

  it("rejects selected geometry outside the processed raster", async () => {
    engine.recognize.mockResolvedValue({
      engineVersion: "fixture",
      lines: [
        {
          text: "Save",
          words: [{ text: "Save", confidence: 99, bbox: { x0: 0, y0: 0, x1: 101, y1: 10 } }]
        }
      ]
    });
    await expect(
      locateText({ inputPath, query: "Save", allowedRoots: [directory] })
    ).rejects.toMatchObject({ code: "OCR_RESULT_INVALID" });
  });
});
