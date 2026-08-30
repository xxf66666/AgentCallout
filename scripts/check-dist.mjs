import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const committedDist = join(repositoryRoot, "dist");

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

async function runBuild(outdir) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [join(scriptDirectory, "build.mjs"), "--outdir", outdir],
      {
        cwd: repositoryRoot,
        stdio: "inherit"
      }
    );
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`temporary build failed (${signal ?? `exit ${String(code)}`})`));
      }
    });
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-callout-check-dist-"));
const temporaryDist = join(temporaryRoot, "dist");

try {
  await runBuild(temporaryDist);
  const [expectedFiles, actualFiles] = await Promise.all([
    listFiles(temporaryDist),
    listFiles(committedDist)
  ]);

  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `dist file list differs\nexpected: ${expectedFiles.join(", ")}\nactual:   ${actualFiles.join(", ")}`
    );
  }

  const mismatches = [];
  for (const file of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(join(temporaryDist, file)),
      readFile(join(committedDist, file))
    ]);
    if (!expected.equals(actual)) {
      mismatches.push(file);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`dist contains stale generated files: ${mismatches.join(", ")}`);
  }

  process.stdout.write(`dist is reproducible (${expectedFiles.length} files compared).\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check-dist failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
