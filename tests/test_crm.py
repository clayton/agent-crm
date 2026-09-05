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

    def test_contact_phone_accepts_only_valid_us_numbers(self) -> None:
        contact = service.create_contact(
            self.conn, "imago", "Jane Buyer", "codex", phone="(602) 234-5678",
        )
        self.assertEqual(contact["phone"], "+16022345678")
        with self.assertRaisesRegex(service.CRMError, "valid US number"):
            service.update_contact(self.conn, contact["id"], "codex", {"phone": "+11373853860"})
        with self.assertRaisesRegex(service.CRMError, "valid US number"):
            service.create_contact(self.conn, "imago", "UK Contact", "codex", phone="+442071838750")
        self.assertEqual(service.get_contact(self.conn, contact["id"])["phone"], "+16022345678")

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

    def test_next_actions_ranks_tasks_and_fills_with_stale_prospects(self) -> None:
        prospect = service.create_prospect(
            self.conn, "imago", "Acme follow-up", "codex",
            owner="buzz:outreach", priority="high",
        )
        past = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
        future = (datetime.now(UTC) + timedelta(days=2)).isoformat(timespec="seconds")
        service.create_task(
            self.conn, "imago", "codex", "Overdue call", due_at=past,
            prospect_id=prospect["id"], assigned_to="buzz:outreach",
        )
        service.create_task(
            self.conn, "imago", "codex", "Upcoming research", due_at=future,
            assigned_to="buzz:outreach", priority="high",
        )
        stale = service.create_prospect(
            self.conn, "imago", "Quiet account", "codex",
            owner="buzz:outreach",
        )
        old = (datetime.now(UTC) - timedelta(days=45)).isoformat(timespec="seconds")
        self.conn.execute("UPDATE prospects SET updated_at=? WHERE id=?", (old, stale["id"]))
        self.conn.commit()

        result = service.next_actions(self.conn, "imago", "buzz:outreach", limit=3)

        self.assertEqual(result["count"], 3)
        self.assertEqual(result["actions"][0]["title"], "Overdue call")
        self.assertIn("overdue", result["actions"][0]["why_now"])
        self.assertTrue(any(item["prospect_name"] == "Quiet account" for item in result["actions"]))

    def test_pipeline_groups_prospects_in_stage_order(self) -> None:
        service.create_prospect(
            self.conn, "imago", "First lead", "codex",
            custom={"signal_tier": "C", "priority_weight": 50},
        )
        qualified = service.create_prospect(self.conn, "imago", "Qualified lead", "codex")
        service.transition_prospect(self.conn, qualified["id"], "researching", "codex")
        service.transition_prospect(self.conn, qualified["id"], "qualified", "codex")

        result = service.pipeline(self.conn, "imago")

        self.assertEqual(result["stages"][0]["key"], "identified")
        self.assertEqual(result["stages"][0]["count"], 1)
        self.assertEqual(result["stages"][0]["prospects"][0]["signal_tier"], "C")
        self.assertEqual(result["stages"][0]["prospects"][0]["priority_weight"], 50)
        self.assertEqual(result["stages"][2]["key"], "qualified")
        self.assertEqual(result["stages"][2]["prospects"][0]["name"], "Qualified lead")
        self.assertFalse(any(stage["terminal"] for stage in result["stages"]))
        self.assertEqual(service.pipeline(self.conn, "imago", True)["stages"][-1]["key"], "do_not_contact")

    def test_bootstrap_is_rerunnable_and_reports_readiness(self) -> None:
        first = service.bootstrap(
            self.conn, "imago", "codex", target_amount=100_000,
            target_period="2026-Q3", currency="USD", default_owner="codex",
        )
        second = service.bootstrap(
            self.conn, "imago", "codex", target_amount=100_000,
            target_period="2026-Q3", currency="USD", default_owner="codex",
        )
        self.assertEqual(first["changed"]["target_amount"], 100_000)
        self.assertEqual(second["changed"], {})
        self.assertEqual(second["settings"]["currency"], "USD")
        self.assertIn("Add the first prospect.", second["next_steps"])

    def test_forecast_and_close_date_push_tracking(self) -> None:
        service.bootstrap(
            self.conn, "imago", "codex", target_amount=100_000,
            target_period="2026-Q3", currency="USD",
        )
        prospect = service.create_prospect(self.conn, "imago", "Forecastable", "codex")
        qualified = service.qualify_opportunity(
            self.conn, prospect["id"], "codex", 25_000,
            "2026-08-15T00:00:00+00:00", "Schedule decision call",
            forecast_category="commit", probability=80,
        )
        self.assertEqual(qualified["qualified_at"][:4], str(datetime.now(UTC).year))
        service.update_prospect(
            self.conn, prospect["id"], "codex",
            {"expected_close_at": "2026-09-01T00:00:00+00:00"},
            expected_version=qualified["version"],
        )
        result = service.forecast(self.conn, "imago", "2026-Q3")
        self.assertEqual(result["open_pipeline"], 25_000)
        self.assertEqual(result["weighted_forecast"], 20_000)
        self.assertEqual(result["commit"], 25_000)
        self.assertEqual(result["pipeline_coverage"], 0.25)
        self.assertEqual(result["opportunities"][0]["close_date_changed_count"], 1)

    def test_pipeline_risks_and_task_creation_are_idempotent(self) -> None:
        prospect = service.create_prospect(self.conn, "imago", "Uncovered", "codex")
        first = service.pipeline_risks(self.conn, "imago", create_tasks=True, actor="codex")
        second = service.pipeline_risks(self.conn, "imago", create_tasks=True, actor="codex")
        self.assertTrue(any(item["kind"] == "missing_owner" for item in first["risks"]))
        self.assertTrue(any(item["kind"] == "no_next_action" for item in first["risks"]))
        self.assertGreaterEqual(len(first["created_task_ids"]), 1)
        self.assertEqual(second["created_task_ids"], [])
        open_tasks = service.get_prospect(self.conn, prospect["id"])["open_tasks"]
        self.assertEqual(len(open_tasks), len(first["created_task_ids"]))

    def test_cro_review_challenges_low_coverage_and_unsupported_commit(self) -> None:
        service.bootstrap(
            self.conn, "imago", "codex", target_amount=100_000,
            target_period="2026-Q3", currency="USD",
        )
        prospect = service.create_prospect(self.conn, "imago", "Optimistic", "codex", owner="codex")
        service.qualify_opportunity(
            self.conn, prospect["id"], "codex", 10_000,
            "2026-08-15T00:00:00+00:00", "Initial next step",
            forecast_category="commit",
        )
        service.update_prospect(self.conn, prospect["id"], "codex", {"next_step": None})
        review = service.cro_review(self.conn, "imago", "2026-Q3")
        self.assertEqual(review["verdict"], "at_risk")
        self.assertTrue(any("coverage" in item["finding"] for item in review["findings"]))
        self.assertTrue(any("Commit" in item["finding"] for item in review["findings"]))

    def test_sdr_queue_and_briefs_separate_sourced_context(self) -> None:
        company = service.create_company(self.conn, "imago", "Acme", "codex", domain="acme.example")
        contact = service.create_contact(
            self.conn, "imago", "Jane Buyer", "codex", company_id=company["id"],
            email="jane@acme.example", title="VP Sales",
        )
        prospect = service.create_prospect(
            self.conn, "imago", "Acme revenue team", "codex",
            company_id=company["id"], contact_id=contact["id"], fit_score=90,
            pain_points="Forecast calls are unreliable", source_url="https://acme.example",
            custom={"signal_tier": "B", "priority_weight": 72},
        )
        service.add_note(
            self.conn, "imago", "codex", "Hiring revenue operations staff.",
            prospect_id=prospect["id"], kind="research", source_url="https://acme.example/jobs",
        )
        queue = service.sdr_queue(self.conn, "imago")
        research = service.research_brief(self.conn, prospect["id"])
        outreach = service.outreach_brief(self.conn, prospect["id"])
        self.assertEqual(queue["queue"][0]["recommended_action"], "prepare_outreach")
        self.assertEqual(queue["queue"][0]["signal_tier"], "B")
        self.assertEqual(queue["queue"][0]["priority_weight"], 72)
        self.assertEqual(len(research["verified_facts"]), 1)
        self.assertTrue(outreach["ready"])
        self.assertEqual(outreach["suggested_channel"], "email")

    def test_public_business_route_can_make_account_ready_without_named_contact(self) -> None:
        company = service.create_company(self.conn, "imago", "Route Co", "codex", domain="route.example")
        prospect = service.create_prospect(
            self.conn, "imago", "Route test", "codex", company_id=company["id"],
            source_url="https://route.example/about", pain_points="A recurring workflow may exist.",
            custom={"signal_tier": "C", "priority_weight": 50,
                    "public_business_route": "https://route.example/contact"},
        )

        queue = service.sdr_queue(self.conn, "imago")
        research = service.research_brief(self.conn, prospect["id"])
        outreach = service.outreach_brief(self.conn, prospect["id"])

        self.assertTrue(queue["queue"][0]["contactable"])
        self.assertEqual(queue["queue"][0]["recommended_action"], "prepare_outreach")
        self.assertTrue(research["ready_for_outreach"])
        self.assertTrue(outreach["ready"])
        self.assertEqual(outreach["suggested_channel"], "business_route")

    def test_experiment_report_groups_logged_feedback_by_signal_cohort(self) -> None:
        company = service.create_company(self.conn, "imago", "Acme", "codex", domain="acme.example")
        prospect = service.create_prospect(
            self.conn, "imago", "Acme test", "codex", company_id=company["id"],
            custom={"experiment_id": "test-30", "cohort": "B", "signal_tier": "B", "priority_weight": 70},
        )
        service.log_interaction(
            self.conn, "imago", "codex", "email", "outbound", "Sent test",
            prospect_id=prospect["id"], outcome="sent",
        )
        service.log_interaction(
            self.conn, "imago", "codex", "email", "inbound", "Confirmed recurring intake work",
            prospect_id=prospect["id"], outcome="workflow_confirmed",
        )

        report = service.experiment_report(self.conn, "imago", "test-30")

        self.assertEqual(report["accounts"], 1)
        self.assertEqual(report["cohorts"]["B"]["contacted"], 1)
        self.assertEqual(report["cohorts"]["B"]["replied"], 1)
        self.assertEqual(report["cohorts"]["B"]["workflow_confirmed"], 1)

    def test_conversion_report_uses_stage_history(self) -> None:
        prospect = service.create_prospect(self.conn, "imago", "Converted", "codex")
        service.transition_prospect(self.conn, prospect["id"], "researching", "codex")
        result = service.conversion_report(self.conn, "imago")
        researching = next(item for item in result["stages"] if item["stage"] == "researching")
        self.assertEqual(result["prospects_created"], 1)
        self.assertEqual(researching["reached"], 1)
        self.assertEqual(researching["conversion_from_previous"], 1.0)


if __name__ == "__main__":
    unittest.main()
