import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
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
  }, 15_000);

  test("recovers dead-owner and old malformed locks without deleting an active lock", async () => {
    const deadRoot = await makePluginFixture("dead-lock");
    const deadLockPath = path.join(deadRoot, ".agent-callout-runtime-install.lock");
    await writeFile(
      deadLockPath,
      `${JSON.stringify({
        version: "1.0",
        token: "00000000-0000-4000-8000-000000000001",
        pid: 12345,
        createdAt: Date.now(),
        expectedSharpVersion: "0.35.4"
      })}\n`
    );
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

    const activeRoot = await makePluginFixture("active-lock");
    const activeLockPath = path.join(activeRoot, ".agent-callout-runtime-install.lock");
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

    const malformedRoot = await makePluginFixture("malformed-lock");
    const malformedLockPath = path.join(malformedRoot, ".agent-callout-runtime-install.lock");
    await writeFile(malformedLockPath, "{");
    const old = new Date(Date.now() - 60_000);
    await utimes(malformedLockPath, old, old);
    await expect(
      ensureRuntimeDependencies({
        pluginRoot: malformedRoot,
        probeRuntime: () => simulatedProbe(malformedRoot),
        installRuntime: simulatedInstaller(malformedRoot),
        malformedLockStaleMs: 1_000,
        lockPollMs: 10,
        lockTimeoutMs: 5_000
      })
    ).resolves.toMatchObject({ installed: true });
    expect(await installCount(malformedRoot)).toBe(1);
  });
});
