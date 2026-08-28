#!/usr/bin/env python3
"""Fix ACCESS_JWKS_URL in 1Password and Worker secrets (/jwks not /certs)."""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.request

VAULT = "rails"
ITEM = "Agent CRM Cloud OAuth"
CRM_DIR = "/Users/clayton/Tools/crm"


def op_field(label: str) -> str:
    proc = subprocess.run(
        ["op", "item", "get", ITEM, "--vault", VAULT, "--fields", label],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def validate_jwks_url(url: str) -> None:
    with urllib.request.urlopen(url) as resp:
        if resp.status != 200:
            raise RuntimeError(f"JWKS URL returned HTTP {resp.status}")
        ct = resp.headers.get("Content-Type", "")
        if "application/json" not in ct:
            raise RuntimeError("JWKS URL content-type is not application/json")
        doc = json.loads(resp.read())
    if not isinstance(doc.get("keys"), list) or not doc["keys"]:
        raise RuntimeError("JWKS response missing keys array")


def wrangler_secret(name: str, value: str, env: str) -> None:
    proc = subprocess.run(
        ["npx", "wrangler", "secret", "put", name, "--env", env],
        input=value.encode(),
        cwd=CRM_DIR,
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode() or proc.stdout.decode())


def main() -> None:
    auth_url = op_field("ACCESS_AUTHORIZATION_URL")
    if not auth_url.endswith("/authorization"):
        raise RuntimeError("unexpected ACCESS_AUTHORIZATION_URL shape")
    jwks_url = auth_url[: -len("/authorization")] + "/jwks"
    validate_jwks_url(jwks_url)

    subprocess.run(
        ["op", "item", "edit", ITEM, "--vault", VAULT, f"ACCESS_JWKS_URL[text]={jwks_url}"],
        check=True,
        capture_output=True,
    )

    for env in ("staging", "production"):
        wrangler_secret("ACCESS_JWKS_URL", jwks_url, env)

    print(json.dumps({"jwks_url_updated": True, "validated": True}))


if __name__ == "__main__":
    main()
