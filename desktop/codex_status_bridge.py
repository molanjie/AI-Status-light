import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


DB_PATH = Path(os.environ.get("CODEX_LOG_DB", Path.home() / ".codex" / "logs_2.sqlite"))
STATE_DB_PATH = Path(os.environ.get("CODEX_STATE_DB", Path.home() / ".codex" / "state_5.sqlite"))
SESSION_INDEX_PATH = Path(os.environ.get("CODEX_SESSION_INDEX", Path.home() / ".codex" / "session_index.jsonl"))
STATE_PATH = Path(__file__).with_name(".codex_status_bridge.json")
SIGNAL_URL = os.environ.get("MINI_WATCH_SIGNAL_URL", "http://127.0.0.1:3001/api/signal-light/state")
QUOTA_URL = os.environ.get("MINI_WATCH_QUOTA_URL", SIGNAL_URL.removesuffix("/state") + "/quota")
AUTH_PATH = Path(os.environ.get("CODEX_AUTH_PATH", Path.home() / ".codex" / "auth.json"))
SESSION_ID = os.environ.get("MINI_WATCH_SESSION_ID", "codex-auto")
ENABLE_QUOTA = os.environ.get("MINI_WATCH_ENABLE_QUOTA", "").lower() in {"1", "true", "yes", "on"}

POLL_SECONDS = 0.18
HEARTBEAT_SECONDS = 8.0
IDLE_AFTER_SILENCE_SECONDS = 180.0
IDLE_AFTER_FINAL_SECONDS = 1.2
IDLE_AFTER_TOOL_RESPONSE_SECONDS = 600.0
POST_DEBOUNCE_SECONDS = 0.25
QUOTA_POLL_SECONDS = 60.0

WORKING_TYPES = {
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.delta",
    "response.output_item.done",
    "response.output_text.delta",
    "response.reasoning_text.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
}

IDLE_TYPES = {
    "response.completed",
}

ERROR_TYPES = {
    "response.failed",
    "response.incomplete",
    "error",
}

THREAD_LABEL_CACHE: dict[str, tuple[str | None, float]] = {}
THREAD_LABEL_TTL_SECONDS = 2.0


def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", flush=True)


def read_state() -> dict:
    try:
        with STATE_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_state(data: dict) -> None:
    tmp = STATE_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=True)
    tmp.replace(STATE_PATH)


def open_db() -> sqlite3.Connection:
    uri = DB_PATH.as_posix()
    con = sqlite3.connect(f"file:{uri}?mode=ro", uri=True, timeout=0.2)
    con.row_factory = sqlite3.Row
    return con


def open_state_db() -> sqlite3.Connection:
    uri = STATE_DB_PATH.as_posix()
    con = sqlite3.connect(f"file:{uri}?mode=ro", uri=True, timeout=0.2)
    con.row_factory = sqlite3.Row
    return con


def current_max_id() -> int:
    try:
        with open_db() as con:
            row = con.execute("select max(id) as id from logs").fetchone()
            return int(row["id"] or 0)
    except sqlite3.Error:
        return 0


def fetch_rows(after_id: int) -> list[sqlite3.Row]:
    with open_db() as con:
        return con.execute(
            "select id, target, feedback_log_body, thread_id from logs where id > ? order by id asc limit 500",
            (after_id,),
        ).fetchall()


def short_session_id(value: str) -> str:
    clean = "".join(ch for ch in value if ch.isalnum())
    if not clean:
        return "main"
    return clean[-6:] if len(clean) > 6 else clean


def clean_thread_label(value: str | None) -> str | None:
    if not value:
        return None
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)
    text = " ".join(text.split())
    if not text:
        return None
    return text[:157] + "..." if len(text) > 160 else text


def label_from_state_db(thread_id: str) -> str | None:
    if not STATE_DB_PATH.exists():
        return None
    try:
        with open_state_db() as con:
            row = con.execute(
                "select title, first_user_message, preview, cwd from threads where id = ?",
                (thread_id,),
            ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None

    for key in ("title", "first_user_message", "preview"):
        label = clean_thread_label(str(row[key] or ""))
        if label:
            return label

    cwd = clean_thread_label(Path(str(row["cwd"] or "")).name)
    return cwd


def label_from_session_index(thread_id: str) -> str | None:
    if not SESSION_INDEX_PATH.exists():
        return None
    try:
        lines = SESSION_INDEX_PATH.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        if thread_id not in line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        label = clean_thread_label(str(data.get("thread_name") or ""))
        if label:
            return label
    return None


def thread_label(thread_id: str) -> str:
    now = time.monotonic()
    cached = THREAD_LABEL_CACHE.get(thread_id)
    if cached and now - cached[1] < THREAD_LABEL_TTL_SECONDS:
        label = cached[0]
        return label or f"会话 {short_session_id(thread_id)}"

    label = label_from_session_index(thread_id) or label_from_state_db(thread_id)
    THREAD_LABEL_CACHE[thread_id] = (label, now)
    return label or f"会话 {short_session_id(thread_id)}"


def label_for_session_id(session_id: str, fallback: str | None = None) -> str:
    prefix = "codex:"
    if session_id.startswith(prefix):
        return thread_label(session_id[len(prefix):])
    return fallback or f"会话 {short_session_id(session_id)}"


def row_session(row: sqlite3.Row) -> tuple[str, str, bool]:
    thread_id = str(row["thread_id"] or "").strip()
    if thread_id:
        return f"codex:{thread_id}", thread_label(thread_id), True
    return SESSION_ID, f"会话 {short_session_id(SESSION_ID)}", False


def make_session_state(label: str) -> dict:
    return {
        "label": label,
        "last_post": {"signal": None, "at": 0.0},
        "active": False,
        "response_has_tool_call": False,
        "last_completed_had_tool": False,
        "last_activity": 0.0,
        "last_heartbeat": 0.0,
        "pending_idle_at": 0.0,
    }


def post_signal(signal: str, last_post: dict, session_id: str, label: str) -> bool:
    now = time.monotonic()
    previous = last_post.get("signal")
    if (
        previous == signal
        and now - float(last_post.get("at") or 0) < POST_DEBOUNCE_SECONDS
    ):
        return True

    body = json.dumps(
        {"signal": signal, "session_id": session_id, "label": label},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        SIGNAL_URL,
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=1.0).read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log(f"post failed: {exc}")
        return False

    last_post["signal"] = signal
    last_post["at"] = now
    if previous != signal:
        log(f"{label} -> {signal}")
    return True


def post_quota(payload: dict, last_post: dict) -> bool:
    if not ENABLE_QUOTA:
        return False

    signature = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    now = time.monotonic()
    if (
        last_post.get("signature") == signature
        and now - float(last_post.get("at") or 0) < QUOTA_POLL_SECONDS
    ):
        return True

    body = signature.encode("utf-8")
    req = urllib.request.Request(
        QUOTA_URL,
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=1.0).read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return False

    last_post["signature"] = signature
    last_post["at"] = now
    log("quota updated")
    return True


def looks_like_quota(value: dict) -> bool:
    keys = set(value)
    if keys & {"five_hour", "fiveHour", "five_hours", "fiveHours", "weekly", "week"}:
        return True
    if keys & {"rate_limit", "rateLimit", "additional_rate_limits", "additionalRateLimits"}:
        return True
    if keys & {"primary_window", "primaryWindow", "secondary_window", "secondaryWindow"}:
        return True
    if (
        keys & {"used_percent", "usedPercent", "remaining_percent", "remainingPercent"}
        and keys & {"limit_window_seconds", "limitWindowSeconds", "window_minutes", "windowMinutes"}
    ):
        return True
    return False


def find_quota_payload(value, depth: int = 0):
    if depth > 8:
        return None
    if isinstance(value, dict):
        if looks_like_quota(value):
            return value
        for child in value.values():
            found = find_quota_payload(child, depth + 1)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_quota_payload(child, depth + 1)
            if found is not None:
                return found
    return None


def iter_json_objects(text: str):
    decoder = json.JSONDecoder()
    pos = 0
    while True:
        start = text.find("{", pos)
        if start < 0:
            return
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            pos = start + 1
            continue
        yield value
        pos = start + max(end, 1)


def quota_from_row(row: sqlite3.Row):
    body = str(row["feedback_log_body"] or "")
    if not any(token in body for token in ("rate_limit", "rateLimit", "rateLimits", "primary_window", "used_percent")):
        return None
    for value in iter_json_objects(body):
        found = find_quota_payload(value)
        if found is not None:
            return found
    return None


def is_quota_update_row(row: sqlite3.Row) -> bool:
    body = str(row["feedback_log_body"] or "")
    return "account/rateLimits/updated" in body or "rateLimits/updated" in body


def read_access_token() -> str | None:
    try:
        with AUTH_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    tokens = data.get("tokens")
    if isinstance(tokens, dict) and isinstance(tokens.get("access_token"), str):
        return tokens["access_token"]
    token = data.get("access_token")
    return token if isinstance(token, str) else None


def fetch_codex_quota():
    token = read_access_token()
    if not token:
        return None

    endpoints = (
        "https://chatgpt.com/backend-api/wham/accounts/check",
        "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
    )
    headers = {
        "authorization": f"Bearer {token}",
        "accept": "application/json",
        "user-agent": "mini-watch-codex",
    }
    for url in endpoints:
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=1.5) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
            continue
        found = find_quota_payload(data)
        if found is not None:
            return found
    return None


def trigger_quota_fetch(fetch_state: dict, last_quota_post: dict) -> None:
    if not ENABLE_QUOTA:
        return

    if fetch_state.get("running"):
        return
    fetch_state["running"] = True
    fetch_state["last_poll"] = time.monotonic()

    def run() -> None:
        try:
            payload = fetch_codex_quota()
            if isinstance(payload, dict):
                post_quota(payload, last_quota_post)
        finally:
            fetch_state["running"] = False

    threading.Thread(target=run, daemon=True).start()


def extract_sse(body: str) -> dict | None:
    prefix = "SSE event: "
    if not body.startswith(prefix):
        return None
    try:
        data = json.loads(body[len(prefix):])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def signal_from_sse(data: dict) -> str | None:
    event_type = str(data.get("type") or "")
    response = data.get("response") if isinstance(data.get("response"), dict) else {}
    item = data.get("item") if isinstance(data.get("item"), dict) else {}

    if event_type in ERROR_TYPES:
        return "error"

    if event_type == "response.created":
        return "response_start"

    if event_type in IDLE_TYPES:
        if response.get("error"):
            return "error"
        if response.get("incomplete_details"):
            return "interrupted"
        if response.get("status") in {"failed", "cancelled"}:
            return "error"
        if response.get("status") == "incomplete":
            return "interrupted"
        return "completed"

    if (
        event_type in {"response.output_item.added", "response.output_item.done"}
        and item.get("type") == "function_call"
    ):
        return "tool_call"

    if event_type in WORKING_TYPES:
        return "working"

    return None


def signal_from_otel(body: str) -> str | None:
    if "event.name=\"codex.sse_event\"" not in body:
        if "event.name=\"codex.tool_decision\"" in body:
            if "decision=ask" in body or "decision=needs" in body or "decision=untrusted" in body:
                return "permission"
            return "tool_call"
        return None
    if "event.kind=response.completed" in body:
        return "completed"
    if "event.kind=response.failed" in body or "event.kind=response.incomplete" in body:
        return "error"
    if (
        "event.kind=response.created" in body
        or "event.kind=response.in_progress" in body
        or "event.kind=response.output_text.delta" in body
        or "event.kind=response.function_call_arguments.delta" in body
        or "event.kind=response.function_call_arguments.done" in body
    ):
        return "working"
    return None


def signal_from_row(row: sqlite3.Row) -> str | None:
    target = str(row["target"] or "")
    body = str(row["feedback_log_body"] or "")

    if target == "codex_api::sse::responses":
        data = extract_sse(body)
        if data is not None:
            return signal_from_sse(data)
        if "response.in_progress" in body or "response.created" in body:
            return "working"
        if "response.completed" in body:
            return "completed"
        if "response.failed" in body or "response.incomplete" in body:
            return "error"

    if target == "codex_otel.log_only":
        return signal_from_otel(body)

    if target == "codex_core::stream_events_utils":
        if "Output item item=FunctionCall" in body or "ToolCall:" in body:
            return "tool_call"
        if "Output item item=Message" in body or "Output item item=Reasoning" in body:
            return "working"

    if target == "codex_core::spawn":
        if "tool_name=" in body or "ToolCall:" in body:
            return "tool_call"

    return None


def main() -> int:
    if not DB_PATH.exists():
        log(f"Codex log database not found: {DB_PATH}")
        return 2

    state = read_state()
    last_id = int(state.get("last_id") or 0)
    if last_id <= 0:
        last_id = current_max_id()
        write_state({"last_id": last_id})
        log(f"initialized at log id {last_id}")

    session_states: dict[str, dict] = {}
    last_real_session = {"session_id": None, "label": None}
    last_quota_post = {"signature": None, "at": 0.0}
    quota_fetch_state = {"running": False, "last_poll": 0.0}
    log(f"watching {DB_PATH}")
    if ENABLE_QUOTA:
        trigger_quota_fetch(quota_fetch_state, last_quota_post)

    while True:
        try:
            rows = fetch_rows(last_id)
        except sqlite3.Error as exc:
            log(f"read failed: {exc}")
            time.sleep(POLL_SECONDS)
            continue

        for row in rows:
            last_id = max(last_id, int(row["id"]))
            if ENABLE_QUOTA:
                quota = quota_from_row(row)
                if isinstance(quota, dict):
                    post_quota(quota, last_quota_post)
                elif is_quota_update_row(row):
                    trigger_quota_fetch(quota_fetch_state, last_quota_post)

            signal = signal_from_row(row)
            if signal is None:
                continue

            session_id, label, has_thread = row_session(row)
            if has_thread:
                if (
                    not last_real_session["session_id"]
                    and session_id != SESSION_ID
                    and SESSION_ID in session_states
                ):
                    fallback = session_states[SESSION_ID]
                    fallback_label = str(fallback.get("label") or f"会话 {short_session_id(SESSION_ID)}")
                    fallback["active"] = False
                    fallback["pending_idle_at"] = 0.0
                    post_signal("off", fallback["last_post"], SESSION_ID, fallback_label)
                last_real_session["session_id"] = session_id
                last_real_session["label"] = label
            elif last_real_session["session_id"] and last_real_session["label"]:
                session_id = str(last_real_session["session_id"])
                label = str(last_real_session["label"])
            session = session_states.setdefault(session_id, make_session_state(label))
            session["label"] = label

            now = time.monotonic()
            if signal == "response_start":
                session["response_has_tool_call"] = False
                session["last_completed_had_tool"] = False
                session["pending_idle_at"] = 0.0
                session["active"] = True
                session["last_activity"] = now
                post_signal("working", session["last_post"], session_id, label)
                session["last_heartbeat"] = now
            elif signal == "tool_call":
                session["response_has_tool_call"] = True
                session["last_completed_had_tool"] = False
                session["pending_idle_at"] = 0.0
                session["active"] = True
                session["last_activity"] = now
                post_signal("working", session["last_post"], session_id, label)
                session["last_heartbeat"] = now
            elif signal == "working":
                session["last_completed_had_tool"] = False
                session["pending_idle_at"] = 0.0
                session["active"] = True
                session["last_activity"] = now
                post_signal("working", session["last_post"], session_id, label)
                session["last_heartbeat"] = now
            elif signal == "completed":
                if session["response_has_tool_call"]:
                    session["pending_idle_at"] = now + IDLE_AFTER_TOOL_RESPONSE_SECONDS
                    session["active"] = True
                    session["last_completed_had_tool"] = True
                    post_signal("working", session["last_post"], session_id, label)
                    session["last_heartbeat"] = now
                elif session["last_completed_had_tool"] and session["pending_idle_at"]:
                    pass
                else:
                    session["pending_idle_at"] = now + IDLE_AFTER_FINAL_SECONDS
                    session["last_completed_had_tool"] = False
                session["response_has_tool_call"] = False
                session["last_activity"] = now
            else:
                session["pending_idle_at"] = 0.0
                session["response_has_tool_call"] = False
                session["last_completed_had_tool"] = False
                session["active"] = False
                post_signal(signal, session["last_post"], session_id, label)

        if rows:
            write_state({"last_id": last_id})

        now = time.monotonic()
        for session_id, session in list(session_states.items()):
            label = str(session.get("label") or f"会话 {short_session_id(session_id)}")
            label = label_for_session_id(session_id, label)
            session["label"] = label
            if session["active"] and now - float(session["last_heartbeat"] or 0) >= HEARTBEAT_SECONDS:
                post_signal("working", session["last_post"], session_id, label)
                session["last_heartbeat"] = now

            if session["pending_idle_at"] and now >= float(session["pending_idle_at"]):
                session["active"] = False
                session["pending_idle_at"] = 0.0
                session["last_completed_had_tool"] = False
                post_signal("off", session["last_post"], session_id, label)

            if (
                session["active"]
                and session["last_activity"]
                and now - float(session["last_activity"]) >= IDLE_AFTER_SILENCE_SECONDS
            ):
                session["active"] = False
                session["pending_idle_at"] = 0.0
                session["response_has_tool_call"] = False
                session["last_completed_had_tool"] = False
                post_signal("off", session["last_post"], session_id, label)

        if ENABLE_QUOTA and now - float(quota_fetch_state.get("last_poll") or 0) >= QUOTA_POLL_SECONDS:
            trigger_quota_fetch(quota_fetch_state, last_quota_post)

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.exit(0)
