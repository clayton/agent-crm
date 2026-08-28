import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../worker/index";
import { migrateLocal } from "../../worker/db";
import * as service from "../../worker/service";
import { scopesAllowTool } from "../../worker/scopes";

const ctx = createExecutionContext();

async function fetchWorker(
  path: string,
  hostname: string,
  init: RequestInit = {},
  extraEnv: Record<string, unknown> = {},
): Promise<Response> {
  const request = new Request(`http://${hostname}${path}`, init);
  const response = await worker.fetch(request, { ...env, DEV_SKIP_ACCESS: "true", ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("agent-crm worker", () => {
  beforeEach(async () => {
    await migrateLocal(env.DB);
  });

  it("health returns ok on agent routes", async () => {
    const res = await fetchWorker("/health", "crm-agent.services.c18h.net");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("creates project via service layer", async () => {
    const project = await service.createProject(env.DB, "Test", "test:actor", "test-proj");
    expect(project.slug).toBe("test-proj");
    const listed = await service.listProjects(env.DB);
    expect(listed.some((p) => p.id === project.id)).toBe(true);
  });

  it("api creates company with idempotency", async () => {
    await service.createProject(env.DB, "API", "api:actor", "api-proj");
    const body = JSON.stringify({ project: "api-proj", name: "Acme" });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-company-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const first = await fetchWorker("/v1/projects/api-proj/companies", "crm-agent.services.c18h.net", { method: "POST", body, headers });
    const second = await fetchWorker("/v1/projects/api-proj/companies", "crm-agent.services.c18h.net", { method: "POST", body, headers });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await first.json();
    const b = await second.json();
    expect(a.id).toBe(b.id);
    const companies = await service.listCompanies(env.DB, "api-proj");
    expect(companies).toHaveLength(1);
  });

  it("rejects invalid transition", async () => {
    await service.createProject(env.DB, "T", "actor", "t");
    const prospect = await service.createProspect(env.DB, "t", "Lead", "actor");
    await expect(service.transitionProspect(env.DB, prospect.id as string, "replied", "actor")).rejects.toThrow(
      "Transition not allowed",
    );
  });

  it("dashboard api returns read model", async () => {
    await service.createProject(env.DB, "Dash", "dash:actor", "dash");
    const res = await fetchWorker("/api/dashboard", "crm.services.c18h.net");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.read_only).toBe(true);
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it("rejects write without Idempotency-Key", async () => {
    await service.createProject(env.DB, "Key", "key:actor", "key-proj");
    const res = await fetchWorker("/v1/projects/key-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dev-Service-Token": "svc-a" },
      body: JSON.stringify({ project: "key-proj", name: "No Key Co" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Idempotency-Key/i);
  });

  it("denies unauthenticated POST /mcp", async () => {
    const res = await fetchWorker("/mcp", "crm-agent.services.c18h.net", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for GET /mcp", async () => {
    const res = await fetchWorker("/mcp", "crm-agent.services.c18h.net", { method: "GET" });
    expect([401, 405]).toContain(res.status);
  });

  it("publishes oauth authorization server metadata", async () => {
    const res = await fetchWorker("/.well-known/oauth-authorization-server", "crm-agent.services.c18h.net");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authorization_endpoint).toContain("/authorize");
    expect(data.token_endpoint).toContain("/oauth/token");
    expect(data.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("rejects hostile Origin preflight without ACAO", async () => {
    const res = await fetchWorker("/mcp", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows trusted dashboard Origin preflight", async () => {
    const res = await fetchWorker("/mcp", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "https://crm.services.c18h.net",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://crm.services.c18h.net");
  });

  it("returns 400 for authorize without required params", async () => {
    const res = await fetchWorker("/authorize", "crm-agent.services.c18h.net");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/client_id/i);
  });

  it("allows loopback Origin on OAuth authorize preflight", async () => {
    const res = await fetchWorker("/authorize", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:53682",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:53682");
  });

  it("allows loopback Origin on OAuth token preflight", async () => {
    const res = await fetchWorker("/oauth/token", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8765",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8765");
  });

  it("rejects non-loopback HTTP Origin on OAuth authorize", async () => {
    const res = await fetchWorker("/authorize", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example:8080",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects loopback Origin on MCP preflight", async () => {
    const res = await fetchWorker("/mcp", "crm-agent.services.c18h.net", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:53682",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns 400 for callback without authorization code", async () => {
    const res = await fetchWorker("/callback", "crm-agent.services.c18h.net");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/authorization code/i);
    expect(body).not.toMatch(/access_token|id_token|Bearer/i);
  });

  it("returns 400 for callback with invalid state", async () => {
    const res = await fetchWorker(
      "/callback?code=fake&state=bad",
      "crm-agent.services.c18h.net",
      {},
      { COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" },
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/access_token|id_token|Bearer/i);
  });

  it("POST /authorize redirects to Access and clears CSRF cookie", async () => {
    const oauthEnv = {
      COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      ACCESS_CLIENT_ID: "test-access-client",
      ACCESS_AUTHORIZATION_URL:
        "https://example.cloudflareaccess.com/cdn-cgi/access/sso/oidc/test-access-client/authorization",
    };
    const reg = await fetchWorker(
      "/oauth/register",
      "crm-agent.services.c18h.net",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "test-mcp",
          redirect_uris: ["http://127.0.0.1:8765/callback"],
          token_endpoint_auth_method: "none",
        }),
      },
      oauthEnv,
    );
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const redirectUri = "http://127.0.0.1:8765/callback";
    const authorizeQuery = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: "crm:read",
    });
    const consent = await fetchWorker(
      `/authorize?${authorizeQuery}`,
      "crm-agent.services.c18h.net",
      {},
      oauthEnv,
    );
    expect(consent.status).toBe(200);
    const html = await consent.text();
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const state = html.match(/name="state" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();
    expect(state).toBeTruthy();
    const csrfCookie = consent.headers.get("Set-Cookie")?.match(/__Host-CSRF_TOKEN=([^;]+)/)?.[1];
    expect(csrfCookie).toBe(csrf);

    const post = await fetchWorker(
      "/authorize",
      "crm-agent.services.c18h.net",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-CSRF_TOKEN=${csrfCookie}`,
        },
        body: new URLSearchParams({ csrf_token: csrf!, state: state! }).toString(),
      },
      oauthEnv,
    );
    expect(post.status).toBe(302);
    expect(post.headers.get("Location")).toContain("example.cloudflareaccess.com");
    const cleared = post.headers.get("Set-Cookie") ?? "";
    expect(cleared).toMatch(/__Host-CSRF_TOKEN=/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(await post.text()).not.toMatch(/access_token|id_token|Bearer/i);
  });
});

describe("scopes", () => {
  it("read scope cannot imply write tools", async () => {
    expect(scopesAllowTool(["crm:read"], "crm_get_company")).toBe(true);
    expect(scopesAllowTool(["crm:read"], "crm_create_company")).toBe(false);
  });

  it("pipeline risks with create_tasks requires write scope", () => {
    expect(scopesAllowTool(["crm:read"], "crm_pipeline_risks", { create_tasks: true })).toBe(false);
    expect(scopesAllowTool(["crm:write"], "crm_pipeline_risks", { create_tasks: true })).toBe(true);
  });
});
