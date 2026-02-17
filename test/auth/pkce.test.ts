/**
 * Unit tests for the PKCE (Proof Key for Code Exchange) module.
 *
 * Covers code verifier generation, S256 code challenge computation,
 * and the convenience generatePKCE() function. Validates RFC 7636
 * compliance including known test vectors from Appendix B.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import { describe, it, expect } from "vitest";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  generatePKCE,
} from "../../src/auth/pkce.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex matching the RFC 7636 unreserved character set for code verifiers:
 * `[A-Z] [a-z] [0-9] - . _ ~`
 */
const UNRESERVED_CHAR_PATTERN = /^[A-Za-z0-9\-._~]+$/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateCodeVerifier", () => {
  // -------------------------------------------------------------------------
  // Default behavior
  // -------------------------------------------------------------------------

  it("should produce a verifier of default length 64 when no argument is given", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(64);
  });

  // -------------------------------------------------------------------------
  // Custom length
  // -------------------------------------------------------------------------

  it("should produce a verifier of the requested custom length", () => {
    const verifier = generateCodeVerifier(80);
    expect(verifier).toHaveLength(80);
  });

  // -------------------------------------------------------------------------
  // Allowed character set
  // -------------------------------------------------------------------------

  it("should only contain characters from the unreserved set [A-Za-z0-9\\-._~]", () => {
    // Generate several verifiers to increase confidence
    for (let i = 0; i < 10; i++) {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(UNRESERVED_CHAR_PATTERN);
    }
  });

  // -------------------------------------------------------------------------
  // Boundary lengths
  // -------------------------------------------------------------------------

  it("should work with the minimum length of 43", () => {
    const verifier = generateCodeVerifier(43);
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(UNRESERVED_CHAR_PATTERN);
  });

  it("should work with the maximum length of 128", () => {
    const verifier = generateCodeVerifier(128);
    expect(verifier).toHaveLength(128);
    expect(verifier).toMatch(UNRESERVED_CHAR_PATTERN);
  });

  // -------------------------------------------------------------------------
  // Invalid length values
  // -------------------------------------------------------------------------

  it("should throw RangeError when length is less than 43", () => {
    expect(() => generateCodeVerifier(42)).toThrow(RangeError);
    expect(() => generateCodeVerifier(0)).toThrow(RangeError);
    expect(() => generateCodeVerifier(1)).toThrow(RangeError);
  });

  it("should throw RangeError when length is greater than 128", () => {
    expect(() => generateCodeVerifier(129)).toThrow(RangeError);
    expect(() => generateCodeVerifier(256)).toThrow(RangeError);
  });

  it("should throw RangeError when length is not an integer", () => {
    expect(() => generateCodeVerifier(50.5)).toThrow(RangeError);
    expect(() => generateCodeVerifier(43.1)).toThrow(RangeError);
    expect(() => generateCodeVerifier(NaN)).toThrow(RangeError);
    expect(() => generateCodeVerifier(Infinity)).toThrow(RangeError);
  });

  // -------------------------------------------------------------------------
  // Randomness
  // -------------------------------------------------------------------------

  it("should produce different verifiers on consecutive calls", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();

    // Two 64-char random strings from a 66-char alphabet have a negligible
    // chance of collision; if they match, something is broken.
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// computeCodeChallenge
// ---------------------------------------------------------------------------

describe("computeCodeChallenge", () => {
  // -------------------------------------------------------------------------
  // RFC 7636 Appendix B known test vector
  // -------------------------------------------------------------------------

  it("should produce the correct challenge for the RFC 7636 Appendix B test vector", async () => {
    // Known test vector from RFC 7636 Appendix B:
    //   code_verifier  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    //   code_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    const challenge = await computeCodeChallenge(verifier);
    expect(challenge).toBe(expectedChallenge);
  });

  // -------------------------------------------------------------------------
  // Base64url encoding
  // -------------------------------------------------------------------------

  it("should produce base64url encoded output (no +, /, or = characters)", async () => {
    // Generate multiple challenges and verify none contain base64 padding
    // or non-url-safe characters
    for (let i = 0; i < 20; i++) {
      const verifier = generateCodeVerifier();
      const challenge = await computeCodeChallenge(verifier);

      expect(challenge).not.toContain("+");
      expect(challenge).not.toContain("/");
      expect(challenge).not.toContain("=");
    }
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  it("should always produce the same challenge for the same verifier", async () => {
    const verifier = generateCodeVerifier();

    const challenge1 = await computeCodeChallenge(verifier);
    const challenge2 = await computeCodeChallenge(verifier);
    const challenge3 = await computeCodeChallenge(verifier);

    expect(challenge1).toBe(challenge2);
    expect(challenge2).toBe(challenge3);
  });

  // -------------------------------------------------------------------------
  // Different inputs produce different outputs
  // -------------------------------------------------------------------------

  it("should produce different challenges for different verifiers", async () => {
    const verifierA = generateCodeVerifier();
    const verifierB = generateCodeVerifier();

    const challengeA = await computeCodeChallenge(verifierA);
    const challengeB = await computeCodeChallenge(verifierB);

    expect(challengeA).not.toBe(challengeB);
  });
});

// ---------------------------------------------------------------------------
// generatePKCE
// ---------------------------------------------------------------------------

describe("generatePKCE", () => {
  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  it("should return an object with codeVerifier, codeChallenge, and codeChallengeMethod", async () => {
    const pkce = await generatePKCE();

    expect(pkce).toHaveProperty("codeVerifier");
    expect(pkce).toHaveProperty("codeChallenge");
    expect(pkce).toHaveProperty("codeChallengeMethod");
  });

  // -------------------------------------------------------------------------
  // codeChallengeMethod
  // -------------------------------------------------------------------------

  it("should always set codeChallengeMethod to 'S256'", async () => {
    const pkce = await generatePKCE();
    expect(pkce.codeChallengeMethod).toBe("S256");
  });

  // -------------------------------------------------------------------------
  // Consistency between verifier and challenge
  // -------------------------------------------------------------------------

  it("should return a codeChallenge that matches computeCodeChallenge(codeVerifier)", async () => {
    const pkce = await generatePKCE();
    const recomputedChallenge = await computeCodeChallenge(pkce.codeVerifier);

    expect(pkce.codeChallenge).toBe(recomputedChallenge);
  });

  // -------------------------------------------------------------------------
  // Verifier validity
  // -------------------------------------------------------------------------

  it("should produce a codeVerifier with valid length and character set", async () => {
    const pkce = await generatePKCE();

    // Default verifier length is 64
    expect(pkce.codeVerifier).toHaveLength(64);
    // All characters must be from the unreserved set
    expect(pkce.codeVerifier).toMatch(UNRESERVED_CHAR_PATTERN);
  });
});
