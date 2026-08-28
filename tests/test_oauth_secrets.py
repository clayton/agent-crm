"""Tests for OAuth secret provisioning script."""
from __future__ import annotations

import os
import subprocess
import unittest
from unittest.mock import patch

# Import after path is set by unittest discovery from repo root
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "set-worker-oauth-secrets.py"
spec = importlib.util.spec_from_file_location("set_worker_oauth_secrets", SCRIPT)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


class OAuthSecretsScriptTest(unittest.TestCase):
    def test_requires_existing_cookie_key_by_default(self) -> None:
        args = mod.argparse.Namespace(rotate_cookie_key=False)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "COOKIE_ENCRYPTION_KEY"):
                mod.resolve_cookie_key(args)

    def test_reuses_env_cookie_key(self) -> None:
        args = mod.argparse.Namespace(rotate_cookie_key=False)
        with patch.dict(os.environ, {"COOKIE_ENCRYPTION_KEY": "abc123"}, clear=True):
            self.assertEqual(mod.resolve_cookie_key(args), "abc123")

    def test_rotate_generates_new_key_without_printing_env(self) -> None:
        args = mod.argparse.Namespace(rotate_cookie_key=True)
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(subprocess, "check_output", return_value=b"deadbeef" * 2):
                key = mod.resolve_cookie_key(args)
        self.assertEqual(key, "deadbeef" * 2)
        self.assertNotIn("deadbeef", os.environ.get("COOKIE_ENCRYPTION_KEY", ""))
