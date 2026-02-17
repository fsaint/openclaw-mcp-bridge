# Getting Started

This guide walks you through installing the MCP Client plugin for OpenClaw, configuring your first MCP server, and using remote tools in your agent sessions.

## Prerequisites

- **OpenClaw** >= 2025.1.0
- **Node.js** >= 22
- **pnpm** (recommended) or npm

## Installation

```bash
git clone https://github.com/fsaint/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
pnpm install
pnpm build
openclaw plugins install ./dist
```

For local development, use `--link` to symlink instead of copying:

```bash
openclaw plugins install --link ./dist
```

After installation, enable the plugin in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mcp-client": {
        "enabled": true,
        "config": {
          "servers": {}
        }
      }
    }
  }
}
```

## Configuring MCP Servers

All server configuration lives in `openclaw.json` under `plugins.entries.mcp-client.config.servers`. Each key is a server name you choose, and the value describes how to connect.

### HTTP Server with API Key

The simplest setup — ideal for services like Tavily that use a static API key.

```json
{
  "plugins": {
    "entries": {
      "mcp-client": {
        "enabled": true,
        "config": {
          "servers": {
            "tavily": {
              "url": "https://mcp.tavily.com/mcp",
              "apiKey": "$TAVILY_API_KEY"
            }
          }
        }
      }
    }
  }
}
```

The `$TAVILY_API_KEY` syntax pulls the value from your environment variable. You can also paste the key directly, but environment variables are strongly recommended for secrets.

### HTTP Server with OAuth 2.1

For servers requiring OAuth authentication (e.g., GitHub MCP):

```json
{
  "servers": {
    "github": {
      "url": "https://mcp.github.com/mcp",
      "auth": {
        "clientId": "your-registered-client-id"
      }
    }
  }
}
```

After adding the server, authenticate by running `/mcp auth github` in your OpenClaw session. This opens your browser for the OAuth consent flow.

For corporate servers with a client secret:

```json
{
  "servers": {
    "corp-api": {
      "url": "https://mcp.internal.corp.com/mcp",
      "auth": {
        "clientId": "openclaw-prod",
        "clientSecret": "$CORP_MCP_SECRET",
        "scopes": ["read", "write"]
      }
    }
  }
}
```

### stdio Server (Local Process)

Run an MCP server as a local subprocess instead of connecting over HTTP:

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "url": "stdio://local"
    }
  }
}
```

The plugin spawns the process and communicates over stdin/stdout using newline-delimited JSON-RPC.

### Multiple Servers

You can configure as many servers as you need. Each one is independent:

```json
{
  "servers": {
    "tavily": {
      "url": "https://mcp.tavily.com/mcp",
      "apiKey": "$TAVILY_API_KEY"
    },
    "github": {
      "url": "https://mcp.github.com/mcp",
      "auth": { "clientId": "my-client-id" }
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "url": "stdio://local"
    }
  }
}
```

## Using MCP Tools

Once configured, MCP tools appear automatically alongside your built-in tools. Every MCP tool is prefixed with its server name to avoid collisions:

```
tavily__search         — Search the web using Tavily
tavily__extract        — Extract content from a URL
github__create_issue   — Create a GitHub issue
github__list_prs       — List pull requests
filesystem__read_file  — Read a file from the filesystem
```

The agent uses these tools like any other — no special syntax required. Just ask the agent to do something, and it will pick the right tool.

### Example Prompts

```
> Search the web for recent news about Rust async runtimes

(Agent calls tavily__search automatically)

> Create a GitHub issue titled "Fix login timeout" in the openclaw/openclaw repo

(Agent calls github__create_issue automatically)
```

## Managing Servers with `/mcp` Commands

The plugin provides a set of slash commands for managing servers at runtime:

| Command | What It Does |
|---------|-------------|
| `/mcp servers` | List all configured servers with connection status |
| `/mcp tools` | List all discovered tools across all servers |
| `/mcp tools <server>` | List tools for a specific server |
| `/mcp status <server>` | Show detailed info for a server (session, auth, uptime) |
| `/mcp connect <url>` | Add a new server at runtime |
| `/mcp disconnect <server>` | Disconnect from a server |
| `/mcp auth <server>` | Start the OAuth authentication flow |
| `/mcp refresh <server>` | Re-discover tools from a server |
| `/mcp help` | Show all available commands |

### Checking Server Status

```
> /mcp servers

MCP Servers (3 configured)
──────────────────────────────────────────────────────────
  tavily          https://mcp.tavily.com/mcp
                  Status: Connected | Auth: API Key | Tools: 2

  github          https://mcp.github.com/mcp
                  Status: Connected | Auth: OAuth | Tools: 14

  filesystem      stdio://npx @mcp/server-filesystem
                  Status: Running | Auth: None | Tools: 6
──────────────────────────────────────────────────────────
```

### Connecting a Server at Runtime

You don't have to edit `openclaw.json` — connect on the fly:

```
> /mcp connect https://mcp.example.com/mcp --name my-server

Connected to server "my-server": 5 tool(s) discovered.
```

Runtime connections persist for the current session. To make them permanent, add them to `openclaw.json`.

### Authenticating with OAuth

When a server requires OAuth, run:

```
> /mcp auth github
```

This opens your browser for the authorization flow. After you approve, the plugin stores the tokens securely in your OS keychain. Tokens auto-refresh — you typically only need to authenticate once.

**Headless environments** (SSH, Docker): If a browser isn't available, the plugin prints the authorization URL. Open it on any device, complete the flow, then pass the code back:

```
> /mcp auth github --code abc123xyz
```

## Authentication Methods

The plugin supports three authentication methods, in order of simplicity:

### 1. No Auth

For local servers or servers on trusted networks. Just provide the URL:

```json
{ "url": "http://localhost:3000/mcp" }
```

Note: `http://` is only allowed for `localhost` and `127.0.0.1`. All remote servers must use `https://`.

### 2. API Key

A static token sent as a `Bearer` header on every request:

```json
{
  "url": "https://mcp.tavily.com/mcp",
  "apiKey": "$TAVILY_API_KEY"
}
```

### 3. OAuth 2.1

Full OAuth flow with PKCE, token refresh, and scope management:

```json
{
  "url": "https://mcp.github.com/mcp",
  "auth": {
    "clientId": "your-client-id"
  }
}
```

The plugin handles the entire OAuth lifecycle automatically:
- Discovers the authorization server via RFC 9728 metadata
- Generates PKCE challenges (S256)
- Opens your browser for consent
- Exchanges authorization codes for tokens
- Refreshes tokens before they expire
- Supports step-up authorization when additional scopes are needed

## Configuration Reference

### Per-Server Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable this server |
| `url` | string | — | MCP server endpoint URL (required) |
| `transport` | `"http"` or `"stdio"` | `"http"` | Transport type |
| `command` | string | — | Command to run (stdio only) |
| `args` | string[] | `[]` | Command arguments (stdio only) |
| `env` | object | `{}` | Environment variables (stdio only) |
| `apiKey` | string | — | Static API key (sent as Bearer token) |
| `auth.clientId` | string | — | Pre-registered OAuth client ID |
| `auth.clientSecret` | string | — | OAuth client secret (confidential clients) |
| `auth.authorizationServerUrl` | string | — | Override the auth server URL |
| `auth.scopes` | string[] | — | Override requested scopes |
| `toolPrefix` | string | server name | Namespace prefix for tools |
| `connectTimeoutMs` | number | `10000` | Connection timeout (ms) |
| `requestTimeoutMs` | number | `30000` | Per-request timeout (ms) |

### Global Options

Set these at the `config` level, alongside `servers`:

```json
{
  "config": {
    "servers": { ... },
    "toolDiscoveryInterval": 300000,
    "maxConcurrentServers": 20,
    "debug": false
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolDiscoveryInterval` | number | `300000` | Re-discover tools interval (ms, default 5 min) |
| `maxConcurrentServers` | number | `20` | Maximum simultaneous connections |
| `debug` | boolean | `false` | Enable debug logging |

## Troubleshooting

### Server shows "Disconnected"

1. Check the server URL is correct: `/mcp status <server>`
2. Verify the server is running and reachable
3. Try reconnecting: `/mcp disconnect <server>` then restart OpenClaw

### Tool calls return 401/403

The server requires authentication. Run `/mcp auth <server>` to start the OAuth flow. If you're using an API key, verify it's correct and not expired.

### Tools aren't showing up

1. Check the server is connected: `/mcp servers`
2. Force a refresh: `/mcp refresh <server>`
3. Verify the server actually exposes tools (some servers only provide resources)

### OAuth flow fails

- Ensure your `clientId` is valid and registered with the authorization server
- Check that port `127.0.0.1` is accessible for the OAuth callback
- In headless environments, use the `--code` flag with `/mcp auth`
- Check if the server requires specific scopes in the `auth.scopes` config

### Connection timeouts

Increase the timeout values in your server config:

```json
{
  "url": "https://slow-server.example.com/mcp",
  "connectTimeoutMs": 30000,
  "requestTimeoutMs": 60000
}
```
