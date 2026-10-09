# Status Diagnostics And Task History Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve lifecycle accuracy, explain connectivity problems, and retain recent task results without changing usage or subscription behavior.

**Architecture:** Incrementally reconstruct task results from existing local JSONL logs. Add backward-compatible history and diagnostic fields to `/api/status`; render them in the existing dashboard. Keep history bounded and exclude thread IDs, file paths, commands, and conversation content.

**Tech Stack:** Node.js, SQLite, Express, browser JavaScript, node:test, Playwright. No new dependencies.

**Spec:** User-approved first batch: state identification, connection diagnostics/retry, task history.

## Global Constraints
- Preserve red processing, yellow waiting/connectivity, green completed/idle.
- Keep completion highlight at 10 seconds and viewport top spacing at 24px.
- Do not re-enable the removed floating overlay or change token/subscription semantics.
- Recent history covers the last 24 hours of available unarchived logs, at most 20 results; restart reconstructs it from logs.
- Waiting persists until a matching response or terminal event; async questions do not block processing.

## Review Focus
- Late or duplicated completion events must not end a newer turn or duplicate history.
- A recoverable stream/tool error must not be classified as task failure.
- Unreadable logs must show degraded/error diagnostics rather than silently reporting idle.
- HTTP success with invalid or stalled JSON must not poison the last valid snapshot.
- Reconnection must preserve usage, sessions, and history; narrow screens must not overflow.

## Tasks
- [x] Add failing lifecycle/history tests; recognize verified terminal and blocking-input events, preserve unresolved waits, sanitize read failures, and reconstruct bounded history.
- [x] Add failing connection/runtime tests; validate responses, cover complete-body timeout, and show diagnostics with a serialized manual reconnect action.
- [x] Add recent-result rendering with literal text and durations; verify mobile, desktop, restart replay, disconnect/recovery, and existing regressions.
- [x] Document behavior, synchronize Pages assets, run the complete suite, and inspect the final diff.

## Execution Notes
- Lifecycle regression tests failed first, then passed after parser/history changes.
- Connection tests reproduced poisoned JSON, unbounded body reads, and ignored reconnect clicks before implementation.
- Added regression tests for parallel waits, duplicate starts, late terminal events, replay after restart, and completed-task counts.
- Ruling: Use the existing clean checkout on a `codex/` branch rather than a separate worktree, keeping this Windows service's stable source path intact.
- Ruling: Reconstruct history from persisted Codex logs rather than store a second private task journal; replay has the documented 24-hour/32-MiB coverage limits.
- Verified event names against the official Codex protocol, and checked local event metadata without reading conversation bodies into tool output.
- Fresh reviewer found five replay/cache/offline edge cases. Added seven failing regressions, then fixed old starts, answered-request replay, truncated-tail waits, optional-field validation/startup isolation, and offline history reconstruction; targeted suite now passes 54/54.
- User explicitly approved publishing this batch to the existing GitHub Pages site.
- Deployment audit found the watchdog did not accept new `cancelled`/`syncing` states or error sessions. Updated its health validator and added owned-server source freshness detection, with failing-first regressions, so verified backend upgrades can activate without a blind PID kill.
- Final suite: 121/121 passed. Real-collector browser checks confirmed cached history survives disconnection, reconnect works, 320/390/1280px layouts have top spacing 24px and no horizontal overflow, and reduced-motion animations are disabled.
- Restarted only the exact existing CodexStatusLightWatchdog scheduled task; its ownership checks safely reloaded the server. Live local response includes history and ready diagnostics.
