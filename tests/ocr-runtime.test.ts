import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { OcrWorkerProcessError, runIsolatedOcrWorker } from "../src/locator/ocr/process.js";
import {
  installOcrRuntime,
  inspectOcrRuntime,
  OcrRuntimeError,
  recognizeOcrImage
} from "../src/locator/ocr/runtime.js";

const repositoryRoot = path.resolve(".");
const assetRoot = path.join(repositoryRoot, "assets", "ocr-runtime");
const recognitionWorkerPath = path.join(assetRoot, "recognize-worker.mjs");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), `agent-callout-ocr-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFakeTesseractRuntime(directory: string, source: string): Promise<void> {
  const packageDirectory = path.join(directory, "node_modules", "tesseract.js");
  await mkdir(packageDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify({ name: "tesseract.js", version: "7.0.0", main: "index.cjs" })}\n`
    ),
    writeFile(path.join(packageDirectory, "index.cjs"), source)
  ]);
}

async function makeInvalidOwnedRuntime(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const name of [
    "package.json",
    "package-lock.json",
    "network-guard.cjs",
    "offline-worker.cjs"
  ]) {
    await copyFile(path.join(assetRoot, name), path.join(directory, name));
  }
  const packageMarkers = [
    ["tesseract.js", "7.0.0"],
    ["tesseract.js-core", "7.0.0"],
    ["@tesseract.js-data/eng", "1.0.0"],
    ["@tesseract.js-data/chi_sim", "1.0.0"]
  ] as const;
  for (const [packageName, version] of packageMarkers) {
    const packageDirectory = path.join(directory, "node_modules", packageName);
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify({ name: packageName, version })}\n`
    );
  }
  const workerDirectory = path.join(
    directory,
    "node_modules",
    "tesseract.js",
    "src",
    "worker-script",
    "node"
  );
  await mkdir(workerDirectory, { recursive: true });
  await writeFile(path.join(workerDirectory, "index.js"), "module.exports = {};\n");
  await mkdir(path.join(directory, "models"));
  await writeFile(
    path.join(directory, "models", "eng.traineddata"),
    "CUSTOMER_SECRET_OCR_MODEL_BYTES"
  );
  const packageLockBytes = await readFile(path.join(assetRoot, "package-lock.json"));
  const { createHash } = await import("node:crypto");
  await writeFile(
    path.join(directory, "runtime-manifest.json"),
    `${JSON.stringify(
      {
        artifact: "agent-callout-ocr-runtime",
        schemaVersion: 1,
        runtimeVersion: "v1",
        packageLockSha256: createHash("sha256").update(packageLockBytes).digest("hex"),
        installedLanguages: ["eng"],
        models: [
          {
            language: "eng",
            version: "4.0.0_best_int",
            sizeBytes: 5_199_098,
            sha256: "5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747"
          }
        ]
      },
      null,
      2
    )}\n`
  );
}

async function processExists(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return false;
    }
  }
  return true;
}

async function rejectedError(operation: Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection.");
  }
  throw new Error("Expected the operation to reject.");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("optional OCR runtime", () => {
  it("maps a fake local engine into bounded lines, words, symbols, and coordinates", async () => {
    const runtimeDirectory = await temporaryDirectory("fake-success");
    await writeFakeTesseractRuntime(
      runtimeDirectory,
      `
        module.exports = {
          OEM: { LSTM_ONLY: 1 },
          PSM: { SPARSE_TEXT: 11 },
          createWorker: async (languages, _oem, options) => {
            if (languages.join('+') !== 'eng+chi_sim') throw new Error('wrong languages');
            if (!require('node:path').isAbsolute(options.workerPath)) throw new Error('worker path');
            if (!require('node:path').isAbsolute(options.langPath)) throw new Error('lang path');
            if (options.cacheMethod !== 'none' || options.gzip !== false) throw new Error('online');
            return {
              setParameters: async () => {},
              recognize: async () => ({ data: {
                version: 'fake-tesseract-5',
                blocks: [{ paragraphs: [{ lines: [{
                  text: '保存 Save',
                  words: [{
                    text: '保存', confidence: 94, bbox: { x0: 10, y0: 12, x1: 42, y1: 28 },
                    symbols: [
                      { text: '保', confidence: 95, bbox: { x0: 10, y0: 12, x1: 26, y1: 28 } },
                      { text: '存', confidence: 93, bbox: { x0: 26, y0: 12, x1: 42, y1: 28 } }
                    ]
                  }]
                }] }] }]
              } }),
              terminate: async () => {}
            };
          }
        };
      `
    );

    const document = await runIsolatedOcrWorker(
      recognitionWorkerPath,
      {
        runtimeDirectory,
        languages: ["eng", "chi_sim"],
        image: Buffer.from("fake-image")
      },
      2_000
    );

    expect(document).toEqual({
      engineVersion: "fake-tesseract-5",
      lines: [
        {
          text: "保存 Save",
          words: [
            {
              text: "保存",
              confidence: 94,
              bbox: { x0: 10, y0: 12, x1: 42, y1: 28 },
              symbols: [
                {
                  text: "保",
                  confidence: 95,
                  bbox: { x0: 10, y0: 12, x1: 26, y1: 28 }
                },
                {
                  text: "存",
                  confidence: 93,
                  bbox: { x0: 26, y0: 12, x1: 42, y1: 28 }
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it("blocks network APIs inside the isolated engine and suppresses engine error text", async () => {
    const runtimeDirectory = await temporaryDirectory("fake-network");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    await writeFakeTesseractRuntime(
      runtimeDirectory,
      `
        module.exports = {
          OEM: { LSTM_ONLY: 1 }, PSM: { SPARSE_TEXT: 11 },
          createWorker: async () => {
            require('node:http').get('http://127.0.0.1:${address.port}/CUSTOMER_SECRET_OCR');
          }
        };
      `
    );
    try {
      await expect(
        runIsolatedOcrWorker(
          recognitionWorkerPath,
          { runtimeDirectory, languages: ["eng"], image: Buffer.from("secret image") },
          2_000
        )
      ).rejects.toMatchObject({ code: "OCR_ENGINE_FAILED" });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("blocks promise DNS resolution inside the isolated engine", async () => {
    const runtimeDirectory = await temporaryDirectory("fake-dns-network");
    await writeFakeTesseractRuntime(
      runtimeDirectory,
      `
        module.exports = {
          OEM: { LSTM_ONLY: 1 }, PSM: { SPARSE_TEXT: 11 },
          createWorker: async () => {
            const dns = require('node:dns/promises');
            const operations = [
              () => dns.resolve4('localhost'),
              () => new dns.Resolver().resolve4('localhost')
            ];
            let blocked = 0;
            for (const operation of operations) {
              try {
                await operation();
                break;
              } catch (error) {
                if (error.message !== 'AGENT_CALLOUT_OCR_NETWORK_DISABLED') break;
                blocked += 1;
              }
            }
            if (blocked === operations.length) throw new Error('EXPECTED_NETWORK_BLOCK');
            return {
              setParameters: async () => {},
              recognize: async () => ({ data: { version: 'NETWORK_WAS_ALLOWED', blocks: [] } }),
              terminate: async () => {}
            };
          }
        };
      `
    );

    await expect(
      runIsolatedOcrWorker(
        recognitionWorkerPath,
        { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
        2_000
      )
    ).rejects.toMatchObject({ code: "OCR_ENGINE_FAILED" });
  });

  it("rejects repeated stage messages instead of extending the deadline", async () => {
    const runtimeDirectory = await temporaryDirectory("stage-spam");
    const workerPath = path.join(runtimeDirectory, "stage-spam.mjs");
    await writeFile(
      workerPath,
      `
        process.once('message', () => {
          process.send({ type: 'stage', stage: 'initializing' });
          process.send({ type: 'stage', stage: 'initializing' });
          setInterval(() => process.send({ type: 'stage', stage: 'initializing' }), 10);
        });
      `
    );

    await expect(
      runIsolatedOcrWorker(
        workerPath,
        { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
        2_000
      )
    ).rejects.toMatchObject({ code: "OCR_RUNTIME_PROTOCOL_ERROR" });
  });

  it("does not inherit Node injection or coverage-write environment variables", async () => {
    const runtimeDirectory = await temporaryDirectory("clean-env");
    const workerPath = path.join(runtimeDirectory, "clean-env-worker.mjs");
    const coverageDirectory = path.join(runtimeDirectory, "coverage-must-not-exist");
    await writeFile(
      workerPath,
      `
        const fs = await import('node:fs/promises');
        await fs.writeFile(
          ${JSON.stringify(path.join(runtimeDirectory, "observed-env.json"))},
          JSON.stringify({
            nodeOptions: process.env.NODE_OPTIONS ?? null,
            coverage: process.env.NODE_V8_COVERAGE ?? null
          })
        );
        process.once('message', () => {
          process.send({ type: 'stage', stage: 'initializing' });
          process.send({ type: 'stage', stage: 'recognizing' });
          process.send({ type: 'result', document: { engineVersion: 'clean-env', lines: [] } });
        });
      `
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousCoverage = process.env.NODE_V8_COVERAGE;
    process.env.NODE_OPTIONS = "--definitely-not-a-real-node-option";
    process.env.NODE_V8_COVERAGE = coverageDirectory;
    try {
      await expect(
        runIsolatedOcrWorker(
          workerPath,
          { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
          2_000
        )
      ).resolves.toEqual({ engineVersion: "clean-env", lines: [] });
      expect(
        JSON.parse(await readFile(path.join(runtimeDirectory, "observed-env.json"), "utf8"))
      ).toEqual({ nodeOptions: "", coverage: "" });
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
      else process.env.NODE_V8_COVERAGE = previousCoverage;
    }
  });

  it("rejects invalid confidence and oversized text instead of normalizing evidence", async () => {
    for (const [name, word] of [
      ["confidence", `{ text: 'secret', confidence: 101, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }`],
      ["text", `{ text: 'x'.repeat(4097), confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }`]
    ] as const) {
      const runtimeDirectory = await temporaryDirectory(`invalid-${name}`);
      await writeFakeTesseractRuntime(
        runtimeDirectory,
        `
          module.exports = {
            OEM: { LSTM_ONLY: 1 }, PSM: { SPARSE_TEXT: 11 },
            createWorker: async () => ({
              setParameters: async () => {},
              recognize: async () => ({ data: {
                version: 'fake',
                blocks: [{ paragraphs: [{ lines: [{ text: 'line', words: [${word}] }] }] }]
              } }),
              terminate: async () => {}
            })
          };
        `
      );
      const error = await rejectedError(
        runIsolatedOcrWorker(
          recognitionWorkerPath,
          { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
          2_000
        )
      );
      expect(error.code).toBe("OCR_ENGINE_FAILED");
      expect(error.message).not.toContain("secret");
    }
  });

  it("kills an initialization that exceeds its hard deadline", async () => {
    const runtimeDirectory = await temporaryDirectory("fake-timeout");
    await writeFakeTesseractRuntime(
      runtimeDirectory,
      `
        const fs = require('node:fs');
        const path = require('node:path');
        module.exports = {
          OEM: { LSTM_ONLY: 1 }, PSM: { SPARSE_TEXT: 11 },
          createWorker: async () => {
            fs.writeFileSync(path.join(__dirname, '..', '..', 'fake.pid'), String(process.pid));
            setInterval(() => {}, 1_000);
            return new Promise(() => {});
          }
        };
      `
    );

    const error = await rejectedError(
      runIsolatedOcrWorker(
        recognitionWorkerPath,
        { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
        500
      )
    );
    expect(error).toBeInstanceOf(OcrWorkerProcessError);
    expect(error.code).toBe("OCR_RUNTIME_TIMEOUT");
    expect(error.message).toContain("initializing");
    const pid = Number(await readFile(path.join(runtimeDirectory, "fake.pid"), "utf8"));
    expect(await processExists(pid)).toBe(false);
  });

  it("kills a recognition that exceeds its separate hard deadline", async () => {
    const runtimeDirectory = await temporaryDirectory("fake-recognition-timeout");
    await writeFakeTesseractRuntime(
      runtimeDirectory,
      `
        const fs = require('node:fs');
        const path = require('node:path');
        module.exports = {
          OEM: { LSTM_ONLY: 1 }, PSM: { SPARSE_TEXT: 11 },
          createWorker: async () => ({
            setParameters: async () => {},
            recognize: async () => {
              fs.writeFileSync(path.join(__dirname, '..', '..', 'fake.pid'), String(process.pid));
              setInterval(() => {}, 1_000);
              return new Promise(() => {});
            },
            terminate: async () => {}
          })
        };
      `
    );

    const error = await rejectedError(
      runIsolatedOcrWorker(
        recognitionWorkerPath,
        { runtimeDirectory, languages: ["eng"], image: Buffer.from("fake-image") },
        500
      )
    );
    expect(error).toBeInstanceOf(OcrWorkerProcessError);
    expect(error.code).toBe("OCR_RUNTIME_TIMEOUT");
    expect(error.message).toContain("recognizing");
    const pid = Number(await readFile(path.join(runtimeDirectory, "fake.pid"), "utf8"));
    expect(await processExists(pid)).toBe(false);
  });

  it("does not install, repair, write, or start a worker when runtime files are absent", async () => {
    const parent = await temporaryDirectory("missing");
    const runtimeDirectory = path.join(parent, "not-installed");
    const before = await readdir(parent);
    const inspection = await inspectOcrRuntime({ runtimeDirectory });

    expect(inspection).toMatchObject({
      status: "not-installed",
      ready: false,
      runtimeVersion: "v1",
      tesseractVersion: "7.0.0",
      installedLanguages: [],
      issues: []
    });
    await expect(
      recognizeOcrImage(Buffer.from("not-decoded"), {
        runtimeDirectory,
        languages: ["eng"],
        timeoutMs: 500
      })
    ).rejects.toMatchObject({ code: "OCR_RUNTIME_NOT_INSTALLED" });
    expect(await readdir(parent)).toEqual(before);
  });

  it("rejects a corrupted model before process startup without exposing model bytes", async () => {
    const runtimeDirectory = await temporaryDirectory("bad-model");
    await makeInvalidOwnedRuntime(runtimeDirectory);
    const modelPath = path.join(runtimeDirectory, "models", "eng.traineddata");
    const before = await stat(modelPath);
    const inspection = await inspectOcrRuntime({ runtimeDirectory });

    expect(inspection.status).toBe("invalid");
    expect(inspection.issues).toContainEqual(expect.objectContaining({ code: "MODEL_INVALID" }));
    const error = await rejectedError(
      recognizeOcrImage(Buffer.from("not-decoded"), {
        runtimeDirectory,
        languages: ["eng"],
        timeoutMs: 500
      })
    );
    expect(error).toBeInstanceOf(OcrRuntimeError);
    expect(error.code).toBe("OCR_RUNTIME_INVALID");
    expect(error.message).not.toContain("CUSTOMER_SECRET_OCR_MODEL_BYTES");
    const after = await stat(modelPath);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({
      size: before.size,
      mtimeMs: before.mtimeMs
    });
  });

  it("preserves a non-runtime directory when explicit installation is requested", async () => {
    const runtimeDirectory = await temporaryDirectory("unowned");
    const importantPath = path.join(runtimeDirectory, "important.txt");
    await writeFile(importantPath, "preserve me");

    await expect(installOcrRuntime({ runtimeDirectory, languages: ["eng"] })).rejects.toMatchObject(
      { code: "OCR_RUNTIME_INVALID" }
    );
    expect(await readFile(importantPath, "utf8")).toBe("preserve me");
  });

  it("does not treat a forged artifact marker as authority to replace a directory", async () => {
    const runtimeDirectory = await temporaryDirectory("forged-owned-marker");
    const importantPath = path.join(runtimeDirectory, "important.txt");
    await Promise.all([
      writeFile(importantPath, "preserve forged marker directory"),
      writeFile(
        path.join(runtimeDirectory, "runtime-manifest.json"),
        `${JSON.stringify({ artifact: "agent-callout-ocr-runtime" })}\n`
      )
    ]);

    await expect(installOcrRuntime({ runtimeDirectory, languages: ["eng"] })).rejects.toMatchObject(
      { code: "OCR_RUNTIME_INVALID" }
    );
    expect(await readFile(importantPath, "utf8")).toBe("preserve forged marker directory");
    expect(await readdir(runtimeDirectory)).toEqual(["important.txt", "runtime-manifest.json"]);
  });

  it.runIf(typeof process.env.AGENT_CALLOUT_OCR_REAL_RUNTIME === "string")(
    "recognizes a real local English image and keeps repeat installation idempotent",
    async () => {
      const runtimeDirectory = process.env.AGENT_CALLOUT_OCR_REAL_RUNTIME as string;
      const installed = await installOcrRuntime({ runtimeDirectory, languages: ["eng"] });
      expect(installed).toMatchObject({ installed: false, ready: true });
      expect(installed.models).toContainEqual({
        language: "eng",
        version: "4.0.0_best_int",
        sizeBytes: 5_199_098,
        sha256: "5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747"
      });
      const label = await sharp({
        text: { text: "HELLO OCR", font: "Arial 72", rgba: true }
      })
        .png()
        .toBuffer();
      const image = await sharp({
        create: { width: 640, height: 180, channels: 3, background: "white" }
      })
        .composite([{ input: label, left: 40, top: 40 }])
        .png()
        .toBuffer();
      const document = await recognizeOcrImage(image, {
        runtimeDirectory,
        languages: ["eng"],
        timeoutMs: 30_000
      });

      expect(document.engineVersion).toMatch(/^5\./u);
      expect(document.lines.flatMap((line) => line.words.map((word) => word.text))).toEqual(
        expect.arrayContaining(["HELLO", "OCR"])
      );
    },
    60_000
  );

  it.runIf(typeof process.env.AGENT_CALLOUT_OCR_REAL_RUNTIME === "string")(
    "serializes two real first installs and publishes exactly one complete runtime",
    async () => {
      const parent = await temporaryDirectory("real-concurrent-install");
      const runtimeDirectory = path.join(parent, "v1");
      const results = await Promise.all([
        installOcrRuntime({ runtimeDirectory, languages: ["eng"] }),
        installOcrRuntime({ runtimeDirectory, languages: ["eng"] })
      ]);

      expect(results.map((result) => result.installed).sort()).toEqual([false, true]);
      expect(results.every((result) => result.ready)).toBe(true);
      expect(await readdir(parent)).toEqual(["v1"]);
      await expect(inspectOcrRuntime({ runtimeDirectory })).resolves.toMatchObject({
        ready: true,
        installedLanguages: ["eng"]
      });
    },
    120_000
  );
});
