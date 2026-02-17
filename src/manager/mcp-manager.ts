/**
 * MCP Manager — orchestrates connections to multiple MCP servers,
 * tool discovery, and tool invocation routing.
 *
 * Manages the full lifecycle of MCP server connections: transport creation,
 * session initialization, tool discovery, tool registry synchronization,
 * and graceful shutdown. Supports both Streamable HTTP and stdio transports.
 *
 * @see SPEC.md section 3 for the architecture overview.
 * @see SPEC.md section 6.4 for plugin entry point integration.
 */

import type {
  JsonRpcResponse,
  MCPCapabilities,
  InitializeResult,
  ToolsListResult,
  ToolsCallResult,
  ConnectionStatus,
  SessionState,
  MCPTool,
} from "../types.js";
import { MCPError } from "../types.js";
import { createRequest, isError, INTERNAL_ERROR } from "../jsonrpc.js";
import { StreamableHTTPTransport } from "../transport/streamable-http.js";
import type { StreamableHTTPConfig } from "../transport/streamable-http.js";
import { StdioTransport } from "../transport/stdio.js";
import type { StdioTransportConfig } from "../transport/stdio.js";
import { ToolRegistry } from "./tool-registry.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { MCPServerConfigType } from "../config-schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default interval for periodic tool re-discovery in milliseconds. */
const DEFAULT_TOOL_DISCOVERY_INTERVAL_MS = 300_000;

/** Default maximum number of concurrent server connections. */
const DEFAULT_MAX_CONCURRENT_SERVERS = 20;

/** Default maximum number of retry attempts for reconnection. */
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

/** Default base delay in milliseconds for exponential backoff. */
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/** Default maximum delay in milliseconds for exponential backoff. */
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

/** Client information sent during the MCP initialize handshake. */
const CLIENT_INFO = {
  name: "openclaw-mcp-client",
  version: "1.0.0",
} as const;

/** Client capabilities advertised during initialization. */
const CLIENT_CAPABILITIES: MCPCapabilities = {
  roots: { listChanged: false },
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a health check against a single MCP server. */
export interface HealthCheckResult {
  /** Logical name of the server. */
  name: string;
  /** Health status: healthy if ping succeeded, unhealthy on error response, unreachable on connection failure. */
  status: "healthy" | "unhealthy" | "unreachable";
  /** Round-trip latency of the ping in milliseconds. */
  latencyMs: number;
  /** Timestamp when this health check was performed. */
  lastChecked: Date;
  /** Number of consecutive failures tracked for this server. */
  consecutiveFailures: number;
}

/** Represents a live connection to a single MCP server. */
export interface ServerConnection {
  /** Logical name of this server (the key in the config map). */
  readonly name: string;
  /** The server configuration used to establish this connection. */
  readonly config: MCPServerConfigType;
  /** The transport instance managing communication with this server. */
  readonly transport: StreamableHTTPTransport | StdioTransport;
  /** Current connection status. */
  status: ConnectionStatus;
  /** MCP session state, populated after a successful initialize handshake. */
  sessionState: SessionState | null;
  /** Number of tools discovered from this server. */
  toolCount: number;
  /** The most recent error message, or null if no error. */
  lastError: string | null;
  /** Timestamp when the connection was established, or null if never connected. */
  connectedAt: Date | null;
  /** Number of consecutive failures observed for this server (resets on success). */
  consecutiveFailures: number;
}

/** Configuration for the MCPManager. */
export interface MCPManagerConfig {
  /** Map of server name to server configuration. */
  readonly servers: Record<string, MCPServerConfigType>;
  /** Interval in ms to re-discover tools from all servers (default: 300000). */
  readonly toolDiscoveryInterval?: number;
  /** Maximum number of simultaneous server connections (default: 20). */
  readonly maxConcurrentServers?: number;
  /** Enable debug logging (default: false). */
  readonly debug?: boolean;
  /** Maximum number of retry attempts when reconnecting to a failed server (default: 5). */
  readonly maxRetryAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  readonly retryBaseDelayMs?: number;
  /** Maximum delay in ms for exponential backoff (default: 60000). */
  readonly retryMaxDelayMs?: number;
}

// ---------------------------------------------------------------------------
// MCPManager
// ---------------------------------------------------------------------------

/**
 * Manages connections to multiple MCP servers, coordinates tool discovery,
 * and routes tool calls to the appropriate server.
 *
 * Provides the core connection lifecycle for the MCP client plugin:
 * connect, disconnect, reconcile config changes, discover tools, and
 * invoke remote tools via the ToolRegistry.
 */
export class MCPManager {
  /** Manager configuration. */
  private readonly config: MCPManagerConfig;

  /** Tool registry for namespace-prefixed tool management. */
  private readonly toolRegistry: ToolRegistry;

  /** Active server connections keyed by server name. */
  private readonly connections: Map<string, ServerConnection> = new Map();

  /** Maximum concurrent server connections. */
  private readonly maxConcurrentServers: number;

  /** Whether debug logging is enabled. */
  private readonly debug: boolean;

  /** Maximum number of retry attempts for reconnection with backoff. */
  private readonly maxRetryAttempts: number;

  /** Base delay in ms for exponential backoff. */
  private readonly retryBaseDelayMs: number;

  /** Maximum delay in ms for exponential backoff. */
  private readonly retryMaxDelayMs: number;

  /**
   * Create a new MCPManager.
   *
   * @param config - Manager configuration including server definitions and global settings.
   */
  constructor(config: MCPManagerConfig) {
    this.config = config;
    this.maxConcurrentServers =
      config.maxConcurrentServers ?? DEFAULT_MAX_CONCURRENT_SERVERS;
    this.debug = config.debug ?? false;
    this.maxRetryAttempts =
      config.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    this.retryBaseDelayMs =
      config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs =
      config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;

    this.toolRegistry = new ToolRegistry({
      discoveryIntervalMs: config.toolDiscoveryInterval ?? DEFAULT_TOOL_DISCOVERY_INTERVAL_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Connection Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to all enabled servers defined in the configuration.
   *
   * Connections are made in parallel, respecting the maxConcurrentServers limit.
   * Individual connection failures are logged as warnings but do not cause the
   * entire batch to fail.
   *
   * @returns Resolves when all connection attempts have completed (or failed).
   */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.config.servers).filter(
      ([_, serverConfig]) => serverConfig.enabled !== false
    );

    // Process servers in batches to respect the concurrency limit
    for (let i = 0; i < entries.length; i += this.maxConcurrentServers) {
      const batch = entries.slice(i, i + this.maxConcurrentServers);
      const promises = batch.map(([name, serverConfig]) =>
        this.connect(name, serverConfig).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.log(`Warning: failed to connect to server "${name}": ${message}`);
        })
      );
      await Promise.all(promises);
    }
  }

  /**
   * Connect to a single MCP server.
   *
   * Creates the appropriate transport (HTTP or stdio), performs the MCP
   * initialize handshake, discovers available tools, and registers them
   * in the ToolRegistry.
   *
   * @param name - Logical name for the server (used as the config key and tool namespace).
   * @param serverConfig - The server's configuration.
   * @throws {MCPError} If the connection or initialization fails.
   */
  async connect(name: string, serverConfig: MCPServerConfigType): Promise<void> {
    this.log(`Connecting to server "${name}"...`);

    const transportType = serverConfig.transport ?? "http";
    let transport: StreamableHTTPTransport | StdioTransport;

    try {
      if (transportType === "stdio") {
        transport = this.createStdioTransport(serverConfig);
      } else {
        transport = this.createHTTPTransport(serverConfig);
      }

      // Create the connection record early so status can be tracked
      const connection: ServerConnection = {
        name,
        config: serverConfig,
        transport,
        status: "connecting",
        sessionState: null,
        toolCount: 0,
        lastError: null,
        connectedAt: null,
        consecutiveFailures: 0,
      };
      this.connections.set(name, connection);

      // Start the transport (stdio needs to spawn the process)
      if (transport instanceof StdioTransport) {
        await transport.start();
      }

      // Perform the MCP initialize handshake
      const initResult = await this.initializeSession(name, transport);

      // Build session state from the initialize result
      const sessionState: SessionState = {
        sessionId:
          transport instanceof StreamableHTTPTransport
            ? transport.getSessionId()
            : null,
        status: "connected",
        lastEventId:
          transport instanceof StreamableHTTPTransport
            ? transport.getLastEventId()
            : null,
        serverInfo: initResult.serverInfo,
        protocolVersion: initResult.protocolVersion,
      };

      connection.sessionState = sessionState;
      connection.status = "connected";
      connection.connectedAt = new Date();
      connection.consecutiveFailures = 0;

      // Discover and register tools
      const tools = await this.discoverTools(name, transport);
      const prefix = serverConfig.toolPrefix ?? name;
      this.toolRegistry.registerServer(name, tools, prefix);
      connection.toolCount = tools.length;

      this.log(
        `Connected to server "${name}": ${String(tools.length)} tool(s) discovered.`
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);

      // Update connection record to error state if it exists
      const existing = this.connections.get(name);
      if (existing !== undefined) {
        existing.status = "error";
        existing.lastError = message;
        existing.consecutiveFailures += 1;
      } else {
        // If we never got to create the connection record, create one in error state
        this.connections.set(name, {
          name,
          config: serverConfig,
          transport: transport!,
          status: "error",
          sessionState: null,
          toolCount: 0,
          lastError: message,
          connectedAt: null,
          consecutiveFailures: 1,
        });
      }

      throw new MCPError(
        `Failed to connect to server "${name}": ${message}`,
        INTERNAL_ERROR
      );
    }
  }

  /**
   * Disconnect from a single MCP server.
   *
   * Terminates the session (for HTTP: sends DELETE; for stdio: stops the process),
   * unregisters the server's tools from the ToolRegistry, and removes the
   * connection record.
   *
   * @param name - The logical name of the server to disconnect.
   */
  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection === undefined) {
      return;
    }

    this.log(`Disconnecting from server "${name}"...`);

    try {
      if (connection.transport instanceof StreamableHTTPTransport) {
        await connection.transport.terminateSession();
      } else if (connection.transport instanceof StdioTransport) {
        await connection.transport.stop();
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.log(
        `Warning: error during disconnect from "${name}": ${message}`
      );
    }

    // Unregister tools and remove the connection
    this.toolRegistry.unregisterServer(name);
    this.connections.delete(name);

    this.log(`Disconnected from server "${name}".`);
  }

  /**
   * Disconnect from all connected servers.
   *
   * Disconnections happen in parallel. Individual failures are logged but
   * do not prevent other servers from being disconnected.
   *
   * @returns Resolves when all disconnection attempts have completed.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    const promises = names.map((name) =>
      this.disconnect(name).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`Warning: error disconnecting from "${name}": ${message}`);
      })
    );
    await Promise.all(promises);
  }

  // -------------------------------------------------------------------------
  // Tool Invocation
  // -------------------------------------------------------------------------

  /**
   * Invoke a remote MCP tool by its namespaced name.
   *
   * Resolves the namespaced tool name to a server and original tool name via
   * the ToolRegistry, then sends a `tools/call` JSON-RPC request to the
   * appropriate server's transport.
   *
   * @param namespacedToolName - The full namespaced tool name (e.g., "tavily__search").
   * @param args - Arguments to pass to the tool.
   * @returns The tool call result.
   * @throws {MCPError} If the tool is not found or the server is not connected.
   */
  async callTool(
    namespacedToolName: string,
    args: Record<string, unknown>
  ): Promise<ToolsCallResult> {
    const resolved = this.toolRegistry.resolveToolCall(namespacedToolName);
    if (resolved === undefined) {
      throw new MCPError(
        `Tool not found: "${namespacedToolName}"`,
        INTERNAL_ERROR
      );
    }

    const { serverName, toolName } = resolved;
    const connection = this.connections.get(serverName);

    if (connection === undefined || connection.status !== "connected") {
      throw new MCPError(
        `Server "${serverName}" is not connected`,
        INTERNAL_ERROR
      );
    }

    try {
      const result = await this.executeToolCall(connection, toolName, args, namespacedToolName);
      // Reset consecutive failures on success
      connection.consecutiveFailures = 0;
      return result;
    } catch (error: unknown) {
      // Track the failure
      connection.consecutiveFailures += 1;

      // Attempt auto-reconnect once for connection-level errors
      if (this.isConnectionError(error)) {
        this.log(
          `Connection error calling "${namespacedToolName}" on "${serverName}", attempting reconnect...`
        );

        try {
          await this.reconnectWithBackoff(serverName);

          // Retry the tool call after successful reconnection
          const retryConnection = this.connections.get(serverName);
          if (
            retryConnection !== undefined &&
            retryConnection.status === "connected"
          ) {
            const result = await this.executeToolCall(
              retryConnection,
              toolName,
              args,
              namespacedToolName
            );
            retryConnection.consecutiveFailures = 0;
            return result;
          }
        } catch (reconnectError: unknown) {
          const reconnectMessage =
            reconnectError instanceof Error
              ? reconnectError.message
              : String(reconnectError);
          this.log(
            `Reconnect failed for "${serverName}": ${reconnectMessage}`
          );
        }
      }

      // Re-throw the original error if reconnect failed or was not attempted
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Configuration Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Reconcile the current connections with a new configuration.
   *
   * Compares the new config against the current state and:
   * - Disconnects servers that were removed or disabled.
   * - Connects servers that were newly added or enabled.
   * - Reconnects servers whose configuration changed (URL, auth, etc.).
   *
   * @param newConfig - The new manager configuration to apply.
   */
  async reconcile(newConfig: MCPManagerConfig): Promise<void> {
    const oldServers = new Set(this.connections.keys());
    const newServers = new Set(
      Object.entries(newConfig.servers)
        .filter(([_, cfg]) => cfg.enabled !== false)
        .map(([name]) => name)
    );

    // Servers to disconnect: present in old but not in new, or disabled
    const toDisconnect: string[] = [];
    for (const name of oldServers) {
      if (!newServers.has(name)) {
        toDisconnect.push(name);
      }
    }

    // Servers to connect: present in new but not in old
    const toConnect: string[] = [];
    for (const name of newServers) {
      if (!oldServers.has(name)) {
        toConnect.push(name);
      }
    }

    // Servers to reconnect: present in both but config changed
    const toReconnect: string[] = [];
    for (const name of newServers) {
      if (oldServers.has(name)) {
        const oldConn = this.connections.get(name);
        if (
          oldConn !== undefined &&
          this.hasConfigChanged(oldConn.config, newConfig.servers[name])
        ) {
          toReconnect.push(name);
        }
      }
    }

    // Disconnect removed/disabled servers
    await Promise.all(
      toDisconnect.map((name) =>
        this.disconnect(name).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.log(`Warning: error during reconcile disconnect of "${name}": ${message}`);
        })
      )
    );

    // Reconnect changed servers
    for (const name of toReconnect) {
      await this.disconnect(name).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`Warning: error during reconcile disconnect of "${name}": ${message}`);
      });
    }

    // Connect new and reconnected servers
    const allToConnect = [...toConnect, ...toReconnect];
    await Promise.all(
      allToConnect.map((name) =>
        this.connect(name, newConfig.servers[name]).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.log(`Warning: error during reconcile connect of "${name}": ${message}`);
        })
      )
    );
  }

  // -------------------------------------------------------------------------
  // Tool Refresh
  // -------------------------------------------------------------------------

  /**
   * Re-discover tools from one or all connected servers.
   *
   * Sends a `tools/list` request to the specified server (or all servers)
   * and updates the ToolRegistry with the fresh tool list.
   *
   * @param serverName - Optional server name to refresh. If omitted, all servers are refreshed.
   */
  async refreshTools(serverName?: string): Promise<void> {
    if (serverName !== undefined) {
      await this.refreshToolsForServer(serverName);
      return;
    }

    // Refresh all connected servers
    const promises = Array.from(this.connections.keys()).map((name) =>
      this.refreshToolsForServer(name).catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`Warning: failed to refresh tools for "${name}": ${message}`);
      })
    );
    await Promise.all(promises);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /**
   * Return all active server connections with their current status.
   *
   * @returns An array of ServerConnection records.
   */
  getConnections(): ServerConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Return the connection for a specific server by name.
   *
   * @param name - The logical server name.
   * @returns The ServerConnection, or undefined if not found.
   */
  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  /**
   * Return all registered tools across all servers.
   *
   * @returns A flat array of RegisteredTool entries.
   */
  getRegisteredTools(): RegisteredTool[] {
    return this.toolRegistry.getAllTools();
  }

  /**
   * Return the ToolRegistry instance for direct access.
   *
   * @returns The ToolRegistry managing tool registrations.
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  // -------------------------------------------------------------------------
  // Health Monitoring
  // -------------------------------------------------------------------------

  /**
   * Check the health of one or all connected servers by sending a JSON-RPC
   * `ping` request and measuring the round-trip latency.
   *
   * @param serverName - Optional server name. If omitted, all servers are checked.
   * @returns A single HealthCheckResult when a name is given, or an array when omitted.
   */
  async healthCheck(serverName?: string): Promise<HealthCheckResult | HealthCheckResult[]> {
    if (serverName !== undefined) {
      return this.healthCheckServer(serverName);
    }

    const names = Array.from(this.connections.keys());
    const results = await Promise.all(
      names.map((name) => this.healthCheckServer(name))
    );
    return results;
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Perform a health check on a single server by sending a `ping` JSON-RPC request.
   *
   * @param name - The server name to check.
   * @returns The HealthCheckResult for this server.
   */
  private async healthCheckServer(name: string): Promise<HealthCheckResult> {
    const connection = this.connections.get(name);
    const now = new Date();

    if (connection === undefined) {
      return {
        name,
        status: "unreachable",
        latencyMs: 0,
        lastChecked: now,
        consecutiveFailures: 0,
      };
    }

    if (connection.status !== "connected") {
      return {
        name,
        status: "unreachable",
        latencyMs: 0,
        lastChecked: now,
        consecutiveFailures: connection.consecutiveFailures,
      };
    }

    const start = Date.now();
    try {
      let rpcResponse: JsonRpcResponse;

      if (connection.transport instanceof StreamableHTTPTransport) {
        rpcResponse = await connection.transport.sendRequest("ping", {});
      } else {
        const request = createRequest("ping", {}, Date.now());
        rpcResponse = await connection.transport.sendAndReceive(request);
      }

      const latencyMs = Date.now() - start;

      if (isError(rpcResponse)) {
        connection.consecutiveFailures += 1;
        return {
          name,
          status: "unhealthy",
          latencyMs,
          lastChecked: now,
          consecutiveFailures: connection.consecutiveFailures,
        };
      }

      connection.consecutiveFailures = 0;
      return {
        name,
        status: "healthy",
        latencyMs,
        lastChecked: now,
        consecutiveFailures: 0,
      };
    } catch (_error: unknown) {
      const latencyMs = Date.now() - start;
      connection.consecutiveFailures += 1;
      return {
        name,
        status: "unreachable",
        latencyMs,
        lastChecked: now,
        consecutiveFailures: connection.consecutiveFailures,
      };
    }
  }

  /**
   * Execute a tool call on a given connection. Factored out for reuse
   * by the auto-reconnect logic in `callTool`.
   *
   * @param connection - The server connection to use.
   * @param toolName - The original (un-namespaced) tool name.
   * @param args - Arguments to pass to the tool.
   * @param namespacedToolName - The full namespaced tool name (for error messages).
   * @returns The tool call result.
   * @throws {MCPError} If the RPC response is an error.
   */
  private async executeToolCall(
    connection: ServerConnection,
    toolName: string,
    args: Record<string, unknown>,
    namespacedToolName: string
  ): Promise<ToolsCallResult> {
    const params = { name: toolName, arguments: args };

    let rpcResponse: JsonRpcResponse;

    if (connection.transport instanceof StreamableHTTPTransport) {
      rpcResponse = await connection.transport.sendRequest("tools/call", params);
    } else {
      const request = createRequest("tools/call", params, Date.now());
      rpcResponse = await connection.transport.sendAndReceive(request);
    }

    if (isError(rpcResponse)) {
      throw new MCPError(
        `Tool call "${namespacedToolName}" failed: ${rpcResponse.error.message}`,
        rpcResponse.error.code
      );
    }

    return rpcResponse.result as ToolsCallResult;
  }

  /**
   * Attempt to reconnect to a server using exponential backoff with jitter.
   *
   * Disconnects the existing session, then retries `connect()` up to
   * `maxRetryAttempts` times with increasing delays. If all attempts fail,
   * the server status is set to "error".
   *
   * @param name - The server name to reconnect.
   * @throws {MCPError} If reconnection fails after all retry attempts.
   */
  private async reconnectWithBackoff(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection === undefined) {
      throw new MCPError(
        `Cannot reconnect: server "${name}" not found`,
        INTERNAL_ERROR
      );
    }

    const serverConfig = connection.config;

    // Tear down the existing connection silently
    try {
      if (connection.transport instanceof StreamableHTTPTransport) {
        await connection.transport.terminateSession();
      } else if (connection.transport instanceof StdioTransport) {
        await connection.transport.stop();
      }
    } catch (_teardownError: unknown) {
      // Ignore teardown errors — we are reconnecting anyway
    }

    // Remove the old connection and tools
    this.toolRegistry.unregisterServer(name);
    this.connections.delete(name);

    let lastError: string = "Unknown error";

    for (let attempt = 0; attempt < this.maxRetryAttempts; attempt++) {
      const delayMs = this.computeBackoffDelay(attempt);
      this.log(
        `Reconnecting to "${name}" (attempt ${String(attempt + 1)}/${String(this.maxRetryAttempts)}, delay ${String(delayMs)}ms)...`
      );

      await this.sleep(delayMs);

      try {
        await this.connect(name, serverConfig);
        this.log(`Reconnected to "${name}" successfully.`);
        return;
      } catch (error: unknown) {
        lastError =
          error instanceof Error ? error.message : String(error);
        this.log(
          `Reconnection attempt ${String(attempt + 1)} to "${name}" failed: ${lastError}`
        );
      }
    }

    // All retries exhausted — mark as error
    const existing = this.connections.get(name);
    if (existing !== undefined) {
      existing.status = "error";
      existing.lastError = `Reconnection failed after ${String(this.maxRetryAttempts)} attempts: ${lastError}`;
    }

    throw new MCPError(
      `Failed to reconnect to "${name}" after ${String(this.maxRetryAttempts)} attempts: ${lastError}`,
      INTERNAL_ERROR
    );
  }

  /**
   * Compute the backoff delay for a given retry attempt.
   *
   * Uses exponential backoff (base * 2^attempt) clamped to a maximum,
   * plus random jitter in the range [0, 1000) ms to prevent thundering herd.
   *
   * @param attempt - Zero-based retry attempt number.
   * @returns The delay in milliseconds before the next retry.
   */
  private computeBackoffDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * Math.pow(2, attempt);
    const clamped = Math.min(exponential, this.retryMaxDelayMs);
    const jitter = Math.random() * 1_000;
    return clamped + jitter;
  }

  /**
   * Determine whether an error represents a connection-level failure
   * (as opposed to a logical tool error from the server).
   *
   * Connection errors include network failures, timeouts, and transport
   * errors that indicate the server is unreachable.
   *
   * @param error - The error to inspect.
   * @returns True if the error is likely a connection/transport failure.
   */
  private isConnectionError(error: unknown): boolean {
    if (error instanceof MCPError) {
      // JSON-RPC errors from the server (negative codes in the standard range)
      // are NOT connection errors — the server responded.
      // Connection errors use INTERNAL_ERROR or are native fetch/process errors.
      const message = error.message.toLowerCase();
      return (
        message.includes("fetch") ||
        message.includes("econnrefused") ||
        message.includes("econnreset") ||
        message.includes("timeout") ||
        message.includes("network") ||
        message.includes("socket") ||
        message.includes("abort") ||
        message.includes("not connected")
      );
    }

    // Native errors (TypeError from fetch, etc.) are connection errors
    if (error instanceof TypeError) {
      return true;
    }

    return false;
  }

  /**
   * Sleep for a given number of milliseconds.
   *
   * @param ms - Duration in milliseconds.
   * @returns A promise that resolves after the delay.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Create a StreamableHTTPTransport for an HTTP-based server.
   *
   * If the server config includes an `apiKey`, sets the Authorization header
   * as a Bearer token.
   *
   * @param serverConfig - The server configuration.
   * @returns A configured StreamableHTTPTransport instance.
   */
  private createHTTPTransport(
    serverConfig: MCPServerConfigType
  ): StreamableHTTPTransport {
    const transportConfig: StreamableHTTPConfig = {
      url: serverConfig.url,
      requestTimeoutMs: serverConfig.requestTimeoutMs,
      connectTimeoutMs: serverConfig.connectTimeoutMs,
      authorizationHeader:
        serverConfig.apiKey !== undefined
          ? `Bearer ${serverConfig.apiKey}`
          : undefined,
    };

    return new StreamableHTTPTransport(transportConfig);
  }

  /**
   * Create a StdioTransport for a subprocess-based server.
   *
   * @param serverConfig - The server configuration (must include `command`).
   * @returns A configured StdioTransport instance.
   * @throws {MCPError} If the `command` field is missing.
   */
  private createStdioTransport(
    serverConfig: MCPServerConfigType
  ): StdioTransport {
    if (serverConfig.command === undefined) {
      throw new MCPError(
        "stdio transport requires a 'command' field in the server config",
        INTERNAL_ERROR
      );
    }

    const transportConfig: StdioTransportConfig = {
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      env: serverConfig.env ?? {},
    };

    return new StdioTransport(transportConfig);
  }

  /**
   * Perform the MCP initialize handshake with a server.
   *
   * For HTTP transports, calls the built-in `initialize()` method.
   * For stdio transports, constructs and sends the initialize request manually.
   *
   * @param name - The server name (for logging).
   * @param transport - The transport to use for the handshake.
   * @returns The server's InitializeResult.
   * @throws {MCPError} If the handshake fails.
   */
  private async initializeSession(
    name: string,
    transport: StreamableHTTPTransport | StdioTransport
  ): Promise<InitializeResult> {
    if (transport instanceof StreamableHTTPTransport) {
      return transport.initialize(CLIENT_INFO, CLIENT_CAPABILITIES);
    }

    // stdio transport: build the initialize request manually
    const initRequest = createRequest(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      },
      Date.now()
    );

    const response = await transport.sendAndReceive(initRequest);

    if (isError(response)) {
      throw new MCPError(
        `Initialize failed for server "${name}": ${response.error.message}`,
        response.error.code
      );
    }

    const result = response.result as InitializeResult;

    // Send the initialized notification (fire-and-forget)
    await transport.send({
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
    });

    return result;
  }

  /**
   * Discover tools from a server via the `tools/list` MCP method.
   *
   * Handles cursor-based pagination to retrieve all available tools.
   *
   * @param name - The server name (for logging).
   * @param transport - The transport to use for the request.
   * @returns The complete array of MCPTool definitions from the server.
   * @throws {MCPError} If the tools/list request fails.
   */
  private async discoverTools(
    name: string,
    transport: StreamableHTTPTransport | StdioTransport
  ): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = {};
      if (cursor !== undefined) {
        params["cursor"] = cursor;
      }

      let response: JsonRpcResponse;

      if (transport instanceof StreamableHTTPTransport) {
        response = await transport.sendRequest(
          "tools/list",
          Object.keys(params).length > 0 ? params : undefined
        );
      } else {
        const request = createRequest(
          "tools/list",
          Object.keys(params).length > 0 ? params : undefined,
          Date.now()
        );
        response = await transport.sendAndReceive(request);
      }

      if (isError(response)) {
        throw new MCPError(
          `tools/list failed for server "${name}": ${response.error.message}`,
          response.error.code
        );
      }

      const result = response.result as ToolsListResult;
      allTools.push(...result.tools);

      cursor = result.nextCursor;
    } while (cursor !== undefined);

    return allTools;
  }

  /**
   * Refresh tools for a single connected server.
   *
   * @param name - The server name to refresh.
   * @throws {MCPError} If the server is not connected.
   */
  private async refreshToolsForServer(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (connection === undefined || connection.status !== "connected") {
      throw new MCPError(
        `Cannot refresh tools: server "${name}" is not connected`,
        INTERNAL_ERROR
      );
    }

    const tools = await this.discoverTools(name, connection.transport);
    const prefix = connection.config.toolPrefix ?? name;
    this.toolRegistry.registerServer(name, tools, prefix);
    connection.toolCount = tools.length;

    this.log(`Refreshed tools for "${name}": ${String(tools.length)} tool(s).`);
  }

  /**
   * Compare two server configurations to determine if they differ in a way
   * that requires reconnection.
   *
   * Compares URL, transport type, command, args, apiKey, and auth settings.
   *
   * @param oldConfig - The previous server configuration.
   * @param newConfig - The new server configuration.
   * @returns True if the configuration has changed and requires reconnection.
   */
  private hasConfigChanged(
    oldConfig: MCPServerConfigType,
    newConfig: MCPServerConfigType
  ): boolean {
    if (oldConfig.url !== newConfig.url) return true;
    if ((oldConfig.transport ?? "http") !== (newConfig.transport ?? "http")) return true;
    if (oldConfig.command !== newConfig.command) return true;
    if (oldConfig.apiKey !== newConfig.apiKey) return true;
    if (oldConfig.toolPrefix !== newConfig.toolPrefix) return true;
    if (oldConfig.connectTimeoutMs !== newConfig.connectTimeoutMs) return true;
    if (oldConfig.requestTimeoutMs !== newConfig.requestTimeoutMs) return true;

    // Compare args arrays
    const oldArgs = oldConfig.args ?? [];
    const newArgs = newConfig.args ?? [];
    if (oldArgs.length !== newArgs.length) return true;
    for (let i = 0; i < oldArgs.length; i++) {
      if (oldArgs[i] !== newArgs[i]) return true;
    }

    // Compare env records
    const oldEnv = oldConfig.env ?? {};
    const newEnv = newConfig.env ?? {};
    const oldEnvKeys = Object.keys(oldEnv).sort();
    const newEnvKeys = Object.keys(newEnv).sort();
    if (oldEnvKeys.length !== newEnvKeys.length) return true;
    for (let i = 0; i < oldEnvKeys.length; i++) {
      if (oldEnvKeys[i] !== newEnvKeys[i]) return true;
      if (oldEnv[oldEnvKeys[i]] !== newEnv[newEnvKeys[i]]) return true;
    }

    // Compare auth config
    const oldAuth = oldConfig.auth;
    const newAuth = newConfig.auth;
    if ((oldAuth === undefined) !== (newAuth === undefined)) return true;
    if (oldAuth !== undefined && newAuth !== undefined) {
      if (oldAuth.clientId !== newAuth.clientId) return true;
      if (oldAuth.clientSecret !== newAuth.clientSecret) return true;
      if (oldAuth.authorizationServerUrl !== newAuth.authorizationServerUrl) return true;
      const oldScopes = (oldAuth.scopes ?? []).join(",");
      const newScopes = (newAuth.scopes ?? []).join(",");
      if (oldScopes !== newScopes) return true;
    }

    return false;
  }

  /**
   * Log a message to the console when debug mode is enabled.
   *
   * @param message - The message to log.
   */
  private log(message: string): void {
    if (this.debug) {
      console.log(`[MCPManager] ${message}`);
    }
  }
}
