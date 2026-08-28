# Agent CRM

An open-source CRM built for agents, with a read-only dashboard for humans.

Agent CRM keeps track of companies, contacts, prospects, opportunities, research, follow-ups, forecasts, and sales-pipeline state. It also points out unsupported forecasts and work that is falling through the cracks. Agents operate it directly through a JSON CLI or typed MCP tools. Humans can inspect the same data through an optional local dashboard that has no write controls or mutation endpoints.

Data stays local in SQLite, and both interfaces use the same application service.

Learn more at [crmemento.com](https://crmemento.com).

## Why agent-first?

Most CRMs are designed around humans clicking through screens. Agent CRM is designed around agents reading structured context, taking explicit actions, and leaving an auditable trail.

- **Agent-operated:** Use the CLI or MCP tools for every change.
- **Human-visible:** Inspect pipeline health through a local, read-only dashboard.
- **Local by default:** SQLite is the source of truth.
- **Pipeline-aware:** Track prospects from identification through won, lost, or do-not-contact.
- **Revenue-aware:** Forecast weighted, best-case, commit, and closed-won revenue.
- **Constructively skeptical:** A critical CRO review challenges weak assumptions with record-level evidence.
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
- Forecastable opportunities, amounts, close dates, probabilities, and next steps
- Sourced research notes
- Follow-up tasks and due dates
- Email, call, message, and meeting logs
- Immutable activity history
- Revenue targets and re-runnable project readiness checks

The default pipeline is:

```text
identified → researching → qualified → ready_to_contact
→ contacted → replied → meeting_booked → won
```

Every non-terminal stage can also exit to `lost`, `not_a_fit`, or `do_not_contact`.

## Read-only human dashboard

Run the live dashboard locally, then open the printed URL:

```bash
./bin/crm dashboard serve
# http://127.0.0.1:8765

# Limit the view to one project or include closed stages
./bin/crm dashboard serve pipeline --include-terminal
```

The server binds to `127.0.0.1` by default, opens SQLite in read-only mode, and exposes only HTTP `GET` routes. It refreshes from the source database whenever dashboard data is requested. There are no forms, drag-and-drop mutations, or editing endpoints.

For a portable point-in-time view, export a self-contained HTML file:

```bash
./bin/crm dashboard export --output crm-dashboard.html
./bin/crm dashboard export pipeline --output pipeline.html
```

The live and exported modes share the same interface: an all-project overview, attention queue, risk summary, revenue metrics, Kanban pipeline, and read-only prospect details with tasks, notes, interactions, and activity.

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

Two agent-oriented read commands make common reviews direct:

```bash
# A ranked queue of 3-5 tasks and follow-ups
./bin/crm next-actions pipeline

# Prospects grouped in configured sales-stage order
./bin/crm pipeline pipeline
./bin/crm pipeline pipeline --include-terminal
```

The equivalent MCP tools are `crm_next_actions` and `crm_pipeline`. They return structured data so the calling agent can format it naturally for the conversation.

## Bootstrap and onboarding

Bootstrap configures forecast defaults and returns a readiness checklist. It is deliberately safe to re-run: unchanged settings are not rewritten and no records are duplicated.

```bash
./bin/crm bootstrap pipeline \
  --target-amount 100000 \
  --target-period 2026-Q3 \
  --currency USD \
  --default-owner codex \
  --actor codex
```

The result identifies missing configuration, unowned prospects, incomplete opportunities, and the next setup steps. The MCP equivalent is `crm_bootstrap`.

## Forecasting and honest revenue reviews

A prospect becomes forecastable only when explicitly qualified with an amount, expected close date, and concrete next step:

```bash
./bin/crm opportunity qualify pro_ID \
  --amount 25000 \
  --expected-close-at 2026-09-15T00:00:00Z \
  --next-step "Schedule the decision call" \
  --forecast-category commit \
  --probability 80 \
  --actor codex

./bin/crm forecast pipeline --period 2026-Q3
./bin/crm conversions pipeline
./bin/crm review pipeline --period 2026-Q3
```

`forecast` returns open pipeline, weighted forecast, best case, commit, closed-won revenue, target attainment, coverage, and missing forecast data. `conversions` derives directional stage conversion rates from the immutable activity history.

`review` is the critical CRO adversary. It flags unsupported commit claims, weak coverage, overdue or expired next steps, incomplete forecast evidence, and other assumptions that deserve scrutiny. Findings include severity, underlying records, and a recommended corrective action.

The MCP equivalents are `crm_qualify_opportunity`, `crm_forecast`, `crm_conversions`, and `crm_cro_review`.

## Staying ahead of dropped work

The v0.3 action engine ranks work across tasks and pipeline risks. Every recommendation carries a score, plain-language reasons, a suggested action, and an effort estimate.

```bash
./bin/crm next-actions pipeline
./bin/crm next-actions pipeline --mode close --time-budget 45
./bin/crm next-actions pipeline --mode pipeline_build
./bin/crm risks pipeline
```

`risks` finds unowned, unscheduled, stale, overdue, uncontactable, expired, and forecast-incomplete records. It is read-only by default. To explicitly create idempotent repair tasks:

```bash
./bin/crm risks pipeline --create-tasks --actor codex
```

The MCP equivalent is `crm_pipeline_risks`.

## Contact enrichment

Agent CRM can research one linked contact and company, then propose identity and work-email updates without applying them:

```bash
./bin/crm contact enrich con_ID --actor codex
./bin/crm contact apply-enrichment enr_ID --actor codex
# After reviewing a flagged result:
./bin/crm contact apply-enrichment enr_ID --approve-manual-review --actor codex
```

The first command uses progressive Serper searches to require official company evidence or multiple matching sources. It stops before email lookup when identity remains unresolved. Hunter runs first; FullEnrich runs only after a Hunter miss. Catch-all, uncertain, and conflicting results require manual review. The command records queries, evidence, raw and normalized provider status, retrieval time, latency, credits, and proposed fields in an append-only attempt. CLI output masks proposed emails.

Writes require a separate `apply-enrichment` call. Flagged results also require `--approve-manual-review`. Applying an attempt fills blank contact fields and never replaces an existing human value. Agent CRM still does not send outreach.

Set `SERPER_API_KEY`, `HUNTER_API_KEY`, and `FULLENRICH_API_KEY`. To read keys from 1Password instead, set the matching `*_OP_REF` variables to secret references and sign in with `op`. Keys stay in request headers and are never stored in CRM records. Keep personal vault paths out of this public repository.

FullEnrich is asynchronous. The minimal CLI polls twice, five minutes apart by default, matching its documentation. Use `--fullenrich-polls` and `--poll-interval` for an interactive run. A pending attempt stays recorded and can be retried later.

## SDR workbench

Agent CRM prepares top-of-funnel work without sending messages:

```bash
./bin/crm sdr-queue pipeline
./bin/crm experiment-report pipeline recall-first-v1-phoenix-30
./bin/crm research-brief pro_ID
./bin/crm outreach-brief pro_ID
```

The SDR queue prioritizes enrichment and outreach preparation using fit, contactability, and research completeness. Research briefs separate sourced facts from unsourced context and missing information. Outreach briefs combine verified context, prior interactions, prerequisites, and a suggested angle while preserving the system-of-record-only boundary.

The MCP equivalents are `crm_sdr_queue`, `crm_research_brief`, and `crm_outreach_brief`.

## Agent skill

The reusable agent skill lives in [`skill/agent-crm`](skill/agent-crm). Symlink or copy that directory into your agent’s skills directory, then configure the skill to point to your checkout.

## Development

The core test suite has no third-party dependencies:

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

## Cloud service (staging)

Agent CRM can run on Cloudflare Workers with D1, split across two hostnames:

- `crm.services.c18h.net` — human dashboard (Cloudflare Access browser identity)
- `crm-agent.services.c18h.net` — MCP OAuth (`/mcp`) and service-token API (`/v1/*`)

Local development:

```bash
npm install
npm run dev
```

Worker tests and typecheck:

```bash
npm run check
PYTHONPATH=src python3 -m unittest discover -s tests -v
```

Python remote API mode (Access service token):

```bash
export CRM_API_URL=https://crm-agent.services.c18h.net
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...
./bin/crm project list
```

Data export for D1 migration (uses consistent SQLite backup; never commit output):

```bash
python3 scripts/export-cloud-data.py --db ~/.codex/memories/agent-crm/crm.sqlite3 --backup /tmp/crm-backup.sqlite3 --output /tmp/crm-export.sql
```

Production cutover, Access applications, OAuth secrets, and production D1 import are intentionally deferred until review.

## License

[MIT](LICENSE)
