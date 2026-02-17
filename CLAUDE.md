# OpenClaw HTTP MCP Client Plugin

## Project Overview

This project implements a first-class MCP (Model Context Protocol) client for OpenClaw,
consisting of a **Plugin** (tool extension), **Skill** (SKILL.md), and **Slash Command**
(via skill command-dispatch). It enables OpenClaw agents to connect to remote MCP servers
over Streamable HTTP with full OAuth 2.1 authentication.

## Key Documents

- `SPEC.md` — Full technical specification (transport, auth, architecture)
- `DEVELOPMENT_PLAN.md` — Task breakdown with dependencies and phasing
- `SECURITY_AUDIT.md` — (Phase 3) Security review findings

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js >= 22
- **Test framework:** Vitest
- **Schema validation:** @sinclair/typebox
- **Package manager:** pnpm

## Architecture

```
src/
  index.ts                  — Plugin entry point (ToolPlugin interface)
  config-schema.ts          — TypeBox configuration schema
  types.ts                  — JSON-RPC 2.0 + MCP type definitions
  jsonrpc.ts                — JSON-RPC encode/decode/validate utilities
  manager/
    mcp-manager.ts          — Multi-server connection lifecycle
    tool-registry.ts        — Dynamic tool registration with namespacing
  transport/
    streamable-http.ts      — MCP Streamable HTTP transport (POST/GET/DELETE + SSE)
    sse-parser.ts           — Server-Sent Events stream parser
    stdio.ts                — stdio transport (subprocess management)
    legacy-sse.ts           — Backwards-compat HTTP+SSE (2024-11-05 spec)
  auth/
    auth-manager.ts         — OAuth 2.1 orchestrator
    discovery.ts            — Protected Resource + Auth Server metadata discovery
    pkce.ts                 — PKCE S256 code challenge generation
    client-registration.ts  — Client ID Metadata Docs / Dynamic Client Registration
    token-store.ts          — Encrypted token persistence
    callback-server.ts      — Local HTTP server for OAuth redirects
  commands/
    mcp-manage.ts           — /mcp subcommand handler (servers, tools, auth, etc.)
skills/
  mcp/
    SKILL.md                — Agent-facing skill definition
test/
  fixtures/
    mock-mcp-server.ts      — Test MCP server (Streamable HTTP)
    mock-auth-server.ts     — Test OAuth 2.1 authorization server
  transport/
    sse-parser.test.ts
    streamable-http.test.ts
    stdio.test.ts
    legacy-sse.test.ts
  auth/
    pkce.test.ts
    discovery.test.ts
    client-registration.test.ts
    token-store.test.ts
    auth-manager.test.ts
  manager/
    mcp-manager.test.ts
  e2e/
    phase1.test.ts
    phase2.test.ts
    stress.test.ts
```

## Coding Standards

- Use `import type` for type-only imports
- All public functions MUST have JSDoc with `@param` and `@returns`
- Prefer `async/await` over raw Promises
- Use `AsyncIterable`/`AsyncGenerator` for streaming data
- Error handling: throw typed errors (extend `MCPError` base class)
- No `any` types — use `unknown` and narrow
- Prefer `const` assertions and literal types
- Test files mirror source structure: `src/foo/bar.ts` → `test/foo/bar.test.ts`

## Agent Team Roles

### Developer Agent (`dev`)
- Implements source code in `src/`
- Creates the skill definition in `skills/mcp/SKILL.md`
- Focuses on correctness, performance, and spec compliance
- References `SPEC.md` for all protocol decisions
- MUST NOT write test files (that's qa's job)
- After completing a task, message qa to inform them code is ready for testing
- Follow the task dependency graph in DEVELOPMENT_PLAN.md

### QA Agent (`qa`)
- Writes all test files in `test/`
- Creates mock servers in `test/fixtures/`
- Reviews dev's code for bugs, security issues, and spec violations
- Runs `npm test` after writing tests to verify they pass
- MUST NOT write source code in `src/` (that's dev's job)
- After finding bugs, message dev with specific file:line references
- If tests fail due to implementation bugs, create a new task for dev to fix

### Coordination Rules
1. Dev and QA own separate directories — no cross-editing
2. Dev writes `src/`, QA writes `test/`
3. When dev finishes a component, they message qa: "Task X.Y complete, ready for tests"
4. When qa finds a bug, they message dev: "Bug in src/foo.ts:42 — describe issue"
5. Both agents read SPEC.md for protocol behavior questions
6. Tasks follow the dependency graph — don't start a task until its dependencies are done

## Running Tests

```bash
# All tests
npm test

# Specific test file
npx vitest run test/transport/sse-parser.test.ts

# Watch mode
npx vitest watch

# Coverage
npx vitest run --coverage
```

## MCP Spec Quick Reference

- **Transport spec:** MCP 2025-03-26 Streamable HTTP
- **Auth spec:** MCP draft — OAuth 2.1
- **JSON-RPC:** 2.0 (UTF-8 encoded, newline-delimited for stdio)
- **Session header:** `Mcp-Session-Id`
- **SSE resumability:** `Last-Event-ID` header
- **PKCE:** S256 mandatory
- **Resource indicators:** RFC 8707 `resource` parameter mandatory
- **Protected Resource Metadata:** RFC 9728
- **Auth Server Metadata:** RFC 8414 + OIDC Discovery fallback
