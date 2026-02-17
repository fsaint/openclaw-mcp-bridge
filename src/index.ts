/**
 * Plugin entry point for the OpenClaw MCP client plugin.
 *
 * Implements the OpenClaw plugin SDK contract: exports a default object
 * with a `register(api)` function that registers MCP tools via
 * `api.registerTool()`.
 *
 * @see SPEC.md section 6.4 for the plugin entry point specification.
 */

import { MCPManager } from "./manager/mcp-manager.js";
import type { MCPManagerConfig } from "./manager/mcp-manager.js";
import type { ConfigSchemaType } from "./config-schema.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin API types (mirrors openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

/**
 * A tool object that can be registered with OpenClaw via api.registerTool().
 */
export interface ToolDefinition {
  /** Unique tool name (namespaced, e.g. "tavily__search"). */
  readonly name: string;
  /** Human-readable description of what the tool does. */
  readonly description: string;
  /** JSON Schema describing the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Execute the tool with the given arguments.
   *
   * @param args - The tool arguments matching the inputSchema.
   * @returns The tool execution result.
   */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * The API object passed to register() by OpenClaw's plugin runtime.
 */
interface PluginApi {
  readonly id: string;
  readonly pluginConfig: ConfigSchemaType;
  registerTool: (tool: ToolDefinition, opts?: { name?: string }) => void;
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

  // Register tools for each configured server
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    if (serverConfig.enabled === false) continue;

    const prefix = serverConfig.toolPrefix ?? serverName;

    // Register a proxy tool that connects lazily and forwards calls
    api.registerTool({
      name: `${prefix}__call`,
      description: `Call a tool on MCP server "${serverName}" (${serverConfig.url}). Pass {"tool": "<tool_name>", "args": {}} to invoke.`,
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The tool name to call on this server" },
          args: { type: "object", description: "Arguments to pass to the tool" },
        },
        required: ["tool"],
      },
      async execute(callArgs: Record<string, unknown>): Promise<unknown> {
        await ensureConnected();
        const toolName = callArgs.tool as string;
        const args = (callArgs.args as Record<string, unknown>) ?? {};
        return mcpManager.callTool(`${prefix}__${toolName}`, args);
      },
    });
  }

  // Register shutdown hook
  api.registerHook("gateway:shutdown", async () => {
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
