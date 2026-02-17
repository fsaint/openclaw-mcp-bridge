/**
 * Mock Auth Server for testing OAuth 2.1 metadata discovery.
 *
 * A configurable HTTP server that serves:
 * - Protected Resource Metadata at well-known paths (RFC 9728)
 * - Authorization Server Metadata at well-known paths (RFC 8414 / OIDC Discovery)
 *
 * Endpoints and responses can be configured per-path so tests can control
 * which discovery attempts succeed, fail, or return specific payloads.
 *
 * @see SPEC.md section 5.1, 5.2 -- auth discovery spec
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */

import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A configured route that returns a JSON response or an error status. */
export interface MockRoute {
  /** HTTP status code to respond with. */
  readonly status: number;
  /** JSON body to return (ignored when status is not 2xx). */
  readonly body?: Record<string, unknown>;
  /** Optional headers to include in the response. */
  readonly headers?: Record<string, string>;
}

/** A recorded HTTP request for test assertions. */
export interface RecordedAuthRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// MockAuthServer
// ---------------------------------------------------------------------------

/**
 * A mock OAuth 2.1 metadata server for testing discovery flows.
 *
 * Serves configurable JSON responses at arbitrary paths, designed to
 * simulate Protected Resource Metadata and Authorization Server Metadata
 * endpoints. Each path can be independently configured to return specific
 * JSON payloads or error codes.
 *
 * @example
 * ```ts
 * const server = new MockAuthServer();
 * server.setRoute("/.well-known/oauth-protected-resource", {
 *   status: 200,
 *   body: {
 *     resource: "https://mcp.example.com",
 *     authorization_servers: ["https://auth.example.com"],
 *   },
 * });
 * const url = await server.start();
 * // ... run tests against url ...
 * await server.stop();
 * ```
 */
export class MockAuthServer {
  private server: Server | null = null;
  private port = 0;
  private routes: Map<string, MockRoute> = new Map();
  private requests: RecordedAuthRequest[] = [];

  /**
   * Configure a route to serve a specific response.
   *
   * @param path - The URL path (e.g., "/.well-known/oauth-protected-resource").
   * @param route - The response configuration.
   */
  setRoute(path: string, route: MockRoute): void {
    this.routes.set(path, route);
  }

  /**
   * Remove a previously configured route.
   *
   * @param path - The URL path to remove.
   */
  removeRoute(path: string): void {
    this.routes.delete(path);
  }

  /**
   * Remove all configured routes.
   */
  clearRoutes(): void {
    this.routes.clear();
  }

  /**
   * Start the mock auth server on a random available port.
   *
   * @returns The base URL of the running server (e.g., "http://127.0.0.1:12345").
   */
  async start(): Promise<string> {
    if (this.server) {
      throw new Error("MockAuthServer is already running");
    }

    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handleRequest(req, res);
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
   */
  async stop(): Promise<void> {
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
   * @returns The URL string, e.g., "http://127.0.0.1:12345".
   * @throws If the server is not running.
   */
  getUrl(): string {
    if (!this.server || this.port === 0) {
      throw new Error("MockAuthServer is not running");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * Get all recorded requests for test assertions.
   *
   * @returns Array of RecordedAuthRequest objects in chronological order.
   */
  getRequests(): readonly RecordedAuthRequest[] {
    return [...this.requests];
  }

  /**
   * Clear the recorded request log.
   */
  resetRequests(): void {
    this.requests = [];
  }

  // -----------------------------------------------------------------------
  // Private: request handling
  // -----------------------------------------------------------------------

  /**
   * Main request handler -- dispatches based on configured routes.
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    // Record the request
    this.requests.push({
      method: req.method ?? "UNKNOWN",
      url: req.url ?? "/",
      headers: req.headers as Record<string, string | string[] | undefined>,
      timestamp: Date.now(),
    });

    // Look up the configured route
    const route = this.routes.get(path);

    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...route.headers,
    };

    res.writeHead(route.status, headers);

    if (route.body && route.status >= 200 && route.status < 300) {
      res.end(JSON.stringify(route.body));
    } else if (route.body) {
      // Also send body for error statuses if provided
      res.end(JSON.stringify(route.body));
    } else {
      res.end();
    }
  }
}
