# Codex Status Light

A local Codex status collector with a responsive traffic-light dashboard.

Live dashboard: https://molanjie.github.io/AI-Status-light/

## Run Locally

Use Node.js 24 or later with `node:sqlite` support.

```powershell
npm install
npm start
```

Open http://127.0.0.1:3456. The collector reads the newest
`~/.codex/state_*.sqlite`, session JSONL files, and subscription dates from
`~/.codex/auth.json`. It does not make OpenAI API requests.

## Status Meaning

- Red: at least one task is processing.
- Yellow: tasks need user input, initial synchronization, or lost connectivity.
- Green: completed for 10 seconds, then idle.
- Flashing red: a task failed or status reading failed.
- Green cancellation: a task was interrupted, not successfully completed.

The session list retains both processing and waiting tasks. Subscription
dates refresh from local login data; stale dates wait for synchronization
instead of claiming a renewal. An optional future `SUBSCRIPTION_RENEWAL_DATE`
in `.env` is a date-only fallback and cannot override a newer token date.

Blocking input and approval requests stay yellow until the matching response
or operation resumes, or the turn ends. Nonblocking async questions and
recoverable stream/tool errors do not stop the processing state. Unreadable
logs and stale tasks are explicitly diagnosed instead of reported as idle.

## History And Connection Diagnostics

Task history shows up to 20 completed, cancelled, or failed turns from
available unarchived logs updated within the last 24 hours. It includes the
current conversation title, result, completion time, and duration when known.
The collector reconstructs it from existing JSONL logs after restart; it does
not maintain a separate copy of conversation content. Initial replay reads
at most the last 32 MiB per log, so older results outside that tail can be absent.

Connection diagnostics show the collector source, complete-response latency,
data age, and whether Codex is closed or the collector cannot read its data.
A remote network failure cannot prove whether the computer or the tunnel is
offline; the dashboard reports that uncertainty. The reconnect button refreshes
endpoint discovery and retries without erasing the last valid snapshot/history.
Invalid JSON/status data is rejected, and the 2.5-second timeout covers both
headers and the JSON response body.

Token totals come from Codex's local thread counters. The recent-dialogue
metric sums lifetime tokens for dialogues updated in the last 24 hours;
it is not a count of tokens newly consumed within 24 hours or a quota estimate.

## Background Service

Authenticate GitHub CLI with `gh auth login`. Install the watchdog from
the stable project directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-codex-status-watchdog.ps1 -StartNow
```

The hidden scheduled task supervises the local server and Cloudflare Quick
Tunnel. It publishes the current endpoint to the `live-status` branch.
GitHub Pages serves `docs`; the computer and watchdog must run for live data.
The watchdog reloads backend code updated after its verified owned server
started, so publishing a frontend does not leave the collector on old logic.

Runtime logs and PID claims are in `%LOCALAPPDATA%\CodexStatusLight`.
If a claim is corrupt, retain a backup and verify the listener and process
ownership before repairing it. Never blindly kill a PID from a damaged file.

## Verify And Publish

```powershell
npm run build:pages
npm test
node scripts/verify-live-page.js
```

Edit `public` and synchronize `docs` with `build:pages` before publishing.
The live verifier checks cached offline status, recovery without reloading,
and 320px, 390px, and desktop widths.
