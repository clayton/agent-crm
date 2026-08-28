import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod/v4";
import { migrateLocal } from "../../worker/db";
import { createMcpServer, MCP_TOOL_DEFS, buildMcpHandler } from "../../worker/mcp";
import * as service from "../../worker/service";

type RegisteredTools = Record<string, { enabled?: boolean }>;

const AGENT_HOST = "crm-agent.services.c18h.net";
const DASHBOARD_HOST = "crm.services.c18h.net";

function mcpHandler() {
  return createMcpHandler(() => createMcpServer(env.DB), {
    route: "/mcp",
    allowedHostnames: [AGENT_HOST],
    allowedOriginHostnames: [DASHBOARD_HOST],
    responseMode: "json",
    legacy: "stateless",
    maxSubscriptions: 0,
  });
}

async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as Record<string, unknown>;
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`Unexpected MCP response: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
}

async function postMcp(body: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Host: AGENT_HOST,
  };
  return mcpHandler().fetch(
    new Request(`http://${AGENT_HOST}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("mcp tool registration", () => {
  beforeEach(async () => {
    await migrateLocal(env.DB);
  });

  it("createMcpServer registers all tools without throwing", () => {
    expect(() => createMcpServer(env.DB)).not.toThrow();
  });

  it("registers the full CRM tool catalog for tools/list", () => {
    const server = createMcpServer(env.DB);
    const registered = server as unknown as { _registeredTools: RegisteredTools };
    const names = Object.entries(registered._registeredTools)
      .filter(([, tool]) => tool.enabled !== false)
      .map(([name]) => name)
      .sort();
    expect(names.length).toBe(MCP_TOOL_DEFS.length);
    expect(names).toEqual([...MCP_TOOL_DEFS.map((t) => t.name)].sort());
  });

  it("buildMcpHandler server factory initializes without throwing", () => {
    expect(() =>
      createMcpHandler(() => createMcpServer(env.DB), {
        route: "/mcp",
        allowedHostnames: [AGENT_HOST],
        allowedOriginHostnames: [DASHBOARD_HOST],
        responseMode: "auto",
        legacy: "stateless",
        maxSubscriptions: 0,
      }),
    ).not.toThrow();
    expect(typeof buildMcpHandler(AGENT_HOST, DASHBOARD_HOST)).toBe("function");
  });

  it("each tool raw shape converts to JSON Schema", () => {
    for (const tool of MCP_TOOL_DEFS) {
      expect(() => z.toJSONSchema(z.object(tool.schema)), tool.name).not.toThrow();
    }
  });

  it("handler tools/list serializes schemas and returns exactly 35 tools", async () => {
    const init = await postMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const initBody = await readJsonRpc(init);
    expect(initBody.error).toBeUndefined();

    await postMcp({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const list = await postMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(list.status).toBe(200);
    const body = await readJsonRpc(list);
    expect(body.error).toBeUndefined();
    const tools = (body.result as { tools?: Array<{ name: string; inputSchema?: unknown }> })?.tools;
    expect(tools?.length).toBe(35);
    const names = tools!.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOL_DEFS.map((t) => t.name)].sort());
    for (const tool of tools!) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe("object");
    }
    const updateTools = tools!.filter((t) => t.name.startsWith("crm_update_"));
    expect(updateTools.length).toBe(3);
    for (const tool of updateTools) {
      const schema = tool.inputSchema as { properties?: { fields?: { additionalProperties?: unknown } } };
      expect(schema.properties?.fields?.additionalProperties).toBeDefined();
    }
  });

  it("createCompany/createContact/createProspect strip route keys from service fields", async () => {
    await service.createProject(env.DB, "MCP", "mcp:actor", "mcp-proj");
    const actor = "mcp:mcp:actor";

    const createCompany = MCP_TOOL_DEFS.find((t) => t.name === "crm_create_company")!;
    const company = (await createCompany.handler(env.DB, actor, {
      project: "mcp-proj",
      name: "Acme MCP",
      linkedin_url: "https://linkedin.com/company/acme",
    })) as Record<string, unknown>;
    expect(company.name).toBe("Acme MCP");
    expect(company.linkedin_url).toBe("https://linkedin.com/company/acme");

    const createContact = MCP_TOOL_DEFS.find((t) => t.name === "crm_create_contact")!;
    const contact = (await createContact.handler(env.DB, actor, {
      project: "mcp-proj",
      full_name: "Jane Doe",
      email: "jane@acme.test",
    })) as Record<string, unknown>;
    expect(contact.full_name).toBe("Jane Doe");
    expect(contact.email).toBe("jane@acme.test");

    const createProspect = MCP_TOOL_DEFS.find((t) => t.name === "crm_create_prospect")!;
    const prospect = (await createProspect.handler(env.DB, actor, {
      project: "mcp-proj",
      name: "Lead MCP",
      stage: "identified",
      source_url: "https://example.com/lead",
    })) as Record<string, unknown>;
    expect(prospect.name).toBe("Lead MCP");
    expect(prospect.source_url).toBe("https://example.com/lead");
    expect(prospect.stage).toBe("identified");
  });
});
