/**
 * Mock MCP Server for integration testing.
 *
 * A minimal but realistic MCP server implementing the Streamable HTTP transport
 * (MCP 2025-03-26 spec). Supports POST, GET, DELETE on a single /mcp endpoint,
 * session management via Mcp-Session-Id, JSON and SSE response modes, and
 * configurable simulation behaviors for testing error/edge cases.
 *
 * @see SPEC.md section 4 — MCP Streamable HTTP Transport Implementation
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded HTTP request for test assertions. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  readonly timestamp: number;
}

/** Configurable simulation options for testing error/edge-case behaviors. */
export interface MockServerOptions {
  /** Return 401 with WWW-Authenticate header on the next non-initialize request. */
  simulateAuthRequired: boolean;
  /** Session ID to treat as expired (returns 404). */
  simulateSessionExpiry: string | null;
  /** Milliseconds to delay before responding. */
  simulateSlowResponse: number;
  /** Break the SSE stream mid-response (after sending partial data). */
  simulateStreamDisconnect: boolean;
}

/** JSON-RPC 2.0 request structure. */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response structure. */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** JSON-RPC 2.0 notification (no id field). */
interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock tools returned by tools/list
// ---------------------------------------------------------------------------

const MOCK_TOOLS = [
  {
    name: "echo",
    description: "Echoes back the provided message immediately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string" as const, description: "The message to echo" },
      },
      required: ["message"],
    },
  },
  {
    name: "slow_counter",
    description: "Streams a count from 1 to N via SSE, one number per event.",
    inputSchema: {
      type: "object" as const,
      properties: {
        count: {
          type: "number" as const,
          description: "How high to count (1-10)",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["count"],
    },
  },
  {
    name: "get_weather",
    description: "Returns mock weather data for a given city.",
    inputSchema: {
      type: "object" as const,
      properties: {
        city: { type: "string" as const, description: "City name" },
      },
      required: ["city"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// MockMCPServer
// ---------------------------------------------------------------------------

/**
 * A mock MCP server for integration testing.
 *
 * Implements the MCP Streamable HTTP transport (2025-03-26) with configurable
 * simulation behaviors for testing error paths, auth flows, and SSE streaming.
 *
 * @example
 * ```ts
 * const server = new MockMCPServer();
 * const url = await server.start();
 * // ... run tests against url ...
 * await server.stop();
 * ```
 */
export class MockMCPServer {
  private server: Server | null = null;
  private port = 0;
  private requests: RecordedRequest[] = [];
  private sessions: Map<string, { createdAt: number }> = new Map();
  private options: MockServerOptions = {
    simulateAuthRequired: false,
    simulateSessionExpiry: null,
    simulateSlowResponse: 0,
    simulateStreamDisconnect: false,
  };

  /** Active SSE connections for server-initiated notifications (GET /mcp). */
  private sseConnections: Map<string, ServerResponse> = new Map();

  /** Monotonic SSE event ID counter for resumability testing. */
  private sseEventIdCounter = 0;

  /**
   * Start the mock MCP server on a random available port.
   *
   * @returns The base URL of the running server (e.g. "http://127.0.0.1:12345").
   */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error("MockMCPServer is already running");
    }

    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: `Internal server error: ${message}` },
            })
          );
        });
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(`http://127.0.0.1:${this.port}`);
        } else {
          reject(new Error("Failed to determine server address"));
        }
      });

      this.server.on("error", reject);
    });
  }

  /**
   * Gracefully shut down the mock server.
   *
   * Closes all active SSE connections and terminates the HTTP server.
   */
  async stop(): Promise<void> {
    // Close all SSE connections
    for (const [, res] of this.sseConnections) {
      res.end();
    }
    this.sseConnections.clear();

    if (!this.server) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        this.port = 0;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get the base URL of the running server.
   *
   * @returns The URL string, e.g. "http://127.0.0.1:12345".
   * @throws If the server is not running.
   */
  getUrl(): string {
    if (!this.server || this.port === 0) {
      throw new Error("MockMCPServer is not running");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Get all recorded requests for test assertions.
   *
   * @returns Array of RecordedRequest objects in chronological order.
   */
  getRequests(): readonly RecordedRequest[] {
    return [...this.requests];
  }

  /**
   * Clear the recorded request log.
   */
  resetRequests(): void {
    this.requests = [];
  }

  /**
   * Set a simulation option for testing error/edge-case behaviors.
   *
   * @param key - The option name.
   * @param value - The option value.
   */
  setOption<K extends keyof MockServerOptions>(
    key: K,
    value: MockServerOptions[K]
  ): void {
    this.options[key] = value;
  }

  /**
   * Get the current value of a simulation option.
   *
   * @param key - The option name.
   * @returns The current option value.
   */
  getOption<K extends keyof MockServerOptions>(key: K): MockServerOptions[K] {
    return this.options[key];
  }

  /**
   * Get the set of currently active session IDs.
   *
   * @returns Array of session ID strings.
   */
  getActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  // -----------------------------------------------------------------------
  // Private: request handling
  // -----------------------------------------------------------------------

  /**
   * Main request handler — dispatches based on path and method.
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    // Only serve the /mcp endpoint
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Apply simulated slow response delay
    if (this.options.simulateSlowResponse > 0) {
      await this.delay(this.options.simulateSlowResponse);
    }

    const method = (req.method ?? "GET").toUpperCase();

    switch (method) {
      case "POST":
        await this.handlePost(req, res);
        break;
      case "GET":
        await this.handleGet(req, res);
        break;
      case "DELETE":
        await this.handleDelete(req, res);
        break;
      default:
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Method ${method} not allowed` }));
    }
  }

  /**
   * Handle POST /mcp — JSON-RPC requests and notifications.
   */
  private async handlePost(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req);
    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      this.recordRequest(req, body);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    this.recordRequest(req, parsed);

    // Handle batched requests (array of JSON-RPC messages)
    if (Array.isArray(parsed)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of parsed) {
        const rpcReq = item as JsonRpcRequest;
        const rpcRes = await this.routeJsonRpc(rpcReq, req, res);
        if (rpcRes !== null) {
          responses.push(rpcRes);
        }
      }
      if (responses.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responses));
      }
      return;
    }

    const rpcReq = parsed as JsonRpcRequest;

    // Validate JSON-RPC structure
    if (rpcReq.jsonrpc !== "2.0" || typeof rpcReq.method !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcReq.id ?? null,
          error: { code: -32600, message: "Invalid Request" },
        })
      );
      return;
    }

    // Simulate auth required (401) for non-initialize requests
    if (
      this.options.simulateAuthRequired &&
      rpcReq.method !== "initialize"
    ) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate":
          'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource", scope="tools:read tools:execute"',
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcReq.id ?? null,
          error: { code: -32001, message: "Unauthorized" },
        })
      );
      return;
    }

    // Session validation for non-initialize methods
    if (rpcReq.method !== "initialize") {
      const sessionValidation = this.validateSession(req, res);
      if (!sessionValidation) {
        return; // Response already sent
      }
    }

    // Route the JSON-RPC method
    const rpcRes = await this.routeJsonRpc(rpcReq, req, res);

    // Notifications (no id) get 202 Accepted — routeJsonRpc returns null
    if (rpcRes === null) {
      return;
    }
  }

  /**
   * Handle GET /mcp — open a server-initiated SSE stream.
   *
   * The client opens a GET to receive server-initiated notifications and requests.
   * The Mcp-Session-Id header is required.
   */
  private async handleGet(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    this.recordRequest(req, null);

    const sessionValidation = this.validateSession(req, res);
    if (!sessionValidation) {
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string;

    // Check for Last-Event-ID for resumability
    const _lastEventId = req.headers["last-event-id"] as string | undefined;

    // Set up SSE stream
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Mcp-Session-Id": sessionId,
    });

    // Store the connection for later server-initiated messages
    this.sseConnections.set(sessionId, res);

    // Send an initial comment to confirm the stream is open
    res.write(": stream opened\n\n");

    // Clean up on close
    req.on("close", () => {
      this.sseConnections.delete(sessionId);
    });
  }

  /**
   * Handle DELETE /mcp — terminate a session.
   *
   * Validates the Mcp-Session-Id header and removes the session.
   */
  private async handleDelete(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    this.recordRequest(req, null);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing Mcp-Session-Id header" }));
      return;
    }

    if (!this.sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // Close any SSE connection for this session
    const sseRes = this.sseConnections.get(sessionId);
    if (sseRes) {
      sseRes.end();
      this.sseConnections.delete(sessionId);
    }

    this.sessions.delete(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "session terminated" }));
  }

  // -----------------------------------------------------------------------
  // Private: JSON-RPC method routing
  // -----------------------------------------------------------------------

  /**
   * Route a JSON-RPC request to the appropriate handler.
   *
   * @param rpcReq - The parsed JSON-RPC request.
   * @param req - The HTTP request (for headers).
   * @param res - The HTTP response (for sending the result).
   * @returns The JSON-RPC response, or null for notifications.
   */
  private async routeJsonRpc(
    rpcReq: JsonRpcRequest,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<JsonRpcResponse | null> {
    switch (rpcReq.method) {
      case "initialize":
        return this.handleInitialize(rpcReq, res);

      case "notifications/initialized":
        this.handleInitializedNotification(res);
        return null;

      case "tools/list":
        return this.handleToolsList(rpcReq, res);

      case "tools/call":
        return this.handleToolsCall(rpcReq, req, res);

      case "ping":
        return this.handlePing(rpcReq, res);

      default: {
        // Unknown method: if it has an id, return method not found
        if (rpcReq.id !== undefined && rpcReq.id !== null) {
          const response: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: rpcReq.id,
            error: {
              code: -32601,
              message: `Method not found: ${rpcReq.method}`,
            },
          };
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify(response));
          return null;
        }
        // Notification for unknown method: just accept it
        if (!res.headersSent) {
          res.writeHead(202);
        }
        res.end();
        return null;
      }
    }
  }

  /**
   * Handle the "initialize" JSON-RPC method.
   *
   * Creates a new session and returns server info, capabilities, and
   * the protocol version. Sets the Mcp-Session-Id response header.
   */
  private handleInitialize(
    rpcReq: JsonRpcRequest,
    res: ServerResponse
  ): JsonRpcResponse {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { createdAt: Date.now() });

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "mock-mcp-server",
          version: "1.0.0",
        },
      },
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
    });
    res.end(JSON.stringify(response));
    return response;
  }

  /**
   * Handle the "notifications/initialized" notification.
   *
   * Notifications have no id and get a 202 Accepted response.
   */
  private handleInitializedNotification(res: ServerResponse): void {
    if (!res.headersSent) {
      res.writeHead(202);
    }
    res.end();
  }

  /**
   * Handle the "ping" JSON-RPC method.
   *
   * Returns an empty result object to confirm the server is reachable.
   */
  private handlePing(
    rpcReq: JsonRpcRequest,
    res: ServerResponse
  ): JsonRpcResponse {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {},
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return response;
  }

  /**
   * Handle the "tools/list" JSON-RPC method.
   *
   * Returns the list of mock tools with their schemas.
   */
  private handleToolsList(
    rpcReq: JsonRpcRequest,
    res: ServerResponse
  ): JsonRpcResponse {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {
        tools: MOCK_TOOLS,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return response;
  }

  /**
   * Handle the "tools/call" JSON-RPC method.
   *
   * Routes to the appropriate mock tool handler. The "echo" and "get_weather"
   * tools return JSON responses. The "slow_counter" tool streams via SSE.
   */
  private async handleToolsCall(
    rpcReq: JsonRpcRequest,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<JsonRpcResponse | null> {
    const params = rpcReq.params ?? {};
    const toolName = params.name as string | undefined;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      const response: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: rpcReq.id ?? null,
        error: { code: -32602, message: "Missing tool name in params" },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return response;
    }

    switch (toolName) {
      case "echo":
        return this.handleEchoTool(rpcReq, toolArgs, res);

      case "slow_counter":
        await this.handleSlowCounterTool(rpcReq, toolArgs, req, res);
        return null; // Response sent via SSE

      case "get_weather":
        return this.handleGetWeatherTool(rpcReq, toolArgs, res);

      default: {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: rpcReq.id ?? null,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return response;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: individual tool handlers
  // -----------------------------------------------------------------------

  /**
   * Handle the "echo" tool — returns the message immediately as JSON.
   */
  private handleEchoTool(
    rpcReq: JsonRpcRequest,
    args: Record<string, unknown>,
    res: ServerResponse
  ): JsonRpcResponse {
    const message = (args.message as string) ?? "";

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {
        content: [{ type: "text", text: `Echo: ${message}` }],
        isError: false,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return response;
  }

  /**
   * Handle the "slow_counter" tool — streams results via SSE.
   *
   * Sends progress notifications followed by the final result,
   * each as a separate SSE event with an incrementing event ID.
   */
  private async handleSlowCounterTool(
    rpcReq: JsonRpcRequest,
    args: Record<string, unknown>,
    _req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const count = Math.min(Math.max(Number(args.count) || 3, 1), 10);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Stream progress notifications
    for (let i = 1; i <= count; i++) {
      // Check for simulated stream disconnect
      if (this.options.simulateStreamDisconnect && i === Math.ceil(count / 2)) {
        res.destroy();
        return;
      }

      this.sseEventIdCounter++;
      const eventId = String(this.sseEventIdCounter);

      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: rpcReq.id,
          progress: i,
          total: count,
          message: `Counting: ${i}/${count}`,
        },
      };

      res.write(`id: ${eventId}\n`);
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(notification)}\n\n`);

      // Small delay between events to simulate streaming
      await this.delay(10);
    }

    // Send the final result
    this.sseEventIdCounter++;
    const finalEventId = String(this.sseEventIdCounter);

    const finalResponse: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {
        content: [
          {
            type: "text",
            text: `Counted from 1 to ${count}`,
          },
        ],
        isError: false,
      },
    };

    res.write(`id: ${finalEventId}\n`);
    res.write(`event: message\n`);
    res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);

    res.end();
  }

  /**
   * Handle the "get_weather" tool — returns mock weather data as JSON.
   */
  private handleGetWeatherTool(
    rpcReq: JsonRpcRequest,
    args: Record<string, unknown>,
    res: ServerResponse
  ): JsonRpcResponse {
    const city = (args.city as string) ?? "Unknown";

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: rpcReq.id ?? null,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              city,
              temperature: 22,
              unit: "celsius",
              condition: "sunny",
              humidity: 45,
            }),
          },
        ],
        isError: false,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return response;
  }

  // -----------------------------------------------------------------------
  // Private: session validation
  // -----------------------------------------------------------------------

  /**
   * Validate the Mcp-Session-Id header on the incoming request.
   *
   * @param req - The HTTP request.
   * @param res - The HTTP response (used to send error responses).
   * @returns True if the session is valid; false if a response was sent.
   */
  private validateSession(
    req: IncomingMessage,
    res: ServerResponse
  ): boolean {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Missing Mcp-Session-Id header" },
        })
      );
      return false;
    }

    // Simulate session expiry for a specific session
    if (this.options.simulateSessionExpiry === sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Session expired" },
        })
      );
      return false;
    }

    if (!this.sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Session not found or expired" },
        })
      );
      return false;
    }

    return true;
  }

  // -----------------------------------------------------------------------
  // Private: utilities
  // -----------------------------------------------------------------------

  /**
   * Read the full body of an HTTP request as a string.
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /**
   * Record an incoming request for later assertion.
   */
  private recordRequest(req: IncomingMessage, body: unknown): void {
    this.requests.push({
      method: req.method ?? "UNKNOWN",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
      timestamp: Date.now(),
    });
  }

  /**
   * Utility: delay for a given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
