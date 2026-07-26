# Agent CRM

An open-source CRM built for agents, not dashboards.

Agent CRM keeps track of companies, contacts, prospects, research, follow-ups, and sales-pipeline state like a traditional CRM. The difference is intentional: there is no graphical interface. Agents work with it directly through a JSON CLI or typed MCP tools.

Data stays local in SQLite, and both interfaces use the same application service.

Learn more at [crmemento.com](https://crmemento.com).

## Why agent-first?

Most CRMs are designed around humans clicking through screens. Agent CRM is designed around agents reading structured context, taking explicit actions, and leaving an auditable trail.

- **No interface:** Use the CLI or MCP tools.
- **Local by default:** SQLite is the source of truth.
- **Pipeline-aware:** Track prospects from identification through won, lost, or do-not-contact.
- **Built for coordination:** Project isolation, immutable activity history, and optimistic version checks help multiple agents work safely.
- **System of record only:** It logs outreach, but never sends messages or contacts anyone.

## Quick start

Agent CRM requires Python 3.11 or later.

```bash
git clone https://github.com/clayton/agent-crm.git
cd agent-crm

export CRM_ACTOR=codex
./bin/crm init
./bin/crm project create "My Pipeline" --slug pipeline
./bin/crm project list
```

All CLI output is JSON. Writes require an actor through `--actor` or `CRM_ACTOR`.

By default, data is stored at `~/.codex/memories/agent-crm/crm.sqlite3`. Set `CRM_DB=/path/to/crm.sqlite3` or use the global `--db` option to choose another location.

## What it tracks

- Projects that isolate separate pipelines
- Companies and contacts
- Prospects and pipeline stages
- Sourced research notes
- Follow-up tasks and due dates
- Email, call, message, and meeting logs
- Immutable activity history

The default pipeline is:

```text
identified → researching → qualified → ready_to_contact
→ contacted → replied → meeting_booked → won
```

Every non-terminal stage can also exit to `lost`, `not_a_fit`, or `do_not_contact`.

## MCP server

Install the optional official MCP Python SDK:

```bash
uv sync --extra mcp
uv run crm-mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "agent-crm": {
      "command": "uv",
      "args": ["--directory", "/absolute/path/to/agent-crm", "run", "crm-mcp"]
    }
  }
}
```

The server exposes typed tools for projects, companies, contacts, prospects, pipeline transitions, notes, tasks, inbox queries, search, and timelines.

## Agent skill

The reusable agent skill lives in [`skill/agent-crm`](skill/agent-crm). Symlink or copy that directory into your agent’s skills directory, then configure the skill to point to your checkout.

## Development

The core test suite has no third-party dependencies:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## License

[MIT](LICENSE)
