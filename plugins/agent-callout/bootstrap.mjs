#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const sharpMarker = path.join(pluginRoot, "node_modules", "sharp", "package.json");
const serverEntry = path.join(pluginRoot, "dist", "mcp.js");

function npmCliCandidates() {
  const executableDirectory = path.dirname(process.execPath);
  return [
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`runtime dependency installation exited with code ${code ?? "unknown"}`));
    });
  });
}

async function ensureRuntimeDependencies() {
  if (existsSync(sharpMarker)) return;

  process.stderr.write("AgentCallout: installing pinned local image runtime on first use...\n");
  const npmCli = npmCliCandidates().find((candidate) => existsSync(candidate));
  const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];

  if (npmCli) {
    await run(process.execPath, [npmCli, ...npmArgs]);
  } else if (process.platform === "win32") {
    await run("cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmArgs]);
  } else {
    await run("npm", npmArgs);
  }

  if (!existsSync(sharpMarker)) {
    throw new Error("Sharp runtime was not installed from the pinned lockfile.");
  }
}

try {
  if (!existsSync(serverEntry)) {
    throw new Error("AgentCallout MCP bundle is missing. Reinstall or update the plugin.");
  }
  await ensureRuntimeDependencies();
  await import(pathToFileURL(serverEntry).href);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentCallout failed to start: ${message}\n`);
  process.exitCode = 1;
}
