import { createHash } from "node:crypto";

import { inspectImage, type ImageSafetyOptions } from "../../core/index.js";
import {
  mapOcrBoundsToSource,
  OcrImageError,
  prepareOcrImage,
  type OcrSourceRect
} from "./image.js";
import { matchOcrText } from "./matching.js";
import { inspectOcrRuntime, recognizeOcrImage } from "./runtime.js";
import type { OcrMatchOptions } from "./types.js";

export interface LocateTextArguments extends ImageSafetyOptions, Partial<OcrMatchOptions> {
  inputPath: string;
  query: string;
  languages?: ("eng" | "chi_sim")[];
  region?: OcrSourceRect;
  scale?: number;
  preprocess?: "none" | "invert";
  expectedInputSha256?: string;
  /** Trusted startup/library setting. Never expose an execution directory as an MCP tool input. */
  runtimeDirectory?: string;
  timeoutMs?: number;
}

/** Locate text only. Candidate selection and annotation remain explicit caller operations. */
export async function locateText(options: LocateTextArguments) {
  const matchingOptions: OcrMatchOptions = {
    mode: options.mode ?? "exact",
    caseSensitive: options.caseSensitive ?? false,
    minimumConfidence: options.minimumConfidence ?? 80,
    maxCandidates: options.maxCandidates ?? 100
  };
  // Validate query/options before opening a screenshot or starting the optional engine.
  matchOcrText({ engineVersion: "validation", lines: [] }, options.query, matchingOptions);
  const image = await prepareOcrImage(options);
  const runtimeOptions =
    options.runtimeDirectory === undefined ? {} : { runtimeDirectory: options.runtimeDirectory };
  const document = await recognizeOcrImage(image.png, {
    ...runtimeOptions,
    ...(options.languages === undefined ? {} : { languages: options.languages }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  const matches = matchOcrText(document, options.query, matchingOptions);
  const runtime = await inspectOcrRuntime(runtimeOptions);
  if (!runtime.ready) {
    throw new OcrImageError("OCR_RESULT_INVALID", "The OCR runtime changed during recognition.");
  }
  const current = await inspectImage(options.inputPath, options);
  if (current.sha256 !== image.inputSha256) {
    throw new OcrImageError(
      "OCR_INPUT_CHANGED",
      "The screenshot changed during OCR; locate text again."
    );
  }
  const candidates = matches.candidates.map(({ bbox, id, evidence, ...candidate }) => ({
    ...candidate,
    id: `ocr-${createHash("sha256").update(`${image.inputSha256}|${image.processedSha256}|${id}`).digest("hex").slice(0, 24)}`,
    rect: mapOcrBoundsToSource(bbox, image.transform),
    evidence: { ...evidence, processedBounds: bbox }
  }));
  return {
    version: "1.0" as const,
    operation: "locate-text" as const,
    status: matches.status,
    requiresConfirmation: matches.requiresConfirmation,
    confirmationReasons: matches.confirmationReasons,
    query: options.query,
    normalizedQuery: matches.normalizedQuery,
    matching: matchingOptions,
    candidates,
    totalCandidates: matches.totalCandidates,
    truncated: matches.truncated,
    source: {
      inputSha256: image.inputSha256,
      dimensions: image.originalDimensions,
      processedSha256: image.processedSha256,
      transform: image.transform
    },
    engine: {
      name: "tesseract.js" as const,
      version: runtime.tesseractVersion,
      internalVersion: document.engineVersion,
      runtimeVersion: runtime.runtimeVersion,
      languages: options.languages ?? ["eng", "chi_sim"],
      models: runtime.models.filter((model) =>
        (options.languages ?? ["eng", "chi_sim"]).includes(model.language)
      )
    },
    limitations: [
      "Candidates describe recognized text, not complete control boundaries.",
      "Confidence is an engine score, not a calibrated probability. Inspect uncertain or ambiguous matches.",
      "No match does not prove that the requested text is absent from the screenshot."
    ]
  };
}

export { installOcrRuntime, inspectOcrRuntime, OcrRuntimeError } from "./runtime.js";
export { OcrImageError } from "./image.js";
