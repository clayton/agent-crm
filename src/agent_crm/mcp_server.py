from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # pragma: no cover
    raise SystemExit("MCP support is not installed. Run: uv tool install 'agent-crm[mcp]' --from .") from exc

from . import service
from .db import connect


mcp = FastMCP("agent-crm")


@contextmanager
def db():
    conn = connect(os.environ.get("CRM_DB"))
    try:
        yield conn
    finally:
        conn.close()


@mcp.tool()
def crm_projects() -> list[dict]:
    """List CRM projects."""
    with db() as conn:
        return service.list_projects(conn)


@mcp.tool()
def crm_create_project(name: str, actor: str, slug: str | None = None, description: str | None = None) -> dict:
    """Create an isolated CRM project with the default cold-outreach pipeline."""
    with db() as conn:
        return service.create_project(conn, name, actor, slug, description)


@mcp.tool()
def crm_create_company(project: str, name: str, actor: str, domain: str | None = None,
                       website: str | None = None, industry: str | None = None,
                       description: str | None = None, tags: list[str] | None = None,
                       custom: dict[str, Any] | None = None) -> dict:
    """Create a company in a project."""
    with db() as conn:
        return service.create_company(conn, project, name, actor, domain=domain, website=website,
                                      industry=industry, description=description, tags=tags, custom=custom)


@mcp.tool()
def crm_get_company(company_id: str) -> dict:
    """Get a company dossier with its contacts and prospects."""
    with db() as conn:
        return service.get_company(conn, company_id)


@mcp.tool()
def crm_list_companies(project: str, limit: int = 100) -> list[dict]:
    """List companies within one project."""
    with db() as conn:
        return service.list_companies(conn, project, limit)


@mcp.tool()
def crm_update_company(company_id: str, actor: str, fields: dict[str, Any]) -> dict:
    """Update standard or custom company profile fields."""
    with db() as conn:
        return service.update_company(conn, company_id, actor, fields)


@mcp.tool()
def crm_create_contact(project: str, full_name: str, actor: str, company_id: str | None = None,
                       email: str | None = None, phone: str | None = None, title: str | None = None,
                       linkedin_url: str | None = None, tags: list[str] | None = None,
                       custom: dict[str, Any] | None = None) -> dict:
    """Create a B2B contact in a project."""
    with db() as conn:
        return service.create_contact(conn, project, full_name, actor, company_id=company_id, email=email,
                                      phone=phone, title=title, linkedin_url=linkedin_url, tags=tags, custom=custom)


@mcp.tool()
def crm_get_contact(contact_id: str) -> dict:
    """Get a contact dossier with its company and prospects."""
    with db() as conn:
        return service.get_contact(conn, contact_id)


@mcp.tool()
def crm_list_contacts(project: str, limit: int = 100) -> list[dict]:
    """List contacts within one project."""
    with db() as conn:
        return service.list_contacts(conn, project, limit)


@mcp.tool()
def crm_update_contact(contact_id: str, actor: str, fields: dict[str, Any]) -> dict:
    """Update standard or custom contact profile fields."""
    with db() as conn:
        return service.update_contact(conn, contact_id, actor, fields)


@mcp.tool()
def crm_create_prospect(project: str, name: str, actor: str, stage: str = "identified",
                        contact_id: str | None = None, company_id: str | None = None,
                        source: str | None = None, source_url: str | None = None,
                        owner: str | None = None, fit_score: int | None = None,
                        priority: str = "normal", pain_points: str | None = None,
                        qualification_notes: str | None = None, tags: list[str] | None = None,
                        custom: dict[str, Any] | None = None) -> dict:
    """Create an outreach prospect, optionally linked to a contact and company."""
    with db() as conn:
        return service.create_prospect(conn, project, name, actor, stage, contact_id=contact_id,
                                       company_id=company_id, source=source, source_url=source_url,
                                       owner=owner, fit_score=fit_score, priority=priority,
                                       pain_points=pain_points, qualification_notes=qualification_notes,
                                       tags=tags, custom=custom)


@mcp.tool()
def crm_get_prospect(prospect_id: str) -> dict:
    """Get a prospect dossier with open tasks and notes."""
    with db() as conn:
        return service.get_prospect(conn, prospect_id)


@mcp.tool()
def crm_list_prospects(project: str, stage: str | None = None, owner: str | None = None,
                       limit: int = 100) -> list[dict]:
    """List or filter a project's prospects."""
    with db() as conn:
        return service.list_prospects(conn, project, stage, owner, limit)


@mcp.tool()
def crm_update_prospect(prospect_id: str, actor: str, fields: dict[str, Any],
                        expected_version: int | None = None) -> dict:
    """Update prospect fields. Pass expected_version for optimistic conflict detection."""
    with db() as conn:
        return service.update_prospect(conn, prospect_id, actor, fields, expected_version)


@mcp.tool()
def crm_transition_prospect(prospect_id: str, to_stage: str, actor: str,
                            reason: str | None = None, expected_version: int | None = None) -> dict:
    """Move a prospect through an allowed pipeline transition."""
    with db() as conn:
        return service.transition_prospect(conn, prospect_id, to_stage, actor, reason, expected_version)


@mcp.tool()
def crm_add_note(project: str, body: str, actor: str, prospect_id: str | None = None,
                 contact_id: str | None = None, company_id: str | None = None,
                 kind: str = "general", source_url: str | None = None) -> dict:
    """Attach a research or outreach note to a prospect, contact, or company."""
    with db() as conn:
        return service.add_note(conn, project, actor, body, prospect_id, contact_id, company_id, kind, source_url)


@mcp.tool()
def crm_create_task(project: str, title: str, actor: str, due_at: str | None = None,
                    prospect_id: str | None = None, assigned_to: str | None = None,
                    description: str | None = None, priority: str = "normal") -> dict:
    """Create a follow-up task. ISO-8601 UTC timestamps are recommended for due_at."""
    with db() as conn:
        return service.create_task(conn, project, actor, title, due_at, prospect_id,
                                   description=description, priority=priority, assigned_to=assigned_to)


@mcp.tool()
def crm_complete_task(task_id: str, actor: str) -> dict:
    """Complete a follow-up task."""
    with db() as conn:
        return service.complete_task(conn, task_id, actor)


@mcp.tool()
def crm_log_interaction(project: str, channel: str, direction: str, summary: str, actor: str,
                        prospect_id: str | None = None, contact_id: str | None = None,
                        company_id: str | None = None, outcome: str | None = None,
                        occurred_at: str | None = None, external_ref: str | None = None) -> dict:
    """Log a cold email, call, SMS, LinkedIn message, meeting, or other interaction without sending it."""
    with db() as conn:
        return service.log_interaction(conn, project, actor, channel, direction, summary, prospect_id,
                                       contact_id, company_id, outcome, occurred_at, external_ref)


@mcp.tool()
def crm_list_interactions(project: str, prospect_id: str | None = None,
                          channel: str | None = None, limit: int = 100) -> list[dict]:
    """List recorded outreach interactions in a project."""
    with db() as conn:
        return service.list_interactions(conn, project, prospect_id, channel, limit)


@mcp.tool()
def crm_inbox(project: str | None = None, actor: str | None = None,
              due_within_days: int = 7, stale_days: int = 30) -> dict:
    """Return overdue, due-soon, and stale work. Intended for explicitly scheduled agents."""
    with db() as conn:
        return service.inbox(conn, project, actor, due_within_days, stale_days)


@mcp.tool()
def crm_next_actions(project: str, actor: str | None = None, limit: int = 5,
                     stale_days: int = 30) -> dict:
    """Return 3-5 ranked next actions for today's most important CRM work."""
    with db() as conn:
        return service.next_actions(conn, project, actor, limit, stale_days)


@mcp.tool()
def crm_pipeline(project: str, include_terminal: bool = False) -> dict:
    """Return a project's prospects grouped in sales-stage order."""
    with db() as conn:
        return service.pipeline(conn, project, include_terminal)


@mcp.tool()
def crm_search(project: str, query: str, limit: int = 50) -> dict:
    """Search companies, contacts, prospects, and notes within one project."""
    with db() as conn:
        return service.search(conn, project, query, limit)


@mcp.tool()
def crm_timeline(entity_type: str, entity_id: str, limit: int = 100) -> list[dict]:
    """Read the immutable activity timeline for an entity."""
    with db() as conn:
        return service.timeline(conn, entity_type, entity_id, limit)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
