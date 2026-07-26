---
name: agent-crm
description: Operate a project-isolated, machine-local B2B CRM for prospects, opportunities, forecasting, revenue reviews, research, outreach state, notes, follow-ups, and timelines. Use when managing pipeline, deciding what to do next, checking forecast health, preventing dropped work, or preparing top-of-funnel research and outreach.
---

# Agent CRM

Use the MCP tools named `crm_*` when available. Otherwise call `crm`; it emits JSON on stdout and errors as JSON on stderr.

## Rules

- Treat each project as an isolated CRM workspace. Never search or mutate a different project unless the user requests it.
- Supply an actor on every write. Use `codex`, `cursor`, or `buzz:<agent-name-or-npub>` unless a more specific identity is available. The actor is audit metadata, not authentication.
- Search before creating a company, contact, or prospect to reduce duplicates.
- Keep factual research in notes and include `source_url` when available. Do not present inference as sourced fact.
- Use tasks for promised follow-ups and deadlines. Use ISO-8601 timestamps with timezone offsets.
- Use `expected_version` when updating a record read earlier in the session.
- Move prospects through allowed stages. The defaults are `identified`, `researching`, `qualified`, `ready_to_contact`, `contacted`, `replied`, `meeting_booked`, `won`; terminal exits are `lost`, `not_a_fit`, and `do_not_contact`.
- Do not send email, place calls, or contact anyone through this CRM. It is a system of record only.
- Log completed outreach with `interaction log`; do not use a generic note as a substitute for an email, call, message, or meeting.
- Do not run `inbox` automatically at session start. Run it only when explicitly requested or as part of a deliberately scheduled follow-up job.
- When asked for today's priorities or the most important things to do, call `crm_next_actions` or `crm next-actions PROJECT`. Present the returned `actions` as a concise numbered list; preserve the reason, due date, prospect/company, and stage when useful.
- When asked to show the pipeline, call `crm_pipeline` or `crm pipeline PROJECT`. Present stages in returned order with their prospect counts, and list the prospects within each stage. Include terminal stages only when the user asks for closed outcomes or pipeline history.
- Run `crm_bootstrap` or `crm bootstrap PROJECT` when the user asks to onboard, configure, audit setup, or refresh CRM readiness. It is safe to re-run. Writes still require an actor.
- A prospect is not forecastable merely because it exists. Use `crm_qualify_opportunity` only when amount, expected close date, and a concrete next step are supportable.
- For revenue questions, use `crm_forecast` for the numbers, `crm_conversions` for historical conversion context, and `crm_cro_review` when the user wants assumptions challenged. Preserve warnings and evidence; do not improve the forecast by inventing missing data.
- Use `crm_pipeline_risks` to find unscheduled, unowned, stale, overdue, uncontactable, or incomplete work. Create repair tasks only when explicitly requested.
- Use `crm_sdr_queue` to prioritize top-of-funnel work. Use `crm_research_brief` before enrichment or research and `crm_outreach_brief` before drafting outreach.
- Research and outreach briefs do not authorize contacting anyone. Agent CRM remains a system of record and preparation tool.
- Read tools return structured data. Choose formatting that fits the conversation rather than reproducing raw JSON.

## CLI examples

Set identity once per process:

```bash
export CRM_ACTOR=codex
crm project list
```

Search, then create a researched prospect:

```bash
crm search imago "Acme"
crm company create imago "Acme Inc" --domain acme.example
crm prospect create imago "Acme design lead" --company-id cmp_ID --owner buzz:researcher --source-url https://acme.example
```

Record research and schedule follow-up:

```bash
crm note add imago "Hiring three designers; likely workflow pain." --prospect-id pro_ID --kind research --source-url https://acme.example/jobs
crm task create imago "Review Acme before outreach" --prospect-id pro_ID --due-at 2026-08-01T16:00:00Z --assigned-to buzz:outreach
crm interaction log imago email outbound "Sent discovery email" --prospect-id pro_ID --outcome sent
```

Read and advance work:

```bash
crm prospect get pro_ID
crm prospect transition pro_ID researching --expected-version 1
crm inbox --project imago --actor buzz:outreach
crm next-actions imago
crm pipeline imago
crm bootstrap imago --target-amount 100000 --target-period 2026-Q3 --currency USD --actor codex
crm opportunity qualify pro_ID --amount 25000 --expected-close-at 2026-09-15T00:00:00Z --next-step "Book decision call" --actor codex
crm forecast imago --period 2026-Q3
crm review imago --period 2026-Q3
crm risks imago
crm sdr-queue imago
```

Use `crm --help` and subcommand `--help` for the complete CLI contract.
