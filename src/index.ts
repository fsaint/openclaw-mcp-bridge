/**
 * Plugin entry point for the OpenClaw MCP client plugin.
 *
 * Implements the OpenClaw plugin SDK contract: exports a default object
 * with a `register(api)` function that registers MCP tools via
 * `api.registerTool()`.
 *
 * Each remote MCP tool is registered as a first-class OpenClaw tool with its
 * own TypeBox parameter schema — no meta-dispatcher needed. The model calls
 * `reins__gmail_search` directly with typed arguments, just like any native tool.
 *
 * Connection to MCP servers happens eagerly in a background promise so that
 * `register()` can remain synchronous. Tools are available as soon as the
 * first agent prompt is built (well before the first tool call).
 *
 * @see SPEC.md section 6.4 for the plugin entry point specification.
 */

import { Type, type TSchema, type TProperties } from "@sinclair/typebox";
import { MCPManager } from "./manager/mcp-manager.js";
import type { MCPManagerConfig } from "./manager/mcp-manager.js";
import type { ConfigSchemaType } from "./config-schema.js";
import type { MCPToolInput } from "./types.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin API types (mirrors openclaw/plugin-sdk + pi-agent-core)
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };

interface AgentToolResult {
  content: TextContent[];
  details: unknown;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult>;
}

interface PluginApi {
  readonly id: string;
  readonly pluginConfig: ConfigSchemaType;
  readonly logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerTool: (tool: AgentTool, opts?: { name?: string }) => void;
  registerHook: (
    events: string | string[],
    handler: (...args: unknown[]) => void,
    opts?: Record<string, unknown>
  ) => void;
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeBox converter
// ---------------------------------------------------------------------------

/**
 * Convert a primitive JSON Schema type string to a TypeBox TSchema.
 * Preserves the description for the model.
 */
function primitiveToTypeBox(
  s: { type?: string; description?: string; enum?: unknown[]; items?: { type?: string } },
  opts: { description?: string }
): TSchema {
  if (s.enum && s.enum.length > 0) {
    // Enum: union of literals
    const literals = s.enum.map((v) => Type.Literal(v as string | number | boolean));
    return literals.length === 1 ? literals[0] : Type.Union(literals, opts);
  }

  switch (s.type) {
    case "string":  return Type.String(opts);
    case "number":
    case "integer": return Type.Number(opts);
    case "boolean": return Type.Boolean(opts);
    case "array":   return Type.Array(Type.Unknown(), opts);
    case "object":  return Type.Record(Type.String(), Type.Unknown(), opts);
    default:        return Type.Unknown(opts);
  }
}

/**
 * Build a TypeBox Object schema from an MCP tool's JSON Schema inputSchema.
 *
 * Required fields become plain TypeBox types; optional fields are wrapped in
 * Type.Optional(). Tools with no declared properties accept an empty object.
 */
function buildTypeBoxSchema(inputSchema: MCPToolInput): ReturnType<typeof Type.Object> {
  const properties = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);

  if (Object.keys(properties).length === 0) {
    return Type.Object({});
  }

  const props: TProperties = {};

  for (const [key, rawSchema] of Object.entries(properties)) {
    const s = rawSchema as {
      type?: string;
      description?: string;
      enum?: unknown[];
      items?: { type?: string };
    };
    const opts = s.description ? { description: s.description } : {};
    const t = primitiveToTypeBox(s, opts);
    props[key] = required.has(key) ? t : Type.Optional(t);
  }

  return Type.Object(props);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toManagerConfig(config: ConfigSchemaType): MCPManagerConfig {
  return {
    servers: config.servers,
    toolDiscoveryInterval: config.toolDiscoveryInterval,
    maxConcurrentServers: config.maxConcurrentServers,
    debug: config.debug,
  };
}

function makeToolResult(result: unknown): AgentToolResult {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }], details: result };
}

function makeErrorResult(toolName: string, err: unknown): AgentToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error calling ${toolName}: ${message}` }],
    details: { error: message },
  };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * Register function called synchronously by OpenClaw's plugin runtime.
 *
 * Starts MCP server connections eagerly in a background promise. Once each
 * server responds to `tools/list`, its tools are registered as individual
 * first-class OpenClaw tools (e.g. `reins__gmail_search`) with full TypeBox
 * parameter schemas.
 *
 * @param api - The OpenClaw plugin API.
 */
function register(api: PluginApi): void {
  const config = api.pluginConfig;
  if (!config?.servers || Object.keys(config.servers).length === 0) {
    return;
  }

  const mcpManager = new MCPManager(toManagerConfig(config));

  // Connect eagerly in the background — tools are registered once available.
  // This fires before the first agent prompt is built, so tools are ready
  // before the model ever needs to call them.
  mcpManager
    .connectAll()
    .then(() => {
      const registeredTools = mcpManager.getRegisteredTools();

      for (const rt of registeredTools) {
        const schema = buildTypeBoxSchema(rt.inputSchema as MCPToolInput);

        api.registerTool({
          name: rt.namespacedName,
          label: rt.description.slice(0, 60) || rt.namespacedName,
          description: rt.description,
          parameters: schema,
          async execute(_toolCallId, params) {
            try {
              const result = await mcpManager.callTool(
                rt.namespacedName,
                params as Record<string, unknown>
              );
              return makeToolResult(result);
            } catch (err) {
              return makeErrorResult(rt.namespacedName, err);
            }
          },
        });
      }

      api.logger.info(
        `mcp-bridge: registered ${registeredTools.length} tools from ${mcpManager.getConnections().length} server(s)`
      );
    })
    .catch((err: unknown) => {
      api.logger.error(
        `mcp-bridge: failed to connect to MCP servers — ${err instanceof Error ? err.message : String(err)}`
      );
    });

  // Graceful shutdown
  api.registerHook(
    "gateway_stop",
    async () => {
      await mcpManager.disconnectAll();
    },
    { name: "mcp-bridge-shutdown", description: "Disconnect all MCP servers on gateway stop" }
  );
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default { register };

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

export { MCPManager } from "./manager/mcp-manager.js";
export type { MCPManagerConfig, ServerConnection } from "./manager/mcp-manager.js";
export { ToolRegistry } from "./manager/tool-registry.js";
export type { RegisteredTool, ToolRegistryConfig } from "./manager/tool-registry.js";
export { StreamableHTTPTransport } from "./transport/streamable-http.js";
export type { StreamableHTTPConfig } from "./transport/streamable-http.js";
export { StdioTransport } from "./transport/stdio.js";
export type { StdioTransportConfig } from "./transport/stdio.js";
export { SSEParser, parseSSEStream } from "./transport/sse-parser.js";
export { configSchema } from "./config-schema.js";
export type {
  ConfigSchemaType,
  MCPServerConfigType,
  ServerAuthConfigType,
} from "./config-schema.js";
export { MCPError } from "./types.js";
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcBatch,
  JsonRpcMessage,
  MCPTool,
  MCPToolInput,
  ToolsCallResult,
  ToolsListResult,
  InitializeResult,
  ConnectionStatus,
  SessionState,
  SSEEvent,
} from "./types.js";
