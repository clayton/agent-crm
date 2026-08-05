from __future__ import annotations

import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import service
from .db import connect_readonly, database_path


ASSETS = files("agent_crm.dashboard_assets")


def dashboard_data(conn, project: str | None = None, include_terminal: bool = False) -> dict[str, Any]:
    """Build the shared read model used by live and exported dashboards."""
    projects = service.list_projects(conn)
    if project:
        selected = service.resolve_project(conn, project)
        projects = [row for row in projects if row["id"] == selected["id"]]

    results = []
    for project_row in projects:
        slug = project_row["slug"]
        pipeline = service.pipeline(conn, slug, include_terminal)
        risks = service.pipeline_risks(conn, slug)["risks"]
        actions = service.next_actions(conn, slug)["actions"]
        prospect_ids = [
            prospect["id"]
            for stage in pipeline["stages"]
            for prospect in stage["prospects"]
        ]
        details = {}
        for prospect_id in prospect_ids:
            detail = service.get_prospect(conn, prospect_id)
            detail["timeline"] = service.timeline(conn, "prospect", prospect_id, 50)
            details[prospect_id] = detail
        results.append({
            "project": {
                "id": project_row["id"],
                "slug": slug,
                "name": project_row["name"],
                "description": project_row.get("description"),
                "settings": project_row.get("settings") or {},
            },
            "pipeline": pipeline,
            "actions": actions,
            "risks": risks,
            "forecast": service.forecast(conn, slug),
            "prospect_details": details,
        })
    return {
        "generated_at": service.now(),
        "read_only": True,
        "includes_terminal_stages": include_terminal,
        "selected_project": project,
        "projects": results,
    }


def _asset(name: str) -> str:
    return ASSETS.joinpath(name).read_text(encoding="utf-8")


def render_live_page() -> str:
    return (
        _asset("index.html")
        .replace("<!-- CRM_STYLES -->", '<link rel="stylesheet" href="/styles.css">')
        .replace("<!-- CRM_DATA -->", '<script id="crm-data" type="application/json">null</script>')
        .replace("<!-- CRM_SCRIPT -->", '<script src="/app.js" defer></script>')
    )


def render_snapshot(data: dict[str, Any]) -> str:
    safe_json = json.dumps(data, sort_keys=True).replace("<", "\\u003c")
    return (
        _asset("index.html")
        .replace("<!-- CRM_STYLES -->", f"<style>{_asset('styles.css')}</style>")
        .replace("<!-- CRM_DATA -->", f'<script id="crm-data" type="application/json">{safe_json}</script>')
        .replace("<!-- CRM_SCRIPT -->", f"<script>{_asset('app.js')}</script>")
    )


def export_dashboard(db: str | Path | None, output: str | Path, project: str | None = None,
                     include_terminal: bool = False) -> dict[str, Any]:
    output_path = Path(output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with connect_readonly(db) as conn:
        data = dashboard_data(conn, project, include_terminal)
    output_path.write_text(render_snapshot(data), encoding="utf-8")
    return {
        "output": str(output_path),
        "projects": len(data["projects"]),
        "generated_at": data["generated_at"],
        "read_only": True,
    }


def create_server(db: str | Path | None, host: str = "127.0.0.1", port: int = 8765,
                  project: str | None = None, include_terminal: bool = False) -> ThreadingHTTPServer:
    db_path = database_path(db).resolve()

    class DashboardHandler(BaseHTTPRequestHandler):
        server_version = "AgentCRM/0.4"

        def _send(self, body: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
            self._send(json.dumps(payload, sort_keys=True).encode(), "application/json; charset=utf-8", status)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
            parsed = urlparse(self.path)
            try:
                if parsed.path == "/":
                    self._send(render_live_page().encode(), "text/html; charset=utf-8")
                    return
                if parsed.path == "/styles.css":
                    self._send(_asset("styles.css").encode(), "text/css; charset=utf-8")
                    return
                if parsed.path == "/app.js":
                    self._send(_asset("app.js").encode(), "text/javascript; charset=utf-8")
                    return
                if parsed.path == "/api/health":
                    self._json({"ok": True, "read_only": True})
                    return
                if parsed.path == "/api/dashboard":
                    query = parse_qs(parsed.query)
                    requested_project = query.get("project", [project])[0]
                    requested_terminal = query.get("include_terminal", [str(include_terminal)])[0].lower() in {"1", "true", "yes"}
                    with connect_readonly(db_path) as conn:
                        self._json(dashboard_data(conn, requested_project, requested_terminal))
                    return
                self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            except (service.CRMError, FileNotFoundError) as exc:
                self._json({"error": str(exc), "type": exc.__class__.__name__}, HTTPStatus.BAD_REQUEST)
            except Exception as exc:  # Keep a malformed record from terminating the server.
                self._json({"error": str(exc), "type": exc.__class__.__name__}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def _read_only(self) -> None:
            self._json({"error": "The dashboard is read-only."}, HTTPStatus.METHOD_NOT_ALLOWED)

        do_POST = _read_only
        do_PUT = _read_only
        do_PATCH = _read_only
        do_DELETE = _read_only

        def log_message(self, format: str, *args: Any) -> None:
            return

    return ThreadingHTTPServer((host, port), DashboardHandler)


def serve_dashboard(db: str | Path | None, host: str = "127.0.0.1", port: int = 8765,
                    project: str | None = None, include_terminal: bool = False) -> None:
    server = create_server(db, host, port, project, include_terminal)
    actual_host, actual_port = server.server_address[:2]
    print(json.dumps({
        "url": f"http://{actual_host}:{actual_port}",
        "database": str(database_path(db).resolve()),
        "read_only": True,
    }, indent=2), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
