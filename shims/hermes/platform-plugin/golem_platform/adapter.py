"""Golem Dashboard gateway adapter for Hermes Agent (GOL-39 part 2 / GOL-42).

Contract (lead-defined, implemented per GOL-42):

- Inbound: poll ``GET {dashboard}/api/dispatch-queue?session={id}&status=pending``
  every GOLEM_POLL_SECONDS; claim each row (GOL-46 claim endpoint) and inject it
  as a native turn via ``self.handle_message(event)`` — the gateway queues
  mid-turn, exactly like a Telegram DM.
- Outbound: ``send(chat_id, content)`` POSTs the worker's reply to the
  dashboard chat lane (GOL-46 ``POST /api/chat``) so the cockpit shows it live.
- Registration: on connect, resolve this worker's session id (GOLEM_SESSION_NAME /
  session registry) so the dashboard scopes polls correctly.

The compiler adapter renders this plugin to ``~/.hermes/plugins/golem/`` via
``golem sync --target hermes``.

Reference: ~/.hermes/hermes-agent/plugins/platforms/ntfy/adapter.py
Base: gateway/platforms/base.py  BasePlatformAdapter (abstract: connect, disconnect, send)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import httpx

    HTTPX_AVAILABLE = True
except ImportError:  # pragma: no cover
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)

logger = logging.getLogger(__name__)


DEFAULT_DASHBOARD_URL = "http://127.0.0.1:7420"
DEFAULT_POLL_SECONDS = 5.0
MAX_MESSAGE_LENGTH = 32000
DEDUP_WINDOW_SECONDS = 300
DEDUP_MAX_SIZE = 1000

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _is_uuid(value: str) -> bool:
    return bool(value and _UUID_RE.match(value.strip()))


def _golem_home() -> Path:
    """Mirror lib/golem-home.js resolution: GOLEM_HOME > XDG_CONFIG_HOME > ~/.golem > ~/.config/golem."""
    env_home = (os.getenv("GOLEM_HOME") or "").strip()
    if env_home:
        return Path(env_home).expanduser()
    xdg = (os.getenv("XDG_CONFIG_HOME") or "").strip()
    if xdg:
        return Path(xdg).expanduser() / "golem"
    migrated = Path.home() / ".golem"
    try:
        if migrated.is_dir():
            return migrated
    except Exception:
        pass
    return Path.home() / ".config" / "golem"


def _resolve_session_id(
    config_extra: Dict[str, Any],
    dashboard_url: str,
    project_id: str,
    session_name_hint: str,
) -> str:
    """Resolve the canonical session id for this worker.

    Priority chain (authoritative → fallback):
      1. HERMES_SESSION_ID / GOLEM_CEO_SESSION_ID / GOLEM_SESSION_ID env
      2. GOLEM_SESSION_NAME / GOLEM_WORKER_NAME / HERMES_SESSION_NAME when it is a UUID
      3. Durable hermes-session-bindings.json (newest for this project)
      4. GOLEM_SESSION_NAME as raw chat_id fallback (poll will yield 0 rows but
         keeps the adapter connected for name-based future lookup)
    """
    for env_key in ("HERMES_SESSION_ID", "GOLEM_CEO_SESSION_ID", "GOLEM_SESSION_ID"):
        val = (os.getenv(env_key) or "").strip()
        if val:
            logger.debug("[golem] session_id from env %s=%s", env_key, val[:12])
            return val

    # config extra may carry session_name that is actually an id (launcher sets GOLEM_SESSION_NAME)
    for candidate in (
        session_name_hint,
        (config_extra.get("session_name") or "").strip() if isinstance(config_extra, dict) else "",
        (config_extra.get("session_id") or "").strip() if isinstance(config_extra, dict) else "",
        os.getenv("GOLEM_SESSION_NAME", "").strip(),
        os.getenv("GOLEM_WORKER_NAME", "").strip(),
        os.getenv("HERMES_SESSION_NAME", "").strip(),
    ):
        if candidate and _is_uuid(candidate):
            logger.debug("[golem] session_id from GOLEM_SESSION_NAME UUID %s", candidate[:12])
            return candidate

    # Durable binding file written by `golem hermes` launcher
    try:
        bindings_file = _golem_home() / "hermes-session-bindings.json"
        if bindings_file.is_file():
            raw = json.loads(bindings_file.read_text(encoding="utf-8"))
            bindings: List[Dict[str, Any]] = raw.get("bindings") if isinstance(raw, dict) else []
            if isinstance(bindings, list) and bindings:
                # newest first
                def _ts(b: Dict[str, Any]) -> float:
                    try:
                        return float(datetime.fromisoformat(str(b.get("created_at") or "").replace("Z", "+00:00")).timestamp())
                    except Exception:
                        try:
                            return float(b.get("created_at") or 0)
                        except Exception:
                            return 0.0

                bindings.sort(key=lambda b: str(b.get("created_at") or ""), reverse=True)
                pid = (project_id or "").strip()
                # Prefer binding that matches project_id
                if pid:
                    for b in bindings:
                        if str(b.get("project_id") or "").strip() == pid and b.get("session_id"):
                            logger.debug("[golem] session_id from bindings (project %s) %s", pid[:8], str(b["session_id"])[:12])
                            return str(b["session_id"]).strip()
                # else newest binding for matching project path prefix
                cwd = (os.getenv("GOLEM_PROJECT_DIR") or os.getcwd()).strip().rstrip("/")
                normalized_cwd = cwd
                for b in bindings:
                    p = str(b.get("project_path") or "").strip().rstrip("/")
                    if p and normalized_cwd and (normalized_cwd == p or normalized_cwd.startswith(p + "/")):
                        if b.get("session_id"):
                            logger.debug("[golem] session_id from bindings (path %s) %s", p, str(b["session_id"])[:12])
                            return str(b["session_id"]).strip()
                # fallback: newest binding overall
                newest = bindings[0]
                if newest.get("session_id"):
                    logger.debug("[golem] session_id from newest binding %s", str(newest["session_id"])[:12])
                    return str(newest["session_id"]).strip()
    except Exception as e:
        logger.debug("[golem] bindings lookup failed: %s", e)

    # Final fallback: raw session name (may be worker name, not UUID — poll will be empty but keeps adapter alive)
    fallback = (session_name_hint or "").strip()
    if fallback:
        logger.debug("[golem] session_id fallback to session_name %s", fallback)
        return fallback
    return ""


def _resolve_dashboard_url(config_extra: Dict[str, Any]) -> str:
    """Dashboard base URL: config extra → GOLEM_DASHBOARD_URL → ~/.golem/dashboard.json → default.

    The dashboard.json fallback mirrors lib/golem-client.js
    resolveGolemDashboardBaseUrl — TUI workers never carry GOLEM_DASHBOARD_URL
    in their env, so the dashboard self-registration record is the source.
    """
    extra_url = ""
    if isinstance(config_extra, dict):
        extra_url = (config_extra.get("dashboard_url") or config_extra.get("dashboardUrl") or "").strip()
    env_url = (os.getenv("GOLEM_DASHBOARD_URL") or "").strip()
    if extra_url or env_url:
        return (extra_url or env_url).rstrip("/")
    try:
        import json as _json

        dashboard_file = _golem_home() / "dashboard.json"
        if dashboard_file.is_file():
            value = _json.loads(dashboard_file.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                url = str(value.get("url") or "").strip()
                if url:
                    return url.rstrip("/")
                if value.get("host") and value.get("port"):
                    return f"http://{value['host']}:{value['port']}"
    except Exception:
        pass
    return DEFAULT_DASHBOARD_URL


def _resolve_poll_seconds(config_extra: Dict[str, Any]) -> float:
    raw = ""
    if isinstance(config_extra, dict):
        raw = str(config_extra.get("poll_seconds") or config_extra.get("pollSeconds") or "").strip()
    if not raw:
        raw = (os.getenv("GOLEM_POLL_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_POLL_SECONDS
    try:
        val = float(raw)
        if val <= 0:
            return DEFAULT_POLL_SECONDS
        # clamp to avoid busy-loop or absurd sleeps
        return max(1.0, min(val, 60.0))
    except Exception:
        return DEFAULT_POLL_SECONDS


# ---------------------------------------------------------------------------
# Requirements / validation helpers (mirrors ntfy pattern)
# ---------------------------------------------------------------------------


def check_requirements() -> bool:
    if not HTTPX_AVAILABLE:
        return False
    # GOLEM_DASHBOARD_URL is the only hard requirement; session id is resolved at connect
    url = (os.getenv("GOLEM_DASHBOARD_URL") or "").strip()
    # Also allow config-driven URL at check time by inspecting extra? At pre-flight we only have env.
    # Return True if either env or default would allow a connection attempt — don't block install.
    return bool(url or DEFAULT_DASHBOARD_URL)


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    url = (extra.get("dashboard_url") or extra.get("dashboardUrl") or os.getenv("GOLEM_DASHBOARD_URL", "")).strip()
    return bool(url or DEFAULT_DASHBOARD_URL)


def is_connected(config) -> bool:
    return validate_config(config)


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class GolemAdapter(BasePlatformAdapter):
    """Bidirectional Golem Dashboard ↔ Hermes worker bridge."""

    def __init__(self, config: PlatformConfig, platform: Optional[Platform] = None):  # type: ignore[override]
        # Support both call styles:
        #   GolemAdapter(cfg)           — factory lambda cfg: GolemAdapter(cfg)  (like ntfy)
        #   GolemAdapter(cfg, Platform) — direct BasePlatformAdapter contract
        if platform is None:
            try:
                platform = Platform("golem")
            except ValueError:
                # Early instantiation before the plugin registry has registered
                # "golem" (e.g. direct smoke import). Build a minimal stub that
                # satisfies the base class's platform.value contract without
                # requiring the enum gate — _platform_name() handles both enum
                # and plain objects via getattr(platform, "value", platform).
                import types as _types

                platform = _types.SimpleNamespace(value="golem", name="GOLEM")  # type: ignore[assignment]
                # Provide the few attributes base/platform code probes for
                platform._value_ = "golem"  # type: ignore[attr-defined]
                platform._name_ = "GOLEM"  # type: ignore[attr-defined]
        super().__init__(config=config, platform=platform)

        extra = getattr(config, "extra", {}) or {}
        self._dashboard_url = _resolve_dashboard_url(extra)
        self._session_name = (
            (extra.get("session_name") or extra.get("sessionName") or "").strip()
            or (os.getenv("GOLEM_SESSION_NAME") or "").strip()
            or (os.getenv("HERMES_SESSION_NAME") or os.getenv("GOLEM_WORKER_NAME") or "").strip()
        )
        self._project_id = (
            (extra.get("project_id") or extra.get("projectId") or "").strip()
            or (os.getenv("GOLEM_PROJECT_ID") or "").strip()
        )
        self._poll_seconds = _resolve_poll_seconds(extra)
        self._session_id: Optional[str] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._http_client: Optional["httpx.AsyncClient"] = None
        self._seen_ids: Dict[str, float] = {}
        self._claim_supported: Optional[bool] = None  # None=unknown, True/False after first probe
        # Stable claim owner identity sent to POST /api/dispatch-queue/:id/claim
        # (GOL-46 route reads body.owner for the publishing lease).
        self._claim_owner = f"hermes-{uuid.uuid4().hex[:12]}"

    # -- Connection lifecycle ------------------------------------------------

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not HTTPX_AVAILABLE:
            logger.warning("[golem] httpx not installed. Run: pip install httpx")
            return False

        # Resolve session id deterministically at connect time
        self._session_id = _resolve_session_id(
            getattr(self.config, "extra", {}) or {},
            self._dashboard_url,
            self._project_id,
            self._session_name,
        )
        # If GOLEM_DASHBOARD_URL was not set at construct, re-resolve (env may have been injected late)
        if not self._dashboard_url:
            self._dashboard_url = _resolve_dashboard_url(getattr(self.config, "extra", {}) or {})

        if not self._dashboard_url:
            logger.warning("[golem] GOLEM_DASHBOARD_URL not configured")
            return False
        if not self._session_id:
            logger.warning("[golem] no session id resolved (set HERMES_SESSION_ID / GOLEM_CEO_SESSION_ID or GOLEM_SESSION_NAME)")
            # Do not fail hard — keep adapter connected so dashboard chat send() still works
            # and a later session binding may arrive. Poll will no-op until an id appears.
            logger.info("[golem] starting without poll (send-only mode)")

        try:
            # Shared async client for poll + send + claim
            self._http_client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=15.0, write=10.0, pool=10.0))
            self._mark_connected()
            if self._session_id:
                # Start poll loop only when we have a target id
                self._poll_task = asyncio.create_task(self._poll_loop())
                logger.info(
                    "[golem] Connected — polling %s/api/dispatch-queue?session=%s every %.1fs",
                    self._dashboard_url,
                    self._session_id[:12] if len(self._session_id) > 12 else self._session_id,
                    self._poll_seconds,
                )
            else:
                logger.info("[golem] Connected (send-only) — dashboard=%s", self._dashboard_url)
            return True
        except Exception as e:
            logger.error("[golem] Failed to connect: %s", e)
            return False

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        if self._http_client:
            try:
                await self._http_client.aclose()
            except Exception:
                pass
            self._http_client = None
        self._seen_ids.clear()
        logger.info("[golem] Disconnected")

    # -- Inbound polling -----------------------------------------------------

    async def _poll_loop(self) -> None:
        """Poll dispatch queue, claim each row, inject via handle_message."""
        assert self._session_id, "poll loop requires session_id"
        # Small stagger so concurrent workers don't thundering-herd on boot
        await asyncio.sleep(0.5)
        consecutive_errors = 0
        while self._running:
            try:
                await self._poll_once()
                consecutive_errors = 0
            except asyncio.CancelledError:
                return
            except Exception as e:
                consecutive_errors += 1
                # Back off on repeated failures, but never exceed 2x poll interval
                if consecutive_errors > 3:
                    logger.warning("[golem] poll error (%d consecutive): %s", consecutive_errors, e)
                else:
                    logger.debug("[golem] poll error: %s", e)
            if not self._running:
                return
            try:
                await asyncio.sleep(self._poll_seconds)
            except asyncio.CancelledError:
                return

    async def _poll_once(self) -> None:
        assert self._http_client is not None
        assert self._session_id

        # Re-resolve session id if we started send-only and a binding appeared
        if not self._session_id:
            fresh = _resolve_session_id(
                getattr(self.config, "extra", {}) or {},
                self._dashboard_url,
                self._project_id,
                self._session_name,
            )
            if fresh:
                self._session_id = fresh
                logger.info("[golem] session_id resolved late: %s", fresh[:12])

        params: Dict[str, str] = {"status": "pending", "session": self._session_id}
        # Dashboard also accepts `session_id` alias — send both for backcompat
        params["session_id"] = self._session_id
        if self._project_id:
            params["project"] = self._project_id

        url = f"{self._dashboard_url}/api/dispatch-queue"
        resp = await self._http_client.get(url, params=params)
        if resp.status_code >= 400:
            # 404 on this endpoint means dashboard is too old — degrade gracefully
            if resp.status_code == 404:
                logger.debug("[golem] dispatch-queue endpoint not found (404) — dashboard may need restart")
                return
            logger.warning("[golem] poll GET %s failed HTTP %d: %s", url, resp.status_code, resp.text[:200])
            return

        try:
            rows = resp.json()
        except Exception as e:
            logger.warning("[golem] poll JSON decode failed: %s", e)
            return

        if not isinstance(rows, list):
            # Some dashboard versions wrap in { queue: [...] } — handle both
            if isinstance(rows, dict) and isinstance(rows.get("queue"), list):
                rows = rows["queue"]
            elif isinstance(rows, dict) and isinstance(rows.get("rows"), list):
                rows = rows["rows"]
            else:
                logger.debug("[golem] poll unexpected shape: %r", str(rows)[:200])
                return

        for row in rows:
            if not isinstance(row, dict):
                continue
            queue_id = str(row.get("id") or row.get("queue_id") or "").strip()
            if not queue_id:
                continue
            if self._is_duplicate(queue_id):
                continue
            # Claim then inject; claim is idempotent — 409 means another consumer won
            content = await self._claim_and_resolve_content(row)
            if content is None:
                # 409 or empty — skip
                continue
            if not content.strip():
                logger.debug("[golem] empty content for queue %s, skipping", queue_id)
                continue
            await self._inject_dispatch(row, content)

    async def _claim_and_resolve_content(self, row: Dict[str, Any]) -> Optional[str]:
        """Claim a queue row via POST /api/dispatch-queue/:id/claim and return its brief content.

        Returns ``None`` when the row should be skipped (already claimed or empty).
        Handles the not-yet-deployed case where the claim endpoint 404s by falling
        back to the envelope fetch / synthetic brief path.
        """
        assert self._http_client is not None

        queue_id = str(row.get("id") or "").strip()
        envelope_id = str(row.get("envelope_id") or row.get("envelopeId") or "").strip()

        # Fast path: if claim endpoint previously 404'd, skip probing it again
        if self._claim_supported is False:
            return await self._resolve_content_without_claim(row)

        # Attempt claim when envelope_id is present (normal case)
        if envelope_id:
            claim_url = f"{self._dashboard_url}/api/dispatch-queue/{envelope_id}/claim"
            # Some dashboard variants use queue id rather than envelope id for claim
            alt_claim_url = f"{self._dashboard_url}/api/dispatch-queue/{queue_id}/claim"
            for attempt_url in (claim_url, alt_claim_url):
                try:
                    cresp = await self._http_client.post(attempt_url, json={"owner": self._claim_owner}, timeout=10.0)
                    if cresp.status_code == 404:
                        # Endpoint not yet deployed — remember and fall back
                        # Only mark unsupported after trying both URL shapes
                        if attempt_url is alt_claim_url:
                            self._claim_supported = False
                            logger.debug("[golem] claim endpoint not found (404) — falling back to envelope fetch")
                            return await self._resolve_content_without_claim(row)
                        continue
                    if cresp.status_code == 409:
                        logger.debug("[golem] queue %s already claimed (409)", queue_id)
                        return None
                    if cresp.status_code >= 400:
                        logger.warning("[golem] claim POST %s HTTP %d: %s", attempt_url, cresp.status_code, cresp.text[:200])
                        # Fall back to envelope fetch rather than dropping
                        return await self._resolve_content_without_claim(row)
                    # Success — parse payload
                    self._claim_supported = True
                    try:
                        data = cresp.json()
                    except Exception:
                        data = {}
                    # Response shapes (handle all):
                    #   { content, envelope_id } | { payload: { content } } | { envelope: { payload } }
                    content = self._extract_content_from_payload(data, row)
                    if content:
                        return content
                    # Empty claim body but status 200 — fall back to envelope fetch
                    logger.debug("[golem] claim 200 but no content for %s, trying envelope fetch", queue_id)
                    return await self._resolve_content_without_claim(row)
                except httpx.TimeoutException:
                    logger.warning("[golem] claim POST %s timeout", attempt_url)
                    return await self._resolve_content_without_claim(row)
                except Exception as e:
                    logger.warning("[golem] claim POST %s failed: %s", attempt_url, e)
                    return await self._resolve_content_without_claim(row)
            # both attempts 404'd
            self._claim_supported = False
            return await self._resolve_content_without_claim(row)

        # No envelope_id (legacy row) — use note or synthetic brief
        return await self._resolve_content_without_claim(row)

    def _extract_content_from_payload(self, data: Any, row: Dict[str, Any]) -> Optional[str]:
        if not isinstance(data, dict):
            if isinstance(data, str) and data.strip():
                return data.strip()
            return None
        # Direct content
        for key in ("content", "text", "brief", "payload"):
            val = data.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
            if isinstance(val, dict):
                # nested { payload: { content: ... } }
                for inner in ("content", "text", "brief"):
                    iv = val.get(inner)
                    if isinstance(iv, str) and iv.strip():
                        return iv.strip()
                # payload may be JSON string
                if isinstance(val.get("payload"), str) and val["payload"].strip():
                    try:
                        inner_json = json.loads(val["payload"])
                        if isinstance(inner_json, dict) and isinstance(inner_json.get("content"), str):
                            return inner_json["content"].strip()
                    except Exception:
                        return val["payload"].strip()
        # Envelope shape: { envelope: { payload: "..." } }
        env = data.get("envelope")
        if isinstance(env, dict):
            nested = self._extract_content_from_payload(env, row)
            if nested:
                return nested
        return None

    async def _resolve_content_without_claim(self, row: Dict[str, Any]) -> Optional[str]:
        """Fallback when claim endpoint is absent: fetch envelope or synthesize from row."""
        assert self._http_client is not None
        envelope_id = str(row.get("envelope_id") or "").strip()
        if envelope_id:
            for env_url in (
                f"{self._dashboard_url}/api/message-envelopes/{envelope_id}",
                f"{self._dashboard_url}/api/envelopes/{envelope_id}",
            ):
                try:
                    eresp = await self._http_client.get(env_url, timeout=10.0)
                    if eresp.status_code == 404:
                        continue
                    if eresp.status_code >= 400:
                        logger.warning("[golem] envelope GET %s HTTP %d: %s", env_url, eresp.status_code, eresp.text[:200])
                        continue
                    try:
                        edata = eresp.json()
                    except Exception:
                        continue
                    content = self._extract_content_from_payload(edata, row)
                    if content:
                        return content
                    # envelope payload may be under .payload string
                    payload_raw = edata.get("payload") if isinstance(edata, dict) else None
                    if isinstance(payload_raw, str):
                        try:
                            payload_json = json.loads(payload_raw)
                            if isinstance(payload_json, dict) and isinstance(payload_json.get("content"), str):
                                return payload_json["content"].strip()
                        except Exception:
                            if payload_raw.strip():
                                return payload_raw.strip()
                    if isinstance(payload_raw, dict) and isinstance(payload_raw.get("content"), str):
                        return payload_raw["content"].strip()
                except Exception as e:
                    logger.debug("[golem] envelope fetch %s failed: %s", env_url, e)
                    continue

        # Synthetic brief from ticket info (handles very old rows or envelope fetch failure)
        ticket_id = str(row.get("ticket_id") or row.get("ticketTitle") or "").strip()
        note = str(row.get("note") or "").strip()
        title = str(row.get("ticket_title") or row.get("title") or ticket_id).strip()
        if ticket_id:
            display = ticket_id
            # ticket_id from dispatch_queue is canonical id; row.ticket_title has display title hint
            # Try to build a minimal brief the agent can act on
            project = str(row.get("project_id") or self._project_id or "unknown").strip()
            kind = "task"
            brief = (
                f"You've been assigned tracker ticket {display}: \"{title}\" (project {project}, kind {kind}).\n\n"
                f"{note + chr(10) + chr(10) if note else ''}"
                f"Load it with the golem tracker tools (ticket_get {display}) to read the full body, acceptance criteria, and comment thread, then pick it up: move it to in_progress, do the work, comment progress, and move it to review/done when complete."
            )
            if row.get("workspace") == "worktree":
                brief += f"\n\nWorkspace: worktree — create/use .worktrees/{display}/ as specified in the dispatch brief."
            if envelope_id:
                brief += f"\n\nDispatch message_id: {envelope_id}\nAcknowledge this dispatch first with ack({{ kind: 'brief', summary: '<one sentence>', envelope_id: '{envelope_id}' }})."
            return brief
        if note.strip():
            return note.strip()
        return None

    async def _inject_dispatch(self, row: Dict[str, Any], content: str) -> None:
        queue_id = str(row.get("id") or "").strip()
        envelope_id = str(row.get("envelope_id") or queue_id).strip()
        # Build a SessionSource + MessageEvent mirroring ntfy
        chat_id = self._session_id or "golem"
        chat_name = self._session_name or chat_id
        user_id = "golem-dashboard"
        user_name = "Golem Dashboard"
        source = self.build_source(
            chat_id=chat_id,
            chat_name=chat_name,
            chat_type="dm",
            user_id=user_id,
            user_name=user_name,
        )
        # Prefer envelope created_at for timestamp when available
        ts: datetime
        raw_ts = row.get("created_at") or row.get("delivered_at")
        try:
            if isinstance(raw_ts, str) and raw_ts:
                # SQLite ISO string
                iso = raw_ts.replace("Z", "+00:00")
                ts = datetime.fromisoformat(iso)
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
            else:
                ts = datetime.now(tz=timezone.utc)
        except Exception:
            ts = datetime.now(tz=timezone.utc)

        event = MessageEvent(
            text=content,
            message_type=MessageType.TEXT,
            source=source,
            message_id=envelope_id,
            raw_message=row,
            timestamp=ts,
        )
        logger.info("[golem] dispatch %s → inject turn (ticket %s)", queue_id[:8], str(row.get("ticket_id") or "")[:16])
        try:
            await self.handle_message(event)
        except Exception as e:
            logger.error("[golem] handle_message failed for %s: %s", queue_id[:8], e)

    # -- Deduplication ------------------------------------------------------

    def _is_duplicate(self, msg_id: str) -> bool:
        now = time.time()
        if len(self._seen_ids) > DEDUP_MAX_SIZE:
            cutoff = now - DEDUP_WINDOW_SECONDS
            self._seen_ids = {k: v for k, v in self._seen_ids.items() if v > cutoff}
        if msg_id in self._seen_ids:
            return True
        self._seen_ids[msg_id] = now
        return False

    # -- Outbound messaging -------------------------------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """POST the worker reply to the dashboard chat lane."""
        target_session = (chat_id or "").strip() or (self._session_id or "").strip()
        if not target_session:
            # As a last resort, use session_name (worker name) — GOL-46 allows name-based lookup
            target_session = (self._session_name or "").strip()
        if not target_session:
            return SendResult(success=False, error="no target session id for dashboard chat")

        if not self._http_client:
            # send() may be called outside the connect lifecycle (standalone_sender path)
            # so create a short-lived client
            if not HTTPX_AVAILABLE:
                return SendResult(success=False, error="httpx not installed")
            client = httpx.AsyncClient(timeout=10.0)
            close_after = True
        else:
            client = self._http_client
            close_after = False

        url = f"{self._dashboard_url}/api/chat" if self._dashboard_url else ""
        if not url:
            return SendResult(success=False, error="GOLEM_DASHBOARD_URL not configured")

        # Truncate if needed
        body_text = content[:MAX_MESSAGE_LENGTH] if len(content) > MAX_MESSAGE_LENGTH else content
        if len(content) > MAX_MESSAGE_LENGTH:
            logger.warning("[golem] truncating chat reply from %d to %d chars", len(content), MAX_MESSAGE_LENGTH)

        payload: Dict[str, Any] = {
            "session_id": target_session,
            "author": "assistant",
            "author_label": self._session_name or target_session[:12] if target_session else "hermes",
            "content": body_text,
        }
        # Some dashboard versions accept `sessionId` camelCase or `text` alias
        # Include them redundantly for compatibility without harming strict validators
        payload["sessionId"] = target_session
        payload["text"] = body_text

        try:
            resp = await client.post(url, json=payload, timeout=10.0)
            if close_after:
                await client.aclose()
            if resp.status_code < 300:
                try:
                    data = resp.json()
                    returned_id = str(data.get("id") or data.get("message_id") or uuid.uuid4().hex[:12])
                except Exception:
                    returned_id = uuid.uuid4().hex[:12]
                logger.debug("[golem] chat send ok session=%s id=%s", target_session[:8], returned_id[:8])
                return SendResult(success=True, message_id=returned_id)
            # 404 may mean the GOL-46 endpoint hasn't landed yet — try legacy fallback POST /api/bus/ingest or /api/chat alternative
            if resp.status_code == 404:
                # Try alternative path: POST /api/dispatch-queue/:sessionId/chat or /api/chat/ingest variant
                # For now return a soft failure with clear guidance
                logger.warning("[golem] chat POST %s 404 — dashboard may need GOL-46 (POST /api/chat). Payload preserved locally.", url)
                return SendResult(success=False, error=f"HTTP 404: dashboard POST /api/chat not found (GOL-46 not yet deployed). Needs dashboard restart with new code.")
            body_snip = resp.text[:300] if hasattr(resp, "text") else ""
            logger.warning("[golem] chat send failed HTTP %d: %s", resp.status_code, body_snip)
            return SendResult(success=False, error=f"HTTP {resp.status_code}: {body_snip}")
        except httpx.TimeoutException:
            if close_after:
                try:
                    await client.aclose()
                except Exception:
                    pass
            return SendResult(success=False, error="Timeout posting to dashboard /api/chat")
        except Exception as e:
            if close_after:
                try:
                    await client.aclose()
                except Exception:
                    pass
            logger.error("[golem] chat send error: %s", e)
            return SendResult(success=False, error=str(e))

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        # Dashboard chat doesn't need typing indicators
        pass

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id or self._session_id or "golem", "type": "dm"}


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------


def _env_enablement() -> Optional[Dict[str, Any]]:
    """Seed PlatformConfig.extra from env vars during gateway config load.

    Called before adapter construction so `hermes gateway status` reflects
    env-only configuration without instantiating the HTTP client.
    Returns None when golem isn't minimally configured.
    """
    url = (os.getenv("GOLEM_DASHBOARD_URL") or "").strip()
    if not url:
        # Allow dashboard url from extra-less env? Require it — without it the adapter is inert
        return None
    seed: Dict[str, Any] = {"dashboard_url": url.rstrip("/")}
    session_name = (os.getenv("GOLEM_SESSION_NAME") or os.getenv("HERMES_SESSION_NAME") or os.getenv("GOLEM_WORKER_NAME") or "").strip()
    if session_name:
        seed["session_name"] = session_name
    project_id = (os.getenv("GOLEM_PROJECT_ID") or "").strip()
    if project_id:
        seed["project_id"] = project_id
    poll = (os.getenv("GOLEM_POLL_SECONDS") or "").strip()
    if poll:
        seed["poll_seconds"] = poll
    # Dashboard session id hints (not standard, but helps preflight)
    for env_key in ("HERMES_SESSION_ID", "GOLEM_CEO_SESSION_ID", "GOLEM_SESSION_ID"):
        sid = (os.getenv(env_key) or "").strip()
        if sid:
            seed["session_id"] = sid
            break
    return seed


async def _standalone_send(
    pconfig: PlatformConfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    """Out-of-process publish for cron / send_message_tool fallbacks.

    When the gateway runner is not in this process (e.g. `hermes cron` running
    standalone), this hook lets callers still deliver via the dashboard chat.
    Without it, `deliver=golem` cron jobs fail with `No live adapter`.
    """
    if not HTTPX_AVAILABLE:
        return {"error": "golem standalone send: httpx not installed"}
    extra = getattr(pconfig, "extra", {}) or {}
    dashboard_url = _resolve_dashboard_url(extra)
    if not dashboard_url:
        return {"error": "golem standalone send: GOLEM_DASHBOARD_URL not configured"}
    target = (chat_id or "").strip() or (extra.get("session_id") or extra.get("session_name") or os.getenv("GOLEM_SESSION_NAME") or "").strip()
    if not target:
        return {"error": "golem standalone send: no target session id (chat_id / GOLEM_SESSION_NAME)"}
    url = f"{dashboard_url}/api/chat"
    payload: Dict[str, Any] = {
        "session_id": target,
        "author": "assistant",
        "content": message[:MAX_MESSAGE_LENGTH],
        "text": message[:MAX_MESSAGE_LENGTH],
        "sessionId": target,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code >= 300:
            return {"error": f"golem HTTP {resp.status_code}: {resp.text[:200]}"}
        try:
            data = resp.json()
            msg_id = str(data.get("id") or data.get("message_id") or uuid.uuid4().hex[:12])
        except Exception:
            msg_id = uuid.uuid4().hex[:12]
        return {"success": True, "platform": "golem", "chat_id": target, "message_id": msg_id}
    except Exception as e:
        return {"error": f"golem standalone send failed: {e}"}


def register(ctx) -> None:
    ctx.register_platform(
        name="golem",
        label="Golem Dashboard",
        adapter_factory=lambda cfg: GolemAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["GOLEM_DASHBOARD_URL"],
        install_hint="Set GOLEM_DASHBOARD_URL to your Golem dashboard (e.g. http://localhost:7420) and optionally GOLEM_SESSION_NAME / GOLEM_PROJECT_ID.",
        env_enablement_fn=_env_enablement,
        standalone_sender_fn=_standalone_send,
        allowed_users_env="GOLEM_ALLOWED_USERS",
        allow_all_env="GOLEM_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="🗿",
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are reachable via the Golem dashboard. "
            "Dashboard dispatches (briefs, comment steers) arrive as native turns — "
            "handle them as priority instructions from the orchestrator."
        ),
    )

    # ── In-TUI dispatch loop (GOL-45 round 2) ────────────────────
    # register() runs wherever the plugin manager loads — messaging gateway,
    # cron, one-shot CLI, worker TUI panes, and the dashboard-PTY tui_gateway
    # entry server. Only the worker TUI surfaces run the loop; the gateway
    # register_platform surface above stays intact for future gateway-managed
    # workers. The loop additionally requires the golem launcher identity
    # (HERMES_SESSION_ID), so no other hermes process can adopt dispatches.
    try:
        from . import tui_loop

        ctx.register_hook("on_session_start", tui_loop.on_session_start)
        ctx.register_hook("on_session_end", tui_loop.on_session_end)
        ctx.register_hook("on_session_finalize", tui_loop.on_session_finalize)
        tui_loop.get_controller().ensure_started()
    except Exception as exc:
        _reg_logger = logging.getLogger(__name__)
        _reg_logger.warning("[golem] tui loop wiring failed: %s", exc)
