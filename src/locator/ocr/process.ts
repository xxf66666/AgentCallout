import { fork, spawn, type ChildProcess } from "node:child_process";

import type { OcrEngineDocument } from "./types.js";

export type OcrLanguage = "eng" | "chi_sim";

export interface OcrWorkerRequest {
  runtimeDirectory: string;
  languages: OcrLanguage[];
  image: Buffer;
}

export class OcrWorkerProcessError extends Error {
  readonly code:
    | "OCR_ENGINE_FAILED"
    | "OCR_RUNTIME_PROTOCOL_ERROR"
    | "OCR_RUNTIME_TIMEOUT"
    | "OCR_RUNTIME_PROCESS_FAILED";

  constructor(code: OcrWorkerProcessError["code"], message: string) {
    super(message);
    this.name = "OcrWorkerProcessError";
    this.code = code;
  }
}

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_DOCUMENT_LINES = 5_000;
const MAX_DOCUMENT_WORDS = 50_000;
const MAX_DOCUMENT_SYMBOLS = 200_000;
const MAX_TEXT_LENGTH = 4_096;

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    AGENT_CALLOUT_OCR_ISOLATED: "1",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_V8_COVERAGE: "",
    NODE_COMPILE_CACHE: ""
  };
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "PATH",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
    "TZ"
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, name: string): number {
  if (!Number.isFinite(value)) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      `The OCR worker returned an invalid ${name}.`
    );
  }
  return value as number;
}

function confidenceNumber(value: unknown, name: string): number {
  const confidence = finiteNumber(value, name);
  if (confidence < 0 || confidence > 100) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      `The OCR worker returned an invalid ${name}.`
    );
  }
  return confidence;
}

function boundedText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      `The OCR worker returned invalid ${name}.`
    );
  }
  return value;
}

function validateBounds(value: unknown): { x0: number; y0: number; x1: number; y1: number } {
  if (!isRecord(value)) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      "The OCR worker returned invalid bounding geometry."
    );
  }
  const bounds = {
    x0: finiteNumber(value.x0, "x0 coordinate"),
    y0: finiteNumber(value.y0, "y0 coordinate"),
    x1: finiteNumber(value.x1, "x1 coordinate"),
    y1: finiteNumber(value.y1, "y1 coordinate")
  };
  if (bounds.x1 < bounds.x0 || bounds.y1 < bounds.y0) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      "The OCR worker returned inverted bounding geometry."
    );
  }
  return bounds;
}

function validateDocument(value: unknown): OcrEngineDocument {
  if (!isRecord(value) || !Array.isArray(value.lines) || value.lines.length > MAX_DOCUMENT_LINES) {
    throw new OcrWorkerProcessError(
      "OCR_RUNTIME_PROTOCOL_ERROR",
      "The OCR worker returned an invalid document."
    );
  }
  let wordCount = 0;
  let symbolCount = 0;
  const lines = value.lines.map((lineValue) => {
    if (!isRecord(lineValue) || !Array.isArray(lineValue.words)) {
      throw new OcrWorkerProcessError(
        "OCR_RUNTIME_PROTOCOL_ERROR",
        "The OCR worker returned an invalid line."
      );
    }
    const words = lineValue.words.map((wordValue) => {
      wordCount += 1;
      if (wordCount > MAX_DOCUMENT_WORDS || !isRecord(wordValue)) {
        throw new OcrWorkerProcessError(
          "OCR_RUNTIME_PROTOCOL_ERROR",
          "The OCR worker returned an invalid word inventory."
        );
      }
      const rawSymbols = wordValue.symbols;
      if (rawSymbols !== undefined && !Array.isArray(rawSymbols)) {
        throw new OcrWorkerProcessError(
          "OCR_RUNTIME_PROTOCOL_ERROR",
          "The OCR worker returned an invalid symbol inventory."
        );
      }
      const symbols = (rawSymbols ?? []).map((symbolValue) => {
        symbolCount += 1;
        if (symbolCount > MAX_DOCUMENT_SYMBOLS || !isRecord(symbolValue)) {
          throw new OcrWorkerProcessError(
            "OCR_RUNTIME_PROTOCOL_ERROR",
            "The OCR worker returned an invalid symbol inventory."
          );
        }
        return {
          text: boundedText(symbolValue.text, "symbol text"),
          confidence: confidenceNumber(symbolValue.confidence, "symbol confidence"),
          bbox: validateBounds(symbolValue.bbox)
        };
      });
      return {
        text: boundedText(wordValue.text, "word text"),
        confidence: confidenceNumber(wordValue.confidence, "word confidence"),
        bbox: validateBounds(wordValue.bbox),
        ...(symbols.length === 0 ? {} : { symbols })
      };
    });
    return { text: boundedText(lineValue.text, "line text"), words };
  });
  return {
    engineVersion: boundedText(value.engineVersion, "engine version"),
    lines
  };
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") child.kill("SIGKILL");
  }
}

export async function runIsolatedOcrWorker(
  workerPath: string,
  request: OcrWorkerRequest,
  timeoutMs: number
): Promise<OcrEngineDocument> {
  return new Promise<OcrEngineDocument>((resolve, reject) => {
    const forkOptions = {
      cwd: request.runtimeDirectory,
      env: isolatedEnvironment(),
      execArgv: [],
      serialization: "advanced",
      silent: true,
      windowsHide: true,
      detached: process.platform !== "win32"
    } as NonNullable<Parameters<typeof fork>[2]> & { windowsHide: boolean };
    const child = fork(workerPath, [], forkOptions);
    let settled = false;
    let pendingOutcome: (() => void) | undefined;
    let stage: "initializing" | "recognizing" = "initializing";
    let initializationAnnounced = false;
    let recognitionAnnounced = false;
    let stderrBytes = 0;
    let timer: NodeJS.Timeout | undefined;

    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const finishAfterCleanup = (operation: () => void): void => {
      if (settled || pendingOutcome !== undefined) return;
      pendingOutcome = operation;
      clearTimeout(timer);
      void killProcessTree(child).finally(() => settle(operation));
    };
    const armDeadline = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finishAfterCleanup(() =>
          reject(
            new OcrWorkerProcessError(
              "OCR_RUNTIME_TIMEOUT",
              `The isolated OCR ${stage} stage exceeded its deadline.`
            )
          )
        );
      }, timeoutMs);
      timer.unref();
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + chunk.byteLength);
    });
    child.once("error", () => {
      settle(() =>
        reject(
          new OcrWorkerProcessError(
            "OCR_RUNTIME_PROCESS_FAILED",
            "The isolated OCR process could not be started."
          )
        )
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (pendingOutcome !== undefined) {
        settle(pendingOutcome);
        return;
      }
      settle(() =>
        reject(
          new OcrWorkerProcessError(
            "OCR_RUNTIME_PROCESS_FAILED",
            `The isolated OCR process exited before returning a document (${code === null ? (signal ?? "unknown") : `code ${code}`}; ${stderrBytes} stderr bytes suppressed).`
          )
        )
      );
    });
    child.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.type !== "string") {
        finishAfterCleanup(() =>
          reject(
            new OcrWorkerProcessError(
              "OCR_RUNTIME_PROTOCOL_ERROR",
              "The isolated OCR process returned an invalid message."
            )
          )
        );
        return;
      }
      if (
        message.type === "stage" &&
        (message.stage === "initializing" || message.stage === "recognizing")
      ) {
        if (message.stage === "initializing") {
          if (initializationAnnounced || recognitionAnnounced) {
            finishAfterCleanup(() =>
              reject(
                new OcrWorkerProcessError(
                  "OCR_RUNTIME_PROTOCOL_ERROR",
                  "The isolated OCR process repeated or reordered a stage message."
                )
              )
            );
            return;
          }
          initializationAnnounced = true;
          return;
        }
        if (!initializationAnnounced || recognitionAnnounced) {
          finishAfterCleanup(() =>
            reject(
              new OcrWorkerProcessError(
                "OCR_RUNTIME_PROTOCOL_ERROR",
                "The isolated OCR process repeated or reordered a stage message."
              )
            )
          );
          return;
        }
        recognitionAnnounced = true;
        stage = "recognizing";
        armDeadline();
        return;
      }
      if (message.type === "error") {
        finishAfterCleanup(() =>
          reject(
            new OcrWorkerProcessError(
              "OCR_ENGINE_FAILED",
              "The isolated OCR engine failed without returning recognized text."
            )
          )
        );
        return;
      }
      if (message.type === "result") {
        try {
          const document = validateDocument(message.document);
          finishAfterCleanup(() => resolve(document));
        } catch (error) {
          finishAfterCleanup(() =>
            reject(
              error instanceof Error
                ? error
                : new OcrWorkerProcessError(
                    "OCR_RUNTIME_PROTOCOL_ERROR",
                    "The isolated OCR process returned an invalid document."
                  )
            )
          );
        }
        return;
      }
      finishAfterCleanup(() =>
        reject(
          new OcrWorkerProcessError(
            "OCR_RUNTIME_PROTOCOL_ERROR",
            "The isolated OCR process returned an unsupported message."
          )
        )
      );
    });

    armDeadline();
    child.send(request, (error) => {
      if (error === null) return;
      finishAfterCleanup(() =>
        reject(
          new OcrWorkerProcessError(
            "OCR_RUNTIME_PROCESS_FAILED",
            "The OCR request could not be delivered to the isolated process."
          )
        )
      );
    });
  });
}
