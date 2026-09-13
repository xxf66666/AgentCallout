// Lineage fork and revision diff (ADR-0012): explicit, recorded copies of
// whole revision lineages plus stable-ID diffs between any two sidecars.
// Sidecar bytes are never rewritten, so every hash and parent-chain check
// of the revision engine keeps working.
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { inspectAnnotationSidecar } from "../core/index.js";

export const FORK_RECORD_VERSION = "1.0";

export type ForkMode = "fork" | "working-copy";

export class LineageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LineageError";
    this.code = code;
  }
}

interface ForkFileRecord {
  path: string;
  role: string;
  sha256: string;
  sizeBytes: number;
}

interface ForkRecord {
  forkVersion: string;
  mode: ForkMode;
  forkedAt: string;
  source: { lineageId: string; sidecarSha256: string; baseStem: string };
  files: ForkFileRecord[];
}

function sha256File(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInsideRoots(candidate: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  return roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
}

// Canonicalize roots through symlinks (macOS /var -> /private/var) the same
// way the core module does, so allowed roots match realpath'd candidates.
async function canonicalRootsList(allowedRoots: readonly string[] | undefined): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of allowedRoots ?? []) {
    const absolute = path.resolve(root);
    resolved.push(await realpath(absolute).catch(() => absolute));
  }
  return resolved;
}

async function canonicalExistingPath(
  inputPath: string,
  allowedRoots: readonly string[] | undefined
): Promise<string> {
  const resolved = await realpath(path.resolve(inputPath));
  if (isInsideRoots(resolved, await canonicalRootsList(allowedRoots))) {
    return resolved;
  }
  throw new LineageError("LINEAGE_TARGET_INVALID", "Path is outside the allowed roots.");
}

async function readSidecarSnapshot(sidecarPath: string) {
  const bytes = await readFile(sidecarPath);
  const raw = JSON.parse(bytes.toString("utf8")) as {
    revision?: { lineageId: string; number: number } | undefined;
    paths: { inputs: string[]; output: string };
  };
  return {
    bytes,
    sha256: sha256File(bytes),
    lineageId: raw.revision?.lineageId ?? sha256File(bytes),
    revisionNumber: raw.revision?.number ?? 0,
    baseStem: path
      .basename(sidecarPath)
      .replace(/\.json$/u, "")
      .replace(/\.rev\d+$/u, ""),
    inputReference: raw.paths.inputs[0] ?? "",
    outputReference: raw.paths.output
  };
}

function collectLineageFiles(entries: string[], stem: string): { json: string[]; png: string[] } {
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.rev\\d+)?\\.(json|png)$`,
    "u"
  );
  const json: string[] = [];
  const png: string[] = [];
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match === null) continue;
    if (match[2] === "json") json.push(entry);
    else png.push(entry);
  }
  return { json, png };
}

export interface ForkLineageArguments {
  sidecarPath: string;
  targetDirectory: string;
  mode?: ForkMode | undefined;
  overwrite?: boolean | undefined;
  allowedRoots?: readonly string[] | undefined;
}

export interface ForkLineageResult {
  forkDirectory: string;
  mode: ForkMode;
  copiedFiles: number;
  sourceLineageId: string;
  sourceRevisionNumber: number;
}

export async function forkLineage(arguments_: ForkLineageArguments): Promise<ForkLineageResult> {
  const sidecarPath = await canonicalExistingPath(arguments_.sidecarPath, arguments_.allowedRoots);
  await inspectAnnotationSidecar({
    sidecarPath,
    allowedRoots: arguments_.allowedRoots
  });
  const snapshot = await readSidecarSnapshot(sidecarPath);
  const sourceDirectory = path.dirname(sidecarPath);
  const mode: ForkMode = arguments_.mode ?? "fork";
  const target = path.resolve(arguments_.targetDirectory);
  const targetParent = path.dirname(target);

  const targetStats = await stat(targetParent).catch(() => undefined);
  if (targetStats === undefined || !targetStats.isDirectory()) {
    throw new LineageError(
      "LINEAGE_TARGET_INVALID",
      "The fork target parent directory must exist."
    );
  }
  if (
    await realpath(targetParent)
      .then(() => true)
      .catch(() => false)
  ) {
    // realpath of an existing directory; containment is checked next.
  }
  const resolvedParent = await realpath(targetParent);
  if (!isInsideRoots(resolvedParent, await canonicalRootsList(arguments_.allowedRoots))) {
    throw new LineageError("LINEAGE_TARGET_INVALID", "Fork target is outside the allowed roots.");
  }

  const entries = await readdir(sourceDirectory);
  const lineage = collectLineageFiles(entries, snapshot.baseStem);
  const copyPlan: { source: string; basename: string; role: string }[] = [];
  for (const name of [...lineage.json, ...lineage.png].sort()) {
    copyPlan.push({
      source: path.join(sourceDirectory, name),
      basename: name,
      role: name.endsWith(".json") ? "sidecar" : "output"
    });
  }
  if (snapshot.inputReference !== "") {
    const originalPath = path.resolve(sourceDirectory, snapshot.inputReference);
    await stat(originalPath).catch(() => {
      throw new LineageError(
        "LINEAGE_SOURCE_INVALID",
        "The original input image is missing; the lineage cannot be forked."
      );
    });
    copyPlan.push({
      source: originalPath,
      basename: path.basename(originalPath),
      role: "original"
    });
  }

  if (
    await stat(target)
      .then(() => true)
      .catch(() => false)
  ) {
    if (!(arguments_.overwrite ?? false)) {
      throw new LineageError(
        "LINEAGE_FORK_TARGET_EXISTS",
        "The fork target already exists; pass overwrite to replace it."
      );
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  const files: ForkFileRecord[] = [];
  try {
    for (const item of copyPlan) {
      const bytes = await readFile(item.source);
      await copyFile(item.source, path.join(target, item.basename));
      files.push({
        path: item.basename,
        role: item.role,
        sha256: sha256File(bytes),
        sizeBytes: bytes.byteLength
      });
    }
    const record: ForkRecord = {
      forkVersion: FORK_RECORD_VERSION,
      mode,
      forkedAt: new Date().toISOString(),
      source: {
        lineageId: snapshot.lineageId,
        sidecarSha256: snapshot.sha256,
        baseStem: snapshot.baseStem
      },
      files
    };
    await writeFile(path.join(target, "fork.json"), JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return {
    forkDirectory: target,
    mode,
    copiedFiles: files.length,
    sourceLineageId: snapshot.lineageId,
    sourceRevisionNumber: snapshot.revisionNumber
  };
}

export interface DiffRevisionsArguments {
  sidecarPathA: string;
  sidecarPathB: string;
  allowedRoots?: readonly string[] | undefined;
}

export interface DiffRevisionChange {
  id: string;
  changes: { field: string; from: string; to: string }[];
}

export interface DiffRevisionsResult {
  operation: "diff-revisions";
  lineageRelation: "same-lineage" | "forked" | "unrelated";
  sidecarA: { path: string; lineageId: string; revisionNumber: number };
  sidecarB: { path: string; lineageId: string; revisionNumber: number };
  added: string[];
  removed: string[];
  changed: DiffRevisionChange[];
}

interface ResolvedAnnotationRecord {
  id: string;
  [key: string]: unknown;
}

function readResolvedAnnotations(raw: unknown): Map<string, ResolvedAnnotationRecord> {
  const map = new Map<string, ResolvedAnnotationRecord>();
  const resolved = (raw as { resolvedAnnotations?: unknown }).resolvedAnnotations;
  if (!Array.isArray(resolved)) return map;
  for (const entry of resolved) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    map.set(id, entry as ResolvedAnnotationRecord);
  }
  return map;
}

function describeDiff(field: string, from: unknown, to: unknown) {
  const render = (value: unknown) => {
    const text = JSON.stringify(value) ?? "undefined";
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  };
  return { field, from: render(from), to: render(to) };
}

export async function diffRevisions(
  arguments_: DiffRevisionsArguments
): Promise<DiffRevisionsResult> {
  const sidecarPathA = await canonicalExistingPath(
    arguments_.sidecarPathA,
    arguments_.allowedRoots
  );
  const sidecarPathB = await canonicalExistingPath(
    arguments_.sidecarPathB,
    arguments_.allowedRoots
  );
  await inspectAnnotationSidecar({
    sidecarPath: sidecarPathA,
    allowedRoots: arguments_.allowedRoots
  });
  await inspectAnnotationSidecar({
    sidecarPath: sidecarPathB,
    allowedRoots: arguments_.allowedRoots
  });

  const snapshotA = await readSidecarSnapshot(sidecarPathA);
  const snapshotB = await readSidecarSnapshot(sidecarPathB);
  const rawA: unknown = JSON.parse(snapshotA.bytes.toString("utf8"));
  const rawB: unknown = JSON.parse(snapshotB.bytes.toString("utf8"));
  const resolvedA = readResolvedAnnotations(rawA);
  const resolvedB = readResolvedAnnotations(rawB);

  let lineageRelation: DiffRevisionsResult["lineageRelation"];
  if (snapshotA.lineageId !== snapshotB.lineageId) {
    lineageRelation = "unrelated";
  } else {
    // Forks keep the copied lineage identity, so a shared lineageId means
    // same-lineage: a fork is detected through its fork.json record in a
    // different directory.
    const directoryA = path.dirname(sidecarPathA);
    const directoryB = path.dirname(sidecarPathB);
    let forked = false;
    if (directoryA !== directoryB) {
      for (const directory of [directoryA, directoryB]) {
        const recordRaw = await readFile(path.join(directory, "fork.json"), "utf8").catch(
          () => undefined
        );
        if (recordRaw === undefined) continue;
        try {
          const record = JSON.parse(recordRaw) as {
            mode?: string;
            source?: { lineageId?: string };
          };
          if (record?.source?.lineageId === snapshotA.lineageId && record.mode !== undefined) {
            forked = true;
            break;
          }
        } catch {
          // Malformed fork records leave the relation at same-lineage.
        }
      }
    }
    lineageRelation = forked ? "forked" : "same-lineage";
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: DiffRevisionChange[] = [];
  for (const [id, annotation] of resolvedA) {
    const counterpart = resolvedB.get(id);
    if (counterpart === undefined) {
      removed.push(id);
      continue;
    }
    const fields = new Set([...Object.keys(annotation), ...Object.keys(counterpart)]);
    const changes: { field: string; from: string; to: string }[] = [];
    for (const field of fields) {
      const before = (annotation as Record<string, unknown>)[field];
      const after = (counterpart as Record<string, unknown>)[field];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push(describeDiff(field, before, after));
      }
    }
    if (changes.length > 0) {
      changed.push({ id, changes });
    }
  }
  for (const id of resolvedB.keys()) {
    if (!resolvedA.has(id)) added.push(id);
  }

  return {
    operation: "diff-revisions",
    lineageRelation,
    sidecarA: {
      path: sidecarPathA,
      lineageId: snapshotA.lineageId,
      revisionNumber: snapshotA.revisionNumber
    },
    sidecarB: {
      path: sidecarPathB,
      lineageId: snapshotB.lineageId,
      revisionNumber: snapshotB.revisionNumber
    },
    added,
    removed,
    changed
  };
}
