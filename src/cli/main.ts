import { runCli } from "./program.js";

const exitCode = await runCli();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
