import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  AgentCalloutRevisionError,
  REVISION_FAULT_POINTS,
  annotateImage,
  createImagePreview,
  reviseAnnotation,
  type RevisionErrorCode,
  type RevisionFaultPoint
} from "../src/core/index.js";
import { runCli, type CliIo, type CliWritable } from "../src/cli/index.js";
import { createAgentCalloutMcpServer } from "../src/mcp/index.js";
import { canonicalizeSpec } from "../src/spec/index.js";

interface BaseFixture {
  inputPath: string;
  outputPath: string;
  sidecarPath: string;
}

interface FileState {
  bytes: Buffer;
  mtimeNs: bigint;
}

interface RevisionSidecar {
  annotationSpec: {
    version: string;
    annotations: { id: string; type: string; [key: string]: unknown }[];
  };
  hashes: {
    inputSha256: string;
    specSha256: string;
    outputSha256: string;
  };
  revision: {
    number: number;
    lineageId: string;
    editsSha256: string;
    parent: {
      sidecar: string;
      sidecarSha256: string;
      output: string;
      outputSha256: string;
      specSha256: string;
    };
  };
}

class StringWriter implements CliWritable {
  public value = "";

  public write(chunk: string): void {
    this.value += chunk;
  }
}

function cliCapture(): { io: CliIo; stdout: StringWriter; stderr: StringWriter } {
  const stdout = new StringWriter();
  const stderr = new StringWriter();
  return { io: { stdout, stderr }, stdout, stderr };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry) => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)])
    );
  }
  throw new TypeError(`Cannot canonicalize ${typeof value}.`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

async function makeInput(filePath: string): Promise<void> {
  const width = 128;
  const height = 96;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 3) % 256;
      pixels[offset + 1] = (y * 5) % 256;
      pixels[offset + 2] = (x + y * 2) % 256;
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toFile(filePath);
}

async function createBase(
  directory: string,
  name: string,
  version: "1.0" | "1.1" = "1.1"
): Promise<BaseFixture> {
  const inputPath = path.join(directory, `${name}.png`);
  const outputPath = path.join(directory, `${name}.annotated.png`);
  await makeInput(inputPath);
  const result = await annotateImage({
    inputPath,
    outputPath,
    spec:
      version === "1.0"
        ? {
            version,
            annotations: [
              {
                id: "box-a",
                type: "rectangle",
                rect: { x: 8, y: 8, width: 28, height: 20 }
              },
              {
                id: "box-b",
                type: "rectangle",
                rect: { x: 74, y: 50, width: 32, height: 24 }
              }
            ]
          }
        : {
            version,
            annotations: [
              {
                id: "box-a",
                type: "rectangle",
                rect: { x: 8, y: 8, width: 28, height: 20 },
                tone: "info"
              },
              {
                id: "box-b",
                type: "rectangle",
                rect: { x: 74, y: 50, width: 32, height: 24 },
                tone: "warning"
              }
            ]
          },
    allowedRoots: [directory]
  });
  return { inputPath, outputPath: result.outputPath, sidecarPath: result.sidecarPath };
}

async function fileState(filePath: string): Promise<FileState> {
  const [bytes, information] = await Promise.all([
    readFile(filePath),
    stat(filePath, { bigint: true })
  ]);
  return { bytes, mtimeNs: information.mtimeNs };
}

async function expectFileState(filePath: string, expected: FileState): Promise<void> {
  const actual = await fileState(filePath);
  expect(actual.bytes).toEqual(expected.bytes);
  expect(actual.mtimeNs).toBe(expected.mtimeNs);
}

async function expectRevisionError(
  promise: Promise<unknown>,
  code: RevisionErrorCode
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentCalloutRevisionError);
    expect((error as AgentCalloutRevisionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected revision error ${code}`);
}

async function revisionResidues(directory: string, stem: string): Promise<string[]> {
  return (await readdir(directory))
    .filter(
      (name) =>
        name.startsWith(`${stem}.rev`) ||
        name.endsWith(".revision.lock") ||
        (name.includes(".revision-lock.") && name.endsWith(".tmp")) ||
        (name.startsWith(`.${stem}.rev`) && name.endsWith(".tmp"))
    )
    .sort();
}

async function runCliProcess(
  arguments_: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...arguments_], {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("safe versioned annotation revisions", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agent-callout-revision-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("replays base -> add -> set -> remove with immutable bytes, mtimes, order, hashes, and lineage", async () => {
    const base = await createBase(directory, "chain");
    const protectedFiles = [base.inputPath, base.outputPath, base.sidecarPath];
    const protectedStates = new Map<string, FileState>();
    for (const filePath of protectedFiles) protectedStates.set(filePath, await fileState(filePath));

    const rev1 = await reviseAnnotation({
      parentSidecarPath: base.sidecarPath,
      edits: [
        {
          op: "add",
          afterId: "box-a",
          annotation: {
            id: "focus",
            type: "rectangle",
            rect: { x: 45, y: 28, width: 24, height: 18 },
            tone: "success"
          }
        }
      ],
      allowedRoots: [directory]
    });
    protectedFiles.push(rev1.outputPath, rev1.sidecarPath);
    protectedStates.set(rev1.outputPath, await fileState(rev1.outputPath));
    protectedStates.set(rev1.sidecarPath, await fileState(rev1.sidecarPath));

    const rev2 = await reviseAnnotation({
      parentSidecarPath: rev1.sidecarPath,
      edits: [
        {
          op: "set",
          id: "focus",
          annotation: {
            id: "focus",
            type: "ellipse",
            rect: { x: 43, y: 26, width: 30, height: 24 },
            tone: "danger"
          }
        }
      ],
      allowedRoots: [directory]
    });
    protectedFiles.push(rev2.outputPath, rev2.sidecarPath);
    protectedStates.set(rev2.outputPath, await fileState(rev2.outputPath));
    protectedStates.set(rev2.sidecarPath, await fileState(rev2.sidecarPath));

    const rev3 = await reviseAnnotation({
      parentSidecarPath: rev2.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });

    expect(path.basename(rev1.outputPath)).toBe("chain.annotated.rev1.png");
    expect(path.basename(rev2.outputPath)).toBe("chain.annotated.rev2.png");
    expect(path.basename(rev3.outputPath)).toBe("chain.annotated.rev3.png");
    const manifests = await Promise.all(
      [rev1.sidecarPath, rev2.sidecarPath, rev3.sidecarPath].map(
        async (sidecarPath) => JSON.parse(await readFile(sidecarPath, "utf8")) as RevisionSidecar
      )
    );
    expect(manifests.map((manifest) => manifest.revision.number)).toEqual([1, 2, 3]);
    expect(new Set(manifests.map((manifest) => manifest.revision.lineageId)).size).toBe(1);
    expect(manifests[0]?.annotationSpec.annotations.map((annotation) => annotation.id)).toEqual([
      "box-a",
      "focus",
      "box-b"
    ]);
    expect(manifests[1]?.annotationSpec.annotations.map((annotation) => annotation.id)).toEqual([
      "box-a",
      "focus",
      "box-b"
    ]);
    expect(manifests[1]?.annotationSpec.annotations[1]?.type).toBe("ellipse");
    expect(manifests[2]?.annotationSpec.annotations.map((annotation) => annotation.id)).toEqual([
      "focus",
      "box-b"
    ]);
    for (const [index, manifest] of manifests.entries()) {
      const result = [rev1, rev2, rev3][index];
      if (result === undefined) throw new Error("Missing revision result");
      expect(manifest.hashes.outputSha256).toBe(sha256(await readFile(result.outputPath)));
      expect(manifest.hashes.specSha256).toBe(result.specSha256);
      expect(manifest.revision.editsSha256).toBe(result.revision.editsSha256);
    }
    expect(manifests[1]?.revision.parent.sidecar).toBe("chain.annotated.rev1.json");
    expect(manifests[2]?.revision.parent.sidecar).toBe("chain.annotated.rev2.json");

    for (const filePath of protectedFiles) {
      const expected = protectedStates.get(filePath);
      if (expected === undefined) throw new Error(`Missing protected state for ${filePath}`);
      await expectFileState(filePath, expected);
    }
  });

  test("revises a trusted AnnotationSpec 1.0 sidecar without admitting 1.1-only fields", async () => {
    const base = await createBase(directory, "legacy-v1", "1.0");
    const revision = await reviseAnnotation({
      parentSidecarPath: base.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });
    const sidecar = JSON.parse(await readFile(revision.sidecarPath, "utf8")) as RevisionSidecar;
    expect(sidecar.annotationSpec.version).toBe("1.0");
    expect(sidecar.annotationSpec.annotations.map((annotation) => annotation.id)).toEqual([
      "box-b"
    ]);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: revision.sidecarPath,
        edits: [
          {
            op: "set",
            id: "box-b",
            annotation: {
              id: "box-b",
              type: "rectangle",
              rect: { x: 74, y: 50, width: 32, height: 24 },
              tone: "danger"
            }
          }
        ],
        allowedRoots: [directory]
      }),
      "REVISION_EDITS_INVALID"
    );
  });

  test("requires explicit moved or basename-only input and accepts only the recorded bytes", async () => {
    const moved = await createBase(directory, "moved");
    const movedInputPath = path.join(directory, "relocated-original.png");
    await rename(moved.inputPath, movedInputPath);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: moved.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "INPUT_REQUIRED"
    );
    const movedRevision = await reviseAnnotation({
      parentSidecarPath: moved.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      inputPath: movedInputPath,
      allowedRoots: [directory]
    });
    expect(movedRevision.inputSha256).toBe(sha256(await readFile(movedInputPath)));

    const mismatch = await createBase(directory, "mismatch");
    const tamperedCopy = path.join(directory, "tampered-copy.png");
    await sharp({
      create: { width: 128, height: 96, channels: 3, background: "black" }
    })
      .png()
      .toFile(tamperedCopy);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: mismatch.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        inputPath: tamperedCopy,
        allowedRoots: [directory]
      }),
      "INPUT_HASH_MISMATCH"
    );

    const basenameOnly = await createBase(directory, "basename");
    const basenameManifest = JSON.parse(await readFile(basenameOnly.sidecarPath, "utf8")) as {
      pathSemantics: string;
      paths: { inputs: string[] };
      inputs: { path: string; pathSemantics: string }[];
    };
    basenameManifest.pathSemantics = "per-input; see inputs[].pathSemantics";
    basenameManifest.paths.inputs[0] = path.basename(basenameOnly.inputPath);
    const inputRecord = basenameManifest.inputs[0];
    if (inputRecord === undefined) throw new Error("Missing input record");
    inputRecord.path = path.basename(basenameOnly.inputPath);
    inputRecord.pathSemantics = "basename-only-resolve-by-sha256";
    await writeFile(basenameOnly.sidecarPath, `${JSON.stringify(basenameManifest, null, 2)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: basenameOnly.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "INPUT_REQUIRED"
    );
    await expect(
      reviseAnnotation({
        parentSidecarPath: basenameOnly.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        inputPath: basenameOnly.inputPath,
        allowedRoots: [directory]
      })
    ).resolves.toMatchObject({ revision: { number: 1 } });
  });

  test("rejects truncated, non-annotate, missing-spec, and hash-tampered parents with no commit", async () => {
    const truncated = await createBase(directory, "truncated");
    await writeFile(truncated.sidecarPath, '{"manifestVersion":"1.0"');
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: truncated.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    const lineageBase = await createBase(directory, "lineage-tamper");
    const lineageRev1 = await reviseAnnotation({
      parentSidecarPath: lineageBase.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });
    const lineageManifest = JSON.parse(await readFile(lineageRev1.sidecarPath, "utf8")) as {
      revision: { parent: { sidecarSha256: string } };
    };
    lineageManifest.revision.parent.sidecarSha256 = "0".repeat(64);
    await writeFile(lineageRev1.sidecarPath, `${JSON.stringify(lineageManifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: lineageRev1.sidecarPath,
        edits: [{ op: "remove", id: "box-b" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    const nonAnnotateInput = path.join(directory, "preview-input.png");
    await makeInput(nonAnnotateInput);
    const preview = await createImagePreview({
      inputPath: nonAnnotateInput,
      outputPath: path.join(directory, "preview.png"),
      allowedRoots: [directory]
    });
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: preview.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    const missingSpec = await createBase(directory, "missing-spec");
    const missingSpecManifest = JSON.parse(
      await readFile(missingSpec.sidecarPath, "utf8")
    ) as Record<string, unknown>;
    delete missingSpecManifest.annotationSpec;
    await writeFile(missingSpec.sidecarPath, `${JSON.stringify(missingSpecManifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: missingSpec.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    const tamperedOutput = await createBase(directory, "tampered-output");
    await writeFile(
      tamperedOutput.outputPath,
      Buffer.concat([await readFile(tamperedOutput.outputPath), Buffer.from([0])])
    );
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: tamperedOutput.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_OUTPUT_MISMATCH"
    );

    const tamperedSpec = await createBase(directory, "tampered-spec");
    const tamperedSpecManifest = JSON.parse(await readFile(tamperedSpec.sidecarPath, "utf8")) as {
      hashes: { specSha256: string };
    };
    tamperedSpecManifest.hashes.specSha256 = "0".repeat(64);
    await writeFile(tamperedSpec.sidecarPath, `${JSON.stringify(tamperedSpecManifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: tamperedSpec.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_SPEC_MISMATCH"
    );

    const pathMismatch = await createBase(directory, "path-mismatch");
    const pathMismatchManifest = JSON.parse(await readFile(pathMismatch.sidecarPath, "utf8")) as {
      paths: { inputs: string[] };
    };
    pathMismatchManifest.paths.inputs[0] = "different-input.png";
    await writeFile(pathMismatch.sidecarPath, `${JSON.stringify(pathMismatchManifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: pathMismatch.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    for (const stem of [
      "truncated.annotated",
      "missing-spec.annotated",
      "tampered-output.annotated",
      "tampered-spec.annotated",
      "path-mismatch.annotated"
    ]) {
      expect(await revisionResidues(directory, stem)).toEqual([]);
    }
  });

  test("strictly rejects unknown or contradictory parent manifest fields", async () => {
    const cases: {
      name: string;
      mutate: (manifest: Record<string, unknown>) => void;
    }[] = [
      { name: "unknown-root", mutate: (manifest) => void (manifest.unexpected = true) },
      {
        name: "unknown-path",
        mutate: (manifest) =>
          void ((manifest.paths as Record<string, unknown>).unexpected = "value")
      },
      {
        name: "unknown-hash",
        mutate: (manifest) =>
          void ((manifest.hashes as Record<string, unknown>).unexpected = "0".repeat(64))
      },
      {
        name: "bad-path-semantics",
        mutate: (manifest) => void (manifest.pathSemantics = "absolute")
      },
      {
        name: "contradictory-path-semantics",
        mutate: (manifest) =>
          void (manifest.pathSemantics = "per-input; see inputs[].pathSemantics")
      },
      {
        name: "revision-manifest-without-revision",
        mutate: (manifest) => void (manifest.manifestVersion = "1.1")
      },
      {
        name: "unknown-dimension",
        mutate: (manifest) =>
          void ((manifest.outputDimensions as Record<string, unknown>).unexpected = 1)
      },
      {
        name: "unknown-renderer",
        mutate: (manifest) =>
          void ((manifest.renderer as Record<string, unknown>).unexpected = true)
      },
      {
        name: "unknown-security",
        mutate: (manifest) =>
          void ((manifest.security as Record<string, unknown>).unexpected = true)
      },
      {
        name: "contradictory-security",
        mutate: (manifest) =>
          void ((manifest.security as Record<string, unknown>).metadataStripped = false)
      },
      {
        name: "contradictory-redact",
        mutate: (manifest) => void (manifest.usesRedact = true)
      },
      {
        name: "contradictory-markdown",
        mutate: (manifest) => void (manifest.markdown = "![wrong](wrong.png)")
      }
    ];
    for (const item of cases) {
      const base = await createBase(directory, `strict-${item.name}`);
      const manifest = JSON.parse(await readFile(base.sidecarPath, "utf8")) as Record<
        string,
        unknown
      >;
      item.mutate(manifest);
      await writeFile(base.sidecarPath, `${JSON.stringify(manifest)}\n`);
      await expectRevisionError(
        reviseAnnotation({
          parentSidecarPath: base.sidecarPath,
          edits: [{ op: "remove", id: "box-a" }],
          allowedRoots: [directory]
        }),
        "PARENT_SIDECAR_INVALID"
      );
      expect(await revisionResidues(directory, `strict-${item.name}.annotated`)).toEqual([]);
    }
  });

  test("refuses to create a revision that would exceed the readable chain bound", async () => {
    type MutableSpec = {
      version: string;
      annotations: Array<Record<string, unknown>>;
    };
    type MutableManifest = Record<string, unknown> & {
      paths: { inputs: string[]; output: string; sidecar: string };
      hashes: { inputSha256: string; specSha256: string; outputSha256: string };
      annotationSpec: MutableSpec;
      operationSpec: MutableSpec;
    };

    const base = await createBase(directory, "chain-limit");
    const baseSidecarBytes = await readFile(base.sidecarPath);
    const baseOutputBytes = await readFile(base.outputPath);
    const baseManifest = JSON.parse(baseSidecarBytes.toString("utf8")) as MutableManifest;
    const lineageId = sha256(baseSidecarBytes);
    let previousSidecarName = path.basename(base.sidecarPath);
    let previousSidecarBytes = baseSidecarBytes;
    let previousOutputName = path.basename(base.outputPath);
    let previousSpec = structuredClone(baseManifest.annotationSpec);
    let previousSpecSha256 = baseManifest.hashes.specSha256;
    let headSidecarPath = base.sidecarPath;

    for (let revisionNumber = 1; revisionNumber <= 255; revisionNumber += 1) {
      const nextSpec = structuredClone(previousSpec);
      const annotation = nextSpec.annotations.find((candidate) => candidate.id === "box-a");
      const rect = annotation?.rect;
      if (annotation === undefined || rect === null || typeof rect !== "object") {
        throw new Error("Chain fixture lost box-a geometry.");
      }
      (rect as Record<string, unknown>).x = revisionNumber % 2 === 1 ? 9 : 8;
      const edits = [{ op: "set", id: "box-a", annotation: structuredClone(annotation) }];
      const outputName = `chain-limit.annotated.rev${revisionNumber}.png`;
      const sidecarName = `chain-limit.annotated.rev${revisionNumber}.json`;
      await writeFile(path.join(directory, outputName), baseOutputBytes, { flag: "wx" });

      const nextSpecSha256 = sha256(Buffer.from(canonicalizeSpec(nextSpec), "utf8"));
      const manifest = structuredClone(baseManifest);
      manifest.manifestVersion = "1.1";
      manifest.paths = {
        inputs: [...baseManifest.paths.inputs],
        output: outputName,
        sidecar: sidecarName
      };
      manifest.operationSpec = nextSpec;
      manifest.annotationSpec = nextSpec;
      manifest.hashes = {
        ...baseManifest.hashes,
        specSha256: nextSpecSha256,
        outputSha256: sha256(baseOutputBytes)
      };
      manifest.markdown = `![AgentCallout output](<${outputName}>)`;
      manifest.revision = {
        number: revisionNumber,
        lineageId,
        parent: {
          sidecar: previousSidecarName,
          sidecarSha256: sha256(previousSidecarBytes),
          output: previousOutputName,
          outputSha256: sha256(baseOutputBytes),
          specSha256: previousSpecSha256
        },
        edits,
        editsSha256: sha256(Buffer.from(canonicalJson(edits), "utf8"))
      };
      const sidecarBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      headSidecarPath = path.join(directory, sidecarName);
      await writeFile(headSidecarPath, sidecarBytes, { flag: "wx" });
      previousSidecarName = sidecarName;
      previousSidecarBytes = sidecarBytes;
      previousOutputName = outputName;
      previousSpec = nextSpec;
      previousSpecSha256 = nextSpecSha256;
    }

    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: headSidecarPath,
        edits: [{ op: "remove", id: "box-b" }],
        allowedRoots: [directory]
      }),
      "REVISION_LIMIT_REACHED"
    );
    await expect(
      stat(path.join(directory, "chain-limit.annotated.rev256.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  test("checks projected chain bytes before publishing the next revision", async () => {
    const base = await createBase(directory, "projected-budget");
    const [sidecarInformation, outputInformation] = await Promise.all([
      stat(base.sidecarPath, { bigint: true }),
      stat(base.outputPath, { bigint: true })
    ]);
    const existingBytes = Number(sidecarInformation.size + outputInformation.size);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: base.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory],
        maxRevisionChainBytes: existingBytes + 1
      }),
      "REVISION_LIMIT_REACHED"
    );
    expect(await revisionResidues(directory, "projected-budget.annotated")).toEqual([]);
  });

  test("rejects hard-linked outputs anywhere in the trusted ancestor chain", async () => {
    const base = await createBase(directory, "ancestor-output-alias");
    const revision = await reviseAnnotation({
      parentSidecarPath: base.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });
    await rm(revision.outputPath);
    await link(base.outputPath, revision.outputPath);
    const manifest = JSON.parse(await readFile(revision.sidecarPath, "utf8")) as {
      hashes: { outputSha256: string };
    };
    manifest.hashes.outputSha256 = sha256(await readFile(base.outputPath));
    await writeFile(revision.sidecarPath, `${JSON.stringify(manifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: revision.sidecarPath,
        edits: [{ op: "remove", id: "box-b" }],
        allowedRoots: [directory]
      }),
      "PARENT_SIDECAR_INVALID"
    );
  });

  test("recovers a matching stale lock owned by a terminated process", async () => {
    const base = await createBase(directory, "stale-lock");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      windowsHide: true,
      stdio: "ignore"
    });
    const deadPid = child.pid;
    if (deadPid === undefined) throw new Error("Child process did not expose a PID");
    const exited = new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("exit", () => resolvePromise());
      child.once("error", rejectPromise);
    });
    child.kill();
    await exited;
    const lineageId = sha256(await readFile(base.sidecarPath));
    const stem = path.basename(base.sidecarPath, ".json");
    const lockPath = path.join(directory, `.${lineageId}.revision.lock`);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        version: "1.0",
        token: "00000000-0000-4000-8000-000000000001",
        pid: deadPid,
        lineageId,
        parentSidecarSha256: lineageId,
        revisionNumber: 1,
        output: `${stem}.rev1.png`,
        sidecar: `${stem}.rev1.json`
      })}\n`
    );
    const revision = await reviseAnnotation({
      parentSidecarPath: base.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });
    expect(revision.revision.number).toBe(1);
    expect(await revisionResidues(directory, stem)).toEqual([
      `${stem}.rev1.json`,
      `${stem}.rev1.png`
    ]);
  });

  test("never deletes an incomplete lock based only on age", async () => {
    const base = await createBase(directory, "incomplete-lock");
    const lineageId = sha256(await readFile(base.sidecarPath));
    const lockPath = path.join(directory, `.${lineageId}.revision.lock`);
    const lockBytes = Buffer.from("{\n", "utf8");
    await writeFile(lockPath, lockBytes);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: base.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory]
      }),
      "REVISION_RECOVERY_REQUIRED"
    );
    expect(await readFile(lockPath)).toEqual(lockBytes);
    expect(await revisionResidues(directory, "incomplete-lock.annotated")).toEqual([
      `.${lineageId}.revision.lock`
    ]);
  });

  test("recovers lock, temp, and orphan PNG after an abruptly terminated publisher", async () => {
    const base = await createBase(directory, "killed-publisher");
    const moduleUrl = pathToFileURL(path.resolve("src/core/index.ts")).href;
    const script = `
      (async () => {
        const { reviseAnnotation } = await import(${JSON.stringify(moduleUrl)});
        await reviseAnnotation({
          parentSidecarPath: process.env.REVISION_PARENT,
          edits: [{ op: "remove", id: "box-a" }],
          allowedRoots: [process.env.REVISION_ROOT],
          faultInjector: async (point) => {
            if (point === "sidecar-publish") {
              process.stdout.write("READY\\n");
              await new Promise(() => {});
            }
          }
        });
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        REVISION_PARENT: base.sidecarPath,
        REVISION_ROOT: directory
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(
        () => rejectPromise(new Error("Killed publisher was not ready")),
        15_000
      );
      let stdout = "";
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("READY")) {
          clearTimeout(timeout);
          resolvePromise();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
      child.once("exit", (code) => {
        if (!stdout.includes("READY")) {
          clearTimeout(timeout);
          rejectPromise(new Error(`Killed publisher exited early with ${String(code)}`));
        }
      });
    });
    child.kill();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("exit", () => resolvePromise());
      child.once("error", rejectPromise);
    });

    const revision = await reviseAnnotation({
      parentSidecarPath: base.sidecarPath,
      edits: [{ op: "remove", id: "box-a" }],
      allowedRoots: [directory]
    });
    expect(revision.revision.number).toBe(1);
    expect(await revisionResidues(directory, "killed-publisher.annotated")).toEqual([
      "killed-publisher.annotated.rev1.json",
      "killed-publisher.annotated.rev1.png"
    ]);
  }, 30_000);

  test("rejects every invalid edit batch without temp, lock, or revision residue", async () => {
    const cases: { name: string; edits: unknown }[] = [
      {
        name: "missing-id",
        edits: [
          {
            op: "add",
            annotation: { type: "rectangle", rect: { x: 1, y: 1, width: 4, height: 4 } }
          }
        ]
      },
      {
        name: "duplicate-add",
        edits: [
          {
            op: "add",
            annotation: {
              id: "box-a",
              type: "rectangle",
              rect: { x: 1, y: 1, width: 4, height: 4 }
            }
          }
        ]
      },
      {
        name: "unknown-set",
        edits: [
          {
            op: "set",
            id: "unknown",
            annotation: {
              id: "unknown",
              type: "rectangle",
              rect: { x: 1, y: 1, width: 4, height: 4 }
            }
          }
        ]
      },
      { name: "unknown-remove", edits: [{ op: "remove", id: "unknown" }] },
      {
        name: "duplicate-touch",
        edits: [
          { op: "remove", id: "box-a" },
          {
            op: "set",
            id: "box-a",
            annotation: {
              id: "box-a",
              type: "rectangle",
              rect: { x: 2, y: 2, width: 5, height: 5 }
            }
          }
        ]
      },
      {
        name: "unknown-after",
        edits: [
          {
            op: "add",
            afterId: "unknown",
            annotation: { id: "new", type: "rectangle", rect: { x: 1, y: 1, width: 4, height: 4 } }
          }
        ]
      },
      {
        name: "no-op",
        edits: [
          {
            op: "set",
            id: "box-a",
            annotation: {
              id: "box-a",
              type: "rectangle",
              rect: { x: 8, y: 8, width: 28, height: 20 },
              tone: "info"
            }
          }
        ]
      },
      {
        name: "mismatched-set-id",
        edits: [
          {
            op: "set",
            id: "box-a",
            annotation: {
              id: "box-b",
              type: "rectangle",
              rect: { x: 1, y: 1, width: 4, height: 4 }
            }
          }
        ]
      }
    ];

    for (const item of cases) {
      const base = await createBase(directory, item.name);
      await expectRevisionError(
        reviseAnnotation({
          parentSidecarPath: base.sidecarPath,
          edits: item.edits,
          allowedRoots: [directory]
        }),
        "REVISION_EDITS_INVALID"
      );
      expect(await revisionResidues(directory, `${item.name}.annotated`)).toEqual([]);
    }

    const limitInputPath = path.join(directory, "final-invalid.png");
    await makeInput(limitInputPath);
    const limitBase = await annotateImage({
      inputPath: limitInputPath,
      outputPath: path.join(directory, "final-invalid.annotated.png"),
      spec: {
        version: "1.1",
        annotations: Array.from({ length: 200 }, (_unused, index) => ({
          id: `limit-${index + 1}`,
          type: "rectangle" as const,
          rect: { x: index % 100, y: index % 70, width: 2, height: 2 }
        }))
      },
      allowedRoots: [directory]
    });
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: limitBase.sidecarPath,
        edits: [
          {
            op: "add",
            annotation: {
              id: "limit-201",
              type: "rectangle",
              rect: { x: 1, y: 1, width: 2, height: 2 }
            }
          }
        ],
        allowedRoots: [directory]
      }),
      "REVISION_EDITS_INVALID"
    );
    expect(await revisionResidues(directory, "final-invalid.annotated")).toEqual([]);
  });

  test("produces the same spec, output hash, and lineage through core, CLI, and MCP", async () => {
    const coreDirectory = path.join(directory, "core-entry");
    const cliDirectory = path.join(directory, "cli-entry");
    const mcpDirectory = path.join(directory, "mcp-entry");
    await Promise.all(
      [coreDirectory, cliDirectory, mcpDirectory].map((entryDirectory) => mkdir(entryDirectory))
    );
    const [coreBase, cliBase, mcpBase] = await Promise.all([
      createBase(coreDirectory, "same"),
      createBase(cliDirectory, "same"),
      createBase(mcpDirectory, "same")
    ]);
    const edits = [
      {
        op: "set",
        id: "box-a",
        annotation: {
          id: "box-a",
          type: "ellipse",
          rect: { x: 7, y: 7, width: 32, height: 24 },
          tone: "success"
        }
      }
    ];

    const core = await reviseAnnotation({
      parentSidecarPath: coreBase.sidecarPath,
      edits,
      allowedRoots: [directory]
    });

    const capture = cliCapture();
    expect(
      await runCli(
        [
          "node",
          "agent-callout",
          "revise",
          cliBase.sidecarPath,
          "--edits-json",
          JSON.stringify(edits),
          "--allow-root",
          directory,
          "--json"
        ],
        capture.io
      )
    ).toBe(0);
    expect(capture.stderr.value).toBe("");
    const cli = JSON.parse(capture.stdout.value) as typeof core;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createAgentCalloutMcpServer({ fixedAllowedRoots: [directory] });
    const client = new Client(
      { name: "revision-cross-entry", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } }
    );
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(directory).href, name: "test root" }]
    }));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    let mcp: typeof core;
    try {
      const call = (await client.callTool({
        name: "revise_annotation",
        arguments: { parentSidecarPath: mcpBase.sidecarPath, edits }
      })) as CallToolResult;
      expect(call.isError).not.toBe(true);
      expect(call.structuredContent).toBeUndefined();
      expect(call.content.some((item) => item.type === "image")).toBe(true);
      const text = call.content.find((item) => item.type === "text");
      if (text?.type !== "text") throw new Error("Missing MCP revision text result");
      mcp = JSON.parse(text.text) as typeof core;
    } finally {
      await client.close();
      await server.close();
    }

    for (const result of [cli, mcp]) {
      expect(result.specSha256).toBe(core.specSha256);
      expect(result.outputSha256).toBe(core.outputSha256);
      expect(result.revision.lineageId).toBe(core.revision.lineageId);
      expect(result.revision.editsSha256).toBe(core.revision.editsSha256);
    }
    const sidecars = await Promise.all(
      [core.sidecarPath, cli.sidecarPath, mcp.sidecarPath].map(
        async (sidecarPath) => JSON.parse(await readFile(sidecarPath, "utf8")) as RevisionSidecar
      )
    );
    expect(sidecars[1]?.annotationSpec).toEqual(sidecars[0]?.annotationSpec);
    expect(sidecars[2]?.annotationSpec).toEqual(sidecars[0]?.annotationSpec);
  });

  test("allows exactly one complete commit in a 16-process race", async () => {
    const base = await createBase(directory, "race");
    const editsPath = path.join(directory, "race-edits.json");
    await writeFile(editsPath, JSON.stringify([{ op: "remove", id: "box-a" }]));
    const attempts = await Promise.all(
      Array.from({ length: 16 }, () =>
        runCliProcess([
          "revise",
          base.sidecarPath,
          "--edits",
          editsPath,
          "--allow-root",
          directory,
          "--json"
        ])
      )
    );
    const successes = attempts.filter((attempt) => attempt.code === 0);
    const conflicts = attempts.filter((attempt) => attempt.code !== 0);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(15);
    for (const conflict of conflicts) {
      expect(conflict.stderr).toContain("[REVISION_CONFLICT]");
    }
    const committed = JSON.parse(successes[0]?.stdout ?? "{}") as {
      outputPath?: string;
      sidecarPath?: string;
    };
    expect(await sharp(committed.outputPath).metadata()).toMatchObject({ format: "png" });
    expect(JSON.parse(await readFile(committed.sidecarPath as string, "utf8"))).toMatchObject({
      revision: { number: 1 }
    });
    expect(await revisionResidues(directory, "race.annotated")).toEqual([
      "race.annotated.rev1.json",
      "race.annotated.rev1.png"
    ]);
  }, 60_000);

  test("cleans this transaction at every staged write, flush, and publish fault", async () => {
    const postCommitFaults = new Set<RevisionFaultPoint>([
      "temp-sidecar-remove",
      "lock-close",
      "lock-remove"
    ]);
    for (const point of REVISION_FAULT_POINTS.filter(
      (candidate) => !postCommitFaults.has(candidate) && candidate !== "rollback-png"
    )) {
      const base = await createBase(directory, `fault-${point}`);
      const protectedPaths = [base.inputPath, base.outputPath, base.sidecarPath];
      const states = await Promise.all(protectedPaths.map((filePath) => fileState(filePath)));
      let injected = false;
      await expectRevisionError(
        reviseAnnotation({
          parentSidecarPath: base.sidecarPath,
          edits: [{ op: "remove", id: "box-a" }],
          allowedRoots: [directory],
          faultInjector: (current: RevisionFaultPoint) => {
            if (current === point && !injected) {
              injected = true;
              throw new Error(`injected ${point}`);
            }
          }
        }),
        "REVISION_PUBLISH_FAILED"
      );
      expect(await revisionResidues(directory, `fault-${point}.annotated`)).toEqual([]);
      for (const [index, filePath] of protectedPaths.entries()) {
        const state = states[index];
        if (state === undefined) throw new Error("Missing protected file state");
        await expectFileState(filePath, state);
      }
    }

    const rollbackBase = await createBase(directory, "fault-rollback-png");
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: rollbackBase.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory],
        faultInjector: (point) => {
          if (point === "sidecar-publish" || point === "rollback-png") {
            throw new Error(`injected ${point}`);
          }
        }
      }),
      "REVISION_PUBLISH_FAILED"
    );
    expect(await revisionResidues(directory, "fault-rollback-png.annotated")).toEqual([]);
  });

  test("reports post-commit cleanup faults and recovers them from the committed head", async () => {
    for (const point of ["temp-sidecar-remove", "lock-close", "lock-remove"] as const) {
      const base = await createBase(directory, `post-commit-${point}`);
      const rev1 = await reviseAnnotation({
        parentSidecarPath: base.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [directory],
        faultInjector: (current) => {
          if (current === point) throw new Error(`injected ${point}`);
        }
      });
      expect(rev1.revision.number).toBe(1);
      expect(rev1.recoveryWarnings?.length).toBeGreaterThan(0);
      const rev2 = await reviseAnnotation({
        parentSidecarPath: rev1.sidecarPath,
        edits: [{ op: "remove", id: "box-b" }],
        allowedRoots: [directory]
      });
      expect(rev2.revision.number).toBe(2);
      expect(await revisionResidues(directory, `post-commit-${point}.annotated`)).toEqual([
        `post-commit-${point}.annotated.rev1.json`,
        `post-commit-${point}.annotated.rev1.png`,
        `post-commit-${point}.annotated.rev2.json`,
        `post-commit-${point}.annotated.rev2.png`
      ]);
    }
  });

  test("rejects root escape, junction escape, target hard links, and input/output aliases", async () => {
    const allowed = path.join(directory, "allowed");
    const outside = path.join(directory, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    const outsideBase = await createBase(outside, "outside-parent");
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: outsideBase.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [allowed]
      }),
      "PARENT_SIDECAR_INVALID"
    );

    const safeBase = await createBase(allowed, "safe");
    const movedOutside = path.join(outside, "moved.png");
    await copyFile(safeBase.inputPath, movedOutside);
    const escape = path.join(allowed, "escape");
    await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
    try {
      await reviseAnnotation({
        parentSidecarPath: safeBase.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        inputPath: path.join(escape, "moved.png"),
        allowedRoots: [allowed]
      });
      throw new Error("Expected INPUT_INVALID");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCalloutRevisionError);
      expect((error as AgentCalloutRevisionError).code).toBe("INPUT_INVALID");
      expect((error as Error).message).toContain("outside the allowed roots");
      expect((error as Error).message).not.toContain(outside);
      expect((error as Error).message).not.toContain(movedOutside);
    }

    const hardLinkBase = await createBase(allowed, "target-hardlink");
    const hardLinkTarget = path.join(allowed, "target-hardlink.annotated.rev1.png");
    await link(hardLinkBase.inputPath, hardLinkTarget);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: hardLinkBase.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [allowed]
      }),
      "REVISION_CONFLICT"
    );
    expect(await readFile(hardLinkTarget)).toEqual(await readFile(hardLinkBase.inputPath));

    const aliasBase = await createBase(allowed, "parent-alias");
    await rm(aliasBase.outputPath);
    await link(aliasBase.inputPath, aliasBase.outputPath);
    const aliasManifest = JSON.parse(await readFile(aliasBase.sidecarPath, "utf8")) as {
      hashes: { outputSha256: string };
      outputDimensions: { width: number; height: number };
    };
    aliasManifest.hashes.outputSha256 = sha256(await readFile(aliasBase.inputPath));
    aliasManifest.outputDimensions = { width: 128, height: 96 };
    await writeFile(aliasBase.sidecarPath, `${JSON.stringify(aliasManifest)}\n`);
    await expectRevisionError(
      reviseAnnotation({
        parentSidecarPath: aliasBase.sidecarPath,
        edits: [{ op: "remove", id: "box-a" }],
        allowedRoots: [allowed]
      }),
      "PARENT_SIDECAR_INVALID"
    );
  });
});
