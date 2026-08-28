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
