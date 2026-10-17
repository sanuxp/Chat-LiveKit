import os
from typing import Any

import httpx


class Backend:
    """Client for the support-chat backend's internal API (shared-secret auth).

    The backend owns the chosen voice pipeline, the system prompt, the history and the tools, so the worker
    and the text chat always behave the same.
    """

    def __init__(self) -> None:
        self._url = os.getenv("BACKEND_URL", "http://backend:3000").rstrip("/")
        token = os.getenv("INTERNAL_API_TOKEN", "")
        if not token:
            raise RuntimeError("INTERNAL_API_TOKEN is not set")
        self._http = httpx.AsyncClient(base_url=self._url, headers={"Authorization": f"Bearer {token}"}, timeout=15)

    async def session(self, conversation_id: str) -> dict[str, Any]:
        r = await self._http.get(f"/api/internal/voice/session/{conversation_id}")
        r.raise_for_status()
        return r.json()

    async def post_message(self, conversation_id: str, role: str, body: str) -> None:
        """role: "customer" | "ai". Stored like a chat message so it shows in the widget and the agent console."""
        r = await self._http.post(f"/api/internal/conversations/{conversation_id}/messages", json={"role": role, "body": body})
        r.raise_for_status()

    async def run_tool(self, conversation_id: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        r = await self._http.post(f"/api/internal/conversations/{conversation_id}/tools/{name}", json={"arguments": arguments})
        r.raise_for_status()
        return r.json()

    async def aclose(self) -> None:
        await self._http.aclose()
