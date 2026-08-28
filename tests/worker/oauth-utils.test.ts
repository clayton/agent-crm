import { describe, it, expect, vi, afterEach } from "vitest";
import { accessOidcIssuer, decodeBase64Url, OAuthFlowError, verifyIdToken } from "../../worker/oauth-utils";

function b64url(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

describe("accessOidcIssuer", () => {
  const team = "example.cloudflareaccess.com";
  const clientId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("derives per-app issuer from authorization URL", () => {
    expect(
      accessOidcIssuer({
        ACCESS_AUTHORIZATION_URL: `https://${team}/cdn-cgi/access/sso/oidc/${clientId}/authorization`,
      }),
    ).toBe(`https://${team}/cdn-cgi/access/sso/oidc/${clientId}`);
  });

  it("derives per-app issuer from token or JWKS URL", () => {
    const expected = `https://${team}/cdn-cgi/access/sso/oidc/${clientId}`;
    expect(
      accessOidcIssuer({ ACCESS_TOKEN_URL: `https://${team}/cdn-cgi/access/sso/oidc/${clientId}/token` }),
    ).toBe(expected);
    expect(
      accessOidcIssuer({ ACCESS_JWKS_URL: `https://${team}/cdn-cgi/access/sso/oidc/${clientId}/certs` }),
    ).toBe(expected);
  });

  it("prefers explicit ACCESS_ISSUER", () => {
    expect(
      accessOidcIssuer({
        ACCESS_ISSUER: `https://${team}/cdn-cgi/access/sso/oidc/${clientId}`,
        ACCESS_AUTHORIZATION_URL: `https://${team}/cdn-cgi/access/sso/oidc/other/authorization`,
      }),
    ).toBe(`https://${team}/cdn-cgi/access/sso/oidc/${clientId}`);
  });

  it("rejects bare team domain as issuer (not equal to derived)", () => {
    const derived = accessOidcIssuer({
      ACCESS_AUTHORIZATION_URL: `https://${team}/cdn-cgi/access/sso/oidc/${clientId}/authorization`,
    });
    expect(derived).not.toBe(`https://${team}`);
  });

  it("throws when issuer cannot be derived", () => {
    expect(() => accessOidcIssuer({})).toThrow(OAuthFlowError);
  });
});

describe("verifyIdToken issuer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects bare team domain issuer", async () => {
    const team = "example.cloudflareaccess.com";
    const clientId = "test-audience";
    const expectedIss = `https://${team}/cdn-cgi/access/sso/oidc/${clientId}`;
    const header = b64url(JSON.stringify({ alg: "RS256", kid: "kid-1" }));
    const payload = b64url(
      JSON.stringify({
        iss: `https://${team}`,
        aud: clientId,
        sub: "user-1",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const token = `${header}.${payload}.${b64url("sig")}`;

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      json: async () => ({ keys: [{ kty: "RSA", kid: "kid-1", n: "x", e: "AQAB" }] }),
    } as Response);
    vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true);

    await expect(verifyIdToken(token, "https://example/certs", clientId, expectedIss)).rejects.toThrow(
      "id_token issuer mismatch",
    );
  });
});

describe("decodeBase64Url", () => {
  it("decodes payloads that need padding", () => {
    const json = '{"sub":"abc","aud":"client"}';
    expect(JSON.parse(decodeBase64Url(b64url(json)))).toEqual({ sub: "abc", aud: "client" });
  });

  it("rejects malformed jwt segments via parseJwt path", () => {
    expect(() => decodeBase64Url("!!!")).toThrow();
  });
});

describe("OAuthFlowError", () => {
  it("defaults to status 400", () => {
    const err = new OAuthFlowError("Missing state parameter");
    expect(err.status).toBe(400);
    expect(err.message).toBe("Missing state parameter");
  });
});
