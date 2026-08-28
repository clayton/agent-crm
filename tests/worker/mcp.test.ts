import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { migrateLocal } from "../../worker/db";
import { createMcpServer, MCP_TOOL_DEFS, buildMcpHandler } from "../../worker/mcp";

type RegisteredTools = Record<string, { enabled?: boolean }>;

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
        allowedHostnames: ["crm-agent.services.c18h.net"],
        allowedOriginHostnames: ["crm.services.c18h.net"],
        responseMode: "auto",
        legacy: "stateless",
        maxSubscriptions: 0,
      }),
    ).not.toThrow();
    expect(typeof buildMcpHandler("crm-agent.services.c18h.net", "crm.services.c18h.net")).toBe("function");
  });
});
