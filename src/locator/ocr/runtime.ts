import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { OcrWorkerProcessError, runIsolatedOcrWorker, type OcrLanguage } from "./process.js";
import type { OcrEngineDocument } from "./types.js";

export type { OcrLanguage } from "./process.js";

export const SUPPORTED_OCR_LANGUAGES = ["eng", "chi_sim"] as const;
export const OCR_RUNTIME_VERSION = "v1";

const RUNTIME_ARTIFACT = "agent-callout-ocr-runtime";
const RUNTIME_MANIFEST = "runtime-manifest.json";
const INSTALL_LOCK_VERSION = "1.0";
const INSTALL_LOCK_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALL_LOCK_POLL_MS = 200;
const MAX_LOCK_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_MODEL_DECODE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_RECOGNITION_TIMEOUT_MS = 30_000;
const MAX_RECOGNITION_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_RECOGNITIONS = 4;
const PINNED_NODE_MODULES_FILE_COUNT = 241;
const PINNED_NODE_MODULES_BYTES = 87_428_500;
const PINNED_NODE_MODULES_SHA256 =
  "f8d679dfaf726a1d720a03e57adfee0134ca65db450e9557e78febd8d7ecb0e4";

const PACKAGE_VERSIONS = Object.freeze({
  "tesseract.js": "7.0.0",
  "tesseract.js-core": "7.0.0",
  "@tesseract.js-data/eng": "1.0.0",
  "@tesseract.js-data/chi_sim": "1.0.0"
});

interface ModelDefinition {
  language: OcrLanguage;
  packageName: "@tesseract.js-data/eng" | "@tesseract.js-data/chi_sim";
  compressedRelativePath: string;
  compressedBytes: number;
  compressedSha256: string;
  decodedBytes: number;
  decodedSha256: string;
}

const MODEL_DEFINITIONS: Record<OcrLanguage, ModelDefinition> = {
  eng: {
    language: "eng",
    packageName: "@tesseract.js-data/eng",
    compressedRelativePath: path.join(
      "node_modules",
      "@tesseract.js-data",
      "eng",
      "4.0.0_best_int",
      "eng.traineddata.gz"
    ),
    compressedBytes: 2_952_873,
    compressedSha256: "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91",
    decodedBytes: 5_199_098,
    decodedSha256: "5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747"
  },
  chi_sim: {
    language: "chi_sim",
    packageName: "@tesseract.js-data/chi_sim",
    compressedRelativePath: path.join(
      "node_modules",
      "@tesseract.js-data",
      "chi_sim",
      "4.0.0_best_int",
      "chi_sim.traineddata.gz"
    ),
    compressedBytes: 1_718_768,
    compressedSha256: "b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c",
    decodedBytes: 2_471_033,
    decodedSha256: "9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6"
  }
};

const RUNTIME_HELPERS = ["network-guard.cjs", "offline-worker.cjs"] as const;
const PACKAGED_RUNTIME_FILES = [
  "package.json",
  "package-lock.json",
  ...RUNTIME_HELPERS,
  "recognize-worker.mjs"
] as const;
const RUNTIME_TOP_LEVEL_ENTRIES = [
  "models",
  "network-guard.cjs",
  "node_modules",
  "offline-worker.cjs",
  "package-lock.json",
  "package.json",
  RUNTIME_MANIFEST
] as const;

export type OcrRuntimeErrorCode =
  | "OCR_ENGINE_FAILED"
  | "OCR_RUNTIME_BUSY"
  | "OCR_RUNTIME_INSTALL_FAILED"
  | "OCR_RUNTIME_INVALID"
  | "OCR_RUNTIME_NOT_INSTALLED"
  | "OCR_RUNTIME_PROCESS_FAILED"
  | "OCR_RUNTIME_PROTOCOL_ERROR"
  | "OCR_RUNTIME_TIMEOUT";

export class OcrRuntimeError extends Error {
  readonly code: OcrRuntimeErrorCode;

  constructor(code: OcrRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OcrRuntimeError";
    this.code = code;
  }
}

export interface OcrRuntimeIssue {
  code:
    | "HELPER_INVALID"
    | "MANIFEST_INVALID"
    | "MODEL_INVALID"
    | "PACKAGE_INVALID"
    | "RUNTIME_PATH_INVALID";
  message: string;
}

export interface OcrRuntimeModelInspection {
  language: OcrLanguage;
  version: "4.0.0_best_int";
  sizeBytes: number;
  sha256: string;
}

export interface OcrRuntimeInspection {
  status: "ready" | "not-installed" | "invalid";
  ready: boolean;
  runtimeDirectory: string;
  runtimeVersion: typeof OCR_RUNTIME_VERSION;
  tesseractVersion: "7.0.0";
  installedLanguages: OcrLanguage[];
  packageVersions: Record<string, string>;
  models: OcrRuntimeModelInspection[];
  issues: OcrRuntimeIssue[];
}

export interface InstallOcrRuntimeOptions {
  runtimeDirectory?: string;
  languages?: OcrLanguage[];
}

export interface InstallOcrRuntimeResult extends OcrRuntimeInspection {
  installed: boolean;
}

export interface InspectOcrRuntimeOptions {
  runtimeDirectory?: string;
}

export interface RecognizeOcrImageOptions {
  runtimeDirectory?: string;
  languages?: OcrLanguage[];
  timeoutMs?: number;
}

interface RuntimeManifest {
  artifact: typeof RUNTIME_ARTIFACT;
  schemaVersion: 1;
  runtimeVersion: typeof OCR_RUNTIME_VERSION;
  packageLockSha256: string;
  installedLanguages: OcrLanguage[];
  models: OcrRuntimeModelInspection[];
}

interface DetailedInspection {
  inspection: OcrRuntimeInspection;
  owned: boolean;
  identity: RuntimePathIdentity | null;
}

interface RuntimePathIdentity {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
}

interface InstallLockRecord {
  version: typeof INSTALL_LOCK_VERSION;
  token: string;
  pid: number;
  createdAt: number;
}

function sameRuntimeIdentity(
  left: RuntimePathIdentity | null,
  right: RuntimePathIdentity | null
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mtimeNs === right.mtimeNs)
  );
}

let recognitionActive = false;
const recognitionQueue: {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultRuntimeDirectory(): string {
  if (process.platform === "win32") {
    const configured = process.env.LOCALAPPDATA;
    const localAppData =
      configured !== undefined && configured.trim() !== "" && path.isAbsolute(configured)
        ? configured
        : path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "AgentCallout", "ocr", OCR_RUNTIME_VERSION);
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "agent-callout", "ocr", OCR_RUNTIME_VERSION);
  }
  const configured = process.env.XDG_CACHE_HOME;
  const cacheRoot =
    configured !== undefined && configured.trim() !== "" && path.isAbsolute(configured)
      ? configured
      : path.join(homedir(), ".cache");
  return path.join(cacheRoot, "agent-callout", "ocr", OCR_RUNTIME_VERSION);
}

function resolvedRuntimeDirectory(runtimeDirectory?: string): string {
  const resolved = path.resolve(runtimeDirectory ?? defaultRuntimeDirectory());
  if (resolved === path.parse(resolved).root) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      "The OCR runtime directory must not be a filesystem root."
    );
  }
  return resolved;
}

function normalizedLanguages(languages?: readonly OcrLanguage[]): OcrLanguage[] {
  const requested = languages ?? SUPPORTED_OCR_LANGUAGES;
  if (requested.length === 0) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      "At least one supported OCR language is required."
    );
  }
  for (const language of requested) {
    if (!(SUPPORTED_OCR_LANGUAGES as readonly string[]).includes(language)) {
      throw new OcrRuntimeError(
        "OCR_RUNTIME_INVALID",
        "Only the eng and chi_sim OCR languages are supported by this runtime version."
      );
    }
  }
  const unique = new Set(requested);
  return SUPPORTED_OCR_LANGUAGES.filter((language) => unique.has(language));
}

function assetDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const parentDirectory = path.dirname(moduleDirectory);
  const grandparentDirectory = path.dirname(parentDirectory);
  const isSourceOrUnbundledModule =
    path.basename(moduleDirectory) === "ocr" &&
    path.basename(parentDirectory) === "locator" &&
    ["src", "dist"].includes(path.basename(grandparentDirectory));
  const candidate = isSourceOrUnbundledModule
    ? path.resolve(moduleDirectory, "../../../assets/ocr-runtime")
    : path.basename(moduleDirectory) === "dist"
      ? path.resolve(moduleDirectory, "../assets/ocr-runtime")
      : undefined;
  if (candidate !== undefined && existsSync(path.join(candidate, "package-lock.json"))) {
    return candidate;
  }
  throw new OcrRuntimeError(
    "OCR_RUNTIME_INVALID",
    "The packaged OCR runtime definition is missing."
  );
}

async function regularFileBytes(
  filePath: string,
  maximumBytes: number,
  rootDirectory?: string
): Promise<Buffer> {
  const information = await lstat(filePath, { bigint: true });
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > BigInt(maximumBytes)
  ) {
    throw new Error("not-a-bounded-regular-file");
  }
  if (rootDirectory !== undefined) {
    const [rootRealPath, fileRealPath] = await Promise.all([
      realpath(rootDirectory),
      realpath(filePath)
    ]);
    const relative = path.relative(rootRealPath, fileRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("file-resolves-outside-runtime");
    }
  }
  return readFile(filePath);
}

async function readJson(
  filePath: string,
  rootDirectory?: string
): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(
    (await regularFileBytes(filePath, MAX_JSON_BYTES, rootDirectory)).toString("utf8")
  );
  if (!isRecord(value)) throw new Error("json-is-not-an-object");
  return value;
}

async function nodeModulesTreeDigest(runtimeDirectory: string): Promise<{
  fileCount: number;
  sizeBytes: number;
  sha256: string;
}> {
  const root = path.join(runtimeDirectory, "node_modules");
  const files: { absolutePath: string; relativePath: string }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (
        relativePath === ".package-lock.json" ||
        relativePath === ".bin" ||
        relativePath.startsWith(".bin/")
      ) {
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error("node-modules-symlink");
      if (entry.isDirectory()) await walk(absolutePath);
      else if (entry.isFile()) files.push({ absolutePath, relativePath });
      else throw new Error("node-modules-special-file");
      if (files.length > 1_000) throw new Error("node-modules-file-limit");
    }
  };
  await walk(root);
  files.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  );
  const digest = createHash("sha256");
  let sizeBytes = 0;
  for (const file of files) {
    const bytes = await regularFileBytes(file.absolutePath, 64 * 1024 * 1024, runtimeDirectory);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > 128 * 1024 * 1024) throw new Error("node-modules-byte-limit");
    digest.update(`${file.relativePath}\0${bytes.byteLength}\0${sha256(bytes)}\n`, "utf8");
  }
  return { fileCount: files.length, sizeBytes, sha256: digest.digest("hex") };
}

async function expectedAssetBytes(): Promise<{
  directory: string;
  files: Map<string, { bytes: Buffer; sha256: string }>;
}> {
  const directory = assetDirectory();
  const entries = await Promise.all(
    PACKAGED_RUNTIME_FILES.map(async (name) => {
      const bytes = await regularFileBytes(path.join(directory, name), MAX_JSON_BYTES);
      return [name, { bytes, sha256: sha256(bytes) }] as const;
    })
  );
  const packageJson = JSON.parse(
    entries.find(([name]) => name === "package.json")?.[1].bytes.toString("utf8") ?? "null"
  ) as { dependencies?: Record<string, string> } | null;
  const packageLock = JSON.parse(
    entries.find(([name]) => name === "package-lock.json")?.[1].bytes.toString("utf8") ?? "null"
  ) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  } | null;
  if (
    packageJson === null ||
    packageLock === null ||
    packageLock.lockfileVersion !== 3 ||
    Object.entries(PACKAGE_VERSIONS).some(
      ([name, version]) =>
        packageJson.dependencies?.[name] !== version ||
        packageLock.packages?.[""]?.dependencies?.[name] !== version ||
        packageLock.packages?.[`node_modules/${name}`]?.version !== version
    )
  ) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      "The packaged OCR runtime definition is not exactly pinned."
    );
  }
  return { directory, files: new Map(entries) };
}

function invalidInspection(
  runtimeDirectory: string,
  issues: OcrRuntimeIssue[],
  installedLanguages: OcrLanguage[] = [],
  models: OcrRuntimeModelInspection[] = [],
  packageVersions: Record<string, string> = {}
): OcrRuntimeInspection {
  return {
    status: "invalid",
    ready: false,
    runtimeDirectory,
    runtimeVersion: OCR_RUNTIME_VERSION,
    tesseractVersion: PACKAGE_VERSIONS["tesseract.js"],
    installedLanguages,
    packageVersions,
    models,
    issues
  };
}

function manifestLanguages(value: unknown): OcrLanguage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  try {
    return normalizedLanguages(value as OcrLanguage[]);
  } catch {
    return undefined;
  }
}

function parsedRuntimeManifest(raw: Record<string, unknown>): RuntimeManifest | undefined {
  const languages = manifestLanguages(raw.installedLanguages);
  const expectedKeys = [
    "artifact",
    "installedLanguages",
    "models",
    "packageLockSha256",
    "runtimeVersion",
    "schemaVersion"
  ];
  if (
    Object.keys(raw).sort().join("\0") !== expectedKeys.join("\0") ||
    raw.artifact !== RUNTIME_ARTIFACT ||
    raw.schemaVersion !== 1 ||
    raw.runtimeVersion !== OCR_RUNTIME_VERSION ||
    typeof raw.packageLockSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.packageLockSha256) ||
    languages === undefined ||
    !Array.isArray(raw.models) ||
    raw.models.length !== languages.length
  ) {
    return undefined;
  }
  const models: OcrRuntimeModelInspection[] = [];
  const rawModels: unknown[] = raw.models;
  for (const [index, language] of languages.entries()) {
    const model = rawModels[index];
    const definition = MODEL_DEFINITIONS[language];
    if (
      !isRecord(model) ||
      Object.keys(model).sort().join("\0") !== "language\0sha256\0sizeBytes\0version" ||
      model.language !== language ||
      model.version !== "4.0.0_best_int" ||
      model.sizeBytes !== definition.decodedBytes ||
      model.sha256 !== definition.decodedSha256
    ) {
      return undefined;
    }
    models.push({
      language,
      version: "4.0.0_best_int",
      sizeBytes: definition.decodedBytes,
      sha256: definition.decodedSha256
    });
  }
  return {
    artifact: RUNTIME_ARTIFACT,
    schemaVersion: 1,
    runtimeVersion: OCR_RUNTIME_VERSION,
    packageLockSha256: raw.packageLockSha256,
    installedLanguages: languages,
    models
  };
}

async function inspectDetailed(runtimeDirectory: string): Promise<DetailedInspection> {
  let rootInformation;
  try {
    rootInformation = await lstat(runtimeDirectory, { bigint: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return {
        owned: false,
        identity: null,
        inspection: {
          status: "not-installed",
          ready: false,
          runtimeDirectory,
          runtimeVersion: OCR_RUNTIME_VERSION,
          tesseractVersion: PACKAGE_VERSIONS["tesseract.js"],
          installedLanguages: [],
          packageVersions: {},
          models: [],
          issues: []
        }
      };
    }
    throw error;
  }
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    return {
      owned: false,
      identity: {
        dev: rootInformation.dev,
        ino: rootInformation.ino,
        mtimeNs: rootInformation.mtimeNs
      },
      inspection: invalidInspection(runtimeDirectory, [
        {
          code: "RUNTIME_PATH_INVALID",
          message: "The OCR runtime path is not a real directory."
        }
      ])
    };
  }

  const issues: OcrRuntimeIssue[] = [];
  let manifest: RuntimeManifest | undefined;
  let ownershipFilesValid = true;
  let topLevelValid = true;
  try {
    const entries = (await readdir(runtimeDirectory)).sort();
    if (entries.join("\0") !== [...RUNTIME_TOP_LEVEL_ENTRIES].sort().join("\0")) {
      topLevelValid = false;
      issues.push({
        code: "RUNTIME_PATH_INVALID",
        message: "The OCR runtime contains unknown or missing top-level entries and was preserved."
      });
    }
  } catch {
    topLevelValid = false;
    issues.push({
      code: "RUNTIME_PATH_INVALID",
      message: "The OCR runtime top-level inventory could not be validated."
    });
  }
  try {
    const raw = await readJson(path.join(runtimeDirectory, RUNTIME_MANIFEST), runtimeDirectory);
    manifest = parsedRuntimeManifest(raw);
    if (manifest === undefined) throw new Error("manifest-shape");
  } catch {
    issues.push({ code: "MANIFEST_INVALID", message: "The OCR runtime manifest is invalid." });
  }

  const packageVersions: Record<string, string> = {};
  const models: OcrRuntimeModelInspection[] = [];
  let assets: Awaited<ReturnType<typeof expectedAssetBytes>> | undefined;
  try {
    assets = await expectedAssetBytes();
    for (const name of ["package.json", "package-lock.json", ...RUNTIME_HELPERS]) {
      const expected = assets.files.get(name);
      const actual = await regularFileBytes(
        path.join(runtimeDirectory, name),
        MAX_JSON_BYTES,
        runtimeDirectory
      );
      if (expected === undefined || sha256(actual) !== expected.sha256) {
        ownershipFilesValid = false;
        issues.push({
          code: name.endsWith(".cjs") ? "HELPER_INVALID" : "PACKAGE_INVALID",
          message: `The installed OCR ${name.endsWith(".cjs") ? "helper" : "package definition"} failed integrity validation.`
        });
      }
    }
    if (
      manifest !== undefined &&
      manifest.packageLockSha256 !== assets.files.get("package-lock.json")?.sha256
    ) {
      ownershipFilesValid = false;
      issues.push({
        code: "PACKAGE_INVALID",
        message: "The OCR runtime manifest does not match the packaged lockfile."
      });
    }
  } catch {
    ownershipFilesValid = false;
    issues.push({
      code: "PACKAGE_INVALID",
      message: "The OCR runtime package definition is missing or invalid."
    });
  }

  for (const [packageName, expectedVersion] of Object.entries(PACKAGE_VERSIONS)) {
    try {
      const marker = await readJson(
        path.join(runtimeDirectory, "node_modules", packageName, "package.json"),
        runtimeDirectory
      );
      if (marker.version !== expectedVersion) throw new Error("version");
      packageVersions[packageName] = expectedVersion;
    } catch {
      issues.push({
        code: "PACKAGE_INVALID",
        message: `The pinned OCR package ${packageName} is missing or has the wrong version.`
      });
    }
  }
  try {
    await regularFileBytes(
      path.join(
        runtimeDirectory,
        "node_modules",
        "tesseract.js",
        "src",
        "worker-script",
        "node",
        "index.js"
      ),
      2 * 1024 * 1024,
      runtimeDirectory
    );
  } catch {
    issues.push({
      code: "PACKAGE_INVALID",
      message: "The pinned Tesseract Node worker is missing or invalid."
    });
  }
  try {
    const tree = await nodeModulesTreeDigest(runtimeDirectory);
    if (
      tree.fileCount !== PINNED_NODE_MODULES_FILE_COUNT ||
      tree.sizeBytes !== PINNED_NODE_MODULES_BYTES ||
      tree.sha256 !== PINNED_NODE_MODULES_SHA256
    ) {
      throw new Error("node-modules-tree-integrity");
    }
  } catch {
    issues.push({
      code: "PACKAGE_INVALID",
      message: "The pinned OCR package tree failed file-count, byte, and SHA-256 validation."
    });
  }

  for (const language of manifest?.installedLanguages ?? []) {
    const definition = MODEL_DEFINITIONS[language];
    try {
      const bytes = await regularFileBytes(
        path.join(runtimeDirectory, "models", `${language}.traineddata`),
        MAX_MODEL_DECODE_BYTES,
        runtimeDirectory
      );
      if (
        bytes.byteLength !== definition.decodedBytes ||
        sha256(bytes) !== definition.decodedSha256
      ) {
        throw new Error("model-integrity");
      }
      const manifestModel = manifest?.models.find((model) => model.language === language);
      if (
        manifestModel?.version !== "4.0.0_best_int" ||
        manifestModel?.sizeBytes !== definition.decodedBytes ||
        manifestModel.sha256 !== definition.decodedSha256
      ) {
        throw new Error("manifest-model-integrity");
      }
      models.push({
        language,
        version: "4.0.0_best_int",
        sizeBytes: definition.decodedBytes,
        sha256: definition.decodedSha256
      });
    } catch {
      issues.push({
        code: "MODEL_INVALID",
        message: `The installed ${language} OCR model failed byte and SHA-256 validation.`
      });
    }
  }

  const installedLanguages = manifest?.installedLanguages ?? [];
  const owned = manifest !== undefined && ownershipFilesValid && topLevelValid;
  return {
    owned,
    identity: {
      dev: rootInformation.dev,
      ino: rootInformation.ino,
      mtimeNs: rootInformation.mtimeNs
    },
    inspection:
      issues.length === 0 && manifest !== undefined
        ? {
            status: "ready",
            ready: true,
            runtimeDirectory,
            runtimeVersion: OCR_RUNTIME_VERSION,
            tesseractVersion: PACKAGE_VERSIONS["tesseract.js"],
            installedLanguages,
            packageVersions,
            models,
            issues: []
          }
        : invalidInspection(runtimeDirectory, issues, installedLanguages, models, packageVersions)
  };
}

export async function inspectOcrRuntime(
  options: InspectOcrRuntimeOptions = {}
): Promise<OcrRuntimeInspection> {
  return (await inspectDetailed(resolvedRuntimeDirectory(options.runtimeDirectory))).inspection;
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
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "A local npm-cli.js could not be found for explicit OCR runtime installation."
    );
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        npmCli,
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org"
      ],
      {
        cwd: directory,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = Math.min(MAX_JSON_BYTES, stdoutBytes + chunk.byteLength);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_JSON_BYTES, stderrBytes + chunk.byteLength);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new OcrRuntimeError(
          "OCR_RUNTIME_INSTALL_FAILED",
          "The pinned OCR npm installation process could not start."
        )
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new OcrRuntimeError(
            "OCR_RUNTIME_INSTALL_FAILED",
            `The pinned OCR npm installation failed (${stdoutBytes} stdout bytes and ${stderrBytes} stderr bytes suppressed).`
          )
        );
    });
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

function installLockCandidatePath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.candidate`;
}

async function removePathByIdentity(
  filePath: string,
  identity: { dev: bigint; ino: bigint },
  allowMissing: boolean
): Promise<void> {
  let current;
  try {
    current = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (allowMissing && isFileSystemError(error, "ENOENT")) return;
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "OCR runtime install-lock ownership changed; the lock was preserved."
    );
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino
  ) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "OCR runtime install-lock ownership changed; the file was preserved."
    );
  }
  await rm(filePath);
}

async function releaseInstallLock(
  lockPath: string,
  token: string,
  identity: { dev: bigint; ino: bigint },
  allowMissing = false
): Promise<void> {
  let current;
  try {
    current = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if (allowMissing && isFileSystemError(error, "ENOENT")) return;
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "OCR runtime install-lock ownership changed; the lock was preserved."
    );
  }
  let record: { token?: unknown };
  let verified;
  try {
    record = JSON.parse((await regularFileBytes(lockPath, MAX_LOCK_BYTES)).toString("utf8")) as {
      token?: unknown;
    };
    verified = await lstat(lockPath, { bigint: true });
  } catch {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "OCR runtime install-lock ownership changed; the lock was preserved."
    );
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    !verified.isFile() ||
    verified.isSymbolicLink() ||
    verified.dev !== identity.dev ||
    verified.ino !== identity.ino ||
    verified.size !== current.size ||
    verified.mtimeNs !== current.mtimeNs ||
    record.token !== token
  ) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "OCR runtime install-lock ownership changed; the lock was preserved."
    );
  }
  await rm(lockPath);
}

async function removeStaleInstallLock(lockPath: string): Promise<boolean> {
  let before;
  try {
    before = await lstat(lockPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_LOCK_BYTES)) {
      throw new Error("lock-shape");
    }
    let raw: Partial<InstallLockRecord>;
    try {
      raw = JSON.parse(await readFile(lockPath, "utf8")) as Partial<InstallLockRecord>;
    } catch {
      if (Date.now() - Number(before.mtimeMs) < 30_000) return false;
      throw new Error("lock-record");
    }
    const { token, pid, createdAt, version } = raw;
    if (
      version !== INSTALL_LOCK_VERSION ||
      typeof token !== "string" ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt)
    ) {
      if (Date.now() - Number(before.mtimeMs) < 30_000) return false;
      throw new Error("lock-record");
    }
    if (processIsAlive(pid)) return false;
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "A complete OCR install lock belongs to a stopped process and was preserved for manual recovery."
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    if (error instanceof OcrRuntimeError) throw error;
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "The OCR runtime install lock is invalid and was preserved."
    );
  }
}

async function acquireInstallLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
  while (true) {
    const token = randomUUID();
    const candidatePath = installLockCandidatePath(lockPath, token);
    let handle;
    let identity: { dev: bigint; ino: bigint } | undefined;
    try {
      handle = await open(candidatePath, "wx", 0o600);
      const information = await handle.stat({ bigint: true });
      identity = { dev: information.dev, ino: information.ino };
      const record: InstallLockRecord = {
        version: INSTALL_LOCK_VERSION,
        token,
        pid: process.pid,
        createdAt: Date.now()
      };
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        // Preserve the acquisition failure.
      }
      if (identity !== undefined) {
        await removePathByIdentity(candidatePath, identity, true);
      }
      throw error;
    }
    try {
      await link(candidatePath, lockPath);
    } catch (error) {
      await releaseInstallLock(candidatePath, token, identity, true);
      if (!isFileSystemError(error, "EEXIST")) throw error;
      if (await removeStaleInstallLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new OcrRuntimeError(
          "OCR_RUNTIME_INSTALL_FAILED",
          "Timed out waiting for another explicit OCR runtime installation."
        );
      }
      await new Promise((resolve) => setTimeout(resolve, INSTALL_LOCK_POLL_MS));
      continue;
    }
    try {
      await releaseInstallLock(candidatePath, token, identity, true);
    } catch (error) {
      await releaseInstallLock(lockPath, token, identity, true);
      throw error;
    }
    return () => releaseInstallLock(lockPath, token, identity);
  }
}

async function extractModel(stagingDirectory: string, language: OcrLanguage): Promise<void> {
  const definition = MODEL_DEFINITIONS[language];
  const compressed = await regularFileBytes(
    path.join(stagingDirectory, definition.compressedRelativePath),
    MAX_MODEL_DECODE_BYTES,
    stagingDirectory
  );
  if (
    compressed.byteLength !== definition.compressedBytes ||
    sha256(compressed) !== definition.compressedSha256
  ) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      `The downloaded ${language} OCR package did not match its pinned bytes and SHA-256.`
    );
  }
  const decoded = gunzipSync(compressed, { maxOutputLength: MAX_MODEL_DECODE_BYTES });
  if (
    decoded.byteLength !== definition.decodedBytes ||
    sha256(decoded) !== definition.decodedSha256
  ) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      `The decoded ${language} OCR model did not match its pinned bytes and SHA-256.`
    );
  }
  await writeFile(path.join(stagingDirectory, "models", `${language}.traineddata`), decoded, {
    flag: "wx",
    mode: 0o600
  });
}

async function publishStagingRuntime(
  stagingDirectory: string,
  runtimeDirectory: string,
  existing: DetailedInspection,
  token: string
): Promise<string | undefined> {
  const backupDirectory = `${runtimeDirectory}.backup-${token}`;
  let backedUp = false;
  try {
    if (existing.inspection.status !== "not-installed") {
      if (!existing.owned) {
        throw new OcrRuntimeError(
          "OCR_RUNTIME_INVALID",
          "The existing directory is not an owned AgentCallout OCR runtime and was preserved."
        );
      }
      await rename(runtimeDirectory, backupDirectory);
      backedUp = true;
      const moved = await lstat(backupDirectory, { bigint: true });
      if (
        existing.identity === null ||
        moved.dev !== existing.identity.dev ||
        moved.ino !== existing.identity.ino ||
        moved.mtimeNs !== existing.identity.mtimeNs
      ) {
        await rename(backupDirectory, runtimeDirectory);
        backedUp = false;
        throw new OcrRuntimeError(
          "OCR_RUNTIME_INSTALL_FAILED",
          "The OCR runtime changed during publication and was preserved."
        );
      }
    }
    await rename(stagingDirectory, runtimeDirectory);
  } catch (error) {
    if (backedUp && !existsSync(runtimeDirectory) && existsSync(backupDirectory)) {
      await rename(backupDirectory, runtimeDirectory);
    }
    throw error;
  }
  return backedUp ? backupDirectory : undefined;
}

async function installOcrRuntimeWhileLocked(
  runtimeDirectory: string,
  requestedLanguages: OcrLanguage[]
): Promise<InstallOcrRuntimeResult> {
  const existing = await inspectDetailed(runtimeDirectory);
  if (
    existing.inspection.ready &&
    requestedLanguages.every((language) =>
      existing.inspection.installedLanguages.includes(language)
    )
  ) {
    return { ...existing.inspection, installed: false };
  }
  if (existing.inspection.status === "invalid" && !existing.owned) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      "The existing directory is not an owned AgentCallout OCR runtime and was preserved."
    );
  }
  const languages = normalizedLanguages([
    ...existing.inspection.installedLanguages,
    ...requestedLanguages
  ]);
  const token = randomUUID();
  const stagingDirectory = `${runtimeDirectory}.install-${token}`;
  const assets = await expectedAssetBytes();
  let stagedIdentity: RuntimePathIdentity | null = null;
  let backupDirectory: string | undefined;
  try {
    await mkdir(stagingDirectory, { recursive: false });
    for (const name of ["package.json", "package-lock.json", ...RUNTIME_HELPERS]) {
      await copyFile(path.join(assets.directory, name), path.join(stagingDirectory, name));
    }
    await runNpmCi(stagingDirectory);
    await mkdir(path.join(stagingDirectory, "models"));
    await Promise.all(languages.map((language) => extractModel(stagingDirectory, language)));
    const manifest: RuntimeManifest = {
      artifact: RUNTIME_ARTIFACT,
      schemaVersion: 1,
      runtimeVersion: OCR_RUNTIME_VERSION,
      packageLockSha256: assets.files.get("package-lock.json")?.sha256 ?? "",
      installedLanguages: languages,
      models: languages.map((language) => ({
        language,
        version: "4.0.0_best_int",
        sizeBytes: MODEL_DEFINITIONS[language].decodedBytes,
        sha256: MODEL_DEFINITIONS[language].decodedSha256
      }))
    };
    await writeFile(
      path.join(stagingDirectory, RUNTIME_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 }
    );
    const staged = await inspectDetailed(stagingDirectory);
    if (!staged.inspection.ready) {
      throw new OcrRuntimeError(
        "OCR_RUNTIME_INSTALL_FAILED",
        "The staged OCR runtime failed its post-install integrity inspection."
      );
    }
    stagedIdentity = staged.identity;
    const current = await inspectDetailed(runtimeDirectory);
    if (
      !sameRuntimeIdentity(existing.identity, current.identity) ||
      existing.owned !== current.owned ||
      existing.inspection.status !== current.inspection.status ||
      existing.inspection.installedLanguages.join("\0") !==
        current.inspection.installedLanguages.join("\0")
    ) {
      throw new OcrRuntimeError(
        "OCR_RUNTIME_INSTALL_FAILED",
        "The OCR runtime changed while installation was staged and was preserved."
      );
    }
    backupDirectory = await publishStagingRuntime(
      stagingDirectory,
      runtimeDirectory,
      current,
      token
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  const installed = await inspectDetailed(runtimeDirectory);
  if (!installed.inspection.ready || !sameRuntimeIdentity(installed.identity, stagedIdentity)) {
    if (sameRuntimeIdentity(installed.identity, stagedIdentity)) {
      await rm(runtimeDirectory, { recursive: true, force: true });
      if (backupDirectory !== undefined) await rename(backupDirectory, runtimeDirectory);
    }
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "The published OCR runtime failed final identity or integrity inspection; any safe backup was preserved."
    );
  }
  if (backupDirectory !== undefined) {
    await rm(backupDirectory, { recursive: true, force: true });
  }
  return { ...installed.inspection, installed: true };
}

export async function installOcrRuntime(
  options: InstallOcrRuntimeOptions = {}
): Promise<InstallOcrRuntimeResult> {
  const runtimeDirectory = resolvedRuntimeDirectory(options.runtimeDirectory);
  const requestedLanguages = normalizedLanguages(options.languages);
  await mkdir(path.dirname(runtimeDirectory), { recursive: true });
  const release = await acquireInstallLock(`${runtimeDirectory}.install.lock`);
  let result: InstallOcrRuntimeResult | undefined;
  let installationError: Error | undefined;
  try {
    result = await installOcrRuntimeWhileLocked(runtimeDirectory, requestedLanguages);
  } catch (error) {
    installationError =
      error instanceof OcrRuntimeError
        ? error
        : new OcrRuntimeError(
            "OCR_RUNTIME_INSTALL_FAILED",
            "Explicit OCR runtime installation failed; any existing valid runtime was preserved.",
            { cause: error }
          );
  }
  let releaseError: Error | undefined;
  try {
    await release();
  } catch (error) {
    releaseError =
      error instanceof Error
        ? error
        : new OcrRuntimeError(
            "OCR_RUNTIME_INSTALL_FAILED",
            "OCR runtime install-lock cleanup failed."
          );
  }
  if (installationError !== undefined) throw installationError;
  if (releaseError !== undefined) throw releaseError;
  if (result === undefined) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INSTALL_FAILED",
      "Explicit OCR runtime installation ended without a result."
    );
  }
  return result;
}

function timeoutValue(value?: number): number {
  const timeout = value ?? DEFAULT_RECOGNITION_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > MAX_RECOGNITION_TIMEOUT_MS) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      `timeoutMs must be an integer between 100 and ${MAX_RECOGNITION_TIMEOUT_MS}.`
    );
  }
  return timeout;
}

function releaseRecognitionSlot(): void {
  const next = recognitionQueue.shift();
  if (next === undefined) {
    recognitionActive = false;
    return;
  }
  clearTimeout(next.timer);
  next.resolve(releaseRecognitionSlot);
}

async function acquireRecognitionSlot(timeoutMs: number): Promise<() => void> {
  if (!recognitionActive) {
    recognitionActive = true;
    return releaseRecognitionSlot;
  }
  if (recognitionQueue.length >= MAX_PENDING_RECOGNITIONS) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_BUSY",
      "The bounded local OCR queue is full; retry after an in-flight recognition finishes."
    );
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = recognitionQueue.indexOf(entry);
        if (index >= 0) recognitionQueue.splice(index, 1);
        reject(
          new OcrRuntimeError(
            "OCR_RUNTIME_BUSY",
            "Timed out waiting for the bounded local OCR worker slot."
          )
        );
      }, timeoutMs)
    };
    entry.timer.unref();
    recognitionQueue.push(entry);
  });
}

export async function recognizeOcrImage(
  image: Buffer,
  options: RecognizeOcrImageOptions = {}
): Promise<OcrEngineDocument> {
  if (!Buffer.isBuffer(image) || image.byteLength === 0 || image.byteLength > MAX_IMAGE_BYTES) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      `OCR input must be a non-empty Buffer no larger than ${MAX_IMAGE_BYTES} bytes.`
    );
  }
  const runtimeDirectory = resolvedRuntimeDirectory(options.runtimeDirectory);
  const languages = normalizedLanguages(options.languages);
  const timeoutMs = timeoutValue(options.timeoutMs);
  const inspection = await inspectOcrRuntime({ runtimeDirectory });
  if (inspection.status === "not-installed") {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_NOT_INSTALLED",
      "The optional OCR runtime is not installed; run the explicit OCR install command first."
    );
  }
  if (!inspection.ready) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_INVALID",
      "The optional OCR runtime failed integrity validation and was not started."
    );
  }
  const missing = languages.filter((language) => !inspection.installedLanguages.includes(language));
  if (missing.length > 0) {
    throw new OcrRuntimeError(
      "OCR_RUNTIME_NOT_INSTALLED",
      "One or more requested OCR language models are not installed; run the explicit installer for those languages."
    );
  }

  const release = await acquireRecognitionSlot(timeoutMs);
  try {
    const assets = await expectedAssetBytes();
    return await runIsolatedOcrWorker(
      path.join(assets.directory, "recognize-worker.mjs"),
      { runtimeDirectory, languages, image },
      timeoutMs
    );
  } catch (error) {
    if (error instanceof OcrWorkerProcessError) {
      throw new OcrRuntimeError(error.code, error.message, { cause: error });
    }
    if (error instanceof OcrRuntimeError) throw error;
    throw new OcrRuntimeError(
      "OCR_ENGINE_FAILED",
      "The isolated OCR engine failed without returning recognized text.",
      { cause: error }
    );
  } finally {
    release();
  }
}
