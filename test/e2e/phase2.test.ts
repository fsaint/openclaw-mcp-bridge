/**
 * Phase 2 End-to-End Tests for OAuth 2.1 authentication flows.
 *
 * Tests the full OAuth 2.1 authorization flow integrated with the MCP plugin,
 * covering:
 * 1. Full OAuth flow — 401 triggers discovery, registration, PKCE, token exchange
 * 2. Token refresh — expired tokens auto-refresh via refresh_token
 * 3. Step-up authorization — 403 insufficient_scope re-authorizes with expanded scopes
 * 4. Mixed auth — simultaneous API key and OAuth servers
 * 5. /mcp auth command — slash command triggers the OAuth flow
 *
 * @see SPEC.md sections 5, 6.4, 8
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MockMCPServer } from "../fixtures/mock-mcp-server.js";
import { MockAuthServer } from "../fixtures/mock-auth-server.js";
import { plugin } from "../../src/index.js";
import type { PluginContext, ToolDefinition } from "../../src/index.js";
import { MCPManager } from "../../src/manager/mcp-manager.js";
import type { MCPManagerConfig } from "../../src/manager/mcp-manager.js";
import type { ConfigSchemaType } from "../../src/config-schema.js";
import type { ToolsCallResult } from "../../src/types.js";
import { AuthManager } from "../../src/auth/auth-manager.js";
import type { AuthManagerConfig } from "../../src/auth/auth-manager.js";
import { TokenStore } from "../../src/auth/token-store.js";
import type { OAuthTokenResponse } from "../../src/auth/token-store.js";
import { handleMCPCommand } from "../../src/commands/mcp-manage.js";
import type { AuthManagerResolver } from "../../src/commands/mcp-manage.js";

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
 * A mock token/registration HTTP server that captures POST request bodies
 * and returns configurable JSON responses on /token and /register paths.
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

  /** All captured bodies for paths that may be called multiple times. */
  capturedBodiesAll: Map<string, Array<Record<string, string>>> = new Map();

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
            const existing = this.capturedBodiesAll.get(url.pathname) ?? [];
            existing.push(parsedBody);
            this.capturedBodiesAll.set(url.pathname, existing);

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

  resetCaptures(): void {
    this.capturedBodies.clear();
    this.capturedBodiesAll.clear();
  }
}

/**
 * Configure a resource server (MockAuthServer) with Protected Resource Metadata
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
 * Configure an auth server (MockAuthServer) with Authorization Server Metadata.
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
 */
function scheduleBrowserCallback(
  authUrl: string,
  code: string = "test-auth-code",
): void {
  setTimeout(() => {
    void simulateBrowserCallback(authUrl, code);
  }, 50);
}

/**
 * Build a ConfigSchemaType for one or more mock servers.
 */
function buildConfig(
  servers: Record<string, string>,
  overrides?: Record<string, Record<string, unknown>>,
): ConfigSchemaType {
  const serverConfigs: Record<string, Record<string, unknown>> = {};
  for (const [name, baseUrl] of Object.entries(servers)) {
    serverConfigs[name] = {
      enabled: true,
      url: `${baseUrl}/mcp`,
      transport: "http",
      ...(overrides?.[name] ?? {}),
    };
  }
  return {
    servers: serverConfigs,
    debug: false,
  } as ConfigSchemaType;
}

/**
 * Build a PluginContext from a ConfigSchemaType.
 */
function buildContext(config: ConfigSchemaType): PluginContext {
  return { config };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("Phase 2 End-to-End Tests: OAuth 2.1 Authentication", () => {
  // -------------------------------------------------------------------------
  // 1. Full OAuth flow E2E
  // -------------------------------------------------------------------------

  describe("1. Full OAuth flow E2E", () => {
    let mcpServer: MockMCPServer;
    let mcpBaseUrl: string;
    let resourceServer: MockAuthServer;
    let authMetadataServer: MockAuthServer;
    let tokenServer: MockTokenServer;
    let resourceBaseUrl: string;
    let authBaseUrl: string;
    let tokenBaseUrl: string;
    let tempDir: string;
    let tokenStore: TokenStore;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "phase2-oauth-flow-"));
      tokenStore = new TokenStore({ storageDir: tempDir });

      mcpServer = new MockMCPServer();
      resourceServer = new MockAuthServer();
      authMetadataServer = new MockAuthServer();
      tokenServer = new MockTokenServer();

      mcpBaseUrl = await mcpServer.start();
      resourceBaseUrl = await resourceServer.start();
      authBaseUrl = await authMetadataServer.start();
      tokenBaseUrl = await tokenServer.start();
    });

    afterEach(async () => {
      await mcpServer.stop();
      await resourceServer.stop();
      await authMetadataServer.stop();
      await tokenServer.stop();
      await rm(tempDir, { recursive: true, force: true });
    });

    it("should complete the full OAuth flow: 401 -> discovery -> DCR -> PKCE -> token exchange -> store", async () => {
      // Configure Protected Resource Metadata pointing to the auth server.
      configureResourceServer(resourceServer, authBaseUrl);

      // Configure Authorization Server Metadata with token endpoint.
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      // Configure DCR endpoint to return a client_id.
      tokenServer.registerResponseStatus = 200;
      tokenServer.registerResponseBody = {
        client_id: "e2e-dcr-client-id",
      };

      // Configure token endpoint to return tokens.
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "e2e-oauth-access-token",
        refresh_token: "e2e-refresh-token",
        scope: "tools:read tools:execute",
      });

      let capturedAuthUrl = "";

      // Create AuthManager with a simulated browser callback.
      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          scheduleBrowserCallback(url, "e2e-auth-code");
        },
      });

      // Simulate a 401 from the MCP server with WWW-Authenticate header.
      const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource", scope="tools:read tools:execute"`;

      const accessToken = await authManager.handleUnauthorized(wwwAuthHeader);

      // Verify the access token was returned.
      expect(accessToken).toBe("e2e-oauth-access-token");

      // Verify the authorization URL was properly constructed.
      const parsedAuthUrl = new URL(capturedAuthUrl);
      expect(parsedAuthUrl.searchParams.get("response_type")).toBe("code");
      expect(parsedAuthUrl.searchParams.get("client_id")).toBe("e2e-dcr-client-id");
      expect(parsedAuthUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsedAuthUrl.searchParams.get("resource")).toBe(resourceBaseUrl);
      expect(parsedAuthUrl.searchParams.get("state")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("code_challenge")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("redirect_uri")).toBeTruthy();
      expect(parsedAuthUrl.searchParams.get("scope")).toBe("tools:read tools:execute");

      // Verify the token endpoint received the correct parameters.
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("authorization_code");
      expect(tokenBody!["code"]).toBe("e2e-auth-code");
      expect(tokenBody!["client_id"]).toBe("e2e-dcr-client-id");
      expect(tokenBody!["resource"]).toBe(resourceBaseUrl);
      expect(tokenBody!["code_verifier"]).toBeTruthy();
      expect(tokenBody!["redirect_uri"]).toBeTruthy();

      // Verify the token was persisted to the TokenStore.
      const storedToken = await tokenStore.getValidToken(resourceBaseUrl);
      expect(storedToken).toBe("e2e-oauth-access-token");

      // Verify the stored data includes the refresh token.
      const stored = await tokenStore.retrieve(resourceBaseUrl);
      expect(stored).not.toBeNull();
      expect(stored!.refreshToken).toBe("e2e-refresh-token");
      expect(stored!.scope).toBe("tools:read tools:execute");
    });

    it("should use the obtained OAuth token for subsequent tool calls on the MCP server", async () => {
      // Set up discovery infrastructure.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "tool-call-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "tool-call-bearer-token",
      });

      // Create the AuthManager.
      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      // Trigger the OAuth flow.
      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      const accessToken = await authManager.handleUnauthorized(wwwAuth);
      expect(accessToken).toBe("tool-call-bearer-token");

      // Now getAccessToken should return the cached token without another flow.
      const cachedToken = await authManager.getAccessToken();
      expect(cachedToken).toBe("tool-call-bearer-token");

      // Use the plugin to initialize the MCP server with the API key (simulating
      // passing the OAuth token as an Authorization header).
      const config = buildConfig(
        { server: mcpBaseUrl },
        { server: { apiKey: accessToken } },
      );
      const context = buildContext(config);
      const result = await plugin.initialize(context);

      // The MCP server should have received the Authorization header.
      const requests = mcpServer.getRequests();
      const initRequest = requests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "initialize",
      );
      expect(initRequest).toBeDefined();
      expect(initRequest!.headers["authorization"]).toBe(
        `Bearer ${accessToken}`,
      );

      // Tool calls should work normally.
      const echoTool = result.tools.find((t) => t.name === "server__echo");
      expect(echoTool).toBeDefined();
      const echoResult = (await echoTool!.execute({
        message: "oauth test",
      })) as ToolsCallResult;
      expect(echoResult.content[0].text).toContain("oauth test");

      await result.onShutdown!();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Token refresh E2E
  // -------------------------------------------------------------------------

  describe("2. Token refresh E2E", () => {
    let resourceServer: MockAuthServer;
    let authMetadataServer: MockAuthServer;
    let tokenServer: MockTokenServer;
    let resourceBaseUrl: string;
    let authBaseUrl: string;
    let tokenBaseUrl: string;
    let tempDir: string;
    let tokenStore: TokenStore;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "phase2-refresh-"));
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

    it("should auto-refresh an expired token using the refresh_token", async () => {
      // Store an expired token with a refresh_token.
      // expires_in=1 is immediately expired due to the 60-second buffer.
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "expired-access-token",
          refresh_token: "e2e-refresh-token",
          expires_in: 1,
        }),
      );

      // Set up discovery so the refresh flow can find the token endpoint.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "refresh-client" };

      // Configure the token endpoint to accept refresh requests.
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "refreshed-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      });

      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      // getAccessToken should detect the expired token and auto-refresh.
      const token = await authManager.getAccessToken();
      expect(token).toBe("refreshed-access-token");

      // Verify the refresh request was sent correctly.
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("refresh_token");
      expect(tokenBody!["refresh_token"]).toBe("e2e-refresh-token");
      expect(tokenBody!["resource"]).toBe(resourceBaseUrl);
      expect(tokenBody!["client_id"]).toBe("refresh-client");

      // Verify the new token was persisted.
      const stored = await tokenStore.retrieve(resourceBaseUrl);
      expect(stored).not.toBeNull();
      expect(stored!.accessToken).toBe("refreshed-access-token");

      // Subsequent getAccessToken calls should return the new token.
      const secondCall = await authManager.getAccessToken();
      expect(secondCall).toBe("refreshed-access-token");
    });

    it("should preserve the refresh token when the server does not rotate it", async () => {
      // Store an expired token with a refresh_token.
      await tokenStore.store(
        resourceBaseUrl,
        makeTokenResponse({
          access_token: "expired-token",
          refresh_token: "original-refresh-token",
          expires_in: 1,
        }),
      );

      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "no-rotate-client" };

      // Token endpoint does NOT return a new refresh_token (no rotation).
      tokenServer.tokenResponseStatus = 200;
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "no-rotate-access-token",
        expires_in: 3600,
        // No refresh_token in response.
      });

      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
      });

      const token = await authManager.getAccessToken();
      expect(token).toBe("no-rotate-access-token");

      // The original refresh token should be preserved.
      const stored = await tokenStore.retrieve(resourceBaseUrl);
      expect(stored).not.toBeNull();
      expect(stored!.accessToken).toBe("no-rotate-access-token");
      expect(stored!.refreshToken).toBe("original-refresh-token");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Step-up authorization E2E (403 insufficient_scope)
  // -------------------------------------------------------------------------

  describe("3. Step-up authorization E2E (403 insufficient_scope)", () => {
    let resourceServer: MockAuthServer;
    let authMetadataServer: MockAuthServer;
    let tokenServer: MockTokenServer;
    let resourceBaseUrl: string;
    let authBaseUrl: string;
    let tokenBaseUrl: string;
    let tempDir: string;
    let tokenStore: TokenStore;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "phase2-stepup-"));
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

    it("should re-authorize with expanded scopes on 403 insufficient_scope", async () => {
      // Store a valid token with limited scopes.
      await tokenStore.store(resourceBaseUrl, {
        ...makeTokenResponse({
          access_token: "limited-scope-token",
          scope: "tools:read",
          expires_in: 3600,
        }),
      });

      // Set up discovery infrastructure.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "stepup-client" };

      // Token endpoint returns a token with expanded scopes.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "expanded-scope-token",
        scope: "tools:read tools:execute admin",
      });

      let capturedAuthUrl = "";

      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          capturedAuthUrl = url;
          scheduleBrowserCallback(url);
        },
      });

      // Simulate a 403 with a scope requirement.
      const wwwAuthHeader = 'Bearer error="insufficient_scope", scope="tools:execute admin"';
      const token = await authManager.handleInsufficientScope(wwwAuthHeader);

      expect(token).toBe("expanded-scope-token");

      // Verify the auth URL contains merged scopes (existing + new).
      const parsedAuthUrl = new URL(capturedAuthUrl);
      const requestedScope = parsedAuthUrl.searchParams.get("scope");
      expect(requestedScope).toBeTruthy();

      const scopeSet = new Set(requestedScope!.split(" "));
      // Existing scope: tools:read
      expect(scopeSet.has("tools:read")).toBe(true);
      // New scopes from 403: tools:execute, admin
      expect(scopeSet.has("tools:execute")).toBe(true);
      expect(scopeSet.has("admin")).toBe(true);

      // Verify the new token was stored.
      const stored = await tokenStore.retrieve(resourceBaseUrl);
      expect(stored).not.toBeNull();
      expect(stored!.accessToken).toBe("expanded-scope-token");
      expect(stored!.scope).toBe("tools:read tools:execute admin");
    });

    it("should use cached discovery from a prior handleUnauthorized call", async () => {
      // First: run a full handleUnauthorized flow to populate the caches.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "cached-stepup-client" };
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "initial-token",
        scope: "read",
      });

      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      await authManager.handleUnauthorized(wwwAuth);

      // Clear request logs to isolate the second call.
      resourceServer.resetRequests();
      authMetadataServer.resetRequests();

      // Update token response for the step-up call.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "stepup-token",
        scope: "read admin",
      });

      // Step-up should use cached discovery and credentials.
      const stepUpToken = await authManager.handleInsufficientScope(
        'Bearer scope="admin"',
      );
      expect(stepUpToken).toBe("stepup-token");

      // Discovery endpoints should NOT have been called again.
      expect(resourceServer.getRequests().length).toBe(0);
      expect(authMetadataServer.getRequests().length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Mixed auth E2E
  // -------------------------------------------------------------------------

  describe("4. Mixed auth E2E (API key + OAuth simultaneously)", () => {
    let apiKeyServer: MockMCPServer;
    let oauthServer: MockMCPServer;
    let apiKeyBaseUrl: string;
    let oauthBaseUrl: string;

    beforeEach(async () => {
      apiKeyServer = new MockMCPServer();
      oauthServer = new MockMCPServer();

      apiKeyBaseUrl = await apiKeyServer.start();
      oauthBaseUrl = await oauthServer.start();
    });

    afterEach(async () => {
      await apiKeyServer.stop();
      await oauthServer.stop();
    });

    it("should handle API key and OAuth servers simultaneously", async () => {
      // Configure two servers: one with API key, one simulating OAuth (via apiKey
      // field, since the plugin passes it as Bearer header).
      const config = buildConfig(
        {
          apikey_server: apiKeyBaseUrl,
          oauth_server: oauthBaseUrl,
        },
        {
          apikey_server: { apiKey: "static-api-key-123" },
          oauth_server: { apiKey: "oauth-access-token-456" },
        },
      );
      const context = buildContext(config);

      const result = await plugin.initialize(context);

      // Should have tools from both servers.
      expect(result.tools.length).toBe(6);
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("apikey_server__echo");
      expect(toolNames).toContain("oauth_server__echo");

      // Clear request logs.
      apiKeyServer.resetRequests();
      oauthServer.resetRequests();

      // Call a tool on the API key server.
      const apiKeyEcho = result.tools.find(
        (t) => t.name === "apikey_server__echo",
      );
      expect(apiKeyEcho).toBeDefined();
      const apiKeyResult = (await apiKeyEcho!.execute({
        message: "api key test",
      })) as ToolsCallResult;
      expect(apiKeyResult.content[0].text).toContain("api key test");

      // Verify the API key server received the correct Bearer token.
      const apiKeyRequests = apiKeyServer.getRequests();
      const apiKeyToolCall = apiKeyRequests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "tools/call",
      );
      expect(apiKeyToolCall).toBeDefined();
      expect(apiKeyToolCall!.headers["authorization"]).toBe(
        "Bearer static-api-key-123",
      );

      // Call a tool on the OAuth server.
      const oauthEcho = result.tools.find(
        (t) => t.name === "oauth_server__echo",
      );
      expect(oauthEcho).toBeDefined();
      const oauthResult = (await oauthEcho!.execute({
        message: "oauth test",
      })) as ToolsCallResult;
      expect(oauthResult.content[0].text).toContain("oauth test");

      // Verify the OAuth server received its token.
      const oauthRequests = oauthServer.getRequests();
      const oauthToolCall = oauthRequests.find(
        (r) =>
          r.method === "POST" &&
          typeof r.body === "object" &&
          r.body !== null &&
          (r.body as Record<string, unknown>).method === "tools/call",
      );
      expect(oauthToolCall).toBeDefined();
      expect(oauthToolCall!.headers["authorization"]).toBe(
        "Bearer oauth-access-token-456",
      );

      await result.onShutdown!();
    });

    it("should route tool calls to the correct server in a mixed auth setup", async () => {
      const config = buildConfig(
        {
          alpha: apiKeyBaseUrl,
          beta: oauthBaseUrl,
        },
        {
          alpha: { apiKey: "alpha-key" },
          beta: { apiKey: "beta-oauth-token" },
        },
      );
      const context = buildContext(config);
      const result = await plugin.initialize(context);

      // Clear logs for clean assertion.
      apiKeyServer.resetRequests();
      oauthServer.resetRequests();

      // Call weather tool on alpha.
      const alphaWeather = result.tools.find(
        (t) => t.name === "alpha__get_weather",
      );
      expect(alphaWeather).toBeDefined();
      const weatherResult = (await alphaWeather!.execute({
        city: "Tokyo",
      })) as ToolsCallResult;
      const weatherData = JSON.parse(
        weatherResult.content[0].text!,
      ) as Record<string, unknown>;
      expect(weatherData.city).toBe("Tokyo");

      // Call echo on beta.
      const betaEcho = result.tools.find((t) => t.name === "beta__echo");
      expect(betaEcho).toBeDefined();
      const echoResult = (await betaEcho!.execute({
        message: "beta message",
      })) as ToolsCallResult;
      expect(echoResult.content[0].text).toContain("beta message");

      // Verify the call was routed to the correct server (alpha got weather, beta got echo).
      const alphaToolCalls = apiKeyServer
        .getRequests()
        .filter(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "tools/call",
        );
      expect(alphaToolCalls.length).toBe(1);

      const betaToolCalls = oauthServer
        .getRequests()
        .filter(
          (r) =>
            r.method === "POST" &&
            typeof r.body === "object" &&
            r.body !== null &&
            (r.body as Record<string, unknown>).method === "tools/call",
        );
      expect(betaToolCalls.length).toBe(1);

      await result.onShutdown!();
    });
  });

  // -------------------------------------------------------------------------
  // 5. /mcp auth command E2E
  // -------------------------------------------------------------------------

  describe("5. /mcp auth command E2E", () => {
    let mcpServer: MockMCPServer;
    let mcpBaseUrl: string;
    let resourceServer: MockAuthServer;
    let authMetadataServer: MockAuthServer;
    let tokenServer: MockTokenServer;
    let resourceBaseUrl: string;
    let authBaseUrl: string;
    let tokenBaseUrl: string;
    let tempDir: string;
    let tokenStore: TokenStore;
    let manager: MCPManager;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "phase2-mcp-auth-"));
      tokenStore = new TokenStore({ storageDir: tempDir });

      mcpServer = new MockMCPServer();
      resourceServer = new MockAuthServer();
      authMetadataServer = new MockAuthServer();
      tokenServer = new MockTokenServer();

      mcpBaseUrl = await mcpServer.start();
      resourceBaseUrl = await resourceServer.start();
      authBaseUrl = await authMetadataServer.start();
      tokenBaseUrl = await tokenServer.start();

      // Create a manager with one OAuth-configured server.
      const managerConfig: MCPManagerConfig = {
        servers: {
          oauthserver: {
            enabled: true,
            url: `${mcpBaseUrl}/mcp`,
            transport: "http",
            auth: {
              clientId: "auth-cmd-client-id",
            },
          } as ConfigSchemaType["servers"][string],
        },
        debug: false,
      };
      manager = new MCPManager(managerConfig);
      await manager.connectAll();
    });

    afterEach(async () => {
      await manager.disconnectAll();
      await mcpServer.stop();
      await resourceServer.stop();
      await authMetadataServer.stop();
      await tokenServer.stop();
      await rm(tempDir, { recursive: true, force: true });
    });

    it("should trigger the OAuth flow and return success message via /mcp auth", async () => {
      // Configure discovery infrastructure.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);

      // Configure token endpoint.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "auth-cmd-token",
      });

      // Create an AuthManager for the server.
      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        clientId: "auth-cmd-client-id",
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      // Create a resolver that returns our AuthManager.
      const resolveAuth: AuthManagerResolver = (serverName: string) => {
        if (serverName === "oauthserver") {
          return authManager;
        }
        return undefined;
      };

      const output = await handleMCPCommand(
        "auth oauthserver",
        manager,
        resolveAuth,
      );

      expect(output).toContain("OAuth authorization");
      expect(output).toContain("oauthserver");
      expect(output).toContain("completed successfully");

      // Verify the token was stored.
      const storedToken = await tokenStore.getValidToken(resourceBaseUrl);
      expect(storedToken).toBe("auth-cmd-token");
    });

    it("should return error when auth subcommand has no server name", async () => {
      const output = await handleMCPCommand("auth", manager);

      expect(output).toContain("Usage");
      expect(output).toContain("serverName");
    });

    it("should return error when server has no OAuth configured", async () => {
      // Create a manager with a server that has no auth config.
      const noAuthConfig: MCPManagerConfig = {
        servers: {
          noauthserver: {
            enabled: true,
            url: `${mcpBaseUrl}/mcp`,
            transport: "http",
            // No auth config.
          } as ConfigSchemaType["servers"][string],
        },
        debug: false,
      };
      const noAuthManager = new MCPManager(noAuthConfig);
      await noAuthManager.connectAll();

      try {
        const output = await handleMCPCommand("auth noauthserver", noAuthManager);
        expect(output).toContain("does not have OAuth authentication configured");
      } finally {
        await noAuthManager.disconnectAll();
      }
    });

    it("should return error when server does not exist", async () => {
      const output = await handleMCPCommand("auth nonexistent", manager);

      expect(output).toContain("Unknown server");
      expect(output).toContain("nonexistent");
    });

    it("should return error when no AuthManager resolver is provided", async () => {
      // Call auth without providing a resolver.
      const output = await handleMCPCommand("auth oauthserver", manager);

      expect(output).toContain("Auth management is not available");
    });
  });

  // -------------------------------------------------------------------------
  // Additional integration: AuthManager + TokenStore lifecycle
  // -------------------------------------------------------------------------

  describe("AuthManager + TokenStore lifecycle integration", () => {
    let resourceServer: MockAuthServer;
    let authMetadataServer: MockAuthServer;
    let tokenServer: MockTokenServer;
    let resourceBaseUrl: string;
    let authBaseUrl: string;
    let tokenBaseUrl: string;
    let tempDir: string;
    let tokenStore: TokenStore;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "phase2-lifecycle-"));
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

    it("should handle the full lifecycle: auth -> use -> expire -> refresh -> use again", async () => {
      // Set up discovery.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "lifecycle-client" };

      // Initial token exchange returns a short-lived token.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "short-lived-token",
        refresh_token: "lifecycle-refresh-token",
        expires_in: 1, // Effectively expired due to 60s buffer.
      });

      const authManager = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      // Step 1: Initial OAuth flow.
      const wwwAuth = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      const initialToken = await authManager.handleUnauthorized(wwwAuth);
      expect(initialToken).toBe("short-lived-token");

      // Step 2: Token is expired (due to buffer). getAccessToken should refresh.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "refreshed-lifecycle-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      });

      const refreshedToken = await authManager.getAccessToken();
      expect(refreshedToken).toBe("refreshed-lifecycle-token");

      // Verify the refresh request was sent.
      const tokenBody = tokenServer.capturedBodies.get("/token");
      expect(tokenBody).toBeDefined();
      expect(tokenBody!["grant_type"]).toBe("refresh_token");
      expect(tokenBody!["refresh_token"]).toBe("lifecycle-refresh-token");

      // Step 3: The refreshed token should now be valid for future calls.
      const cachedToken = await authManager.getAccessToken();
      expect(cachedToken).toBe("refreshed-lifecycle-token");

      // Step 4: Clear tokens and verify we can re-auth from scratch.
      await authManager.clearTokens();
      const afterClear = await authManager.getAccessToken();
      expect(afterClear).toBeNull();
    });

    it("should handle multiple independent AuthManagers for different servers", async () => {
      // Create a second resource server URL (use the same auth infrastructure).
      const secondResourceUrl = `${resourceBaseUrl}/secondary`;

      // Both AuthManagers share the same TokenStore but manage different URLs.
      configureResourceServer(resourceServer, authBaseUrl);
      configureAuthServerMetadata(authMetadataServer, tokenBaseUrl);
      tokenServer.registerResponseBody = { client_id: "multi-client" };

      // First auth manager.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "server-one-token",
      });

      const authManager1 = new AuthManager({
        serverUrl: resourceBaseUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      const wwwAuth1 = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource"`;
      const token1 = await authManager1.handleUnauthorized(wwwAuth1);
      expect(token1).toBe("server-one-token");

      // Second auth manager with different server URL.
      tokenServer.tokenResponseBody = makeTokenResponse({
        access_token: "server-two-token",
      });

      const authManager2 = new AuthManager({
        serverUrl: secondResourceUrl,
        tokenStore,
        openBrowser: async (url: string) => {
          scheduleBrowserCallback(url);
        },
      });

      // The second server URL will try to discover at its own path.
      // Set up the well-known path for the secondary resource.
      resourceServer.setRoute("/.well-known/oauth-protected-resource/secondary", {
        status: 200,
        body: {
          resource: secondResourceUrl,
          authorization_servers: [authBaseUrl],
        },
      });

      const wwwAuth2 = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/secondary"`;
      const token2 = await authManager2.handleUnauthorized(wwwAuth2);
      expect(token2).toBe("server-two-token");

      // Both tokens should be independently retrievable.
      const retrieved1 = await tokenStore.getValidToken(resourceBaseUrl);
      expect(retrieved1).toBe("server-one-token");

      const retrieved2 = await tokenStore.getValidToken(secondResourceUrl);
      expect(retrieved2).toBe("server-two-token");

      // Clearing one should not affect the other.
      await authManager1.clearTokens();
      const afterClear1 = await tokenStore.getValidToken(resourceBaseUrl);
      expect(afterClear1).toBeNull();

      const afterClear2 = await tokenStore.getValidToken(secondResourceUrl);
      expect(afterClear2).toBe("server-two-token");
    });
  });
});
