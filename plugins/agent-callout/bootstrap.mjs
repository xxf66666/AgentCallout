#!/usr/bin/env node

import { existsSync } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultPluginRoot = path.dirname(modulePath);
const LOCK_FILENAME = ".agent-callout-runtime-install.lock";
const LOCK_VERSION = "1.0";
const DEFAULT_LOCK_TIMEOUT_MS = 180_000;
const DEFAULT_LOCK_POLL_MS = 200;
const DEFAULT_MALFORMED_LOCK_STALE_MS = 30_000;
const MAX_LOCK_BYTES = 64 * 1024;

function isFileSystemError(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readJson(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${description} is missing or invalid.`, { cause: error });
  }
}

export async function readPinnedSharpVersion(pluginRoot = defaultPluginRoot) {
  const packageJson = await readJson(path.join(pluginRoot, "package.json"), "Plugin package.json");
  const packageLock = await readJson(
    path.join(pluginRoot, "package-lock.json"),
    "Plugin package-lock.json"
  );
  const expectedVersion = packageJson.dependencies?.sharp;
  if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
    throw new Error("Plugin package.json must pin Sharp to an exact semantic version.");
  }
  if (
    packageLock.lockfileVersion !== 3 ||
    packageLock.packages?.[""]?.dependencies?.sharp !== expectedVersion ||
    packageLock.packages?.["node_modules/sharp"]?.version !== expectedVersion
  ) {
    throw new Error("Plugin package-lock.json does not pin the declared Sharp version.");
  }
  return expectedVersion;
}

function runCaptured(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

export async function probeSharpRuntime({
  pluginRoot = defaultPluginRoot,
  expectedSharpVersion
} = {}) {
  const expectedVersion = expectedSharpVersion ?? (await readPinnedSharpVersion(pluginRoot));
  const sharpDirectory = path.join(pluginRoot, "node_modules", "sharp");
  const markerPath = path.join(sharpDirectory, "package.json");
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return { ok: false, reason: "missing-or-invalid-marker" };
  }
  if (marker.version !== expectedVersion) {
    return { ok: false, reason: "version-mismatch" };
  }

  const probeSource = `
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const sharpDirectory = process.env.AGENT_CALLOUT_SHARP_DIRECTORY;
    const expected = process.env.AGENT_CALLOUT_EXPECTED_SHARP_VERSION;
    const require = createRequire(pathToFileURL(path.join(sharpDirectory, "bootstrap-probe.cjs")));
    const sharp = require("./");
    if (sharp.versions?.sharp !== expected || typeof sharp.versions?.vips !== "string") {
      throw new Error("Sharp version metadata does not match the pinned runtime.");
    }
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } }
    }).png().toBuffer();
    const metadata = await sharp(bytes).metadata();
    if (metadata.format !== "png" || metadata.width !== 1 || metadata.height !== 1) {
      throw new Error("Sharp native PNG self-test failed.");
    }
  `;
  const probe = await runCaptured(
    process.execPath,
    ["--input-type=module", "--eval", probeSource],
    {
      cwd: pluginRoot,
      env: {
        ...process.env,
        AGENT_CALLOUT_SHARP_DIRECTORY: sharpDirectory,
        AGENT_CALLOUT_EXPECTED_SHARP_VERSION: expectedVersion
      }
    }
  );
  return probe.code === 0
    ? { ok: true, version: expectedVersion }
    : { ok: false, reason: "native-self-test-failed" };
}

function npmCliCandidates() {
  const executableDirectory = path.dirname(process.execPath);
  return [
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function runInstallerCommand(command, args, pluginRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: pluginRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`runtime dependency installation exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function installPinnedRuntime(pluginRoot = defaultPluginRoot) {
  await readPinnedSharpVersion(pluginRoot);
  const npmCli = npmCliCandidates().find((candidate) => existsSync(candidate));
  const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];

  if (npmCli) {
    await runInstallerCommand(process.execPath, [npmCli, ...npmArgs], pluginRoot);
  } else if (process.platform === "win32") {
    await runInstallerCommand("cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmArgs], pluginRoot);
  } else {
    await runInstallerCommand("npm", npmArgs, pluginRoot);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeLockIfOwned(lockPath, identity, token) {
  let current;
  try {
    current = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  if (!current.isFile() || !sameIdentity(current, identity)) {
    throw new Error("Runtime installation lock ownership changed; manual recovery is required.");
  }
  if (token !== undefined) {
    let record;
    try {
      record = JSON.parse(await readFile(lockPath, "utf8"));
    } catch (error) {
      throw new Error("Runtime installation lock became unreadable; manual recovery is required.", {
        cause: error
      });
    }
    if (record.token !== token) {
      throw new Error("Runtime installation lock token changed; manual recovery is required.");
    }
  }
  let verified;
  try {
    verified = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  if (!verified.isFile() || !sameIdentity(verified, identity)) {
    throw new Error(
      "Runtime installation lock changed before cleanup; manual recovery is required."
    );
  }
  await rm(lockPath);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

async function readExistingLock(lockPath, malformedLockStaleMs, isProcessAlive) {
  let before;
  try {
    before = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { state: "missing" };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_LOCK_BYTES)) {
    throw new Error("Runtime installation lock is not a valid owned file.");
  }

  let bytes;
  try {
    bytes = await readFile(lockPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { state: "missing" };
    throw error;
  }
  let after;
  try {
    after = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { state: "missing" };
    throw error;
  }
  if (
    !sameIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    return { state: "active" };
  }

  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    const ageMs = Date.now() - Number(after.mtimeNs / 1_000_000n);
    if (ageMs < malformedLockStaleMs) return { state: "active" };
    await removeLockIfOwned(lockPath, after);
    return { state: "recovered" };
  }
  const exactKeys = ["version", "token", "pid", "createdAt", "expectedSharpVersion"];
  if (
    typeof record !== "object" ||
    record === null ||
    Array.isArray(record) ||
    Object.keys(record).sort().join("\0") !== exactKeys.sort().join("\0") ||
    record.version !== LOCK_VERSION ||
    typeof record.token !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !Number.isFinite(record.createdAt) ||
    typeof record.expectedSharpVersion !== "string"
  ) {
    throw new Error("Runtime installation lock is invalid; manual recovery is required.");
  }
  if (isProcessAlive(record.pid)) return { state: "active" };
  await removeLockIfOwned(lockPath, after, record.token);
  return { state: "recovered" };
}

async function tryAcquireLock(lockPath, expectedSharpVersion) {
  let handle;
  let identity;
  const token = randomUUID();
  try {
    handle = await open(lockPath, "wx", 0o600);
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(
      `${JSON.stringify({
        version: LOCK_VERSION,
        token,
        pid: process.pid,
        createdAt: Date.now(),
        expectedSharpVersion
      })}\n`,
      "utf8"
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { identity, token };
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original acquisition error.
    }
    if (isFileSystemError(error, "EEXIST")) return undefined;
    if (identity !== undefined) {
      try {
        await removeLockIfOwned(lockPath, identity, token);
      } catch {
        // The caller receives the acquisition error; ownership failures remain on disk for diagnosis.
      }
    }
    throw error;
  }
}

export async function ensureRuntimeDependencies(options = {}) {
  const pluginRoot = options.pluginRoot ?? defaultPluginRoot;
  const expectedSharpVersion =
    options.expectedSharpVersion ?? (await readPinnedSharpVersion(pluginRoot));
  const probeRuntime =
    options.probeRuntime ?? (() => probeSharpRuntime({ pluginRoot, expectedSharpVersion }));
  const installRuntime = options.installRuntime ?? (() => installPinnedRuntime(pluginRoot));
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const malformedLockStaleMs = options.malformedLockStaleMs ?? DEFAULT_MALFORMED_LOCK_STALE_MS;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const lockPath = path.join(pluginRoot, LOCK_FILENAME);
  const deadline = Date.now() + lockTimeoutMs;

  for (;;) {
    const probe = await probeRuntime();
    if (probe.ok === true)
      return { installed: false, repaired: false, version: expectedSharpVersion };

    const ownership = await tryAcquireLock(lockPath, expectedSharpVersion);
    if (ownership !== undefined) {
      let installed = false;
      try {
        const afterLockProbe = await probeRuntime();
        if (afterLockProbe.ok !== true) {
          process.stderr.write(
            "AgentCallout: installing or repairing the pinned local image runtime...\n"
          );
          await installRuntime();
          installed = true;
          const repairedProbe = await probeRuntime();
          if (repairedProbe.ok !== true) {
            throw new Error("Sharp runtime failed its pinned version and native PNG self-test.");
          }
        }
      } finally {
        await removeLockIfOwned(lockPath, ownership.identity, ownership.token);
      }
      return {
        installed,
        repaired: installed && probe.reason !== "missing-or-invalid-marker",
        version: expectedSharpVersion
      };
    }

    const lock = await readExistingLock(lockPath, malformedLockStaleMs, isProcessAlive);
    if (lock.state === "missing" || lock.state === "recovered") continue;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for another AgentCallout runtime installation.");
    }
    await delay(lockPollMs);
  }
}

export async function runBootstrap(options = {}) {
  const pluginRoot = options.pluginRoot ?? defaultPluginRoot;
  const serverEntry = options.serverEntry ?? path.join(pluginRoot, "dist", "mcp.js");
  if (!existsSync(serverEntry)) {
    throw new Error("AgentCallout MCP bundle is missing. Reinstall or update the plugin.");
  }
  await ensureRuntimeDependencies({ ...options, pluginRoot });
  await import(pathToFileURL(serverEntry).href);
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  const left = path.resolve(entry);
  const right = path.resolve(modulePath);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

if (isDirectExecution()) {
  try {
    await runBootstrap();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentCallout failed to start: ${message}\n`);
    process.exitCode = 1;
  }
}
