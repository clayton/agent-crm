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
PROSPECT_FIELDS = {"contact_id", "company_id", "name", "source", "source_url", "owner", "fit_score", "priority", "pain_points", "needs", "budget", "authority", "timing", "qualification_notes", "do_not_contact", "lost_reason", "last_contacted_at", "next_contact_at", "stale_after"}


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
        """SELECT p.*, s.key AS stage, s.name AS stage_name, c.full_name AS contact_name, co.name AS company_name
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
    clean.update(updated_at=now(), updated_by=actor)
    assignments = [f"{key}=?" for key in clean] + ["version=version+1"]
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
