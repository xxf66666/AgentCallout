import { spawn } from "node:child_process";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  ensureRuntimeDependencies,
  probeSharpRuntime,
  readPinnedSharpVersion
} from "../plugins/agent-callout/bootstrap.mjs";

const repositoryRoot = path.resolve(".");
const bootstrapUrl = pathToFileURL(
  path.join(repositoryRoot, "plugins", "agent-callout", "bootstrap.mjs")
).href;
const temporaryDirectories = [];
const LOCK_FILENAME = ".agent-callout-runtime-install.lock";

function candidateLockPath(root, token) {
  return path.join(root, `${LOCK_FILENAME}.${token}.candidate`);
}

async function makePluginFixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `agent-callout-bootstrap-${name}-`));
  temporaryDirectories.push(root);
  const packageJson = {
    name: "agent-callout-bootstrap-fixture",
    version: "0.0.0",
    private: true,
    dependencies: { sharp: "0.35.4" }
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: { sharp: "0.35.4" }
      },
      "node_modules/sharp": { version: "0.35.4" }
    }
  };
  await Promise.all([
    writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`),
    writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`)
  ]);
  return root;
}

async function simulatedProbe(root) {
  try {
    const health = JSON.parse(await readFile(path.join(root, "runtime-health.json"), "utf8"));
    return health.healthy === true && health.version === "0.35.4"
      ? { ok: true, version: "0.35.4" }
      : { ok: false, reason: "native-self-test-failed" };
  } catch {
    return { ok: false, reason: "missing-or-invalid-marker" };
  }
}

function simulatedInstaller(root, delayMs = 0) {
  return async () => {
    await appendFile(path.join(root, "install.log"), `${process.pid}\n`, "utf8");
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await writeFile(
      path.join(root, "runtime-health.json"),
      `${JSON.stringify({ healthy: true, version: "0.35.4" })}\n`,
      "utf8"
    );
  };
}

async function installCount(root) {
  try {
    return (await readFile(path.join(root, "install.log"), "utf8")).split(/\r?\n/u).filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function runNode(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: repositoryRoot,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Claude plugin bootstrap", () => {
  test("pins and natively exercises the installed Sharp runtime", async () => {
    await expect(readPinnedSharpVersion(repositoryRoot)).resolves.toBe("0.35.4");
    await expect(
      probeSharpRuntime({ pluginRoot: repositoryRoot, expectedSharpVersion: "0.35.4" })
    ).resolves.toEqual({ ok: true, version: "0.35.4" });
    await expect(
      probeSharpRuntime({ pluginRoot: repositoryRoot, expectedSharpVersion: "0.35.3" })
    ).resolves.toEqual({ ok: false, reason: "version-mismatch" });
  });

  test("installs once and makes the second startup an idempotent no-op", async () => {
    const root = await makePluginFixture("idempotent");
    const options = {
      pluginRoot: root,
      probeRuntime: () => simulatedProbe(root),
      installRuntime: simulatedInstaller(root),
      lockPollMs: 10,
      lockTimeoutMs: 5_000
    };

    await expect(ensureRuntimeDependencies(options)).resolves.toMatchObject({ installed: true });
    await expect(ensureRuntimeDependencies(options)).resolves.toMatchObject({ installed: false });
    expect(await installCount(root)).toBe(1);
    await expect(
      stat(path.join(root, ".agent-callout-runtime-install.lock"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("repairs an existing marker whose native runtime cannot load", async () => {
    const root = await makePluginFixture("corrupt");
    const sharpDirectory = path.join(root, "node_modules", "sharp");
    await mkdir(sharpDirectory, { recursive: true });
    await writeFile(
      path.join(sharpDirectory, "package.json"),
      `${JSON.stringify({ name: "sharp", version: "0.35.4", main: "missing.cjs" })}\n`
    );
    await expect(
      probeSharpRuntime({ pluginRoot: root, expectedSharpVersion: "0.35.4" })
    ).resolves.toEqual({ ok: false, reason: "native-self-test-failed" });

    let repaired = false;
    await expect(
      ensureRuntimeDependencies({
        pluginRoot: root,
        probeRuntime: async () =>
          repaired
            ? { ok: true, version: "0.35.4" }
            : probeSharpRuntime({ pluginRoot: root, expectedSharpVersion: "0.35.4" }),
        installRuntime: async () => {
          repaired = true;
          await appendFile(path.join(root, "install.log"), "repair\n", "utf8");
        },
        lockPollMs: 10,
        lockTimeoutMs: 5_000
      })
    ).resolves.toMatchObject({ installed: true, repaired: true });
    expect(await installCount(root)).toBe(1);
  });

  test("allows only one installer across two first-start processes", async () => {
    const root = await makePluginFixture("concurrent");
    const childSource = `
      const { appendFile, readFile, writeFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const { ensureRuntimeDependencies } = await import(${JSON.stringify(bootstrapUrl)});
      const root = ${JSON.stringify(root)};
      const probeRuntime = async () => {
        try {
          const health = JSON.parse(await readFile(path.join(root, "runtime-health.json"), "utf8"));
          return health.healthy === true ? { ok: true, version: "0.35.4" } : { ok: false };
        } catch { return { ok: false, reason: "missing-or-invalid-marker" }; }
      };
      const installRuntime = async () => {
        await appendFile(path.join(root, "install.log"), process.pid + "\\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writeFile(path.join(root, "runtime-health.json"), '{"healthy":true,"version":"0.35.4"}\\n');
      };
      await ensureRuntimeDependencies({
        pluginRoot: root,
        probeRuntime,
        installRuntime,
        lockPollMs: 20,
        lockTimeoutMs: 10_000
      });
    `;

    const results = await Promise.all([runNode(childSource), runNode(childSource)]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results.every((result) => result.stdout === "")).toBe(true);
    expect(await installCount(root)).toBe(1);
    expect((await readdir(root)).filter((name) => name.includes(LOCK_FILENAME))).toEqual([]);
  }, 15_000);

  test("recovers a dead-owner published candidate without deleting an active lock", async () => {
    const deadRoot = await makePluginFixture("dead-lock");
    const deadLockPath = path.join(deadRoot, LOCK_FILENAME);
    const deadToken = "00000000-0000-4000-8000-000000000001";
    const deadCandidatePath = candidateLockPath(deadRoot, deadToken);
    await writeFile(
      deadCandidatePath,
      `${JSON.stringify({
        version: "1.0",
        token: deadToken,
        pid: 12345,
        createdAt: Date.now(),
        expectedSharpVersion: "0.35.4"
      })}\n`
    );
    await link(deadCandidatePath, deadLockPath);
    await expect(
      ensureRuntimeDependencies({
        pluginRoot: deadRoot,
        probeRuntime: () => simulatedProbe(deadRoot),
        installRuntime: simulatedInstaller(deadRoot),
        isProcessAlive: () => false,
        lockPollMs: 10,
        lockTimeoutMs: 5_000
      })
    ).resolves.toMatchObject({ installed: true });
    await expect(stat(deadCandidatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(deadLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    const activeRoot = await makePluginFixture("active-lock");
    const activeLockPath = path.join(activeRoot, LOCK_FILENAME);
    const activeLock = `${JSON.stringify({
      version: "1.0",
      token: "00000000-0000-4000-8000-000000000002",
      pid: process.pid,
      createdAt: Date.now(),
      expectedSharpVersion: "0.35.4"
    })}\n`;
    await writeFile(activeLockPath, activeLock);
    await expect(
      ensureRuntimeDependencies({
        pluginRoot: activeRoot,
        probeRuntime: () => simulatedProbe(activeRoot),
        installRuntime: simulatedInstaller(activeRoot),
        isProcessAlive: () => true,
        lockPollMs: 10,
        lockTimeoutMs: 50
      })
    ).rejects.toThrow(/Timed out waiting/u);
    expect(await readFile(activeLockPath, "utf8")).toBe(activeLock);
    expect(await installCount(activeRoot)).toBe(0);
  });

  test("ignores a live partial candidate and preserves an invalid canonical lock", async () => {
    const candidateRoot = await makePluginFixture("partial-candidate");
    const partialToken = "00000000-0000-4000-8000-000000000003";
    const partialCandidatePath = candidateLockPath(candidateRoot, partialToken);
    const partialHandle = await open(partialCandidatePath, "wx", 0o600);
    try {
      await partialHandle.writeFile("{", "utf8");
      await expect(
        ensureRuntimeDependencies({
          pluginRoot: candidateRoot,
          probeRuntime: () => simulatedProbe(candidateRoot),
          installRuntime: simulatedInstaller(candidateRoot),
          lockPollMs: 10,
          lockTimeoutMs: 5_000
        })
      ).resolves.toMatchObject({ installed: true });
      await expect(
        ensureRuntimeDependencies({
          pluginRoot: candidateRoot,
          probeRuntime: () => simulatedProbe(candidateRoot),
          installRuntime: simulatedInstaller(candidateRoot),
          lockPollMs: 10,
          lockTimeoutMs: 5_000
        })
      ).resolves.toMatchObject({ installed: false });
      expect(await installCount(candidateRoot)).toBe(1);
      expect(await readFile(partialCandidatePath, "utf8")).toBe("{");
      await expect(stat(path.join(candidateRoot, LOCK_FILENAME))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await partialHandle.close();
    }

    const malformedRoot = await makePluginFixture("malformed-lock");
    const malformedLockPath = path.join(malformedRoot, LOCK_FILENAME);
    await writeFile(malformedLockPath, "{");
    await expect(
      ensureRuntimeDependencies({
        pluginRoot: malformedRoot,
        probeRuntime: () => simulatedProbe(malformedRoot),
        installRuntime: simulatedInstaller(malformedRoot),
        lockPollMs: 10,
        lockTimeoutMs: 5_000
      })
    ).rejects.toThrow(/incomplete or invalid; manual recovery/u);
    expect(await readFile(malformedLockPath, "utf8")).toBe("{");
    expect(await installCount(malformedRoot)).toBe(0);
  });
});
