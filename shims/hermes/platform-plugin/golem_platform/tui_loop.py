"""In-TUI dispatch loop for the Golem platform plugin (GOL-45, round 2).

Round 1's gateway adapter never runs inside a plain ``hermes`` TUI worker —
``ctx.register_platform`` only wires adapters into the messaging-gateway runner
(see GOL-45 comment 65cc2985 for the live evidence). This module closes that
gap: it runs the SAME poll→claim→inject→settle cycle on a daemon thread inside
the worker's own TUI process, injecting dashboard dispatches as native turns
through the sanctioned in-process lane.

Worker-TUI injection surface (verified against hermes v0.20.3):
  - The worker TUI is cli.py's in-process prompt_toolkit app.
    cli.py (~16864) explicitly hands the plugin manager the live CLI object:
    ``get_plugin_manager()._cli_ref = self`` — "so plugins can inject messages".
  - The sanctioned lane is the SAME queues the Enter handler uses
    (heartbeat watchdog + /loop inject via ``_pending_input.put``):
      * idle       → ``cli._pending_input.put(text)``   (drained ~10 Hz loop)
      * busy       → ``cli._interrupt_queue.put(text)`` when
                     ``cli.busy_input_mode == "interrupt"`` (worker default),
                     else ``cli._pending_input.put(text)``
    A queued item becomes a native user turn on the running session.
  - Secondary surface: dashboard-PTY/desktop sessions run turns through
    ``tui_gateway.server.handle_request("prompt.submit", …)``; the controller
    uses it when the CLI ref is absent but a live tui_gateway session exists.

Lifecycle:
  - ``register(ctx)`` arms the loop only when this process is the WORKER TUI
    surface (:func:`_worker_loop_surface`): an interactive CLI carrying the
    golem launcher identity (``--pass-session-id`` + ``HERMES_SESSION_ID``),
    or a tui_gateway entry server with live sessions. Messaging-gateway
    runner, cron, and one-shot CLI processes stay inert (prevent binding
    collisions: no identity → no dispatch hijack).
  - ``on_session_start`` (first native turn) re-arms idempotently.
  - ``on_session_end`` / ``on_session_finalize`` stop the loop and release
    any claimed-but-unsettled rows (abort path, builder2's fence contract).

Curl-verified dashboard contract (GOL-46, commit 2bc959e):
  claim ``POST /:id/claim {owner, lease_ms}`` (15m pull_adapter default) →
  settle ``POST /:id/settle {owner}`` after submit accepted (idempotent) →
  release ``POST /:id/release {owner}`` on failure/abort → row back to pending.
  pull_adapter rows are exempt from the 60m drainer expiry, so the poll
  cadence carries no deadline pressure.

The gateway adapter class (:class:`golem_platform.adapter.GolemAdapter`) stays
intact for future gateway-managed workers.
"""

from __future__ import annotations

import atexit
import logging
import os
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .adapter import (
    DEFAULT_POLL_SECONDS,
    HTTPX_AVAILABLE,
    _golem_home,
    _is_uuid,
    _resolve_poll_seconds,
)

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# Claim lease for pull_adapter rows — builder2's hardened 15m default, sent
# explicitly so the intent is on the wire and immune to future default changes.
PULL_LEASE_MS = 900_000


# ---------------------------------------------------------------------------
# Surface detection: WHERE is this process, and may it run the loop?
# ---------------------------------------------------------------------------


def _golem_worker_identity() -> Optional[str]:
    """The launcher-injected canonical session id, or None.

    `golem hermes --session-id <uuid>` injects HERMES_SESSION_ID /
    GOLEM_CEO_SESSION_ID / GOLEM_SESSION_ID into the entire worker process
    tree (CLI TUI → tui_gateway entry). Requiring it before polling prevents
    any other hermes process in this project (kanban workers, one-shot CLI
    runs) from silently adopting the newest binding and claiming dispatches
    meant for the real worker.
    """
    for env_key in ("HERMES_SESSION_ID", "GOLEM_CEO_SESSION_ID", "GOLEM_SESSION_ID"):
        val = (os.getenv(env_key) or "").strip()
        if val:
            return val
    return None


def _cli_tui_ref() -> Any:
    """The live in-process CLI TUI object, or None.

    cli.py stamps the plugin manager with the running session
    (``get_plugin_manager()._cli_ref = self``) *specifically* so plugins can
    inject messages. It is None under the messaging gateway, in cron, and in
    every non-interactive surface.
    """
    try:
        from hermes_cli.plugins import get_plugin_manager

        return getattr(get_plugin_manager(), "_cli_ref", None)
    except Exception:
        return None


def _worker_loop_surface() -> Optional[str]:
    """Which in-TUI turn-injection surface is live here, or None.

    Primary signal (works at plugin-load time, BEFORE the CLI app exists):
    the golem launcher shape — ``hermes --pass-session-id`` argv plus the
    launcher-injected canonical session id (HERMES_SESSION_ID). That is the
    exact process tree `golem hermes` spawns, and no other hermes surface
    (gateway runner, cron, kanban one-shots, plain `hermes` chat) carries it.

    Secondary signal (dashboard-PTY/desktop sessions): an already-imported
    tui_gateway server holding live session records.

    NOTE: `_cli_ref` is deliberately NOT consulted for the arm decision — cli.py
    assigns it only once the interactive TUI initialises, which is later than
    plugin load. Instead the loop arms early and the injection path re-checks
    the ref every cycle, releasing claimed rows until the CLI app is ready.
    """
    argv = sys.argv or []
    if _golem_worker_identity() and ("--pass-session-id" in argv or "tui_gateway.entry" in " ".join(argv)):
        return "cli"
    server_mod = sys.modules.get("tui_gateway.server")
    if server_mod is not None:
        sessions = getattr(server_mod, "_sessions", None)
        if isinstance(sessions, dict) and sessions and _golem_worker_identity():
            return "tui_gateway"
    return None


# ---------------------------------------------------------------------------
# HTTP helpers (short-lived httpx clients — the loop is a plain daemon thread,
# the same shape Hermes itself uses for the heartbeat watchdog)
# ---------------------------------------------------------------------------


def _request(method: str, url: str, *, params=None, json_body=None, timeout: float = 10.0):
    if not HTTPX_AVAILABLE or httpx is None:
        return None
    try:
        with httpx.Client(timeout=timeout) as client:
            return client.request(method, url, params=params, json=json_body)
    except Exception as exc:
        logger.debug("[golem] %s %s failed: %s", method, url, exc)
        return None


def _extract_content(data: Any) -> Optional[str]:
    """Parse claim/envelope response shapes into the dispatch brief text."""
    if isinstance(data, str) and data.strip():
        return data.strip()
    if not isinstance(data, dict):
        return None
    for key in ("content", "text", "brief"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    envelope = data.get("envelope")
    if isinstance(envelope, dict):
        nested = _extract_content(envelope)
        if nested:
            return nested
    return None


def _fetch_envelope_content(base: str, envelope_id: str) -> Optional[str]:
    """Last-resort brief read from the durable envelope (older dashboard)."""
    resp = _request("GET", f"{base}/api/message-envelopes/{envelope_id}", timeout=10.0)
    if resp is None or resp.status_code >= 300:
        return None
    try:
        data = resp.json()
    except Exception:
        return None
    content = _extract_content(data)
    if content:
        return content
    payload_raw = data.get("payload") if isinstance(data, dict) else None
    if isinstance(payload_raw, str) and payload_raw.strip():
        import json as _json

        try:
            parsed = _json.loads(payload_raw)
        except Exception:
            return payload_raw.strip()
        if isinstance(parsed, dict) and isinstance(parsed.get("content"), str):
            return parsed["content"].strip()
    if isinstance(payload_raw, dict) and isinstance(payload_raw.get("content"), str):
        return payload_raw["content"].strip()
    return None


class TuiDispatchController:
    """In-worker-TUI poll→claim→inject→settle loop (daemon thread).

    Mirrors Hermes' own heartbeat-watchdog pattern: a daemon thread polls at
    ``GOLEM_POLL_SECONDS`` cadence, resolves the golem canonical session id
    from the launcher env chain, claims pending dispatch rows, injects the
    brief into THIS TUI session via the sanctioned queues, then settles the
    row (release on failure, release outstanding on abort).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._owner = f"hermes-tui-{uuid.uuid4().hex[:12]}"
        self._seen: Dict[str, float] = {}
        self._claimed: Dict[str, Dict[str, Any]] = {}  # queue_id -> {row, envelope_id}
        self._session_id: Optional[str] = None
        self._surface_logged = False
        self._atexit_registered = False
        # Backoff after an injection failure with no surface yet (pre-TUI boot):
        # skip N poll cycles before the next claim, so an unavailable TUI does
        # not churn claim/release every 5s.
        self._backoff_cycles = 0

    # ── lifecycle ────────────────────────────────────────────────────────

    def ensure_started(self) -> None:
        if not httpx:
            logger.debug("[golem] tui loop unavailable: httpx missing")
            return
        if _worker_loop_surface() is None:
            return
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if self._stop.is_set():
                self._stop = threading.Event()
            self._thread = threading.Thread(
                target=self._run, name="golem-tui-dispatch", daemon=True
            )
            self._thread.start()
            if not getattr(self, "_atexit_registered", False):
                self._atexit_registered = True
                try:
                    atexit.register(self._atexit_release)
                except Exception:
                    pass
            logger.info(
                "[golem] TUI dispatch loop started (owner=%s, dashboard=%s)",
                self._owner,
                self._dashboard_url(),
            )

    def stop(self, release: bool = True, timeout: float = 3.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=timeout)
            self._thread = None
        if release:
            self.release_outstanding()

    def notify_session_start(self, session_id: Optional[str] = None) -> None:
        """``on_session_start`` hook — re-arm the loop (idempotent)."""
        self.ensure_started()

    def notify_session_ended(self) -> None:
        """``on_session_end`` hook — abort: stop the loop, release claims."""
        self.stop(release=True)

    def _atexit_release(self) -> None:
        try:
            self.stop(release=True, timeout=2.0)
        except Exception:
            pass

    # ── config ───────────────────────────────────────────────────────────

    def _dashboard_url(self) -> str:
        from .adapter import _resolve_dashboard_url

        return _resolve_dashboard_url({})

    def _poll_seconds(self) -> float:
        return _resolve_poll_seconds({})

    def _golem_session_id(self) -> Optional[str]:
        if self._session_id:
            return self._session_id
        for env_key in ("HERMES_SESSION_ID", "GOLEM_CEO_SESSION_ID", "GOLEM_SESSION_ID"):
            val = (os.getenv(env_key) or "").strip()
            if val:
                self._session_id = val
                return val
        return None

    # ── main loop ────────────────────────────────────────────────────────

    def _run(self) -> None:
        # Small stagger so a burst of worker boots doesn't thunder-herd the queue.
        self._stop.wait(0.75)
        consecutive_errors = 0
        while not self._stop.is_set():
            if self._backoff_cycles > 0:
                self._backoff_cycles -= 1
            else:
                try:
                    self._cycle()
                    consecutive_errors = 0
                except Exception as exc:
                    consecutive_errors += 1
                    if consecutive_errors <= 3 or consecutive_errors % 20 == 0:
                        logger.warning("[golem] tui poll cycle error: %s", exc)
            self._stop.wait(self._poll_seconds())

    def _cycle(self) -> None:
        if not self._golem_session_id():
            if not self._surface_logged:
                self._surface_logged = True
                logger.info("[golem] no golem session identity in env — TUI poll loop dormant")
            return
        for row in self._poll_once():
            if self._stop.is_set():
                return
            if isinstance(row, dict):
                self._handle_row(row)

    # ── HTTP: poll ───────────────────────────────────────────────────────

    def _poll_once(self) -> List[Dict[str, Any]]:
        url = f"{self._dashboard_url()}/api/dispatch-queue"
        sid = self._golem_session_id()
        params: Dict[str, str] = {
            "session": sid or "",
            "session_id": sid or "",
            "status": "pending",
        }
        project = (os.getenv("GOLEM_PROJECT_ID") or "").strip()
        if project:
            params["project"] = project
        resp = _request("GET", url, params=params)
        if resp is None or resp.status_code >= 400:
            if resp is not None and resp.status_code == 404:
                logger.debug("[golem] dispatch-queue 404 — dashboard restart needed")
            return []
        try:
            rows = resp.json()
        except Exception:
            return []
        if isinstance(rows, dict) and isinstance(rows.get("queue"), list):
            rows = rows["queue"]
        return rows if isinstance(rows, list) else []

    # ── per-row: claim → inject → settle/release ─────────────────────────

    def _handle_row(self, row: Dict[str, Any]) -> None:
        queue_id = str(row.get("id") or row.get("queue_id") or "").strip()
        if not queue_id or queue_id in self._seen or queue_id in self._claimed:
            return
        with self._lock:
            self._claimed[queue_id] = {
                "row": row,
                "envelope_id": str(row.get("envelope_id") or "").strip(),
            }
        content = self._claim_row(queue_id, row)
        if content is None:
            # 409 → another consumer owns the row; not our delivery.
            with self._lock:
                self._claimed.pop(queue_id, None)
            self._seen.setdefault(queue_id, time.time())
            return
        ok, detail = self._submit_to_tui(content, row)
        if ok:
            settled = self._settle_row(queue_id)
            with self._lock:
                self._claimed.pop(queue_id, None)
            self._seen[queue_id] = time.time()
            logger.info(
                "[golem] dispatch %s → native TUI turn (%s), %s",
                queue_id[:8],
                detail,
                "settled" if settled else "settle failed (lease will fence)",
            )
        else:
            with self._lock:
                self._claimed.pop(queue_id, None)
            self._release_row(queue_id)
            self._seen.pop(queue_id, None)
            # Surface not ready yet (TUI booting) — back off before re-claiming.
            self._backoff_cycles = 1
            logger.warning(
                "[golem] dispatch %s injection failed — released to pending (%s)",
                queue_id[:8],
                detail,
            )

    def _claim_row(self, queue_id: str, row: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """``POST /:id/claim {owner, lease_ms}`` → brief content, or None."""
        base = self._dashboard_url()
        envelope_id = str((row or {}).get("envelope_id") or "").strip()
        attempts = [f"{base}/api/dispatch-queue/{queue_id}/claim"]
        if envelope_id and envelope_id != queue_id:
            attempts.append(f"{base}/api/dispatch-queue/{envelope_id}/claim")
        for attempt_url in attempts:
            resp = _request(
                "POST",
                attempt_url,
                json_body={"owner": self._owner, "lease_ms": PULL_LEASE_MS},
                timeout=10.0,
            )
            if resp is None:
                continue
            if resp.status_code == 409:
                logger.debug("[golem] row %s already claimed elsewhere", queue_id[:8])
                return None
            if resp.status_code == 404:
                continue  # alternate id shape / older dashboard
            if resp.status_code >= 400:
                logger.warning(
                    "[golem] claim %s → HTTP %d: %s",
                    attempt_url,
                    resp.status_code,
                    resp.text[:160],
                )
                continue
            try:
                data = resp.json()
            except Exception:
                data = {}
            content = _extract_content(data)
            if content:
                return content
        if envelope_id:
            return _fetch_envelope_content(base, envelope_id)
        return None

    def _settle_row(self, queue_id: str) -> bool:
        url = f"{self._dashboard_url()}/api/dispatch-queue/{queue_id}/settle"
        resp = _request("POST", url, json_body={"owner": self._owner}, timeout=10.0)
        ok = resp is not None and resp.status_code < 300
        if not ok:
            logger.warning(
                "[golem] settle %s → %s", queue_id[:8], getattr(resp, "status_code", "no-conn")
            )
        return ok

    def _release_row(self, queue_id: str) -> bool:
        url = f"{self._dashboard_url()}/api/dispatch-queue/{queue_id}/release"
        resp = _request("POST", url, json_body={"owner": self._owner}, timeout=10.0)
        ok = resp is not None and resp.status_code < 300
        if not ok:
            logger.debug(
                "[golem] release %s → %s", queue_id[:8], getattr(resp, "status_code", "no-conn")
            )
        return ok

    def release_outstanding(self) -> None:
        """Return every claimed-but-unsettled row to pending (abort/crash path)."""
        with self._lock:
            outstanding = list(self._claimed.keys())
            self._claimed.clear()
        for queue_id in outstanding:
            try:
                self._release_row(queue_id)
                logger.info("[golem] released claimed row %s on stop", queue_id[:8])
            except Exception as exc:
                logger.debug("[golem] release failed for %s: %s", queue_id[:8], exc)

    # ── TUI injection ────────────────────────────────────────────────────

    def _submit_to_tui(self, content: str, row: Dict[str, Any]) -> Tuple[bool, str]:
        """Inject the brief into the running TUI session as a native turn.

        Primary surface (worker panes): the CLI reference handed to the plugin
        manager at cli.py ~16864. Routing mirrors cli.py's own external-input
        path (~8044): busy + interrupt mode → ``_interrupt_queue`` (worker
        default), otherwise ``_pending_input`` — the idle-poll loop drains it
        at ~10 Hz and runs it as the next native turn.

        Secondary surface (dashboard-PTY chats): tui_gateway
        ``prompt.submit`` — the same RPC the client composer uses; queues
        mid-turn and streams into the pane.
        """
        cli = _cli_tui_ref()
        if cli is not None and hasattr(cli, "_pending_input"):
            try:
                running = bool(getattr(cli, "_agent_running", False))
                mode = str(getattr(cli, "busy_input_mode", "interrupt") or "interrupt").lower()
                if running and mode == "interrupt":
                    cli._interrupt_queue.put(content)
                    return True, "cli interrupt-queue (mid-turn)"
                cli._pending_input.put(content)
                return True, f"cli input-queue (busy={running})"
            except Exception as exc:
                return False, f"cli queue put failed: {exc}"

        # Secondary surface: tui_gateway prompt.submit (desktop-PTY gateway).
        try:
            from tui_gateway import server as _tui_server

            handle_request = getattr(_tui_server, "handle_request", None)
            sessions = getattr(_tui_server, "_sessions", None)
            if handle_request is None or not isinstance(sessions, dict) or not sessions:
                return False, "no TUI surface (no CLI ref, no live tui_gateway session)"
            sid = self._pick_tui_gateway_session()
            if not sid:
                return False, "no live tui_gateway session"
            rid = f"golem-{uuid.uuid4().hex[:10]}"
            resp = handle_request(
                {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "method": "prompt.submit",
                    "params": {"session_id": sid, "text": content},
                }
            )
            if not isinstance(resp, dict):
                return False, f"unexpected response shape: {type(resp).__name__}"
            if resp.get("error"):
                msg = str((resp.get("error") or {}).get("message", ""))[:200]
                return False, f"prompt.submit error: {msg}"
            result = resp.get("result")
            status = str(result.get("status", "")) if isinstance(result, dict) else ""
            return True, f"tui_gateway session={sid} status={status or 'ok'}"
        except Exception as exc:
            return False, f"tui_gateway submit failed: {exc}"

    def _pick_tui_gateway_session(self) -> Optional[str]:
        """Newest live, non-finalized tui_gateway session id, or None."""
        try:
            from tui_gateway import server as _tui_server

            sessions = getattr(_tui_server, "_sessions", None)
        except Exception:
            return None
        if not isinstance(sessions, dict) or not sessions:
            return None
        lock = getattr(_tui_server, "_sessions_lock", None)
        try:
            if lock is not None:
                with lock:
                    items = list(sessions.items())
            else:
                items = list(sessions.items())
        except Exception:
            items = list(sessions.items())
        candidates = [
            (sid, sess)
            for sid, sess in items
            if isinstance(sess, dict) and not sess.get("_finalized")
        ]
        if not candidates:
            return None
        non_lazy = [pair for pair in candidates if not pair[1].get("lazy")]
        pool = non_lazy or candidates

        def _last_active(pair):
            try:
                return float(pair[1].get("last_active") or 0.0)
            except Exception:
                return 0.0

        return sorted(pool, key=_last_active, reverse=True)[0][0]


# ---------------------------------------------------------------------------
# Hook callbacks + process-singleton access (registered from register(ctx))
# ---------------------------------------------------------------------------

_CONTROLLER: Optional[TuiDispatchController] = None
_CONTROLLER_LOCK = threading.Lock()


def get_controller() -> TuiDispatchController:
    global _CONTROLLER
    with _CONTROLLER_LOCK:
        if _CONTROLLER is None:
            _CONTROLLER = TuiDispatchController()
        return _CONTROLLER


def on_session_start(**kwargs: Any) -> None:
    """VALID_HOOK 'on_session_start' — arm the in-TUI dispatch loop."""
    try:
        get_controller().notify_session_start(str(kwargs.get("session_id") or "") or None)
    except Exception as exc:
        logger.debug("[golem] on_session_start hook failed: %s", exc)


def on_session_end(**kwargs: Any) -> None:
    """VALID_HOOK 'on_session_end' — abort: stop the loop, release claims."""
    try:
        controller = _CONTROLLER
        if controller is not None:
            controller.notify_session_ended()
    except Exception as exc:
        logger.debug("[golem] on_session_end hook failed: %s", exc)


def on_session_finalize(**kwargs: Any) -> None:
    """VALID_HOOK 'on_session_finalize' — teardown pass; no-op when idle."""
    try:
        controller = _CONTROLLER
        if controller is not None:
            controller.stop(release=True, timeout=2.0)
    except Exception:
        pass


__all__ = [
    "TuiDispatchController",
    "get_controller",
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "PULL_LEASE_MS",
]