from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import UTC, datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

SERPER_URL = "https://google.serper.dev/search"
HUNTER_URL = "https://api.hunter.io/v2/email-finder"
FULLENRICH_URL = "https://app.fullenrich.com/api/v2/contact/enrich/bulk"
KEYS = {
    "serper": "SERPER_API_KEY",
    "hunter": "HUNTER_API_KEY",
    "fullenrich": "FULLENRICH_API_KEY",
}
TERMINAL_FULLENRICH = {"COMPLETED", "COMPLETE", "FINISHED", "DONE", "FAILED", "ERROR", "CANCELLED"}


class EnrichmentError(RuntimeError):
    pass


def retrieved_at() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def api_key(provider: str) -> str:
    env_name = KEYS[provider]
    if value := os.environ.get(env_name):
        return value
    reference = os.environ.get(f"{env_name}_OP_REF")
    if not reference:
        raise EnrichmentError(f"Set {env_name} or {env_name}_OP_REF.")
    try:
        value = subprocess.check_output(
            ["op", "read", reference], text=True, stderr=subprocess.DEVNULL,
        ).strip()
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise EnrichmentError(
            f"Could not read {env_name}_OP_REF from 1Password. Sign in with op first."
        ) from exc
    if not value:
        raise EnrichmentError(f"The {provider} API key is empty.")
    return value


def request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
                 payload: dict | None = None, timeout: int = 30,
                 empty_on_404: bool = False) -> tuple[dict, int]:
    request_headers = {"Accept": "application/json", **(headers or {})}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        request_headers["Content-Type"] = "application/json"
    started = time.monotonic()
    request = Request(url, data=body, headers=request_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except HTTPError as exc:
        if exc.code == 404 and empty_on_404:
            return {}, round((time.monotonic() - started) * 1000)
        message = exc.read().decode(errors="replace")[:500]
        raise EnrichmentError(f"Request failed with HTTP {exc.code}: {message}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise EnrichmentError("Provider request failed.") from exc
    return result, round((time.monotonic() - started) * 1000)


def serper_search(query: str) -> dict:
    data, latency = request_json(
        SERPER_URL,
        method="POST",
        headers={"X-API-KEY": api_key("serper")},
        payload={"q": query, "gl": "us", "hl": "en", "num": 10},
    )
    candidates = [
        {
            "url": item.get("link") or "",
            "title": item.get("title") or "",
            "snippet": item.get("snippet") or "",
        }
        for item in (data.get("organic") or [])[:10]
        if item.get("link")
    ]
    return {"query": query, "candidates": candidates, "latency_ms": latency}


def _words(value: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", (value or "").lower())


def _contains(text: str, value: str | None) -> bool:
    wanted = _words(value)
    present = set(_words(text))
    return bool(wanted) and all(word in present for word in wanted)


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def _candidate_names(results: list[dict], first_name: str) -> list[str]:
    names: list[str] = []
    pattern = re.compile(rf"\b({re.escape(first_name)}\s+[A-Z][A-Za-z'’-]+)\b", re.IGNORECASE)
    for search in results:
        for item in search["candidates"]:
            for match in pattern.findall(f"{item['title']} {item['snippet']}"):
                name = " ".join(part.capitalize() for part in match.split())
                if name.lower() not in {value.lower() for value in names}:
                    names.append(name)
    return names


def resolve_identity(contact: dict, company: dict) -> dict:
    full_name = (contact.get("full_name") or "").strip()
    first_name = (contact.get("first_name") or full_name.split()[0] if full_name else "").strip()
    last_name = (contact.get("last_name") or "").strip()
    if not last_name and len(full_name.split()) > 1:
        first_name, last_name = full_name.split()[0], " ".join(full_name.split()[1:])
    company_name = (company.get("name") or "").strip()
    domain = (company.get("domain") or _host(company.get("website") or "")).strip()
    role = (contact.get("title") or "").strip()
    if not first_name or not company_name or not domain:
        return {"status": "unresolved", "confidence": "low", "reason": "Contact first name, company, and domain are required.", "searches": []}

    if last_name:
        name = f"{first_name} {last_name}"
        queries = [
            f'"{name}" "{company_name}"',
            f'site:linkedin.com/in "{name}" "{company_name}"',
            f'site:{domain} "{name}"',
        ]
    else:
        suffix = f" {role}" if role else ""
        queries = [
            f'"{first_name}" "{company_name}"{suffix}',
            f'site:{domain} "{first_name}"{suffix}',
            f'site:linkedin.com/in "{first_name}" "{company_name}"{suffix}',
        ]
    searches = [serper_search(query) for query in queries]
    all_items = [item for search in searches for item in search["candidates"]]

    if last_name:
        official = [item for item in all_items if _host(item["url"]).endswith(domain) and _contains(f"{item['title']} {item['snippet']}", name)]
        consistent = [
            item for item in all_items
            if _contains(f"{item['title']} {item['snippet']} {item['url']}", name)
            and (_contains(f"{item['title']} {item['snippet']}", company_name) or domain in f"{item['url']} {item['snippet']}")
        ]
        accepted = bool(official) or len({item["url"] for item in consistent}) >= 2
        return {
            "status": "resolved" if accepted else "unresolved",
            "confidence": "high" if accepted else "low",
            "reason": "Official company evidence matched." if official else "Multiple consistent sources matched." if accepted else "Identity evidence was insufficient.",
            "first_name": first_name,
            "last_name": last_name,
            "full_name": name,
            "evidence_urls": list(dict.fromkeys(item["url"] for item in (official or consistent))),
            "searches": searches,
            "retrieved_at": retrieved_at(),
        }

    candidates = _candidate_names(searches, first_name)
    matches = []
    for name in candidates:
        linkedin = [item for item in all_items if "linkedin.com/in" in item["url"] and _contains(f"{item['title']} {item['snippet']}", name) and _contains(f"{item['title']} {item['snippet']}", company_name)]
        official = [item for item in all_items if _host(item["url"]).endswith(domain) and _contains(f"{item['title']} {item['snippet']}", first_name) and (not role or _contains(f"{item['title']} {item['snippet']}", role))]
        if linkedin and official:
            matches.append((name, linkedin[0], official[0]))
    if len(matches) != 1:
        return {
            "status": "unresolved", "confidence": "low",
            "reason": "A partial name needs one LinkedIn candidate plus matching official company evidence.",
            "candidate_names": candidates, "searches": searches, "retrieved_at": retrieved_at(),
        }
    name, linkedin, official = matches[0]
    parts = name.split(maxsplit=1)
    return {
        "status": "resolved", "confidence": "high", "reason": "LinkedIn and official company evidence matched.",
        "first_name": parts[0], "last_name": parts[1], "full_name": name,
        "linkedin_url": linkedin["url"], "evidence_urls": [linkedin["url"], official["url"]],
        "searches": searches, "retrieved_at": retrieved_at(),
    }


def hunter(identity: dict, domain: str) -> dict:
    params = {"domain": domain, "first_name": identity["first_name"], "last_name": identity["last_name"], "max_duration": 10}
    if identity.get("linkedin_url"):
        handle = urlparse(identity["linkedin_url"]).path.rstrip("/").split("/")[-1]
        params = {"linkedin_handle": handle, "max_duration": 10}
    data, latency = request_json(
        f"{HUNTER_URL}?{urlencode(params)}",
        headers={"X-API-KEY": api_key("hunter")},
        timeout=15, empty_on_404=True,
    )
    result = data.get("data") or {}
    verification = result.get("verification") or {}
    raw_status = verification.get("status")
    normalized = "not_found" if not result.get("email") else "verified" if raw_status == "valid" else "manual_review"
    return {
        "provider": "hunter", "email": result.get("email"), "score": result.get("score"),
        "raw_status": raw_status, "normalized_status": normalized, "sources": result.get("sources") or [],
        "latency_ms": latency, "credits": 1 if result.get("email") else 0,
        "retrieved_at": retrieved_at(),
    }


def fullenrich(identity: dict, domain: str, contact_id: str, polls: int, poll_interval: int) -> dict:
    entry = {
        "first_name": identity["first_name"], "last_name": identity["last_name"], "domain": domain,
        "enrich_fields": ["contact.work_emails"], "custom": {"contact_id": contact_id},
    }
    if identity.get("linkedin_url"):
        entry["linkedin_url"] = identity["linkedin_url"]
    headers = {"Authorization": f"Bearer {api_key('fullenrich')}"}
    created, create_latency = request_json(
        FULLENRICH_URL, method="POST", headers=headers,
        payload={"name": f"Agent CRM {contact_id}", "data": [entry]},
    )
    job_id = created.get("id") or created.get("enrichment_id")
    if not job_id:
        raise EnrichmentError("FullEnrich did not return an enrichment ID.")
    result, poll_latencies = created, []
    for number in range(max(1, polls)):
        if number:
            time.sleep(max(0, poll_interval))
        result, latency = request_json(f"{FULLENRICH_URL}/{job_id}", headers=headers)
        poll_latencies.append(latency)
        if str(result.get("status") or "").upper() in TERMINAL_FULLENRICH:
            break
    records = result.get("data") or result.get("datas") or []
    record = records[0] if records else {}
    contact_info = record.get("contact_info") or record.get("contact") or {}
    email_result = contact_info.get("most_probable_work_email") or contact_info.get("work_email") or record.get("most_probable_work_email") or {}
    if isinstance(email_result, str):
        email_result = {"email": email_result}
    status = str(result.get("status") or "").upper()
    raw_status = email_result.get("status")
    normalized = "pending" if status not in TERMINAL_FULLENRICH else "not_found" if not email_result.get("email") else "vendor_deliverable" if str(raw_status or "").upper() == "DELIVERABLE" else "manual_review"
    return {
        "provider": "fullenrich", "job_id": job_id, "job_status": status,
        "email": email_result.get("email"), "raw_status": raw_status, "normalized_status": normalized,
        "cost": result.get("cost") or {}, "credits": (result.get("cost") or {}).get("credits"),
        "profile": record.get("profile") or record.get("contact_profile"),
        "company": record.get("company"), "latency_ms": create_latency + sum(poll_latencies),
        "retrieved_at": retrieved_at(), "pending": status not in TERMINAL_FULLENRICH,
    }
