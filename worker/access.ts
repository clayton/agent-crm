export type AccessIdentity = {
  sub: string;
  email?: string;
  commonName?: string;
  serviceTokenId?: string;
  type: "browser" | "service_token" | "oauth";
};

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("Invalid JWT format");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function fetchJwksCert(token: string, teamDomain: string): Promise<CryptoKey> {
  const header = JSON.parse(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"))) as { kid?: string };
  const kid = header.kid;
  if (!kid) throw new AccessError("JWT missing kid");
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError("Failed to fetch Access certs");
  const certs = (await res.json()) as { keys: JsonWebKey[] };
  const jwk = certs.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === kid);
  if (!jwk) throw new AccessError("Access cert not found for kid");
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function verifyJwtSignature(token: string, key: CryptoKey): Promise<void> {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, data);
  if (!ok) throw new AccessError("Invalid Access JWT signature");
}

function validateAccessClaims(payload: Record<string, unknown>, expectedAud: string, teamDomain: string): void {
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expectedAud)) {
    throw new AccessError("Access JWT audience mismatch");
  }
  const expectedIss = `https://${teamDomain}`;
  if (payload.iss !== expectedIss) {
    throw new AccessError("Access JWT issuer mismatch");
  }
  const exp = payload.exp;
  if (typeof exp === "number" && exp < Math.floor(Date.now() / 1000)) {
    throw new AccessError("Access JWT expired");
  }
}

export async function verifyAccessJwt(
  token: string,
  expectedAud: string,
  teamDomain: string,
): Promise<AccessIdentity> {
  if (!token) throw new AccessError("Missing Access JWT");
  const payload = decodeJwtPayload(token);
  validateAccessClaims(payload, expectedAud, teamDomain);
  const key = await fetchJwksCert(token, teamDomain);
  await verifyJwtSignature(token, key);
  const sub = String(payload.sub ?? "");
  const email = payload.email ? String(payload.email) : undefined;
  const commonName = payload.common_name ? String(payload.common_name) : undefined;
  const serviceTokenId = payload.service_token_id ? String(payload.service_token_id) : undefined;
  const isServiceToken = Boolean(commonName || serviceTokenId);
  if (!sub && !isServiceToken) throw new AccessError("Access JWT missing identity");
  const type: AccessIdentity["type"] = isServiceToken ? "service_token" : "browser";
  return { sub, email, commonName, serviceTokenId, type };
}

export function actorFromAccess(identity: AccessIdentity, prefix: string): string {
  if (identity.type === "service_token") {
    const tokenId = identity.commonName ?? identity.serviceTokenId;
    if (tokenId) return `${prefix}:svc:${tokenId}`;
  }
  if (identity.email) return `${prefix}:${identity.email}`;
  return `${prefix}:${identity.sub}`;
}

export function actorFromOAuth(clientId: string, email?: string): string {
  if (email) return `mcp:${email}`;
  return `mcp:${clientId}`;
}

export function accessJwtFromRequest(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/CF_Authorization=([^;]+)/);
  return match?.[1] ?? null;
}

export { validateAccessClaims };

export function safeLog(message: string, meta: Record<string, string | number | boolean | undefined> = {}): void {
  const clean = Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== undefined && v !== ""),
  );
  console.log(JSON.stringify({ message, ...clean }));
}
