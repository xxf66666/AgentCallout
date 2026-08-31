import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "agent-callout");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function versionFromText(filePath, pattern, label) {
  const match = pattern.exec(await readFile(filePath, "utf8"));
  if (match?.[1] === undefined) throw new Error(`Could not read ${label} version.`);
  return match[1];
}

const rootPackage = await readJson(path.join(repositoryRoot, "package.json"));
const rootLock = await readJson(path.join(repositoryRoot, "package-lock.json"));
const pluginPackage = await readJson(path.join(pluginRoot, "package.json"));
const pluginLock = await readJson(path.join(pluginRoot, "package-lock.json"));
const codexManifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const claudeManifest = await readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));
const marketplace = await readJson(path.join(repositoryRoot, ".claude-plugin", "marketplace.json"));
const marketplaceEntry = marketplace.plugins?.find((entry) => entry.name === "agent-callout");
if (marketplaceEntry === undefined) {
  throw new Error("AgentCallout is missing from the repository marketplace.");
}

const versionRecords = {
  package: rootPackage.version,
  packageLock: rootLock.version,
  packageLockRoot: rootLock.packages?.[""]?.version,
  pluginPackage: pluginPackage.version,
  pluginPackageLock: pluginLock.version,
  pluginPackageLockRoot: pluginLock.packages?.[""]?.version,
  codexManifest: codexManifest.version,
  claudeManifest: claudeManifest.version,
  marketplace: marketplaceEntry.version,
  core: await versionFromText(
    path.join(repositoryRoot, "src", "index.ts"),
    /AGENT_CALLOUT_VERSION\s*=\s*"([^"]+)"/u,
    "core"
  ),
  renderer: await versionFromText(
    path.join(repositoryRoot, "src", "renderer", "index.ts"),
    /RENDERER_VERSION\s*=\s*"([^"]+)"/u,
    "renderer"
  ),
  skill: await versionFromText(
    path.join(pluginRoot, "skills", "agent-callout", "SKILL.md"),
    /^\s*version:\s*"([^"]+)"\s*$/mu,
    "skill"
  )
};
const versions = new Set(Object.values(versionRecords));
if (versions.size !== 1 || versions.has(undefined)) {
  throw new Error(`AgentCallout version mismatch: ${JSON.stringify(versionRecords)}`);
}

await rm(path.join(pluginRoot, "dist", "mcp.js.map"), { force: true });

const copies = [
  ["dist/mcp.js", "dist/mcp.js"],
  ["assets/fonts/NotoSansCJKsc-Regular.otf", "assets/fonts/NotoSansCJKsc-Regular.otf"],
  ["assets/fonts/OFL.txt", "assets/fonts/OFL.txt"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"]
];

for (const [sourceRelative, destinationRelative] of copies) {
  const source = path.join(repositoryRoot, sourceRelative);
  const destination = path.join(pluginRoot, destinationRelative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

process.stdout.write(`Synced AgentCallout ${rootPackage.version} runtime into the plugin.\n`);
