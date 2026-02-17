/**
 * Integration tests for the MCPManager.
 *
 * Tests the full MCPManager lifecycle against MockMCPServer instances,
 * covering connection management, tool discovery, tool calling, config
 * reconciliation, tool refresh, error handling, and API key authentication.
 *
 * @see SPEC.md section 3 for MCPManager architecture
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MockMCPServer } from "../fixtures/mock-mcp-server.js";
import { MCPManager } from "../../src/manager/mcp-manager.js";
import type { MCPManagerConfig } from "../../src/manager/mcp-manager.js";
import type { MCPServerConfigType } from "../../src/config-schema.js";
import { MCPError } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Create a minimal MCPServerConfigType pointing at a given URL. */
function makeServerConfig(
  url: string,
  overrides: Partial<MCPServerConfigType> = {},
): MCPServerConfigType {
  return {
    enabled: true,
    url: `${url}/mcp`,
    ...overrides,
  };
}

/** Create an MCPManagerConfig from a set of server entries. */
function makeManagerConfig(
  servers: Record<string, MCPServerConfigType>,
  overrides: Partial<MCPManagerConfig> = {},
): MCPManagerConfig {
  return {
    servers,
    debug: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MCPManager", () => {
  let serverA: MockMCPServer;
  let serverB: MockMCPServer;
  let urlA: string;
  let urlB: string;

  // -------------------------------------------------------------------------
  // Setup / Teardown
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    serverA = new MockMCPServer();
    serverB = new MockMCPServer();
    [urlA, urlB] = await Promise.all([serverA.start(), serverB.start()]);
  });

  afterAll(async () => {
    await Promise.all([serverA.stop(), serverB.stop()]);
  });

  beforeEach(() => {
    // Reset mock server state before each test
    for (const server of [serverA, serverB]) {
      server.setOption("simulateAuthRequired", false);
      server.setOption("simulateSessionExpiry", null);
      server.setOption("simulateSlowResponse", 0);
      server.setOption("simulateStreamDisconnect", false);
      server.resetRequests();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Connection Lifecycle
  // -------------------------------------------------------------------------

  describe("Connection lifecycle", () => {
    it("connect() to a single server succeeds, getConnection() returns connected status", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        const conn = manager.getConnection("alpha");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("connected");
        expect(conn!.name).toBe("alpha");
        expect(conn!.connectedAt).toBeInstanceOf(Date);
        expect(conn!.lastError).toBeNull();
        expect(conn!.sessionState).not.toBeNull();
        expect(conn!.sessionState!.status).toBe("connected");
        expect(conn!.sessionState!.serverInfo).toBeDefined();
        expect(conn!.sessionState!.serverInfo!.name).toBe("mock-mcp-server");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("connectAll() connects to multiple servers in parallel", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connectAll();

        const connections = manager.getConnections();
        expect(connections.length).toBe(2);

        const connA = manager.getConnection("alpha");
        const connB = manager.getConnection("beta");
        expect(connA).toBeDefined();
        expect(connA!.status).toBe("connected");
        expect(connB).toBeDefined();
        expect(connB!.status).toBe("connected");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("disconnect() cleanly removes a server, unregisters its tools", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connectAll();

        // Both servers have tools registered
        const toolsBefore = manager.getRegisteredTools();
        const alphaToolsBefore = toolsBefore.filter(
          (t) => t.serverName === "alpha",
        );
        expect(alphaToolsBefore.length).toBeGreaterThan(0);

        // Disconnect alpha
        await manager.disconnect("alpha");

        // Connection should be removed
        expect(manager.getConnection("alpha")).toBeUndefined();

        // Tools for alpha should be gone
        const toolsAfter = manager.getRegisteredTools();
        const alphaToolsAfter = toolsAfter.filter(
          (t) => t.serverName === "alpha",
        );
        expect(alphaToolsAfter.length).toBe(0);

        // Beta tools should still be present
        const betaToolsAfter = toolsAfter.filter(
          (t) => t.serverName === "beta",
        );
        expect(betaToolsAfter.length).toBeGreaterThan(0);
      } finally {
        await manager.disconnectAll();
      }
    });

    it("disconnectAll() removes all servers", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config);

      await manager.connectAll();
      expect(manager.getConnections().length).toBe(2);

      await manager.disconnectAll();

      expect(manager.getConnections().length).toBe(0);
      expect(manager.getRegisteredTools().length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Tool Discovery
  // -------------------------------------------------------------------------

  describe("Tool discovery", () => {
    it("after connect, getRegisteredTools() returns namespaced tools", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        const tools = manager.getRegisteredTools();
        expect(tools.length).toBeGreaterThan(0);

        // All tools should have namespaced names
        for (const tool of tools) {
          expect(tool.namespacedName).toContain("__");
          expect(tool.serverName).toBe("alpha");
        }
      } finally {
        await manager.disconnectAll();
      }
    });

    it("tools have correct server__tool naming pattern", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        const tools = manager.getRegisteredTools();

        // The mock server provides echo, slow_counter, get_weather
        const toolNames = tools.map((t) => t.namespacedName);
        expect(toolNames).toContain("alpha__echo");
        expect(toolNames).toContain("alpha__slow_counter");
        expect(toolNames).toContain("alpha__get_weather");

        // Verify originalName is preserved
        const echoTool = tools.find(
          (t) => t.namespacedName === "alpha__echo",
        );
        expect(echoTool).toBeDefined();
        expect(echoTool!.originalName).toBe("echo");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("getToolRegistry() provides direct registry access", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        const registry = manager.getToolRegistry();
        expect(registry).toBeDefined();

        // Registry should have the same tools as getRegisteredTools()
        expect(registry.getAllTools().length).toBe(
          manager.getRegisteredTools().length,
        );

        // Registry should be able to resolve tool calls
        const resolved = registry.resolveToolCall("alpha__echo");
        expect(resolved).toBeDefined();
        expect(resolved!.serverName).toBe("alpha");
        expect(resolved!.toolName).toBe("echo");
      } finally {
        await manager.disconnectAll();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Tool Calling
  // -------------------------------------------------------------------------

  describe("Tool calling", () => {
    it('callTool("server__echo", args) routes to correct server and returns result', async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        const result = await manager.callTool("alpha__echo", {
          message: "integration test",
        });

        expect(result).toBeDefined();
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.content[0].type).toBe("text");
        expect(result.content[0].text).toContain("Echo: integration test");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("callTool with unknown tool throws error", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connect("alpha", config.servers.alpha);

        await expect(
          manager.callTool("nonexistent__tool", {}),
        ).rejects.toThrow(MCPError);

        await expect(
          manager.callTool("nonexistent__tool", {}),
        ).rejects.toThrow(/Tool not found/);
      } finally {
        await manager.disconnectAll();
      }
    });

    it("callTool with disconnected server throws error", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      try {
        // Connect, then disconnect (tools remain in registry momentarily
        // if we bypass normal flow). Instead, we manually register a tool
        // via the registry and then try to call it.
        await manager.connect("alpha", config.servers.alpha);

        // Verify tool exists
        const tools = manager.getRegisteredTools();
        expect(tools.some((t) => t.namespacedName === "alpha__echo")).toBe(
          true,
        );

        // Disconnect the server
        await manager.disconnect("alpha");

        // The tool registry was cleaned on disconnect, so this should be "tool not found".
        // But the test intent is to check the error when a server is disconnected.
        // Reconnect alpha and then break the connection status to simulate disconnect.
        await manager.connect("alpha", config.servers.alpha);
        const conn = manager.getConnection("alpha");
        // Forcibly set status to simulate a disconnected server
        (conn as { status: string }).status = "error";

        await expect(
          manager.callTool("alpha__echo", { message: "test" }),
        ).rejects.toThrow(MCPError);

        await expect(
          manager.callTool("alpha__echo", { message: "test" }),
        ).rejects.toThrow(/not connected/);
      } finally {
        await manager.disconnectAll();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 4. Config Reconciliation
  // -------------------------------------------------------------------------

  describe("Config reconciliation", () => {
    it("reconcile() connects new servers added to config", async () => {
      // Start with only alpha
      const config1 = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config1);

      try {
        await manager.connectAll();
        expect(manager.getConnections().length).toBe(1);
        expect(manager.getConnection("alpha")).toBeDefined();

        // Reconcile with both alpha and beta
        const config2 = makeManagerConfig({
          alpha: makeServerConfig(urlA),
          beta: makeServerConfig(urlB),
        });
        await manager.reconcile(config2);

        expect(manager.getConnections().length).toBe(2);
        expect(manager.getConnection("beta")).toBeDefined();
        expect(manager.getConnection("beta")!.status).toBe("connected");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("reconcile() disconnects servers removed from config", async () => {
      // Start with both alpha and beta
      const config1 = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config1);

      try {
        await manager.connectAll();
        expect(manager.getConnections().length).toBe(2);

        // Reconcile with only alpha
        const config2 = makeManagerConfig({
          alpha: makeServerConfig(urlA),
        });
        await manager.reconcile(config2);

        expect(manager.getConnections().length).toBe(1);
        expect(manager.getConnection("alpha")).toBeDefined();
        expect(manager.getConnection("beta")).toBeUndefined();

        // Beta tools should be gone
        const betaTools = manager
          .getRegisteredTools()
          .filter((t) => t.serverName === "beta");
        expect(betaTools.length).toBe(0);
      } finally {
        await manager.disconnectAll();
      }
    });

    it("reconcile() reconnects servers whose URL changed", async () => {
      const config1 = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config1);

      try {
        await manager.connectAll();

        const connBefore = manager.getConnection("alpha");
        expect(connBefore).toBeDefined();
        const sessionBefore = connBefore!.sessionState?.sessionId;

        // Reconcile with alpha pointing at serverB's URL (URL changed)
        const config2 = makeManagerConfig({
          alpha: makeServerConfig(urlB),
        });
        await manager.reconcile(config2);

        const connAfter = manager.getConnection("alpha");
        expect(connAfter).toBeDefined();
        expect(connAfter!.status).toBe("connected");

        // Session should be different (reconnected to a different server)
        const sessionAfter = connAfter!.sessionState?.sessionId;
        expect(sessionAfter).not.toBe(sessionBefore);
      } finally {
        await manager.disconnectAll();
      }
    });

    it("reconcile() skips servers whose config has not changed", async () => {
      const config1 = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config1);

      try {
        await manager.connectAll();

        const connBefore = manager.getConnection("alpha");
        const sessionBefore = connBefore!.sessionState?.sessionId;
        const connectedAtBefore = connBefore!.connectedAt;

        // Reconcile with the exact same config
        const config2 = makeManagerConfig({
          alpha: makeServerConfig(urlA),
        });
        await manager.reconcile(config2);

        const connAfter = manager.getConnection("alpha");
        expect(connAfter).toBeDefined();
        expect(connAfter!.status).toBe("connected");

        // Session and connectedAt should be the same (no reconnection)
        expect(connAfter!.sessionState?.sessionId).toBe(sessionBefore);
        expect(connAfter!.connectedAt).toBe(connectedAtBefore);
      } finally {
        await manager.disconnectAll();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. Tool Refresh
  // -------------------------------------------------------------------------

  describe("Tool refresh", () => {
    it("refreshTools() re-discovers tools from all servers", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connectAll();

        const toolsBefore = manager.getRegisteredTools().length;
        expect(toolsBefore).toBeGreaterThan(0);

        // Refresh tools from all servers
        await manager.refreshTools();

        const toolsAfter = manager.getRegisteredTools().length;
        // Tool count should be the same since the mock server is unchanged
        expect(toolsAfter).toBe(toolsBefore);

        // Verify tools from both servers are present
        const serverNames = new Set(
          manager.getRegisteredTools().map((t) => t.serverName),
        );
        expect(serverNames.has("alpha")).toBe(true);
        expect(serverNames.has("beta")).toBe(true);
      } finally {
        await manager.disconnectAll();
      }
    });

    it("refreshTools(serverName) refreshes tools from one server", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
        beta: makeServerConfig(urlB),
      });
      const manager = new MCPManager(config);

      try {
        await manager.connectAll();

        // Clear request logs so we can inspect what happens during refresh
        serverA.resetRequests();
        serverB.resetRequests();

        // Refresh only alpha's tools
        await manager.refreshTools("alpha");

        // Server A should have received a tools/list request
        const requestsA = serverA.getRequests();
        const toolsListA = requestsA.filter(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "tools/list",
        );
        expect(toolsListA.length).toBe(1);

        // Server B should NOT have received a tools/list request
        const requestsB = serverB.getRequests();
        const toolsListB = requestsB.filter(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "tools/list",
        );
        expect(toolsListB.length).toBe(0);
      } finally {
        await manager.disconnectAll();
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Error Handling
  // -------------------------------------------------------------------------

  describe("Error handling", () => {
    it("connect() to unreachable server sets status to 'error'", async () => {
      const config = makeManagerConfig({
        dead: {
          enabled: true,
          url: "http://127.0.0.1:1/mcp", // Port 1 -- nothing listening
          connectTimeoutMs: 2000,
        },
      });
      const manager = new MCPManager(config);

      try {
        await expect(
          manager.connect("dead", config.servers.dead),
        ).rejects.toThrow(MCPError);

        // Connection record should exist in error state
        const conn = manager.getConnection("dead");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("error");
        expect(conn!.lastError).toBeTruthy();
      } finally {
        await manager.disconnectAll();
      }
    });

    it("connectAll() with mixed success/failure connects the good ones", async () => {
      const config = makeManagerConfig({
        good: makeServerConfig(urlA),
        bad: {
          enabled: true,
          url: "http://127.0.0.1:1/mcp",
          connectTimeoutMs: 2000,
        },
      });
      const manager = new MCPManager(config);

      try {
        // connectAll should not throw even though one fails
        await manager.connectAll();

        // The good server should be connected
        const goodConn = manager.getConnection("good");
        expect(goodConn).toBeDefined();
        expect(goodConn!.status).toBe("connected");

        // The bad server should be in error state
        const badConn = manager.getConnection("bad");
        expect(badConn).toBeDefined();
        expect(badConn!.status).toBe("error");
      } finally {
        await manager.disconnectAll();
      }
    });

    it("getConnection() for unknown server returns undefined", async () => {
      const config = makeManagerConfig({
        alpha: makeServerConfig(urlA),
      });
      const manager = new MCPManager(config);

      expect(manager.getConnection("nonexistent")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 7. API Key Auth
  // -------------------------------------------------------------------------

  describe("API key auth", () => {
    it("when apiKey is configured, Authorization header is sent", async () => {
      const apiKey = "test-secret-key-abc123";
      const config = makeManagerConfig({
        authed: makeServerConfig(urlA, { apiKey }),
      });
      const manager = new MCPManager(config);

      try {
        serverA.resetRequests();

        await manager.connect("authed", config.servers.authed);

        // Inspect the recorded requests on the mock server
        const requests = serverA.getRequests();

        // The initialize request should have the Authorization header
        const initRequest = requests.find(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "initialize",
        );
        expect(initRequest).toBeDefined();
        expect(initRequest!.headers["authorization"]).toBe(
          `Bearer ${apiKey}`,
        );

        // The tools/list request should also have the Authorization header
        const toolsRequest = requests.find(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "tools/list",
        );
        expect(toolsRequest).toBeDefined();
        expect(toolsRequest!.headers["authorization"]).toBe(
          `Bearer ${apiKey}`,
        );
      } finally {
        await manager.disconnectAll();
      }
    });
  });
});
