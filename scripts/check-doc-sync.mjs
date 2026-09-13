// Doc drift check: the "current status" surfaces must mention the version
// that the code actually carries. Runs as part of `npm run verify`.
import { readFile } from "node:fs/promises";

const core = await readFile("src/core/index.ts", "utf8");
const version = core.match(/AGENT_CALLOUT_VERSION = "([^"]+)"/u)?.[1];
if (version === undefined) {
  throw new Error("check-doc-sync: could not read AGENT_CALLOUT_VERSION from src/core/index.ts");
}

const progress = await readFile("PROGRESS.md", "utf8");
const progressStatus = progress.split("## 验证日志")[0];
const roadmap = await readFile("docs/roadmap.md", "utf8");

const errors = [];
if (!progressStatus.includes(version)) {
  errors.push(`PROGRESS.md 当前状态/已完成区未提及 ${version}；版本推进时请同步「当前状态」。`);
}
if (!roadmap.includes(version)) {
  errors.push(`docs/roadmap.md 未提及 ${version}；规划或已发布列表需要覆盖当前版本。`);
}

if (errors.length > 0) {
  console.error(`check-doc-sync failed for ${version}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`doc sync OK (${version}).`);
