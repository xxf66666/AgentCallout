import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli } from "../src/cli/index.js";
import {
  annotateImage,
  createHandoffPackage,
  reviseAnnotation,
  verifyHandoffPackage
} from "../src/core/index.js";

function captureIo(): {
  io: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } };
  stdout: string;
  stderr: string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) }
    },
    get stdout(): string {
      return stdout.join("");
    },
    get stderr(): string {
      return stderr.join("");
    }
  };
}

interface HandoffManifestShape {
  handoffVersion: string;
  generator: { name: string; version: string };
  createdAt: string;
  originalIncluded: boolean;
  annotation: { annotationCount: number; outputDimensions: { width: number; height: number } };
  files: { path: string; role: string; sha256: string; sizeBytes: number }[];
}

describe("AgentCallout handoff packages", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "agent-callout-handoff-测试-")));
    await sharp({ create: { width: 120, height: 80, channels: 3, background: "#204060" } })
      .png()
      .toFile(join(directory, "示例 截图.png"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function annotateFixture(outputName = "示例 截图.annotated.png"): Promise<string> {
    const result = await annotateImage({
      inputPath: join(directory, "示例 截图.png"),
      outputPath: join(directory, outputName),
      allowedRoots: [directory],
      spec: {
        version: "1.1",
        annotations: [
          { id: "box-1", type: "rectangle", rect: { x: 10, y: 10, width: 40, height: 20 } }
        ]
      }
    });
    return result.sidecarPath;
  }

  test("creates a plain-directory package with entry, manifest, summary, sidecar, output and original", async () => {
    const sidecarPath = await annotateFixture();
    const result = await createHandoffPackage({ sidecarPath, allowedRoots: [directory] });

    expect(result.annotationCount).toBe(1);
    const entries = (await readdir(result.handoffDirectory)).sort();
    expect(entries).toEqual([
      "HANDOFF.md",
      "manifest.json",
      "summary.json",
      "示例 截图.annotated.json",
      "示例 截图.annotated.png",
      "示例 截图.png"
    ]);

    const manifest = JSON.parse(
      await readFile(join(result.handoffDirectory, "manifest.json"), "utf8")
    ) as HandoffManifestShape;
    expect(manifest.handoffVersion).toBe("1.0");
    expect(manifest.generator.name).toBe("agent-callout");
    expect(manifest.generator.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow();
    expect(manifest.originalIncluded).toBe(true);
    expect(manifest.annotation.annotationCount).toBe(1);
    expect(manifest.files.map((file) => file.role).sort()).toEqual([
      "annotated-output",
      "annotation-sidecar",
      "entry",
      "original-input",
      "safety-summary"
    ]);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.sizeBytes).toBeGreaterThan(0);
    }

    const summary = JSON.parse(
      await readFile(join(result.handoffDirectory, "summary.json"), "utf8")
    ) as Record<string, unknown>;
    expect(summary["summaryVersion"]).toBe("1.0");
    expect(JSON.stringify(summary)).not.toContain(directory);

    const handoffMd = await readFile(join(result.handoffDirectory, "HANDOFF.md"), "utf8");
    expect(handoffMd).toContain("verify-handoff");
    expect(handoffMd).toContain("示例 截图.annotated.json");

    // The sidecar inside the package must stay byte-identical to the source.
    expect(await readFile(join(result.handoffDirectory, "示例 截图.annotated.json"))).toEqual(
      await readFile(sidecarPath)
    );
  });

  test("omits the original and marks the package non-revisable with --no-original", async () => {
    const sidecarPath = await annotateFixture();
    const result = await createHandoffPackage({
      sidecarPath,
      allowedRoots: [directory],
      includeOriginal: false
    });
    const entries = (await readdir(result.handoffDirectory)).sort();
    expect(entries).not.toContain("示例 截图.png");
    const manifest = JSON.parse(
      await readFile(join(result.handoffDirectory, "manifest.json"), "utf8")
    ) as HandoffManifestShape;
    expect(manifest.originalIncluded).toBe(false);
    const handoffMd = await readFile(join(result.handoffDirectory, "HANDOFF.md"), "utf8");
    expect(handoffMd).toContain("不可重渲染");
  });

  test("rejects reserved names, existing targets and missing originals without side effects", async () => {
    const conflictSidecar = await annotateFixture("manifest.png");
    await expect(
      createHandoffPackage({ sidecarPath: conflictSidecar, allowedRoots: [directory] })
    ).rejects.toThrow(/HANDOFF_NAME_CONFLICT/u);

    const sidecarPath = await annotateFixture();
    const first = await createHandoffPackage({ sidecarPath, allowedRoots: [directory] });
    await expect(createHandoffPackage({ sidecarPath, allowedRoots: [directory] })).rejects.toThrow(
      /HANDOFF_TARGET_EXISTS/u
    );
    const replaced = await createHandoffPackage({
      sidecarPath,
      allowedRoots: [directory],
      overwrite: true,
      includeOriginal: false
    });
    expect((await readdir(replaced.handoffDirectory)).sort()).not.toContain("示例 截图.png");

    await rm(join(directory, "示例 截图.png"));
    await expect(
      createHandoffPackage({ sidecarPath, allowedRoots: [directory], overwrite: true })
    ).rejects.toThrow(/HANDOFF_ORIGINAL_MISSING/u);
    // No half-written target or temp residue may survive a failure.
    expect((await readdir(directory)).filter((name) => name.includes(".handoff"))).toEqual([
      "示例 截图.annotated.handoff"
    ]);
    expect((await readdir(directory)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(first.handoffDirectory).toBe(join(directory, "示例 截图.annotated.handoff"));
  });

  test("verifies an intact package and detects tampering, missing files and broken manifests", async () => {
    const sidecarPath = await annotateFixture();
    const created = await createHandoffPackage({ sidecarPath, allowedRoots: [directory] });
    const intact = await verifyHandoffPackage({
      handoffDirectory: created.handoffDirectory,
      allowedRoots: [directory]
    });
    expect(intact.valid).toBe(true);
    expect(intact.issues).toEqual([]);
    expect(intact.sidecarValid).toBe(true);
    expect(intact.annotationCount).toBe(1);

    const packagedPng = join(created.handoffDirectory, "示例 截图.annotated.png");
    await writeFile(
      packagedPng,
      await sharp({ create: { width: 9, height: 9, channels: 3, background: "#101010" } })
        .png()
        .toBuffer()
    );
    const tampered = await verifyHandoffPackage({
      handoffDirectory: created.handoffDirectory,
      allowedRoots: [directory]
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.issues.map((issue) => issue.code)).toContain("HANDOFF_HASH_MISMATCH");

    await rm(packagedPng);
    const missing = await verifyHandoffPackage({
      handoffDirectory: created.handoffDirectory,
      allowedRoots: [directory]
    });
    expect(missing.issues.map((issue) => issue.code)).toContain("HANDOFF_FILE_MISSING");

    const brokenTarget = join(directory, "坏包.handoff");
    await mkdir(brokenTarget);
    await writeFile(join(brokenTarget, "manifest.json"), "{broken", "utf8");
    // A directory with an unparseable manifest is reported as an invalid
    // manifest instead of throwing.
    const broken = await verifyHandoffPackage({
      handoffDirectory: brokenTarget,
      allowedRoots: [directory]
    });
    expect(broken.valid).toBe(false);
    expect(broken.issues.map((issue) => issue.code)).toContain("HANDOFF_MANIFEST_INVALID");
  });

  test("supports revisions inside the package and keeps verification valid", async () => {
    const sidecarPath = await annotateFixture();
    const created = await createHandoffPackage({ sidecarPath, allowedRoots: [directory] });
    const packagedSidecar = join(created.handoffDirectory, "示例 截图.annotated.json");
    const revised = await reviseAnnotation({
      parentSidecarPath: packagedSidecar,
      allowedRoots: [created.handoffDirectory, directory],
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
    expect(revised.revision.number).toBe(1);
    const verified = await verifyHandoffPackage({
      handoffDirectory: created.handoffDirectory,
      allowedRoots: [directory]
    });
    expect(verified.valid).toBe(true);
    expect(verified.issues).toEqual([]);
  });

  test("concurrent creation lets exactly one writer win", async () => {
    const sidecarPath = await annotateFixture();
    const attempts = await Promise.allSettled([
      createHandoffPackage({ sidecarPath, allowedRoots: [directory] }),
      createHandoffPackage({ sidecarPath, allowedRoots: [directory] })
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter(
      (attempt) =>
        attempt.status === "rejected" && /HANDOFF_TARGET_EXISTS/u.test(String(attempt.reason))
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  test("exposes create-handoff and verify-handoff through the CLI", async () => {
    const sidecarPath = await annotateFixture();
    const create = captureIo();
    const createCode = await runCli(
      ["node", "agent-callout", "create-handoff", sidecarPath, "--json"],
      create.io
    );
    expect(createCode).toBe(0);
    const created = JSON.parse(create.stdout) as { handoffDirectory: string };
    expect(created.handoffDirectory).toBe(join(directory, "示例 截图.annotated.handoff"));

    const verify = captureIo();
    const verifyCode = await runCli(
      ["node", "agent-callout", "verify-handoff", created.handoffDirectory, "--json"],
      verify.io
    );
    expect(verifyCode).toBe(0);
    const verified = JSON.parse(verify.stdout) as { valid: boolean; filesChecked: number };
    expect(verified.valid).toBe(true);
    expect(verified.filesChecked).toBe(5);

    const tamperSidecar = await annotateFixture("中文 输出.annotated.png");
    const createZh = captureIo();
    await runCli(
      [
        "node",
        "agent-callout",
        "create-handoff",
        tamperSidecar,
        "--output-dir",
        join(directory, "中文接交包"),
        "--json"
      ],
      createZh.io
    );
    await rm(join(directory, "中文接交包", "中文 输出.annotated.png"));
    const tamperVerify = captureIo();
    const tamperCode = await runCli(
      ["node", "agent-callout", "verify-handoff", join(directory, "中文接交包"), "--json"],
      tamperVerify.io
    );
    expect(tamperCode).toBe(0);
    const tamperResult = JSON.parse(tamperVerify.stdout) as {
      valid: boolean;
      issues: { code: string }[];
    };
    expect(tamperResult.valid).toBe(false);
    expect(tamperResult.issues.map((issue) => issue.code)).toContain("HANDOFF_FILE_MISSING");
  });
});
