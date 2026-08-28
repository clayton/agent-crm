import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod/v4";
import type { D1Database } from "@cloudflare/workers-types";
import type { ExecutionContext } from "@cloudflare/workers-types";
import * as service from "./service";
import { CRMError } from "./service";
import { scopesAllowTool } from "./scopes";
import { BodyTooLargeError, requestWithBoundedBody } from "./body-limit";

export type McpAuth = {
  actor: string;
  scopes: string[];
};

type ToolHandler = (db: D1Database, actor: string, args: Record<string, unknown>) => Promise<unknown>;

const toolDefs: Array<{
  name: string;
  description: string;
  read: boolean;
  schema: z.ZodRawShape;
  handler: ToolHandler;
}> = [
  { name: "crm_projects", description: "List CRM projects.", read: true, schema: {}, handler: (db) => service.listProjects(db) },
  {
    name: "crm_create_project",
    description: "Create an isolated CRM project with the default cold-outreach pipeline.",
    read: false,
    schema: { name: z.string(), slug: z.string().optional(), description: z.string().optional() },
    handler: (db, actor, a) => service.createProject(db, a.name as string, actor, a.slug as string | undefined, a.description as string | undefined),
  },
  {
    name: "crm_create_company",
    description: "Create a company in a project.",
    read: false,
    schema: { project: z.string(), name: z.string(), domain: z.string().optional(), website: z.string().optional(), linkedin_url: z.string().optional(), industry: z.string().optional(), employee_count: z.number().optional(), annual_revenue: z.string().optional(), location: z.string().optional(), description: z.string().optional() },
    handler: (db, actor, a) => service.createCompany(db, a.project as string, a.name as string, actor, a),
  },
  { name: "crm_get_company", description: "Get a company dossier.", read: true, schema: { company_id: z.string() }, handler: (db, _a, a) => service.getCompany(db, a.company_id as string) },
  { name: "crm_list_companies", description: "List companies within one project.", read: true, schema: { project: z.string(), limit: z.number().optional() }, handler: (db, _a, a) => service.listCompanies(db, a.project as string, (a.limit as number) ?? 100) },
  { name: "crm_update_company", description: "Update company profile fields.", read: false, schema: { company_id: z.string(), fields: z.record(z.string(), z.json()) }, handler: (db, actor, a) => service.updateCompany(db, a.company_id as string, actor, a.fields as Record<string, unknown>) },
  { name: "crm_create_contact", description: "Create a B2B contact.", read: false, schema: { project: z.string(), full_name: z.string(), company_id: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), title: z.string().optional() }, handler: (db, actor, a) => service.createContact(db, a.project as string, a.full_name as string, actor, a) },
  { name: "crm_get_contact", description: "Get a contact dossier.", read: true, schema: { contact_id: z.string() }, handler: (db, _a, a) => service.getContact(db, a.contact_id as string) },
  { name: "crm_list_contacts", description: "List contacts.", read: true, schema: { project: z.string(), limit: z.number().optional() }, handler: (db, _a, a) => service.listContacts(db, a.project as string, (a.limit as number) ?? 100) },
  { name: "crm_update_contact", description: "Update contact fields.", read: false, schema: { contact_id: z.string(), fields: z.record(z.string(), z.json()) }, handler: (db, actor, a) => service.updateContact(db, a.contact_id as string, actor, a.fields as Record<string, unknown>) },
  { name: "crm_create_prospect", description: "Create an outreach prospect.", read: false, schema: { project: z.string(), name: z.string(), stage: z.string().optional(), contact_id: z.string().optional(), company_id: z.string().optional(), source: z.string().optional(), source_url: z.string().optional(), owner: z.string().optional(), fit_score: z.number().optional(), pain_points: z.string().optional(), needs: z.string().optional(), budget: z.string().optional(), authority: z.string().optional(), timing: z.string().optional(), qualification_notes: z.string().optional(), amount: z.number().optional(), currency: z.string().optional(), expected_close_at: z.string().optional(), forecast_category: z.string().optional(), probability: z.number().optional(), next_step: z.string().optional(), next_step_due_at: z.string().optional() }, handler: (db, actor, a) => service.createProspect(db, a.project as string, a.name as string, actor, (a.stage as string) ?? "identified", a) },
  { name: "crm_get_prospect", description: "Get a prospect dossier.", read: true, schema: { prospect_id: z.string() }, handler: (db, _a, a) => service.getProspect(db, a.prospect_id as string) },
  { name: "crm_list_prospects", description: "List prospects.", read: true, schema: { project: z.string(), stage: z.string().optional(), owner: z.string().optional(), limit: z.number().optional() }, handler: (db, _a, a) => service.listProspects(db, a.project as string, a.stage as string | undefined, a.owner as string | undefined, (a.limit as number) ?? 100) },
  { name: "crm_update_prospect", description: "Update prospect fields.", read: false, schema: { prospect_id: z.string(), fields: z.record(z.string(), z.json()), expected_version: z.number().optional() }, handler: (db, actor, a) => service.updateProspect(db, a.prospect_id as string, actor, a.fields as Record<string, unknown>, a.expected_version as number | undefined) },
  { name: "crm_transition_prospect", description: "Move a prospect through pipeline.", read: false, schema: { prospect_id: z.string(), to_stage: z.string(), reason: z.string().optional(), expected_version: z.number().optional() }, handler: (db, actor, a) => service.transitionProspect(db, a.prospect_id as string, a.to_stage as string, actor, a.reason as string | undefined, a.expected_version as number | undefined) },
  { name: "crm_qualify_opportunity", description: "Make a prospect forecastable.", read: false, schema: { prospect_id: z.string(), amount: z.number(), expected_close_at: z.string(), next_step: z.string(), currency: z.string().optional(), forecast_category: z.string().optional(), probability: z.number().optional(), next_step_due_at: z.string().optional(), expected_version: z.number().optional() }, handler: (db, actor, a) => service.qualifyOpportunity(db, a.prospect_id as string, actor, a.amount as number, a.expected_close_at as string, a.next_step as string, a.currency as string | undefined, (a.forecast_category as string) ?? "pipeline", a.probability as number | undefined, a.next_step_due_at as string | undefined, a.expected_version as number | undefined) },
  { name: "crm_add_note", description: "Attach a note.", read: false, schema: { project: z.string(), body: z.string(), prospect_id: z.string().optional(), contact_id: z.string().optional(), company_id: z.string().optional(), kind: z.string().optional(), source_url: z.string().optional() }, handler: (db, actor, a) => service.addNote(db, a.project as string, actor, a.body as string, a.prospect_id as string | undefined, a.contact_id as string | undefined, a.company_id as string | undefined, (a.kind as string) ?? "general", a.source_url as string | undefined) },
  { name: "crm_create_task", description: "Create a follow-up task.", read: false, schema: { project: z.string(), title: z.string(), due_at: z.string().optional(), prospect_id: z.string().optional(), contact_id: z.string().optional(), company_id: z.string().optional(), assigned_to: z.string().optional(), description: z.string().optional(), priority: z.string().optional() }, handler: (db, actor, a) => service.createTask(db, a.project as string, actor, a.title as string, a.due_at as string | undefined, a.prospect_id as string | undefined, a.contact_id as string | undefined, a.company_id as string | undefined, a.description as string | undefined, (a.priority as string) ?? "normal", a.assigned_to as string | undefined) },
  { name: "crm_complete_task", description: "Complete a task.", read: false, schema: { task_id: z.string() }, handler: (db, actor, a) => service.completeTask(db, a.task_id as string, actor) },
  { name: "crm_log_interaction", description: "Log an interaction.", read: false, schema: { project: z.string(), channel: z.string(), direction: z.string(), summary: z.string(), prospect_id: z.string().optional(), contact_id: z.string().optional(), company_id: z.string().optional(), outcome: z.string().optional(), occurred_at: z.string().optional(), external_ref: z.string().optional() }, handler: (db, actor, a) => service.logInteraction(db, a.project as string, actor, a.channel as string, a.direction as string, a.summary as string, a.prospect_id as string | undefined, a.contact_id as string | undefined, a.company_id as string | undefined, a.outcome as string | undefined, a.occurred_at as string | undefined, a.external_ref as string | undefined) },
  { name: "crm_list_interactions", description: "List interactions.", read: true, schema: { project: z.string(), prospect_id: z.string().optional(), channel: z.string().optional(), limit: z.number().optional() }, handler: (db, _a, a) => service.listInteractions(db, a.project as string, a.prospect_id as string | undefined, a.channel as string | undefined, (a.limit as number) ?? 100) },
  { name: "crm_inbox", description: "Return overdue, due-soon, and stale work.", read: true, schema: { project: z.string().optional(), due_within_days: z.number().optional(), stale_days: z.number().optional(), limit: z.number().optional() }, handler: (db, actor, a) => service.inbox(db, a.project as string | undefined, actor, (a.due_within_days as number) ?? 7, (a.stale_days as number) ?? 30, (a.limit as number) ?? 100) },
  { name: "crm_next_actions", description: "Return ranked actions.", read: true, schema: { project: z.string(), limit: z.number().optional(), stale_days: z.number().optional(), mode: z.string().optional(), time_budget: z.number().optional() }, handler: (db, actor, a) => service.nextActions(db, a.project as string, actor, (a.limit as number) ?? 5, a.stale_days as number | undefined, (a.mode as string) ?? "balanced", a.time_budget as number | undefined) },
  { name: "crm_pipeline", description: "Return pipeline grouped by stage.", read: true, schema: { project: z.string(), include_terminal: z.boolean().optional() }, handler: (db, _a, a) => service.pipeline(db, a.project as string, Boolean(a.include_terminal)) },
  { name: "crm_bootstrap", description: "Configure project readiness.", read: false, schema: { project: z.string(), target_amount: z.number().optional(), target_period: z.string().optional(), currency: z.string().optional(), default_owner: z.string().optional(), stale_days: z.number().optional() }, handler: (db, actor, a) => service.bootstrap(db, a.project as string, actor, a.target_amount as number | undefined, a.target_period as string | undefined, a.currency as string | undefined, a.default_owner as string | undefined, a.stale_days as number | undefined) },
  { name: "crm_forecast", description: "Forecast revenue.", read: true, schema: { project: z.string(), period: z.string().optional() }, handler: (db, _a, a) => service.forecast(db, a.project as string, a.period as string | undefined) },
  { name: "crm_conversions", description: "Historical conversion rates.", read: true, schema: { project: z.string() }, handler: (db, _a, a) => service.conversionReport(db, a.project as string) },
  { name: "crm_cro_review", description: "Adversarial revenue review.", read: true, schema: { project: z.string(), period: z.string().optional() }, handler: (db, _a, a) => service.croReview(db, a.project as string, a.period as string | undefined) },
  { name: "crm_pipeline_risks", description: "Find pipeline risks.", read: true, schema: { project: z.string(), create_tasks: z.boolean().optional(), stale_days: z.number().optional() }, handler: (db, actor, a) => service.pipelineRisks(db, a.project as string, Boolean(a.create_tasks), a.create_tasks ? actor : undefined, a.stale_days as number | undefined) },
  { name: "crm_sdr_queue", description: "Prioritize top-of-funnel prospects.", read: true, schema: { project: z.string(), limit: z.number().optional() }, handler: (db, _a, a) => service.sdrQueue(db, a.project as string, (a.limit as number) ?? 25) },
  { name: "crm_experiment_report", description: "Report experiment cohort outcomes.", read: true, schema: { project: z.string(), experiment_id: z.string() }, handler: (db, _a, a) => service.experimentReport(db, a.project as string, a.experiment_id as string) },
  { name: "crm_research_brief", description: "Research brief for a prospect.", read: true, schema: { prospect_id: z.string() }, handler: (db, _a, a) => service.researchBrief(db, a.prospect_id as string) },
  { name: "crm_outreach_brief", description: "Outreach brief for a prospect.", read: true, schema: { prospect_id: z.string() }, handler: (db, _a, a) => service.outreachBrief(db, a.prospect_id as string) },
  { name: "crm_search", description: "Search CRM records.", read: true, schema: { project: z.string(), query: z.string(), limit: z.number().optional() }, handler: (db, _a, a) => service.search(db, a.project as string, a.query as string, (a.limit as number) ?? 50) },
  { name: "crm_timeline", description: "Read activity timeline.", read: true, schema: { entity_type: z.string(), entity_id: z.string(), limit: z.number().optional() }, handler: (db, _a, a) => service.timeline(db, a.entity_type as string, a.entity_id as string, (a.limit as number) ?? 100) },
];

function authFromContext(): McpAuth {
  const auth = getMcpAuthContext();
  const props = (auth?.props ?? {}) as Record<string, unknown>;
  const scopesRaw = props.scope ?? props.scopes ?? "";
  const scopes = typeof scopesRaw === "string" ? scopesRaw.split(/\s+/).filter(Boolean) : [];
  const email = props.email ? String(props.email) : undefined;
  const clientId = props.clientId ? String(props.clientId) : "unknown";
  const actor = email ? `mcp:${email}` : `mcp:${clientId}`;
  return { actor, scopes };
}

type ToolInputSchema = NonNullable<Parameters<McpServer["registerTool"]>[1]["inputSchema"]>;

function registerTools(server: McpServer, db: D1Database): void {
  for (const tool of toolDefs) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.schema) as unknown as ToolInputSchema },
      async (args: Record<string, unknown>) => {
        const auth = authFromContext();
        if (!scopesAllowTool(auth.scopes, tool.name, args)) {
          throw new CRMError("Insufficient OAuth scope for this tool.");
        }
        const result = await tool.handler(db, auth.actor, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
}

export function createMcpServer(db: D1Database): McpServer {
  const server = new McpServer({ name: "agent-crm", version: "1.0.0" });
  registerTools(server, db);
  return server;
}

export function buildMcpHandler(agentHost: string, dashboardHost: string) {
  return async (request: Request, env: { DB: D1Database }, ctx: ExecutionContext) => {
    const handler = createMcpHandler(() => createMcpServer(env.DB), {
      route: "/mcp",
      allowedHostnames: [agentHost],
      allowedOriginHostnames: [dashboardHost],
      responseMode: "auto",
      legacy: "stateless",
      maxSubscriptions: 0,
    });
    if (request.method === "POST" && request.body) {
      try {
        const bounded = await requestWithBoundedBody(request);
        return handler(bounded, env, ctx);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return new Response(JSON.stringify({ error: "Request body too large" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw error;
      }
    }
    return handler(request, env, ctx);
  };
}

export { toolDefs as MCP_TOOL_DEFS };
