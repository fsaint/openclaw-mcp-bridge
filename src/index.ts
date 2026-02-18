/**
 * Plugin entry point for the OpenClaw MCP client plugin.
 *
 * Implements the OpenClaw plugin SDK contract: exports a default object
 * with a `register(api)` function that registers MCP tools via
 * `api.registerTool()`.
 *
 * @see SPEC.md section 6.4 for the plugin entry point specification.
 */

import { Type } from "@sinclair/typebox";
import { MCPManager } from "./manager/mcp-manager.js";
import type { MCPManagerConfig } from "./manager/mcp-manager.js";
import type { ConfigSchemaType } from "./config-schema.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin API types (mirrors openclaw/plugin-sdk + pi-agent-core)
// ---------------------------------------------------------------------------

/**
 * Content block returned in AgentToolResult.
 */
type TextContent = { type: "text"; text: string };

/**
 * Result shape required by AgentTool.execute().
 */
interface AgentToolResult {
  content: TextContent[];
  details: unknown;
}

/**
 * An AgentTool that can be registered with OpenClaw via api.registerTool().
 * Must use TypeBox schemas for `parameters` (not plain JSON Schema).
 */
interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult>;
}

/**
 * The API object passed to register() by OpenClaw's plugin runtime.
 */
interface PluginApi {
  readonly id: string;
  readonly pluginConfig: ConfigSchemaType;
  readonly logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerTool: (tool: AgentTool, opts?: { name?: string }) => void;
  registerHook: (events: string | string[], handler: (...args: unknown[]) => void, opts?: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ConfigSchemaType to the MCPManagerConfig shape expected by MCPManager.
 *
 * @param config - The plugin configuration from OpenClaw.
 * @returns An MCPManagerConfig ready for the MCPManager constructor.
 */
function toManagerConfig(config: ConfigSchemaType): MCPManagerConfig {
  return {
    servers: config.servers,
    toolDiscoveryInterval: config.toolDiscoveryInterval,
    maxConcurrentServers: config.maxConcurrentServers,
    debug: config.debug,
  };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * Register function called synchronously by OpenClaw's plugin runtime.
 *
 * Since MCP server connections are async but register() must be synchronous,
 * we register tool factories that lazily connect on first invocation.
 *
 * @param api - The OpenClaw plugin API.
 */
function register(api: PluginApi): void {
  const config = api.pluginConfig;
  if (!config?.servers || Object.keys(config.servers).length === 0) {
    return;
  }

  const mcpManager = new MCPManager(toManagerConfig(config));

  // Register a factory for each configured server's tools.
  // The factory connects lazily on first tool call.
  let connected = false;
  const ensureConnected = async (): Promise<void> => {
    if (connected) return;
    await mcpManager.connectAll();
    connected = true;
  };

  // Register a proxy tool per configured server.
  // Each tool connects lazily and forwards calls to the remote MCP server.
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.enabled === false) continue;

    const prefix = serverConfig.toolPrefix ?? serverName;

    api.registerTool({
      name: `${prefix}__call`,
      label: `MCP: ${serverName}`,
      description: `Call a tool on MCP server "${serverName}" (${serverConfig.url}). Pass tool name and arguments to invoke any tool on this server.`,
      parameters: Type.Object({
        tool: Type.String({ description: "The tool name to call on this server" }),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments to pass to the tool" })),
      }),
      async execute(_toolCallId: string, params: Record<string, unknown>): Promise<AgentToolResult> {
        await ensureConnected();
        const toolName = params.tool as string;
        const args = (params.args as Record<string, unknown>) ?? {};
        try {
          const result = await mcpManager.callTool(`${prefix}__${toolName}`, args);
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return {
            content: [{ type: "text", text }],
            details: { server: serverName, tool: toolName, result },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Error calling ${prefix}__${toolName}: ${message}` }],
            details: { server: serverName, tool: toolName, error: message },
          };
        }
      },
    });

    api.logger.info(`mcp-client: registered proxy tool ${prefix}__call for server "${serverName}"`);
  }

  // Register shutdown hook
  api.registerHook("gateway_stop", async () => {
    if (connected) {
      await mcpManager.disconnectAll();
    }
  }, { name: "mcp-client-shutdown", description: "Disconnect all MCP servers" });
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default { register };

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

// Manager layer
export { MCPManager } from "./manager/mcp-manager.js";
export type { MCPManagerConfig, ServerConnection } from "./manager/mcp-manager.js";
export { ToolRegistry } from "./manager/tool-registry.js";
export type { RegisteredTool, ToolRegistryConfig } from "./manager/tool-registry.js";

// Transport layer
export { StreamableHTTPTransport } from "./transport/streamable-http.js";
export type { StreamableHTTPConfig } from "./transport/streamable-http.js";
export { StdioTransport } from "./transport/stdio.js";
export type { StdioTransportConfig } from "./transport/stdio.js";
export { SSEParser, parseSSEStream } from "./transport/sse-parser.js";

// Config and types
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
