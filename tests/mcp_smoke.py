"""Protocol-level smoke test for the optional MCP server."""

from __future__ import annotations

import asyncio
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def smoke() -> None:
    server = Path(__file__).parents[1] / ".venv" / "bin" / "crm-mcp"
    async with stdio_client(StdioServerParameters(command=str(server))) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            names = {tool.name for tool in result.tools}
            expected = {"crm_projects", "crm_create_prospect", "crm_transition_prospect", "crm_inbox",
                        "crm_search", "crm_log_interaction", "crm_update_company", "crm_update_contact"}
            missing = expected - names
            if missing:
                raise AssertionError(f"Missing MCP tools: {sorted(missing)}")
            projects = await session.call_tool("crm_projects", {})
            if projects.isError:
                raise AssertionError("crm_projects returned an MCP error")
            print(f"MCP handshake OK: {len(names)} tools")


if __name__ == "__main__":
    asyncio.run(smoke())
