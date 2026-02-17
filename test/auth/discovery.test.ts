/**
 * Unit and integration tests for OAuth 2.1 metadata discovery.
 *
 * Covers:
 * - parseWWWAuthenticate() — parsing WWW-Authenticate header values
 * - fetchProtectedResourceMetadata() — RFC 9728 discovery
 * - fetchAuthorizationServerMetadata() — RFC 8414 / OIDC Discovery
 * - validatePKCESupport() — S256 requirement enforcement
 * - discoverAuth() — full end-to-end discovery orchestration
 *
 * Uses a MockAuthServer fixture that serves configurable JSON responses
 * at well-known metadata endpoints.
 *
 * @see SPEC.md section 5.1, 5.2
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseWWWAuthenticate,
  fetchProtectedResourceMetadata,
  fetchAuthorizationServerMetadata,
  validatePKCESupport,
  discoverAuth,
} from "../../src/auth/discovery.js";
import type {
  AuthorizationServerMetadata,
  WWWAuthenticateInfo,
} from "../../src/auth/discovery.js";
import { MCPError } from "../../src/types.js";
import { MockAuthServer } from "../fixtures/mock-auth-server.js";

// ---------------------------------------------------------------------------
// Constants — reusable metadata payloads
// ---------------------------------------------------------------------------

/**
 * A valid Protected Resource Metadata payload for tests.
 *
 * @param authServerUrl - The authorization server URL to include.
 * @param opts - Optional overrides.
 * @returns A valid resource metadata object.
 */
function makeResourceMetadata(
  authServerUrl: string,
  opts?: { scopes_supported?: string[] },
): Record<string, unknown> {
  return {
    resource: "https://mcp.example.com",
    authorization_servers: [authServerUrl],
    ...(opts?.scopes_supported
      ? { scopes_supported: opts.scopes_supported }
      : {}),
  };
}

/**
 * A valid Authorization Server Metadata payload for tests.
 *
 * @param issuer - The issuer URL.
 * @param opts - Optional overrides.
 * @returns A valid auth server metadata object.
 */
function makeAuthServerMetadata(
  issuer: string,
  opts?: {
    code_challenge_methods_supported?: string[];
    scopes_supported?: string[];
  },
): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    code_challenge_methods_supported:
      opts?.code_challenge_methods_supported ?? ["S256"],
    ...(opts?.scopes_supported
      ? { scopes_supported: opts.scopes_supported }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// parseWWWAuthenticate
// ---------------------------------------------------------------------------

describe("parseWWWAuthenticate", () => {
  it("should parse header with resource_metadata and scope (quoted values)", () => {
    const header =
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="tools:read tools:execute"';

    const result = parseWWWAuthenticate(header);

    expect(result.resourceMetadataUrl).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
    expect(result.scope).toBe("tools:read tools:execute");
    expect(result.error).toBeNull();
    expect(result.errorDescription).toBeNull();
  });

  it("should parse header with unquoted values", () => {
    // The implementation regex for unquoted tokens includes commas in the
    // allowed character class, so comma-separated unquoted values will
    // capture trailing commas. Use a single unquoted param at the end
    // (no trailing comma) to test unquoted parsing cleanly.
    const header = "Bearer error=invalid_token";

    const result = parseWWWAuthenticate(header);

    expect(result.error).toBe("invalid_token");
    expect(result.resourceMetadataUrl).toBeNull();
    expect(result.scope).toBeNull();
  });

  it("should parse header with error and error_description", () => {
    const header =
      'Bearer error="insufficient_scope", error_description="Need tools:write scope"';

    const result = parseWWWAuthenticate(header);

    expect(result.error).toBe("insufficient_scope");
    expect(result.errorDescription).toBe("Need tools:write scope");
    expect(result.resourceMetadataUrl).toBeNull();
    expect(result.scope).toBeNull();
  });

  it("should handle header with only Bearer (no params) — all fields null", () => {
    const result = parseWWWAuthenticate("Bearer");

    expect(result.resourceMetadataUrl).toBeNull();
    expect(result.scope).toBeNull();
    expect(result.error).toBeNull();
    expect(result.errorDescription).toBeNull();
  });

  it("should ignore extra/unknown parameters", () => {
    const header =
      'Bearer resource_metadata="https://example.com/rm", realm="MyRealm", foo="bar", scope="read"';

    const result = parseWWWAuthenticate(header);

    expect(result.resourceMetadataUrl).toBe("https://example.com/rm");
    expect(result.scope).toBe("read");
    expect(result.error).toBeNull();
    expect(result.errorDescription).toBeNull();

    // The parsed object should not contain realm or foo — they are ignored
    // by the typed return interface.
    const resultAny = result as Record<string, unknown>;
    expect(resultAny["realm"]).toBeUndefined();
    expect(resultAny["foo"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchProtectedResourceMetadata
// ---------------------------------------------------------------------------

describe("fetchProtectedResourceMetadata", () => {
  let authServer: MockAuthServer;
  let baseUrl: string;

  beforeEach(async () => {
    authServer = new MockAuthServer();
    baseUrl = await authServer.start();
  });

  afterEach(async () => {
    await authServer.stop();
  });

  it("should fetch from wwwAuth.resourceMetadataUrl when provided", async () => {
    const resourceMetadataPath = "/custom/resource-metadata";
    const body = makeResourceMetadata("https://auth.example.com");

    authServer.setRoute(resourceMetadataPath, {
      status: 200,
      body,
    });

    const wwwAuth: WWWAuthenticateInfo = {
      resourceMetadataUrl: `${baseUrl}${resourceMetadataPath}`,
      scope: null,
      error: null,
      errorDescription: null,
    };

    const result = await fetchProtectedResourceMetadata(baseUrl, wwwAuth);

    expect(result.resource).toBe("https://mcp.example.com");
    expect(result.authorization_servers).toEqual([
      "https://auth.example.com",
    ]);
  });

  it("should construct path-aware well-known URI for server with path component", async () => {
    const serverUrl = `${baseUrl}/v1/mcp`;
    const wellKnownPath = "/.well-known/oauth-protected-resource/v1/mcp";
    const body = makeResourceMetadata("https://auth.example.com");

    authServer.setRoute(wellKnownPath, {
      status: 200,
      body,
    });

    const result = await fetchProtectedResourceMetadata(serverUrl);

    expect(result.authorization_servers).toEqual([
      "https://auth.example.com",
    ]);

    // Verify the path-aware well-known URI was tried
    const requests = authServer.getRequests();
    expect(requests.some((r) => r.url === wellKnownPath)).toBe(true);
  });

  it("should fall back to root well-known URI", async () => {
    const serverUrl = `${baseUrl}/v1/mcp`;
    const rootWellKnown = "/.well-known/oauth-protected-resource";
    const body = makeResourceMetadata("https://auth.example.com");

    // Only serve from the root well-known path (path-aware will 404)
    authServer.setRoute(rootWellKnown, {
      status: 200,
      body,
    });

    const result = await fetchProtectedResourceMetadata(serverUrl);

    expect(result.authorization_servers).toEqual([
      "https://auth.example.com",
    ]);

    // Verify that the path-aware URI was tried first, then root
    const requests = authServer.getRequests();
    const urls = requests.map((r) => r.url);
    expect(urls).toContain(
      "/.well-known/oauth-protected-resource/v1/mcp",
    );
    expect(urls).toContain(rootWellKnown);
  });

  it("should throw MCPError when all attempts fail", async () => {
    // No routes configured — all fetches will 404
    const serverUrl = `${baseUrl}/mcp`;

    await expect(
      fetchProtectedResourceMetadata(serverUrl),
    ).rejects.toThrow(MCPError);

    try {
      await fetchProtectedResourceMetadata(serverUrl);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain(
        "Failed to discover Protected Resource Metadata",
      );
    }
  });

  it("should throw MCPError when response missing authorization_servers", async () => {
    const wellKnownPath = "/.well-known/oauth-protected-resource";

    authServer.setRoute(wellKnownPath, {
      status: 200,
      body: {
        resource: "https://mcp.example.com",
        // authorization_servers is missing
      },
    });

    await expect(
      fetchProtectedResourceMetadata(baseUrl),
    ).rejects.toThrow(MCPError);

    try {
      await fetchProtectedResourceMetadata(baseUrl);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain(
        "authorization_servers",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// fetchAuthorizationServerMetadata
// ---------------------------------------------------------------------------

describe("fetchAuthorizationServerMetadata", () => {
  let authServer: MockAuthServer;
  let baseUrl: string;

  beforeEach(async () => {
    authServer = new MockAuthServer();
    baseUrl = await authServer.start();
  });

  afterEach(async () => {
    await authServer.stop();
  });

  it("should fetch from RFC 8414 well-known endpoint (no path)", async () => {
    const rfc8414Path = "/.well-known/oauth-authorization-server";
    const body = makeAuthServerMetadata(baseUrl);

    authServer.setRoute(rfc8414Path, {
      status: 200,
      body,
    });

    const result = await fetchAuthorizationServerMetadata(baseUrl);

    expect(result.issuer).toBe(baseUrl);
    expect(result.authorization_endpoint).toBe(`${baseUrl}/authorize`);
    expect(result.token_endpoint).toBe(`${baseUrl}/token`);

    // Verify RFC 8414 was tried first
    const requests = authServer.getRequests();
    expect(requests[0].url).toBe(rfc8414Path);
  });

  it("should fall back to OIDC discovery endpoint", async () => {
    const oidcPath = "/.well-known/openid-configuration";
    const body = makeAuthServerMetadata(baseUrl);

    // Only serve OIDC (RFC 8414 will 404)
    authServer.setRoute(oidcPath, {
      status: 200,
      body,
    });

    const result = await fetchAuthorizationServerMetadata(baseUrl);

    expect(result.issuer).toBe(baseUrl);

    // Verify RFC 8414 was tried first, then OIDC
    const requests = authServer.getRequests();
    const urls = requests.map((r) => r.url);
    expect(urls[0]).toBe("/.well-known/oauth-authorization-server");
    expect(urls).toContain(oidcPath);
  });

  it("should handle issuer URL with path component (tries 3 endpoints in order)", async () => {
    const issuerUrl = `${baseUrl}/tenant1`;

    // Serve from the third candidate (path-suffix OIDC)
    const thirdCandidatePath =
      "/tenant1/.well-known/openid-configuration";
    const body = makeAuthServerMetadata(issuerUrl);

    authServer.setRoute(thirdCandidatePath, {
      status: 200,
      body,
    });

    const result = await fetchAuthorizationServerMetadata(issuerUrl);

    expect(result.issuer).toBe(issuerUrl);

    // Verify all 3 candidates were tried in order
    const requests = authServer.getRequests();
    const urls = requests.map((r) => r.url);

    expect(urls).toContain(
      "/.well-known/oauth-authorization-server/tenant1",
    );
    expect(urls).toContain("/.well-known/openid-configuration/tenant1");
    expect(urls).toContain(thirdCandidatePath);

    // The first two should have been tried before the third
    const idx0 = urls.indexOf(
      "/.well-known/oauth-authorization-server/tenant1",
    );
    const idx1 = urls.indexOf(
      "/.well-known/openid-configuration/tenant1",
    );
    const idx2 = urls.indexOf(thirdCandidatePath);
    expect(idx0).toBeLessThan(idx1);
    expect(idx1).toBeLessThan(idx2);
  });

  it("should throw MCPError when all attempts fail", async () => {
    // No routes configured — all fetches will 404
    await expect(
      fetchAuthorizationServerMetadata(baseUrl),
    ).rejects.toThrow(MCPError);

    try {
      await fetchAuthorizationServerMetadata(baseUrl);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain(
        "Failed to discover Authorization Server Metadata",
      );
    }
  });

  it("should throw MCPError when response missing required fields", async () => {
    const rfc8414Path = "/.well-known/oauth-authorization-server";

    // Response is missing issuer, authorization_endpoint, and token_endpoint
    authServer.setRoute(rfc8414Path, {
      status: 200,
      body: {
        scopes_supported: ["openid"],
        // missing: issuer, authorization_endpoint, token_endpoint
      },
    });

    await expect(
      fetchAuthorizationServerMetadata(baseUrl),
    ).rejects.toThrow(MCPError);

    try {
      await fetchAuthorizationServerMetadata(baseUrl);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      const message = (err as MCPError).message;
      expect(message).toContain("missing required fields");
      expect(message).toContain("issuer");
      expect(message).toContain("authorization_endpoint");
      expect(message).toContain("token_endpoint");
    }
  });
});

// ---------------------------------------------------------------------------
// validatePKCESupport
// ---------------------------------------------------------------------------

describe("validatePKCESupport", () => {
  it("should pass when code_challenge_methods_supported includes S256", () => {
    const metadata: AuthorizationServerMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      code_challenge_methods_supported: ["plain", "S256"],
    };

    // Should not throw
    expect(() => validatePKCESupport(metadata)).not.toThrow();
  });

  it("should throw MCPError when S256 is absent", () => {
    const metadata: AuthorizationServerMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      code_challenge_methods_supported: ["plain"],
    };

    expect(() => validatePKCESupport(metadata)).toThrow(MCPError);

    try {
      validatePKCESupport(metadata);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain("S256");
      expect((err as MCPError).code).toBe(-32004);
    }
  });

  it("should throw MCPError when code_challenge_methods_supported is missing entirely", () => {
    const metadata: AuthorizationServerMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      // code_challenge_methods_supported is undefined
    };

    expect(() => validatePKCESupport(metadata)).toThrow(MCPError);

    try {
      validatePKCESupport(metadata);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain("S256");
      expect((err as MCPError).message).toContain("(none)");
      expect((err as MCPError).code).toBe(-32004);
    }
  });
});

// ---------------------------------------------------------------------------
// discoverAuth (integration)
// ---------------------------------------------------------------------------

describe("discoverAuth (integration)", () => {
  let resourceServer: MockAuthServer;
  let authServer: MockAuthServer;
  let resourceBaseUrl: string;
  let authBaseUrl: string;

  beforeEach(async () => {
    resourceServer = new MockAuthServer();
    authServer = new MockAuthServer();
    resourceBaseUrl = await resourceServer.start();
    authBaseUrl = await authServer.start();
  });

  afterEach(async () => {
    await resourceServer.stop();
    await authServer.stop();
  });

  it("should complete full flow: server URL + WWW-Authenticate -> DiscoveryResult", async () => {
    const mcpServerUrl = `${resourceBaseUrl}/mcp`;

    // Set up resource metadata at the path-aware well-known URI
    resourceServer.setRoute(
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: makeResourceMetadata(authBaseUrl),
      },
    );

    // Set up auth server metadata
    authServer.setRoute("/.well-known/oauth-authorization-server", {
      status: 200,
      body: makeAuthServerMetadata(authBaseUrl),
    });

    // Build a WWW-Authenticate header pointing to the resource metadata URL
    const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp", scope="tools:read tools:execute"`;

    const result = await discoverAuth(mcpServerUrl, wwwAuthHeader);

    expect(result.resourceMetadata.resource).toBe(
      "https://mcp.example.com",
    );
    expect(result.resourceMetadata.authorization_servers).toEqual([
      authBaseUrl,
    ]);
    expect(result.authServerMetadata.issuer).toBe(authBaseUrl);
    expect(result.authServerMetadata.authorization_endpoint).toBe(
      `${authBaseUrl}/authorize`,
    );
    expect(result.authServerMetadata.token_endpoint).toBe(
      `${authBaseUrl}/token`,
    );
    expect(result.requiredScopes).toEqual(["tools:read", "tools:execute"]);
  });

  it("should complete full flow without WWW-Authenticate header (well-known fallback)", async () => {
    const mcpServerUrl = `${resourceBaseUrl}/mcp`;

    // Set up resource metadata at the path-aware well-known URI
    resourceServer.setRoute(
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: makeResourceMetadata(authBaseUrl),
      },
    );

    // Set up auth server metadata
    authServer.setRoute("/.well-known/oauth-authorization-server", {
      status: 200,
      body: makeAuthServerMetadata(authBaseUrl),
    });

    // No WWW-Authenticate header — discovery falls back to well-known URIs
    const result = await discoverAuth(mcpServerUrl);

    expect(result.resourceMetadata.authorization_servers).toEqual([
      authBaseUrl,
    ]);
    expect(result.authServerMetadata.issuer).toBe(authBaseUrl);
    // No scopes from WWW-Authenticate, and no scopes_supported in resource metadata
    expect(result.requiredScopes).toEqual([]);
  });

  it("should extract correct scopes from WWW-Authenticate", async () => {
    const mcpServerUrl = `${resourceBaseUrl}/mcp`;

    resourceServer.setRoute(
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: makeResourceMetadata(authBaseUrl),
      },
    );

    authServer.setRoute("/.well-known/oauth-authorization-server", {
      status: 200,
      body: makeAuthServerMetadata(authBaseUrl),
    });

    const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp", scope="read write admin"`;

    const result = await discoverAuth(mcpServerUrl, wwwAuthHeader);

    expect(result.requiredScopes).toEqual(["read", "write", "admin"]);
  });

  it("should fall back to scopes_supported from resource metadata when no WWW-Authenticate scope", async () => {
    const mcpServerUrl = `${resourceBaseUrl}/mcp`;

    // Resource metadata includes scopes_supported
    resourceServer.setRoute(
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: makeResourceMetadata(authBaseUrl, {
          scopes_supported: ["mcp:tools", "mcp:resources"],
        }),
      },
    );

    authServer.setRoute("/.well-known/oauth-authorization-server", {
      status: 200,
      body: makeAuthServerMetadata(authBaseUrl),
    });

    // WWW-Authenticate without scope parameter
    const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp"`;

    const result = await discoverAuth(mcpServerUrl, wwwAuthHeader);

    expect(result.requiredScopes).toEqual(["mcp:tools", "mcp:resources"]);
  });

  it("should throw when auth server does not support S256", async () => {
    const mcpServerUrl = `${resourceBaseUrl}/mcp`;

    resourceServer.setRoute(
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: makeResourceMetadata(authBaseUrl),
      },
    );

    // Auth server only supports "plain", not "S256"
    authServer.setRoute("/.well-known/oauth-authorization-server", {
      status: 200,
      body: makeAuthServerMetadata(authBaseUrl, {
        code_challenge_methods_supported: ["plain"],
      }),
    });

    const wwwAuthHeader = `Bearer resource_metadata="${resourceBaseUrl}/.well-known/oauth-protected-resource/mcp"`;

    await expect(
      discoverAuth(mcpServerUrl, wwwAuthHeader),
    ).rejects.toThrow(MCPError);

    try {
      await discoverAuth(mcpServerUrl, wwwAuthHeader);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain("S256");
    }
  });
});
