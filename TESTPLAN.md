# Manual Test Plan — OpenClaw HTTP MCP Client

This document provides step-by-step instructions for manually verifying every
feature built across Phase 1 (Core MCP), Phase 2 (OAuth 2.1), and Phase 3
(Production Hardening).

---

## Prerequisites

1. **Node.js 22+** installed (`node --version`)
2. Dependencies installed:
   ```bash
   npm install
   ```
3. TypeScript compiles cleanly:
   ```bash
   npx tsc --noEmit
   ```
4. All automated tests pass (354 tests):
   ```bash
   npx vitest run
   ```

---

## Part 1 — Automated Test Suite

Run all automated tests first. Every subsequent manual test builds on the
assumption that the automated suite is green.

### Step 1.1: Run the full test suite

```bash
npx vitest run
```

**Expected:** 14 test files, 354 tests, 0 failures.

### Step 1.2: Run tests with coverage (optional)

```bash
npx vitest run --coverage
```

**Expected:** Coverage report generated. Core modules (`src/transport/`,
`src/auth/`, `src/manager/`) should have high coverage.

### Step 1.3: Run a single test file to verify isolation

```bash
npx vitest run test/transport/streamable-http.test.ts
```

**Expected:** 26 tests pass. No cross-file interference.

---

## Part 2 — Streamable HTTP Transport (Phase 1)

These steps verify the core MCP 2025-03-26 Streamable HTTP transport.

### Step 2.1: Start the mock MCP server in a terminal

Write a small driver script to start the mock server:

```bash
cat > /tmp/start-mock.mts << 'EOF'
import { MockMCPServer } from "./test/fixtures/mock-mcp-server.js";

const server = new MockMCPServer();
const { port } = await server.start();
console.log(`Mock MCP server listening on http://127.0.0.1:${port}/mcp`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  await server.stop();
  process.exit(0);
});
EOF
npx tsx /tmp/start-mock.mts
```

Note the port number (e.g., `54321`). Keep this terminal open.

### Step 2.2: Connect to the mock server via MCPManager

In a second terminal, create and run a driver script:

```bash
cat > /tmp/test-connect.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

const PORT = parseInt(process.argv[2] ?? "0");
if (!PORT) { console.error("Usage: npx tsx /tmp/test-connect.mts <port>"); process.exit(1); }

const manager = new MCPManager({
  servers: {
    mock: {
      url: `http://127.0.0.1:${PORT}/mcp`,
      enabled: true,
    },
  },
});

await manager.connectAll();

// Verify connection
const connections = manager.getConnections();
console.log("Connections:", connections.map(c => `${c.name}: ${c.status} (${c.toolCount} tools)`));

// List tools
const tools = manager.getRegisteredTools();
console.log("Tools:", tools.map(t => `${t.namespacedName} — ${t.description}`));

// Call the echo tool
const result = await manager.callTool("mock__echo", { message: "hello world" });
console.log("Echo result:", JSON.stringify(result, null, 2));

await manager.disconnectAll();
console.log("Disconnected.");
EOF
npx tsx /tmp/test-connect.mts <PORT>
```

Replace `<PORT>` with the port from Step 2.1.

**Expected output:**
- Connection shows `mock: connected (3 tools)` (echo, add, slow_echo)
- Tools list shows `mock__echo`, `mock__add`, `mock__slow_echo`
- Echo result contains `{ content: [{ type: "text", text: "hello world" }] }`
- Disconnects cleanly

### Step 2.3: Verify tool call with arguments

```bash
cat > /tmp/test-tool-call.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

const PORT = parseInt(process.argv[2] ?? "0");
const manager = new MCPManager({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});

await manager.connectAll();

// Call the add tool
const result = await manager.callTool("mock__add", { a: 17, b: 25 });
console.log("17 + 25 =", JSON.stringify(result));

await manager.disconnectAll();
EOF
npx tsx /tmp/test-tool-call.mts <PORT>
```

**Expected:** Result contains `42`.

### Step 2.4: Verify unknown tool call fails gracefully

```bash
cat > /tmp/test-unknown-tool.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

const PORT = parseInt(process.argv[2] ?? "0");
const manager = new MCPManager({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});

await manager.connectAll();

try {
  await manager.callTool("mock__nonexistent", {});
  console.log("ERROR: should have thrown");
} catch (err) {
  console.log("Correctly threw:", err.message);
}

await manager.disconnectAll();
EOF
npx tsx /tmp/test-unknown-tool.mts <PORT>
```

**Expected:** Throws MCPError with "Tool not found" message.

---

## Part 3 — Stdio Transport (Phase 1)

### Step 3.1: Verify stdio transport with a subprocess

```bash
cat > /tmp/test-stdio.mts << 'EOF'
import { StdioTransport } from "./src/transport/stdio.js";

const transport = new StdioTransport({
  command: "node",
  args: ["-e", `
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test-stdio", version: "0.1.0" }
            }
          }) + "\\n");
        } else if (msg.method === "tools/list") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [] }
          }) + "\\n");
        }
      } catch {}
    });
  `],
});

await transport.start();

const initResult = await transport.sendRequest("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0" }
});
console.log("Init result:", JSON.stringify(initResult));
console.log("isRunning:", transport.isRunning);

await transport.stop();
console.log("Stopped. isRunning:", transport.isRunning);
EOF
npx tsx /tmp/test-stdio.mts
```

**Expected:**
- Init result shows `serverInfo: { name: "test-stdio" }`
- `isRunning` is `true` before stop, `false` after

---

## Part 4 — SSE Parser (Phase 1)

### Step 4.1: Parse a raw SSE stream

```bash
cat > /tmp/test-sse.mts << 'EOF'
import { SSEParser } from "./src/transport/sse-parser.js";

const events: Array<{ event: string; data: string; id?: string }> = [];
const parser = new SSEParser({
  onEvent: (event, data, id) => events.push({ event, data, id }),
});

const raw = [
  "event: message\n",
  "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n",
  "\n",
  "id: evt-2\n",
  "event: message\n",
  "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":false}}\n",
  "\n",
];

for (const chunk of raw) {
  parser.feed(chunk);
}

console.log("Parsed events:", JSON.stringify(events, null, 2));
console.log("Count:", events.length);
EOF
npx tsx /tmp/test-sse.mts
```

**Expected:** 2 events parsed. Second event has `id: "evt-2"`.

---

## Part 5 — Slash Commands (Phase 1)

### Step 5.1: Test /mcp commands programmatically

```bash
cat > /tmp/test-commands.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";
import { handleMCPCommand } from "./src/commands/mcp-manage.js";

const PORT = parseInt(process.argv[2] ?? "0");
const manager = new MCPManager({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});

await manager.connectAll();

// /mcp servers
console.log("=== /mcp servers ===");
console.log(await handleMCPCommand("servers", manager));

// /mcp tools
console.log("\n=== /mcp tools ===");
console.log(await handleMCPCommand("tools", manager));

// /mcp tools mock
console.log("\n=== /mcp tools mock ===");
console.log(await handleMCPCommand("tools mock", manager));

// /mcp status mock
console.log("\n=== /mcp status mock ===");
console.log(await handleMCPCommand("status mock", manager));

// /mcp help
console.log("\n=== /mcp help ===");
console.log(await handleMCPCommand("help", manager));

// /mcp refresh mock
console.log("\n=== /mcp refresh mock ===");
console.log(await handleMCPCommand("refresh mock", manager));

// /mcp disconnect mock
console.log("\n=== /mcp disconnect mock ===");
console.log(await handleMCPCommand("disconnect mock", manager));

// /mcp servers (should show disconnected)
console.log("\n=== /mcp servers (after disconnect) ===");
console.log(await handleMCPCommand("servers", manager));

await manager.disconnectAll();
EOF
npx tsx /tmp/test-commands.mts <PORT>
```

**Expected:**
- `servers` lists 1 server with "Connected" status and tool count
- `tools` lists 3 tools with `mock__` prefix
- `tools mock` lists the same 3 tools filtered
- `status mock` shows URL, transport, session ID, connected time
- `help` shows all 8 subcommands
- `refresh` re-discovers tools
- `disconnect` confirms disconnection
- After disconnect, `servers` shows "No MCP servers configured"

---

## Part 6 — OAuth 2.1 Authentication (Phase 2)

### Step 6.1: PKCE generation

```bash
cat > /tmp/test-pkce.mts << 'EOF'
import { generatePKCE, generateCodeVerifier, computeCodeChallenge } from "./src/auth/pkce.js";

const pair = await generatePKCE();
console.log("Code verifier length:", pair.codeVerifier.length);
console.log("Code verifier (first 20):", pair.codeVerifier.slice(0, 20) + "...");
console.log("Code challenge:", pair.codeChallenge);
console.log("Method:", pair.codeChallengeMethod);

// Verify deterministic challenge
const challenge2 = await computeCodeChallenge(pair.codeVerifier);
console.log("Same verifier same challenge:", challenge2 === pair.codeChallenge);

// Verify uniqueness
const pair2 = await generatePKCE();
console.log("Two pairs are different:", pair.codeVerifier !== pair2.codeVerifier);
EOF
npx tsx /tmp/test-pkce.mts
```

**Expected:**
- Verifier length is 64
- Challenge is a base64url string (no `+`, `/`, or `=`)
- Method is `S256`
- Same verifier always produces the same challenge
- Two generated pairs are different

### Step 6.2: Token store round-trip

```bash
cat > /tmp/test-tokens.mts << 'EOF'
import { TokenStore } from "./src/auth/token-store.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "testplan-tokens-"));
const store = new TokenStore({ storageDir: dir });

const serverUrl = "https://mcp.example.com/api";

// Store a token
await store.store(serverUrl, {
  access_token: "tok_abc123",
  token_type: "Bearer",
  expires_in: 3600,
  refresh_token: "ref_xyz789",
  scope: "read write",
});
console.log("Stored token.");

// Retrieve
const stored = await store.retrieve(serverUrl);
console.log("Retrieved:", {
  accessToken: stored?.accessToken,
  tokenType: stored?.tokenType,
  hasRefresh: !!stored?.refreshToken,
  scope: stored?.scope,
  serverUrl: stored?.serverUrl,
});

// Get valid token
const valid = await store.getValidToken(serverUrl);
console.log("Valid token:", valid ? valid.slice(0, 10) + "..." : null);

// Needs refresh
const needsRefresh = await store.needsRefresh(serverUrl);
console.log("Needs refresh:", needsRefresh);

// List servers
const servers = await store.listServers();
console.log("Listed servers:", servers);

// Delete
await store.delete(serverUrl);
const afterDelete = await store.retrieve(serverUrl);
console.log("After delete:", afterDelete);

console.log("\nStorage dir:", dir);
EOF
npx tsx /tmp/test-tokens.mts
```

**Expected:**
- Stores and retrieves the token with all fields intact
- `getValidToken` returns the access token (not expired yet)
- `needsRefresh` returns `false` (just created, 1h TTL)
- `listServers` returns `["https://mcp.example.com/api"]`
- After delete, retrieve returns `null`

### Step 6.3: WWW-Authenticate header parsing

```bash
cat > /tmp/test-www-auth.mts << 'EOF'
import { parseWWWAuthenticate } from "./src/auth/discovery.js";

const header1 = 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource" scope="read write"';
const result1 = parseWWWAuthenticate(header1);
console.log("Test 1:", result1);

const header2 = 'Bearer error=insufficient_scope error_description="Need admin scope"';
const result2 = parseWWWAuthenticate(header2);
console.log("Test 2:", result2);

const header3 = 'Bearer';
const result3 = parseWWWAuthenticate(header3);
console.log("Test 3 (empty):", result3);
EOF
npx tsx /tmp/test-www-auth.mts
```

**Expected:**
- Test 1: `resourceMetadataUrl` is the URL, `scope` is `"read write"`
- Test 2: `error` is `"insufficient_scope"`, `errorDescription` is `"Need admin scope"`
- Test 3: All fields are `null`

### Step 6.4: Client registration — pre-registered credentials

```bash
cat > /tmp/test-client-reg.mts << 'EOF'
import { usePreRegistered, buildClientMetadataDocument } from "./src/auth/client-registration.js";

// Pre-registered with secret
const creds1 = usePreRegistered({ clientId: "my-app", clientSecret: "secret123" });
console.log("Pre-registered with secret:", creds1);

// Pre-registered without secret
const creds2 = usePreRegistered({ clientId: "my-public-app" });
console.log("Pre-registered public:", creds2);

// No pre-registered
const creds3 = usePreRegistered({});
console.log("No config:", creds3);

// Build metadata document
const doc = buildClientMetadataDocument("https://example.com/.well-known/client-metadata");
console.log("Metadata doc:", JSON.stringify(doc, null, 2));
EOF
npx tsx /tmp/test-client-reg.mts
```

**Expected:**
- With secret: `tokenEndpointAuthMethod` is `"client_secret_post"`
- Public: `tokenEndpointAuthMethod` is `"none"`
- No config: returns `null`
- Metadata doc: `client_id` matches the URL, `grant_types` includes `"authorization_code"`

### Step 6.5: Callback server lifecycle

```bash
cat > /tmp/test-callback.mts << 'EOF'
import { CallbackServer } from "./src/auth/callback-server.js";

const state = "test-state-12345";
const server = new CallbackServer({ expectedState: state, timeoutMs: 5000 });

const { port, redirectUri } = await server.start();
console.log("Callback server listening on port:", port);
console.log("Redirect URI:", redirectUri);

// Simulate a browser redirect hitting the callback
setTimeout(async () => {
  const url = `http://127.0.0.1:${port}/callback?code=auth_code_abc&state=${state}`;
  console.log("Simulating browser redirect to:", url);
  const response = await fetch(url);
  console.log("Browser got status:", response.status);
  const html = await response.text();
  console.log("Browser got:", html.includes("Authentication Successful") ? "Success page" : "Error page");
}, 500);

const result = await server.waitForCallback();
console.log("Callback result:", result);
EOF
npx tsx /tmp/test-callback.mts
```

**Expected:**
- Server starts on a random port
- Redirect URI is `http://127.0.0.1:<port>/callback`
- Browser simulation gets 200 with "Authentication Successful"
- `waitForCallback` resolves with `{ code: "auth_code_abc", state: "test-state-12345" }`

### Step 6.6: Callback server — state mismatch (CSRF protection)

```bash
cat > /tmp/test-csrf.mts << 'EOF'
import { CallbackServer } from "./src/auth/callback-server.js";

const server = new CallbackServer({ expectedState: "correct-state", timeoutMs: 3000 });
const { port } = await server.start();

// Hit with wrong state
setTimeout(async () => {
  const url = `http://127.0.0.1:${port}/callback?code=abc&state=WRONG-state`;
  const response = await fetch(url);
  console.log("Browser got status:", response.status, "(should be 400)");
}, 200);

try {
  await server.waitForCallback();
  console.log("ERROR: should have thrown");
} catch (err) {
  console.log("Correctly rejected:", err.message);
}
EOF
npx tsx /tmp/test-csrf.mts
```

**Expected:** Browser gets 400, server throws "State mismatch" or times out.

---

## Part 7 — Legacy SSE Transport (Phase 3)

### Step 7.1: Verify legacy transport tests pass in isolation

```bash
npx vitest run test/transport/legacy-sse.test.ts
```

**Expected:** 19 tests pass. The legacy transport follows the 2024-11-05
protocol (GET for SSE, POST for JSON-RPC).

---

## Part 8 — JSON-RPC Batching (Phase 3)

### Step 8.1: Parse a batch response

```bash
cat > /tmp/test-batch.mts << 'EOF'
import { parseBatchResponse } from "./src/jsonrpc.js";

const batch = [
  { jsonrpc: "2.0", id: 1, result: { status: "ok" } },
  { jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Invalid Request" } },
  { jsonrpc: "2.0", id: "abc", result: { data: [1, 2, 3] } },
];

const map = parseBatchResponse(batch);
console.log("Batch size:", map.size);
console.log("ID 1 result:", map.get(1)?.result);
console.log("ID 2 error:", map.get(2)?.error);
console.log("ID 'abc' result:", map.get("abc")?.result);
EOF
npx tsx /tmp/test-batch.mts
```

**Expected:** Map contains 3 entries, correctly indexed by ID.

---

## Part 9 — Health Checks & Retry (Phase 3)

### Step 9.1: Health check a running server

```bash
cat > /tmp/test-health.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

const PORT = parseInt(process.argv[2] ?? "0");
const manager = new MCPManager({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});

await manager.connectAll();

// Health check single server
const result = await manager.healthCheck("mock");
console.log("Health check:", JSON.stringify(result, null, 2));

// Health check all servers
const allResults = await manager.healthCheck();
console.log("All health checks:", JSON.stringify(allResults, null, 2));

await manager.disconnectAll();
EOF
npx tsx /tmp/test-health.mts <PORT>
```

(Requires mock server from Step 2.1 to be running.)

**Expected:**
- Single: `status: "healthy"`, `latencyMs >= 0`, `consecutiveFailures: 0`
- All: Array with 1 entry, same healthy result

### Step 9.2: Health check an unreachable server

Stop the mock server (Ctrl+C in the Step 2.1 terminal), then run:

```bash
cat > /tmp/test-health-down.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

// Port that nothing is listening on
const manager = new MCPManager({
  servers: { dead: { url: "http://127.0.0.1:1/mcp", enabled: true } },
});

try {
  await manager.connectAll();
} catch {}

const result = await manager.healthCheck("dead");
console.log("Health check:", JSON.stringify(result, null, 2));

await manager.disconnectAll();
EOF
npx tsx /tmp/test-health-down.mts
```

**Expected:** `status: "unreachable"`, `consecutiveFailures > 0`.

---

## Part 10 — Config Hot-Reload (Phase 1 + 3)

### Step 10.1: Reconcile config changes

```bash
cat > /tmp/test-reconcile.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";

const PORT = parseInt(process.argv[2] ?? "0");

// Start with one server
const manager = new MCPManager({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});

await manager.connectAll();
console.log("Before reconcile:", manager.getConnections().map(c => c.name));
console.log("Tools:", manager.getRegisteredTools().length);

// Reconcile with an empty config — removes the server
await manager.reconcile({ servers: {} });
console.log("After reconcile (empty):", manager.getConnections().length, "connections");
console.log("Tools:", manager.getRegisteredTools().length);

// Reconcile back with the server
await manager.reconcile({
  servers: { mock: { url: `http://127.0.0.1:${PORT}/mcp`, enabled: true } },
});
console.log("After reconcile (restored):", manager.getConnections().map(c => c.name));
console.log("Tools:", manager.getRegisteredTools().length);

await manager.disconnectAll();
EOF
npx tsx /tmp/test-reconcile.mts <PORT>
```

(Restart mock server from Step 2.1 first.)

**Expected:**
- Before: 1 connection, 3 tools
- After empty reconcile: 0 connections, 0 tools
- After restore: 1 connection, 3 tools again

---

## Part 11 — /mcp connect Command (Phase 2)

### Step 11.1: Connect to a server via the /mcp connect command

```bash
cat > /tmp/test-connect-cmd.mts << 'EOF'
import { MCPManager } from "./src/manager/mcp-manager.js";
import { handleMCPCommand } from "./src/commands/mcp-manage.js";

const PORT = parseInt(process.argv[2] ?? "0");
const manager = new MCPManager({ servers: {} });

// /mcp connect <url> --name myserver
const result = await handleMCPCommand(
  `connect http://127.0.0.1:${PORT}/mcp --name myserver`,
  manager,
);
console.log(result);

// Verify it's connected
console.log(await handleMCPCommand("servers", manager));
console.log(await handleMCPCommand("tools myserver", manager));

await manager.disconnectAll();
EOF
npx tsx /tmp/test-connect-cmd.mts <PORT>
```

**Expected:**
- Connect message: `Connected to server "myserver": 3 tool(s) discovered.`
- Servers list shows `myserver` with "Connected" status

---

## Part 12 — Security Checks (Phase 3)

### Step 12.1: Review the security audit

```bash
cat SECURITY_AUDIT.md
```

Verify the following findings are documented:
- **HIGH:** Token file permissions (needs 0o600/0o700)
- **HIGH:** No HTTPS enforcement on MCP server URLs
- **MEDIUM:** Missing Origin header in HTTP requests
- **WARNINGS:** Token in console log, plaintext secrets, timing on state comparison

### Step 12.2: Verify XSS protection in callback server

```bash
cat > /tmp/test-xss.mts << 'EOF'
import { CallbackServer } from "./src/auth/callback-server.js";

const server = new CallbackServer({ expectedState: "s", timeoutMs: 2000 });
const { port } = await server.start();

// Send an XSS payload in the error param
setTimeout(async () => {
  const url = `http://127.0.0.1:${port}/callback?error=<script>alert(1)</script>&error_description=<img onerror=alert(1)>`;
  const res = await fetch(url);
  const html = await res.text();
  const hasRawScript = html.includes("<script>alert");
  const hasEscaped = html.includes("&lt;script&gt;");
  console.log("Contains raw <script>:", hasRawScript, "(should be false)");
  console.log("Contains escaped &lt;script&gt;:", hasEscaped, "(should be true)");
}, 200);

try { await server.waitForCallback(); } catch {}
EOF
npx tsx /tmp/test-xss.mts
```

**Expected:** HTML entities are escaped. No raw `<script>` in output.

---

## Part 13 — Stress / Edge Cases (Phase 3)

### Step 13.1: Run stress tests in isolation

```bash
npx vitest run test/e2e/stress.test.ts
```

**Expected:** 10 tests pass, including:
- 7 concurrent MCP servers
- Malformed JSON-RPC handling
- Timeout handling
- Mid-stream disconnect
- Rapid connect/disconnect cycles
- Config hot-reload during in-flight calls
- Health check on healthy/unhealthy servers

---

## Part 14 — End-to-End Integration (Phase 1 + 2)

### Step 14.1: Run Phase 1 E2E tests

```bash
npx vitest run test/e2e/phase1.test.ts
```

**Expected:** 28 tests pass covering full connection lifecycle, tool discovery,
tool invocation, session management, and config reconciliation.

### Step 14.2: Run Phase 2 E2E tests

```bash
npx vitest run test/e2e/phase2.test.ts
```

**Expected:** 15 tests pass covering full OAuth flow, token refresh, step-up
authorization, mixed auth servers, and /mcp auth command.

---

## Part 15 — TypeScript Compilation & Exports

### Step 15.1: Verify clean compilation

```bash
npx tsc --noEmit
```

**Expected:** No errors (warnings about pre-existing unused variables are acceptable).

### Step 15.2: Verify public API imports

```bash
cat > /tmp/test-imports.mts << 'EOF'
// Transport layer
import { StreamableHTTPTransport } from "./src/transport/streamable-http.js";
import { StdioTransport } from "./src/transport/stdio.js";
import { LegacySSETransport } from "./src/transport/legacy-sse.js";
import { SSEParser } from "./src/transport/sse-parser.js";

// Auth layer
import { AuthManager } from "./src/auth/auth-manager.js";
import { TokenStore } from "./src/auth/token-store.js";
import { CallbackServer } from "./src/auth/callback-server.js";
import { generatePKCE } from "./src/auth/pkce.js";
import { discoverAuth, parseWWWAuthenticate } from "./src/auth/discovery.js";
import { registerClient, usePreRegistered } from "./src/auth/client-registration.js";

// Manager layer
import { MCPManager } from "./src/manager/mcp-manager.js";
import { ToolRegistry } from "./src/manager/tool-registry.js";

// Commands
import { handleMCPCommand } from "./src/commands/mcp-manage.js";

// JSON-RPC
import { createRequest, createNotification, parseBatchResponse } from "./src/jsonrpc.js";

// Types
import { MCPError } from "./src/types.js";

// Config schema
import { configSchema, MCPServerConfig } from "./src/config-schema.js";

console.log("All imports resolved successfully.");
console.log("Modules loaded:", [
  "StreamableHTTPTransport", "StdioTransport", "LegacySSETransport", "SSEParser",
  "AuthManager", "TokenStore", "CallbackServer", "generatePKCE",
  "discoverAuth", "registerClient", "MCPManager", "ToolRegistry",
  "handleMCPCommand", "createRequest", "parseBatchResponse",
  "MCPError", "configSchema",
].join(", "));
EOF
npx tsx /tmp/test-imports.mts
```

**Expected:** All imports resolve without errors. No missing exports.

---

## Cleanup

Remove temporary test scripts:

```bash
rm -f /tmp/start-mock.mts /tmp/test-*.mts
```

---

## Summary Checklist

| # | Feature | Test | Status |
|---|---------|------|--------|
| 1 | Automated test suite (354 tests) | Part 1 | |
| 2 | Streamable HTTP connect + tools | Part 2 | |
| 3 | Tool call with arguments | Part 2 | |
| 4 | Unknown tool error handling | Part 2 | |
| 5 | Stdio transport | Part 3 | |
| 6 | SSE parser | Part 4 | |
| 7 | /mcp servers, tools, status, help | Part 5 | |
| 8 | /mcp disconnect, refresh | Part 5 | |
| 9 | PKCE generation (S256) | Part 6 | |
| 10 | Token store CRUD | Part 6 | |
| 11 | WWW-Authenticate parsing | Part 6 | |
| 12 | Client registration methods | Part 6 | |
| 13 | OAuth callback server | Part 6 | |
| 14 | CSRF state validation | Part 6 | |
| 15 | Legacy SSE transport | Part 7 | |
| 16 | JSON-RPC batch parsing | Part 8 | |
| 17 | Health check (healthy) | Part 9 | |
| 18 | Health check (unreachable) | Part 9 | |
| 19 | Config hot-reload / reconcile | Part 10 | |
| 20 | /mcp connect command | Part 11 | |
| 21 | Security audit review | Part 12 | |
| 22 | XSS protection | Part 12 | |
| 23 | Stress & edge cases (10 tests) | Part 13 | |
| 24 | Phase 1 E2E (28 tests) | Part 14 | |
| 25 | Phase 2 E2E (15 tests) | Part 14 | |
| 26 | TypeScript compilation | Part 15 | |
| 27 | Public API imports | Part 15 | |
