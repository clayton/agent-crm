#!/usr/bin/env python3
"""Export CRM data from SQLite for D1 import (data-only, FK order)."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


TABLES = [
    "projects",
    "pipeline_stages",
    "stage_transitions",
    "companies",
    "contacts",
    "prospects",
    "notes",
    "tasks",
    "interactions",
    "enrichment_attempts",
    "activities",
]


def backup_db(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(source)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()


def export_data(conn: sqlite3.Connection) -> list[str]:
    lines: list[str] = []
    for table in TABLES:
        rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        if not rows:
            continue
        cols = [d[0] for d in conn.execute(f"SELECT * FROM {table} LIMIT 0").description]
        for row in rows:
            values = []
            for value in row:
                if value is None:
                    values.append("NULL")
                elif isinstance(value, (int, float)):
                    values.append(str(value))
                else:
                    escaped = str(value).replace("'", "''")
                    values.append(f"'{escaped}'")
            lines.append(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join(values)});")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="Export SQLite CRM data for D1 import")
    parser.add_argument("--db", type=Path, required=True, help="Source SQLite path")
    parser.add_argument("--output", type=Path, required=True, help="Output .sql file")
    parser.add_argument("--backup", type=Path, help="Optional consistent backup path")
    args = parser.parse_args()

    if args.backup:
        backup_db(args.db, args.backup)

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        lines = export_data(conn)
    finally:
        conn.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "statements": len(lines)}, indent=2))


if __name__ == "__main__":
    main()
