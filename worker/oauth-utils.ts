import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export class OAuthFlowError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacVerify(signatureHex: string, data: string, secret: string): Promise<boolean> {
  if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
  const sig = new Uint8Array(signatureHex.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
}

async function pkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { codeVerifier, codeChallenge };
}

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  secret: string,
): Promise<{ stateToken: string; codeChallenge: string }> {
  const uuid = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = await pkcePair();
  const stateToken = `${uuid}.${await hmacSign(uuid, secret)}`;
  await kv.put(`oauth:state:${uuid}`, JSON.stringify({ oauthReqInfo, codeVerifier }), { expirationTtl: 600 });
  return { stateToken, codeChallenge };
}

export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
  secret: string,
): Promise<{ oauthReqInfo: AuthRequest; codeVerifier: string }> {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) throw new OAuthFlowError("Missing state parameter");
  const dot = state.lastIndexOf(".");
  if (dot === -1) throw new OAuthFlowError("Invalid state format");
  const uuid = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!(await hmacVerify(sig, uuid, secret))) throw new OAuthFlowError("Invalid state signature");
  const stored = await kv.get(`oauth:state:${uuid}`);
  if (!stored) throw new OAuthFlowError("Invalid or expired state");
  await kv.delete(`oauth:state:${uuid}`);
  return JSON.parse(stored) as { oauthReqInfo: AuthRequest; codeVerifier: string };
}

export function upstreamAuthorizeUrl(params: {
  upstreamUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(params.upstreamUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeUpstreamCode(params: {
  upstreamUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; idToken: string }> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(params.upstreamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new OAuthFlowError("Upstream token exchange failed", response.status >= 500 ? 502 : 400);
  }
  const json = (await response.json()) as { access_token?: string; id_token?: string };
  if (!json.access_token || !json.id_token) {
    throw new OAuthFlowError("Upstream token response missing tokens", 502);
  }
  return { accessToken: json.access_token, idToken: json.id_token };
}

/** Per-app Access OIDC issuer: https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client-id> */
export function accessOidcIssuer(env: {
  ACCESS_ISSUER?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
}): string {
  if (env.ACCESS_ISSUER) return env.ACCESS_ISSUER.replace(/\/$/, "");
  for (const url of [env.ACCESS_AUTHORIZATION_URL, env.ACCESS_TOKEN_URL, env.ACCESS_JWKS_URL]) {
    if (!url) continue;
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(\/cdn-cgi\/access\/sso\/oidc\/[^/]+)/);
    if (match) return `${parsed.origin}${match[1]}`;
  }
  throw new OAuthFlowError("OAuth issuer not configured", 503);
}

export function decodeBase64Url(segment: string): string {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

function parseJwt(token: string): { header: { kid?: string }; payload: Record<string, unknown>; signed: string; signature: Uint8Array } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OAuthFlowError("Invalid id_token format");
  const header = JSON.parse(decodeBase64Url(parts[0])) as { kid?: string };
  const payload = JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
  const signature = Uint8Array.from(decodeBase64Url(parts[2]), (c) => c.charCodeAt(0));
  return { header, payload, signed: `${parts[0]}.${parts[1]}`, signature };
}

export async function verifyIdToken(
  idToken: string,
  jwksUrl: string,
  expectedAud: string,
  expectedIss: string,
): Promise<{ sub: string; email?: string; name?: string }> {
  const jwt = parseJwt(idToken);
  const kid = jwt.header.kid;
  if (!kid) throw new OAuthFlowError("id_token missing kid");
  const keys = (await (await fetch(jwksUrl)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const jwk = keys.keys.find((k) => k.kid === kid);
  if (!jwk) throw new OAuthFlowError("id_token signing key not found", 502);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    jwt.signature,
    new TextEncoder().encode(jwt.signed),
  );
  if (!ok) throw new OAuthFlowError("id_token signature invalid", 401);
  const now = Math.floor(Date.now() / 1000);
  const exp = jwt.payload.exp;
  if (typeof exp === "number" && exp < now) throw new OAuthFlowError("id_token expired", 401);
  const aud = jwt.payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expectedAud)) throw new OAuthFlowError("id_token audience mismatch", 401);
  if (jwt.payload.iss !== expectedIss) throw new OAuthFlowError("id_token issuer mismatch", 401);
  const sub = String(jwt.payload.sub ?? "");
  if (!sub) throw new OAuthFlowError("id_token missing sub", 401);
  return {
    sub,
    email: jwt.payload.email ? String(jwt.payload.email) : undefined,
    name: jwt.payload.name ? String(jwt.payload.name) : undefined,
  };
}

export function csrfToken(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: `__Host-CSRF_TOKEN=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
  };
}

export function verifyCsrf(formData: FormData, request: Request): string {
  const fromForm = formData.get("csrf_token");
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/__Host-CSRF_TOKEN=([^;]+)/);
  if (typeof fromForm !== "string" || !match || fromForm !== match[1]) {
    throw new OAuthFlowError("CSRF token mismatch", 403);
  }
  return "__Host-CSRF_TOKEN=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0";
}
