# Security Audit: OpenClaw MCP Client Plugin — Auth Code Paths

**Audit Date**: 2026-02-16
**Auditor**: QA Agent (automated)
**Scope**: All auth-related source files in `src/auth/`, `src/transport/streamable-http.ts`, and `src/config-schema.ts`

---

## Summary Table

| # | Check | Verdict | Severity |
|---|-------|---------|----------|
| 1 | Token leakage | **WARNING** | Medium |
| 2 | Audience isolation | **PASS** | -- |
| 3 | Token storage security (file permissions) | **FAIL** | High |
| 4 | HTTPS enforcement | **FAIL** | High |
| 5 | PKCE S256 enforcement | **PASS** | -- |
| 6 | Redirect URI safety (127.0.0.1 only) | **PASS** | -- |
| 7 | State parameter validation (CSRF) | **WARNING** | Low |
| 8 | XSS in callback HTML | **PASS** | -- |
| 9 | Token file atomic writes | **PASS** | -- |
| 10 | Secret exposure in config | **WARNING** | Medium |
| 11 | Resource parameter (RFC 8707) | **PASS** | -- |
| 12 | Origin header | **FAIL** | Medium |
| 13 | Timing attacks | **WARNING** | Low |
| 14 | Error information disclosure | **WARNING** | Low |

**Overall Risk Assessment: MEDIUM** -- Several issues require attention before production deployment, but the core OAuth 2.1 flow is well-structured with correct PKCE, state validation, and resource binding.

---

## Detailed Findings

### 1. Token Leakage

**Verdict: WARNING**

**Finding**: The default browser opener in `auth-manager.ts` logs the full authorization URL to the console. While the authorization URL itself does not contain tokens, it does contain the PKCE `code_challenge`, `client_id`, `state`, and `resource` parameters. This is acceptable for development but could leak session-correlation information in production logs.

- **File**: `src/auth/auth-manager.ts`, lines 83-88
  ```typescript
  async function defaultOpenBrowser(url: string): Promise<void> {
    console.log(
      "[OpenClaw] Please open the following URL in your browser to authorize:",
    );
    console.log(url);
  }
  ```

- **File**: `src/manager/mcp-manager.ts`, lines 787-791 -- The debug log function does not appear to log tokens or secrets directly, but it logs arbitrary messages when `debug: true` is set. Callers should be audited to ensure no token values are interpolated into debug messages.
  ```typescript
  private log(message: string): void {
    if (this.debug) {
      console.log(`[MCPManager] ${message}`);
    }
  }
  ```

**Positive findings**:
- Access tokens are never logged anywhere in the codebase.
- Refresh tokens are never logged.
- Error messages from token exchange (`auth-manager.ts`, lines 510-528) include server error codes and descriptions but do NOT include the token values or the authorization code.
- Token files are written via `JSON.stringify` and read via `readFile` with no logging of contents.

**Recommendation**:
- The default `openBrowser` fallback should explicitly note that it is a development stub. Production integrations should provide a real browser opener and suppress URL logging.
- Add a comment or guard to the `log()` method in `mcp-manager.ts` warning callers never to pass token values.

---

### 2. Audience Isolation

**Verdict: PASS**

**Finding**: Tokens are properly scoped per MCP server URL.

- **Token storage**: `src/auth/token-store.ts`, line 39 -- Each `StoredTokens` record includes a `serverUrl` field. Token files are keyed by a SHA-256 hash of the server URL (line 93-97), making cross-server confusion impossible.
  ```typescript
  readonly serverUrl: string;
  ```

- **Token retrieval**: `src/auth/token-store.ts`, line 295 -- `getValidToken(serverUrl)` only returns tokens matching the requested server.

- **AuthManager per server**: `src/auth/auth-manager.ts`, line 103 -- Each `AuthManager` instance is bound to a single `serverUrl`. The `getAccessToken()` method (line 155) queries the token store for that specific server URL.

- **RFC 8707 resource parameter**: The `resource` parameter is set to `this.serverUrl` in both the authorization request (line 427) and the token exchange (line 486), and in the refresh token request (line 327). This ensures audience-bound tokens.

**No issues found.**

---

### 3. Token Storage Security (File Permissions)

**Verdict: FAIL**

**Finding**: Token files are written without explicit file permission restrictions. The `mkdir` and `writeFile` calls use default OS permissions (typically `0o644` for files, `0o755` for directories on Unix systems), which means other users on the same machine can read the token files.

- **File**: `src/auth/token-store.ts`, line 215
  ```typescript
  await mkdir(this.storageDir, { recursive: true });
  ```
  No `mode` option specified. Directory will be created with umask-dependent permissions.

- **File**: `src/auth/token-store.ts`, line 239
  ```typescript
  await writeFile(tempPath, data, "utf-8");
  ```
  No `mode` option specified. File will be created with default permissions (typically `0o644`).

**Recommendation**:
- Create the storage directory with `mode: 0o700` (owner-only access):
  ```typescript
  await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
  ```
- Write token files with `mode: 0o600` (owner read/write only):
  ```typescript
  await writeFile(tempPath, data, { encoding: "utf-8", mode: 0o600 });
  ```
- Consider adding a startup check that warns if the token directory has overly permissive permissions.

---

### 4. HTTPS Enforcement

**Verdict: FAIL**

**Finding**: There is no validation anywhere in the codebase that the MCP server URL uses HTTPS. Tokens could be sent over plain HTTP to non-localhost servers.

- **File**: `src/transport/streamable-http.ts`, lines 232-237 -- The constructor accepts any URL without protocol validation:
  ```typescript
  constructor(config: StreamableHTTPConfig) {
    this.url = config.url;
    // ...
  }
  ```

- **File**: `src/transport/streamable-http.ts`, lines 561-576 -- The `buildHeaders()` method attaches the `Authorization` header to every request without checking whether the target URL is HTTPS:
  ```typescript
  if (this.authorizationHeader !== null) {
    headers["Authorization"] = this.authorizationHeader;
  }
  ```

- **File**: `src/config-schema.ts`, line 44 -- The URL field uses `format: "uri"` which validates URI syntax but does NOT enforce HTTPS:
  ```typescript
  url: Type.String({ format: "uri", description: "MCP server endpoint URL" }),
  ```

- **File**: `src/manager/mcp-manager.ts`, lines 558-568 -- API keys are sent as Bearer tokens without any HTTPS check:
  ```typescript
  authorizationHeader:
    serverConfig.apiKey !== undefined
      ? `Bearer ${serverConfig.apiKey}`
      : undefined,
  ```

**Recommendation**:
- Add HTTPS validation in the transport constructor or in the `MCPManager.connect()` method. Allow an exception only for `http://127.0.0.1` and `http://localhost` (for local development/testing).
- Example guard:
  ```typescript
  const parsed = new URL(config.url);
  const isLocalhost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !isLocalhost) {
    throw new MCPError("Tokens may only be sent over HTTPS (except localhost)", -32010);
  }
  ```

---

### 5. PKCE S256 Enforcement

**Verdict: PASS**

**Finding**: The PKCE implementation is correct and S256 is enforced at multiple levels.

- **File**: `src/auth/pkce.ts`, line 49 -- The `PKCEPair` interface hardcodes the method:
  ```typescript
  readonly codeChallengeMethod: "S256";
  ```

- **File**: `src/auth/pkce.ts`, line 128 -- The `generatePKCE()` function always returns `codeChallengeMethod: "S256"`. There is no code path that produces `"plain"`.

- **File**: `src/auth/discovery.ts`, lines 401-414 -- The `validatePKCESupport()` function explicitly rejects authorization servers that do not advertise S256 support:
  ```typescript
  if (!methods || !methods.includes("S256")) {
    throw new MCPError(
      "Authorization server does not support PKCE with S256. " +
        "MCP clients MUST refuse to proceed without S256 support.",
      -32004,
    );
  }
  ```

- **File**: `src/auth/discovery.ts`, line 462 -- `discoverAuth()` calls `validatePKCESupport()` as step 5, ensuring S256 is validated before any authorization flow begins.

- The code verifier is generated with `crypto.randomBytes()` (cryptographically secure) and has a default length of 64 characters (well above the RFC 7636 minimum of 43).

**No issues found.**

---

### 6. Redirect URI Safety

**Verdict: PASS**

**Finding**: The callback server correctly binds exclusively to `127.0.0.1`.

- **File**: `src/auth/callback-server.ts`, line 117
  ```typescript
  server.listen(0, "127.0.0.1", () => {
  ```
  The second argument `"127.0.0.1"` ensures the server only listens on the loopback interface. It does NOT use `"0.0.0.0"` (all interfaces) or `"::"` (IPv6 all interfaces).

- **File**: `src/auth/callback-server.ts`, line 135 -- The redirect URI is constructed with `127.0.0.1`:
  ```typescript
  redirectUri: `http://127.0.0.1:${this.port}${CALLBACK_PATH}`,
  ```

- Port `0` is used, which lets the OS assign a random available port, avoiding port conflicts.

**No issues found.**

---

### 7. State Parameter Validation (CSRF)

**Verdict: WARNING**

**Finding**: The state parameter is generated correctly and validated, but the comparison uses JavaScript's `!==` operator which is theoretically vulnerable to timing attacks.

- **Positive**: State is generated with `crypto.randomBytes(32)` producing 64 hex characters (`src/auth/auth-manager.ts`, line 409):
  ```typescript
  const state = randomBytes(STATE_BYTES).toString("hex");
  ```
  This provides 256 bits of entropy, which is excellent.

- **Positive**: The state is validated in the callback server (`src/auth/callback-server.ts`, line 243):
  ```typescript
  if (state !== this.expectedState) {
  ```

- **Concern**: The `!==` string comparison is not constant-time. However, the state parameter is a one-time-use value for a browser redirect flow, the callback server handles exactly one request and then shuts down, and the attacker would need to make requests to the local loopback interface. The practical exploitability is extremely low.

**Recommendation**: For defense-in-depth, consider using `crypto.timingSafeEqual()`:
```typescript
import { timingSafeEqual } from "node:crypto";
const isMatch = state.length === this.expectedState.length &&
  timingSafeEqual(Buffer.from(state), Buffer.from(this.expectedState));
```

---

### 8. XSS in Callback HTML

**Verdict: PASS**

**Finding**: User-controlled input is properly HTML-escaped before being rendered in the callback response.

- **File**: `src/auth/callback-server.ts`, lines 315-325 -- The `buildErrorHtml()` function escapes `&`, `<`, `>`, and `"`:
  ```typescript
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  ```

- The success HTML (`SUCCESS_HTML`, line 50-52) is a static string with no interpolated values.

- The error messages that flow into `buildErrorHtml()` come from:
  - `error` and `error_description` query parameters (line 205-208) -- properly escaped.
  - Static strings like "Missing required query parameters" -- safe.
  - "State mismatch" -- safe static string.

**Minor note**: The single-quote character (`'`) is not escaped. This is generally safe since the escaped content is placed inside `<p>` tags (not inside HTML attribute values with single quotes). No practical XSS vector exists.

**No issues found.**

---

### 9. Token File Atomic Writes

**Verdict: PASS**

**Finding**: Token files are written atomically using the write-then-rename pattern.

- **File**: `src/auth/token-store.ts`, lines 236-241
  ```typescript
  private async atomicWrite(targetPath: string, data: string): Promise<void> {
    const suffix = randomBytes(8).toString("hex");
    const tempPath = `${targetPath}.${suffix}.tmp`;
    await writeFile(tempPath, data, "utf-8");
    await rename(tempPath, targetPath);
  }
  ```

- A random suffix prevents temp file collisions between concurrent writes.
- The `rename()` operation is atomic on POSIX filesystems (when source and destination are on the same filesystem, which they are since the temp file is in the same directory).
- Both `store()` (line 253) and `updateTokens()` (line 335) use `atomicWrite()`.

**No issues found.**

---

### 10. Secret Exposure in Config

**Verdict: WARNING**

**Finding**: Client secrets and API keys are stored as plaintext strings in the configuration schema with no special handling.

- **File**: `src/config-schema.ts`, line 24
  ```typescript
  clientSecret: Type.Optional(Type.String()),
  ```

- **File**: `src/config-schema.ts`, line 66
  ```typescript
  apiKey: Type.Optional(Type.String()),
  ```

- These values will be present in whatever configuration file the user provides (likely a JSON or YAML file on disk). There is no support for environment variable references, secret store integration, or encryption.

- **File**: `src/manager/mcp-manager.ts`, line 772 -- Config comparison includes the client secret in a direct string comparison, which could theoretically be visible in debug/trace logs in some Node.js debugging scenarios:
  ```typescript
  if (oldAuth.clientSecret !== newAuth.clientSecret) return true;
  ```

**Recommendation**:
- Support environment variable references in the config schema (e.g., `"clientSecret": "$ENV:MY_SECRET"`).
- Document that configuration files containing secrets should have restricted file permissions (e.g., `0o600`).
- Consider supporting OS keychain integration for secret storage.

---

### 11. Resource Parameter (RFC 8707)

**Verdict: PASS**

**Finding**: The `resource` parameter is correctly included in all three auth/token request paths.

- **Authorization request**: `src/auth/auth-manager.ts`, line 427
  ```typescript
  authUrl.searchParams.set("resource", this.serverUrl);
  ```

- **Token exchange (authorization code)**: `src/auth/auth-manager.ts`, line 486
  ```typescript
  body.set("resource", this.serverUrl);
  ```

- **Token refresh**: `src/auth/auth-manager.ts`, line 327
  ```typescript
  body.set("resource", this.serverUrl);
  ```

This ensures that tokens are audience-bound to the specific MCP server, preventing token confusion attacks across servers that share an authorization server.

**No issues found.**

---

### 12. Origin Header

**Verdict: FAIL**

**Finding**: The `Origin` header is not set on any HTTP requests. The MCP specification and OAuth best practices recommend including the `Origin` header on token requests to help authorization servers validate the request source.

- **File**: `src/auth/auth-manager.ts`, lines 499-508 -- The token exchange request does not set an `Origin` header:
  ```typescript
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: controller.signal,
  });
  ```

- The same omission exists in the refresh token request (`auth-manager.ts`, lines 340-349).

- **File**: `src/transport/streamable-http.ts`, lines 561-576 -- The `buildHeaders()` method for transport requests does not include `Origin`:
  ```typescript
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    // ... session ID and auth header, but no Origin
  }
  ```

**Recommendation**:
- Add the `Origin` header to token endpoint requests. The value should be derived from the callback server's redirect URI origin (e.g., `http://127.0.0.1`).
- Consider adding the `Origin` header to MCP server requests as well, per the MCP specification's transport requirements.

---

### 13. Timing Attacks

**Verdict: WARNING**

**Finding**: Several security-sensitive string comparisons use JavaScript's `===`/`!==` operators, which are not constant-time.

- **State validation**: `src/auth/callback-server.ts`, line 243
  ```typescript
  if (state !== this.expectedState) {
  ```

- **Config secret comparison**: `src/manager/mcp-manager.ts`, line 772
  ```typescript
  if (oldAuth.clientSecret !== newAuth.clientSecret) return true;
  ```

**Risk assessment**: The practical risk is very low:
- The state parameter comparison happens on a local-only callback server that accepts exactly one request. An attacker on the local network cannot reach `127.0.0.1`.
- The config secret comparison is an internal check for detecting config changes, not an authentication gate.
- No token comparisons are performed (tokens are stored and forwarded, never validated locally).

**Recommendation**: For defense-in-depth, use `crypto.timingSafeEqual()` for the state comparison. The config comparison is not security-critical and can remain as-is.

---

### 14. Error Information Disclosure

**Verdict: WARNING**

**Finding**: Some error messages include internal details that could help an attacker understand the system's configuration.

- **File**: `src/auth/discovery.ts`, lines 227-230 -- Failed discovery reveals the candidate URLs that were tried:
  ```typescript
  `Failed to discover Protected Resource Metadata for ${serverUrl}. ` +
    `Tried: ${candidateUrls.join(", ")}`,
  ```

- **File**: `src/auth/discovery.ts`, lines 336-339 -- Same pattern for authorization server metadata.

- **File**: `src/auth/client-registration.ts`, lines 287-293 -- Registration failure reveals the auth server issuer URL:
  ```typescript
  `Unable to register OAuth client: no registration method available. ` +
    `... Auth server: ${authServerMetadata.issuer}`,
  ```

- **File**: `src/auth/client-registration.ts`, lines 175-189 -- Dynamic registration errors forward the `error` and `error_description` from the authorization server, which could contain internal details.

**Positive findings**:
- Token values are never included in error messages.
- The callback server sends generic error messages to the browser (after HTML escaping).
- HTTP status codes are included in errors (appropriate for debugging) but no response bodies are leaked for non-error-protocol responses.

**Recommendation**:
- Consider two-tier error messages: a user-facing summary and a debug-level detailed message. Log the detailed message only when `debug: true` is configured.
- The current level of information disclosure is acceptable for a developer tool but should be reviewed if the plugin is deployed in a production environment where error messages might be exposed to end users.

---

## Additional Observations

### Token File Cleanup
- **File**: `src/auth/token-store.ts` -- There is no mechanism to clean up expired tokens from disk. Over time, stale token files will accumulate in `~/.openclaw/mcp/tokens/`. While this is not a direct security vulnerability, stale token files containing expired refresh tokens represent unnecessary exposure.
- **Recommendation**: Add a `cleanExpired()` method or perform cleanup during `store()`/`updateTokens()`.

### Temp File Cleanup on Crash
- **File**: `src/auth/token-store.ts`, line 238 -- If the process crashes between `writeFile` (line 239) and `rename` (line 240), the `.tmp` file will remain on disk. These temp files contain full token data.
- **Recommendation**: Add startup cleanup that removes `*.tmp` files from the token directory.

### Hash Truncation for Filenames
- **File**: `src/auth/token-store.ts`, lines 74, 93-97 -- The token filename uses only the first 16 hex characters (64 bits) of the SHA-256 hash. While 64 bits provides a very low collision probability for typical usage (fewer than 100 servers), this is worth documenting as a design limitation.

### Dynamic Registration Without Client Authentication
- **File**: `src/auth/client-registration.ts`, line 155 -- Dynamic registration always uses `token_endpoint_auth_method: "none"`. This is correct for public clients (the typical case for CLI tools), but it means anyone who knows the client_id can impersonate the client. This is a known limitation of public OAuth clients and is mitigated by PKCE.

---

## Recommended Priority Actions

1. **HIGH -- Fix file permissions** (Finding #3): Add `mode: 0o700` to `mkdir` and `mode: 0o600` to `writeFile` in `token-store.ts`.

2. **HIGH -- Enforce HTTPS** (Finding #4): Add URL protocol validation in the transport or manager layer. Reject non-HTTPS URLs except for `127.0.0.1`/`localhost`.

3. **MEDIUM -- Add Origin header** (Finding #12): Include the `Origin` header on token endpoint requests per OAuth 2.1 best practices.

4. **MEDIUM -- Secret handling in config** (Finding #10): Support environment variable references for `clientSecret` and `apiKey` fields.

5. **LOW -- Constant-time state comparison** (Finding #7/13): Use `crypto.timingSafeEqual()` for the OAuth state parameter validation.

6. **LOW -- Reduce error verbosity** (Finding #14): Consider suppressing internal URLs from user-facing error messages in production mode.
