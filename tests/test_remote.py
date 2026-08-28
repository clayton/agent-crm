"""Tests for remote CRM client (offline, no network)."""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from agent_crm.cli import run
from agent_crm.remote import RemoteCRMClient, RemoteCRMError, remote_enabled
import argparse


class RemoteClientTest(unittest.TestCase):
    def test_remote_enabled_requires_url(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(remote_enabled())

    def test_client_requires_credentials(self) -> None:
        with patch.dict(os.environ, {"CRM_API_URL": "https://example.test"}, clear=True):
            with self.assertRaisesRegex(RemoteCRMError, "CF_ACCESS_CLIENT_ID"):
                RemoteCRMClient()

    def test_client_builds_from_env(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        with patch.dict(os.environ, env, clear=True):
            client = RemoteCRMClient()
            self.assertEqual(client.base_url, "https://crm-agent.services.c18h.net")

    def test_contact_command_blocked_in_remote_mode(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        args = argparse.Namespace(command="contact", action="enrich", contact_id="con_1")
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "remote mode"):
                run(args)

    def test_init_blocked_in_remote_mode(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        args = argparse.Namespace(command="init", db=None)
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "init is not available"):
                run(args)

    def test_dashboard_export_blocked_in_remote_mode(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        args = argparse.Namespace(
            command="dashboard", action="export", db=None, output="/tmp/out.html",
            project=None, include_terminal=False,
        )
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "dashboard export"):
                run(args)

    def test_dashboard_serve_blocked_in_remote_mode(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        args = argparse.Namespace(
            command="dashboard", action="serve", db=None, host="127.0.0.1", port=8765,
            project=None, include_terminal=False,
        )
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(RuntimeError, "dashboard serve"):
                run(args)

    def test_remote_create_company_passes_extended_fields(self) -> None:
        env = {
            "CRM_API_URL": "https://crm-agent.services.c18h.net",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
        captured: dict = {}

        def fake_request(self, method, path, body=None, *, idempotency_key=None):
            captured["method"] = method
            captured["path"] = path
            captured["body"] = body
            captured["headers"] = {
                "CF-Access-Client-Id": self.client_id,
                "CF-Access-Client-Secret": self.client_secret,
            }
            return {"id": "cmp_test", "name": body["name"], "linkedin_url": body.get("linkedin_url")}

        with patch.dict(os.environ, env, clear=True):
            with patch.object(RemoteCRMClient, "_request", fake_request):
                client = RemoteCRMClient()
                result = client.create_company(
                    "proj",
                    "Acme",
                    linkedin_url="https://linkedin.com/company/acme",
                    employee_count=50,
                    location="SF",
                )
        self.assertEqual(result["linkedin_url"], "https://linkedin.com/company/acme")
        self.assertEqual(captured["body"]["employee_count"], 50)
        self.assertIn("CF-Access-Client-Id", captured["headers"])
