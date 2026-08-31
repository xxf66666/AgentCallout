import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { canonicalizeSpec, parseAnnotationSpec } from "../src/spec/index.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = path.join(repositoryRoot, "examples");
const examples = ["ui-bug", "numbered-review", "privacy"] as const;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("committed examples", () => {
  for (const example of examples) {
    it(`${example} has a valid spec, decodable output, matching hash, and portable sidecar`, async () => {
      const directory = path.join(examplesRoot, example);
      const spec = JSON.parse(
        await readFile(path.join(directory, "annotations.json"), "utf8")
      ) as unknown;
      const parsed = parseAnnotationSpec(spec);
      const input = await readFile(path.join(directory, "input.png"));
      const output = await readFile(path.join(directory, "output.png"));
      const sidecarText = await readFile(path.join(directory, "output.json"), "utf8");
      const sidecar = JSON.parse(sidecarText) as {
        annotationCount: number;
        annotationSpec: unknown;
        hashes: { inputSha256: string; outputSha256: string; specSha256: string };
        paths: { input?: string; output: string; sidecar: string };
        warnings: unknown[];
      };
      const metadata = await sharp(output).metadata();

      expect(parsed.version).toBe("1.1");
      expect(metadata.format).toBe("png");
      expect(sidecar.annotationCount).toBe(parsed.annotations.length);
      expect(sidecar.annotationSpec).toEqual(parsed);
      expect(sidecar.hashes.inputSha256).toBe(sha256(input));
      expect(sidecar.hashes.outputSha256).toBe(sha256(output));
      expect(sidecar.hashes.specSha256).toBe(sha256(Buffer.from(canonicalizeSpec(parsed))));
      expect(sidecar.paths.output).toBe("output.png");
      expect(sidecar.paths.sidecar).toBe("output.json");
      expect(sidecar.warnings).toEqual([]);
      expect(sidecarText).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\//u);
    });
  }

  it("privacy example replaces the complete token region with one opaque color", async () => {
    const outputPath = path.join(examplesRoot, "privacy", "output.png");
    const region = await sharp(outputPath)
      .extract({ left: 255, top: 372, width: 515, height: 46 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = new Set<string>();
    for (let index = 0; index < region.data.length; index += region.info.channels) {
      pixels.add(
        `${region.data[index]},${region.data[index + 1]},${region.data[index + 2]},${region.data[index + 3]}`
      );
    }
    expect([...pixels]).toEqual(["17,24,39,255"]);
  });

  it("contact sheet and index describe the regenerated 1.1 examples", async () => {
    const output = await readFile(path.join(examplesRoot, "contact-sheet.png"));
    const sidecarText = await readFile(path.join(examplesRoot, "contact-sheet.json"), "utf8");
    const readme = await readFile(path.join(examplesRoot, "README.md"), "utf8");
    const sidecar = JSON.parse(sidecarText) as {
      hashes: { outputSha256: string };
      paths: { output: string; sidecar: string };
      warnings: unknown[];
    };
    const metadata = await sharp(output).metadata();

    expect(metadata.format).toBe("png");
    expect(sidecar.hashes.outputSha256).toBe(sha256(output));
    expect(sidecar.paths.output).toBe("contact-sheet.png");
    expect(sidecar.paths.sidecar).toBe("contact-sheet.json");
    expect(sidecar.warnings).toEqual([]);
    expect(sidecarText).not.toMatch(/[A-Za-z]:[\\/]|\/Users\/|\/home\//u);
    expect(readme).toContain("AnnotationSpec 1.1");
  });
});
