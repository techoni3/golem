"""Golem Dashboard gateway adapter for Hermes Agent (GOL-39 part 2).

Contract (lead-defined, implemented per GOL-42):

- Inbound: poll ``GET {dashboard}/api/dispatch-queue?session_id=<id>&status=pending``
  every GOLEM_POLL_SECONDS; claim each row (GOL-43 claim endpoint) and inject it
  as a native turn via ``self._message_handler(event)`` — the gateway queues
  mid-turn, exactly like a Telegram DM.
- Outbound: ``send(chat_id, content)`` POSTs the worker's reply to the
  dashboard chat lane (GOL-43 ``POST /api/chat``) so the cockpit shows it live.
- Registration: on connect, register this worker's session name + project so
  the dashboard scopes polls correctly (GOLEM_SESSION_NAME / GOLEM_PROJECT_ID).

The compiler adapter renders this plugin to ``~/.hermes/plugins/golem/`` via
``golem sync --target hermes``. The dashboard flips the hermes channel row to
pull-only (no drainer push) so the adapter is the sole delivery consumer.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from gateway.platforms.base import BasePlatformAdapter
from gateway.platforms.base import PlatformConfig, Platform, SendResult


class GolemAdapter(BasePlatformAdapter):
    """Bidirectional Golem Dashboard ↔ Hermes worker bridge."""

    def __init__(self, config: PlatformConfig, platform: Platform):
        super().__init__(config, platform)
        self._dashboard_url = (os.getenv("GOLEM_DASHBOARD_URL") or "").rstrip("/")
        self._session_name = os.getenv("GOLEM_SESSION_NAME") or ""
        self._project_id = os.getenv("GOLEM_PROJECT_ID") or ""
        self._poll_seconds = float(os.getenv("GOLEM_POLL_SECONDS") or 5)
        self._session_id: Optional[str] = None  # resolved at connect (GOL-42)
        self._poll_task = None

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        """GOL-42: resolve session id, then start the dispatch poll loop."""
        raise NotImplementedError("GOL-42")

    async def disconnect(self) -> None:
        """GOL-42: cancel the poll task."""
        raise NotImplementedError("GOL-42")

    async def send(self, chat_id: str, content: str, reply_to=None, metadata=None) -> SendResult:
        """GOL-42: POST the worker reply to the dashboard chat lane (GOL-43 endpoint)."""
        raise NotImplementedError("GOL-42")

    # -- internal (GOL-42) -------------------------------------------------
    async def _poll_loop(self) -> None:
        """GOL-42: poll pending dispatches, claim, inject via _message_handler."""
        raise NotImplementedError("GOL-42")
