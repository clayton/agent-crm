import { describe, it, expect } from "vitest";
import { decodeBase64Url, OAuthFlowError } from "../../worker/oauth-utils";

function b64url(data: string): string {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

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
