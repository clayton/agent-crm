from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agent_crm import cli


class CLITest(unittest.TestCase):
    def test_company_create_passes_name_and_actor_separately(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "test.sqlite3"
            cli.run(cli.parser().parse_args([
                "--db", str(database), "project", "create", "Imago", "--slug", "imago", "--actor", "codex",
            ]))

            company = cli.run(cli.parser().parse_args([
                "--db", str(database), "company", "create", "imago", "Acme Inc",
                "--domain", "acme.example", "--actor", "buzz:knock",
            ]))

            self.assertEqual(company["name"], "Acme Inc")
            self.assertEqual(company["domain"], "acme.example")
            self.assertEqual(company["created_by"], "buzz:knock")


if __name__ == "__main__":
    unittest.main()
