/**
 * Unit and integration tests for OAuth 2.1 client registration.
 *
 * Covers:
 * - usePreRegistered() — pre-registered credentials from config
 * - registerViaDynamicRegistration() — RFC 7591 dynamic registration
 * - buildClientMetadataDocument() — Client ID Metadata Documents
 * - registerClient() — orchestrated registration with priority order
 *
 * Uses a MockAuthServer fixture to simulate registration endpoints and
 * a small inline HTTP server for request body assertions.
 *
 * @see SPEC.md section 5.2
 * @see https://datatracker.ietf.org/doc/html/rfc7591
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import {
  usePreRegistered,
  registerViaDynamicRegistration,
  buildClientMetadataDocument,
  registerClient,
} from "../../src/auth/client-registration.js";
import type {
  ClientRegistrationConfig,
  ClientCredentials,
} from "../../src/auth/client-registration.js";
import type { AuthorizationServerMetadata } from "../../src/auth/discovery.js";
import { MCPError } from "../../src/types.js";
import { MockAuthServer } from "../fixtures/mock-auth-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A minimal HTTP server that captures POST request bodies.
 *
 * Used to assert that registerViaDynamicRegistration sends the correct
 * request body to the registration endpoint.
 */
class BodyCapturingServer {
  private server: Server | null = null;
  private port = 0;

  /** The last captured request body (parsed JSON). */
  lastBody: Record<string, unknown> | null = null;

  /** The last captured request headers. */
  lastHeaders: Record<string, string | string[] | undefined> = {};

  /** The response to return. */
  responseStatus = 200;
  responseBody: Record<string, unknown> = {};

  /**
   * Start the server on a random port.
   *
   * @returns The base URL of the running server.
   */
  async start(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.lastHeaders = req.headers as Record<string, string | string[] | undefined>;

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            this.lastBody = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            this.lastBody = null;
          }

          res.writeHead(this.responseStatus, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(this.responseBody));
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
   * Stop the server.
   */
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
 * Build a minimal valid AuthorizationServerMetadata object for tests.
 *
 * @param issuer - The issuer URL.
 * @param opts - Optional overrides for metadata fields.
 * @returns An AuthorizationServerMetadata object.
 */
function makeAuthServerMetadata(
  issuer: string,
  opts?: {
    registration_endpoint?: string;
    client_id_metadata_document_supported?: boolean;
  },
): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(opts?.registration_endpoint !== undefined
      ? { registration_endpoint: opts.registration_endpoint }
      : {}),
    ...(opts?.client_id_metadata_document_supported !== undefined
      ? {
          client_id_metadata_document_supported:
            opts.client_id_metadata_document_supported,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// usePreRegistered
// ---------------------------------------------------------------------------

describe("usePreRegistered", () => {
  it("should return credentials when clientId is provided", () => {
    const config: ClientRegistrationConfig = {
      clientId: "my-client-id",
    };

    const result = usePreRegistered(config);

    expect(result).not.toBeNull();
    expect(result!.clientId).toBe("my-client-id");
  });

  it("should return credentials with secret when clientSecret is also provided", () => {
    const config: ClientRegistrationConfig = {
      clientId: "my-client-id",
      clientSecret: "my-secret",
    };

    const result = usePreRegistered(config);

    expect(result).not.toBeNull();
    expect(result!.clientId).toBe("my-client-id");
    expect(result!.clientSecret).toBe("my-secret");
  });

  it("should set tokenEndpointAuthMethod to 'none' without secret", () => {
    const config: ClientRegistrationConfig = {
      clientId: "my-client-id",
    };

    const result = usePreRegistered(config);

    expect(result).not.toBeNull();
    expect(result!.tokenEndpointAuthMethod).toBe("none");
    expect(result!.clientSecret).toBeUndefined();
  });

  it("should set tokenEndpointAuthMethod to 'client_secret_post' with secret", () => {
    const config: ClientRegistrationConfig = {
      clientId: "my-client-id",
      clientSecret: "my-secret",
    };

    const result = usePreRegistered(config);

    expect(result).not.toBeNull();
    expect(result!.tokenEndpointAuthMethod).toBe("client_secret_post");
  });

  it("should return null when no clientId in config", () => {
    const config: ClientRegistrationConfig = {};

    const result = usePreRegistered(config);

    expect(result).toBeNull();
  });

  it("should return null when clientId is undefined", () => {
    const config: ClientRegistrationConfig = {
      clientId: undefined,
      clientSecret: "some-secret",
    };

    const result = usePreRegistered(config);

    expect(result).toBeNull();
  });

  it("should return null when clientId is empty string", () => {
    const config: ClientRegistrationConfig = {
      clientId: "",
    };

    const result = usePreRegistered(config);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerViaDynamicRegistration
// ---------------------------------------------------------------------------

describe("registerViaDynamicRegistration", () => {
  let mockServer: MockAuthServer;
  let baseUrl: string;

  beforeEach(async () => {
    mockServer = new MockAuthServer();
    baseUrl = await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
  });

  it("should successfully register with mock endpoint and receive client_id", async () => {
    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "assigned-client-id-123",
        client_name: "OpenClaw MCP Client",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });

    const result = await registerViaDynamicRegistration(`${baseUrl}/register`);

    expect(result.clientId).toBe("assigned-client-id-123");
    expect(result.tokenEndpointAuthMethod).toBe("none");
  });

  it("should receive client_secret when server provides one", async () => {
    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "assigned-client-id-456",
        client_secret: "server-assigned-secret",
        client_name: "OpenClaw MCP Client",
        redirect_uris: ["http://127.0.0.1/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      },
    });

    const result = await registerViaDynamicRegistration(`${baseUrl}/register`);

    expect(result.clientId).toBe("assigned-client-id-456");
    expect(result.clientSecret).toBe("server-assigned-secret");
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");
  });

  it("should send correct request body (client_name, redirect_uris, grant_types, etc.)", async () => {
    const bodyCapture = new BodyCapturingServer();
    const captureUrl = await bodyCapture.start();

    bodyCapture.responseStatus = 200;
    bodyCapture.responseBody = {
      client_id: "captured-client-id",
    };

    try {
      await registerViaDynamicRegistration(`${captureUrl}/register`);

      expect(bodyCapture.lastBody).not.toBeNull();
      expect(bodyCapture.lastBody!["client_name"]).toBe("OpenClaw MCP Client");
      expect(bodyCapture.lastBody!["redirect_uris"]).toEqual([
        "http://127.0.0.1/callback",
      ]);
      expect(bodyCapture.lastBody!["grant_types"]).toEqual([
        "authorization_code",
      ]);
      expect(bodyCapture.lastBody!["response_types"]).toEqual(["code"]);
      expect(bodyCapture.lastBody!["token_endpoint_auth_method"]).toBe("none");

      // Verify Content-Type header
      expect(bodyCapture.lastHeaders["content-type"]).toBe("application/json");
    } finally {
      await bodyCapture.stop();
    }
  });

  it("should throw MCPError on HTTP error from registration endpoint", async () => {
    mockServer.setRoute("/register", {
      status: 400,
      body: {
        error: "invalid_client_metadata",
        error_description: "redirect_uris is required",
      },
    });

    await expect(
      registerViaDynamicRegistration(`${baseUrl}/register`),
    ).rejects.toThrow(MCPError);

    try {
      await registerViaDynamicRegistration(`${baseUrl}/register`);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      const message = (err as MCPError).message;
      expect(message).toContain("Dynamic Client Registration failed");
      expect(message).toContain("400");
      expect(message).toContain("invalid_client_metadata");
      expect(message).toContain("redirect_uris is required");
      expect((err as MCPError).code).toBe(400);
    }
  });

  it("should throw MCPError on HTTP 500 error", async () => {
    mockServer.setRoute("/register", {
      status: 500,
      body: {
        error: "server_error",
      },
    });

    await expect(
      registerViaDynamicRegistration(`${baseUrl}/register`),
    ).rejects.toThrow(MCPError);

    try {
      await registerViaDynamicRegistration(`${baseUrl}/register`);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).code).toBe(500);
    }
  });

  it("should throw MCPError when response missing client_id", async () => {
    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_name: "OpenClaw MCP Client",
        // client_id is missing
      },
    });

    await expect(
      registerViaDynamicRegistration(`${baseUrl}/register`),
    ).rejects.toThrow(MCPError);

    try {
      await registerViaDynamicRegistration(`${baseUrl}/register`);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      const message = (err as MCPError).message;
      expect(message).toContain("missing required 'client_id' field");
      expect((err as MCPError).code).toBe(-32005);
    }
  });

  it("should throw MCPError when response has empty client_id", async () => {
    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "",
      },
    });

    await expect(
      registerViaDynamicRegistration(`${baseUrl}/register`),
    ).rejects.toThrow(MCPError);

    try {
      await registerViaDynamicRegistration(`${baseUrl}/register`);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain("client_id");
    }
  });

  it("should use default client name 'OpenClaw MCP Client'", async () => {
    const bodyCapture = new BodyCapturingServer();
    const captureUrl = await bodyCapture.start();

    bodyCapture.responseStatus = 200;
    bodyCapture.responseBody = {
      client_id: "default-name-client-id",
    };

    try {
      // Call without providing a client name (uses the default)
      await registerViaDynamicRegistration(`${captureUrl}/register`);

      expect(bodyCapture.lastBody).not.toBeNull();
      expect(bodyCapture.lastBody!["client_name"]).toBe("OpenClaw MCP Client");
    } finally {
      await bodyCapture.stop();
    }
  });

  it("should use custom client name when provided", async () => {
    const bodyCapture = new BodyCapturingServer();
    const captureUrl = await bodyCapture.start();

    bodyCapture.responseStatus = 200;
    bodyCapture.responseBody = {
      client_id: "custom-name-client-id",
    };

    try {
      await registerViaDynamicRegistration(
        `${captureUrl}/register`,
        "My Custom Client",
      );

      expect(bodyCapture.lastBody).not.toBeNull();
      expect(bodyCapture.lastBody!["client_name"]).toBe("My Custom Client");
    } finally {
      await bodyCapture.stop();
    }
  });

  it("should set tokenEndpointAuthMethod to 'none' when no secret returned", async () => {
    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "no-secret-client",
      },
    });

    const result = await registerViaDynamicRegistration(`${baseUrl}/register`);

    expect(result.clientSecret).toBeUndefined();
    expect(result.tokenEndpointAuthMethod).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// buildClientMetadataDocument
// ---------------------------------------------------------------------------

describe("buildClientMetadataDocument", () => {
  it("should return correct document structure", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(doc).toHaveProperty("client_id");
    expect(doc).toHaveProperty("client_name");
    expect(doc).toHaveProperty("redirect_uris");
    expect(doc).toHaveProperty("grant_types");
    expect(doc).toHaveProperty("response_types");
    expect(doc).toHaveProperty("token_endpoint_auth_method");
  });

  it("should set client_id to match the metadata URL", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(doc.client_id).toBe(metadataUrl);
  });

  it("should include required fields: redirect_uris, grant_types, response_types", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(Array.isArray(doc.redirect_uris)).toBe(true);
    expect(doc.redirect_uris.length).toBeGreaterThan(0);

    expect(Array.isArray(doc.grant_types)).toBe(true);
    expect(doc.grant_types).toContain("authorization_code");

    expect(Array.isArray(doc.response_types)).toBe(true);
    expect(doc.response_types).toContain("code");
  });

  it("should set client_name to 'OpenClaw MCP Client'", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(doc.client_name).toBe("OpenClaw MCP Client");
  });

  it("should set token_endpoint_auth_method to 'none'", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(doc.token_endpoint_auth_method).toBe("none");
  });

  it("should include default redirect URI 'http://127.0.0.1/callback'", () => {
    const metadataUrl = "https://example.com/.well-known/oauth-client/my-app";
    const doc = buildClientMetadataDocument(metadataUrl);

    expect(doc.redirect_uris).toContain("http://127.0.0.1/callback");
  });
});

// ---------------------------------------------------------------------------
// registerClient (integration -- priority order)
// ---------------------------------------------------------------------------

describe("registerClient (integration -- priority order)", () => {
  let mockServer: MockAuthServer;
  let baseUrl: string;

  beforeEach(async () => {
    mockServer = new MockAuthServer();
    baseUrl = await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
  });

  it("should use pre-registered credentials when clientId is in config (highest priority)", async () => {
    // Even if the server has a registration endpoint, pre-registered wins
    const metadata = makeAuthServerMetadata(baseUrl, {
      registration_endpoint: `${baseUrl}/register`,
      client_id_metadata_document_supported: true,
    });

    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "dcr-client-id",
      },
    });

    const config: ClientRegistrationConfig = {
      clientId: "pre-registered-id",
      clientSecret: "pre-registered-secret",
      clientMetadataUrl: "https://example.com/.well-known/oauth-client/my-app",
    };

    const result = await registerClient(metadata, config);

    expect(result.clientId).toBe("pre-registered-id");
    expect(result.clientSecret).toBe("pre-registered-secret");
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");

    // Verify no registration request was made
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(0);
  });

  it("should use Client ID Metadata when server supports it and metadataUrl is provided", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      client_id_metadata_document_supported: true,
      registration_endpoint: `${baseUrl}/register`,
    });

    const config: ClientRegistrationConfig = {
      clientMetadataUrl: "https://example.com/.well-known/oauth-client/my-app",
    };

    const result = await registerClient(metadata, config);

    // Client ID should be the metadata URL per MCP spec
    expect(result.clientId).toBe(
      "https://example.com/.well-known/oauth-client/my-app",
    );
    expect(result.clientSecret).toBeUndefined();
    expect(result.tokenEndpointAuthMethod).toBe("none");

    // Verify no registration request was made to the DCR endpoint
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(0);
  });

  it("should fall back to Dynamic Client Registration when no pre-registered and no metadata support", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      registration_endpoint: `${baseUrl}/register`,
      // client_id_metadata_document_supported is not set (defaults to falsy)
    });

    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "dcr-assigned-client-id",
        client_secret: "dcr-assigned-secret",
      },
    });

    const config: ClientRegistrationConfig = {};

    const result = await registerClient(metadata, config);

    expect(result.clientId).toBe("dcr-assigned-client-id");
    expect(result.clientSecret).toBe("dcr-assigned-secret");
    expect(result.tokenEndpointAuthMethod).toBe("client_secret_post");

    // Verify the registration endpoint was called
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
  });

  it("should throw MCPError when no registration method is available", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      // No registration_endpoint
      // No client_id_metadata_document_supported
    });

    const config: ClientRegistrationConfig = {};

    await expect(registerClient(metadata, config)).rejects.toThrow(MCPError);

    try {
      await registerClient(metadata, config);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      const message = (err as MCPError).message;
      expect(message).toContain("Unable to register OAuth client");
      expect(message).toContain("no registration method available");
      expect((err as MCPError).code).toBe(-32005);
    }
  });

  it("should give pre-registered priority even when DCR is available", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      registration_endpoint: `${baseUrl}/register`,
    });

    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "dcr-client-id",
      },
    });

    const config: ClientRegistrationConfig = {
      clientId: "pre-reg-id",
    };

    const result = await registerClient(metadata, config);

    expect(result.clientId).toBe("pre-reg-id");
    expect(result.tokenEndpointAuthMethod).toBe("none");

    // No DCR request should have been made
    const requests = mockServer.getRequests();
    expect(requests.length).toBe(0);
  });

  it("should use DCR when metadata document not supported (no metadataUrl)", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      registration_endpoint: `${baseUrl}/register`,
      client_id_metadata_document_supported: true,
    });

    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "dcr-fallback-id",
      },
    });

    // No clientMetadataUrl -- so metadata document path is skipped
    const config: ClientRegistrationConfig = {};

    const result = await registerClient(metadata, config);

    // Should fall through to DCR since clientMetadataUrl is not provided
    expect(result.clientId).toBe("dcr-fallback-id");

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
  });

  it("should use DCR when server does not support metadata documents", async () => {
    const metadata = makeAuthServerMetadata(baseUrl, {
      registration_endpoint: `${baseUrl}/register`,
      client_id_metadata_document_supported: false,
    });

    mockServer.setRoute("/register", {
      status: 200,
      body: {
        client_id: "dcr-nosupport-id",
      },
    });

    const config: ClientRegistrationConfig = {
      clientMetadataUrl: "https://example.com/.well-known/oauth-client/my-app",
    };

    const result = await registerClient(metadata, config);

    // Should fall through to DCR since the server doesn't support metadata docs
    expect(result.clientId).toBe("dcr-nosupport-id");

    const requests = mockServer.getRequests();
    expect(requests.length).toBe(1);
    expect(requests[0].method).toBe("POST");
  });

  it("should include issuer in error message when no method available", async () => {
    const metadata = makeAuthServerMetadata("https://auth.example.com");

    const config: ClientRegistrationConfig = {};

    try {
      await registerClient(metadata, config);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).message).toContain("https://auth.example.com");
    }
  });
});
