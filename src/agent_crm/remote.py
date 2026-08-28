"""Access service-token client for remote Agent CRM API."""
from __future__ import annotations

import json
import os
import uuid
import urllib.error
import urllib.request
from typing import Any


class RemoteCRMError(RuntimeError):
    pass


class RemoteCRMClient:
    def __init__(
        self,
        base_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("CRM_API_URL", "")).rstrip("/")
        self.client_id = client_id or os.environ.get("CF_ACCESS_CLIENT_ID", "")
        self.client_secret = client_secret or os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
        if not self.base_url:
            raise RemoteCRMError("CRM_API_URL is required for remote mode.")
        if not self.client_id or not self.client_secret:
            raise RemoteCRMError("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required.")

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {
            "CF-Access-Client-Id": self.client_id,
            "CF-Access-Client-Secret": self.client_secret,
            "Accept": "application/json",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8")
            try:
                detail = json.loads(payload)
            except json.JSONDecodeError:
                detail = {"error": payload}
            raise RemoteCRMError(detail.get("error", str(exc))) from exc

    def list_projects(self) -> list[dict[str, Any]]:
        return self._request("GET", "/v1/projects")

    def create_project(self, name: str, slug: str | None = None, description: str | None = None, *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._request(
            "POST",
            "/v1/projects",
            {"name": name, "slug": slug, "description": description},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def list_companies(self, project: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._request("GET", f"/v1/projects/{project}/companies?limit={limit}")

    def create_company(self, project: str, name: str, *, idempotency_key: str | None = None, **fields: Any) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/projects/{project}/companies",
            {"project": project, "name": name, **fields},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def get_company(self, company_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/companies/{company_id}")

    def update_company(self, company_id: str, fields: dict[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._request(
            "PATCH",
            f"/v1/companies/{company_id}",
            {"id": company_id, "fields": fields},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def list_prospects(self, project: str, stage: str | None = None, owner: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        params = [f"project={project}", f"limit={limit}"]
        if stage:
            params.append(f"stage={stage}")
        if owner:
            params.append(f"owner={owner}")
        return self._request("GET", f"/v1/projects/{project}/prospects?{'&'.join(params)}")

    def create_prospect(self, project: str, name: str, *, idempotency_key: str | None = None, **fields: Any) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/projects/{project}/prospects",
            {"project": project, "name": name, **fields},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def get_prospect(self, prospect_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/prospects/{prospect_id}")

    def update_prospect(self, prospect_id: str, fields: dict[str, Any], expected_version: int | None = None, *, idempotency_key: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"id": prospect_id, "fields": fields}
        if expected_version is not None:
            body["expected_version"] = expected_version
        return self._request(
            "PATCH",
            f"/v1/prospects/{prospect_id}",
            body,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def transition_prospect(self, prospect_id: str, to_stage: str, reason: str | None = None, expected_version: int | None = None, *, idempotency_key: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"id": prospect_id, "to_stage": to_stage}
        if reason:
            body["reason"] = reason
        if expected_version is not None:
            body["expected_version"] = expected_version
        return self._request(
            "POST",
            f"/v1/prospects/{prospect_id}/transition",
            body,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def add_note(self, project: str, body: str, *, idempotency_key: str | None = None, **fields: Any) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/projects/{project}/notes",
            {"project": project, "body": body, **fields},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def create_task(self, project: str, title: str, *, idempotency_key: str | None = None, **fields: Any) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/projects/{project}/tasks",
            {"project": project, "title": title, **fields},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def complete_task(self, task_id: str, *, idempotency_key: str | None = None) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/tasks/{task_id}/complete",
            {"id": task_id},
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def pipeline(self, project: str, include_terminal: bool = False) -> dict[str, Any]:
        suffix = "?include_terminal=true" if include_terminal else ""
        return self._request("GET", f"/v1/projects/{project}/pipeline{suffix}")

    def forecast(self, project: str, period: str | None = None) -> dict[str, Any]:
        suffix = f"?period={period}" if period else ""
        return self._request("GET", f"/v1/projects/{project}/forecast{suffix}")

    def search(self, project: str, query: str, limit: int = 50) -> dict[str, Any]:
        return self._request("GET", f"/v1/projects/{project}/search?query={urllib.request.quote(query)}&limit={limit}")

    def timeline(self, entity_type: str, entity_id: str, limit: int = 100) -> list[dict[str, Any]]:
        return self._request("GET", f"/v1/timeline/{entity_type}/{entity_id}?limit={limit}")


def remote_enabled() -> bool:
    return bool(os.environ.get("CRM_API_URL"))
