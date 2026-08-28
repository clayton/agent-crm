import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";
import * as service from "./service";
import { CRMError } from "./service";
import { reserveIdempotencyKey, completeIdempotency } from "./db";
import { safeLog } from "./access";

const MAX_BODY = 256 * 1024;

export type ApiContext = {
  db: D1Database;
  actor: string;
  idempotencyKey?: string | null;
};

const projectSchema = z.string().min(1).max(128);
const limitSchema = z.number().int().min(1).max(1000).optional();

const operations: Record<
  string,
  {
    method: "GET" | "POST" | "PATCH";
    write: boolean;
    schema: z.ZodType;
    handler: (ctx: ApiContext, body: Record<string, unknown>) => Promise<unknown>;
  }
> = {
  "GET /v1/projects": {
    method: "GET",
    write: false,
    schema: z.object({}),
    handler: async (ctx) => service.listProjects(ctx.db),
  },
  "POST /v1/projects": {
    method: "POST",
    write: true,
    schema: z.object({
      name: z.string().min(1).max(256),
      slug: z.string().max(128).optional(),
      description: z.string().max(4096).optional(),
    }),
    handler: async (ctx, body) =>
      service.createProject(ctx.db, body.name as string, ctx.actor, body.slug as string | undefined, body.description as string | undefined),
  },
  "GET /v1/projects/:project/companies": {
    method: "GET",
    write: false,
    schema: z.object({ project: projectSchema, limit: limitSchema }),
    handler: async (ctx, body) => service.listCompanies(ctx.db, body.project as string, (body.limit as number) ?? 100),
  },
  "POST /v1/projects/:project/companies": {
    method: "POST",
    write: true,
    schema: z.object({
      project: projectSchema,
      name: z.string().min(1),
      domain: z.string().optional(),
      website: z.string().optional(),
      industry: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      custom: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (ctx, body) =>
      service.createCompany(ctx.db, body.project as string, body.name as string, ctx.actor, {
        domain: body.domain,
        website: body.website,
        industry: body.industry,
        description: body.description,
        tags: body.tags,
        custom: body.custom,
      }),
  },
  "GET /v1/companies/:id": {
    method: "GET",
    write: false,
    schema: z.object({ id: z.string().min(1) }),
    handler: async (ctx, body) => service.getCompany(ctx.db, body.id as string),
  },
  "PATCH /v1/companies/:id": {
    method: "PATCH",
    write: true,
    schema: z.object({ id: z.string().min(1), fields: z.record(z.string(), z.unknown()) }),
    handler: async (ctx, body) => service.updateCompany(ctx.db, body.id as string, ctx.actor, body.fields as Record<string, unknown>),
  },
  "GET /v1/projects/:project/prospects": {
    method: "GET",
    write: false,
    schema: z.object({ project: projectSchema, stage: z.string().optional(), owner: z.string().optional(), limit: limitSchema }),
    handler: async (ctx, body) =>
      service.listProspects(ctx.db, body.project as string, body.stage as string | undefined, body.owner as string | undefined, (body.limit as number) ?? 100),
  },
  "POST /v1/projects/:project/prospects": {
    method: "POST",
    write: true,
    schema: z.object({
      project: projectSchema,
      name: z.string().min(1),
      stage: z.string().optional(),
      contact_id: z.string().optional(),
      company_id: z.string().optional(),
      source: z.string().optional(),
      owner: z.string().optional(),
      fit_score: z.number().int().min(0).max(100).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      tags: z.array(z.string()).optional(),
      custom: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async (ctx, body) =>
      service.createProspect(ctx.db, body.project as string, body.name as string, ctx.actor, (body.stage as string) ?? "identified", {
        contact_id: body.contact_id,
        company_id: body.company_id,
        source: body.source,
        owner: body.owner,
        fit_score: body.fit_score,
        priority: body.priority,
        tags: body.tags,
        custom: body.custom,
      }),
  },
  "GET /v1/prospects/:id": {
    method: "GET",
    write: false,
    schema: z.object({ id: z.string().min(1) }),
    handler: async (ctx, body) => service.getProspect(ctx.db, body.id as string),
  },
  "PATCH /v1/prospects/:id": {
    method: "PATCH",
    write: true,
    schema: z.object({
      id: z.string().min(1),
      fields: z.record(z.string(), z.unknown()),
      expected_version: z.number().int().optional(),
    }),
    handler: async (ctx, body) =>
      service.updateProspect(ctx.db, body.id as string, ctx.actor, body.fields as Record<string, unknown>, body.expected_version as number | undefined),
  },
  "POST /v1/prospects/:id/transition": {
    method: "POST",
    write: true,
    schema: z.object({
      id: z.string().min(1),
      to_stage: z.string().min(1),
      reason: z.string().optional(),
      expected_version: z.number().int().optional(),
    }),
    handler: async (ctx, body) =>
      service.transitionProspect(
        ctx.db,
        body.id as string,
        body.to_stage as string,
        ctx.actor,
        body.reason as string | undefined,
        body.expected_version as number | undefined,
      ),
  },
  "POST /v1/projects/:project/notes": {
    method: "POST",
    write: true,
    schema: z.object({
      project: projectSchema,
      body: z.string().min(1),
      prospect_id: z.string().optional(),
      contact_id: z.string().optional(),
      company_id: z.string().optional(),
      kind: z.string().optional(),
      source_url: z.string().optional(),
    }),
    handler: async (ctx, body) =>
      service.addNote(
        ctx.db,
        body.project as string,
        ctx.actor,
        body.body as string,
        body.prospect_id as string | undefined,
        body.contact_id as string | undefined,
        body.company_id as string | undefined,
        (body.kind as string) ?? "general",
        body.source_url as string | undefined,
      ),
  },
  "POST /v1/projects/:project/tasks": {
    method: "POST",
    write: true,
    schema: z.object({
      project: projectSchema,
      title: z.string().min(1),
      due_at: z.string().optional(),
      prospect_id: z.string().optional(),
      assigned_to: z.string().optional(),
      description: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    }),
    handler: async (ctx, body) =>
      service.createTask(
        ctx.db,
        body.project as string,
        ctx.actor,
        body.title as string,
        body.due_at as string | undefined,
        body.prospect_id as string | undefined,
        undefined,
        undefined,
        body.description as string | undefined,
        (body.priority as string) ?? "normal",
        body.assigned_to as string | undefined,
      ),
  },
  "POST /v1/tasks/:id/complete": {
    method: "POST",
    write: true,
    schema: z.object({ id: z.string().min(1) }),
    handler: async (ctx, body) => service.completeTask(ctx.db, body.id as string, ctx.actor),
  },
  "GET /v1/projects/:project/pipeline": {
    method: "GET",
    write: false,
    schema: z.object({ project: projectSchema, include_terminal: z.boolean().optional() }),
    handler: async (ctx, body) => service.pipeline(ctx.db, body.project as string, Boolean(body.include_terminal)),
  },
  "GET /v1/projects/:project/forecast": {
    method: "GET",
    write: false,
    schema: z.object({ project: projectSchema, period: z.string().optional() }),
    handler: async (ctx, body) => service.forecast(ctx.db, body.project as string, body.period as string | undefined),
  },
  "GET /v1/projects/:project/search": {
    method: "GET",
    write: false,
    schema: z.object({ project: projectSchema, query: z.string().min(1), limit: limitSchema }),
    handler: async (ctx, body) => service.search(ctx.db, body.project as string, body.query as string, (body.limit as number) ?? 50),
  },
  "GET /v1/timeline/:entity_type/:entity_id": {
    method: "GET",
    write: false,
    schema: z.object({ entity_type: z.string(), entity_id: z.string(), limit: limitSchema }),
    handler: async (ctx, body) =>
      service.timeline(ctx.db, body.entity_type as string, body.entity_id as string, (body.limit as number) ?? 100),
  },
};

function matchRoute(pathname: string, method: string): { key: string; params: Record<string, string> } | null {
  const routes: [RegExp, string, string][] = [
    [/^\/v1\/projects$/, "GET /v1/projects", "GET"],
    [/^\/v1\/projects$/, "POST /v1/projects", "POST"],
    [/^\/v1\/projects\/([^/]+)\/companies$/, "GET /v1/projects/:project/companies", "GET"],
    [/^\/v1\/projects\/([^/]+)\/companies$/, "POST /v1/projects/:project/companies", "POST"],
    [/^\/v1\/companies\/([^/]+)$/, "GET /v1/companies/:id", "GET"],
    [/^\/v1\/companies\/([^/]+)$/, "PATCH /v1/companies/:id", "PATCH"],
    [/^\/v1\/projects\/([^/]+)\/prospects$/, "GET /v1/projects/:project/prospects", "GET"],
    [/^\/v1\/projects\/([^/]+)\/prospects$/, "POST /v1/projects/:project/prospects", "POST"],
    [/^\/v1\/prospects\/([^/]+)$/, "GET /v1/prospects/:id", "GET"],
    [/^\/v1\/prospects\/([^/]+)$/, "PATCH /v1/prospects/:id", "PATCH"],
    [/^\/v1\/prospects\/([^/]+)\/transition$/, "POST /v1/prospects/:id/transition", "POST"],
    [/^\/v1\/projects\/([^/]+)\/notes$/, "POST /v1/projects/:project/notes", "POST"],
    [/^\/v1\/projects\/([^/]+)\/tasks$/, "POST /v1/projects/:project/tasks", "POST"],
    [/^\/v1\/tasks\/([^/]+)\/complete$/, "POST /v1/tasks/:id/complete", "POST"],
    [/^\/v1\/projects\/([^/]+)\/pipeline$/, "GET /v1/projects/:project/pipeline", "GET"],
    [/^\/v1\/projects\/([^/]+)\/forecast$/, "GET /v1/projects/:project/forecast", "GET"],
    [/^\/v1\/projects\/([^/]+)\/search$/, "GET /v1/projects/:project/search", "GET"],
    [/^\/v1\/timeline\/([^/]+)\/([^/]+)$/, "GET /v1/timeline/:entity_type/:entity_id", "GET"],
  ];
  for (const [re, key, m] of routes) {
    if (m !== method) continue;
    const match = pathname.match(re);
    if (!match) continue;
    const params: Record<string, string> = {};
    if (key.includes(":project")) params.project = match[1];
    if (key.includes(":id") && !key.includes("entity")) params.id = match[1];
    if (key.includes(":entity_type")) {
      params.entity_type = match[1];
      params.entity_id = match[2];
    }
    return { key, params };
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(error: unknown): Response {
  const message = error instanceof CRMError ? error.message : "Internal server error";
  const status = error instanceof CRMError ? 400 : 500;
  if (!(error instanceof CRMError)) safeLog("api_error", { type: "unexpected" });
  return jsonResponse({ error: message, type: error instanceof CRMError ? "CRMError" : "Error" }, status);
}

export async function handleApiRequest(request: Request, ctx: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/json") && request.method !== "GET") {
    return jsonResponse({ error: "Content-Type must be application/json" }, 415);
  }
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > MAX_BODY) {
    return jsonResponse({ error: "Request body too large" }, 413);
  }

  const matched = matchRoute(url.pathname, request.method);
  if (!matched) return jsonResponse({ error: "Not found" }, 404);
  const op = operations[matched.key];
  if (!op || op.method !== request.method) return jsonResponse({ error: "Not found" }, 404);

  let body: Record<string, unknown> = { ...matched.params };
  if (request.method !== "GET") {
    try {
      body = { ...body, ...(await request.json()) as Record<string, unknown> };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
  } else {
    for (const [k, v] of url.searchParams.entries()) {
      if (k === "limit" || k === "fit_score" || k === "expected_version") body[k] = Number(v);
      else if (k === "include_terminal") body[k] = v === "true";
      else body[k] = v;
    }
  }

  const parsed = op.schema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Validation failed", details: parsed.error.flatten() }, 422);
  }

  try {
    if (op.write) {
      if (!ctx.idempotencyKey) {
        return jsonResponse({ error: "Idempotency-Key header required" }, 400);
      }
      const reserved = await reserveIdempotencyKey(ctx.db, ctx.idempotencyKey, ctx.actor, matched.key);
      if (reserved !== "reserved") {
        return jsonResponse(JSON.parse(reserved.response_json));
      }
    }

    const result = await op.handler(ctx, parsed.data as Record<string, unknown>);
    if (op.write && ctx.idempotencyKey) {
      await completeIdempotency(ctx.db, ctx.idempotencyKey, result);
    }
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Idempotency-Key")) {
      return jsonResponse({ error: error.message }, 409);
    }
    return errorResponse(error);
  }
}
