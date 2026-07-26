from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from typing import Any

from . import service
from .db import connect, database_path


def json_value(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def add_write(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--actor", help="Actor identity; defaults to CRM_ACTOR")


def actor(args: argparse.Namespace) -> str:
    return args.actor or os.environ.get("CRM_ACTOR", "")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="crm", description="Local agent-first CRM")
    root.add_argument("--db", help="SQLite path; defaults to CRM_DB or ~/.codex/memories/agent-crm/crm.sqlite3")
    commands = root.add_subparsers(dest="command", required=True)

    commands.add_parser("init", help="Initialize the database")

    project = commands.add_parser("project")
    project_commands = project.add_subparsers(dest="action", required=True)
    p_create = project_commands.add_parser("create")
    p_create.add_argument("name")
    p_create.add_argument("--slug")
    p_create.add_argument("--description")
    add_write(p_create)
    project_commands.add_parser("list")
    p_get = project_commands.add_parser("get")
    p_get.add_argument("project")

    company = commands.add_parser("company")
    company_commands = company.add_subparsers(dest="action", required=True)
    c_create = company_commands.add_parser("create")
    c_create.add_argument("project")
    c_create.add_argument("name")
    for field in ["domain", "website", "linkedin-url", "industry", "annual-revenue", "location", "description"]:
        c_create.add_argument(f"--{field}")
    c_create.add_argument("--employee-count", type=int)
    c_create.add_argument("--tags", type=json_value, default=[])
    c_create.add_argument("--custom", type=json_value, default={})
    add_write(c_create)
    c_get = company_commands.add_parser("get")
    c_get.add_argument("company_id")
    c_list = company_commands.add_parser("list")
    c_list.add_argument("project")
    c_list.add_argument("--limit", type=int, default=100)
    c_update = company_commands.add_parser("update")
    c_update.add_argument("company_id")
    c_update.add_argument("--fields", type=json_value, required=True)
    add_write(c_update)

    contact = commands.add_parser("contact")
    contact_commands = contact.add_subparsers(dest="action", required=True)
    ct_create = contact_commands.add_parser("create")
    ct_create.add_argument("project")
    ct_create.add_argument("full_name")
    for field in ["company-id", "first-name", "last-name", "email", "phone", "title", "department", "seniority", "linkedin-url", "location"]:
        ct_create.add_argument(f"--{field}")
    ct_create.add_argument("--tags", type=json_value, default=[])
    ct_create.add_argument("--custom", type=json_value, default={})
    add_write(ct_create)
    ct_get = contact_commands.add_parser("get")
    ct_get.add_argument("contact_id")
    ct_list = contact_commands.add_parser("list")
    ct_list.add_argument("project")
    ct_list.add_argument("--limit", type=int, default=100)
    ct_update = contact_commands.add_parser("update")
    ct_update.add_argument("contact_id")
    ct_update.add_argument("--fields", type=json_value, required=True)
    add_write(ct_update)

    prospect = commands.add_parser("prospect")
    prospect_commands = prospect.add_subparsers(dest="action", required=True)
    pr_create = prospect_commands.add_parser("create")
    pr_create.add_argument("project")
    pr_create.add_argument("name")
    pr_create.add_argument("--stage", default="identified")
    for field in ["contact-id", "company-id", "source", "source-url", "owner", "priority", "pain-points", "needs", "budget", "authority", "timing", "qualification-notes", "last-contacted-at", "next-contact-at", "stale-after"]:
        pr_create.add_argument(f"--{field}")
    pr_create.add_argument("--fit-score", type=int)
    pr_create.add_argument("--do-not-contact", action="store_true")
    pr_create.add_argument("--tags", type=json_value, default=[])
    pr_create.add_argument("--custom", type=json_value, default={})
    add_write(pr_create)
    pr_get = prospect_commands.add_parser("get")
    pr_get.add_argument("prospect_id")
    pr_list = prospect_commands.add_parser("list")
    pr_list.add_argument("project")
    pr_list.add_argument("--stage")
    pr_list.add_argument("--owner")
    pr_list.add_argument("--limit", type=int, default=100)
    pr_update = prospect_commands.add_parser("update")
    pr_update.add_argument("prospect_id")
    pr_update.add_argument("--fields", type=json_value, required=True, help="JSON object of fields to change")
    pr_update.add_argument("--expected-version", type=int)
    add_write(pr_update)
    pr_transition = prospect_commands.add_parser("transition")
    pr_transition.add_argument("prospect_id")
    pr_transition.add_argument("stage")
    pr_transition.add_argument("--reason")
    pr_transition.add_argument("--expected-version", type=int)
    add_write(pr_transition)

    note = commands.add_parser("note")
    note_commands = note.add_subparsers(dest="action", required=True)
    n_add = note_commands.add_parser("add")
    n_add.add_argument("project")
    n_add.add_argument("body")
    n_add.add_argument("--prospect-id")
    n_add.add_argument("--contact-id")
    n_add.add_argument("--company-id")
    n_add.add_argument("--kind", default="general")
    n_add.add_argument("--source-url")
    add_write(n_add)

    task = commands.add_parser("task")
    task_commands = task.add_subparsers(dest="action", required=True)
    t_create = task_commands.add_parser("create")
    t_create.add_argument("project")
    t_create.add_argument("title")
    for field in ["due-at", "prospect-id", "contact-id", "company-id", "description", "assigned-to"]:
        t_create.add_argument(f"--{field}")
    t_create.add_argument("--priority", default="normal")
    add_write(t_create)
    t_complete = task_commands.add_parser("complete")
    t_complete.add_argument("task_id")
    add_write(t_complete)

    interaction = commands.add_parser("interaction")
    interaction_commands = interaction.add_subparsers(dest="action", required=True)
    i_log = interaction_commands.add_parser("log")
    i_log.add_argument("project")
    i_log.add_argument("channel", choices=["email", "call", "sms", "linkedin", "meeting", "other"])
    i_log.add_argument("direction", choices=["inbound", "outbound", "internal"])
    i_log.add_argument("summary")
    for field in ["prospect-id", "contact-id", "company-id", "outcome", "occurred-at", "external-ref"]:
        i_log.add_argument(f"--{field}")
    add_write(i_log)
    i_list = interaction_commands.add_parser("list")
    i_list.add_argument("project")
    i_list.add_argument("--prospect-id")
    i_list.add_argument("--channel", choices=["email", "call", "sms", "linkedin", "meeting", "other"])
    i_list.add_argument("--limit", type=int, default=100)

    inbox = commands.add_parser("inbox")
    inbox.add_argument("--project")
    inbox.add_argument("--actor")
    inbox.add_argument("--due-within-days", type=int, default=7)
    inbox.add_argument("--stale-days", type=int, default=30)

    search = commands.add_parser("search")
    search.add_argument("project")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=50)

    timeline = commands.add_parser("timeline")
    timeline.add_argument("entity_type", choices=["project", "company", "contact", "prospect", "task"])
    timeline.add_argument("entity_id")
    timeline.add_argument("--limit", type=int, default=100)
    return root


def compact_fields(args: argparse.Namespace, exclude: set[str]) -> dict:
    return {key: value for key, value in vars(args).items() if key not in exclude and value is not None}


def run(args: argparse.Namespace) -> Any:
    conn = connect(args.db)
    try:
        if args.command == "init":
            return {"database": str(database_path(args.db)), "initialized": True}
        if args.command == "project":
            if args.action == "create":
                return service.create_project(conn, args.name, actor(args), args.slug, args.description)
            if args.action == "list":
                return service.list_projects(conn)
            return service.get_project(conn, args.project)
        if args.command == "company":
            if args.action == "create":
                values = compact_fields(args, {"db", "command", "action", "project", "actor"})
                return service.create_company(conn, args.project, actor(args), **values)
            if args.action == "get":
                return service.get_company(conn, args.company_id)
            if args.action == "list":
                return service.list_companies(conn, args.project, args.limit)
            return service.update_company(conn, args.company_id, actor(args), args.fields)
        if args.command == "contact":
            if args.action == "create":
                values = compact_fields(args, {"db", "command", "action", "project", "actor", "full_name"})
                return service.create_contact(conn, args.project, args.full_name, actor(args), **values)
            if args.action == "get":
                return service.get_contact(conn, args.contact_id)
            if args.action == "list":
                return service.list_contacts(conn, args.project, args.limit)
            return service.update_contact(conn, args.contact_id, actor(args), args.fields)
        if args.command == "prospect":
            if args.action == "create":
                values = compact_fields(args, {"db", "command", "action", "project", "actor", "name", "stage"})
                return service.create_prospect(conn, args.project, args.name, actor(args), args.stage, **values)
            if args.action == "get":
                return service.get_prospect(conn, args.prospect_id)
            if args.action == "list":
                return service.list_prospects(conn, args.project, args.stage, args.owner, args.limit)
            if args.action == "update":
                return service.update_prospect(conn, args.prospect_id, actor(args), args.fields, args.expected_version)
            return service.transition_prospect(conn, args.prospect_id, args.stage, actor(args), args.reason, args.expected_version)
        if args.command == "note":
            values = compact_fields(args, {"db", "command", "action", "project", "actor", "body"})
            return service.add_note(conn, args.project, actor(args), args.body, **values)
        if args.command == "task":
            if args.action == "create":
                values = compact_fields(args, {"db", "command", "action", "project", "actor", "title"})
                return service.create_task(conn, args.project, actor(args), args.title, **values)
            return service.complete_task(conn, args.task_id, actor(args))
        if args.command == "interaction":
            if args.action == "log":
                values = compact_fields(args, {"db", "command", "action", "project", "actor", "channel", "direction", "summary"})
                return service.log_interaction(conn, args.project, actor(args), args.channel, args.direction, args.summary, **values)
            return service.list_interactions(conn, args.project, args.prospect_id, args.channel, args.limit)
        if args.command == "inbox":
            return service.inbox(conn, args.project, args.actor, args.due_within_days, args.stale_days)
        if args.command == "search":
            return service.search(conn, args.project, args.query, args.limit)
        if args.command == "timeline":
            return service.timeline(conn, args.entity_type, args.entity_id, args.limit)
        raise RuntimeError("Unhandled command")
    finally:
        conn.close()


def main() -> None:
    try:
        print(json.dumps(run(parser().parse_args()), indent=2, sort_keys=True))
    except (service.CRMError, sqlite3.IntegrityError) as exc:
        print(json.dumps({"error": str(exc), "type": exc.__class__.__name__}), file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
