import { describe, it, expect } from "vitest";
import { AccessError, actorFromAccess, validateAccessClaims } from "../../worker/access";

const TEAM = "labountylabs.cloudflareaccess.com";
const AUD_DASHBOARD = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const AUD_API = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

describe("access jwt claims", () => {
  it("rejects issuer mismatch", () => {
    expect(() =>
      validateAccessClaims(
        { aud: AUD_DASHBOARD, iss: "https://wrong.example.com", exp: Math.floor(Date.now() / 1000) + 3600 },
        AUD_DASHBOARD,
        TEAM,
      ),
    ).toThrow(AccessError);
  });

  it("rejects expired tokens", () => {
    expect(() =>
      validateAccessClaims(
        { aud: AUD_DASHBOARD, iss: `https://${TEAM}`, exp: 1 },
        AUD_DASHBOARD,
        TEAM,
      ),
    ).toThrow("expired");
  });

  it("accepts valid issuer audience and expiry", () => {
    expect(() =>
      validateAccessClaims(
        { aud: AUD_DASHBOARD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600 },
        AUD_DASHBOARD,
        TEAM,
      ),
    ).not.toThrow();
  });

  it("accepts audience as array", () => {
    expect(() =>
      validateAccessClaims(
        { aud: [AUD_API, "other"], iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 3600 },
        AUD_API,
        TEAM,
      ),
    ).not.toThrow();
  });
});

describe("service token identity", () => {
  it("maps common_name to distinct api actors", () => {
    const a = actorFromAccess({ sub: "", commonName: "token-a-id", type: "service_token" }, "api");
    const b = actorFromAccess({ sub: "", commonName: "token-b-id", type: "service_token" }, "api");
    expect(a).toBe("api:svc:token-a-id");
    expect(b).toBe("api:svc:token-b-id");
    expect(a).not.toBe(b);
  });

  it("prefers common_name over service_token_id", () => {
    const actor = actorFromAccess(
      { sub: "", commonName: "cf-client-id", serviceTokenId: "legacy-id", type: "service_token" },
      "api",
    );
    expect(actor).toBe("api:svc:cf-client-id");
  });
});
