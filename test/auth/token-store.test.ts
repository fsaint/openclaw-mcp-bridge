/**
 * Unit tests for the TokenStore class.
 *
 * Covers persistent storage, retrieval, expiry-aware access, refresh token
 * rotation, deletion, and server listing. Each test uses an isolated
 * temporary directory for the token storage to prevent cross-test pollution.
 *
 * @see src/auth/token-store.ts
 * @see SPEC.md section 5.3, 5.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
  TokenStore,
  type OAuthTokenResponse,
  type StoredTokens,
} from "../../src/auth/token-store.js";
import { MCPError } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A server URL used throughout the tests. */
const SERVER_URL = "https://mcp.example.com/v1";

/** A second server URL for multi-server tests. */
const SERVER_URL_2 = "https://other.example.com/api";

/**
 * Build a minimal valid OAuthTokenResponse.
 *
 * @param overrides - Optional field overrides.
 * @returns A complete OAuthTokenResponse.
 */
function makeTokenResponse(
  overrides?: Partial<OAuthTokenResponse>,
): OAuthTokenResponse {
  return {
    access_token: "access-token-abc",
    token_type: "Bearer",
    expires_in: 3600,
    ...overrides,
  };
}

/**
 * Compute the expected filename for a given server URL.
 *
 * Mirrors the hashing logic in the TokenStore implementation so tests can
 * verify the on-disk file directly.
 */
function expectedFileName(serverUrl: string): string {
  const hash = createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 16);
  return `${hash}.json`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TokenStore", () => {
  let tempDir: string;
  let store: TokenStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "token-store-test-"));
    store = new TokenStore({ storageDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // store()
  // -------------------------------------------------------------------------

  describe("store()", () => {
    it("should create the storage directory and write a token file with correct JSON structure", async () => {
      // Use a subdirectory that doesn't exist yet to verify recursive mkdir
      const nestedDir = join(tempDir, "nested", "dir");
      const nestedStore = new TokenStore({ storageDir: nestedDir });

      const tokens = makeTokenResponse({
        refresh_token: "refresh-xyz",
        scope: "tools:read",
      });

      await nestedStore.store(SERVER_URL, tokens);

      // Verify the file was created in the nested directory
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(nestedDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      expect(parsed["accessToken"]).toBe("access-token-abc");
      expect(parsed["tokenType"]).toBe("Bearer");
      expect(parsed["refreshToken"]).toBe("refresh-xyz");
      expect(parsed["scope"]).toBe("tools:read");
      expect(parsed["serverUrl"]).toBe(SERVER_URL);
      expect(typeof parsed["expiresAt"]).toBe("number");

      // expiresAt should be approximately now + 3600s (allow 5s tolerance)
      const expectedExpiresAt = Date.now() + 3600 * 1000;
      expect(parsed["expiresAt"] as number).toBeGreaterThan(
        expectedExpiresAt - 5000,
      );
      expect(parsed["expiresAt"] as number).toBeLessThan(
        expectedExpiresAt + 5000,
      );
    });

    it("should overwrite existing tokens for the same server URL", async () => {
      const firstTokens = makeTokenResponse({
        access_token: "first-token",
      });
      const secondTokens = makeTokenResponse({
        access_token: "second-token",
      });

      await store.store(SERVER_URL, firstTokens);
      await store.store(SERVER_URL, secondTokens);

      const retrieved = await store.retrieve(SERVER_URL);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.accessToken).toBe("second-token");
    });

    it("should not include refreshToken when token response has no refresh_token", async () => {
      const tokens = makeTokenResponse();
      // Ensure there is no refresh_token
      delete tokens.refresh_token;

      await store.store(SERVER_URL, tokens);

      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      expect(parsed).not.toHaveProperty("refreshToken");
    });

    it("should not include scope when token response has no scope", async () => {
      const tokens = makeTokenResponse();
      delete tokens.scope;

      await store.store(SERVER_URL, tokens);

      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      expect(parsed).not.toHaveProperty("scope");
    });
  });

  // -------------------------------------------------------------------------
  // retrieve()
  // -------------------------------------------------------------------------

  describe("retrieve()", () => {
    it("should return stored tokens with all fields intact", async () => {
      const tokens = makeTokenResponse({
        access_token: "my-token",
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: "my-refresh",
        scope: "read write",
      });

      await store.store(SERVER_URL, tokens);
      const result = await store.retrieve(SERVER_URL);

      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("my-token");
      expect(result!.tokenType).toBe("Bearer");
      expect(result!.refreshToken).toBe("my-refresh");
      expect(result!.scope).toBe("read write");
      expect(result!.serverUrl).toBe(SERVER_URL);
      expect(typeof result!.expiresAt).toBe("number");
    });

    it("should return null when no tokens exist for the given server URL", async () => {
      const result = await store.retrieve("https://nonexistent.example.com");
      expect(result).toBeNull();
    });

    it("should throw MCPError when token file contains invalid JSON", async () => {
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      await writeFile(filePath, "not valid json {{{", "utf-8");

      await expect(store.retrieve(SERVER_URL)).rejects.toThrow(MCPError);

      try {
        await store.retrieve(SERVER_URL);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).message).toContain("invalid JSON");
        expect((err as MCPError).code).toBe(-32010);
      }
    });

    it("should throw MCPError when token file is missing required fields", async () => {
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      // Valid JSON but missing required fields
      await writeFile(filePath, JSON.stringify({ foo: "bar" }), "utf-8");

      await expect(store.retrieve(SERVER_URL)).rejects.toThrow(MCPError);

      try {
        await store.retrieve(SERVER_URL);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        expect((err as MCPError).message).toContain("accessToken");
        expect((err as MCPError).code).toBe(-32010);
      }
    });

    it("should throw MCPError when token file contains a JSON array instead of object", async () => {
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      await writeFile(filePath, "[1, 2, 3]", "utf-8");

      await expect(store.retrieve(SERVER_URL)).rejects.toThrow(MCPError);

      try {
        await store.retrieve(SERVER_URL);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(MCPError);
        // Arrays pass the typeof "object" check, so the error is about
        // missing required fields rather than "not a JSON object"
        expect((err as MCPError).code).toBe(-32010);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getValidToken()
  // -------------------------------------------------------------------------

  describe("getValidToken()", () => {
    it("should return the access token when it is not expired", async () => {
      const tokens = makeTokenResponse({
        access_token: "valid-token",
        expires_in: 3600, // 1 hour from now
      });

      await store.store(SERVER_URL, tokens);
      const result = await store.getValidToken(SERVER_URL);

      expect(result).toBe("valid-token");
    });

    it("should return null when the token has expired", async () => {
      // Store tokens, then manually overwrite the file with an expired expiresAt
      const tokens = makeTokenResponse({ access_token: "expired-token" });
      await store.store(SERVER_URL, tokens);

      // Read, modify expiresAt to the past, and write back
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed["expiresAt"] = Date.now() - 120_000; // 2 minutes ago
      await writeFile(filePath, JSON.stringify(parsed), "utf-8");

      const result = await store.getValidToken(SERVER_URL);
      expect(result).toBeNull();
    });

    it("should return null when the token expires within the 60-second buffer", async () => {
      // Store tokens with expiresAt only 30 seconds from now
      const tokens = makeTokenResponse({ access_token: "near-expiry-token" });
      await store.store(SERVER_URL, tokens);

      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Set expiresAt to 30 seconds from now — within the 60s buffer
      parsed["expiresAt"] = Date.now() + 30_000;
      await writeFile(filePath, JSON.stringify(parsed), "utf-8");

      const result = await store.getValidToken(SERVER_URL);
      expect(result).toBeNull();
    });

    it("should return null when no tokens are stored for the server", async () => {
      const result = await store.getValidToken(
        "https://unknown.example.com",
      );
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // needsRefresh()
  // -------------------------------------------------------------------------

  describe("needsRefresh()", () => {
    it("should return true when the token has expired", async () => {
      const tokens = makeTokenResponse();
      await store.store(SERVER_URL, tokens);

      // Overwrite expiresAt to the past
      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed["expiresAt"] = Date.now() - 120_000;
      await writeFile(filePath, JSON.stringify(parsed), "utf-8");

      const result = await store.needsRefresh(SERVER_URL);
      expect(result).toBe(true);
    });

    it("should return true when the token is within the 60-second expiry buffer", async () => {
      const tokens = makeTokenResponse();
      await store.store(SERVER_URL, tokens);

      const fileName = expectedFileName(SERVER_URL);
      const filePath = join(tempDir, fileName);
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 45 seconds from now — inside the 60s buffer
      parsed["expiresAt"] = Date.now() + 45_000;
      await writeFile(filePath, JSON.stringify(parsed), "utf-8");

      const result = await store.needsRefresh(SERVER_URL);
      expect(result).toBe(true);
    });

    it("should return false when the token is still valid and outside the buffer", async () => {
      const tokens = makeTokenResponse({ expires_in: 3600 });
      await store.store(SERVER_URL, tokens);

      const result = await store.needsRefresh(SERVER_URL);
      expect(result).toBe(false);
    });

    it("should return false when no tokens are stored for the server", async () => {
      const result = await store.needsRefresh(
        "https://nosuchserver.example.com",
      );
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // updateTokens()
  // -------------------------------------------------------------------------

  describe("updateTokens()", () => {
    it("should preserve old refresh token when new response has none", async () => {
      // Store initial tokens with a refresh token
      const initial = makeTokenResponse({
        access_token: "old-access",
        refresh_token: "original-refresh",
        expires_in: 3600,
      });
      await store.store(SERVER_URL, initial);

      // Update with a response that has NO refresh_token
      const refreshResponse = makeTokenResponse({
        access_token: "new-access",
        expires_in: 7200,
      });
      delete refreshResponse.refresh_token;

      await store.updateTokens(SERVER_URL, refreshResponse);

      const result = await store.retrieve(SERVER_URL);
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("new-access");
      // The original refresh token should be preserved
      expect(result!.refreshToken).toBe("original-refresh");
    });

    it("should rotate refresh token when new response includes one", async () => {
      // Store initial tokens with an old refresh token
      const initial = makeTokenResponse({
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_in: 3600,
      });
      await store.store(SERVER_URL, initial);

      // Update with a response that includes a NEW refresh_token
      const refreshResponse = makeTokenResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });

      await store.updateTokens(SERVER_URL, refreshResponse);

      const result = await store.retrieve(SERVER_URL);
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("new-access");
      expect(result!.refreshToken).toBe("new-refresh");
    });

    it("should work when no existing tokens are stored (first-time update)", async () => {
      const tokens = makeTokenResponse({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      });

      await store.updateTokens(SERVER_URL, tokens);

      const result = await store.retrieve(SERVER_URL);
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("fresh-access");
      expect(result!.refreshToken).toBe("fresh-refresh");
    });

    it("should update the expiresAt timestamp based on the new response", async () => {
      const initial = makeTokenResponse({ expires_in: 100 });
      await store.store(SERVER_URL, initial);

      const refreshResponse = makeTokenResponse({ expires_in: 7200 });
      const beforeUpdate = Date.now();
      await store.updateTokens(SERVER_URL, refreshResponse);

      const result = await store.retrieve(SERVER_URL);
      expect(result).not.toBeNull();
      // New expiresAt should be approximately now + 7200s
      const expectedExpiresAt = beforeUpdate + 7200 * 1000;
      expect(result!.expiresAt).toBeGreaterThan(expectedExpiresAt - 5000);
      expect(result!.expiresAt).toBeLessThan(expectedExpiresAt + 5000);
    });
  });

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe("delete()", () => {
    it("should remove the token file for the given server URL", async () => {
      const tokens = makeTokenResponse();
      await store.store(SERVER_URL, tokens);

      // Confirm file exists
      const fileName = expectedFileName(SERVER_URL);
      const files = await readdir(tempDir);
      expect(files).toContain(fileName);

      // Delete
      await store.delete(SERVER_URL);

      // Confirm file is gone
      const filesAfter = await readdir(tempDir);
      expect(filesAfter).not.toContain(fileName);

      // Confirm retrieve returns null
      const result = await store.retrieve(SERVER_URL);
      expect(result).toBeNull();
    });

    it("should be a no-op when no token file exists for the server", async () => {
      // Should not throw
      await expect(
        store.delete("https://nonexistent.example.com"),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listServers()
  // -------------------------------------------------------------------------

  describe("listServers()", () => {
    it("should return all stored server URLs", async () => {
      await store.store(SERVER_URL, makeTokenResponse());
      await store.store(
        SERVER_URL_2,
        makeTokenResponse({ access_token: "token-2" }),
      );

      const servers = await store.listServers();

      expect(servers).toHaveLength(2);
      expect(servers).toContain(SERVER_URL);
      expect(servers).toContain(SERVER_URL_2);
    });

    it("should return an empty array when no tokens are stored", async () => {
      const servers = await store.listServers();
      expect(servers).toEqual([]);
    });

    it("should return an empty array when the storage directory does not exist", async () => {
      const nonExistentDir = join(tempDir, "does-not-exist");
      const emptyStore = new TokenStore({ storageDir: nonExistentDir });

      const servers = await emptyStore.listServers();
      expect(servers).toEqual([]);
    });

    it("should skip malformed token files without throwing", async () => {
      // Store one valid token
      await store.store(SERVER_URL, makeTokenResponse());

      // Write a malformed file directly to the storage directory
      const malformedPath = join(tempDir, "malformed0000000.json");
      await writeFile(malformedPath, "not valid json!", "utf-8");

      // Write another malformed file with valid JSON but missing fields
      const incompletePath = join(tempDir, "incomplete000000.json");
      await writeFile(
        incompletePath,
        JSON.stringify({ foo: "bar" }),
        "utf-8",
      );

      const servers = await store.listServers();

      // Only the valid token file should be included
      expect(servers).toHaveLength(1);
      expect(servers).toContain(SERVER_URL);
    });

    it("should ignore non-JSON files in the storage directory", async () => {
      await store.store(SERVER_URL, makeTokenResponse());

      // Write a non-.json file
      const txtPath = join(tempDir, "readme.txt");
      await writeFile(txtPath, "not a token", "utf-8");

      const servers = await store.listServers();

      expect(servers).toHaveLength(1);
      expect(servers).toContain(SERVER_URL);
    });
  });

  // -------------------------------------------------------------------------
  // Filename hashing
  // -------------------------------------------------------------------------

  describe("filename hashing", () => {
    it("should use first 16 hex chars of SHA-256 hash as filename", async () => {
      await store.store(SERVER_URL, makeTokenResponse());

      const expectedHash = createHash("sha256")
        .update(SERVER_URL)
        .digest("hex")
        .slice(0, 16);
      const expectedFile = `${expectedHash}.json`;

      const files = await readdir(tempDir);
      expect(files).toContain(expectedFile);
    });

    it("should produce different files for different server URLs", async () => {
      await store.store(SERVER_URL, makeTokenResponse());
      await store.store(SERVER_URL_2, makeTokenResponse());

      const file1 = expectedFileName(SERVER_URL);
      const file2 = expectedFileName(SERVER_URL_2);

      expect(file1).not.toBe(file2);

      const files = await readdir(tempDir);
      expect(files).toContain(file1);
      expect(files).toContain(file2);
    });
  });
});
