/**
 * Tool Registry — manages the mapping between remote MCP tools and
 * locally-registered OpenClaw tools with namespace prefixing.
 *
 * Each remote MCP tool is registered under a namespaced name of the form
 * `<prefix>__<toolName>` to prevent collisions across servers. The `__`
 * separator is chosen because it is unlikely to appear in tool names.
 *
 * @see SPEC.md section 6.5 for the namespacing convention.
 */

import type { MCPTool } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A registered tool with its server origin. */
export interface RegisteredTool {
  /** Namespaced name: "serverName__toolName" */
  readonly namespacedName: string;
  /** Original tool name on the remote server */
  readonly originalName: string;
  /** Server this tool belongs to */
  readonly serverName: string;
  /** Tool description from the MCP server */
  readonly description: string;
  /** JSON Schema for the tool's input parameters */
  readonly inputSchema: Record<string, unknown>;
}

/** Configuration options for the ToolRegistry. */
export interface ToolRegistryConfig {
  /** Interval in ms to re-discover tools (0 = disabled) */
  readonly discoveryIntervalMs: number;
}

/** The separator used to join prefix and tool name in namespaced names. */
const NAMESPACE_SEPARATOR = "__";

/** Default configuration values. */
const DEFAULT_CONFIG: ToolRegistryConfig = {
  discoveryIntervalMs: 0,
} as const;

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Manages dynamic registration of remote MCP tools as namespaced OpenClaw tools.
 *
 * Tools from multiple MCP servers are stored in a single registry, each prefixed
 * with its server name (or a custom prefix) to avoid name collisions.
 */
export class ToolRegistry {
  /** Registry config (merged with defaults). */
  private readonly config: ToolRegistryConfig;

  /**
   * Map from server name to its array of registered tools.
   * This is the primary ownership structure.
   */
  private readonly serverTools: Map<string, RegisteredTool[]> = new Map();

  /**
   * Map from namespaced tool name to the RegisteredTool entry.
   * Acts as a fast lookup index that is rebuilt on registration changes.
   */
  private readonly toolIndex: Map<string, RegisteredTool> = new Map();

  /**
   * Create a new ToolRegistry.
   *
   * @param config - Optional partial configuration. Missing fields use defaults.
   */
  constructor(config?: Partial<ToolRegistryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register (or re-register) all tools for a given server.
   *
   * Takes the server name and the tools array from a `tools/list` response,
   * creates namespaced names of the form `<prefix>__<toolName>`, and stores
   * them in the registry. If the server was already registered, its previous
   * tools are replaced (supporting re-discovery).
   *
   * @param serverName - The logical name of the MCP server.
   * @param tools - The tools array from the server's `tools/list` response.
   * @param prefix - Optional namespace prefix; defaults to `serverName`.
   * @returns The array of RegisteredTool entries that were registered.
   */
  registerServer(
    serverName: string,
    tools: readonly MCPTool[],
    prefix?: string
  ): RegisteredTool[] {
    // Remove any previous registration for this server first.
    this.unregisterServer(serverName);

    const effectivePrefix = prefix ?? serverName;
    const registered: RegisteredTool[] = [];

    for (const tool of tools) {
      const namespacedName = `${effectivePrefix}${NAMESPACE_SEPARATOR}${tool.name}`;

      const entry: RegisteredTool = {
        namespacedName,
        originalName: tool.name,
        serverName,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      };

      // Collision detection: warn if another server already owns this namespaced name.
      const existing = this.toolIndex.get(namespacedName);
      if (existing !== undefined) {
        console.warn(
          `[ToolRegistry] Namespace collision: "${namespacedName}" was registered ` +
            `by server "${existing.serverName}" and is now being replaced by ` +
            `server "${serverName}".`
        );
      }

      this.toolIndex.set(namespacedName, entry);
      registered.push(entry);
    }

    this.serverTools.set(serverName, registered);

    return registered;
  }

  /**
   * Remove all tools for a given server from the registry.
   *
   * @param serverName - The server whose tools should be unregistered.
   */
  unregisterServer(serverName: string): void {
    const existing = this.serverTools.get(serverName);
    if (existing === undefined) {
      return;
    }

    // Remove each tool from the index, but only if it still points to this server
    // (it may have been overwritten by a collision from another server).
    for (const tool of existing) {
      const indexed = this.toolIndex.get(tool.namespacedName);
      if (indexed !== undefined && indexed.serverName === serverName) {
        this.toolIndex.delete(tool.namespacedName);
      }
    }

    this.serverTools.delete(serverName);
  }

  /**
   * Look up a tool by its full namespaced name.
   *
   * @param name - The namespaced tool name (e.g. "tavily__search").
   * @returns The RegisteredTool entry, or undefined if not found.
   */
  getToolByNamespacedName(name: string): RegisteredTool | undefined {
    return this.toolIndex.get(name);
  }

  /**
   * Parse a namespaced tool name back into the server name and original tool name.
   *
   * Used by MCPManager to route tool calls to the correct server.
   *
   * @param namespacedName - The full namespaced name (e.g. "tavily__search").
   * @returns An object with `serverName` and `toolName`, or undefined if the
   *          tool is not found in the registry.
   */
  resolveToolCall(
    namespacedName: string
  ): { serverName: string; toolName: string } | undefined {
    const tool = this.toolIndex.get(namespacedName);
    if (tool === undefined) {
      return undefined;
    }
    return { serverName: tool.serverName, toolName: tool.originalName };
  }

  /**
   * Return all registered tools across all servers.
   *
   * @returns A flat array of every RegisteredTool in the registry.
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.toolIndex.values());
  }

  /**
   * Return the tools registered for a specific server.
   *
   * @param serverName - The server name to filter by.
   * @returns An array of RegisteredTool entries for that server, or an empty
   *          array if the server is not registered.
   */
  getToolsForServer(serverName: string): RegisteredTool[] {
    return this.serverTools.get(serverName) ?? [];
  }

  /**
   * Return the names of all servers that have registered tools.
   *
   * @returns An array of server name strings.
   */
  getServerNames(): string[] {
    return Array.from(this.serverTools.keys());
  }

  /**
   * Return the total number of registered tools across all servers.
   *
   * @returns The tool count.
   */
  getToolCount(): number {
    return this.toolIndex.size;
  }

  /**
   * Remove all tools and servers from the registry.
   */
  clear(): void {
    this.serverTools.clear();
    this.toolIndex.clear();
  }

  /**
   * Return the configured discovery interval in milliseconds.
   *
   * @returns The discovery interval, or 0 if periodic discovery is disabled.
   */
  getDiscoveryIntervalMs(): number {
    return this.config.discoveryIntervalMs;
  }
}
