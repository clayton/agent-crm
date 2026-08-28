import type { ExecutionContext } from "@cloudflare/workers-types";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import {
  accessJwtFromRequest,
  actorFromAccess,
  verifyAccessJwt,
  safeLog,
  AccessError,
} from "./access";
import { handleApiRequest } from "./api";
import { buildMcpHandler } from "./mcp";
import { dashboardData } from "./dashboard";
import * as service from "./service";
import { authHandler } from "./auth-handler";
import { enforceTrustedOrigin } from "./origin";
import { CRMError } from "./service";

export interface Env extends Cloudflare.Env {
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_JWKS_URL?: string;
  ACCESS_ISSUER?: string;
  COOKIE_ENCRYPTION_KEY?: string;
}

const TEAM_DOMAIN = "labountylabs.cloudflareaccess.com";

function devSkipAccess(env: Env): boolean {
  return String((env as { DEV_SKIP_ACCESS?: string }).DEV_SKIP_ACCESS ?? "") === "true";
}

function host(request: Request): string {
  const headerHost = request.headers.get("Host")?.split(":")[0];
  if (headerHost) return headerHost;
  return new URL(request.url).hostname;
}

function isDashboardHost(request: Request, env: Env): boolean {
  const h = host(request);
  return h === env.DASHBOARD_HOST || h === "localhost" || h === "127.0.0.1";
}

function isAgentHost(request: Request, env: Env): boolean {
  const h = host(request);
  return h === env.AGENT_HOST || h.endsWith(".workers.dev");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function verifyBrowserAccess(request: Request, env: Env) {
  if (devSkipAccess(env)) {
    return { sub: "dev", email: "dev@local", type: "browser" as const };
  }
  const token = accessJwtFromRequest(request);
  if (!token) throw new AccessError("Access required");
  return verifyAccessJwt(token, env.ACCESS_AUD_DASHBOARD, env.ACCESS_TEAM_DOMAIN ?? TEAM_DOMAIN);
}

async function verifyApiAccess(request: Request, env: Env) {
  if (devSkipAccess(env)) {
    const svc = request.headers.get("X-Dev-Service-Token") ?? "dev-token";
    return { sub: "", commonName: svc, type: "service_token" as const };
  }
  const token = accessJwtFromRequest(request);
  if (!token) throw new AccessError("Service token required");
  return verifyAccessJwt(token, env.ACCESS_AUD_API, env.ACCESS_TEAM_DOMAIN ?? TEAM_DOMAIN);
}

async function handleDashboard(request: Request, env: Env): Promise<Response> {
  await verifyBrowserAccess(request, env);
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const index = await env.ASSETS.fetch(new URL("/assets/index.html.template", request.url));
    let html = await index.text();
    html = html
      .replace("<!-- CRM_STYLES -->", '<link rel="stylesheet" href="/assets/styles.css">')
      .replace("<!-- CRM_DATA -->", '<script id="crm-data" type="application/json">null</script>')
      .replace("<!-- CRM_SCRIPT -->", '<script src="/assets/app.js" defer></script>');
    return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  }
  if (url.pathname.startsWith("/assets/")) {
    return env.ASSETS.fetch(request);
  }
  const prospectDetailMatch = url.pathname.match(/^\/api\/dashboard\/prospects\/([^/]+)$/);
  if (prospectDetailMatch) {
    const detail = await service.getProspect(env.DB, decodeURIComponent(prospectDetailMatch[1]));
    detail.timeline = await service.timeline(env.DB, "prospect", String(detail.id), 50);
    return json(detail);
  }
  if (url.pathname === "/api/dashboard") {
    const project = url.searchParams.get("project");
    const includeTerminal = url.searchParams.get("include_terminal") === "true";
    const data = await dashboardData(env.DB, project, includeTerminal);
    return json(data);
  }
  return new Response("Not found", { status: 404 });
}

async function handleAgent(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ status: "ok" });
  }
  if (url.pathname.startsWith("/v1/")) {
    const identity = await verifyApiAccess(request, env);
    const actor = actorFromAccess(identity, "api");
    return handleApiRequest(request, {
      db: env.DB,
      actor,
      idempotencyKey: request.headers.get("Idempotency-Key"),
    });
  }
  return new Response("Not found", { status: 404 });
}

const defaultHandler = {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);

    if (host(request).endsWith(".workers.dev") && !devSkipAccess(env)) {
      return new Response("Not found", { status: 404 });
    }

    try {
      if (isAgentHost(request, env) && (url.pathname === "/authorize" || url.pathname === "/callback")) {
        return authHandler.fetch(request, env as never, ctx);
      }
      if (isDashboardHost(request, env)) {
        return handleDashboard(request, env);
      }
      if (isAgentHost(request, env)) {
        return handleAgent(request, env);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AccessError) {
        safeLog("access_denied", { path: url.pathname });
        return json({ error: error.message }, 401);
      }
      if (error instanceof CRMError) {
        return json({ error: error.message, type: "CRMError" }, 400);
      }
      safeLog("worker_error", { path: url.pathname });
      return json({ error: "Internal server error" }, 500);
    }
  },
};

const mcpApiHandler = {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    buildMcpHandler(env.AGENT_HOST, env.DASHBOARD_HOST)(request, env, ctx),
};

const oauthWorker = new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler as never,
  defaultHandler: defaultHandler as never,
  allowPlainPKCE: false,
  scopesSupported: ["crm:read", "crm:write", "offline_access"],
});

const AGENT_ONLY_PREFIXES = ["/mcp", "/oauth", "/.well-known", "/authorize", "/callback"];

function allowedHost(request: Request, env: Env): boolean {
  const h = host(request);
  if (h.endsWith(".workers.dev")) return devSkipAccess(env);
  return (
    h === env.DASHBOARD_HOST ||
    h === env.AGENT_HOST ||
    h === "localhost" ||
    h === "127.0.0.1"
  );
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    if (!allowedHost(request, env)) {
      return new Response("Not found", { status: 404 });
    }
    const url = new URL(request.url);
    if (isDashboardHost(request, env)) {
      const blocked = AGENT_ONLY_PREFIXES.some(
        (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
      );
      if (blocked) return new Response("Not found", { status: 404 });
    }
    const originBlock = enforceTrustedOrigin(request, env);
    if (originBlock) return originBlock;
    try {
      return await oauthWorker.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof AccessError) {
        safeLog("access_denied", { path: url.pathname });
        return json({ error: error.message }, 401);
      }
      if (error instanceof CRMError) {
        return json({ error: error.message, type: "CRMError" }, 400);
      }
      throw error;
    }
  },
};
