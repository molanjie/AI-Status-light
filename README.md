# Codex Status Light

A local Codex status collector with a responsive traffic-light dashboard.

Live dashboard: https://molanjie.github.io/AI-Status-light/

## Responsive Layout

Portrait phones retain the compact single-column layout. At 768px and above,
or on landscape screens at least 560px wide, the dashboard uses two columns
for usage/subscription details and session/connection panels. The status light
and summary remain full-width. Landscape phones also use tighter spacing.
Rotation needs no reload; low-height screens scroll normally, and safe-area
insets keep content away from notches. The top gap is 24px unless the device's
safe area requires more space.

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

## Connection Diagnostics

The dashboard does not display task history. Existing collector result
metadata remains compatible with older clients and lifecycle replay.

Connection diagnostics show the collector source, complete-response latency,
data age, and whether Codex is closed or the collector cannot read its data.
A remote network failure cannot prove whether the computer or the tunnel is
offline; the dashboard reports that uncertainty. The reconnect button refreshes
endpoint discovery and retries without erasing the last valid snapshot.
Invalid JSON/status data is rejected, and the 2.5-second timeout covers both
headers and the JSON response body.

## Live Details And Usage

Subscription details have their own card, with expiry or renewal date,
remaining days, and the source's refresh time. Local login metadata is not a
live billing query; expired or missing dates explicitly await synchronization.

Current conversations can be expanded to read their full displayed title,
model, status, start time, and running duration. The current action uses real
tool events and only exposes categories such as reading, editing, executing,
or searching, never command bodies or internal paths. Durations stop advancing
when the connection is lost.

Today and last-seven-day usage come from increments between JSONL cumulative
token observations, including archived conversations. Calendar days use
Asia/Shanghai; the rolling 24-hour counter is separate. Lifetime totals and
per-model totals still come from thread counters and are labelled separately.
Cached input is already included in input tokens, not added again. Incremental
scanning reports loading, and missing, reset, or ambiguous records are marked
incomplete rather than presented as exact consumption. No quota is inferred.

Sound and browser notifications are opt-in and can be filtered by completion,
waiting, or error. Initial snapshots and reconnects do not replay old alerts.
Settings persist locally; audio may need the test button after a page reload
to satisfy browser gesture requirements. These are page-local alerts, not
background push notifications: closing the page stops them.
Bursts are coalesced rather than discarded. Opaque, collector-scoped session
keys keep renamed or simultaneous tasks distinct without publishing thread IDs.

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
