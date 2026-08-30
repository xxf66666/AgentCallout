import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "agent-callout");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

const rootPackage = await readJson(path.join(repositoryRoot, "package.json"));
const pluginPackage = await readJson(path.join(pluginRoot, "package.json"));
const codexManifest = await readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const claudeManifest = await readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"));

const versions = new Set([
  rootPackage.version,
  pluginPackage.version,
  codexManifest.version,
  claudeManifest.version
]);
if (versions.size !== 1) {
  throw new Error(`AgentCallout version mismatch: ${[...versions].join(", ")}`);
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
