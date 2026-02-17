/**
 * Tests for the MockMCPServer test fixture.
 *
 * Verifies that the mock server starts, responds correctly to MCP Streamable HTTP
 * transport methods (POST/GET/DELETE), handles session management, and supports
 * configurable simulation behaviors.
 *
 * @see SPEC.md section 4 — MCP Streamable HTTP Transport Implementation
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockMCPServer } from "./mock-mcp-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON-RPC request to the mock server via POST.
 *
 * @param url - Base URL of the mock server.
 * @param body - JSON-RPC request body.
 * @param headers - Additional headers to include.
 * @returns The fetch Response object.
 */
async function postJsonRpc(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Send an initialize request and return the session ID.
 *
 * @param url - Base URL of the mock server.
 * @returns Object with the parsed response body and session ID.
 */
async function initializeSession(
  url: string
): Promise<{ body: Record<string, unknown>; sessionId: string }> {
  const res = await postJsonRpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });

  const body = (await res.json()) as Record<string, unknown>;
  const sessionId = res.headers.get("mcp-session-id");

  if (!sessionId) {
    throw new Error("No Mcp-Session-Id header in initialize response");
  }

  return { body, sessionId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MockMCPServer", () => {
  let server: MockMCPServer;
  let url: string;

  beforeEach(async () => {
    server = new MockMCPServer();
    url = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("should start and return a valid URL", () => {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("should return the URL via getUrl()", () => {
      expect(server.getUrl()).toBe(url);
    });

    it("should stop cleanly", async () => {
      await server.stop();

      // After stopping, fetching should fail
      await expect(
        fetch(`${url}/mcp`).catch((err: unknown) => {
          throw err;
        })
      ).rejects.toThrow();
    });

    it("should throw if started twice", async () => {
      await expect(server.start()).rejects.toThrow("already running");
    });

    it("should throw getUrl() if not running", async () => {
      const newServer = new MockMCPServer();
      expect(() => newServer.getUrl()).toThrow("not running");
    });
  });

  // -------------------------------------------------------------------------
  // Initialize
  // -------------------------------------------------------------------------

  describe("initialize", () => {
    it("should respond to initialize with server info and session ID", async () => {
      const { body, sessionId } = await initializeSession(url);

      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");

      const result = body.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2025-03-26");
      expect(result.serverInfo).toEqual({
        name: "mock-mcp-server",
        version: "1.0.0",
      });
      expect(result.capabilities).toEqual({
        tools: { listChanged: true },
      });
    });

    it("should generate unique session IDs for each initialize", async () => {
      const { sessionId: id1 } = await initializeSession(url);
      const { sessionId: id2 } = await initializeSession(url);

      expect(id1).not.toBe(id2);
    });

    it("should track active sessions", async () => {
      expect(server.getActiveSessions()).toHaveLength(0);

      const { sessionId } = await initializeSession(url);
      expect(server.getActiveSessions()).toContain(sessionId);
      expect(server.getActiveSessions()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // notifications/initialized
  // -------------------------------------------------------------------------

  describe("notifications/initialized", () => {
    it("should return 202 Accepted for initialized notification", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(202);
    });
  });

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  describe("session management", () => {
    it("should return 400 when Mcp-Session-Id is missing on non-initialize requests", async () => {
      const res = await postJsonRpc(url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.message).toMatch(/Missing Mcp-Session-Id/i);
    });

    it("should return 404 when Mcp-Session-Id is invalid", async () => {
      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        },
        { "Mcp-Session-Id": "non-existent-session" }
      );

      expect(res.status).toBe(404);
    });

    it("should accept valid session ID", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
    });

    it("should terminate session on DELETE", async () => {
      const { sessionId } = await initializeSession(url);

      // DELETE the session
      const deleteRes = await fetch(`${url}/mcp`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": sessionId },
      });
      expect(deleteRes.status).toBe(200);

      // Now the session should be gone
      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
        },
        { "Mcp-Session-Id": sessionId }
      );
      expect(res.status).toBe(404);
    });

    it("should return 400 for DELETE without session ID", async () => {
      const deleteRes = await fetch(`${url}/mcp`, {
        method: "DELETE",
      });
      expect(deleteRes.status).toBe(400);
    });

    it("should return 404 for DELETE with unknown session ID", async () => {
      const deleteRes = await fetch(`${url}/mcp`, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": "does-not-exist" },
      });
      expect(deleteRes.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  describe("tools/list", () => {
    it("should return mock tools with schemas", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(2);

      const result = body.result as { tools: Array<Record<string, unknown>> };
      expect(result.tools).toHaveLength(3);

      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("echo");
      expect(toolNames).toContain("slow_counter");
      expect(toolNames).toContain("get_weather");

      // Verify tools have input schemas
      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect((tool.inputSchema as Record<string, unknown>).type).toBe(
          "object"
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // tools/call — JSON response
  // -------------------------------------------------------------------------

  describe("tools/call (JSON response)", () => {
    it("should handle the echo tool", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { message: "hello world" },
          },
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(3);

      const result = body.result as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe("Echo: hello world");
    });

    it("should handle the get_weather tool", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "get_weather",
            arguments: { city: "San Francisco" },
          },
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const result = body.result as {
        content: Array<{ type: string; text: string }>;
      };

      const weather = JSON.parse(result.content[0].text) as Record<
        string,
        unknown
      >;
      expect(weather.city).toBe("San Francisco");
      expect(weather.temperature).toBe(22);
      expect(weather.condition).toBe("sunny");
    });

    it("should return error for unknown tool", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "nonexistent_tool",
            arguments: {},
          },
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toMatch(/Unknown tool/);
    });

    it("should return error when tool name is missing", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {},
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32602);
      expect(error.message).toMatch(/Missing tool name/);
    });
  });

  // -------------------------------------------------------------------------
  // tools/call — SSE streaming response
  // -------------------------------------------------------------------------

  describe("tools/call (SSE streaming response)", () => {
    it("should stream slow_counter results via SSE", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "slow_counter",
            arguments: { count: 3 },
          },
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

      // Read the full SSE body
      const body = await res.text();

      // Should contain progress notifications
      expect(body).toContain('"method":"notifications/progress"');

      // Should contain the final result
      expect(body).toContain("Counted from 1 to 3");

      // Should contain event IDs for resumability
      expect(body).toMatch(/id: \d+/);

      // Should contain event type
      expect(body).toContain("event: message");

      // Parse all the SSE data lines
      const dataLines = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);

      // 3 progress notifications + 1 final result = 4 data events
      expect(dataLines).toHaveLength(4);

      // Verify progress notifications
      const progressEvents = dataLines.filter(
        (d) => d.method === "notifications/progress"
      );
      expect(progressEvents).toHaveLength(3);

      // Verify final result
      const finalResult = dataLines.find((d) => d.result !== undefined);
      expect(finalResult).toBeDefined();
      expect(finalResult!.id).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // GET /mcp — Server-initiated SSE stream
  // -------------------------------------------------------------------------

  describe("GET /mcp (server-initiated SSE stream)", () => {
    it("should open an SSE stream with valid session", async () => {
      const { sessionId } = await initializeSession(url);

      const controller = new AbortController();

      const res = await fetch(`${url}/mcp`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Mcp-Session-Id": sessionId,
        },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("mcp-session-id")).toBe(sessionId);

      // Abort the stream since the mock server keeps it open
      controller.abort();
    });

    it("should return 400 for GET without session ID", async () => {
      const res = await fetch(`${url}/mcp`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(400);
    });

    it("should return 404 for GET with invalid session ID", async () => {
      const res = await fetch(`${url}/mcp`, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Mcp-Session-Id": "invalid-session",
        },
      });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Request recording
  // -------------------------------------------------------------------------

  describe("request recording", () => {
    it("should record all requests", async () => {
      expect(server.getRequests()).toHaveLength(0);

      await initializeSession(url);

      const requests = server.getRequests();
      expect(requests.length).toBeGreaterThanOrEqual(1);
      expect(requests[0].method).toBe("POST");
      expect(requests[0].url).toBe("/mcp");
    });

    it("should clear requests on resetRequests()", async () => {
      await initializeSession(url);
      expect(server.getRequests().length).toBeGreaterThan(0);

      server.resetRequests();
      expect(server.getRequests()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Simulation options
  // -------------------------------------------------------------------------

  describe("simulation: simulateAuthRequired", () => {
    it("should return 401 with WWW-Authenticate for non-initialize requests", async () => {
      const { sessionId } = await initializeSession(url);

      server.setOption("simulateAuthRequired", true);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/list",
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get("www-authenticate");
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain("Bearer");
      expect(wwwAuth).toContain("resource_metadata");
      expect(wwwAuth).toContain("scope");
    });

    it("should still allow initialize when auth is required", async () => {
      server.setOption("simulateAuthRequired", true);

      const res = await postJsonRpc(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeTruthy();
    });
  });

  describe("simulation: simulateSessionExpiry", () => {
    it("should return 404 for the specified expired session", async () => {
      const { sessionId } = await initializeSession(url);

      server.setOption("simulateSessionExpiry", sessionId);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/list",
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(404);
    });

    it("should not affect other sessions", async () => {
      const { sessionId: session1 } = await initializeSession(url);
      const { sessionId: session2 } = await initializeSession(url);

      server.setOption("simulateSessionExpiry", session1);

      // session1 is "expired"
      const res1 = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/list",
        },
        { "Mcp-Session-Id": session1 }
      );
      expect(res1.status).toBe(404);

      // session2 should still work
      const res2 = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/list",
        },
        { "Mcp-Session-Id": session2 }
      );
      expect(res2.status).toBe(200);
    });
  });

  describe("simulation: simulateSlowResponse", () => {
    it("should delay the response by the configured time", async () => {
      server.setOption("simulateSlowResponse", 200);

      const start = Date.now();
      await initializeSession(url);
      const elapsed = Date.now() - start;

      // Should take at least 200ms (the delay), allow some tolerance
      expect(elapsed).toBeGreaterThanOrEqual(180);
    });
  });

  describe("simulation: simulateStreamDisconnect", () => {
    it("should break the SSE stream mid-response", async () => {
      const { sessionId } = await initializeSession(url);

      server.setOption("simulateStreamDisconnect", true);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "slow_counter",
            arguments: { count: 6 },
          },
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);

      // The server calls res.destroy() to simulate a mid-stream disconnect.
      // Reading the body may succeed with partial data OR throw a socket error
      // (e.g. TypeError: terminated, SocketError: other side closed).
      // Both outcomes are valid — the disconnect IS the expected behavior.
      let body: string;
      try {
        body = await res.text();
      } catch (err: unknown) {
        // Socket was closed by the server before the client finished reading.
        // This confirms the disconnect happened — the test passes.
        const message = err instanceof Error ? err.message : String(err);
        expect(
          message.includes("terminated") ||
            message.includes("other side closed") ||
            message.includes("aborted") ||
            message.includes("ECONNRESET")
        ).toBe(true);
        return;
      }

      // If we DID get partial data, verify it has progress but not the final result.
      // The disconnect happens at ceil(6/2) = 3, so we should see events 1 and 2
      expect(body).toContain('"method":"notifications/progress"');
      expect(body).not.toContain("Counted from 1 to 6");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("should return 404 for non /mcp paths", async () => {
      const res = await fetch(`${url}/other`);
      expect(res.status).toBe(404);
    });

    it("should return 405 for unsupported methods", async () => {
      const res = await fetch(`${url}/mcp`, {
        method: "PUT",
      });
      expect(res.status).toBe(405);
    });

    it("should return parse error for invalid JSON", async () => {
      const res = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32700);
      expect(error.message).toMatch(/Parse error/);
    });

    it("should return invalid request for bad JSON-RPC structure", async () => {
      const res = await postJsonRpc(url, {
        jsonrpc: "1.0",
        id: 1,
        method: "initialize",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as { code: number };
      expect(error.code).toBe(-32600);
    });

    it("should return method not found for unknown methods with an id", async () => {
      const { sessionId } = await initializeSession(url);

      const res = await postJsonRpc(
        url,
        {
          jsonrpc: "2.0",
          id: 99,
          method: "unknown/method",
        },
        { "Mcp-Session-Id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body.error as { code: number; message: string };
      expect(error.code).toBe(-32601);
      expect(error.message).toMatch(/Method not found/);
    });
  });

  // -------------------------------------------------------------------------
  // setOption / getOption
  // -------------------------------------------------------------------------

  describe("setOption / getOption", () => {
    it("should get and set options", () => {
      expect(server.getOption("simulateAuthRequired")).toBe(false);
      server.setOption("simulateAuthRequired", true);
      expect(server.getOption("simulateAuthRequired")).toBe(true);
    });

    it("should have sensible defaults", () => {
      expect(server.getOption("simulateAuthRequired")).toBe(false);
      expect(server.getOption("simulateSessionExpiry")).toBeNull();
      expect(server.getOption("simulateSlowResponse")).toBe(0);
      expect(server.getOption("simulateStreamDisconnect")).toBe(false);
    });
  });
});
