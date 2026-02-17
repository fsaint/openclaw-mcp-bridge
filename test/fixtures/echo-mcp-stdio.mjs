/**
 * Minimal MCP stdio echo server for testing StdioTransport.
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin and writes
 * newline-delimited JSON-RPC 2.0 responses to stdout. Logs to stderr.
 *
 * Supported methods:
 * - initialize: returns a valid InitializeResult
 * - tools/list: returns a mock tools list
 * - tools/call: echoes back the arguments as the result
 * - Any other method: returns a method_not_found error (-32601)
 *
 * Exit modes:
 * - If the env var CRASH_AFTER_MS is set, the process exits with code 1
 *   after that many milliseconds.
 * - If stdin is closed (EOF), the process exits cleanly with code 0.
 */

import { createInterface } from "node:readline";

const METHOD_NOT_FOUND = -32601;

const rl = createInterface({ input: process.stdin });

process.stderr.write("echo-mcp-stdio: server started\n");

rl.on("line", (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Invalid JSON — ignore
    process.stderr.write(`echo-mcp-stdio: invalid JSON received: ${line}\n`);
    return;
  }

  // Handle notifications (no id) — just log them
  if (parsed.id === undefined || parsed.id === null) {
    process.stderr.write(
      `echo-mcp-stdio: notification received: ${parsed.method}\n`
    );
    return;
  }

  const id = parsed.id;
  const method = parsed.method;

  let response;

  if (method === "initialize") {
    response = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "echo-mcp-stdio", version: "1.0.0" },
        instructions: "This is a test echo MCP server.",
      },
    };
  } else if (method === "tools/list") {
    response = {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes back the provided arguments",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
            },
          },
          {
            name: "add",
            description: "Adds two numbers",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            },
          },
        ],
      },
    };
  } else if (method === "tools/call") {
    const args = parsed.params?.arguments ?? {};
    response = {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify(args),
          },
        ],
      },
    };
  } else {
    response = {
      jsonrpc: "2.0",
      id,
      error: {
        code: METHOD_NOT_FOUND,
        message: `Method not found: ${method}`,
      },
    };
  }

  const responseLine = JSON.stringify(response) + "\n";
  process.stdout.write(responseLine);
  process.stderr.write(`echo-mcp-stdio: responded to ${method} (id=${id})\n`);
});

rl.on("close", () => {
  process.stderr.write("echo-mcp-stdio: stdin closed, exiting\n");
  process.exit(0);
});

// Optional: crash after a configured delay (for testing auto-restart)
if (process.env.CRASH_AFTER_MS) {
  const delay = parseInt(process.env.CRASH_AFTER_MS, 10);
  setTimeout(() => {
    process.stderr.write("echo-mcp-stdio: crashing intentionally\n");
    process.exit(1);
  }, delay);
}
