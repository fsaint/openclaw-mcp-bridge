# Spec: HTTP MCP Server Support for OpenClaw

**Status:** Draft
**Date:** 2026-02-16
**Author:** (auto-generated from deep-dive research)

---

## 1. Problem Statement

OpenClaw currently has no native support for connecting to remote MCP (Model Context
Protocol) servers over HTTP. Issue [#13248](https://github.com/openclaw/openclaw/issues/13248)
(open) requests full MCP support. Issue [#8188](https://github.com/openclaw/openclaw/issues/8188)
was closed because the community MCPorter skill exists, but it shells out to a CLI
subprocess with ~2.4s cold-start latency per invocation — unacceptable for real-time use.

A community plugin ([lunarpulse/openclaw-mcp-plugin](https://github.com/lunarpulse/openclaw-mcp-plugin))
demonstrates that the Streamable HTTP transport works, but lacks OAuth 2.1
authentication, proper session management, and is not integrated into the official
distribution.

This spec defines a first-class integration that requires **all three** of OpenClaw's
extension mechanisms: a **Plugin**, a **Skill**, and a **Slash Command** — each serving
a distinct role.

---

## 2. Why We Need a Plugin, a Skill, AND a Slash Command

| Mechanism | Role | Why It's Needed |
|-----------|------|-----------------|
| **Plugin** (Tool Extension) | Core MCP client engine | Plugins are the only mechanism that can register tool slots, manage long-lived connections, hook into the Gateway lifecycle, and hold state (OAuth tokens, sessions). Skills cannot do this. |
| **Skill** (SKILL.md) | Agent-facing instructions | Skills inject system-prompt context telling the agent *how* and *when* to use MCP tools. Without a skill, the agent has no knowledge of MCP servers or their capabilities. |
| **Slash Command** (via Skill invocation control) | User-facing management CLI | Users need `/mcp servers`, `/mcp connect`, `/mcp auth` etc. to manage servers interactively. This is delivered through the skill's `command-dispatch` mode. |

They compose as follows:

```
User types "/mcp servers"
        │
        ▼
  Slash Command (Skill invocation control)
        │  command-dispatch: tool
        ▼
  Skill (SKILL.md)
        │  routes to plugin tool
        ▼
  Plugin (Tool Extension)
        │  MCPManager handles request
        ▼
  Remote MCP Server (Streamable HTTP + OAuth 2.1)
```

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│                                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │  Skill:       │   │  Plugin:      │   │  Config:      │ │
│  │  mcp          │──▶│  mcp-client   │◀──│  openclaw.json│ │
│  │  (SKILL.md)   │   │  (Tool Ext)   │   │              │ │
│  └──────────────┘   └──────┬───────┘   └──────────────┘ │
│                             │                             │
│          ┌─────────────────┼─────────────────┐           │
│          │                 │                 │           │
│          ▼                 ▼                 ▼           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ MCPManager   │ │ AuthManager  │ │ ToolRegistry     │ │
│  │              │ │ (OAuth 2.1)  │ │ (dynamic tools)  │ │
│  └──────┬───────┘ └──────┬───────┘ └──────────────────┘ │
│         │                │                               │
└─────────┼────────────────┼───────────────────────────────┘
          │                │
          ▼                ▼
  ┌──────────────┐ ┌──────────────┐
  │ MCP Server A │ │ Auth Server  │
  │ (Streamable  │ │ (OAuth 2.1)  │
  │  HTTP)       │ │              │
  └──────────────┘ └──────────────┘
```

### 3.1 Components

| Component | Responsibility |
|-----------|---------------|
| **MCPManager** | Manages connections, session lifecycle (Mcp-Session-Id), reconnection, and server health. One logical connection per configured server. |
| **AuthManager** | Implements the full MCP OAuth 2.1 authorization spec: Protected Resource Metadata discovery (RFC 9728), Authorization Server Metadata discovery (RFC 8414 / OIDC), PKCE (S256), Client ID Metadata Documents, Dynamic Client Registration fallback, token storage, refresh, and step-up authorization. |
| **StreamableHTTPTransport** | HTTP POST/GET/DELETE with SSE streaming. Handles JSON-RPC 2.0 message framing, batching, and resumability via Last-Event-ID. |
| **ToolRegistry** | Dynamically registers/unregisters remote tools as OpenClaw agent tools. Merges tool schemas from multiple MCP servers, with namespace prefixing to avoid collisions. |

---

## 4. MCP Streamable HTTP Transport Implementation

Based on the [MCP Transport Spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

### 4.1 Endpoint Model

Each MCP server exposes a single endpoint (e.g., `https://example.com/mcp`). The plugin
communicates via:

| Method | Purpose |
|--------|---------|
| **POST** | Send JSON-RPC requests, notifications, and responses. Every client→server message is a new POST. |
| **GET** | Open an SSE stream for server→client notifications/requests (optional). |
| **DELETE** | Terminate a session (send `Mcp-Session-Id` header). |

### 4.2 Request Format

```http
POST /mcp HTTP/1.1
Host: example.com
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer <access-token>
Mcp-Session-Id: <session-id>

{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
```

### 4.3 Response Handling

The plugin MUST handle both response types:

1. **`Content-Type: application/json`** — single JSON-RPC response
2. **`Content-Type: text/event-stream`** — SSE stream containing one or more JSON-RPC
   messages (responses, notifications, server requests)

### 4.4 Session Management

| Step | Behavior |
|------|----------|
| Initialize | POST `InitializeRequest`. If response includes `Mcp-Session-Id` header, store it. |
| Subsequent requests | Include `Mcp-Session-Id` in all POST/GET/DELETE requests. |
| Session expired (404) | Discard session, re-initialize with new `InitializeRequest`. |
| Client shutdown | Send DELETE with `Mcp-Session-Id` to cleanly terminate. |

### 4.5 Resumability

- The plugin SHOULD track SSE event `id` fields per stream.
- On reconnect to a broken GET stream, include `Last-Event-ID` header.
- The plugin MUST NOT replay messages from different streams.

### 4.6 Backwards Compatibility (HTTP+SSE)

For servers running the older 2024-11-05 spec:

1. Attempt POST `InitializeRequest` to the server URL.
2. If 4xx error, fall back to GET expecting an SSE stream with an `endpoint` event.
3. Use the old HTTP+SSE transport for the remainder of the session.

---

## 5. Authentication (MCP OAuth 2.1)

Based on the [MCP Authorization Spec (draft)](https://modelcontextprotocol.io/specification/draft/basic/authorization).

### 5.1 Auth Flow Overview

```
1. POST request to MCP server → 401 Unauthorized
2. Parse WWW-Authenticate header → extract resource_metadata URL
3. GET Protected Resource Metadata → extract authorization_servers
4. GET Authorization Server Metadata (RFC 8414 / OIDC discovery)
5. Client registration (Client ID Metadata Doc → Dynamic Registration → Pre-registered)
6. Authorization Code + PKCE (S256) + resource parameter
7. Token exchange → access_token (+ refresh_token)
8. Retry original request with Bearer token
```

### 5.2 Supported Client Registration Methods (in priority order)

1. **Pre-registered credentials** — User provides `client_id` (and optionally
   `client_secret`) in config. Used when the user has manually registered an OAuth app.

2. **Client ID Metadata Documents** — The plugin hosts a metadata JSON document at an
   HTTPS URL. The authorization server fetches it to verify the client. This is the
   preferred method for first-time connections.

3. **Dynamic Client Registration (RFC 7591)** — Fallback. POST to the authorization
   server's `registration_endpoint`.

### 5.3 Token Storage

| Item | Storage Location | Encryption |
|------|-----------------|------------|
| Access tokens | `~/.openclaw/mcp/tokens/<server-hash>.json` | Encrypted at rest using OS keychain (macOS Keychain / Linux secret-service / Windows Credential Vault) |
| Refresh tokens | Same file | Same encryption |
| Client credentials | `openclaw.json` (for pre-registered) or auto-managed | User-managed or auto-managed |

### 5.4 Token Lifecycle

```
┌─────────┐    expired     ┌─────────┐   failed    ┌─────────┐
│  Valid   │──────────────▶│ Refresh  │────────────▶│ Re-auth │
│  Token   │               │  Token   │             │  Flow   │
└─────────┘               └─────────┘             └─────────┘
     ▲                         │                        │
     │         success         │                        │
     └─────────────────────────┘                        │
     │                                                  │
     └──────────────────────────────────────────────────┘
```

- On 401: check if token is expired → refresh → re-auth if refresh fails.
- On 403 `insufficient_scope`: step-up authorization with expanded scopes.
- PKCE MUST use S256. If the server doesn't advertise
  `code_challenge_methods_supported`, refuse to proceed.
- The `resource` parameter (RFC 8707) MUST be included in authorization and token
  requests, set to the MCP server's canonical URI.

### 5.5 Security Requirements

- All MCP server URLs MUST be HTTPS (except localhost for development).
- Origin header validation on the server side (DNS rebinding protection).
- Tokens MUST NOT be passed through to upstream APIs (confused deputy prevention).
- Tokens MUST be audience-validated by the MCP server.
- Redirect URIs: `http://127.0.0.1:<port>/callback` for local OAuth flows.

---

## 6. Plugin Implementation

### 6.1 Manifest (`package.json`)

```json
{
  "name": "@openclaw/plugin-mcp-client",
  "version": "1.0.0",
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "slots": ["tool"],
    "configSchema": "./src/config-schema.ts",
    "catalog": {
      "label": "MCP Client",
      "description": "Connect to remote MCP servers via Streamable HTTP with OAuth 2.1 auth"
    }
  },
  "peerDependencies": {
    "openclaw": ">=2025.1.0"
  }
}
```

### 6.2 Configuration Schema

```typescript
import { Type } from "@sinclair/typebox";

const ServerAuthConfig = Type.Object({
  // Pre-registered OAuth credentials (optional)
  clientId: Type.Optional(Type.String()),
  clientSecret: Type.Optional(Type.String()),
  // Override authorization server URL (optional, normally auto-discovered)
  authorizationServerUrl: Type.Optional(Type.String()),
  // Custom scopes to request (optional, normally from WWW-Authenticate)
  scopes: Type.Optional(Type.Array(Type.String())),
});

const MCPServerConfig = Type.Object({
  enabled: Type.Boolean({ default: true }),
  url: Type.String({ format: "uri", description: "MCP server endpoint URL" }),
  transport: Type.Optional(
    Type.Union([Type.Literal("http"), Type.Literal("stdio")], {
      default: "http",
    })
  ),
  // For stdio transport only
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  // Authentication
  auth: Type.Optional(ServerAuthConfig),
  // API key auth (simpler alternative, sent as Bearer token)
  apiKey: Type.Optional(Type.String()),
  // Tool namespace prefix (default: server name)
  toolPrefix: Type.Optional(Type.String()),
  // Connection settings
  connectTimeoutMs: Type.Optional(Type.Number({ default: 10000 })),
  requestTimeoutMs: Type.Optional(Type.Number({ default: 30000 })),
});

export const configSchema = Type.Object({
  servers: Type.Record(Type.String(), MCPServerConfig),
  // Global settings
  toolDiscoveryInterval: Type.Optional(
    Type.Number({ default: 300000, description: "Re-discover tools every N ms" })
  ),
  maxConcurrentServers: Type.Optional(Type.Number({ default: 20 })),
  debug: Type.Optional(Type.Boolean({ default: false })),
});
```

### 6.3 Configuration Example (`openclaw.json`)

```json5
{
  "plugins": {
    "entries": {
      "mcp-client": {
        "enabled": true,
        "config": {
          "servers": {
            "tavily": {
              "enabled": true,
              "url": "https://mcp.tavily.com/mcp",
              "apiKey": "tvly-xxxxx"
            },
            "github-mcp": {
              "enabled": true,
              "url": "https://mcp.github.com/mcp",
              "auth": {
                "clientId": "my-registered-client-id"
              }
            },
            "local-filesystem": {
              "enabled": true,
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
            },
            "private-corp-server": {
              "enabled": true,
              "url": "https://mcp.internal.corp.com/mcp",
              "auth": {
                "clientId": "openclaw-prod",
                "clientSecret": "secret-from-vault",
                "scopes": ["read", "write"]
              }
            }
          }
        }
      }
    }
  }
}
```

### 6.4 Plugin Entry Point

```typescript
import { ToolPlugin } from "openclaw/plugin-sdk";

export const plugin: ToolPlugin = {
  async initialize(context) {
    const config = context.config;
    const mcpManager = new MCPManager(config);
    const authManager = new AuthManager(config);

    // Connect to all enabled servers
    await mcpManager.connectAll(authManager);

    return {
      tools: mcpManager.getRegisteredTools(),

      // Gateway lifecycle hooks
      async onShutdown() {
        await mcpManager.disconnectAll();
      },

      async onConfigChange(newConfig) {
        await mcpManager.reconcile(newConfig, authManager);
      },
    };
  },
};
```

### 6.5 Tool Registration

Each remote MCP tool is registered as an OpenClaw tool with a namespaced name:

```
Remote tool: "search"  on server "tavily"
  → OpenClaw tool: "tavily__search"

Remote tool: "read_file" on server "filesystem"
  → OpenClaw tool: "filesystem__read_file"
```

The tool schema (parameters, description) is pulled directly from the remote server's
`tools/list` response and mapped to OpenClaw's tool schema format.

---

## 7. Skill Implementation

### 7.1 Skill File (`skills/mcp/SKILL.md`)

```markdown
---
name: mcp
description: >
  Manage and interact with remote MCP (Model Context Protocol) servers.
  List servers, check status, connect new servers, and trigger authentication.
user-invocable: true
command-dispatch: tool
command-tool: mcp_manage
command-arg-mode: raw
metadata:
  {
    "openclaw": {
      "requires": {
        "config": ["plugins.entries.mcp-client.enabled"]
      },
      "emoji": "🔌"
    }
  }
---

# MCP Server Management

You have access to remote MCP servers that provide additional tools.
When a user asks you to perform a task, check if any MCP tools are relevant.

## Available MCP Commands

- `/mcp servers` — List all configured MCP servers and their status
- `/mcp tools [server]` — List tools available from MCP servers
- `/mcp connect <url> [--name <name>]` — Connect to a new MCP server
- `/mcp disconnect <name>` — Disconnect from an MCP server
- `/mcp auth <name>` — Trigger OAuth authentication for a server
- `/mcp status <name>` — Show detailed status for a specific server
- `/mcp refresh <name>` — Re-discover tools from a server

## Behavior

When MCP tools are discovered, they appear as regular tools with a
`<server>__<tool>` naming pattern. Use them like any other tool.
If a tool call returns a 401/403 error, inform the user they may need
to run `/mcp auth <server>` to authenticate.
```

### 7.2 Skill Gating

The skill is only loaded when `plugins.entries.mcp-client.enabled` is truthy in
`openclaw.json`, preventing it from appearing when the plugin isn't installed.

---

## 8. Slash Command Implementation

The slash command is delivered through the skill's **command-dispatch** mode, not as a
separate mechanism. When the user types `/mcp <subcommand>`, OpenClaw:

1. Matches the skill by name (`mcp`)
2. Sees `command-dispatch: tool` → bypasses the AI model
3. Invokes the `mcp_manage` tool directly with the raw argument string
4. The plugin's `mcp_manage` tool parses the subcommand and executes

### 8.1 Subcommand Routing

| Command | Action |
|---------|--------|
| `/mcp servers` | List all servers with connection status, auth status, tool count |
| `/mcp tools [server]` | List all discovered tools (optionally filtered by server) |
| `/mcp connect <url>` | Add a new server to config, attempt connection + auth |
| `/mcp disconnect <name>` | Cleanly terminate session, remove from runtime (not config) |
| `/mcp auth <name>` | Initiate OAuth flow: open browser for consent, handle callback |
| `/mcp status <name>` | Show session ID, token expiry, last heartbeat, tool count |
| `/mcp refresh [name]` | Re-run `tools/list` to discover new/removed tools |

### 8.2 Example Output

```
> /mcp servers

MCP Servers (3 configured)
──────────────────────────────────────────────────────────
  tavily          https://mcp.tavily.com/mcp
                  Status: Connected | Auth: API Key | Tools: 2

  github-mcp      https://mcp.github.com/mcp
                  Status: Connected | Auth: OAuth (expires 2h) | Tools: 14

  local-fs        stdio://npx @mcp/server-filesystem
                  Status: Running (PID 48291) | Auth: None | Tools: 6
──────────────────────────────────────────────────────────
```

---

## 9. Authentication Flows (Detailed)

### 9.1 API Key Authentication (Simple Path)

For servers that accept a static API key:

```json
{
  "tavily": {
    "url": "https://mcp.tavily.com/mcp",
    "apiKey": "tvly-xxxxx"
  }
}
```

The plugin sends `Authorization: Bearer tvly-xxxxx` on every request. No OAuth flow.

### 9.2 OAuth 2.1 Authentication (Full Path)

```
Step 1: Initial request → 401 Unauthorized
        Parse WWW-Authenticate:
          Bearer resource_metadata="https://server/.well-known/oauth-protected-resource",
                 scope="tools:read tools:execute"

Step 2: GET resource_metadata URL
        → { "resource": "https://server/mcp",
            "authorization_servers": ["https://auth.server.com"],
            "scopes_supported": ["tools:read", "tools:execute"] }

Step 3: GET https://auth.server.com/.well-known/oauth-authorization-server
        → { "authorization_endpoint": "...",
            "token_endpoint": "...",
            "code_challenge_methods_supported": ["S256"],
            "client_id_metadata_document_supported": true,
            "registration_endpoint": "..." }

Step 4: Client registration (one of):
        a) Use pre-registered client_id from config
        b) Client ID Metadata Document (plugin hosts metadata at HTTPS URL)
        c) Dynamic Client Registration (POST /register)

Step 5: Authorization Code + PKCE
        - Generate code_verifier + code_challenge (S256)
        - Open browser: auth_endpoint?response_type=code
            &client_id=...&redirect_uri=http://127.0.0.1:PORT/callback
            &code_challenge=...&code_challenge_method=S256
            &resource=https://server/mcp
            &scope=tools:read tools:execute
        - User consents in browser
        - Callback with authorization code

Step 6: Token exchange
        POST token_endpoint
          grant_type=authorization_code
          &code=...&code_verifier=...
          &redirect_uri=...&resource=https://server/mcp
        → { "access_token": "...", "refresh_token": "...",
            "expires_in": 3600, "token_type": "Bearer" }

Step 7: Store tokens, retry original MCP request with Bearer token
```

### 9.3 Interactive Auth via `/mcp auth`

When the user runs `/mcp auth github-mcp`:

1. Plugin starts a temporary local HTTP server on `127.0.0.1:<random-port>`.
2. Opens the user's browser to the authorization URL.
3. User authenticates and consents.
4. Browser redirects to `http://127.0.0.1:<port>/callback?code=...`.
5. Plugin exchanges the code for tokens.
6. Local server shuts down.
7. Plugin reports success to the user with token expiry info.

For headless/remote environments (SSH, Docker):

1. Plugin prints the authorization URL to the terminal.
2. User opens it manually in any browser.
3. After consent, user copies the callback URL or code.
4. Plugin accepts the code via `/mcp auth github-mcp --code <code>`.

### 9.4 Token Refresh

- Before each request, check if `access_token` expires within 60 seconds.
- If so, use `refresh_token` to get a new access token.
- If refresh fails (e.g., revoked), trigger re-auth and notify the user.
- For public clients, expect refresh token rotation per OAuth 2.1.

### 9.5 Step-Up Authorization

When a tool call returns 403 with `insufficient_scope`:

1. Parse the required scopes from `WWW-Authenticate`.
2. Initiate a new authorization flow with the expanded scope set.
3. Retry the tool call with the new token.
4. If step-up fails after 2 attempts, report the error to the user.

---

## 10. Error Handling

| Scenario | Behavior |
|----------|----------|
| Server unreachable | Mark server as `disconnected`. Retry with exponential backoff (1s, 2s, 4s, ... max 60s). Surface error to agent after 3 retries. |
| 401 Unauthorized | Trigger token refresh → re-auth flow → surface to user. |
| 403 Forbidden | Attempt step-up auth → surface to user if scopes cannot be obtained. |
| 404 (session expired) | Discard session. Re-initialize with new `InitializeRequest`. |
| SSE stream disconnected | Reconnect with `Last-Event-ID`. Do NOT interpret as cancellation. |
| Malformed JSON-RPC | Log error, skip message, continue processing stream. |
| Tool call timeout | Cancel after `requestTimeoutMs`. Send MCP `CancelledNotification`. |
| Server returns unknown tool | Remove tool from registry, notify agent. |

---

## 11. Agent Integration

### 11.1 Tool Presentation

Remote MCP tools appear in the agent's tool list identically to native tools:

```
Available tools:
  ...native tools...
  tavily__search          — Search the web using Tavily
  tavily__extract         — Extract content from a URL
  github__create_issue    — Create a GitHub issue
  github__list_prs        — List pull requests
  filesystem__read_file   — Read a file from the filesystem
  ...
```

### 11.2 Tool Call Flow

```
Agent decides to call "tavily__search"
  → Plugin parses prefix → routes to "tavily" server
  → POST to https://mcp.tavily.com/mcp
    {"jsonrpc":"2.0","id":42,"method":"tools/call",
     "params":{"name":"search","arguments":{"query":"..."}}}
  → Response streamed via SSE or returned as JSON
  → Plugin maps response back to agent tool result format
```

### 11.3 Context Injection

The skill injects into the system prompt:

```xml
<available-mcp-servers>
  <server name="tavily" tools="2" status="connected"/>
  <server name="github-mcp" tools="14" status="connected"/>
</available-mcp-servers>
```

This gives the agent awareness of available servers without listing every tool
(tools are listed via the standard tool registry).

---

## 12. Configuration Reference

### 12.1 Per-Server Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this server |
| `url` | string | — | MCP server endpoint URL (required for HTTP) |
| `transport` | `"http"` \| `"stdio"` | `"http"` | Transport type |
| `command` | string | — | Command to run (stdio only) |
| `args` | string[] | `[]` | Command arguments (stdio only) |
| `env` | Record | `{}` | Environment variables (stdio only) |
| `auth.clientId` | string | — | Pre-registered OAuth client ID |
| `auth.clientSecret` | string | — | OAuth client secret (confidential clients) |
| `auth.authorizationServerUrl` | string | — | Override auth server URL |
| `auth.scopes` | string[] | — | Override requested scopes |
| `apiKey` | string | — | Static API key (sent as Bearer token) |
| `toolPrefix` | string | server name | Namespace prefix for tools |
| `connectTimeoutMs` | number | `10000` | Connection timeout |
| `requestTimeoutMs` | number | `30000` | Per-request timeout |

### 12.2 Global Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolDiscoveryInterval` | number | `300000` | Re-discover tools interval (ms) |
| `maxConcurrentServers` | number | `20` | Max simultaneous server connections |
| `debug` | boolean | `false` | Enable debug logging |

---

## 13. File/Directory Layout

```
extensions/mcp-client/
├── package.json                     # Plugin manifest
├── src/
│   ├── index.ts                     # Plugin entry point (ToolPlugin)
│   ├── config-schema.ts             # TypeBox config schema
│   ├── manager/
│   │   ├── mcp-manager.ts           # Server connection lifecycle
│   │   └── tool-registry.ts         # Dynamic tool registration
│   ├── transport/
│   │   ├── streamable-http.ts       # Streamable HTTP transport
│   │   ├── sse-parser.ts            # SSE stream parser
│   │   ├── stdio.ts                 # stdio transport (subprocess)
│   │   └── legacy-sse.ts            # Backwards-compat HTTP+SSE
│   ├── auth/
│   │   ├── auth-manager.ts          # OAuth 2.1 orchestrator
│   │   ├── discovery.ts             # Resource/AS metadata discovery
│   │   ├── pkce.ts                  # PKCE S256 code challenge
│   │   ├── client-registration.ts   # Client ID Metadata / DCR
│   │   ├── token-store.ts           # Encrypted token persistence
│   │   └── callback-server.ts       # Local HTTP server for OAuth redirect
│   ├── commands/
│   │   └── mcp-manage.ts            # /mcp subcommand handler
│   └── types.ts                     # Shared TypeScript types
├── skills/
│   └── mcp/
│       └── SKILL.md                 # Agent-facing skill definition
└── test/
    ├── transport.test.ts
    ├── auth.test.ts
    ├── manager.test.ts
    └── fixtures/
        ├── mock-mcp-server.ts       # Test MCP server
        └── mock-auth-server.ts      # Test OAuth server
```

---

## 14. Security Considerations

1. **HTTPS only** for remote servers (localhost exempt for dev).
2. **Token isolation** — tokens for server A are never sent to server B.
3. **No token passthrough** — the plugin never forwards client tokens to upstream APIs.
4. **Audience validation** — tokens are bound to specific MCP server URIs via RFC 8707.
5. **PKCE required** — S256 method mandatory; refuse servers that don't support it.
6. **Origin validation** — the plugin sets appropriate Origin headers; servers should validate.
7. **Encrypted token storage** — OS keychain integration for token-at-rest encryption.
8. **Redirect URI binding** — only `127.0.0.1` (not `0.0.0.0`) for OAuth callbacks.
9. **Config secrets** — `apiKey` and `clientSecret` values should be sourced from
   environment variables or secret managers, not hardcoded. The config supports
   `$ENV_VAR` substitution syntax per OpenClaw convention.
10. **Rate limiting** — respect server rate limits; implement client-side backoff.

---

## 15. Testing Strategy

| Layer | Approach |
|-------|----------|
| **Unit** | Transport encoding/decoding, PKCE generation, SSE parsing, token refresh logic |
| **Integration** | Mock MCP server + mock OAuth server. Test full connect→auth→discover→call→disconnect cycle. |
| **E2E** | Connect to a real public MCP server (e.g., Tavily, or a test server). Verify tool discovery and invocation. |
| **Security** | Test token isolation, audience validation, PKCE enforcement, reject non-HTTPS. |
| **Backwards compat** | Test against HTTP+SSE (2024-11-05 spec) server. |

---

## 16. Rollout Plan

### Phase 1: Core Transport + API Key Auth
- Streamable HTTP transport (POST/GET/SSE)
- Session management (Mcp-Session-Id)
- API key authentication (Bearer token)
- Tool discovery and registration
- `/mcp servers`, `/mcp tools`, `/mcp status`
- stdio transport support

### Phase 2: OAuth 2.1 Authentication
- Protected Resource Metadata discovery
- Authorization Server Metadata discovery
- Client ID Metadata Documents
- Dynamic Client Registration fallback
- PKCE (S256)
- Token storage + refresh
- `/mcp auth`, `/mcp connect`
- Step-up authorization (scope escalation)

### Phase 3: Production Hardening
- Backwards compatibility with HTTP+SSE (2024-11-05)
- SSE resumability (Last-Event-ID)
- JSON-RPC batching support
- Connection pooling and health checks
- Metrics / OpenTelemetry integration
- ClawHub publish as community skill

---

## 17. Open Questions

1. **Tool approval gates** — Should MCP tool calls go through OpenClaw's approval system
   (like the Lobster tool extension), or execute directly? Recommendation: direct for
   read-only tools, approval for write/execute tools.

2. **Per-agent MCP servers** — Should different agents have different MCP server configs?
   The plugin config is global, but `agents.defaults.mcp` could override per agent.

3. **MCP server as provider** — Some MCP servers expose `sampling` capabilities (they can
   call an LLM). Should we support this? Recommendation: defer to Phase 4.

4. **Resource subscriptions** — MCP supports `resources/subscribe` for watching resource
   changes. Implement in Phase 3 or defer?

5. **Client ID Metadata hosting** — For the Client ID Metadata Document flow, where does
   OpenClaw host the metadata JSON? Options: (a) bundled static file served by Gateway,
   (b) hosted on openclaw.ai, (c) user provides their own URL.

---

## 18. References

- [MCP Streamable HTTP Transport Spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP Authorization Spec (draft)](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [OpenClaw Skills Documentation](https://docs.openclaw.ai/tools/skills)
- [OpenClaw Plugin Architecture (DeepWiki)](https://deepwiki.com/openclaw/openclaw/10-extensions-and-plugins)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Feature Request: Full MCP Support (#13248)](https://github.com/openclaw/openclaw/issues/13248)
- [Feature Request: MCP Client Support (#8188)](https://github.com/openclaw/openclaw/issues/8188)
- [Community MCP Plugin (lunarpulse)](https://github.com/lunarpulse/openclaw-mcp-plugin)
- [OAuth 2.1 Draft (draft-ietf-oauth-v2-1-13)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 8414 — OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [RFC 7591 — Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 8707 — Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)
- [MCP Transport Future (Blog)](http://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/)
