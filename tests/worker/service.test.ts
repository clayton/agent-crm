import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../worker/index";
import { migrateLocal, reserveIdempotencyKey } from "../../worker/db";
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

  it("dashboard api omits eager prospect_details", async () => {
    await service.createProject(env.DB, "Lazy", "lazy:actor", "lazy");
    const p1 = await service.createProspect(env.DB, "lazy", "Lead One", "lazy:actor");
    const p2 = await service.createProspect(env.DB, "lazy", "Lead Two", "lazy:actor");
    await service.addNote(env.DB, "lazy", "lazy:actor", "Note one", p1.id as string);
    await service.addNote(env.DB, "lazy", "lazy:actor", "Note two", p2.id as string);
    const res = await fetchWorker("/api/dashboard?project=lazy", "crm.services.c18h.net");
    expect(res.status).toBe(200);
    const data = await res.json();
    const project = data.projects[0];
    expect(project.prospect_details).toBeUndefined();
    expect(project.pipeline.total_prospects).toBe(2);
  });

  it("dashboard prospect detail endpoint returns dossier", async () => {
    await service.createProject(env.DB, "Det", "det:actor", "det");
    const prospect = await service.createProspect(env.DB, "det", "Detail Lead", "det:actor");
    await service.addNote(env.DB, "det", "det:actor", "Detail note", prospect.id as string, undefined, undefined, "research");
    const res = await fetchWorker(
      `/api/dashboard/prospects/${prospect.id}`,
      "crm.services.c18h.net",
    );
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.name).toBe("Detail Lead");
    expect(detail.notes).toHaveLength(1);
    expect(Array.isArray(detail.timeline)).toBe(true);
  });

  it("dashboard prospect detail returns 400 for missing id", async () => {
    const res = await fetchWorker(
      "/api/dashboard/prospects/missing-prospect-id",
      "crm.services.c18h.net",
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("CRMError");
    expect(body.error).toContain("Prospect not found");
  });

  it("api createTask accepts title-only body", async () => {
    await service.createProject(env.DB, "Task", "task:actor", "task-proj");
    const body = JSON.stringify({ project: "task-proj", title: "Follow up" });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-task-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const res = await fetchWorker("/v1/projects/task-proj/tasks", "crm-agent.services.c18h.net", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.title).toBe("Follow up");
    expect(task.priority).toBe("normal");
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

  it("dashboard returns 401 when Access is required", async () => {
    const res = await fetchWorker("/api/dashboard", "crm.services.c18h.net", {}, { DEV_SKIP_ACCESS: "false" });
    expect(res.status).toBe(401);
  });

  it("v1 returns 401 when Access is required", async () => {
    const res = await fetchWorker("/v1/projects", "crm-agent.services.c18h.net", {}, { DEV_SKIP_ACCESS: "false" });
    expect(res.status).toBe(401);
  });

  it("rejects measured body over 256 KiB even when Content-Length is small", async () => {
    await service.createProject(env.DB, "Body", "body:actor", "body-proj");
    const payload = JSON.stringify({ project: "body-proj", name: "Big Co", padding: "x".repeat(260 * 1024) });
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": "64",
      "Idempotency-Key": "idem-body-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const res = await fetchWorker("/v1/projects/body-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      body: payload,
      headers,
    });
    expect(res.status).toBe(413);
  });

  it("accepts small valid write body", async () => {
    await service.createProject(env.DB, "Small", "small:actor", "small-proj");
    const body = JSON.stringify({
      project: "small-proj",
      name: "Small Co",
      linkedin_url: "https://linkedin.com/company/small",
      employee_count: 12,
    });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-small-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const res = await fetchWorker("/v1/projects/small-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
    const company = await res.json();
    expect(company.linkedin_url).toBe("https://linkedin.com/company/small");
  });

  it("rejects strict schema unknown fields on company create", async () => {
    await service.createProject(env.DB, "Strict", "strict:actor", "strict-proj");
    const body = JSON.stringify({ project: "strict-proj", name: "Co", unknown_field: true });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-strict-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const res = await fetchWorker("/v1/projects/strict-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(422);
  });

  it("releases idempotency key after failed write so retry succeeds", async () => {
    await service.createProject(env.DB, "Idem", "idem:actor", "idem-proj");
    const badBody = JSON.stringify({ project: "idem-proj", title: "Task", prospect_id: "missing-prospect" });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-retry-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const fail = await fetchWorker("/v1/projects/idem-proj/tasks", "crm-agent.services.c18h.net", {
      method: "POST",
      body: badBody,
      headers,
    });
    expect(fail.status).toBe(400);
    const ok = await fetchWorker("/v1/projects/idem-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      body: JSON.stringify({ project: "idem-proj", name: "Retry Co" }),
      headers,
    });
    expect(ok.status).toBe(200);
  });

  it("does not release in-progress idempotency row owned by another request", async () => {
    await service.createProject(env.DB, "InProg", "inprog:actor", "inprog-proj");
    await reserveIdempotencyKey(
      env.DB,
      "idem-in-progress-1",
      "api:svc-a",
      "POST /v1/projects/:project/companies",
    );
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "idem-in-progress-1",
      "X-Dev-Service-Token": "svc-a",
    };
    const res = await fetchWorker("/v1/projects/inprog-proj/companies", "crm-agent.services.c18h.net", {
      method: "POST",
      body: JSON.stringify({ project: "inprog-proj", name: "Should Not Win" }),
      headers,
    });
    expect(res.status).toBe(409);
    const row = await env.DB.prepare(
      "SELECT response_json FROM idempotency_keys WHERE key=?",
    ).bind("idem-in-progress-1").first<{ response_json: string }>();
    expect(row?.response_json).toBe("");
  });

  it("consent page escapes client name and id", async () => {
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
          client_name: "Evil<script>alert(1)</script>",
          redirect_uris: ["http://127.0.0.1:8765/callback"],
          token_endpoint_auth_method: "none",
        }),
      },
      oauthEnv,
    );
    expect(reg.status).toBe(201);
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    const authorizeQuery = new URLSearchParams({
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:8765/callback",
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "crm:read",
    });
    const consent = await fetchWorker(
      `/authorize?${authorizeQuery}`,
      "crm-agent.services.c18h.net",
      {},
      oauthEnv,
    );
    const html = await consent.text();
    expect(html).toContain("Evil&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(escapeHtml(clientId));
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

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
