import { startStdioMcpServer } from "./server.js";

try {
  const roots: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--allow-root") {
      const value = process.argv[index + 1];
      if (value === undefined) {
        throw new Error("--allow-root requires a path");
      }
      roots.push(value);
      index += 1;
    } else if (argument?.startsWith("--allow-root=")) {
      roots.push(argument.slice("--allow-root=".length));
    } else {
      throw new Error(`Unknown MCP startup argument: ${String(argument)}`);
    }
  }
  await startStdioMcpServer(roots.length === 0 ? {} : { fixedAllowedRoots: roots });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentCallout MCP failed to start: ${message}\n`);
  process.exitCode = 1;
}
