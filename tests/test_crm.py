from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

from agent_crm import service
from agent_crm.db import connect


class CRMTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = connect(Path(self.tmp.name) / "test.sqlite3")
        self.project = service.create_project(self.conn, "ImagoProject", "codex", "imago")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def test_full_prospect_workflow_and_timeline(self) -> None:
        company = service.create_company(self.conn, "imago", "Acme", "buzz:researcher", domain="acme.example")
        contact = service.create_contact(self.conn, "imago", "Jane Buyer", "buzz:researcher",
                                         company_id=company["id"], email="jane@acme.example", title="VP Design")
        prospect = service.create_prospect(self.conn, "imago", "Acme design team", "buzz:researcher",
                                           company_id=company["id"], contact_id=contact["id"], fit_score=85)
        updated = service.transition_prospect(self.conn, prospect["id"], "researching", "buzz:researcher",
                                              expected_version=1)
        self.assertEqual(updated["stage"], "researching")
        self.assertEqual(updated["version"], 2)
        service.add_note(self.conn, "imago", "buzz:researcher", "Strong hiring signal",
                         prospect_id=prospect["id"], kind="research", source_url="https://acme.example/jobs")
        interaction = service.log_interaction(self.conn, "imago", "buzz:outreach", "email", "outbound",
                                              "Sent a short discovery email", prospect_id=prospect["id"],
                                              contact_id=contact["id"], outcome="sent")
        self.assertEqual(interaction["channel"], "email")
        refreshed = service.get_prospect(self.conn, prospect["id"])
        self.assertEqual(refreshed["company_name"], "Acme")
        self.assertEqual(refreshed["contact_name"], "Jane Buyer")
        self.assertEqual(len(refreshed["notes"]), 1)
        self.assertEqual(len(refreshed["interactions"]), 1)
        self.assertIsNotNone(refreshed["last_contacted_at"])
        actions = [item["action"] for item in service.timeline(self.conn, "prospect", prospect["id"])]
        self.assertIn("created", actions)
        self.assertIn("stage_changed", actions)
        self.assertIn("note_added", actions)
        self.assertIn("interaction_logged", actions)

    def test_invalid_transition_and_version_conflict(self) -> None:
        prospect = service.create_prospect(self.conn, "imago", "Test", "codex")
        with self.assertRaisesRegex(service.CRMError, "Transition not allowed"):
            service.transition_prospect(self.conn, prospect["id"], "replied", "codex")
        with self.assertRaisesRegex(service.CRMError, "Version conflict"):
            service.update_prospect(self.conn, prospect["id"], "codex", {"priority": "high"}, expected_version=9)

    def test_actor_required(self) -> None:
        with self.assertRaisesRegex(service.CRMError, "actor is required"):
            service.create_company(self.conn, "imago", "No Actor Inc", "")

    def test_project_isolation(self) -> None:
        service.create_project(self.conn, "Other", "codex", "other")
        company = service.create_company(self.conn, "imago", "Same Name", "codex", domain="same.example")
        service.create_company(self.conn, "other", "Same Name", "codex", domain="same.example")
        self.assertEqual(len(service.search(self.conn, "imago", "Same Name")["companies"]), 1)
        self.assertEqual(len(service.search(self.conn, "other", "Same Name")["companies"]), 1)
        with self.assertRaisesRegex(service.CRMError, "Cross-project"):
            service.create_contact(self.conn, "other", "Wrong Project", "codex", company_id=company["id"])

    def test_inbox_surfaces_overdue_due_soon_and_stale(self) -> None:
        prospect = service.create_prospect(self.conn, "imago", "Needs attention", "codex", owner="buzz:outreach")
        past = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
        soon = (datetime.now(UTC) + timedelta(days=1)).isoformat(timespec="seconds")
        service.create_task(self.conn, "imago", "codex", "Past task", due_at=past,
                            prospect_id=prospect["id"], assigned_to="buzz:outreach")
        service.create_task(self.conn, "imago", "codex", "Soon task", due_at=soon,
                            prospect_id=prospect["id"], assigned_to="buzz:outreach")
        old = (datetime.now(UTC) - timedelta(days=45)).isoformat(timespec="seconds")
        self.conn.execute("UPDATE prospects SET updated_at=? WHERE id=?", (old, prospect["id"]))
        self.conn.commit()
        result = service.inbox(self.conn, "imago", "buzz:outreach", due_within_days=7, stale_days=30)
        self.assertEqual(result["counts"], {"overdue": 1, "due_soon": 1, "stale_prospects": 1})


if __name__ == "__main__":
    unittest.main()
