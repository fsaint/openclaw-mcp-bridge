/**
 * Plugin entry point for the OpenClaw MCP client plugin.
 *
 * Implements the ToolPlugin interface to register remote MCP tools as
 * OpenClaw agent tools. Manages the full lifecycle: initialization,
 * tool discovery, shutdown, and dynamic configuration reconciliation.
 *
 * @see SPEC.md section 6.4 for the plugin entry point specification.
 */

import { MCPManager } from "./manager/mcp-manager.js";
import type { MCPManagerConfig } from "./manager/mcp-manager.js";
import type { RegisteredTool } from "./manager/tool-registry.js";
import type { ConfigSchemaType } from "./config-schema.js";

// ---------------------------------------------------------------------------
// ToolPlugin Interface (local definition — mirrors openclaw/plugin-sdk)
// ---------------------------------------------------------------------------

/**
 * A single tool definition exposed to the OpenClaw agent runtime.
 *
 * Each tool has a name, description, input schema, and an execute function
 * that the agent calls when it wants to invoke the tool.
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
 * Context provided by OpenClaw when initializing a plugin.
 */
export interface PluginContext {
  /** The plugin's validated configuration. */
  readonly config: ConfigSchemaType;
}

/**
 * Result returned by a plugin after successful initialization.
 *
 * Contains the tools to register plus optional lifecycle hooks.
 */
export interface PluginResult {
  /** Array of tool definitions to register with the agent. */
  readonly tools: ToolDefinition[];
  /** Called when the gateway is shutting down. */
  onShutdown?: () => Promise<void>;
  /** Called when the plugin configuration changes at runtime. */
  onConfigChange?: (newConfig: ConfigSchemaType) => Promise<void>;
}

/**
 * Minimal ToolPlugin interface matching OpenClaw's plugin SDK contract.
 *
 * A plugin must implement `initialize()` which receives the plugin context
 * and returns registered tools plus lifecycle hooks.
 */
export interface ToolPlugin {
  /**
   * Initialize the plugin and return its tools and lifecycle hooks.
   *
   * @param context - The plugin context containing validated configuration.
   * @returns The plugin result with tools and optional lifecycle hooks.
   */
  initialize(context: PluginContext): Promise<PluginResult>;
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

/**
 * Convert an array of RegisteredTool entries to ToolDefinition objects.
 *
 * Each ToolDefinition's `execute` method delegates to
 * `mcpManager.callTool()`, routing the call to the appropriate
 * remote MCP server.
 *
 * @param registeredTools - Tools from the ToolRegistry.
 * @param mcpManager - The MCPManager instance to route calls through.
 * @returns An array of ToolDefinition objects ready for the agent runtime.
 */
function buildToolDefinitions(
  registeredTools: readonly RegisteredTool[],
  mcpManager: MCPManager
): ToolDefinition[] {
  return registeredTools.map((tool) => ({
    name: tool.namespacedName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: (args: Record<string, unknown>): Promise<unknown> =>
      mcpManager.callTool(tool.namespacedName, args),
  }));
}

// ---------------------------------------------------------------------------
// Plugin Instance
// ---------------------------------------------------------------------------

/**
 * The OpenClaw MCP client plugin.
 *
 * On initialization, creates an MCPManager, connects to all configured
 * servers, discovers their tools, and returns them as OpenClaw ToolDefinitions.
 *
 * Lifecycle hooks:
 * - `onShutdown`: gracefully disconnects all servers.
 * - `onConfigChange`: reconciles connections with the new config and rebuilds
 *   the tool list.
 */
export const plugin: ToolPlugin = {
  async initialize(context: PluginContext): Promise<PluginResult> {
    const config = context.config;
    let mcpManager = new MCPManager(toManagerConfig(config));

    // Connect to all enabled MCP servers in parallel
    await mcpManager.connectAll();

    // Build the initial tool definitions from discovered tools
    let tools = buildToolDefinitions(
      mcpManager.getRegisteredTools(),
      mcpManager
    );

    return {
      tools,

      async onShutdown(): Promise<void> {
        await mcpManager.disconnectAll();
      },

      async onConfigChange(newConfig: ConfigSchemaType): Promise<void> {
        // Reconcile connections: disconnect removed/changed, connect new servers
        await mcpManager.reconcile(toManagerConfig(newConfig));

        // Rebuild the tool list from the updated registry
        tools = buildToolDefinitions(
          mcpManager.getRegisteredTools(),
          mcpManager
        );
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default plugin;

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
