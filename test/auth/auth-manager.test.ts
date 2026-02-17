/**
 * Integration tests for the AuthManager class.
 *
 * AuthManager orchestrates the full OAuth 2.1 flow for MCP authorization.
 * These tests wire up mock HTTP servers for metadata discovery, client
 * registration, and token exchange to verify the end-to-end behavior of
 * each public method.
 *
 * @see src/auth/auth-manager.ts
 * @see SPEC.md section 5
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuthManager } from "../../src/auth/auth-manager.js";
import type { AuthManagerConfig } from "../../src/auth/auth-manager.js";
import { TokenStore } from "../../src/auth/token-store.js";
import type { OAuthTokenResponse } from "../../src/auth/token-store.js";
import { MCPError } from "../../src/types.js";
import { MockAuthServer } from "../fixtures/mock-auth-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid OAuthTokenResponse.
 */
function makeTokenResponse(
  overrides?: Partial<OAuthTokenResponse>,
): OAuthTokenResponse {
  return {
    access_token: "test-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    ...overrides,
  };
}

/**
 * A simple HTTP server that acts as a token endpoint.
 *
 * Captures POST request bodies and returns configurable JSON responses.
 * Also supports configuring the DCR (registration) endpoint.
 */
class MockTokenServer {
  private server: Server | null = null;
  private port = 0;

  /** Response for the /token endpoint. */
  tokenResponseStatus = 200;
  tokenResponseBody: Record<string, unknown> = {};

  /** Response for the /register endpoint. */
  registerResponseStatus = 200;
  registerResponseBody: Record<string, unknown> = {};

  /** Captured request bodies keyed by path. */
  capturedBodies: Map<string, Record<string, string>> = new Map();

  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = createServer(
        (req: IncomingMessage, res: ServerResponse) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            const url = new URL(
              req.url ?? "/",
              `http://127.0.0.1:${this.port}`,
            );

            // Parse body depending on content type
            const contentType = req.headers["content-type"] ?? "";
            let parsedBody: Record<string, string> = {};
            if (contentType.includes("application/x-www-form-urlencoded")) {
              const params = new URLSearchParams(raw);
              for (const [key, value] of params) {
                parsedBody[key] = value;
              }
            } else if (contentType.includes("application/json")) {
              try {
                parsedBody = JSON.parse(raw) as Record<string, string>;
              } catch {
                parsedBody = {};
              }
            }

            this.capturedBodies.set(url.pathname, parsedBody);

            if (url.pathname === "/token") {
              res.writeHead(this.tokenResponseStatus, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify(this.tokenResponseBody));
            } else if (url.pathname === "/register") {
              res.writeHead(this.registerResponseStatus, {
                "Content-Type": "application/json",
              });
              res.end(JSON.stringify(this.registerResponseBody));
            } else {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Not found" }));
            }
          });
        },
      );

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

  async stop(): Promise<void> {
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
}

/**
 * Set up a resource server (MockAuthServer) with Protected Resource Metadata
 * pointing to the given auth server URL.
 */
function configureResourceServer(
  server: MockAuthServer,
  authServerUrl: string,
  opts?: { scopes_supported?: string[] },
): void {
  server.setRoute("/.well-known/oauth-protected-resource", {
    status: 200,
    body: {
      resource: server.getUrl(),
      authorization_servers: [authServerUrl],
      ...(opts?.scopes_supported
        ? { scopes_supported: opts.scopes_supported }
        : {}),
    },
  });
}

/**
 * Set up an auth server (MockAuthServer) with Authorization Server Metadata.
 */
function configureAuthServerMetadata(
  server: MockAuthServer,
  tokenServerUrl: string,
  opts?: {
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
  },
): void {
  const issuer = server.getUrl();
  server.setRoute("/.well-known/oauth-authorization-server", {
    status: 200,
    body: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${tokenServerUrl}/token`,
      registration_endpoint:
        opts?.registration_endpoint ?? `${tokenServerUrl}/register`,
      code_challenge_methods_supported:
        opts?.code_challenge_methods_supported ?? ["S256"],
    },
  });
}

/**
 * Simulate a browser redirect by parsing the authorization URL, extracting
 * the redirect_uri and state, then making a GET request to the callback
 * server with a test authorization code.
 *
 * Returns a promise that resolves when the callback request completes.
 */
async function simulateBrowserCallback(
  authUrl: string,
  code: string = "test-auth-code",
): Promise<void> {
  const url = new URL(authUrl);
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");

  if (!redirectUri || !state) {
    throw new Error(
      `Missing redirect_uri or state in auth URL: ${authUrl}`,
    );
  }

  const callbackUrl = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

  const response = await fetch(callbackUrl);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Callback request failed with status ${response.status}: ${body}`,
    );
  }
}

/**
 * Schedule a browser callback simulation after a short delay.
 *
 * The openBrowser callback in AuthManager is awaited BEFORE waitForCallback()
 * registers the request handler on the CallbackServer. To avoid a race where
 * the HTTP request arrives before the handler is registered, we fire the
 * request asynchronously (via setTimeout) so that openBrowser() returns
 * immediately and waitForCallback() can set up the handler first.
 *
 * @param authUrl - The authorization URL to parse.
 * @param code - The authorization code to simulate.
 */
function scheduleBrowserCallback(
  authUrl: string,
  code: string = "test-auth-code",
): void {
  // Use setTimeout(0) to defer the request to the next event loop tick,
  // after waitForCallback() has registered its request handler.
  setTimeout(() => {
    void simulateBrowserCallback(authUrl, code);
  }, 50);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthManager", () => {
  let tempDir: string;
  let tokenStore: TokenStore;
  let resourceServer: MockAuthServer;
  let authMetadataServer: MockAuthServer;
  let tokenServer: MockTokenServer;
  let resourceBaseUrl: string;
  let authBaseUrl: string;
  let tokenBaseUrl: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "auth-manager-test-"));
    tokenStore = new TokenStore({ storageDir: tempDir });

    resourceServer = new MockAuthServer();
    authMetadataServer = new MockAuthServer();
    tokenServer = new MockTokenServer();

    resourceBaseUrl = await resourceServer.start();
    authBaseUrl = await authMetadataServer.start();
    tokenBaseUrl = await tokenServer.start();
  });

  afterEach(async () => {
    await resourceServer.stop();
    await authMetadataServer.stop();
    await tokenServer.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // handleUnauthorized — full flow
  // -----------------------------------------------------------------------

  describe("handleUnauthorized()", () => {
    it("should complete the full OAuth flow and return an access token", async () => {
      // Configure resource server metadata
      configureResourceServer(resourceServer, authBaseUrl);

      // Configure auth server metadata
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      // Configure DCR endpoint
      tokenServer.registerResponseStatus = 200;
      tokenServer.registerResponseBody = {
        client_id: "dcr-client-id",
      };

      // Configure token endpoint
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "new-access-token-from-flow",
        refresh_token: "new-refresh-token",
      });

      let capturedAuthUrl = "";

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          // Simulate the browser redirect to the callback server
          scheduleBrowserCallback(url, "test-auth-code");
        },
      });

      const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      const accessToken = await manager.handleUnauthorized(wwwAuthHeader);

      // Verify the access token is returned
      expect(accessToken).toBe("new-access-token-from-flow");

      // Verify the auth URL was constructed properly
      const parsedAuthUrl = new URL(capturedAuthUrl);
      expect(parsedAuthUrl.searchParams.get("response_type")).toBe("code");
      expect(parsedAuthUrl.searchParams.get("client_id")).toBe(
        "dcr-client-id",
      );
      expect(parsedAuthUrl.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(parsedAuthUrl.searchParams.get("resource")).toBe(
        resourceBaseUrl,
      );
      expect(parsedAuthUrl.searchParams.get("state")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("redirect_uri")).toBeTruthy();

      // Verify token was stored
      const storedToken = await tokenStore.getValidToken(resourceBaseUrl);
      expect(storedToken).toBe("new-access-token-from-flow");

      // Verify token endpoint received the correct request body
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("authorization_code");
      expect(tokenBody!["code"]).toBe("test-auth-code");
      expect(tokenBody!["client_id"]).toBe("dcr-client-id");
      expect(tokenBody!["resource"]).toBe(resourceBaseUrl);
      expect(tokenBody!["code_verifier"]).toBeTruthy();
      expect(tokenBody!["redirect_uri"]).toBeTruthy();
    });

    it("should skip DCR when pre-registered client credentials are provided", async () => {
      // Configure resource server metadata
      configureResourceServer(resourceServer, authBaseUrl);

      // Configure auth server metadata (with registration endpoint)
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      // Configure token endpoint
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "pre-reg-access-token",
      });

      let capturedAuthUrl = "";

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        clientId: "my-pre-registered-client",
        clientSecret: "my-client-secret",
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      const accessToken = await manager.handleUnauthorized(wwwAuthHeader);

      expect(accessToken).toBe("pre-reg-access-token");

      // Verify client_id in the auth URL is the pre-registered one
      const parsedAuthUrl = new URL(capturedAuthUrl);
      expect(parsedAuthUrl.searchParams.get("client_id")).toBe(
        "my-pre-registered-client",
      );

      // Verify the token endpoint received client_secret
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["client_id"]).toBe("my-pre-registered-client");
      expect(tokenBody!["client_secret"]).toBe("my-client-secret");

      // Verify DCR endpoint was NOT called
      expect(tokenServer.capturedBodies.has("/register")).toBe(false);
    });

    it("should include scopes from WWW-Authenticate in the auth URL", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      tokenServer.registerResponseBody = { client_id: "test-client" };
      tokenServer.tokenResponseBody = makeTokenResponse();

      let capturedAuthUrl = "";

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource", scope="tools:read tools:execute"`;
      await manager.handleUnauthorized(wwwAuthHeader);

      const parsedAuthUrl = new URL(capturedAuthUrl);
      expect(parsedAuthUrl.searchParams.get("scope")).toBe(
        "tools:read tools:execute",
      );
    });
  });

  // -----------------------------------------------------------------------
  // getAccessToken
  // -----------------------------------------------------------------------

  describe("getAccessToken()", () => {
    it("should return valid token when one is stored", async () => {
      // Pre-store a valid token
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "stored-valid-token",
          expires_in: 3600,
        }),
      );

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.getAccessToken();
      expect(token).toBe("stored-valid-token");
    });

    it("should return null when no token is stored", async () => {
      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.getAccessToken();
      expect(token).toBeNull();
    });

    it("should auto-refresh an expired token that has a refresh_token", async () => {
      // Store an expired token with a refresh_token
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "expired-token",
          refresh_token: "my-refresh-token",
          expires_in: 1, // Will expire almost immediately
        }),
      );

      // Wait a tiny moment so the token expires (plus the 60s buffer
      // means expires_in=1 is always expired)
      // The 60s buffer in TokenStore means a 1-second token is already expired

      // Configure discovery and registration for the refresh flow
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      tokenServer.registerResponseBody = { client_id: "refresh-client" };
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "refreshed-access-token",
        expires_in: 3600,
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.getAccessToken();
      expect(token).toBe("refreshed-access-token");

      // Verify the refresh request was made
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("refresh_token");
      expect(tokenBody!["refresh_token"]).toBe("my-refresh-token");
    });
  });

  // -----------------------------------------------------------------------
  // refreshToken
  // -----------------------------------------------------------------------

  describe("refreshToken()", () => {
    it("should successfully refresh with valid refresh token", async () => {
      // Store a token with refresh_token (expired by buffer)
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "old-access",
          refresh_token: "valid-refresh-token",
          expires_in: 10, // Expired due to 60s buffer
        }),
      );

      // Configure discovery and registration
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "refresh-client" };

      // Configure token endpoint for refresh
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "new-refreshed-token",
        expires_in: 7200,
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.refreshToken();
      expect(token).toBe("new-refreshed-token");

      // Verify the refresh token was sent
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("refresh_token");
      expect(tokenBody!["refresh_token"]).toBe("valid-refresh-token");
      expect(tokenBody!["resource"]).toBe(resourceBaseUrl);
      expect(tokenBody!["client_id"]).toBe("refresh-client");

      // Verify the new token was persisted
      const stored = await tokenStore.getValidToken(resourceBaseUrl);
      expect(stored).toBe("new-refreshed-token");
    });

    it("should return null when no refresh token is stored", async () => {
      // Store a token WITHOUT refresh_token
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "no-refresh-token",
          expires_in: 10,
        }),
      );

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.refreshToken();
      expect(token).toBeNull();
    });

    it("should return null when no tokens are stored at all", async () => {
      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.refreshToken();
      expect(token).toBeNull();
    });

    it("should return null on server error during refresh", async () => {
      // Store a token with refresh_token
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "old-access",
          refresh_token: "my-refresh",
          expires_in: 10,
        }),
      );

      // Configure discovery and registration
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "refresh-client" };

      // Token endpoint returns an error
      tokenServer.tokenResponseStatus = 500;
      tokenServer.tokenResponseBody = {
        error: "server_error",
      };

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await manager.refreshToken();
      expect(token).toBeNull();
    });

    it("should include client_secret in refresh request when available", async () => {
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "old-access",
          refresh_token: "refresh-with-secret",
          expires_in: 10,
        }),
      );

      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "refreshed-with-secret",
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        clientId: "pre-reg-client",
        clientSecret: "pre-reg-secret",
        tokenStore,
      });

      const token = await manager.refreshToken();
      expect(token).toBe("refreshed-with-secret");

      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["client_id"]).toBe("pre-reg-client");
      expect(tokenBody!["client_secret"]).toBe("pre-reg-secret");
    });
  });

  // -----------------------------------------------------------------------
  // handleInsufficientScope
  // -----------------------------------------------------------------------

  describe("handleInsufficientScope()", () => {
    it("should merge scopes from existing token and new WWW-Authenticate header", async () => {
      // Store a token with existing scopes
      await tokenStore.store(resourceBaseUrl, {
        ...makeTokenResponse({
          access_token: "old-token",
          scope: "read write",
          expires_in: 3600,
        }),
      });

      // Configure servers
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "scope-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "expanded-scope-token",
        scope: "read write admin",
      });

      let capturedAuthUrl = "";

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          scheduleBrowserCallback(url);
        },
      });

      // Request additional "admin" scope
      const wwwAuthHeader =
        'Bearer error="insufficient_scope", scope="admin"';
      const token = await manager.handleInsufficientScope(wwwAuthHeader);

      expect(token).toBe("expanded-scope-token");

      // Verify the auth URL contains merged scopes
      const parsedAuthUrl = new URL(capturedAuthUrl);
      const requestedScope = parsedAuthUrl.searchParams.get("scope");
      expect(requestedScope).toBeTruthy();

      // The merged scopes should contain all of: read, write, admin
      const scopeSet = new Set(requestedScope!.split(" "));
      expect(scopeSet.has("read")).toBe(true);
      expect(scopeSet.has("write")).toBe(true);
      expect(scopeSet.has("admin")).toBe(true);
    });

    it("should work without a WWW-Authenticate header", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "scope-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "no-header-token",
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const token = await manager.handleInsufficientScope();
      expect(token).toBe("no-header-token");
    });

    it("should use cached discovery from prior handleUnauthorized call", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "cached-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "first-token",
        scope: "read",
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      // First: handleUnauthorized populates the cache
      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      await manager.handleUnauthorized(wwwAuth);

      // Clear recorded requests to isolate the second call
      resourceServer.resetRequests();
      authMetadataServer.resetRequests();

      // Update token response for the second call
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "second-token",
        scope: "read admin",
      });

      // Second: handleInsufficientScope should use cached discovery
      const token = await manager.handleInsufficientScope(
        'Bearer scope="admin"',
      );
      expect(token).toBe("second-token");

      // Discovery endpoints should NOT have been called again
      const resourceRequests = resourceServer.getRequests();
      const authRequests = authMetadataServer.getRequests();
      expect(resourceRequests.length).toBe(0);
      expect(authRequests.length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // clearTokens
  // -----------------------------------------------------------------------

  describe("clearTokens()", () => {
    it("should remove stored tokens and clear cached state", async () => {
      // Store a token
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({ access_token: "token-to-clear" }),
      );

      // Verify it's there
      const before = await tokenStore.getValidToken(resourceBaseUrl);
      expect(before).toBe("token-to-clear");

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      await manager.clearTokens();

      // Token should be gone
      const after = await tokenStore.getValidToken(resourceBaseUrl);
      expect(after).toBeNull();

      // retrieve should also return null
      const stored = await tokenStore.retrieve(resourceBaseUrl);
      expect(stored).toBeNull();
    });

    it("should be safe to call when no tokens exist", async () => {
      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      // Should not throw
      await expect(manager.clearTokens()).resolves.toBeUndefined();
    });

    it("should force fresh discovery after clearing", async () => {
      // Set up and run a full flow to populate cache
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "clear-test-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "initial-token",
      });

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      await manager.handleUnauthorized(wwwAuth);

      // Clear tokens (and caches)
      await manager.clearTokens();

      // Reset request logs
      resourceServer.resetRequests();
      authMetadataServer.resetRequests();

      // Run another auth flow -- should re-discover
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "after-clear-token",
      });

      await manager.handleUnauthorized(wwwAuth);

      // Discovery servers should have been called again
      const resourceRequests = resourceServer.getRequests();
      const authRequests = authMetadataServer.getRequests();
      expect(resourceRequests.length).toBeGreaterThan(0);
      expect(authRequests.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Token exchange errors
  // -----------------------------------------------------------------------

  describe("token exchange errors", () => {
    it("should throw MCPError when token endpoint returns an error", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "error-test-client" };

      // Token endpoint returns error
      tokenServer.tokenResponseStatus = 400;
      tokenServer.tokenResponseBody = {
        error: "invalid_grant",
        error_description: "Authorization code has expired",
      };

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;

      await expect(manager.handleUnauthorized(wwwAuth)).rejects.toThrow(
        MCPError,
      );

      try {
        await manager.handleUnauthorized(wwwAuth);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        const mcpError = err as MCPError;
        expect(mcpError.message).toContain("Token exchange failed");
        expect(mcpError.message).toContain("400");
        expect(mcpError.message).toContain("invalid_grant");
        expect(mcpError.message).toContain(
          "Authorization code has expired",
        );
        expect(mcpError.code).toBe(400);
      }
    });

    it("should throw MCPError when token response is missing access_token", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "bad-response-client" };

      // Token endpoint returns a response missing access_token
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = {
        token_type: "Bearer",
        expires_in: 3600,
        // access_token is missing
      };

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;

      await expect(manager.handleUnauthorized(wwwAuth)).rejects.toThrow(
        MCPError,
      );

      try {
        await manager.handleUnauthorized(wwwAuth);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).message).toContain("access_token");
      }
    });

    it("should throw MCPError when token response is missing token_type", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "bad-type-client" };

      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = {
        access_token: "some-token",
        expires_in: 3600,
        // token_type is missing
      };

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;

      await expect(manager.handleUnauthorized(wwwAuth)).rejects.toThrow(
        MCPError,
      );

      try {
        await manager.handleUnauthorized(wwwAuth);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).message).toContain("token_type");
      }
    });

    it("should throw MCPError when token response has invalid expires_in", async () => {
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = {
        client_id: "bad-expires-client",
      };

      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = {
        access_token: "some-token",
        token_type: "Bearer",
        expires_in: -1,
      };

      const manager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;

      await expect(manager.handleUnauthorized(wwwAuth)).rejects.toThrow(
        MCPError,
      );

      try {
        await manager.handleUnauthorized(wwwAuth);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).message).toContain("expires_in");
      }
    });
  });
});
