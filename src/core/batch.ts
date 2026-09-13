// Batch annotate orchestration (roadmap v0.6.0): run annotateImage across a
// list of (image, spec) pairs with deterministic cross-image numbering,
// fail-fast or continue-on-error execution, and per-item isolation.
import path from "node:path";

import { annotateImage, type ImageSafetyOptions } from "./index.js";

export const MAX_BATCH_ITEMS = 32;

export interface BatchItemInput {
  /** Image path for this item. */
  input: string;
  /** Full AnnotationSpec (inline object) for this item. */
  spec?: unknown;
  /** Or a spec file path (relative to the batch manifest directory). */
  specPath?: string;
  /** Optional explicit output PNG path. Defaults beside the input image. */
  output?: string;
}

export interface AnnotateBatchArguments extends ImageSafetyOptions {
  items: BatchItemInput[];
  /** "continuous" renumbers all numbered-callouts 1..N across images. */
  numbering?: "continuous" | "per-image" | undefined;
  /** Continue past failed items instead of fail-fast. Default false. */
  continueOnError?: boolean | undefined;
  /** Base directory for item specPath references. Defaults to process.cwd(). */
  manifestDirectory?: string | undefined;
}

export interface AnnotateBatchItemResult {
  index: number;
  status: "ok";
  inputPath: string;
  outputPath: string;
  sidecarPath: string;
  annotationCount: number;
  warnings: string[];
}

export interface AnnotateBatchFailure {
  index: number;
  inputPath: string | undefined;
  message: string;
}

export interface AnnotateBatchResult {
  operation: "annotate-batch";
  numbering: "continuous" | "per-image";
  total: number;
  okCount: number;
  failureCount: number;
  results: AnnotateBatchItemResult[];
  failures: AnnotateBatchFailure[];
}

interface NumberedSpec {
  annotations?: Array<Record<string, unknown>>;
}

/** Continuous numbering renumbers every numbered-callout in traversal order. */
export function assignContinuousNumbers(items: BatchItemInput[]): void {
  let next = 1;
  for (const item of items) {
    const spec = item.spec as NumberedSpec | undefined;
    if (spec === undefined || !Array.isArray(spec.annotations)) continue;
    for (const annotation of spec.annotations) {
      if (
        typeof annotation === "object" &&
        annotation !== null &&
        (annotation as { type?: unknown }).type === "numbered-callout"
      ) {
        (annotation as { number?: number }).number = next;
        next += 1;
      }
    }
  }
}

async function resolveItemSpec(item: BatchItemInput, manifestDirectory: string): Promise<void> {
  if (item.spec !== undefined && item.specPath !== undefined) {
    throw new Error(`Batch item ${item.input}: provide exactly one of spec or specPath.`);
  }
  if (item.spec === undefined && item.specPath !== undefined) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.resolve(manifestDirectory, item.specPath), "utf8");
    item.spec = JSON.parse(raw);
  }
}

export async function annotateBatch(
  arguments_: AnnotateBatchArguments
): Promise<AnnotateBatchResult> {
  const items = arguments_.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Batch requires a non-empty items array.");
  }
  if (items.length > MAX_BATCH_ITEMS) {
    throw new Error(`Batch supports at most ${MAX_BATCH_ITEMS} items; got ${items.length}.`);
  }
  for (const item of items) {
    if (typeof item.input !== "string" || item.input.trim() === "") {
      throw new Error("Every batch item requires an input image path.");
    }
  }

  const numbering = arguments_.numbering ?? "per-image";
  const manifestDirectory = arguments_.manifestDirectory ?? process.cwd();

  // Load specPath references before numbering so loaded specs participate.
  for (const item of items) {
    await resolveItemSpec(item, manifestDirectory);
  }
  if (numbering === "continuous") {
    assignContinuousNumbers(items);
  }

  const results: AnnotateBatchItemResult[] = [];
  const failures: AnnotateBatchFailure[] = [];

  for (const [index, item] of items.entries()) {
    try {
      const generated = await annotateImage({
        inputPath: item.input,
        outputPath: item.output,
        spec: item.spec,
        allowedRoots: arguments_.allowedRoots
      });
      results.push({
        index,
        status: "ok",
        inputPath: item.input,
        outputPath: generated.outputPath,
        sidecarPath: generated.sidecarPath,
        annotationCount: generated.annotationCount,
        warnings: generated.warnings ?? []
      });
    } catch (error) {
      const failure = {
        index,
        inputPath: item.input,
        message: error instanceof Error ? error.message : String(error)
      };
      if (!(arguments_.continueOnError ?? false)) {
        failure.message = `Batch aborted at item ${index} (fail-fast): ${failure.message}`;
        throw Object.assign(new Error(failure.message), {
          batchPartial: { results, failures: [failure] }
        });
      }
      failures.push(failure);
    }
  }

  return {
    operation: "annotate-batch",
    numbering,
    total: items.length,
    okCount: results.length,
    failureCount: failures.length,
    results,
    failures
  };
}
