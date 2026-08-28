import type { ExecutionContext } from "@cloudflare/workers-types";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { CRM_READ, CRM_WRITE, OFFLINE_ACCESS } from "./scopes";
import {
  OAuthFlowError,
  createOAuthState,
  csrfToken,
  exchangeUpstreamCode,
  upstreamAuthorizeUrl,
  validateOAuthState,
  verifyCsrf,
  verifyIdToken,
} from "./oauth-utils";
type AuthEnv = {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
  COOKIE_ENCRYPTION_KEY?: string;
};

const ALLOWED_SCOPES = [CRM_READ, CRM_WRITE, OFFLINE_ACCESS];

function validateAuthorizeParams(url: URL): void {
  if (!url.searchParams.get("client_id")) throw new OAuthFlowError("Missing client_id");
  if (!url.searchParams.get("redirect_uri")) throw new OAuthFlowError("Missing redirect_uri");
  if (url.searchParams.get("response_type") !== "code") throw new OAuthFlowError("Unsupported response_type");
  if (!url.searchParams.get("code_challenge")) throw new OAuthFlowError("Missing code_challenge");
  const method = url.searchParams.get("code_challenge_method") ?? "plain";
  if (method !== "S256") throw new OAuthFlowError("code_challenge_method must be S256");
}

function requestedScopes(scope: string[]): string[] {
  const granted = scope.filter((s) => ALLOWED_SCOPES.includes(s as typeof CRM_READ));
  return granted.length ? granted : [CRM_READ];
}

function consentHtml(scopes: string[], csrf: string, oauthState: string): string {
  return `<!DOCTYPE html><html><body>
<h1>Agent CRM</h1>
<p>Grant MCP access with scopes: ${scopes.join(", ")}</p>
<form method="POST">
<input type="hidden" name="csrf_token" value="${csrf}">
<input type="hidden" name="state" value="${oauthState}">
<button type="submit">Allow</button>
</form>
</body></html>`;
}

function redirectToAccess(request: Request, env: AuthEnv, stateToken: string, codeChallenge: string): Response {
  if (!env.ACCESS_CLIENT_ID || !env.ACCESS_AUTHORIZATION_URL) {
    return new Response("OAuth not configured", { status: 503 });
  }
  const location = upstreamAuthorizeUrl({
    upstreamUrl: env.ACCESS_AUTHORIZATION_URL,
    clientId: env.ACCESS_CLIENT_ID,
    redirectUri: new URL("/callback", request.url).href,
    scope: "openid email profile",
    state: stateToken,
    codeChallenge,
  });
  return Response.redirect(location, 302);
}

export const authHandler = {
  fetch: async (request: Request, env: AuthEnv, _ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        validateAuthorizeParams(url);
        if (!env.COOKIE_ENCRYPTION_KEY) {
          return new Response("OAuth not configured", { status: 503 });
        }
        const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
        if (!client) throw new OAuthFlowError("Invalid client_id");
        const { token, setCookie } = csrfToken();
        const encoded = btoa(JSON.stringify({ oauthReqInfo, clientName: client.clientName ?? oauthReqInfo.clientId }));
        return new Response(consentHtml(requestedScopes(oauthReqInfo.scope), token, encoded), {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store", "Set-Cookie": setCookie },
        });
      }

      if (url.pathname === "/authorize" && request.method === "POST") {
        if (!env.COOKIE_ENCRYPTION_KEY) {
          return new Response("OAuth not configured", { status: 503 });
        }
        const form = await request.formData();
        const clearCsrf = verifyCsrf(form, request);
        const encoded = form.get("state");
        if (typeof encoded !== "string") return new Response("Missing state", { status: 400 });
        const parsed = JSON.parse(atob(encoded)) as { oauthReqInfo: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>> };
        const { stateToken, codeChallenge } = await createOAuthState(
          parsed.oauthReqInfo,
          env.OAUTH_KV,
          env.COOKIE_ENCRYPTION_KEY,
        );
        const response = redirectToAccess(request, env, stateToken, codeChallenge);
        response.headers.append("Set-Cookie", clearCsrf);
        return response;
      }

      if (url.pathname === "/callback" && request.method === "GET") {
        if (!env.COOKIE_ENCRYPTION_KEY) {
          return new Response("OAuth not configured", { status: 503 });
        }
        const code = url.searchParams.get("code");
        if (!code) return new Response("Missing authorization code", { status: 400 });
        const { oauthReqInfo, codeVerifier } = await validateOAuthState(request, env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
        if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET || !env.ACCESS_TOKEN_URL || !env.ACCESS_JWKS_URL) {
          return new Response("OAuth not configured", { status: 503 });
        }
        const { idToken } = await exchangeUpstreamCode({
          upstreamUrl: env.ACCESS_TOKEN_URL,
          clientId: env.ACCESS_CLIENT_ID,
          clientSecret: env.ACCESS_CLIENT_SECRET,
          code,
          redirectUri: new URL("/callback", request.url).href,
          codeVerifier,
        });
        const teamDomain = "labountylabs.cloudflareaccess.com";
        const user = await verifyIdToken(
          idToken,
          env.ACCESS_JWKS_URL,
          env.ACCESS_CLIENT_ID,
          `https://${teamDomain}`,
        );
        const scope = requestedScopes(oauthReqInfo.scope);
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: user.sub,
          metadata: { email: user.email ?? user.sub },
          scope,
          props: {
            email: user.email,
            clientId: oauthReqInfo.clientId,
            scope: scope.join(" "),
          },
        });
        return Response.redirect(redirectTo, 302);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof OAuthFlowError) {
        return new Response(error.message, { status: error.status });
      }
      if (error instanceof Error && /invalid|missing|not allowed|must be/i.test(error.message)) {
        return new Response(error.message, { status: 400 });
      }
      return new Response("OAuth error", { status: 500 });
    }
  },
};
