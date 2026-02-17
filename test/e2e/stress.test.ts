/**
 * Stress and edge-case tests for the OpenClaw MCP client plugin.
 *
 * Covers extreme conditions: many concurrent servers, malformed responses,
 * timeouts, mid-stream disconnects, rapid connect/disconnect cycles,
 * hot-reload during in-flight calls, and health checks.
 *
 * @see SPEC.md section 3 for MCPManager architecture
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { MockMCPServer } from "../fixtures/mock-mcp-server.js";
import { MCPManager } from "../../src/manager/mcp-manager.js";
import type { MCPManagerConfig } from "../../src/manager/mcp-manager.js";
import type { MCPServerConfigType } from "../../src/config-schema.js";
import { MCPError } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Start a raw HTTP server on a random port and return its URL + close handle.
 * The `handler` callback controls what responses are sent.
 */
function startRawServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({ url: `http://127.0.0.1:${addr.port}`, server });
      } else {
        reject(new Error("Failed to determine server address"));
      }
    });
    server.on("error", reject);
  });
}

/** Close an HTTP server and wait for it to finish. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Shared cleanup tracking
// ---------------------------------------------------------------------------

const managersToCleanup: MCPManager[] = [];
const mockServersToCleanup: MockMCPServer[] = [];
const rawServersToCleanup: Server[] = [];

afterEach(async () => {
  // Disconnect all managers
  await Promise.all(
    managersToCleanup.map((m) => m.disconnectAll().catch(() => {})),
  );
  managersToCleanup.length = 0;

  // Stop all mock servers
  await Promise.all(
    mockServersToCleanup.map((s) => s.stop().catch(() => {})),
  );
  mockServersToCleanup.length = 0;

  // Close all raw servers
  await Promise.all(
    rawServersToCleanup.map((s) => closeServer(s).catch(() => {})),
  );
  rawServersToCleanup.length = 0;
});

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Stress and edge-case tests", () => {
  // -------------------------------------------------------------------------
  // 1. Multiple concurrent MCP servers
  // -------------------------------------------------------------------------

  describe("Multiple concurrent MCP servers", () => {
    it(
      "connects to 7 servers in parallel, calls tools concurrently, and disconnects cleanly",
      { timeout: 15000 },
      async () => {
        const SERVER_COUNT = 7;
        const servers: MockMCPServer[] = [];
        const urls: string[] = [];

        // Start N mock servers
        for (let i = 0; i < SERVER_COUNT; i++) {
          const server = new MockMCPServer();
          servers.push(server);
          mockServersToCleanup.push(server);
        }
        const startResults = await Promise.all(servers.map((s) => s.start()));
        urls.push(...startResults);

        // Build config with all servers
        const serverConfigs: Record<string, MCPServerConfigType> = {};
        for (let i = 0; i < SERVER_COUNT; i++) {
          serverConfigs[`server${i}`] = makeServerConfig(urls[i]);
        }
        const config = makeManagerConfig(serverConfigs);
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        // Connect all in parallel
        await manager.connectAll();

        // Verify all connected
        const connections = manager.getConnections();
        expect(connections.length).toBe(SERVER_COUNT);
        for (const conn of connections) {
          expect(conn.status).toBe("connected");
        }

        // Call tools on different servers concurrently
        const callPromises = [];
        for (let i = 0; i < SERVER_COUNT; i++) {
          callPromises.push(
            manager.callTool(`server${i}__echo`, {
              message: `hello from server ${i}`,
            }),
          );
        }
        const results = await Promise.all(callPromises);

        // Verify all results
        for (let i = 0; i < SERVER_COUNT; i++) {
          expect(results[i].content).toBeDefined();
          expect(results[i].content.length).toBeGreaterThan(0);
          expect(results[i].content[0].text).toContain(
            `hello from server ${i}`,
          );
        }

        // Disconnect all
        await manager.disconnectAll();
        expect(manager.getConnections().length).toBe(0);
        expect(manager.getRegisteredTools().length).toBe(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 2. Server sends malformed JSON-RPC
  // -------------------------------------------------------------------------

  describe("Server sends malformed JSON-RPC", () => {
    it(
      "handles server returning invalid JSON (not parseable)",
      { timeout: 10000 },
      async () => {
        const { url, server: rawServer } = await startRawServer(
          (_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("this is not valid json {{{");
          },
        );
        rawServersToCleanup.push(rawServer);

        const config = makeManagerConfig({
          broken: makeServerConfig(url, { connectTimeoutMs: 3000 }),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        // Connect should fail because initialize response is not valid JSON
        await expect(
          manager.connect("broken", config.servers.broken),
        ).rejects.toThrow(MCPError);

        const conn = manager.getConnection("broken");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("error");
      },
    );

    it(
      "handles server returning valid JSON but not JSON-RPC (missing jsonrpc field)",
      { timeout: 10000 },
      async () => {
        const { url, server: rawServer } = await startRawServer(
          (_req, res) => {
            // Valid JSON, but not a JSON-RPC response (no "jsonrpc" field)
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ id: 1, result: "hello" }));
          },
        );
        rawServersToCleanup.push(rawServer);

        const config = makeManagerConfig({
          notRpc: makeServerConfig(url, { connectTimeoutMs: 3000 }),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        // Connect should fail because the response is not valid JSON-RPC
        await expect(
          manager.connect("notRpc", config.servers.notRpc),
        ).rejects.toThrow(MCPError);

        const conn = manager.getConnection("notRpc");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("error");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. Server never responds (timeout)
  // -------------------------------------------------------------------------

  describe("Server never responds (timeout)", () => {
    it(
      "times out when server accepts connection but never responds",
      { timeout: 10000 },
      async () => {
        // Server that accepts connections but never sends a response
        const { url, server: rawServer } = await startRawServer(
          (_req, _res) => {
            // Intentionally never respond
          },
        );
        rawServersToCleanup.push(rawServer);

        const config = makeManagerConfig({
          silent: makeServerConfig(url, { connectTimeoutMs: 500 }),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        const startTime = Date.now();
        await expect(
          manager.connect("silent", config.servers.silent),
        ).rejects.toThrow(MCPError);
        const elapsed = Date.now() - startTime;

        // Should have timed out reasonably close to 500ms (with some margin)
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(elapsed).toBeLessThan(5000);

        const conn = manager.getConnection("silent");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("error");
        expect(conn!.lastError).toBeTruthy();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 4. Server drops connection mid-stream
  // -------------------------------------------------------------------------

  describe("Server drops connection mid-stream", () => {
    it(
      "handles server that starts SSE then abruptly closes",
      { timeout: 10000 },
      async () => {
        let requestCount = 0;
        const { url, server: rawServer } = await startRawServer(
          (req, res) => {
            requestCount++;

            // First request (initialize): return a valid response
            if (requestCount === 1) {
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Mcp-Session-Id": "test-session-drop",
              });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: "drop-server", version: "1.0.0" },
                  },
                }),
              );
              return;
            }

            // Second request (notifications/initialized): accept it
            if (requestCount === 2) {
              res.writeHead(202);
              res.end();
              return;
            }

            // Third request (tools/list): start SSE then abruptly close
            if (requestCount === 3) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              // Write partial SSE data then destroy the connection
              res.write("event: message\n");
              res.write(
                'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
              );
              // Abruptly destroy the socket
              setTimeout(() => {
                res.destroy();
              }, 50);
              return;
            }

            // Default: 404
            res.writeHead(404);
            res.end();
          },
        );
        rawServersToCleanup.push(rawServer);

        const config = makeManagerConfig({
          dropper: makeServerConfig(url, {
            connectTimeoutMs: 3000,
            requestTimeoutMs: 3000,
          }),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        // Connect should fail at tools/list because the stream is broken
        await expect(
          manager.connect("dropper", config.servers.dropper),
        ).rejects.toThrow(MCPError);

        const conn = manager.getConnection("dropper");
        expect(conn).toBeDefined();
        expect(conn!.status).toBe("error");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 5. Rapid connect/disconnect cycles
  // -------------------------------------------------------------------------

  describe("Rapid connect/disconnect cycles", () => {
    it(
      "survives 5 rapid connect/disconnect cycles without resource leaks",
      { timeout: 15000 },
      async () => {
        const mockServer = new MockMCPServer();
        mockServersToCleanup.push(mockServer);
        const url = await mockServer.start();

        const CYCLES = 5;

        for (let i = 0; i < CYCLES; i++) {
          const config = makeManagerConfig({
            cycled: makeServerConfig(url),
          });
          const manager = new MCPManager(config);

          await manager.connect("cycled", config.servers.cycled);

          const conn = manager.getConnection("cycled");
          expect(conn).toBeDefined();
          expect(conn!.status).toBe("connected");

          // Verify tools were discovered
          const tools = manager.getRegisteredTools();
          expect(tools.length).toBeGreaterThan(0);

          await manager.disconnectAll();

          // After disconnect, no connections or tools should remain
          expect(manager.getConnections().length).toBe(0);
          expect(manager.getRegisteredTools().length).toBe(0);
        }

        // The mock server should still be running and accepting connections
        // Verify by doing one final connect
        const finalConfig = makeManagerConfig({
          cycled: makeServerConfig(url),
        });
        const finalManager = new MCPManager(finalConfig);
        managersToCleanup.push(finalManager);

        await finalManager.connect(
          "cycled",
          finalConfig.servers.cycled,
        );
        const finalConn = finalManager.getConnection("cycled");
        expect(finalConn).toBeDefined();
        expect(finalConn!.status).toBe("connected");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 6. Config hot-reload while tools are in-flight
  // -------------------------------------------------------------------------

  describe("Config hot-reload while tools are in-flight", () => {
    it(
      "reconcile() during a pending slow tool call completes or errors cleanly",
      { timeout: 15000 },
      async () => {
        const slowServer = new MockMCPServer();
        mockServersToCleanup.push(slowServer);
        const slowUrl = await slowServer.start();

        const fastServer = new MockMCPServer();
        mockServersToCleanup.push(fastServer);
        const fastUrl = await fastServer.start();

        const config1 = makeManagerConfig({
          slow: makeServerConfig(slowUrl),
        });
        const manager = new MCPManager(config1);
        managersToCleanup.push(manager);

        await manager.connectAll();
        expect(manager.getConnection("slow")!.status).toBe("connected");

        // Make the slow server very slow for subsequent requests
        slowServer.setOption("simulateSlowResponse", 2000);

        // Start a slow tool call (do not await yet)
        const toolCallPromise = manager
          .callTool("slow__echo", { message: "slow call" })
          .then((result) => ({ outcome: "resolved" as const, result }))
          .catch((error: unknown) => ({ outcome: "rejected" as const, error }));

        // Give the tool call a moment to start
        await new Promise((resolve) => setTimeout(resolve, 100));

        // While the tool call is in-flight, reconcile with a new config
        // that adds a new server
        const config2 = makeManagerConfig({
          slow: makeServerConfig(slowUrl),
          fast: makeServerConfig(fastUrl),
        });
        await manager.reconcile(config2);

        // The fast server should now be connected
        const fastConn = manager.getConnection("fast");
        expect(fastConn).toBeDefined();
        expect(fastConn!.status).toBe("connected");

        // The in-flight call should eventually resolve or reject cleanly
        const outcome = await toolCallPromise;
        expect(["resolved", "rejected"]).toContain(outcome.outcome);

        // The system should remain in a usable state
        // Reset slow response delay for clean teardown
        slowServer.setOption("simulateSlowResponse", 0);

        // Verify we can still call tools on the fast server
        const fastResult = await manager.callTool("fast__echo", {
          message: "after reconcile",
        });
        expect(fastResult.content[0].text).toContain("after reconcile");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 7. Health check on healthy/unhealthy servers
  // -------------------------------------------------------------------------

  describe("Health check on healthy/unhealthy servers", () => {
    it(
      "healthCheck() returns healthy for a connected server",
      { timeout: 10000 },
      async () => {
        const mockServer = new MockMCPServer();
        mockServersToCleanup.push(mockServer);
        const url = await mockServer.start();

        const config = makeManagerConfig({
          healthyServer: makeServerConfig(url),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        await manager.connect(
          "healthyServer",
          config.servers.healthyServer,
        );

        const result = await manager.healthCheck("healthyServer");
        // Single server health check returns a single result
        expect(result).toBeDefined();
        expect("status" in result).toBe(true);
        const single = result as { status: string; latencyMs: number; name: string };
        expect(single.name).toBe("healthyServer");
        expect(single.status).toBe("healthy");
        expect(single.latencyMs).toBeGreaterThanOrEqual(0);
      },
    );

    it(
      "healthCheck() returns unreachable after the server is stopped",
      { timeout: 10000 },
      async () => {
        const mockServer = new MockMCPServer();
        const url = await mockServer.start();

        const config = makeManagerConfig({
          goneSoon: makeServerConfig(url),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        await manager.connect("goneSoon", config.servers.goneSoon);

        // Verify initially healthy
        const healthyResult = await manager.healthCheck("goneSoon");
        const healthy = healthyResult as { status: string };
        expect(healthy.status).toBe("healthy");

        // Stop the server (simulating it going down)
        await mockServer.stop();

        // Health check should now return unreachable
        const unhealthyResult = await manager.healthCheck("goneSoon");
        const unhealthy = unhealthyResult as {
          status: string;
          consecutiveFailures: number;
        };
        expect(unhealthy.status).toBe("unreachable");
        expect(unhealthy.consecutiveFailures).toBeGreaterThan(0);
      },
    );

    it(
      "healthCheck() on all servers returns an array of results",
      { timeout: 10000 },
      async () => {
        const serverA = new MockMCPServer();
        const serverB = new MockMCPServer();
        mockServersToCleanup.push(serverA, serverB);
        const [urlA, urlB] = await Promise.all([
          serverA.start(),
          serverB.start(),
        ]);

        const config = makeManagerConfig({
          alpha: makeServerConfig(urlA),
          beta: makeServerConfig(urlB),
        });
        const manager = new MCPManager(config);
        managersToCleanup.push(manager);

        await manager.connectAll();

        const results = await manager.healthCheck();
        expect(Array.isArray(results)).toBe(true);
        const arr = results as Array<{ name: string; status: string }>;
        expect(arr.length).toBe(2);

        const names = arr.map((r) => r.name).sort();
        expect(names).toEqual(["alpha", "beta"]);
        for (const r of arr) {
          expect(r.status).toBe("healthy");
        }
      },
    );
  });
});
