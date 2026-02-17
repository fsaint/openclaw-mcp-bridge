/**
 * Integration tests for the LegacySSETransport.
 *
 * Tests the transport against an inline mock legacy MCP server that implements
 * the 2024-11-05 HTTP+SSE transport protocol:
 * 1. Client GETs the server URL to open an SSE stream
 * 2. Server sends an `endpoint` SSE event with the URL to POST to
 * 3. Client POSTs JSON-RPC requests to that endpoint
 * 4. Server responds with application/json
 *
 * Covers initialization, tool discovery, tool calls, notifications,
 * connection lifecycle, authentication, relative endpoint URLs,
 * server-initiated notifications, and timeout handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import {
  LegacySSETransport,
  RequestTimeoutError,
} from "../../src/transport/legacy-sse.js";
import { MCPError } from "../../src/types.js";
import type {
  InitializeResult,
  InitializeRequestParams,
  ToolsListResult,
  ToolsCallResult,
} from "../../src/types.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const INIT_PARAMS: InitializeRequestParams = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "test-client", version: "1.0.0" },
};

// ---------------------------------------------------------------------------
// Mock Legacy MCP Server (inline)
// ---------------------------------------------------------------------------

/**
 * A minimal mock MCP server implementing the 2024-11-05 HTTP+SSE transport.
 *
 * On GET with Accept: text/event-stream, opens a persistent SSE stream and
 * immediately sends an `endpoint` event. On POST to the endpoint path,
 * parses and handles JSON-RPC requests for initialize, tools/list, and
 * tools/call. Supports pushing server-initiated notifications on the SSE
 * stream.
 */
class MockLegacyServer {
  private server: Server | null = null;
  private port = 0;
  private sseConnections: Map<string, ServerResponse> = new Map();
  private recordedRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }> = [];

  /** If true, delay the SSE endpoint event (for connect timeout testing). */
  delayEndpointMs = 0;

  /** If true, send a relative endpoint path instead of absolute. */
  useRelativeEndpoint = false;

  /** If true, delay POST responses (for request timeout testing). */
  delayPostMs = 0;

  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: `Internal error: ${msg}` },
          }));
        });
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(`http://127.0.0.1:${this.port}`);
        } else {
          reject(new Error("Failed to get address"));
        }
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    for (const [, res] of this.sseConnections) {
      res.end();
    }
    this.sseConnections.clear();

    if (!this.server) return;
    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        this.port = 0;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Push a server-initiated notification on all open SSE connections. */
  pushNotification(notification: Record<string, unknown>): void {
    const data = JSON.stringify(notification);
    for (const [, res] of this.sseConnections) {
      res.write(`event: message\ndata: ${data}\n\n`);
    }
  }

  getRecordedRequests() {
    return [...this.recordedRequests];
  }

  resetRecordedRequests(): void {
    this.recordedRequests = [];
  }

  // -----------------------------------------------------------------------
  // Request routing
  // -----------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/" && req.headers.accept?.includes("text/event-stream")) {
      await this.handleSSEGet(req, res, url);
      return;
    }

    if (method === "POST" && url.pathname === "/messages") {
      await this.handlePost(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  // -----------------------------------------------------------------------
  // SSE GET handler
  // -----------------------------------------------------------------------

  private async handleSSEGet(req: IncomingMessage, res: ServerResponse, _url: URL): Promise<void> {
    this.recordedRequests.push({
      method: "GET",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: null,
    });

    const sessionId = randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    if (this.delayEndpointMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayEndpointMs));
    }

    const endpointPath = `/messages?sessionId=${sessionId}`;
    if (this.useRelativeEndpoint) {
      res.write(`event: endpoint\ndata: ${endpointPath}\n\n`);
    } else {
      res.write(`event: endpoint\ndata: http://127.0.0.1:${this.port}${endpointPath}\n\n`);
    }

    this.sseConnections.set(sessionId, res);

    req.on("close", () => {
      this.sseConnections.delete(sessionId);
    });
  }

  // -----------------------------------------------------------------------
  // POST handler
  // -----------------------------------------------------------------------

  private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }));
      return;
    }

    this.recordedRequests.push({
      method: "POST",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: parsed,
    });

    if (this.delayPostMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.delayPostMs));
    }

    const rpcMethod = parsed.method as string | undefined;
    const rpcId = parsed.id as string | number | null | undefined;

    // Notifications (no id) -- accept silently
    if (rpcId === undefined || rpcId === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    switch (rpcMethod) {
      case "initialize":
        this.respondInitialize(rpcId, res);
        break;

      case "tools/list":
        this.respondToolsList(rpcId, res);
        break;

      case "tools/call":
        this.respondToolsCall(rpcId, parsed.params as Record<string, unknown> | undefined, res);
        break;

      default: {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId,
          error: { code: -32601, message: `Method not found: ${String(rpcMethod)}` },
        }));
      }
    }
  }

  // -----------------------------------------------------------------------
  // JSON-RPC method handlers
  // -----------------------------------------------------------------------

  private respondInitialize(id: string | number, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "mock-legacy-server", version: "1.0.0" },
      },
    }));
  }

  private respondToolsList(id: string | number, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes back the provided message.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
          {
            name: "get_weather",
            description: "Returns mock weather data.",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
    }));
  }

  private respondToolsCall(
    id: string | number,
    params: Record<string, unknown> | undefined,
    res: ServerResponse,
  ): void {
    const toolName = params?.name as string | undefined;
    const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

    if (toolName === "echo") {
      const message = (toolArgs.message as string) ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Echo: ${message}` }],
          isError: false,
        },
      }));
      return;
    }

    if (toolName === "get_weather") {
      const city = (toolArgs.city as string) ?? "Unknown";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ city, temperature: 22, unit: "celsius", condition: "sunny" }),
          }],
          isError: false,
        },
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Unknown tool: ${String(toolName)}` },
    }));
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("LegacySSETransport", () => {
  let server: MockLegacyServer;
  let baseUrl: string;
  let transport: LegacySSETransport;

  // -----------------------------------------------------------------------
  // Setup / Teardown
  // -----------------------------------------------------------------------

  beforeEach(async () => {
    server = new MockLegacyServer();
    baseUrl = await server.start();

    transport = new LegacySSETransport({ url: baseUrl });
  });

  afterEach(async () => {
    try {
      await transport.close();
    } catch {
      // Ignore errors during cleanup
    }
    await server.stop();
  });

  // -----------------------------------------------------------------------
  // 1. Initialize
  // -----------------------------------------------------------------------

  describe("Initialize", () => {
    it("should open SSE, receive endpoint, send initialize, and get capabilities", async () => {
      const result = await transport.initialize(INIT_PARAMS);

      expect(result).toBeDefined();
      expect(result.protocolVersion).toBe("2024-11-05");
      expect(result.serverInfo).toBeDefined();
      expect(result.serverInfo.name).toBe("mock-legacy-server");
      expect(result.serverInfo.version).toBe("1.0.0");
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities).toHaveProperty("tools");
    });

    it("should send notifications/initialized after initialize request", async () => {
      await transport.initialize(INIT_PARAMS);

      const requests = server.getRecordedRequests();

      const initReq = requests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "initialize",
      );
      expect(initReq).toBeDefined();

      const notifReq = requests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "notifications/initialized",
      );
      expect(notifReq).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2. sendRequest — tools/list
  // -----------------------------------------------------------------------

  describe("sendRequest — tools/list", () => {
    it("should return a tools array from tools/list", async () => {
      await transport.initialize(INIT_PARAMS);

      const response = await transport.sendRequest("tools/list");

      expect("result" in response).toBe(true);

      const result = (response as { result: unknown }).result as ToolsListResult;
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBe(2);

      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("get_weather");
    });
  });

  // -----------------------------------------------------------------------
  // 3. sendRequest — tools/call
  // -----------------------------------------------------------------------

  describe("sendRequest — tools/call", () => {
    it("should call the echo tool and get a result", async () => {
      await transport.initialize(INIT_PARAMS);

      const response = await transport.sendRequest("tools/call", {
        name: "echo",
        arguments: { message: "hello world" },
      });

      expect("result" in response).toBe(true);

      const result = (response as { result: unknown }).result as ToolsCallResult;
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Echo: hello world");
      expect(result.isError).toBe(false);
    });

    it("should call the get_weather tool and get a JSON result", async () => {
      await transport.initialize(INIT_PARAMS);

      const response = await transport.sendRequest("tools/call", {
        name: "get_weather",
        arguments: { city: "San Francisco" },
      });

      expect("result" in response).toBe(true);

      const result = (response as { result: unknown }).result as ToolsCallResult;
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");

      const weatherData = JSON.parse(result.content[0].text!) as Record<string, unknown>;
      expect(weatherData.city).toBe("San Francisco");
      expect(weatherData.temperature).toBe(22);
      expect(weatherData.condition).toBe("sunny");
    });
  });

  // -----------------------------------------------------------------------
  // 4. sendNotification
  // -----------------------------------------------------------------------

  describe("sendNotification", () => {
    it("should send a notification without expecting a response body", async () => {
      await transport.initialize(INIT_PARAMS);

      await expect(
        transport.sendNotification("notifications/cancelled", {
          requestId: 999,
          reason: "User cancelled",
        }),
      ).resolves.toBeUndefined();
    });

    it("should POST a notification with no id field", async () => {
      await transport.initialize(INIT_PARAMS);

      server.resetRecordedRequests();

      await transport.sendNotification("notifications/cancelled", {
        requestId: 42,
        reason: "test",
      });

      const requests = server.getRecordedRequests();
      const notifReq = requests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "notifications/cancelled",
      );

      expect(notifReq).toBeDefined();
      // Notifications must not have an "id" field
      expect((notifReq!.body as Record<string, unknown>)).not.toHaveProperty("id");
    });
  });

  // -----------------------------------------------------------------------
  // 5. close
  // -----------------------------------------------------------------------

  describe("close", () => {
    it("should cleanly shut down without error", async () => {
      await transport.initialize(INIT_PARAMS);

      await expect(transport.close()).resolves.toBeUndefined();
    });

    it("should be safe to call close multiple times", async () => {
      await transport.initialize(INIT_PARAMS);

      await transport.close();
      await expect(transport.close()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 6. isConnected
  // -----------------------------------------------------------------------

  describe("isConnected", () => {
    it("should be false before initialization", () => {
      expect(transport.isConnected).toBe(false);
    });

    it("should be true after successful initialization", async () => {
      await transport.initialize(INIT_PARAMS);

      expect(transport.isConnected).toBe(true);
    });

    it("should be false after close", async () => {
      await transport.initialize(INIT_PARAMS);
      expect(transport.isConnected).toBe(true);

      await transport.close();
      expect(transport.isConnected).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 7. API key auth
  // -----------------------------------------------------------------------

  describe("API key auth", () => {
    it("should send Authorization: Bearer header on both GET and POST", async () => {
      const authedTransport = new LegacySSETransport({
        url: baseUrl,
        apiKey: "test-api-key-xyz",
      });

      await authedTransport.initialize(INIT_PARAMS);

      const requests = server.getRecordedRequests();

      // The GET request for SSE should include Authorization
      const getReq = requests.find((r) => r.method === "GET");
      expect(getReq).toBeDefined();
      expect(getReq!.headers["authorization"]).toBe("Bearer test-api-key-xyz");

      // The POST request for initialize should include Authorization
      const postReq = requests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "initialize",
      );
      expect(postReq).toBeDefined();
      expect(postReq!.headers["authorization"]).toBe("Bearer test-api-key-xyz");

      await authedTransport.close();
    });
  });

  // -----------------------------------------------------------------------
  // 8. Relative endpoint URL
  // -----------------------------------------------------------------------

  describe("Relative endpoint URL", () => {
    it("should resolve a relative endpoint path against the base URL", async () => {
      server.useRelativeEndpoint = true;

      await transport.initialize(INIT_PARAMS);

      // If it initializes successfully it means the relative URL was resolved
      // correctly and the POST to the endpoint worked.
      expect(transport.isConnected).toBe(true);

      const response = await transport.sendRequest("tools/list");
      expect("result" in response).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Server notifications
  // -----------------------------------------------------------------------

  describe("Server notifications", () => {
    it("should invoke onNotification callback when the server pushes a message", async () => {
      await transport.initialize(INIT_PARAMS);

      const received: unknown[] = [];
      transport.onNotification = (msg) => {
        received.push(msg);
      };

      // Push a notification from the server via the SSE stream
      server.pushNotification({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });

      // Give the background SSE stream a moment to process the event
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(received.length).toBe(1);
      expect((received[0] as Record<string, unknown>).method).toBe(
        "notifications/tools/list_changed",
      );
    });

    it("should not crash when onNotification is not set and server pushes a message", async () => {
      await transport.initialize(INIT_PARAMS);

      // onNotification is not set (null by default)
      server.pushNotification({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });

      // Give some time for the event to be processed
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // Transport should still be functional
      expect(transport.isConnected).toBe(true);

      const response = await transport.sendRequest("tools/list");
      expect("result" in response).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Connection timeout
  // -----------------------------------------------------------------------

  describe("Connection timeout", () => {
    it("should throw when server is unreachable", async () => {
      const deadTransport = new LegacySSETransport({
        url: "http://127.0.0.1:1",
        connectTimeoutMs: 2000,
      });

      await expect(deadTransport.initialize(INIT_PARAMS)).rejects.toThrow();
    });

    it("should throw RequestTimeoutError when SSE endpoint event is delayed beyond connectTimeoutMs", async () => {
      // Set a long delay for the endpoint event
      server.delayEndpointMs = 5000;

      const shortConnectTransport = new LegacySSETransport({
        url: baseUrl,
        connectTimeoutMs: 200,
      });

      await expect(
        shortConnectTransport.initialize(INIT_PARAMS),
      ).rejects.toThrow(RequestTimeoutError);
    });
  });

  // -----------------------------------------------------------------------
  // 11. Request timeout
  // -----------------------------------------------------------------------

  describe("Request timeout", () => {
    it("should throw RequestTimeoutError when POST response is slow", async () => {
      // Initialize with normal timing
      await transport.initialize(INIT_PARAMS);
      await transport.close();

      // Set up a slow POST response and a short request timeout
      server.delayPostMs = 5000;

      const shortTimeoutTransport = new LegacySSETransport({
        url: baseUrl,
        requestTimeoutMs: 200,
        connectTimeoutMs: 5000,
      });

      // Initialize should succeed (GET for SSE is fast, but the POST for
      // initialize will be slow). The initialize method calls sendRequest
      // internally, which should timeout.
      await expect(
        shortTimeoutTransport.initialize(INIT_PARAMS),
      ).rejects.toThrow(RequestTimeoutError);
    });
  });
});
