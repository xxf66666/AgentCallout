// Optional browser DOM locator runtime (ADR-0011): pinned playwright-core
// plus the user's installed Chrome, executed in a controlled subprocess.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOM_RUNTIME_VERSION = "v1";

const RUNTIME_ASSETS = ["package.json", "package-lock.json", "locate-worker.mjs"];

export type DomLocatorKind = "selector" | "text" | "accessible";

export interface DomLocator {
  kind: DomLocatorKind;
  value: string;
  exact?: boolean | undefined;
  role?: string | undefined;
}

export interface DomLocateArguments {
  url: string;
  locator: DomLocator;
  /** Full-page screenshot is written here; candidate rects bind to its hash. */
  screenshotPath: string;
  viewport?: { width: number; height: number } | undefined;
  timeoutMs?: number | undefined;
  maxCandidates?: number | undefined;
  /** Trusted setting from server startup; never from a locate_dom request. */
  runtimeDirectory?: string | undefined;
  /** Trusted setting from server startup; never from a locate_dom request. */
  browserExecutablePath?: string | undefined;
}

export interface DomCandidate {
  rect: { x: number; y: number; width: number; height: number };
  framePath: string[];
  tag: string;
  role: string | null;
  name: string;
  text: string;
}

export interface DomLocateResult {
  ok: true;
  url: string;
  candidates: DomCandidate[];
  totalCandidates: number;
  truncated: boolean;
  page: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
  };
  screenshot: { path: string; sha256: string; sizeBytes: number };
}

export interface DomRuntimeStatus {
  status: "not-installed" | "ready";
  ready: boolean;
  runtimeDirectory: string;
  runtimeVersion: string;
  playwrightVersion: string | undefined;
  chromeCandidatePaths: string[];
  issues: string[];
}

export class DomRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomRuntimeError";
    this.code = code;
  }
}

function repositoryAssetsDirectory(): string {
  // Mirror the OCR runtime: from src/locator/dom the assets live three
  // levels up; from a bundled dist/cli.js they sit one level up.
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const parentDirectory = path.dirname(moduleDirectory);
  const isSourceModule =
    path.basename(moduleDirectory) === "dom" && path.basename(parentDirectory) === "locator";
  const candidates = isSourceModule
    ? [path.resolve(moduleDirectory, "../../../assets/dom-runtime")]
    : path.basename(moduleDirectory) === "dist"
      ? [path.resolve(moduleDirectory, "../assets/dom-runtime")]
      : [];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "locate-worker.mjs"))) {
      return candidate;
    }
  }
  throw new DomRuntimeError(
    "DOM_RUNTIME_ASSETS_MISSING",
    "The packaged browser runtime definition is missing."
  );
}

function defaultRuntimeDirectory(): string {
  if (process.platform === "win32") {
    const configured = process.env.LOCALAPPDATA;
    const localAppData =
      configured !== undefined && configured.trim() !== "" && path.isAbsolute(configured)
        ? configured
        : path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "AgentCallout", "browser", DOM_RUNTIME_VERSION);
  }
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library",
      "Caches",
      "agent-callout",
      "browser",
      DOM_RUNTIME_VERSION
    );
  }
  const configured = process.env.XDG_CACHE_HOME;
  const cacheRoot =
    configured !== undefined && configured.trim() !== "" && path.isAbsolute(configured)
      ? configured
      : path.join(homedir(), ".cache");
  return path.join(cacheRoot, "agent-callout", "browser", DOM_RUNTIME_VERSION);
}

function resolvedRuntimeDirectory(runtimeDirectory?: string): string {
  const resolved = path.resolve(runtimeDirectory ?? defaultRuntimeDirectory());
  if (resolved === path.parse(resolved).root) {
    throw new DomRuntimeError(
      "DOM_RUNTIME_INVALID",
      "The browser runtime directory must not be a filesystem root."
    );
  }
  return resolved;
}

function chromeCandidatePaths(): string[] {
  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }
  if (process.platform === "win32") {
    return [
      path.join(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "Google\\Chrome\\Application\\chrome.exe"
      ),
      path.join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Google\\Chrome\\Application\\chrome.exe"
      ),
      path.join(
        process.env["LOCALAPPDATA"] ?? path.join(homedir(), "AppData", "Local"),
        "Google\\Chrome\\Application\\chrome.exe"
      )
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
}

function npmCliCandidates(): string[] {
  const executableDirectory = path.dirname(process.execPath);
  return [
    process.env.npm_execpath,
    process.env.npm_config_prefix === undefined
      ? undefined
      : path.join(process.env.npm_config_prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
    process.platform === "win32" ? undefined : "/usr/share/nodejs/npm/bin/npm-cli.js"
  ]
    .filter(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        candidate !== "" &&
        path.basename(candidate).toLowerCase() === "npm-cli.js"
    )
    .map((candidate) => path.resolve(candidate));
}

async function runNpmCi(directory: string): Promise<void> {
  const npmCli = npmCliCandidates().find((candidate) => existsSync(candidate));
  if (npmCli === undefined) {
    throw new DomRuntimeError(
      "DOM_RUNTIME_INSTALL_FAILED",
      "A local npm-cli.js could not be found for browser runtime installation."
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: directory,
        stdio: "ignore",
        env: { ...process.env, NODE_OPTIONS: "" },
        detached: process.platform !== "win32"
      }
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new DomRuntimeError(
          "DOM_RUNTIME_INSTALL_FAILED",
          `Browser runtime installation failed (${signal ?? `exit ${String(code)}`}).`
        )
      );
    });
  });
}

export async function installBrowserRuntime(
  options: { runtimeDirectory?: string | undefined } = {}
): Promise<DomRuntimeStatus> {
  const target = resolvedRuntimeDirectory(options.runtimeDirectory);
  const assets = repositoryAssetsDirectory();
  await mkdir(target, { recursive: true });
  for (const asset of RUNTIME_ASSETS) {
    await cp(path.join(assets, asset), path.join(target, asset));
  }
  await runNpmCi(target);
  return inspectBrowserRuntime(options);
}

export async function inspectBrowserRuntime(
  options: {
    runtimeDirectory?: string | undefined;
  } = {}
): Promise<DomRuntimeStatus> {
  const target = resolvedRuntimeDirectory(options.runtimeDirectory);
  const issues: string[] = [];
  let playwrightVersion: string | undefined;
  const packageJsonPath = path.join(target, "node_modules", "playwright-core", "package.json");
  if (!existsSync(path.join(target, "node_modules", "playwright-core"))) {
    issues.push("Browser runtime is not installed; run `agent-callout browser install`.");
  } else {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
      playwrightVersion = parsed.version;
    } catch {
      issues.push("Installed browser runtime could not be read; reinstall it.");
    }
  }
  if (!existsSync(path.join(target, "locate-worker.mjs"))) {
    issues.push("locate-worker.mjs is missing; reinstall the browser runtime.");
  }
  const chromeCandidates = chromeCandidatePaths().filter((candidate) => existsSync(candidate));
  if (chromeCandidates.length === 0) {
    issues.push("No installed Chrome was found; install Chrome or set the executable path.");
  }
  return {
    status: issues.length === 0 ? "ready" : "not-installed",
    ready: issues.length === 0,
    runtimeDirectory: target,
    runtimeVersion: DOM_RUNTIME_VERSION,
    playwrightVersion,
    chromeCandidatePaths: chromeCandidates,
    issues
  };
}

function tmpdirRoot(): string {
  return process.env.TMPDIR ?? "/tmp";
}

async function locateWithRuntime(
  runtimeDirectory: string,
  arguments_: DomLocateArguments
): Promise<DomLocateResult> {
  const workerPath = path.join(runtimeDirectory, "locate-worker.mjs");
  const temporaryDirectory = await mkdtemp(path.join(tmpdirRoot(), "agent-callout-dom-"));
  const requestPath = path.join(temporaryDirectory, "request.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      url: arguments_.url,
      locator: arguments_.locator,
      screenshotPath: arguments_.screenshotPath,
      ...(arguments_.viewport === undefined ? {} : { viewport: arguments_.viewport }),
      ...(arguments_.timeoutMs === undefined ? {} : { timeoutMs: arguments_.timeoutMs }),
      ...(arguments_.maxCandidates === undefined
        ? {}
        : { maxCandidates: arguments_.maxCandidates }),
      ...(arguments_.browserExecutablePath === undefined
        ? {}
        : { executablePath: arguments_.browserExecutablePath })
    }),
    "utf8"
  );
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, "--request", requestPath], {
        cwd: temporaryDirectory,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_OPTIONS: "" },
        detached: process.platform !== "win32"
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", () => {});
      const timer = setTimeout(
        () => {
          child.kill("SIGKILL");
          reject(new DomRuntimeError("DOM_LOCATE_TIMEOUT", "The DOM locate worker timed out."));
        },
        Math.min(Math.max(arguments_.timeoutMs ?? 60_000, 5_000), 300_000)
      );
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new DomRuntimeError(
        "DOM_LOCATE_FAILED",
        "The DOM locate worker produced no parseable result."
      );
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { ok?: unknown }).ok !== true) {
      const failure = parsed as { code?: string; message?: string } | undefined;
      throw new DomRuntimeError(
        failure?.code ?? "DOM_LOCATE_FAILED",
        failure?.message ?? "The DOM locate worker failed."
      );
    }
    return parsed as DomLocateResult;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function locateDom(arguments_: DomLocateArguments): Promise<DomLocateResult> {
  const runtime = await inspectBrowserRuntime({ runtimeDirectory: arguments_.runtimeDirectory });
  if (!runtime.ready) {
    throw new DomRuntimeError(
      "DOM_RUNTIME_NOT_READY",
      `DOM_RUNTIME_NOT_READY: ${runtime.issues.join(" ")}`
    );
  }
  const screenshotDirectory = path.dirname(path.resolve(arguments_.screenshotPath));
  if (!existsSync(screenshotDirectory)) {
    throw new DomRuntimeError(
      "DOM_LOCATOR_INVALID",
      "The screenshot output directory must exist before locating."
    );
  }
  const result = await locateWithRuntime(
    resolvedRuntimeDirectory(arguments_.runtimeDirectory),
    arguments_
  );
  // Verify the screenshot bytes on disk still match the evidence hash the
  // worker reported, so returned coordinates cannot drift from the file.
  const screenshotBytes = await readFile(result.screenshot.path);
  const screenshotSha256 = createHash("sha256").update(screenshotBytes).digest("hex");
  if (screenshotSha256 !== result.screenshot.sha256) {
    throw new DomRuntimeError(
      "DOM_EVIDENCE_CHANGED",
      "The captured screenshot changed before the locate result was returned."
    );
  }
  return result;
}
