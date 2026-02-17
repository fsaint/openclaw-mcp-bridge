# Development Plan: HTTP MCP Server for OpenClaw

## Agent Team Structure

| Role | Agent Name | Responsibility |
|------|-----------|----------------|
| **Lead** | You (the human) | Coordinates via Claude Code, reviews output |
| **Developer** | `dev` | Implements features, writes source code |
| **QA** | `qa` | Writes tests, reviews code for bugs/security, validates spec compliance |

## Phase 1: Core Transport + API Key Auth

### Task 1.1 — Project Scaffold (dev)
- Initialize `package.json` with TypeScript, vitest, `@sinclair/typebox`
- Create `tsconfig.json`
- Set up `openclaw.plugin.json` manifest
- Wire up the config schema (`src/config-schema.ts`)
- **Deliverable:** `npm run build` succeeds with empty entry point

### Task 1.2 — JSON-RPC Types & Utilities (dev)
- Define JSON-RPC 2.0 types: Request, Response, Notification, Error, Batch
- Create `src/types.ts` with all MCP-specific types (InitializeRequest,
  InitializeResult, ToolsListResult, ToolsCallResult, etc.)
- Create `src/jsonrpc.ts` with encode/decode/validate helpers
- **Deliverable:** Typed JSON-RPC message construction and parsing

### Task 1.3 — Test Fixtures: Mock MCP Server (qa)
- Create `test/fixtures/mock-mcp-server.ts`: a minimal MCP server that
  responds to `initialize`, `tools/list`, and `tools/call`
- Support both `application/json` and `text/event-stream` responses
- Support `Mcp-Session-Id` header
- **Deliverable:** Running test server on localhost for integration tests

### Task 1.4 — SSE Parser (dev)
- Implement `src/transport/sse-parser.ts`
- Parse `text/event-stream` per the SSE specification
- Handle `event`, `data`, `id`, `retry` fields
- Support multi-line `data` fields
- Emit parsed events as an async iterable
- **Deliverable:** SSE parser with unit tests

### Task 1.5 — SSE Parser Tests (qa)
- Unit tests for SSE parser: single events, multi-line data, event IDs,
  retry fields, malformed input, empty lines, UTF-8
- **Deliverable:** `test/transport/sse-parser.test.ts` — all passing

### Task 1.6 — Streamable HTTP Transport (dev)
- Implement `src/transport/streamable-http.ts`
- POST: send JSON-RPC messages, handle `application/json` and SSE responses
- GET: open SSE stream for server-initiated messages
- DELETE: terminate session
- Headers: `Accept`, `Content-Type`, `Mcp-Session-Id`, `Authorization`, `Last-Event-ID`
- Session management: store session ID from InitializeResult, send on all
  subsequent requests, handle 404 (session expired) with re-init
- Reconnect logic for broken SSE streams with `Last-Event-ID`
- **Deliverable:** `StreamableHTTPTransport` class with full lifecycle

### Task 1.7 — Transport Integration Tests (qa)
- Tests against mock MCP server:
  - Connect + initialize + receive session ID
  - tools/list discovery
  - tools/call with JSON response
  - tools/call with SSE streaming response
  - Session expiry (404) → automatic re-initialization
  - Broken SSE stream → reconnect with Last-Event-ID
  - Connection timeout handling
  - Malformed response handling
- **Deliverable:** `test/transport/streamable-http.test.ts` — all passing

### Task 1.8 — stdio Transport (dev)
- Implement `src/transport/stdio.ts`
- Spawn subprocess with configurable `command`, `args`, `env`
- Newline-delimited JSON-RPC over stdin/stdout
- Capture stderr for logging
- Handle process exit/crash with restart logic
- **Deliverable:** `StdioTransport` class

### Task 1.9 — stdio Transport Tests (qa)
- Test with a simple echo MCP server script
- Process spawn, message exchange, crash recovery, clean shutdown
- **Deliverable:** `test/transport/stdio.test.ts` — all passing

### Task 1.10 — Tool Registry (dev)
- Implement `src/manager/tool-registry.ts`
- Convert MCP `tools/list` results to OpenClaw tool schema format
- Namespace tools with `<server>__<tool>` prefix
- Handle tool additions, removals, and schema changes on re-discovery
- Periodic re-discovery on configurable interval
- **Deliverable:** `ToolRegistry` class

### Task 1.11 — MCP Manager (dev)
- Implement `src/manager/mcp-manager.ts`
- Manages multiple server connections (Map<string, Connection>)
- `connectAll()`: connect to all enabled servers from config
- `disconnect(name)`: cleanly terminate one server
- `disconnectAll()`: terminate all servers
- `reconcile(newConfig)`: diff old/new config, connect/disconnect as needed
- `callTool(namespacedTool, args)`: route to correct server, execute
- Health check / heartbeat per connection
- **Deliverable:** `MCPManager` class

### Task 1.12 — Manager Integration Tests (qa)
- Multi-server connect/disconnect
- Tool routing to correct server
- Config reconciliation (add/remove servers at runtime)
- Server health check and failure recovery
- **Deliverable:** `test/manager/mcp-manager.test.ts` — all passing

### Task 1.13 — Plugin Entry Point (dev)
- Implement `src/index.ts` as OpenClaw `ToolPlugin`
- Wire up MCPManager + ToolRegistry
- Expose discovered tools as OpenClaw agent tools
- Implement `onShutdown` and `onConfigChange` lifecycle hooks
- API Key auth: if `apiKey` is set, send as `Authorization: Bearer <key>`
- **Deliverable:** Plugin loads in OpenClaw, tools appear in agent tool list

### Task 1.14 — Slash Command Handler (dev)
- Implement `src/commands/mcp-manage.ts`
- Parse subcommands: `servers`, `tools`, `status`, `connect`, `disconnect`, `refresh`
- Format output as readable tables/text
- Wire into the plugin as the `mcp_manage` tool
- **Deliverable:** `/mcp servers` and `/mcp tools` work

### Task 1.15 — Skill Definition (dev)
- Create `skills/mcp/SKILL.md` with YAML frontmatter
- Define command-dispatch mode pointing to `mcp_manage` tool
- Write agent instructions for MCP tool awareness
- Gate on `plugins.entries.mcp-client.enabled`
- **Deliverable:** Skill loads, `/mcp` commands dispatch correctly

### Task 1.16 — Phase 1 End-to-End Test (qa)
- Full E2E: config → plugin load → connect to mock server → discover tools
  → agent calls tool → response returned → `/mcp servers` shows status
- API key auth E2E: server requires Bearer token, plugin sends it
- Slash commands E2E: `/mcp servers`, `/mcp tools`, `/mcp status`
- **Deliverable:** `test/e2e/phase1.test.ts` — all passing

---

## Phase 2: OAuth 2.1 Authentication

### Task 2.1 — PKCE Module (dev)
- Implement `src/auth/pkce.ts`
- Generate `code_verifier` (43-128 chars, URL-safe)
- Compute `code_challenge` using S256 (SHA-256 + base64url)
- **Deliverable:** PKCE generation with unit tests

### Task 2.2 — PKCE Tests (qa)
- Verify S256 challenge computation against known vectors
- Verify verifier length and character set
- **Deliverable:** `test/auth/pkce.test.ts`

### Task 2.3 — Metadata Discovery (dev)
- Implement `src/auth/discovery.ts`
- Parse `WWW-Authenticate` header from 401 response:
  extract `resource_metadata` URL and `scope`
- Fetch Protected Resource Metadata (RFC 9728):
  well-known URI construction with path component fallback
- Fetch Authorization Server Metadata (RFC 8414 / OIDC):
  try OAuth 2.0 AS metadata endpoints, then OIDC endpoints, in priority order
- Validate `code_challenge_methods_supported` includes S256
- **Deliverable:** `discoverAuth(serverUrl, wwwAuthHeader)` returns
  `{ resourceMetadata, authServerMetadata }`

### Task 2.4 — Discovery Tests (qa)
- Test fixture: mock auth server with `.well-known` endpoints
- Test WWW-Authenticate header parsing (with/without resource_metadata)
- Test well-known URI construction for root and path-based servers
- Test RFC 8414 → OIDC fallback sequence
- Test rejection when S256 not supported
- **Deliverable:** `test/auth/discovery.test.ts`

### Task 2.5 — Client Registration (dev)
- Implement `src/auth/client-registration.ts`
- Pre-registered: use `clientId`/`clientSecret` from config
- Client ID Metadata Documents: construct metadata JSON,
  serve from a known URL (or use pre-configured URL)
- Dynamic Client Registration (RFC 7591): POST to `registration_endpoint`
- Priority: pre-registered → Client ID Metadata → DCR
- **Deliverable:** `registerClient(authServerMetadata, config)` returns
  `{ clientId, clientSecret? }`

### Task 2.6 — Client Registration Tests (qa)
- Test all three registration paths
- Test priority fallback logic
- Test error handling (registration denied, network failure)
- **Deliverable:** `test/auth/client-registration.test.ts`

### Task 2.7 — OAuth Callback Server (dev)
- Implement `src/auth/callback-server.ts`
- Start temporary HTTP server on `127.0.0.1:<random-port>`
- Listen for OAuth redirect with authorization code
- Extract `code` and `state` parameters, validate state
- Return success HTML page to browser, shut down server
- Support headless mode: print URL, accept `--code` parameter
- **Deliverable:** `CallbackServer` class

### Task 2.8 — Token Store (dev)
- Implement `src/auth/token-store.ts`
- Store/retrieve tokens per server (keyed by server URL hash)
- File-based storage at `~/.openclaw/mcp/tokens/<hash>.json`
- Encrypt at rest using OS keychain when available,
  fall back to file-based encryption with machine key
- Token refresh: detect expiry, use refresh_token, handle rotation
- **Deliverable:** `TokenStore` class

### Task 2.9 — Token Store Tests (qa)
- Store, retrieve, refresh, expire, delete tokens
- Test encryption round-trip
- Test concurrent access safety
- **Deliverable:** `test/auth/token-store.test.ts`

### Task 2.10 — Auth Manager (dev)
- Implement `src/auth/auth-manager.ts`
- Orchestrates the full OAuth 2.1 flow:
  1. Detect 401 → discover metadata → register client → PKCE →
     open browser → callback → token exchange → store tokens
  2. On 403 `insufficient_scope`: step-up authorization
  3. On token expiry: refresh → re-auth
- Include `resource` parameter (RFC 8707) in auth and token requests
- Integrate with `StreamableHTTPTransport` as auth middleware
- **Deliverable:** `AuthManager` class that wraps transport with auth

### Task 2.11 — Auth Integration Tests (qa)
- Test fixture: mock OAuth authorization server
  (discovery endpoints, authorize endpoint, token endpoint)
- Full auth flow E2E: 401 → discover → register → authorize → token → retry
- Token refresh flow
- Step-up authorization (403 → re-auth with expanded scopes)
- Expired session + expired token recovery
- Reject servers without S256 PKCE support
- **Deliverable:** `test/auth/auth-manager.test.ts`

### Task 2.12 — `/mcp auth` and `/mcp connect` Commands (dev)
- Add `auth` subcommand to `src/commands/mcp-manage.ts`:
  trigger OAuth flow for a named server
- Add `connect` subcommand: add server to runtime config, connect, auth
- Support `--code <code>` for headless auth
- **Deliverable:** `/mcp auth github` and `/mcp connect https://...` work

### Task 2.13 — Phase 2 End-to-End Test (qa)
- Full E2E with OAuth: config server requiring auth → plugin triggers auth
  flow → mock browser consent → token obtained → tool call succeeds
- Token refresh E2E: token expires mid-session → auto-refresh → tool call
  continues
- Step-up E2E: tool call returns 403 → step-up → new token → retry succeeds
- Mixed auth E2E: one server with API key, one with OAuth, both work
- **Deliverable:** `test/e2e/phase2.test.ts` — all passing

---

## Phase 3: Production Hardening

### Task 3.1 — Backwards-Compatible HTTP+SSE Transport (dev)
- Implement `src/transport/legacy-sse.ts`
- Support the 2024-11-05 HTTP+SSE transport:
  GET to open SSE, receive `endpoint` event, POST to that endpoint
- Auto-detection: POST InitializeRequest → if 4xx, fall back to legacy
- **Deliverable:** `LegacySSETransport` class

### Task 3.2 — Legacy Transport Tests (qa)
- Mock legacy MCP server
- Auto-detection test: try Streamable HTTP, fall back to legacy
- Full lifecycle on legacy transport
- **Deliverable:** `test/transport/legacy-sse.test.ts`

### Task 3.3 — JSON-RPC Batching (dev)
- Support sending and receiving batched JSON-RPC messages
- Batch responses: match by `id` to pending requests
- **Deliverable:** Batching support in transport layer

### Task 3.4 — Connection Health & Retry (dev)
- Exponential backoff for reconnection (1s, 2s, 4s, ... max 60s)
- Server health status tracking (connected/disconnected/error)
- Configurable retry limits
- **Deliverable:** Robust connection management

### Task 3.5 — Security Audit (qa)
- Review all auth code paths for token leakage
- Verify tokens are never sent to wrong server (audience isolation)
- Verify no token passthrough to upstream APIs
- Verify HTTPS enforcement (except localhost)
- Verify PKCE S256 enforcement
- Verify Origin header is set correctly
- Verify redirect URI uses 127.0.0.1 only
- **Deliverable:** `SECURITY_AUDIT.md` with findings

### Task 3.6 — Stress & Edge Case Tests (qa)
- 20 concurrent MCP servers
- Server that sends malformed JSON-RPC
- Server that never responds (timeout)
- Server that drops connection mid-stream
- Rapid connect/disconnect cycles
- Config hot-reload while tools are in-flight
- **Deliverable:** `test/e2e/stress.test.ts`

---

## Task Dependency Graph

```
Phase 1:
  1.1 (scaffold) ──┬──▶ 1.2 (types) ──┬──▶ 1.4 (SSE parser) ──▶ 1.6 (HTTP transport)
                    │                   │                              │
                    │                   └──▶ 1.8 (stdio transport)    │
                    │                                                  │
                    └──▶ 1.3 (mock server)                            │
                                │                                      │
                                ├──▶ 1.5 (SSE tests)                  │
                                │                                      ▼
                                ├──▶ 1.7 (transport tests)    1.10 (tool registry)
                                │                                      │
                                └──▶ 1.9 (stdio tests)        1.11 (MCP manager)
                                                                       │
                                                               1.12 (manager tests)
                                                                       │
                                                               1.13 (plugin entry)
                                                                  │         │
                                                          1.14 (commands)  1.15 (skill)
                                                                  │         │
                                                               1.16 (E2E tests)

Phase 2:
  2.1 (PKCE) ──▶ 2.3 (discovery) ──▶ 2.5 (registration) ──▶ 2.7 (callback)
       │              │                     │                      │
       ▼              ▼                     ▼                      ▼
  2.2 (tests)    2.4 (tests)          2.6 (tests)           2.8 (token store)
                                                                   │
                                                              2.9 (tests)
                                                                   │
                                                             2.10 (auth manager)
                                                                   │
                                                             2.11 (auth tests)
                                                                   │
                                                             2.12 (commands)
                                                                   │
                                                             2.13 (E2E tests)

Phase 3:
  3.1 (legacy) ──▶ 3.2 (tests)
  3.3 (batching)
  3.4 (health/retry)
  3.5 (security audit)
  3.6 (stress tests)
```
