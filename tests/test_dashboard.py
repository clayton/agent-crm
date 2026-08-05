from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from agent_crm import service
from agent_crm.dashboard import create_server, dashboard_data, export_dashboard, render_snapshot
from agent_crm.db import connect, connect_readonly


class DashboardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "test.sqlite3"
        self.conn = connect(self.db_path)
        service.create_project(self.conn, "ImagoProject", "codex", "imago")
        self.company = service.create_company(self.conn, "imago", "Acme <Labs>", "codex")
        self.prospect = service.create_prospect(
            self.conn, "imago", "Acme pipeline", "codex",
            company_id=self.company["id"], fit_score=88, priority="high",
        )
        service.add_note(
            self.conn, "imago", "codex", "Research </script> remains inert.",
            prospect_id=self.prospect["id"], kind="research",
        )
        self.conn.close()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_readonly_connection_rejects_writes(self) -> None:
        with connect_readonly(self.db_path) as conn:
            self.assertEqual(conn.execute("PRAGMA query_only").fetchone()[0], 1)
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("DELETE FROM prospects")
        with connect(self.db_path) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM prospects").fetchone()[0], 1)

    def test_readonly_connection_does_not_create_a_database(self) -> None:
        missing = Path(self.tmp.name) / "missing.sqlite3"
        with self.assertRaises(FileNotFoundError):
            connect_readonly(missing)
        self.assertFalse(missing.exists())

    def test_dashboard_data_contains_attention_pipeline_and_details(self) -> None:
        with connect_readonly(self.db_path) as conn:
            result = dashboard_data(conn, "imago")
        self.assertTrue(result["read_only"])
        self.assertEqual(len(result["projects"]), 1)
        project = result["projects"][0]
        self.assertEqual(project["pipeline"]["total_prospects"], 1)
        self.assertTrue(project["actions"])
        self.assertTrue(project["risks"])
        detail = project["prospect_details"][self.prospect["id"]]
        self.assertEqual(detail["company_name"], "Acme <Labs>")
        self.assertTrue(detail["timeline"])

    def test_snapshot_is_self_contained_and_script_safe(self) -> None:
        with connect_readonly(self.db_path) as conn:
            html = render_snapshot(dashboard_data(conn))
        self.assertIn("<style>", html)
        self.assertIn("<script>(() =>", html)
        self.assertNotIn('href="/styles.css"', html)
        self.assertNotIn("Research </script>", html)
        self.assertIn("Research \\u003c/script>", html)

        output = Path(self.tmp.name) / "snapshot.html"
        result = export_dashboard(self.db_path, output, "imago")
        self.assertEqual(result["projects"], 1)
        self.assertTrue(output.read_text().startswith("<!doctype html>"))

    def test_live_server_serves_data_and_rejects_mutations(self) -> None:
        server = create_server(self.db_path, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with urlopen(f"{base}/api/health") as response:
                self.assertEqual(json.load(response), {"ok": True, "read_only": True})
            with urlopen(f"{base}/api/dashboard?project=imago") as response:
                payload = json.load(response)
                self.assertEqual(payload["projects"][0]["project"]["slug"], "imago")
            with self.assertRaises(HTTPError) as raised:
                urlopen(Request(f"{base}/api/dashboard", method="POST", data=b"{}"))
            self.assertEqual(raised.exception.code, 405)
            self.assertIn("read-only", raised.exception.read().decode())
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
