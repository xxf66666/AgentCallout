import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = path.resolve(process.argv[2] ?? "dist/mcp.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: process.cwd(),
  stderr: "pipe"
});
const stderr = [];
transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

const client = new Client(
  { name: "agent-callout-stdio-smoke", version: "1.0.0" },
  { capabilities: {} }
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const doctor = await client.callTool({ name: "doctor", arguments: {} });
  if (doctor.isError === true) {
    throw new Error("AgentCallout doctor returned an MCP tool error.");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        entry,
        protocolVersion: client.getServerVersion(),
        instructionsPresent: (client.getInstructions()?.length ?? 0) > 0,
        tools: tools.tools.map((tool) => tool.name).sort(),
        doctorStructured: doctor.structuredContent,
        stderr: stderr.join("").trim()
      },
      null,
      2
    )}\n`
  );
} finally {
  await client.close();
}
