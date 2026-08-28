import type { Env } from "./index";

const CORS_PREFIXES = ["/mcp", "/oauth", "/.well-known", "/authorize", "/callback"];

function trustedOrigins(env: Env): Set<string> {
  const origins = new Set([
    `https://${env.DASHBOARD_HOST}`,
    `https://${env.AGENT_HOST}`,
  ]);
  if (env.DEV_SKIP_ACCESS === "true") {
    origins.add("http://localhost:8787");
    origins.add("http://127.0.0.1:8787");
  }
  return origins;
}

function needsOriginGate(pathname: string): boolean {
  return CORS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Block untrusted Origin on OAuth/MCP surfaces before OAuthProvider runs. */
export function enforceTrustedOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const { pathname } = new URL(request.url);
  if (!needsOriginGate(pathname)) return null;

  if (!trustedOrigins(env).has(origin)) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  return null;
}
