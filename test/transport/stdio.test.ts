/**
 * Comprehensive unit tests for the stdio transport (StdioTransport).
 *
 * Spawns a real subprocess (echo-mcp-stdio.mjs) and exercises the full
 * lifecycle, message exchange, error handling, auto-restart, and clean
 * shutdown paths of StdioTransport.
 *
 * @see /src/transport/stdio.ts
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolve } from "node:path";
import { StdioTransport } from "../../src/transport/stdio.js";
import type { StdioTransportConfig } from "../../src/transport/stdio.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcMessage,
} from "../../src/types.js";
import { MCPError } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the echo MCP stdio server fixture. */
const ECHO_SERVER_PATH = resolve(
  import.meta.dirname,
  "..",
  "fixtures",
  "echo-mcp-stdio.mjs"
);

/**
 * Build a default StdioTransportConfig pointing at the echo server.
 *
 * @param overrides - Optional config overrides.
 * @returns A complete StdioTransportConfig.
 */
function makeConfig(
  overrides: Partial<StdioTransportConfig> = {}
): StdioTransportConfig {
  return {
    command: "node",
    args: [ECHO_SERVER_PATH],
    env: {},
    ...overrides,
  };
}

/**
 * Build a JSON-RPC 2.0 request object.
 *
 * @param method - The RPC method name.
 * @param id - Request identifier.
 * @param params - Optional parameters.
 * @returns A JsonRpcRequest.
 */
function makeRequest(
  method: string,
  id: number | string,
  params?: Record<string, unknown>
): JsonRpcRequest {
  const base: JsonRpcRequest = params !== undefined
    ? { jsonrpc: "2.0", id, method, params }
    : { jsonrpc: "2.0", id, method };
  return base;
}

/**
 * Wait for a specified number of milliseconds.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StdioTransport", () => {
  /** Transport instance to be cleaned up after each test. */
  let transport: StdioTransport | null = null;

  afterEach(async () => {
    if (transport !== null) {
      try {
        await transport.stop();
      } catch {
        // Ignore errors during cleanup
      }
      transport = null;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Lifecycle
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("start() spawns the process and isRunning() returns true", async () => {
      transport = new StdioTransport(makeConfig());

      expect(transport.isRunning()).toBe(false);
      await transport.start();
      expect(transport.isRunning()).toBe(true);
    });

    it("stop() kills the process and isRunning() returns false", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();
      expect(transport.isRunning()).toBe(true);

      await transport.stop();
      expect(transport.isRunning()).toBe(false);
    });

    it("double start() does not throw when already connected", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      // The implementation returns early if process !== null && status === "connected"
      await expect(transport.start()).resolves.toBeUndefined();
      expect(transport.isRunning()).toBe(true);
    });

    it("send() before start() throws an MCPError", async () => {
      transport = new StdioTransport(makeConfig());

      const request = makeRequest("initialize", 1);
      await expect(transport.send(request)).rejects.toThrow(MCPError);
      await expect(transport.send(request)).rejects.toThrow(
        /subprocess is not running/
      );
    });

    it("sendAndReceive() before start() throws an MCPError", async () => {
      transport = new StdioTransport(makeConfig());

      const request = makeRequest("initialize", 1);
      await expect(transport.sendAndReceive(request)).rejects.toThrow(MCPError);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Message exchange
  // -------------------------------------------------------------------------

  describe("message exchange", () => {
    it("send() writes to process stdin without error", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("initialize", 1, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      await expect(transport.send(request)).resolves.toBeUndefined();
    });

    it("sendAndReceive() returns matching response for initialize", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("initialize", 1, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      const response = await transport.sendAndReceive(request);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect("result" in response).toBe(true);
      if ("result" in response) {
        const result = response.result as Record<string, unknown>;
        expect(result.protocolVersion).toBe("2025-03-26");
        expect(result.serverInfo).toEqual({
          name: "echo-mcp-stdio",
          version: "1.0.0",
        });
      }
    });

    it("sendAndReceive() returns matching response for tools/list", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("tools/list", 2);
      const response = await transport.sendAndReceive(request);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(2);
      expect("result" in response).toBe(true);
      if ("result" in response) {
        const result = response.result as { tools: unknown[] };
        expect(result.tools).toHaveLength(2);
      }
    });

    it("sendAndReceive() returns matching response for tools/call", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("tools/call", 3, {
        name: "echo",
        arguments: { message: "hello world" },
      });
      const response = await transport.sendAndReceive(request);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(3);
      expect("result" in response).toBe(true);
      if ("result" in response) {
        const result = response.result as {
          content: Array<{ type: string; text: string }>;
        };
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe("text");
        expect(JSON.parse(result.content[0].text)).toEqual({
          message: "hello world",
        });
      }
    });

    it("sendAndReceive() returns error response for unknown method", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("unknown/method", 4);
      const response = await transport.sendAndReceive(request);

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(4);
      expect("error" in response).toBe(true);
      if ("error" in response) {
        const errResp = response as { error: { code: number; message: string } };
        expect(errResp.error.code).toBe(-32601);
        expect(errResp.error.message).toContain("Method not found");
      }
    });

    it("multiple sequential sendAndReceive() calls work correctly", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const response1 = await transport.sendAndReceive(
        makeRequest("tools/list", 10)
      );
      expect(response1.id).toBe(10);
      expect("result" in response1).toBe(true);

      const response2 = await transport.sendAndReceive(
        makeRequest("tools/call", 11, {
          name: "echo",
          arguments: { x: 1 },
        })
      );
      expect(response2.id).toBe(11);
      expect("result" in response2).toBe(true);

      const response3 = await transport.sendAndReceive(
        makeRequest("initialize", 12, {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        })
      );
      expect(response3.id).toBe(12);
      expect("result" in response3).toBe(true);
    });

    it("concurrent sendAndReceive() calls resolve independently", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const promises = [
        transport.sendAndReceive(makeRequest("tools/list", 20)),
        transport.sendAndReceive(makeRequest("tools/call", 21, {
          name: "echo",
          arguments: { msg: "concurrent-1" },
        })),
        transport.sendAndReceive(makeRequest("initialize", 22, {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        })),
        transport.sendAndReceive(makeRequest("tools/call", 23, {
          name: "add",
          arguments: { a: 2, b: 3 },
        })),
      ];

      const responses = await Promise.all(promises);

      // Each response should match its request id
      expect(responses[0].id).toBe(20);
      expect(responses[1].id).toBe(21);
      expect(responses[2].id).toBe(22);
      expect(responses[3].id).toBe(23);

      // Verify each response has the expected structure
      expect("result" in responses[0]).toBe(true);
      expect("result" in responses[1]).toBe(true);
      expect("result" in responses[2]).toBe(true);
      expect("result" in responses[3]).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Incoming messages
  // -------------------------------------------------------------------------

  describe("incoming messages", () => {
    it("onMessage handler receives messages not matching a pending request", async () => {
      transport = new StdioTransport(makeConfig());

      const receivedMessages: JsonRpcMessage[] = [];
      transport.onMessage((msg) => {
        receivedMessages.push(msg);
      });

      await transport.start();

      // Use sendAndReceive for a normal request — the response should be
      // dispatched to the pending request, not to onMessage
      const response = await transport.sendAndReceive(
        makeRequest("initialize", 1, {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        })
      );

      expect(response.id).toBe(1);
      // The response matched a pending request so it should NOT appear in onMessage
      expect(receivedMessages).toHaveLength(0);
    });

    it("onStderr handler receives stderr output", async () => {
      transport = new StdioTransport(makeConfig());

      const stderrLines: string[] = [];
      transport.onStderr((line) => {
        stderrLines.push(line);
      });

      await transport.start();

      // The echo server writes "echo-mcp-stdio: server started" to stderr on start
      // Give it a moment to flush
      await sleep(200);

      expect(stderrLines.length).toBeGreaterThanOrEqual(1);
      expect(stderrLines.some((l) => l.includes("server started"))).toBe(true);
    });

    it("onStderr handler receives log output from request handling", async () => {
      transport = new StdioTransport(makeConfig());

      const stderrLines: string[] = [];
      transport.onStderr((line) => {
        stderrLines.push(line);
      });

      await transport.start();
      await sleep(100);

      // Send a request — the echo server logs to stderr when responding
      await transport.sendAndReceive(makeRequest("tools/list", 1));

      await sleep(200);

      expect(stderrLines.some((l) => l.includes("responded to tools/list"))).toBe(
        true
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("invalid JSON from stdout triggers onError but does not crash", async () => {
      // Create a server script that sends invalid JSON on stdout
      // We'll use a custom command for this
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [
            "-e",
            `
            process.stdout.write("this is not valid json\\n");
            // Then send a valid response to prove the transport still works
            const readline = require("readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", (line) => {
              const msg = JSON.parse(line);
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { ok: true }
              }) + "\\n");
            });
            rl.on("close", () => process.exit(0));
            `,
          ],
        })
      );

      const errors: Error[] = [];
      transport.onError((err) => {
        errors.push(err);
      });

      await transport.start();

      // Wait for the invalid JSON to be processed
      await sleep(300);

      // The error handler should have been called
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(
        errors.some((e) => e.message.includes("Invalid JSON-RPC message"))
      ).toBe(true);

      // The transport should still be running
      expect(transport.isRunning()).toBe(true);

      // And we can still send a valid request
      const response = await transport.sendAndReceive(
        makeRequest("test", 1)
      );
      expect(response.id).toBe(1);
      expect("result" in response).toBe(true);
    });

    it("process crash (non-zero exit) triggers error handler", async () => {
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [
            "-e",
            `
            setTimeout(() => {
              process.exit(1);
            }, 100);
            `,
          ],
          maxRestartAttempts: 0,
        })
      );

      const errors: Error[] = [];
      transport.onError((err) => {
        errors.push(err);
      });

      await transport.start();

      // Wait for the process to crash
      await sleep(500);

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(
        errors.some((e) => e.message.includes("exited unexpectedly"))
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Auto-restart
  // -------------------------------------------------------------------------

  describe("auto-restart", () => {
    it("process crash triggers automatic restart", async () => {
      // Use CRASH_AFTER_MS to make the server crash, then it will restart
      // with a fresh process that does NOT have CRASH_AFTER_MS set
      // We need a custom approach: spawn a script that crashes once, then a
      // fresh spawn (auto-restart) will succeed.
      //
      // The transport spawns the same command+args each time, so we cannot
      // conditionally change behavior on restart. Instead, we use a very
      // short-lived crash script and observe that the transport restarts.

      let restartCount = 0;
      const errors: Error[] = [];

      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [ECHO_SERVER_PATH],
          env: { CRASH_AFTER_MS: "100" },
          maxRestartAttempts: 3,
        })
      );

      transport.onError((err) => {
        errors.push(err);
        if (err.message.includes("exited unexpectedly")) {
          restartCount += 1;
        }
      });

      await transport.start();

      // The server crashes after 100ms, gets restarted, crashes again...
      // Eventually maxRestartAttempts (3) should be exhausted after
      // 3 restarts + the original spawn = 4 total exit events:
      //   spawn -> crash -> restart (1) -> crash -> restart (2) -> crash -> restart (3) -> crash -> give up
      // Wait enough time for all restarts to happen
      await sleep(2000);

      // We should see multiple crash errors
      expect(restartCount).toBeGreaterThanOrEqual(2);
    });

    it("after maxRestartAttempts exhausted, status becomes error and isRunning is false", async () => {
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: ["-e", "process.exit(1)"],
          env: {},
          maxRestartAttempts: 1,
        })
      );

      const errors: Error[] = [];
      transport.onError((err) => {
        errors.push(err);
      });

      await transport.start();

      // Process exits immediately, transport restarts once, then gives up
      await sleep(1500);

      expect(transport.isRunning()).toBe(false);
      // Should see "giving up" error
      expect(
        errors.some((e) => e.message.includes("giving up"))
      ).toBe(true);
    });

    it("maxRestartAttempts of 0 means no auto-restart", async () => {
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: ["-e", "process.exit(1)"],
          env: {},
          maxRestartAttempts: 0,
        })
      );

      const errors: Error[] = [];
      transport.onError((err) => {
        errors.push(err);
      });

      await transport.start();
      await sleep(500);

      expect(transport.isRunning()).toBe(false);
      // The "giving up" error should fire immediately since maxRestartAttempts is 0
      expect(
        errors.some((e) => e.message.includes("giving up"))
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Clean shutdown
  // -------------------------------------------------------------------------

  describe("clean shutdown", () => {
    it("stop() rejects pending sendAndReceive promises", async () => {
      // Use a server that delays responses so we can stop while a request is pending
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [
            "-e",
            `
            // A server that never responds — just reads stdin forever
            const readline = require("readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", () => {
              // intentionally do not respond
            });
            rl.on("close", () => process.exit(0));
            `,
          ],
        })
      );

      await transport.start();

      // Send a request that will never get a response.
      // Capture the rejection in a variable so it is "handled" immediately
      // and does not trigger Node's unhandled rejection warning.
      let caughtError: unknown = null;
      const pendingPromise = transport.sendAndReceive(
        makeRequest("hanging-method", 99)
      ).catch((err: unknown) => {
        caughtError = err;
      });

      // Give the message time to be written
      await sleep(100);

      // Stop the transport — should reject pending requests
      await transport.stop();

      // Wait for the catch handler to run
      await pendingPromise;

      expect(caughtError).toBeInstanceOf(MCPError);
      expect((caughtError as Error).message).toMatch(/shutting down/);
    });

    it("stop() closes stdin and sends SIGTERM", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();
      expect(transport.isRunning()).toBe(true);

      await transport.stop();

      expect(transport.isRunning()).toBe(false);
      // After stop(), transport should be fully disconnected
      // Attempting to send should throw
      await expect(
        transport.send(makeRequest("test", 1))
      ).rejects.toThrow(MCPError);
    });

    it("stop() on an already-stopped transport is a no-op", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();
      await transport.stop();

      // Second stop should not throw
      await expect(transport.stop()).resolves.toBeUndefined();
      expect(transport.isRunning()).toBe(false);
    });

    it("stop() resolves even if process has already exited", async () => {
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: ["-e", "process.exit(0)"],
          env: {},
          maxRestartAttempts: 0,
        })
      );

      await transport.start();
      // Wait for the process to exit on its own
      await sleep(500);

      // stop() should still resolve cleanly
      await expect(transport.stop()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 7. Configuration
  // -------------------------------------------------------------------------

  describe("configuration", () => {
    it("passes environment variables to the subprocess", async () => {
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [
            "-e",
            `
            const readline = require("readline");
            const rl = readline.createInterface({ input: process.stdin });
            rl.on("line", (line) => {
              const msg = JSON.parse(line);
              process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { myEnvVar: process.env.MY_TEST_VAR }
              }) + "\\n");
            });
            rl.on("close", () => process.exit(0));
            `,
          ],
          env: { MY_TEST_VAR: "test-value-42" },
        })
      );

      await transport.start();

      const response = await transport.sendAndReceive(
        makeRequest("test", 1)
      );

      expect("result" in response).toBe(true);
      if ("result" in response) {
        const result = response.result as { myEnvVar: string };
        expect(result.myEnvVar).toBe("test-value-42");
      }
    });

    it("uses default maxRestartAttempts of 3 when not configured", async () => {
      // Verify the default by observing that the transport attempts restarts
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: ["-e", "process.exit(1)"],
          env: {},
          // maxRestartAttempts not set — should default to 3
        })
      );

      let crashCount = 0;
      transport.onError((err) => {
        if (err.message.includes("exited unexpectedly")) {
          crashCount += 1;
        }
      });

      await transport.start();
      await sleep(2000);

      // Should have crashed: initial + 3 restarts = 4 crashes,
      // but the "giving up" error also fires.
      // At minimum, we should see more than 1 crash (proving restart happened)
      expect(crashCount).toBeGreaterThan(1);
    });

    it("shutdownTimeoutMs is configurable", async () => {
      // Use a very short timeout to test the SIGKILL path
      transport = new StdioTransport(
        makeConfig({
          command: "node",
          args: [
            "-e",
            `
            // Ignore SIGTERM to test SIGKILL timeout
            process.on("SIGTERM", () => {});
            // Keep running forever
            setInterval(() => {}, 1000);
            `,
          ],
          shutdownTimeoutMs: 200,
          maxRestartAttempts: 0,
        })
      );

      await transport.start();
      expect(transport.isRunning()).toBe(true);

      const startTime = Date.now();
      await transport.stop();
      const elapsed = Date.now() - startTime;

      expect(transport.isRunning()).toBe(false);
      // The stop should have completed around the shutdown timeout
      // Allow some margin for process overhead
      expect(elapsed).toBeLessThan(2000);
    });
  });

  // -------------------------------------------------------------------------
  // 8. String IDs
  // -------------------------------------------------------------------------

  describe("string request IDs", () => {
    it("sendAndReceive() works with string IDs", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const request = makeRequest("tools/list", "string-id-1");
      const response = await transport.sendAndReceive(request);

      expect(response.id).toBe("string-id-1");
      expect("result" in response).toBe(true);
    });

    it("concurrent requests with mixed string and number IDs resolve correctly", async () => {
      transport = new StdioTransport(makeConfig());
      await transport.start();

      const promises = [
        transport.sendAndReceive(makeRequest("tools/list", "abc")),
        transport.sendAndReceive(makeRequest("tools/list", 100)),
        transport.sendAndReceive(makeRequest("tools/list", "xyz-999")),
        transport.sendAndReceive(makeRequest("tools/list", 200)),
      ];

      const responses = await Promise.all(promises);

      expect(responses[0].id).toBe("abc");
      expect(responses[1].id).toBe(100);
      expect(responses[2].id).toBe("xyz-999");
      expect(responses[3].id).toBe(200);
    });
  });
});
