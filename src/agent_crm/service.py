from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from .db import row_dict, transaction


DEFAULT_STAGES = [
    ("identified", "Identified", False, None),
    ("researching", "Researching", False, None),
    ("qualified", "Qualified", False, None),
    ("ready_to_contact", "Ready to Contact", False, None),
    ("contacted", "Contacted", False, None),
    ("replied", "Replied", False, None),
    ("meeting_booked", "Meeting Booked", False, None),
    ("won", "Won", True, "won"),
    ("lost", "Lost", True, "lost"),
    ("not_a_fit", "Not a Fit", True, "disqualified"),
    ("do_not_contact", "Do Not Contact", True, "do_not_contact"),
]


class CRMError(ValueError):
    pass


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def require_actor(actor: str | None) -> str:
    actor = (actor or "").strip()
    if not actor:
        raise CRMError("A write actor is required (--actor or CRM_ACTOR).")
    return actor


def slugify(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not value:
        raise CRMError("A non-empty project slug is required.")
    return value


def activity(conn: sqlite3.Connection, project_id: str, entity_type: str, entity_id: str,
             action: str, actor: str, details: dict[str, Any] | None = None) -> None:
    conn.execute(
        "INSERT INTO activities(project_id, entity_type, entity_id, action, actor, occurred_at, details_json) VALUES(?,?,?,?,?,?,?)",
        (project_id, entity_type, entity_id, action, actor, now(), json.dumps(details or {}, sort_keys=True)),
    )


def resolve_project(conn: sqlite3.Connection, project: str) -> dict:
    row = conn.execute("SELECT * FROM projects WHERE id = ? OR slug = ?", (project, project)).fetchone()
    if not row:
        raise CRMError(f"Project not found: {project}")
    return row_dict(row) or {}


def validate_link(conn: sqlite3.Connection, table: str, entity_id: str | None, project_id: str) -> None:
    if not entity_id:
        return
    if table not in {"companies", "contacts", "prospects"}:
        raise CRMError(f"Unsupported link type: {table}")
    row = conn.execute(f"SELECT project_id FROM {table} WHERE id=?", (entity_id,)).fetchone()
    if not row:
        raise CRMError(f"Linked {table[:-1]} not found: {entity_id}")
    if row["project_id"] != project_id:
        raise CRMError(f"Cross-project {table[:-1]} link rejected: {entity_id}")


def create_project(conn: sqlite3.Connection, name: str, actor: str, slug: str | None = None,
                   description: str | None = None) -> dict:
    actor = require_actor(actor)
    project_id, timestamp = uid("prj"), now()
    project_slug = slugify(slug or name)
    with transaction(conn):
        conn.execute(
            "INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)",
            (project_id, project_slug, name, description, "{}", timestamp, timestamp, actor, actor),
        )
        stage_ids: dict[str, str] = {}
        for position, (key, label, terminal, outcome) in enumerate(DEFAULT_STAGES):
            stage_id = uid("stg")
            stage_ids[key] = stage_id
            conn.execute(
                "INSERT INTO pipeline_stages VALUES(?,?,?,?,?,?,?)",
                (stage_id, project_id, key, label, position, int(terminal), outcome),
            )
        linear = [key for key, _, terminal, _ in DEFAULT_STAGES if not terminal] + ["won"]
        for from_key, to_key in zip(linear, linear[1:]):
            conn.execute("INSERT INTO stage_transitions VALUES(?,?,?)", (project_id, stage_ids[from_key], stage_ids[to_key]))
        terminal_keys = ["lost", "not_a_fit", "do_not_contact"]
        for from_key, _, terminal, _ in DEFAULT_STAGES:
            if not terminal:
                for to_key in terminal_keys:
                    conn.execute("INSERT INTO stage_transitions VALUES(?,?,?)", (project_id, stage_ids[from_key], stage_ids[to_key]))
        activity(conn, project_id, "project", project_id, "created", actor, {"name": name, "slug": project_slug})
    return get_project(conn, project_id)


def get_project(conn: sqlite3.Connection, project: str) -> dict:
    result = resolve_project(conn, project)
    result["stages"] = [row_dict(row) for row in conn.execute(
        "SELECT * FROM pipeline_stages WHERE project_id = ? ORDER BY position", (result["id"],)
    )]
    return result


def list_projects(conn: sqlite3.Connection) -> list[dict]:
    return [row_dict(row) for row in conn.execute("SELECT * FROM projects ORDER BY name")]


COMPANY_FIELDS = {"name", "domain", "website", "linkedin_url", "industry", "employee_count", "annual_revenue", "location", "description"}
CONTACT_FIELDS = {"company_id", "first_name", "last_name", "full_name", "email", "phone", "title", "department", "seniority", "linkedin_url", "location"}
PROSPECT_FIELDS = {
    "contact_id", "company_id", "name", "source", "source_url", "owner",
    "fit_score", "priority", "pain_points", "needs", "budget", "authority",
    "timing", "qualification_notes", "do_not_contact", "lost_reason",
    "last_contacted_at", "next_contact_at", "stale_after", "amount",
    "currency", "expected_close_at", "forecast_category", "probability",
    "probability_source", "next_step", "next_step_due_at", "qualified_at",
}


def _create_entity(conn: sqlite3.Connection, table: str, prefix: str, project: str, actor: str,
                   values: dict[str, Any], allowed: set[str], tags: list[str] | None, custom: dict | None) -> dict:
    actor = require_actor(actor)
    project_row = resolve_project(conn, project)
    unknown = set(values) - allowed
    if unknown:
        raise CRMError(f"Unsupported {table} fields: {', '.join(sorted(unknown))}")
    entity_id, timestamp = uid(prefix), now()
    record = {key: value for key, value in values.items() if value is not None}
    record.update(id=entity_id, project_id=project_row["id"], tags_json=json.dumps(tags or []), custom_json=json.dumps(custom or {}),
                  created_at=timestamp, updated_at=timestamp, created_by=actor, updated_by=actor)
    columns = ",".join(record)
    placeholders = ",".join("?" for _ in record)
    with transaction(conn):
        conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(record.values()))
        activity(conn, project_row["id"], table[:-1], entity_id, "created", actor, values)
    return row_dict(conn.execute(f"SELECT * FROM {table} WHERE id = ?", (entity_id,)).fetchone()) or {}


def create_company(conn: sqlite3.Connection, project: str, name: str, actor: str, **fields: Any) -> dict:
    tags, custom = fields.pop("tags", None), fields.pop("custom", None)
    return _create_entity(conn, "companies", "cmp", project, actor, {"name": name, **fields}, COMPANY_FIELDS, tags, custom)


def create_contact(conn: sqlite3.Connection, project: str, full_name: str, actor: str, **fields: Any) -> dict:
    tags, custom = fields.pop("tags", None), fields.pop("custom", None)
    validate_link(conn, "companies", fields.get("company_id"), resolve_project(conn, project)["id"])
    return _create_entity(conn, "contacts", "con", project, actor, {"full_name": full_name, **fields}, CONTACT_FIELDS, tags, custom)


def _get_entity(conn: sqlite3.Connection, table: str, entity_id: str) -> dict:
    if table not in {"companies", "contacts"}:
        raise CRMError(f"Unsupported entity type: {table}")
    row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    if not row:
        raise CRMError(f"{table[:-1].title()} not found: {entity_id}")
    return row_dict(row) or {}


def get_company(conn: sqlite3.Connection, company_id: str) -> dict:
    result = _get_entity(conn, "companies", company_id)
    result["contacts"] = [row_dict(r) for r in conn.execute(
        "SELECT * FROM contacts WHERE company_id=? ORDER BY full_name", (company_id,)
    )]
    result["prospects"] = [row_dict(r) for r in conn.execute(
        "SELECT p.*, s.key AS stage FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id WHERE p.company_id=? ORDER BY p.updated_at DESC",
        (company_id,),
    )]
    return result


def get_contact(conn: sqlite3.Connection, contact_id: str) -> dict:
    result = _get_entity(conn, "contacts", contact_id)
    if result.get("company_id"):
        result["company"] = _get_entity(conn, "companies", result["company_id"])
    result["prospects"] = [row_dict(r) for r in conn.execute(
        "SELECT p.*, s.key AS stage FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id WHERE p.contact_id=? ORDER BY p.updated_at DESC",
        (contact_id,),
    )]
    return result


def _list_entities(conn: sqlite3.Connection, table: str, project: str, limit: int) -> list[dict]:
    if table not in {"companies", "contacts"}:
        raise CRMError(f"Unsupported entity type: {table}")
    project_id = resolve_project(conn, project)["id"]
    order = "name" if table == "companies" else "full_name"
    return [row_dict(r) for r in conn.execute(
        f"SELECT * FROM {table} WHERE project_id=? ORDER BY {order} LIMIT ?",
        (project_id, min(max(limit, 1), 1000)),
    )]


def list_companies(conn: sqlite3.Connection, project: str, limit: int = 100) -> list[dict]:
    return _list_entities(conn, "companies", project, limit)


def list_contacts(conn: sqlite3.Connection, project: str, limit: int = 100) -> list[dict]:
    return _list_entities(conn, "contacts", project, limit)


def _update_entity(conn: sqlite3.Connection, table: str, entity_id: str, actor: str,
                   fields: dict[str, Any], allowed: set[str]) -> dict:
    actor = require_actor(actor)
    current = _get_entity(conn, table, entity_id)
    unknown = set(fields) - (allowed | {"tags", "custom"})
    if unknown:
        raise CRMError(f"Unsupported {table[:-1]} fields: {', '.join(sorted(unknown))}")
    clean = {k + "_json" if k in {"tags", "custom"} else k: json.dumps(v) if k in {"tags", "custom"} else v for k, v in fields.items()}
    clean.update(updated_at=now(), updated_by=actor)
    with transaction(conn):
        conn.execute(f"UPDATE {table} SET {','.join(f'{key}=?' for key in clean)} WHERE id=?", (*clean.values(), entity_id))
        activity(conn, current["project_id"], table[:-1], entity_id, "updated", actor, fields)
    return _get_entity(conn, table, entity_id)


def update_company(conn: sqlite3.Connection, company_id: str, actor: str, fields: dict[str, Any]) -> dict:
    return _update_entity(conn, "companies", company_id, actor, fields, COMPANY_FIELDS)


def update_contact(conn: sqlite3.Connection, contact_id: str, actor: str, fields: dict[str, Any]) -> dict:
    current = _get_entity(conn, "contacts", contact_id)
    validate_link(conn, "companies", fields.get("company_id"), current["project_id"])
    return _update_entity(conn, "contacts", contact_id, actor, fields, CONTACT_FIELDS)


def _stage(conn: sqlite3.Connection, project_id: str, key: str) -> dict:
    row = conn.execute("SELECT * FROM pipeline_stages WHERE project_id = ? AND key = ?", (project_id, key)).fetchone()
    if not row:
        raise CRMError(f"Pipeline stage not found: {key}")
    return row_dict(row) or {}


def create_prospect(conn: sqlite3.Connection, project: str, name: str, actor: str,
                    stage: str = "identified", **fields: Any) -> dict:
    tags, custom = fields.pop("tags", None), fields.pop("custom", None)
    project_row = resolve_project(conn, project)
    validate_link(conn, "contacts", fields.get("contact_id"), project_row["id"])
    validate_link(conn, "companies", fields.get("company_id"), project_row["id"])
    stage_row = _stage(conn, project_row["id"], stage)
    values = {"name": name, "stage_id": stage_row["id"], **{k: v for k, v in fields.items() if v is not None}}
    unknown = set(values) - (PROSPECT_FIELDS | {"stage_id"})
    if unknown:
        raise CRMError(f"Unsupported prospect fields: {', '.join(sorted(unknown))}")
    actor = require_actor(actor)
    prospect_id, timestamp = uid("pro"), now()
    record = {"id": prospect_id, "project_id": project_row["id"], **values,
              "tags_json": json.dumps(tags or []), "custom_json": json.dumps(custom or {}),
              "created_at": timestamp, "updated_at": timestamp, "created_by": actor, "updated_by": actor}
    with transaction(conn):
        conn.execute(f"INSERT INTO prospects ({','.join(record)}) VALUES ({','.join('?' for _ in record)})", tuple(record.values()))
        activity(conn, project_row["id"], "prospect", prospect_id, "created", actor, {"name": name, "stage": stage})
    return get_prospect(conn, prospect_id)


def get_prospect(conn: sqlite3.Connection, prospect_id: str) -> dict:
    row = conn.execute(
        """SELECT p.*, s.key AS stage, s.name AS stage_name,
                  c.full_name AS contact_name, c.email AS contact_email,
                  c.phone AS contact_phone, c.title AS contact_title,
                  co.name AS company_name, co.domain AS company_domain
           FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
           LEFT JOIN contacts c ON c.id=p.contact_id LEFT JOIN companies co ON co.id=p.company_id
           WHERE p.id=?""", (prospect_id,)
    ).fetchone()
    if not row:
        raise CRMError(f"Prospect not found: {prospect_id}")
    result = row_dict(row) or {}
    result["open_tasks"] = [row_dict(r) for r in conn.execute(
        "SELECT * FROM tasks WHERE prospect_id=? AND status='open' ORDER BY due_at IS NULL, due_at", (prospect_id,)
    )]
    result["notes"] = [row_dict(r) for r in conn.execute(
        "SELECT * FROM notes WHERE prospect_id=? ORDER BY created_at DESC", (prospect_id,)
    )]
    result["interactions"] = [row_dict(r) for r in conn.execute(
        "SELECT * FROM interactions WHERE prospect_id=? ORDER BY occurred_at DESC", (prospect_id,)
    )]
    return result


def list_prospects(conn: sqlite3.Connection, project: str, stage: str | None = None,
                   owner: str | None = None, limit: int = 100) -> list[dict]:
    project_id = resolve_project(conn, project)["id"]
    sql = """SELECT p.*, s.key AS stage, c.full_name AS contact_name, co.name AS company_name
             FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
             LEFT JOIN contacts c ON c.id=p.contact_id LEFT JOIN companies co ON co.id=p.company_id
             WHERE p.project_id=?"""
    params: list[Any] = [project_id]
    if stage:
        sql += " AND s.key=?"
        params.append(stage)
    if owner:
        sql += " AND p.owner=?"
        params.append(owner)
    sql += " ORDER BY p.updated_at DESC LIMIT ?"
    params.append(min(max(limit, 1), 1000))
    return [row_dict(row) for row in conn.execute(sql, params)]


def transition_prospect(conn: sqlite3.Connection, prospect_id: str, to_stage: str, actor: str,
                        reason: str | None = None, expected_version: int | None = None) -> dict:
    actor = require_actor(actor)
    current = get_prospect(conn, prospect_id)
    if expected_version is not None and current["version"] != expected_version:
        raise CRMError(f"Version conflict: expected {expected_version}, found {current['version']}")
    target = _stage(conn, current["project_id"], to_stage)
    allowed = conn.execute(
        "SELECT 1 FROM stage_transitions WHERE from_stage_id=? AND to_stage_id=?",
        (current["stage_id"], target["id"]),
    ).fetchone()
    if not allowed:
        raise CRMError(f"Transition not allowed: {current['stage']} -> {to_stage}")
    timestamp = now()
    extra = {}
    if to_stage == "do_not_contact":
        extra["do_not_contact"] = 1
    if to_stage in {"lost", "not_a_fit"} and reason:
        extra["lost_reason"] = reason
    if to_stage == "won":
        extra["forecast_category"] = "closed"
        extra["probability"] = 100
    assignments = ["stage_id=?", "updated_at=?", "updated_by=?", "version=version+1"] + [f"{k}=?" for k in extra]
    params = [target["id"], timestamp, actor, *extra.values(), prospect_id]
    with transaction(conn):
        conn.execute(f"UPDATE prospects SET {','.join(assignments)} WHERE id=?", params)
        activity(conn, current["project_id"], "prospect", prospect_id, "stage_changed", actor,
                 {"from": current["stage"], "to": to_stage, "reason": reason})
    return get_prospect(conn, prospect_id)


def update_prospect(conn: sqlite3.Connection, prospect_id: str, actor: str,
                    fields: dict[str, Any], expected_version: int | None = None) -> dict:
    actor = require_actor(actor)
    current = get_prospect(conn, prospect_id)
    unknown = set(fields) - (PROSPECT_FIELDS | {"tags", "custom"})
    if unknown:
        raise CRMError(f"Unsupported prospect fields: {', '.join(sorted(unknown))}")
    if expected_version is not None and current["version"] != expected_version:
        raise CRMError(f"Version conflict: expected {expected_version}, found {current['version']}")
    clean = {k + "_json" if k in {"tags", "custom"} else k: json.dumps(v) if k in {"tags", "custom"} else v for k, v in fields.items()}
    close_date_changed = (
        "expected_close_at" in fields
        and current.get("expected_close_at")
        and fields["expected_close_at"]
        and fields["expected_close_at"] > current["expected_close_at"]
    )
    clean.update(updated_at=now(), updated_by=actor)
    assignments = [f"{key}=?" for key in clean] + ["version=version+1"]
    if close_date_changed:
        assignments.append("close_date_changed_count=close_date_changed_count+1")
    with transaction(conn):
        conn.execute(f"UPDATE prospects SET {','.join(assignments)} WHERE id=?", (*clean.values(), prospect_id))
        activity(conn, current["project_id"], "prospect", prospect_id, "updated", actor, fields)
    return get_prospect(conn, prospect_id)


def add_note(conn: sqlite3.Connection, project: str, actor: str, body: str,
             prospect_id: str | None = None, contact_id: str | None = None,
             company_id: str | None = None, kind: str = "general", source_url: str | None = None) -> dict:
    actor = require_actor(actor)
    project_id = resolve_project(conn, project)["id"]
    validate_link(conn, "prospects", prospect_id, project_id)
    validate_link(conn, "contacts", contact_id, project_id)
    validate_link(conn, "companies", company_id, project_id)
    note_id, timestamp = uid("not"), now()
    with transaction(conn):
        conn.execute("INSERT INTO notes VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (note_id, project_id, prospect_id, contact_id, company_id, kind, body, source_url, timestamp, actor))
        parent_type, parent_id = ("prospect", prospect_id) if prospect_id else (("contact", contact_id) if contact_id else ("company", company_id))
        activity(conn, project_id, parent_type, parent_id or "", "note_added", actor, {"note_id": note_id, "kind": kind})
    return row_dict(conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()) or {}


def create_task(conn: sqlite3.Connection, project: str, actor: str, title: str,
                due_at: str | None = None, prospect_id: str | None = None,
                contact_id: str | None = None, company_id: str | None = None,
                description: str | None = None, priority: str = "normal", assigned_to: str | None = None) -> dict:
    actor = require_actor(actor)
    project_id = resolve_project(conn, project)["id"]
    validate_link(conn, "prospects", prospect_id, project_id)
    validate_link(conn, "contacts", contact_id, project_id)
    validate_link(conn, "companies", company_id, project_id)
    task_id, timestamp = uid("tsk"), now()
    with transaction(conn):
        conn.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (task_id, project_id, prospect_id, contact_id, company_id, title, description, due_at, priority,
                      assigned_to, "open", None, timestamp, timestamp, actor, actor))
        activity(conn, project_id, "task", task_id, "created", actor, {"title": title, "due_at": due_at})
    return row_dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()) or {}


def complete_task(conn: sqlite3.Connection, task_id: str, actor: str) -> dict:
    actor = require_actor(actor)
    row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        raise CRMError(f"Task not found: {task_id}")
    task = row_dict(row) or {}
    timestamp = now()
    with transaction(conn):
        conn.execute("UPDATE tasks SET status='completed', completed_at=?, updated_at=?, updated_by=? WHERE id=?",
                     (timestamp, timestamp, actor, task_id))
        activity(conn, task["project_id"], "task", task_id, "completed", actor)
    return row_dict(conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()) or {}


def log_interaction(conn: sqlite3.Connection, project: str, actor: str, channel: str,
                    direction: str, summary: str, prospect_id: str | None = None,
                    contact_id: str | None = None, company_id: str | None = None,
                    outcome: str | None = None, occurred_at: str | None = None,
                    external_ref: str | None = None) -> dict:
    actor = require_actor(actor)
    project_id = resolve_project(conn, project)["id"]
    validate_link(conn, "prospects", prospect_id, project_id)
    validate_link(conn, "contacts", contact_id, project_id)
    validate_link(conn, "companies", company_id, project_id)
    if not any((prospect_id, contact_id, company_id)):
        raise CRMError("An interaction must link to a prospect, contact, or company.")
    if channel not in {"email", "call", "sms", "linkedin", "meeting", "other"}:
        raise CRMError(f"Unsupported interaction channel: {channel}")
    if direction not in {"inbound", "outbound", "internal"}:
        raise CRMError(f"Unsupported interaction direction: {direction}")
    interaction_id, created_at = uid("int"), now()
    occurred_at = occurred_at or created_at
    with transaction(conn):
        conn.execute("INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (interaction_id, project_id, prospect_id, contact_id, company_id, channel, direction,
                      outcome, summary, occurred_at, external_ref, created_at, actor))
        if prospect_id and direction in {"inbound", "outbound"}:
            conn.execute("UPDATE prospects SET last_contacted_at=?, updated_at=?, updated_by=?, version=version+1 WHERE id=?",
                         (occurred_at, created_at, actor, prospect_id))
        entity_type, entity_id = ("prospect", prospect_id) if prospect_id else (("contact", contact_id) if contact_id else ("company", company_id))
        activity(conn, project_id, entity_type, entity_id or "", "interaction_logged", actor,
                 {"interaction_id": interaction_id, "channel": channel, "direction": direction, "outcome": outcome})
    return row_dict(conn.execute("SELECT * FROM interactions WHERE id=?", (interaction_id,)).fetchone()) or {}


def list_interactions(conn: sqlite3.Connection, project: str, prospect_id: str | None = None,
                      channel: str | None = None, limit: int = 100) -> list[dict]:
    project_id = resolve_project(conn, project)["id"]
    sql = "SELECT * FROM interactions WHERE project_id=?"
    params: list[Any] = [project_id]
    if prospect_id:
        validate_link(conn, "prospects", prospect_id, project_id)
        sql += " AND prospect_id=?"
        params.append(prospect_id)
    if channel:
        sql += " AND channel=?"
        params.append(channel)
    sql += " ORDER BY occurred_at DESC LIMIT ?"
    params.append(min(max(limit, 1), 1000))
    return [row_dict(r) for r in conn.execute(sql, params)]


def inbox(conn: sqlite3.Connection, project: str | None = None, actor: str | None = None,
          due_within_days: int = 7, stale_days: int = 30) -> dict:
    timestamp = now()
    horizon = (datetime.now(UTC) + timedelta(days=due_within_days)).isoformat(timespec="seconds")
    params: list[Any] = []
    project_clause = ""
    project_id = None
    if project:
        project_id = resolve_project(conn, project)["id"]
        project_clause = " AND t.project_id=?"
        params.append(project_id)
    actor_clause = ""
    if actor:
        actor_clause = " AND t.assigned_to=?"
        params.append(actor)
    task_base = """SELECT t.*, p.name AS prospect_name, pr.slug AS project_slug FROM tasks t
                   JOIN projects pr ON pr.id=t.project_id LEFT JOIN prospects p ON p.id=t.prospect_id
                   WHERE t.status='open'"""
    overdue = [row_dict(r) for r in conn.execute(task_base + " AND t.due_at IS NOT NULL AND t.due_at < ?" + project_clause + actor_clause + " ORDER BY t.due_at", [timestamp, *params])]
    due_soon = [row_dict(r) for r in conn.execute(task_base + " AND t.due_at >= ? AND t.due_at <= ?" + project_clause + actor_clause + " ORDER BY t.due_at", [timestamp, horizon, *params])]
    stale_cutoff = (datetime.now(UTC) - timedelta(days=stale_days)).isoformat(timespec="seconds")
    stale_sql = """SELECT p.*, s.key AS stage, pr.slug AS project_slug FROM prospects p
                   JOIN pipeline_stages s ON s.id=p.stage_id JOIN projects pr ON pr.id=p.project_id
                   WHERE s.terminal=0 AND p.updated_at < ?"""
    stale_params: list[Any] = [stale_cutoff]
    if project_id:
        stale_sql += " AND p.project_id=?"
        stale_params.append(project_id)
    if actor:
        stale_sql += " AND p.owner=?"
        stale_params.append(actor)
    stale_sql += " ORDER BY p.updated_at"
    stale = [row_dict(r) for r in conn.execute(stale_sql, stale_params)]
    return {"generated_at": timestamp, "overdue": overdue, "due_soon": due_soon, "stale_prospects": stale,
            "counts": {"overdue": len(overdue), "due_soon": len(due_soon), "stale_prospects": len(stale)}}


def next_actions(conn: sqlite3.Connection, project: str, actor: str | None = None,
                 limit: int = 5, stale_days: int = 30, mode: str = "balanced",
                 time_budget: int | None = None) -> dict:
    """Rank work across tasks and pipeline risks with inspectable reasons."""
    if mode not in {"balanced", "close", "pipeline_build"}:
        raise CRMError("Mode must be balanced, close, or pipeline_build.")
    project_row = resolve_project(conn, project)
    limit = min(max(limit, 3), 5)
    timestamp = now()
    task_sql = """SELECT t.*, p.name AS prospect_name, p.amount, p.forecast_category,
                         s.key AS stage, c.name AS company_name
                  FROM tasks t
                  LEFT JOIN prospects p ON p.id=t.prospect_id
                  LEFT JOIN pipeline_stages s ON s.id=p.stage_id
                  LEFT JOIN companies c ON c.id=COALESCE(t.company_id, p.company_id)
                  WHERE t.project_id=? AND t.status='open'"""
    params: list[Any] = [project_row["id"]]
    if actor:
        task_sql += " AND (t.assigned_to=? OR t.assigned_to IS NULL)"
        params.append(actor)
    candidates = []
    priority_score = {"urgent": 35, "high": 25, "normal": 15, "low": 5}
    for task_row in conn.execute(task_sql, params):
        task = row_dict(task_row) or {}
        score = priority_score.get(task.get("priority"), 15)
        why = [f"{task.get('priority', 'normal')} priority task"]
        due_at = task.get("due_at")
        if due_at and due_at < timestamp:
            score += 70
            why.append("overdue")
        elif due_at and due_at[:10] <= timestamp[:10]:
            score += 30
            why.append("due today")
        elif due_at:
            score += 10
            why.append("scheduled")
        amount = task.get("amount") or 0
        if amount:
            score += min(int(amount / 5000), 20)
            why.append(f"{amount:g} in pipeline")
        if task.get("forecast_category") == "commit":
            score += 20
            why.append("commit opportunity")
        if mode == "close" and task.get("stage") in {"replied", "meeting_booked"}:
            score += 20
        if mode == "pipeline_build" and task.get("stage") in {"identified", "researching", "ready_to_contact"}:
            score += 20
        candidates.append({
            "type": "task", "id": task["id"], "title": task["title"],
            "score": min(score, 100), "why_now": why, "reason": why[0],
            "suggested_action": task["title"], "estimated_effort_minutes": 15,
            "priority": task["priority"], "due_at": due_at,
            "prospect_id": task.get("prospect_id"), "prospect_name": task.get("prospect_name"),
            "company_name": task.get("company_name"), "stage": task.get("stage"), "amount": amount or None,
        })

    risks = pipeline_risks(conn, project, stale_days=stale_days)["risks"]
    risk_score = {"critical": 90, "high": 75, "medium": 55, "low": 35}
    for risk in risks:
        if actor:
            owner = conn.execute("SELECT owner FROM prospects WHERE id=?", (risk["prospect_id"],)).fetchone()
            if owner and owner["owner"] not in {None, actor}:
                continue
        score = risk_score[risk["severity"]]
        if risk.get("amount"):
            score += min(int(risk["amount"] / 10000), 10)
        if mode == "close" and risk["stage"] in {"replied", "meeting_booked"}:
            score += 10
        if mode == "pipeline_build" and risk["kind"] in {"not_contactable", "missing_owner"}:
            score += 10
        candidates.append({
            "type": "pipeline_risk", "id": f"{risk['kind']}:{risk['prospect_id']}",
            "title": risk["recommended_action"], "score": min(score, 100),
            "why_now": [risk["message"], f"{risk['severity']} pipeline risk"],
            "reason": risk["kind"], "suggested_action": risk["recommended_action"],
            "estimated_effort_minutes": 15, "priority": risk["severity"],
            "due_at": None, "prospect_id": risk["prospect_id"],
            "prospect_name": risk["prospect_name"], "company_name": None,
            "stage": risk["stage"], "amount": risk.get("amount"),
        })

    candidates.sort(key=lambda item: (-item["score"], item["title"]))
    selected, used_minutes, seen, seen_prospects = [], 0, set(), set()
    for item in candidates:
        key = (item["type"], item["id"])
        if key in seen:
            continue
        if item.get("prospect_id") and item["prospect_id"] in seen_prospects:
            continue
        effort = item["estimated_effort_minutes"]
        if time_budget is not None and selected and used_minutes + effort > time_budget:
            continue
        selected.append(item)
        seen.add(key)
        if item.get("prospect_id"):
            seen_prospects.add(item["prospect_id"])
        used_minutes += effort
        if len(selected) >= limit:
            break
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "generated_at": timestamp, "mode": mode, "time_budget_minutes": time_budget,
        "estimated_total_minutes": used_minutes, "actions": selected, "count": len(selected),
    }


def pipeline(conn: sqlite3.Connection, project: str, include_terminal: bool = False) -> dict:
    """Return prospects grouped in configured pipeline-stage order."""
    project_row = resolve_project(conn, project)
    stage_sql = "SELECT * FROM pipeline_stages WHERE project_id=?"
    stage_params: list[Any] = [project_row["id"]]
    if not include_terminal:
        stage_sql += " AND terminal=0"
    stage_sql += " ORDER BY position"
    stages = []
    total = 0
    for stage_row in conn.execute(stage_sql, stage_params):
        stage = row_dict(stage_row) or {}
        prospects = [row_dict(row) for row in conn.execute(
            """SELECT p.id, p.name, p.owner, p.priority, p.fit_score, p.next_contact_at,
                      p.last_contacted_at, p.updated_at, p.version, p.amount,
                      p.currency, p.expected_close_at, p.forecast_category,
                      p.probability, p.next_step, p.next_step_due_at,
                      c.full_name AS contact_name, co.name AS company_name
               FROM prospects p
               LEFT JOIN contacts c ON c.id=p.contact_id
               LEFT JOIN companies co ON co.id=p.company_id
               WHERE p.stage_id=?
               ORDER BY CASE p.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                        WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 2 END,
                        p.updated_at DESC""",
            (stage["id"],),
        )]
        stages.append({
            "key": stage["key"],
            "name": stage["name"],
            "position": stage["position"],
            "terminal": bool(stage["terminal"]),
            "outcome": stage["outcome"],
            "count": len(prospects),
            "prospects": prospects,
        })
        total += len(prospects)
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "stages": stages,
        "total_prospects": total,
        "includes_terminal_stages": include_terminal,
    }


def _project_settings(project_row: dict) -> dict[str, Any]:
    return dict(project_row.get("settings") or {})


def _period_bounds(period: str | None) -> tuple[str, str, str]:
    current = datetime.now(UTC)
    if not period:
        quarter = ((current.month - 1) // 3) + 1
        period = f"{current.year}-Q{quarter}"
    quarter_match = re.fullmatch(r"(\d{4})-Q([1-4])", period)
    month_match = re.fullmatch(r"(\d{4})-(0[1-9]|1[0-2])", period)
    if quarter_match:
        year, quarter = int(quarter_match.group(1)), int(quarter_match.group(2))
        start_month = (quarter - 1) * 3 + 1
        start = datetime(year, start_month, 1, tzinfo=UTC)
        end = datetime(year + (1 if start_month == 10 else 0), 1 if start_month == 10 else start_month + 3, 1, tzinfo=UTC)
    elif month_match:
        year, month = int(month_match.group(1)), int(month_match.group(2))
        start = datetime(year, month, 1, tzinfo=UTC)
        end = datetime(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1, tzinfo=UTC)
    else:
        raise CRMError("Period must be YYYY-Q1..Q4 or YYYY-MM.")
    return period, start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds")


def bootstrap(conn: sqlite3.Connection, project: str, actor: str,
              target_amount: float | None = None, target_period: str | None = None,
              currency: str | None = None, default_owner: str | None = None,
              stale_days: int | None = None) -> dict:
    """Safely configure and re-check a project's revenue operating defaults."""
    actor = require_actor(actor)
    project_row = resolve_project(conn, project)
    settings = _project_settings(project_row)
    supplied = {
        "target_amount": target_amount,
        "target_period": target_period,
        "currency": currency,
        "default_owner": default_owner,
        "stale_days": stale_days,
    }
    changed = {key: value for key, value in supplied.items() if value is not None and settings.get(key) != value}
    if target_period is not None:
        _period_bounds(target_period)
    if target_amount is not None and target_amount < 0:
        raise CRMError("Target amount cannot be negative.")
    if stale_days is not None and stale_days < 1:
        raise CRMError("Stale days must be at least 1.")
    if changed:
        settings.update(changed)
        timestamp = now()
        with transaction(conn):
            conn.execute(
                "UPDATE projects SET settings_json=?, updated_at=?, updated_by=? WHERE id=?",
                (json.dumps(settings, sort_keys=True), timestamp, actor, project_row["id"]),
            )
            activity(conn, project_row["id"], "project", project_row["id"], "bootstrapped", actor, changed)

    counts = conn.execute(
        """SELECT
             COUNT(*) AS prospects,
             COALESCE(SUM(CASE WHEN owner IS NULL OR owner='' THEN 1 ELSE 0 END), 0) AS missing_owner,
             COALESCE(SUM(CASE WHEN contact_id IS NULL AND company_id IS NULL THEN 1 ELSE 0 END), 0) AS missing_relationship,
             COALESCE(SUM(CASE WHEN qualified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opportunities,
             COALESCE(SUM(CASE WHEN qualified_at IS NOT NULL AND
                 (amount IS NULL OR expected_close_at IS NULL OR next_step IS NULL) THEN 1 ELSE 0 END), 0)
                 AS incomplete_opportunities
           FROM prospects WHERE project_id=?""",
        (project_row["id"],),
    ).fetchone()
    values = row_dict(counts) or {}
    checks = [
        {"key": "currency", "complete": bool(settings.get("currency")), "message": "Set the default forecast currency."},
        {"key": "target", "complete": settings.get("target_amount") is not None and bool(settings.get("target_period")),
         "message": "Set a revenue target and target period."},
        {"key": "owner", "complete": bool(settings.get("default_owner")) or values["missing_owner"] == 0,
         "message": "Set a default owner or assign every active prospect."},
        {"key": "pipeline", "complete": values["prospects"] > 0, "message": "Add the first prospect."},
        {"key": "forecast_data", "complete": values["incomplete_opportunities"] == 0,
         "message": "Complete amount, close date, and next step for qualified opportunities."},
    ]
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "settings": settings,
        "changed": changed,
        "checks": checks,
        "complete": all(item["complete"] for item in checks),
        "counts": values,
        "next_steps": [item["message"] for item in checks if not item["complete"]],
    }


def qualify_opportunity(conn: sqlite3.Connection, prospect_id: str, actor: str,
                        amount: float, expected_close_at: str, next_step: str,
                        currency: str | None = None, forecast_category: str = "pipeline",
                        probability: int | None = None, next_step_due_at: str | None = None,
                        expected_version: int | None = None) -> dict:
    """Mark a prospect as forecastable while preserving its existing pipeline stage."""
    current = get_prospect(conn, prospect_id)
    settings = _project_settings(resolve_project(conn, current["project_id"]))
    if amount < 0:
        raise CRMError("Opportunity amount cannot be negative.")
    if forecast_category not in {"pipeline", "best_case", "commit"}:
        raise CRMError("Open opportunity forecast category must be pipeline, best_case, or commit.")
    stage_probabilities = {
        "identified": 5, "researching": 10, "qualified": 25,
        "ready_to_contact": 30, "contacted": 40, "replied": 55,
        "meeting_booked": 75,
    }
    source = "manual" if probability is not None else "stage_default"
    probability = probability if probability is not None else stage_probabilities.get(current["stage"], 25)
    fields = {
        "amount": amount,
        "currency": currency or settings.get("currency") or "USD",
        "expected_close_at": expected_close_at,
        "forecast_category": forecast_category,
        "probability": probability,
        "probability_source": source,
        "next_step": next_step,
        "next_step_due_at": next_step_due_at,
        "qualified_at": current.get("qualified_at") or now(),
    }
    return update_prospect(conn, prospect_id, actor, fields, expected_version)


def forecast(conn: sqlite3.Connection, project: str, period: str | None = None) -> dict:
    project_row = resolve_project(conn, project)
    settings = _project_settings(project_row)
    period, start, end = _period_bounds(period or settings.get("target_period"))
    all_rows = [row_dict(row) or {} for row in conn.execute(
        """SELECT p.id, p.name, p.amount, p.currency, p.expected_close_at,
                  p.forecast_category, p.probability, p.probability_source,
                  p.next_step, p.next_step_due_at, p.close_date_changed_count,
                  p.owner, p.qualified_at, p.last_contacted_at,
                  s.key AS stage, s.terminal, s.outcome, c.name AS company_name
           FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
           LEFT JOIN companies c ON c.id=p.company_id
           WHERE p.project_id=? AND p.qualified_at IS NOT NULL""",
        (project_row["id"],),
    )]
    rows = [
        row for row in all_rows
        if row.get("expected_close_at") and start <= row["expected_close_at"] < end
    ]
    forecast_currency = settings.get("currency") or (rows[0].get("currency") if rows else "USD")
    currency_mismatches = [
        {"id": row["id"], "name": row["name"], "currency": row.get("currency")}
        for row in rows if row.get("currency") != forecast_currency
    ]
    comparable_rows = [row for row in rows if row.get("currency") == forecast_currency]
    open_rows = [row for row in comparable_rows if not row["terminal"]]
    won_rows = [row for row in comparable_rows if row["outcome"] == "won"]
    open_pipeline = sum(row.get("amount") or 0 for row in open_rows)
    weighted = sum((row.get("amount") or 0) * (row.get("probability") or 0) / 100 for row in open_rows)
    commit = sum(row.get("amount") or 0 for row in open_rows if row.get("forecast_category") == "commit")
    best_case = sum(row.get("amount") or 0 for row in open_rows if row.get("forecast_category") in {"commit", "best_case"})
    closed_won = sum(row.get("amount") or 0 for row in won_rows)
    target = settings.get("target_amount") if settings.get("target_period") == period else None
    missing = [
        {"id": row["id"], "name": row["name"],
         "missing": [key for key in ("amount", "expected_close_at", "next_step", "probability") if row.get(key) is None]}
        for row in all_rows
        if any(row.get(key) is None for key in ("amount", "expected_close_at", "next_step", "probability"))
    ]
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "period": period,
        "currency": forecast_currency,
        "target": target,
        "closed_won": closed_won,
        "open_pipeline": open_pipeline,
        "weighted_forecast": round(weighted, 2),
        "best_case": best_case,
        "commit": commit,
        "pipeline_coverage": round(open_pipeline / target, 2) if target else None,
        "commit_attainment": round((closed_won + commit) / target, 2) if target else None,
        "opportunities": rows,
        "missing_data": missing,
        "excluded_currency_mismatches": currency_mismatches,
    }


def conversion_report(conn: sqlite3.Connection, project: str) -> dict:
    project_row = resolve_project(conn, project)
    stages = [row_dict(row) or {} for row in conn.execute(
        "SELECT * FROM pipeline_stages WHERE project_id=? ORDER BY position", (project_row["id"],)
    )]
    created = conn.execute(
        "SELECT COUNT(*) FROM prospects WHERE project_id=?", (project_row["id"],)
    ).fetchone()[0]
    transitions = {
        stage["key"]: conn.execute(
            """SELECT COUNT(DISTINCT entity_id) FROM activities
               WHERE project_id=? AND entity_type='prospect' AND action='stage_changed'
                 AND json_extract(details_json, '$.to')=?""",
            (project_row["id"], stage["key"]),
        ).fetchone()[0]
        for stage in stages
    }
    transitions["identified"] = max(transitions.get("identified", 0), created)
    ordered = [stage for stage in stages if stage["key"] not in {"lost", "not_a_fit", "do_not_contact"}]
    stage_metrics = []
    previous = None
    for stage in ordered:
        reached = transitions.get(stage["key"], 0)
        stage_metrics.append({
            "stage": stage["key"],
            "reached": reached,
            "conversion_from_previous": round(reached / previous, 3) if previous else None,
            "conversion_from_created": round(reached / created, 3) if created else None,
        })
        previous = reached
    won = transitions.get("won", 0)
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "prospects_created": created,
        "won": won,
        "overall_win_rate": round(won / created, 3) if created else None,
        "stages": stage_metrics,
        "sample_warning": "Conversion rates are directional until enough historical stage transitions exist." if created < 30 else None,
    }


def pipeline_risks(conn: sqlite3.Connection, project: str, create_tasks: bool = False,
                   actor: str | None = None, stale_days: int | None = None) -> dict:
    project_row = resolve_project(conn, project)
    settings = _project_settings(project_row)
    stale_days = stale_days or settings.get("stale_days") or 30
    timestamp = now()
    stale_cutoff = (datetime.now(UTC) - timedelta(days=stale_days)).isoformat(timespec="seconds")
    prospects = [row_dict(row) or {} for row in conn.execute(
        """SELECT p.*, s.key AS stage, s.terminal, c.full_name AS contact_name,
                  c.email, c.phone, co.name AS company_name
           FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
           LEFT JOIN contacts c ON c.id=p.contact_id
           LEFT JOIN companies co ON co.id=p.company_id
           WHERE p.project_id=? AND s.terminal=0""",
        (project_row["id"],),
    )]
    risks = []

    def add(prospect: dict, kind: str, severity: str, message: str, action_text: str) -> None:
        risks.append({
            "kind": kind, "severity": severity, "prospect_id": prospect["id"],
            "prospect_name": prospect["name"], "stage": prospect["stage"],
            "amount": prospect.get("amount"), "message": message,
            "recommended_action": action_text,
        })

    for item in prospects:
        open_task = conn.execute(
            "SELECT 1 FROM tasks WHERE prospect_id=? AND status='open' LIMIT 1", (item["id"],)
        ).fetchone()
        if not item.get("owner"):
            add(item, "missing_owner", "high", "Active prospect has no owner.", "Assign an accountable owner.")
        if not open_task and not item.get("next_contact_at") and not item.get("next_step_due_at"):
            add(item, "no_next_action", "high", "No open task or scheduled next action.", "Schedule the next concrete step.")
        if item.get("next_step_due_at") and item["next_step_due_at"] < timestamp:
            add(item, "overdue_next_step", "critical", "The opportunity next step is overdue.", item.get("next_step") or "Review the opportunity.")
        if item.get("expected_close_at") and item["expected_close_at"] < timestamp:
            add(item, "expired_close_date", "critical", "Expected close date is in the past.", "Re-qualify or close the opportunity.")
        if item["updated_at"] < stale_cutoff:
            add(item, "stale", "medium", f"No CRM update in at least {stale_days} days.", "Review status and schedule a next step.")
        if item["stage"] == "ready_to_contact" and not (item.get("email") or item.get("phone")):
            add(item, "not_contactable", "high", "Ready-to-contact prospect has no email or phone.", "Enrich the contact record.")
        if item.get("qualified_at") and any(item.get(key) is None for key in ("amount", "expected_close_at", "next_step")):
            add(item, "incomplete_forecast", "high", "Qualified opportunity is missing forecast evidence.", "Add amount, close date, and next step.")
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    risks.sort(key=lambda item: (severity_order[item["severity"]], -(item.get("amount") or 0), item["prospect_name"]))
    created_task_ids = []
    if create_tasks:
        actor = require_actor(actor)
        for risk in risks:
            title = f"CRM risk: {risk['recommended_action']}"
            exists = conn.execute(
                "SELECT id FROM tasks WHERE prospect_id=? AND status='open' AND title=?",
                (risk["prospect_id"], title),
            ).fetchone()
            if not exists:
                task = create_task(
                    conn, project, actor, title, prospect_id=risk["prospect_id"],
                    priority="urgent" if risk["severity"] == "critical" else "high",
                )
                created_task_ids.append(task["id"])
    return {
        "project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
        "generated_at": timestamp,
        "risks": risks,
        "counts": {severity: sum(1 for item in risks if item["severity"] == severity)
                   for severity in ("critical", "high", "medium", "low")},
        "created_task_ids": created_task_ids,
    }


def cro_review(conn: sqlite3.Connection, project: str, period: str | None = None) -> dict:
    forecast_data = forecast(conn, project, period)
    risk_data = pipeline_risks(conn, project)
    findings = []
    for risk in risk_data["risks"]:
        if risk["severity"] in {"critical", "high"}:
            findings.append({
                "severity": risk["severity"],
                "finding": risk["message"],
                "evidence": {"prospect_id": risk["prospect_id"], "prospect_name": risk["prospect_name"],
                             "amount": risk.get("amount"), "stage": risk["stage"]},
                "recommended_action": risk["recommended_action"],
            })
    target = forecast_data.get("target")
    if target and forecast_data["pipeline_coverage"] < 3:
        findings.append({
            "severity": "critical" if forecast_data["pipeline_coverage"] < 1 else "high",
            "finding": "Open pipeline coverage is below 3x target.",
            "evidence": {"target": target, "open_pipeline": forecast_data["open_pipeline"],
                         "coverage": forecast_data["pipeline_coverage"]},
            "recommended_action": "Increase qualified pipeline or revise the forecast.",
        })
    if forecast_data["excluded_currency_mismatches"]:
        findings.append({
            "severity": "high",
            "finding": "Some opportunities were excluded because their currency does not match the project forecast currency.",
            "evidence": {"forecast_currency": forecast_data["currency"],
                         "opportunities": forecast_data["excluded_currency_mismatches"]},
            "recommended_action": "Normalize opportunity currency before relying on the aggregate forecast.",
        })
    commit_rows = [row for row in forecast_data["opportunities"] if row.get("forecast_category") == "commit" and not row["terminal"]]
    engagement_cutoff = (datetime.now(UTC) - timedelta(days=14)).isoformat(timespec="seconds")
    unsupported_commit = [
        row for row in commit_rows
        if not row.get("next_step")
        or row.get("close_date_changed_count", 0) >= 2
        or not row.get("last_contacted_at")
        or row["last_contacted_at"] < engagement_cutoff
    ]
    if unsupported_commit:
        findings.append({
            "severity": "critical",
            "finding": "Commit contains opportunities without credible supporting evidence.",
            "evidence": {"opportunity_count": len(unsupported_commit),
                         "amount": sum(row.get("amount") or 0 for row in unsupported_commit),
                         "prospect_ids": [row["id"] for row in unsupported_commit]},
            "recommended_action": "Re-qualify these opportunities or remove them from commit.",
        })
    slipped = [
        row for row in forecast_data["opportunities"]
        if not row["terminal"] and row.get("close_date_changed_count", 0) >= 2
    ]
    if slipped:
        findings.append({
            "severity": "high",
            "finding": "Multiple opportunity close dates have been pushed at least twice.",
            "evidence": {"opportunity_count": len(slipped),
                         "amount": sum(row.get("amount") or 0 for row in slipped),
                         "prospect_ids": [row["id"] for row in slipped]},
            "recommended_action": "Re-confirm buying process and timing instead of rolling dates forward.",
        })
    open_rows = [row for row in forecast_data["opportunities"] if not row["terminal"]]
    open_amount = sum(row.get("amount") or 0 for row in open_rows)
    if open_amount:
        largest = max(open_rows, key=lambda row: row.get("amount") or 0)
        concentration = (largest.get("amount") or 0) / open_amount
        if concentration >= 0.5:
            findings.append({
                "severity": "high",
                "finding": "The forecast is highly concentrated in one opportunity.",
                "evidence": {"prospect_id": largest["id"], "prospect_name": largest["name"],
                             "amount": largest.get("amount"), "share_of_open_pipeline": round(concentration, 2)},
                "recommended_action": "Build additional qualified coverage and scenario-plan without this deal.",
            })
    findings.sort(key=lambda item: {"critical": 0, "high": 1, "medium": 2, "low": 3}[item["severity"]])
    return {
        "project": forecast_data["project"],
        "period": forecast_data["period"],
        "headline": {
            "target": target,
            "closed_won": forecast_data["closed_won"],
            "commit": forecast_data["commit"],
            "weighted_forecast": forecast_data["weighted_forecast"],
            "pipeline_coverage": forecast_data["pipeline_coverage"],
        },
        "findings": findings,
        "finding_count": len(findings),
        "verdict": "at_risk" if any(item["severity"] == "critical" for item in findings) else
                   ("needs_attention" if findings else "healthy"),
    }


def sdr_queue(conn: sqlite3.Connection, project: str, limit: int = 25) -> dict:
    project_row = resolve_project(conn, project)
    rows = [row_dict(row) or {} for row in conn.execute(
        """SELECT p.id, p.name, p.stage_id, p.fit_score, p.priority, p.source_url,
                  p.pain_points, p.qualification_notes, p.last_contacted_at,
                  s.key AS stage, c.full_name AS contact_name, c.email, c.phone,
                  c.title, co.name AS company_name, co.domain, co.industry
           FROM prospects p JOIN pipeline_stages s ON s.id=p.stage_id
           LEFT JOIN contacts c ON c.id=p.contact_id
           LEFT JOIN companies co ON co.id=p.company_id
           WHERE p.project_id=? AND s.terminal=0
             AND s.key IN ('identified','researching','qualified','ready_to_contact')""",
        (project_row["id"],),
    )]
    queue = []
    for item in rows:
        completeness = sum(bool(item.get(key)) for key in
                           ("company_name", "domain", "contact_name", "title", "email", "pain_points", "source_url"))
        contactable = bool(item.get("email") or item.get("phone"))
        score = (item.get("fit_score") or 0) + completeness * 5 + (15 if contactable else 0)
        missing = [label for key, label in (
            ("company_name", "company"), ("domain", "company domain"), ("contact_name", "contact"),
            ("title", "contact title"), ("email", "email"), ("pain_points", "pain hypothesis"),
            ("source_url", "source"),
        ) if not item.get(key)]
        queue.append({
            **item, "score": min(score, 100), "research_completeness": round(completeness / 7, 2),
            "contactable": contactable, "missing": missing,
            "recommended_action": "prepare_outreach" if contactable and completeness >= 5 else "enrich",
        })
    queue.sort(key=lambda item: (-item["score"], item["name"]))
    return {"project": {"id": project_row["id"], "slug": project_row["slug"], "name": project_row["name"]},
            "queue": queue[:min(max(limit, 1), 100)], "count": min(len(queue), limit)}


def research_brief(conn: sqlite3.Connection, prospect_id: str) -> dict:
    prospect = get_prospect(conn, prospect_id)
    sourced_notes = [note for note in prospect["notes"] if note.get("source_url")]
    unsourced_notes = [note for note in prospect["notes"] if not note.get("source_url")]
    missing = [label for key, label in (
        ("company_name", "company"), ("contact_name", "contact"), ("source_url", "prospect source"),
        ("pain_points", "pain hypothesis"), ("needs", "needs"), ("authority", "buying authority"),
        ("timing", "timing"),
    ) if not prospect.get(key)]
    return {
        "prospect": {key: prospect.get(key) for key in
                     ("id", "name", "stage", "company_name", "contact_name", "fit_score", "source_url")},
        "verified_facts": sourced_notes,
        "unsourced_context": unsourced_notes,
        "missing_information": missing,
        "research_questions": [f"Find and verify: {item}." for item in missing],
        "ready_for_outreach": not any(item in missing for item in ("company", "contact", "pain hypothesis")),
    }


def outreach_brief(conn: sqlite3.Connection, prospect_id: str) -> dict:
    prospect = get_prospect(conn, prospect_id)
    research = research_brief(conn, prospect_id)
    prior = prospect["interactions"][:5]
    missing = []
    if not prospect.get("contact_name"):
        missing.append("contact")
    if not prospect.get("pain_points"):
        missing.append("pain hypothesis")
    return {
        "prospect": research["prospect"],
        "recommended_angle": prospect.get("pain_points") or prospect.get("needs"),
        "qualification_context": prospect.get("qualification_notes"),
        "suggested_channel": "email" if prospect.get("contact_email") else
                             ("call" if prospect.get("contact_phone") else "research"),
        "prior_interactions": prior,
        "verified_facts": research["verified_facts"],
        "missing_prerequisites": missing,
        "ready": not missing and not prospect.get("do_not_contact"),
        "safety_note": "This brief prepares outreach context; Agent CRM does not send messages.",
    }


def search(conn: sqlite3.Connection, project: str, query: str, limit: int = 50) -> dict:
    project_id = resolve_project(conn, project)["id"]
    pattern = f"%{query}%"
    companies = [row_dict(r) for r in conn.execute("SELECT * FROM companies WHERE project_id=? AND (name LIKE ? OR domain LIKE ? OR description LIKE ?) LIMIT ?", (project_id, pattern, pattern, pattern, limit))]
    contacts = [row_dict(r) for r in conn.execute("SELECT * FROM contacts WHERE project_id=? AND (full_name LIKE ? OR email LIKE ? OR title LIKE ?) LIMIT ?", (project_id, pattern, pattern, pattern, limit))]
    prospects = [row_dict(r) for r in conn.execute("SELECT * FROM prospects WHERE project_id=? AND (name LIKE ? OR pain_points LIKE ? OR qualification_notes LIKE ?) LIMIT ?", (project_id, pattern, pattern, pattern, limit))]
    notes = [row_dict(r) for r in conn.execute("SELECT * FROM notes WHERE project_id=? AND body LIKE ? LIMIT ?", (project_id, pattern, limit))]
    return {"companies": companies, "contacts": contacts, "prospects": prospects, "notes": notes}


def timeline(conn: sqlite3.Connection, entity_type: str, entity_id: str, limit: int = 100) -> list[dict]:
    return [row_dict(r) for r in conn.execute(
        "SELECT * FROM activities WHERE entity_type=? AND entity_id=? ORDER BY occurred_at DESC, id DESC LIMIT ?",
        (entity_type, entity_id, min(max(limit, 1), 1000)),
    )]
