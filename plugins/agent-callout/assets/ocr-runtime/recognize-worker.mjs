import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(moduleDirectory, "network-guard.cjs"));

const MAX_LINES = 5_000;
const MAX_WORDS = 50_000;
const MAX_SYMBOLS = 200_000;
const MAX_TEXT_LENGTH = 4_096;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function safeText(value) {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    throw new Error("OCR_ENGINE_OUTPUT_LIMIT");
  }
  return value;
}

function safeConfidence(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error("OCR_ENGINE_INVALID_CONFIDENCE");
  }
  return value;
}

function safeBounds(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isFinite(value.x0) ||
    !Number.isFinite(value.y0) ||
    !Number.isFinite(value.x1) ||
    !Number.isFinite(value.y1) ||
    value.x1 < value.x0 ||
    value.y1 < value.y0
  ) {
    throw new Error("OCR_ENGINE_INVALID_GEOMETRY");
  }
  return { x0: value.x0, y0: value.y0, x1: value.x1, y1: value.y1 };
}

function engineDocument(data) {
  const lines = [];
  let wordCount = 0;
  let symbolCount = 0;
  let textBytes = 0;
  const takeText = (value) => {
    const text = safeText(value);
    textBytes += Buffer.byteLength(text, "utf8");
    if (textBytes > MAX_TEXT_BYTES) throw new Error("OCR_ENGINE_OUTPUT_LIMIT");
    return text;
  };
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        if (lines.length >= MAX_LINES) throw new Error("OCR_ENGINE_OUTPUT_LIMIT");
        const words = [];
        for (const word of line.words ?? []) {
          wordCount += 1;
          if (wordCount > MAX_WORDS) throw new Error("OCR_ENGINE_OUTPUT_LIMIT");
          const symbols = [];
          for (const symbol of word.symbols ?? []) {
            symbolCount += 1;
            if (symbolCount > MAX_SYMBOLS) throw new Error("OCR_ENGINE_OUTPUT_LIMIT");
            const text = takeText(symbol.text);
            if (text.trim() === "") continue;
            symbols.push({
              text,
              confidence: safeConfidence(symbol.confidence),
              bbox: safeBounds(symbol.bbox)
            });
          }
          const text = takeText(word.text);
          if (text.trim() === "") continue;
          words.push({
            text,
            confidence: safeConfidence(word.confidence),
            bbox: safeBounds(word.bbox),
            ...(symbols.length === 0 ? {} : { symbols })
          });
        }
        lines.push({ text: takeText(line.text), words });
      }
    }
  }
  return {
    engineVersion: takeText(data.version ?? "tesseract-unknown"),
    lines
  };
}

let replied = false;

function reply(message, exitCode) {
  if (replied) return;
  replied = true;
  if (typeof process.send !== "function") {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => {
    process.disconnect();
    process.exit(exitCode);
  });
}

process.once("message", async (request) => {
  let worker;
  try {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.runtimeDirectory !== "string" ||
      !Array.isArray(request.languages) ||
      !Buffer.isBuffer(request.image)
    ) {
      throw new Error("OCR_WORKER_INVALID_REQUEST");
    }
    replyStage("initializing");
    const runtimeRequire = createRequire(
      pathToFileURL(path.join(request.runtimeDirectory, "runtime-entry.cjs"))
    );
    const { createWorker, OEM, PSM } = runtimeRequire("tesseract.js");
    worker = await createWorker(request.languages, OEM.LSTM_ONLY, {
      workerPath: path.join(request.runtimeDirectory, "offline-worker.cjs"),
      langPath: path.join(request.runtimeDirectory, "models"),
      cacheMethod: "none",
      gzip: false,
      logger() {},
      errorHandler() {}
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      user_defined_dpi: "96"
    });
    replyStage("recognizing");
    const { data } = await worker.recognize(request.image, {}, { text: false, blocks: true });
    await worker.terminate();
    worker = undefined;
    reply({ type: "result", document: engineDocument(data) }, 0);
  } catch {
    try {
      await worker?.terminate();
    } catch {
      // The parent process owns the hard deadline and will terminate this process if needed.
    }
    reply(
      {
        type: "error",
        code: "OCR_ENGINE_FAILED",
        message: "The isolated OCR engine failed without returning recognized text."
      },
      1
    );
  }
});

function replyStage(stage) {
  if (typeof process.send === "function") process.send({ type: "stage", stage });
}

process.once("uncaughtException", () =>
  reply(
    {
      type: "error",
      code: "OCR_ENGINE_FAILED",
      message: "The isolated OCR engine terminated unexpectedly."
    },
    1
  )
);
process.once("unhandledRejection", () =>
  reply(
    {
      type: "error",
      code: "OCR_ENGINE_FAILED",
      message: "The isolated OCR engine terminated unexpectedly."
    },
    1
  )
);
