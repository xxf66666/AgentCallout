import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { annotationSpecSchema, type AnnotationSpec } from "../spec/index.js";

export const EDITOR_PROJECT_VERSION = "1.0" as const;

export interface RedactionProject {
  version: typeof EDITOR_PROJECT_VERSION;
  source: {
    sha256: string;
  };
  annotationSpec: AnnotationSpec;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 hash.");

const projectSchema = z
  .object({
    version: z.literal(EDITOR_PROJECT_VERSION),
    source: z.object({ sha256: sha256Schema }).strict(),
    annotationSpec: annotationSpecSchema
  })
  .strict();

function requireOnlyRedactions(project: RedactionProject): RedactionProject {
  const unsupported = project.annotationSpec.annotations.find(
    (annotation) => annotation.type !== "redact"
  );
  if (unsupported) {
    throw new Error(
      `The redaction editor accepts only redact annotations; ${JSON.stringify(unsupported.id)} is ${unsupported.type}.`
    );
  }
  return project;
}

export function parseRedactionProject(value: unknown): RedactionProject {
  return requireOnlyRedactions(projectSchema.parse(value));
}

export function createRedactionProject(sourceSha256: string): RedactionProject {
  return parseRedactionProject({
    version: EDITOR_PROJECT_VERSION,
    source: { sha256: sourceSha256 },
    annotationSpec: {
      version: "1.0",
      coordinateSpace: "pixel",
      annotations: []
    }
  });
}

/** Atomically replace a project file so a crash cannot leave partial JSON behind. */
export async function writeRedactionProject(
  filePath: string,
  project: RedactionProject
): Promise<void> {
  const normalized = parseRedactionProject(project);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}
