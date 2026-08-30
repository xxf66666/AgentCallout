import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function outputDirectory(argv) {
  const index = argv.indexOf("--outdir");
  if (index === -1) {
    return resolve(repositoryRoot, "dist");
  }
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "") {
    throw new Error("--outdir requires a directory path");
  }
  return resolve(repositoryRoot, value);
}

const buildArguments = process.argv.slice(2);
const customOutdir = buildArguments.includes("--outdir");
const outdir = outputDirectory(buildArguments);
await mkdir(outdir, { recursive: true });
await Promise.all(
  ["cli.js.map", "mcp.js.map", "index.js.map"].map((file) =>
    rm(join(outdir, file), { force: true })
  )
);

const shared = {
  absWorkingDir: repositoryRoot,
  bundle: true,
  charset: "utf8",
  external: ["sharp"],
  format: "esm",
  keepNames: true,
  legalComments: "eof",
  logLevel: "info",
  metafile: false,
  outdir,
  platform: "node",
  sourcemap: false,
  target: "node20"
};

await build({
  ...shared,
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __agentCalloutCreateRequire } from "node:module";',
      "const require = __agentCalloutCreateRequire(import.meta.url);"
    ].join("\n")
  },
  entryPoints: {
    cli: "src/cli/main.ts",
    mcp: "src/mcp/main.ts"
  }
});

await build({
  ...shared,
  entryPoints: { index: "src/index.ts" }
});

if (!customOutdir) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(scriptDirectory, "sync-plugin.mjs")], {
      cwd: repositoryRoot,
      stdio: "inherit"
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`plugin sync failed (${signal ?? `exit ${String(code)}`})`));
      }
    });
  });
}
