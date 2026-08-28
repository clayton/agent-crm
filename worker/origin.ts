import type { Env } from "./index";

const CORS_PREFIXES = ["/mcp", "/oauth", "/.well-known", "/authorize", "/callback"];
const OAUTH_LOOPBACK_PREFIXES = ["/authorize", "/callback", "/oauth"];

function trustedHttpsOrigins(env: Env): Set<string> {
  return new Set([`https://${env.DASHBOARD_HOST}`, `https://${env.AGENT_HOST}`]);
}

function isOAuthPath(pathname: string): boolean {
  return OAUTH_LOOPBACK_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** RFC 8252 loopback redirect URIs use ephemeral ports on localhost/127.0.0.1. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function needsOriginGate(pathname: string): boolean {
  return CORS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isOriginAllowed(origin: string, pathname: string, env: Env): boolean {
  if (trustedHttpsOrigins(env).has(origin)) return true;
  if (isOAuthPath(pathname) && isLoopbackOrigin(origin)) return true;
  return false;
}

/** Block untrusted Origin on OAuth/MCP surfaces before OAuthProvider runs. */
export function enforceTrustedOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const { pathname } = new URL(request.url);
  if (!needsOriginGate(pathname)) return null;

  if (!isOriginAllowed(origin, pathname, env)) {
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
