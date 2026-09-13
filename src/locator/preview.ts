// Candidate preview rendering (roadmap v0.6.1): draw numbered outline boxes
// for OCR/DOM locate candidates onto the source image. The output is a
// temporary confirmation artifact: no sidecar, not part of the revision
// chain, and never an annotation by itself.
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { type ImageSafetyOptions } from "../core/index.js";

async function canonicalInputPathForPreview(
  inputPath: string,
  allowedRoots: readonly string[] | undefined
): Promise<string> {
  const resolved = await realpath(path.resolve(inputPath));
  const roots = (allowedRoots ?? []).map((root) => path.resolve(root));
  if (roots.length === 0) return resolved;
  const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) {
    throw new Error("Preview input path is outside the allowed roots.");
  }
  return resolved;
}

export const MAX_PREVIEW_CANDIDATES = 100;

export interface CandidatePreviewInput {
  rect: { x: number; y: number; width: number; height: number };
  /** Optional label shown under the index badge (truncated). */
  label?: string | undefined;
}

export interface RenderCandidatePreviewArguments extends ImageSafetyOptions {
  inputPath: string;
  candidates: CandidatePreviewInput[];
  outputPath?: string | undefined;
}

export interface CandidatePreviewResult {
  operation: "candidate-preview";
  outputPath: string;
  candidateCount: number;
  width: number;
  height: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export async function renderCandidatePreview(
  arguments_: RenderCandidatePreviewArguments
): Promise<CandidatePreviewResult> {
  if (arguments_.candidates.length === 0) {
    throw new Error("Candidate preview requires at least one candidate.");
  }
  if (arguments_.candidates.length > MAX_PREVIEW_CANDIDATES) {
    throw new Error(
      `Candidate preview supports at most ${MAX_PREVIEW_CANDIDATES} candidates; got ${arguments_.candidates.length}.`
    );
  }
  const inputPath = await canonicalInputPathForPreview(
    arguments_.inputPath,
    arguments_.allowedRoots
  );
  const imageBytes = await readFile(inputPath);
  const metadata = await sharp(imageBytes).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error("Candidate preview input must have readable dimensions.");
  }

  const boxes: string[] = [];
  for (const [index, candidate] of arguments_.candidates.entries()) {
    const number_ = index + 1;
    const x = Math.max(0, Math.min(width - 1, Math.round(candidate.rect.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(candidate.rect.y)));
    const boxWidth = Math.max(2, Math.min(width - x, Math.round(candidate.rect.width)));
    const boxHeight = Math.max(2, Math.min(height - y, Math.round(candidate.rect.height)));
    boxes.push(
      `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" fill="none" stroke="#FF3B30" stroke-width="3"/>` +
        `<rect x="${x}" y="${Math.max(0, y - 26)}" width="26" height="26" fill="#FF3B30"/>` +
        `<text x="${x + 13}" y="${Math.max(18, y - 7)}" font-family="sans-serif" font-size="18" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${number_}</text>`
    );
    const label = candidate.label === undefined ? "" : escapeXml(candidate.label.slice(0, 60));
    if (label !== "") {
      boxes.push(
        `<text x="${x}" y="${Math.min(height - 4, y + boxHeight + 20)}" font-family="sans-serif" font-size="15" fill="#FF3B30" stroke="#FFFFFF" stroke-width="0.5">${number_}. ${label}</text>`
      );
    }
  }

  const overlay = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes.join("")}</svg>`
  );
  const output = await sharp(imageBytes)
    .composite([{ input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const outputPath =
    arguments_.outputPath ??
    path.join(
      path.dirname(inputPath),
      `${path.basename(inputPath, path.extname(inputPath))}.candidates.png`
    );
  await writeFile(outputPath, output);
  return {
    operation: "candidate-preview",
    outputPath,
    candidateCount: arguments_.candidates.length,
    width,
    height
  };
}
