from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


# Codex exposes this root to agents even when their current project is elsewhere.
# CRM_DB remains the escape hatch for non-Codex runtimes or a future relocation.
DEFAULT_DB = Path.home() / ".codex" / "memories" / "agent-crm" / "crm.sqlite3"


def database_path(explicit: str | Path | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if value := os.environ.get("CRM_DB"):
        return Path(value).expanduser()
    return DEFAULT_DB


def connect(path: str | Path | None = None) -> sqlite3.Connection:
    db_path = database_path(path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    migrate(conn)
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        conn.executescript(
            """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT,
            settings_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL
        );

        CREATE TABLE pipeline_stages (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
            outcome TEXT CHECK (outcome IN ('won', 'lost', 'disqualified', 'do_not_contact')),
            UNIQUE(project_id, key),
            UNIQUE(project_id, position)
        );

        CREATE TABLE stage_transitions (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
            to_stage_id TEXT NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
            PRIMARY KEY(from_stage_id, to_stage_id)
        );

        CREATE TABLE companies (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            domain TEXT,
            website TEXT,
            linkedin_url TEXT,
            industry TEXT,
            employee_count INTEGER,
            annual_revenue TEXT,
            location TEXT,
            description TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            custom_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            UNIQUE(project_id, domain)
        );

        CREATE TABLE contacts (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
            first_name TEXT,
            last_name TEXT,
            full_name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            title TEXT,
            department TEXT,
            seniority TEXT,
            linkedin_url TEXT,
            location TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            custom_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            UNIQUE(project_id, email)
        );

        CREATE TABLE prospects (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
            company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
            stage_id TEXT NOT NULL REFERENCES pipeline_stages(id),
            name TEXT NOT NULL,
            source TEXT,
            source_url TEXT,
            owner TEXT,
            fit_score INTEGER CHECK (fit_score BETWEEN 0 AND 100),
            priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
            pain_points TEXT,
            needs TEXT,
            budget TEXT,
            authority TEXT,
            timing TEXT,
            qualification_notes TEXT,
            do_not_contact INTEGER NOT NULL DEFAULT 0 CHECK (do_not_contact IN (0, 1)),
            lost_reason TEXT,
            last_contacted_at TEXT,
            next_contact_at TEXT,
            stale_after TEXT,
            tags_json TEXT NOT NULL DEFAULT '[]',
            custom_json TEXT NOT NULL DEFAULT '{}',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL
        );

        CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
            contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
            company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
            kind TEXT NOT NULL DEFAULT 'general',
            body TEXT NOT NULL,
            source_url TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL)
        );

        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
            contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
            company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            description TEXT,
            due_at TEXT,
            priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
            assigned_to TEXT,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
            completed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL
        );

        CREATE TABLE activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            details_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX idx_contacts_project_name ON contacts(project_id, full_name);
        CREATE INDEX idx_companies_project_name ON companies(project_id, name);
        CREATE INDEX idx_prospects_project_stage ON prospects(project_id, stage_id);
        CREATE INDEX idx_prospects_updated ON prospects(project_id, updated_at);
        CREATE INDEX idx_tasks_due ON tasks(project_id, status, due_at);
        CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id, occurred_at);
            """
        )
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        version = 1
    if version < 2:
        conn.executescript(
            """
            CREATE TABLE interactions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                prospect_id TEXT REFERENCES prospects(id) ON DELETE CASCADE,
                contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
                company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
                channel TEXT NOT NULL CHECK (channel IN ('email', 'call', 'sms', 'linkedin', 'meeting', 'other')),
                direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
                outcome TEXT,
                summary TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                external_ref TEXT,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL,
                CHECK (prospect_id IS NOT NULL OR contact_id IS NOT NULL OR company_id IS NOT NULL)
            );
            CREATE INDEX idx_interactions_prospect ON interactions(prospect_id, occurred_at);
            CREATE INDEX idx_interactions_project ON interactions(project_id, occurred_at);
            """
        )
        conn.execute("PRAGMA user_version = 2")
        conn.commit()
        version = 2
    if version < 3:
        conn.executescript(
            """
            ALTER TABLE prospects ADD COLUMN amount REAL;
            ALTER TABLE prospects ADD COLUMN currency TEXT;
            ALTER TABLE prospects ADD COLUMN expected_close_at TEXT;
            ALTER TABLE prospects ADD COLUMN forecast_category TEXT
                CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'closed'));
            ALTER TABLE prospects ADD COLUMN probability INTEGER
                CHECK (probability BETWEEN 0 AND 100);
            ALTER TABLE prospects ADD COLUMN probability_source TEXT
                CHECK (probability_source IN ('manual', 'stage_default', 'historical'));
            ALTER TABLE prospects ADD COLUMN next_step TEXT;
            ALTER TABLE prospects ADD COLUMN next_step_due_at TEXT;
            ALTER TABLE prospects ADD COLUMN qualified_at TEXT;
            ALTER TABLE prospects ADD COLUMN close_date_changed_count INTEGER NOT NULL DEFAULT 0;
            CREATE INDEX idx_prospects_close_date
                ON prospects(project_id, expected_close_at);
            """
        )
        conn.execute("PRAGMA user_version = 3")
        conn.commit()


def row_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    result = dict(row)
    for key, value in list(result.items()):
        if key.endswith("_json") and isinstance(value, str):
            result[key.removesuffix("_json")] = json.loads(value)
            del result[key]
        elif key in {"terminal", "do_not_contact"} and value is not None:
            result[key] = bool(value)
    return result
