#!/usr/bin/env python3
"""Fetch SaaS OAuth endpoints and set Worker secrets via wrangler + update 1Password."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

ACCOUNT = "e1e48237580e2796c8d53a089e8eab02"
TEAM = "labountylabs.cloudflareaccess.com"
SAAS_ID = "32739999-2b9c-4d46-b428-c0253e8dbb59"
AUD_DASH = "8d7deb0558a4d2fb5ac3b1bdff22141f315b4fb0125f19f8f1d2e8102844b191"
AUD_API = "fc21e9ffc40360ebe9bb6561c20a30510b23b382a4662438fdf9c00470c30ddd"


def cf_get(path: str) -> dict:
    token = os.environ["API_TOKEN"]
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    if not data.get("success"):
        raise RuntimeError(data.get("errors"))
    return data["result"]


def validate_jwks_url(url: str) -> None:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
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
        cwd="/Users/clayton/Tools/crm",
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode() or proc.stdout.decode())


def main() -> None:
    app = cf_get(f"/accounts/{ACCOUNT}/access/apps/{SAAS_ID}")
    saas = app.get("saas_app") or {}
    client_id = saas["client_id"]
    client_secret = saas["client_secret"]
    auth_url = f"https://{TEAM}/cdn-cgi/access/sso/oidc/{client_id}/authorization"
    token_url = f"https://{TEAM}/cdn-cgi/access/sso/oidc/{client_id}/token"
    jwks_url = f"https://{TEAM}/cdn-cgi/access/sso/oidc/{client_id}/jwks"
    validate_jwks_url(jwks_url)

    cookie_key = subprocess.check_output(["openssl", "rand", "-hex", "32"]).decode().strip()
    secrets = {
        "ACCESS_CLIENT_ID": client_id,
        "ACCESS_CLIENT_SECRET": client_secret,
        "ACCESS_AUTHORIZATION_URL": auth_url,
        "ACCESS_TOKEN_URL": token_url,
        "ACCESS_JWKS_URL": jwks_url,
        "COOKIE_ENCRYPTION_KEY": cookie_key,
        "ACCESS_TEAM_DOMAIN": TEAM,
    }

    for env in ("staging", "production"):
        for name, value in secrets.items():
            wrangler_secret(name, value, env)

    meta = {
        "access_aud_dashboard": AUD_DASH,
        "access_aud_api": AUD_API,
        "oauth_client_id": client_id,
        "saas_app_id": SAAS_ID,
    }
    path = "/tmp/crm-access-provision.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
