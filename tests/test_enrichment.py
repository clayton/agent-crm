from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_crm import service
from agent_crm.db import connect


class EnrichmentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = connect(Path(self.tmp.name) / "test.sqlite3")
        service.create_project(self.conn, "Pipeline", "codex", "pipeline")
        self.company = service.create_company(
            self.conn, "pipeline", "Acme", "codex", domain="acme.example",
        )

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def test_resolved_hunter_result_requires_approval_and_does_not_overwrite(self) -> None:
        contact = service.create_contact(
            self.conn, "pipeline", "Jane Buyer", "codex",
            company_id=self.company["id"], first_name="Jane", last_name="Buyer",
        )
        identity = {
            "status": "resolved", "confidence": "high", "first_name": "Jane",
            "last_name": "Buyer", "full_name": "Jane Buyer",
            "evidence_urls": ["https://acme.example/about"],
        }
        hunter = {
            "provider": "hunter", "email": "jane@acme.example", "score": 95,
            "raw_status": "valid", "normalized_status": "verified", "sources": [],
            "latency_ms": 12, "credits": 1,
        }
        with patch("agent_crm.enrichment.resolve_identity", return_value=identity), \
             patch("agent_crm.enrichment.hunter", return_value=hunter):
            attempt = service.enrich_contact(self.conn, contact["id"], "codex")

        self.assertEqual(attempt["status"], "ready")
        self.assertEqual(attempt["review_state"], "pending_approval")
        self.assertEqual(attempt["proposed"]["email"], "j***@acme.example")
        self.assertIsNone(service.get_contact(self.conn, contact["id"])["email"])

        applied = service.apply_contact_enrichment(self.conn, attempt["id"], "codex")
        self.assertEqual(applied["contact"]["email"], "jane@acme.example")
        self.assertEqual(applied["attempt"]["status"], "applied")

    def test_unresolved_identity_stops_before_email_providers(self) -> None:
        contact = service.create_contact(
            self.conn, "pipeline", "Jessica", "codex",
            company_id=self.company["id"], first_name="Jessica",
        )
        identity = {"status": "unresolved", "confidence": "low", "searches": []}
        with patch("agent_crm.enrichment.resolve_identity", return_value=identity), \
             patch("agent_crm.enrichment.hunter") as hunter:
            attempt = service.enrich_contact(self.conn, contact["id"], "codex")

        self.assertEqual(attempt["status"], "unresolved")
        hunter.assert_not_called()

    def test_hunter_miss_falls_back_and_vendor_claim_needs_review(self) -> None:
        contact = service.create_contact(
            self.conn, "pipeline", "Jane Buyer", "codex",
            company_id=self.company["id"], first_name="Jane", last_name="Buyer",
        )
        identity = {
            "status": "resolved", "confidence": "high", "first_name": "Jane",
            "last_name": "Buyer", "full_name": "Jane Buyer",
        }
        miss = {"provider": "hunter", "email": None, "raw_status": None, "normalized_status": "not_found"}
        fallback = {
            "provider": "fullenrich", "email": "jane@acme.example",
            "raw_status": "DELIVERABLE", "normalized_status": "vendor_deliverable",
            "pending": False, "credits": 1,
        }
        with patch("agent_crm.enrichment.resolve_identity", return_value=identity), \
             patch("agent_crm.enrichment.hunter", return_value=miss), \
             patch("agent_crm.enrichment.fullenrich", return_value=fallback):
            attempt = service.enrich_contact(self.conn, contact["id"], "codex")

        self.assertEqual(attempt["status"], "manual_review")
        self.assertEqual(attempt["review_state"], "manual_review")
        self.assertEqual([item["provider"] for item in attempt["providers"]], ["hunter", "fullenrich"])
        with self.assertRaisesRegex(service.CRMError, "manual review"):
            service.apply_contact_enrichment(self.conn, attempt["id"], "codex")
        applied = service.apply_contact_enrichment(
            self.conn, attempt["id"], "codex", approve_manual_review=True,
        )
        self.assertEqual(applied["contact"]["email"], "jane@acme.example")

    def test_existing_conflicting_email_requires_manual_review(self) -> None:
        contact = service.create_contact(
            self.conn, "pipeline", "Jane Buyer", "codex", company_id=self.company["id"],
            first_name="Jane", last_name="Buyer", email="human@acme.example",
        )
        identity = {"status": "resolved", "confidence": "high", "first_name": "Jane", "last_name": "Buyer", "full_name": "Jane Buyer"}
        result = {"provider": "hunter", "email": "vendor@acme.example", "raw_status": "valid"}
        with patch("agent_crm.enrichment.resolve_identity", return_value=identity), \
             patch("agent_crm.enrichment.hunter", return_value=result):
            attempt = service.enrich_contact(self.conn, contact["id"], "codex")

        self.assertEqual(attempt["review_state"], "manual_review")
        with self.assertRaisesRegex(service.CRMError, "manual review"):
            service.apply_contact_enrichment(self.conn, attempt["id"], "codex")
        with self.assertRaisesRegex(service.CRMError, "No safe enrichment fields"):
            service.apply_contact_enrichment(
                self.conn, attempt["id"], "codex", approve_manual_review=True,
            )


if __name__ == "__main__":
    unittest.main()
