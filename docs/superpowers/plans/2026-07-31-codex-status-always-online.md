# Codex Status Always-Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the GitHub Pages status page continuously available, show an honest cached offline state while the PC is unavailable, and automatically restore the local status service plus public tunnel within 90 seconds after Windows logon or an owned-process failure.

**Architecture:** GitHub Pages remains the fixed frontend. A testable browser connection module discovers the current Quick Tunnel URL from an `endpoint.json` file on an orphan `live-status` branch and persists the last good status locally. A single-instance PowerShell watchdog owns and health-checks the Node server and Cloudflare tunnel, while a Node publisher updates the runtime endpoint through the GitHub API without changing `master` or the local worktree.

**Tech Stack:** Node.js 24.15.0, Express 4, Node built-in test runner, browser JavaScript without a bundler, Windows PowerShell 5.1, GitHub CLI 2.92.0, cloudflared 2026.5.2, GitHub Pages.

## Global Constraints

- Keep the fixed public page at `https://molanjie.github.io/AI-Status-light/`.
- Do not add a Cloudflare account, paid service, runtime npm dependency, or public secret.
- Keep `/api/status` response fields and refresh behavior compatible with the current page.
- Do not expose conversation bodies, internal paths, thread IDs, GitHub tokens, or local user directories.
- Treat Windows user logon, not pre-logon boot, as the start of the 90-second recovery window.
- Poll `/api/status` every 1 second and refresh the endpoint registry every 30 seconds.
- Require three consecutive failed polling rounds before showing yellow `采集端离线`.
- Preserve the last good status and its timestamp; never replace it with fabricated zero counts or an idle state.
- Update runtime endpoint data only on `live-status`; never write runtime commits to `master` or modify the local worktree.
- Stop or restart only processes proven to be owned by the watchdog through PID files and command-line checks.
- Keep the existing responsive layout free of horizontal overflow at 320px, 390px, and desktop widths.
- Keep the two existing untracked `codex-status-server.*.log` files out of every commit.

## File Map

- Modify `server.js`: expose an injectable Express app and add the cheap health endpoint.
- Create `test/server.test.js`: verify health behavior and status-reader isolation.
- Create `public/status-connection.js`: pure endpoint validation, candidate ordering, snapshot persistence, and failure-threshold logic.
- Create `test/status-connection.test.js`: unit tests for the browser connection module.
- Modify `public/index.html`: consume the connection module, registry, persistent snapshot, and offline semantics.
- Create `scripts/sync-pages.js`: copy canonical public assets to `docs`.
- Modify `package.json`: add the Pages sync command.
- Create `test/pages-sync.test.js`: enforce public/docs parity and absence of a compiled tunnel URL.
- Generate `docs/index.html` and `docs/status-connection.js`: GitHub Pages artifacts.
- Create `scripts/endpoint-registry.js`: validate and publish `endpoint.json` to the orphan `live-status` branch through GitHub REST.
- Create `test/endpoint-registry.test.js`: mocked create, update, and no-op publisher tests.
- Create `scripts/CodexStatusWatchdog.psm1`: focused PowerShell functions for URL parsing, dependency resolution, HTTP checks, and owned-process validation.
- Create `scripts/codex-status-watchdog.ps1`: single-instance supervision loop.
- Create `test/watchdog.test.js`: invoke PowerShell functions and dry-run configuration from Node tests.
- Create `scripts/install-codex-status-watchdog.ps1`: idempotent Task Scheduler installation, inspection, start, and removal.
- Create `scripts/verify-live-page.js`: Playwright verification for cached offline state, automatic reconnection, and responsive widths.
- Modify `.gitignore`: ignore legacy Codex status runtime logs while leaving existing files untouched.

---

### Task 1: Add a Cheap, Injectable Health Endpoint

**Files:**
- Modify: `server.js:1-37`
- Create: `test/server.test.js`

**Interfaces:**
- Consumes: existing `readCodexStatus(): object`.
- Produces: `createApp(options?): Express.Application`, `startServer(options?): http.Server`, and `GET /api/health -> { ok, startedAt, now }`.

- [ ] **Step 1: Write the failing server tests**

Create `test/server.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const { createApp } = require("../server");

async function withServer(app, callback) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("health endpoint is cheap and does not read Codex state", async () => {
  let readCount = 0;
  const app = createApp({
    readStatus() {
      readCount += 1;
      return { state: "idle" };
    },
    startedAt: 1785432000000,
    now: () => 1785432005000,
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      startedAt: 1785432000000,
      now: 1785432005000,
    });
  });

  assert.equal(readCount, 0);
});

test("status endpoint still delegates to the injected reader", async () => {
  const expected = { state: "processing", sessionCount: 1 };
  const app = createApp({ readStatus: () => expected });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run:

```powershell
node --test test/server.test.js
```

Expected: FAIL because `server.js` does not export `createApp` and starts listening during import.

- [ ] **Step 3: Refactor `server.js` and add `/api/health`**

Use this public shape:

```js
const express = require("express");
const path = require("path");
require("dotenv").config();

const { readCodexStatus } = require("./codex-status");

function createApp(options = {}) {
  const readStatus = options.readStatus || readCodexStatus;
  const startedAt = options.startedAt || Date.now();
  const now = options.now || Date.now;
  const app = express();

  app.use(express.static(path.join(__dirname, "public")));
  app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, startedAt, now: now() });
  });

  app.get("/api/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(readStatus());
  });

  return app;
}

function startServer(options = {}) {
  const port = options.port || process.env.PORT || 3456;
  const host = options.host || process.env.HOST || "0.0.0.0";
  const server = createApp(options).listen(port, host);
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
```

- [ ] **Step 4: Run focused and full tests**

Run:

```powershell
node --test test/server.test.js
npm.cmd test
```

Expected: both commands PASS; importing `server.js` leaves port `3456` unused.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- server.js test/server.test.js
git commit -m "feat: add lightweight status health endpoint"
```

---

### Task 2: Build the Testable Browser Connection Core

**Files:**
- Create: `public/status-connection.js`
- Create: `test/status-connection.test.js`

**Interfaces:**
- Consumes: `Storage`-compatible objects and parsed registry JSON.
- Produces: global/CommonJS `CodexStatusConnection` with `parseRegistry`, `buildApiCandidates`, `loadSnapshot`, `saveSnapshot`, and `createFailureTracker`.

- [ ] **Step 1: Write the failing connection tests**

Create `test/status-connection.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const connection = require("../public/status-connection");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("accepts only schema 1 HTTPS Quick Tunnel registries", () => {
  assert.deepEqual(
    connection.parseRegistry({
      schemaVersion: 1,
      apiBase: "https://fresh-tunnel.trycloudflare.com/",
      publishedAt: "2026-07-31T12:00:00.000Z",
    }),
    {
      apiBase: "https://fresh-tunnel.trycloudflare.com",
      publishedAt: "2026-07-31T12:00:00.000Z",
    }
  );
  assert.equal(
    connection.parseRegistry({
      schemaVersion: 1,
      apiBase: "http://fresh-tunnel.trycloudflare.com",
      publishedAt: "2026-07-31T12:00:00.000Z",
    }),
    null
  );
  assert.equal(
    connection.parseRegistry({
      schemaVersion: 1,
      apiBase: "https://example.com",
      publishedAt: "2026-07-31T12:00:00.000Z",
    }),
    null
  );
});

test("orders explicit, registry, stored, and local candidates without duplicates", () => {
  assert.deepEqual(
    connection.buildApiCandidates({
      explicitBase: "https://manual.example",
      registryBase: "https://live.trycloudflare.com",
      storedBase: "https://live.trycloudflare.com/",
      isFile: true,
    }),
    [
      "https://manual.example",
      "https://live.trycloudflare.com",
      "http://127.0.0.1:3456",
    ]
  );
});

test("round-trips the last good snapshot and rejects malformed data", () => {
  const storage = memoryStorage();
  const data = { state: "processing", sessionCount: 2 };
  connection.saveSnapshot(storage, data, 1785432000000);
  assert.deepEqual(connection.loadSnapshot(storage), {
    data,
    savedAt: 1785432000000,
  });

  const malformed = memoryStorage({
    codex_status_last_good_v1: "{\"data\":null,\"savedAt\":\"bad\"}",
  });
  assert.equal(connection.loadSnapshot(malformed), null);
});

test("requires three consecutive failures and resets after success", () => {
  const tracker = connection.createFailureTracker(3);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(tracker.recordFailure(), true);
  tracker.recordSuccess();
  assert.equal(tracker.count(), 0);
  assert.equal(tracker.recordFailure(), false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
node --test test/status-connection.test.js
```

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `public/status-connection.js`**

Use a UMD wrapper so the same file is testable by Node and loadable as a plain browser script:

```js
(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexStatusConnection = api;
})(typeof window === "object" ? window : globalThis, function createApi() {
  const SNAPSHOT_KEY = "codex_status_last_good_v1";

  function normalizeApiBase(value) {
    return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  }

  function parseRegistry(value) {
    if (!value || value.schemaVersion !== 1) return null;
    const apiBase = normalizeApiBase(value.apiBase);
    const publishedAt = value.publishedAt;
    try {
      const url = new URL(apiBase);
      const allowedHost =
        url.hostname.length > ".trycloudflare.com".length &&
        url.hostname.endsWith(".trycloudflare.com");
      if (url.protocol !== "https:" || !allowedHost || url.username || url.password) return null;
      if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) return null;
      return { apiBase, publishedAt };
    } catch (error) {
      return null;
    }
  }

  function buildApiCandidates(options = {}) {
    const result = [];
    function add(value) {
      const normalized = normalizeApiBase(value);
      if (normalized && !result.includes(normalized)) result.push(normalized);
    }
    add(options.explicitBase);
    add(options.registryBase);
    add(options.storedBase);
    if (options.isFile) add("http://127.0.0.1:3456");
    return result;
  }

  function loadSnapshot(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(SNAPSHOT_KEY));
      if (!parsed || !parsed.data || !Number.isFinite(parsed.savedAt)) return null;
      return { data: parsed.data, savedAt: parsed.savedAt };
    } catch (error) {
      return null;
    }
  }

  function saveSnapshot(storage, data, savedAt) {
    if (!data || !Number.isFinite(savedAt)) return;
    try {
      storage.setItem(SNAPSHOT_KEY, JSON.stringify({ data, savedAt }));
    } catch (error) {}
  }

  function createFailureTracker(limit) {
    let failures = 0;
    return {
      recordFailure() {
        failures += 1;
        return failures >= limit;
      },
      recordSuccess() {
        failures = 0;
      },
      count() {
        return failures;
      },
    };
  }

  return {
    SNAPSHOT_KEY,
    normalizeApiBase,
    parseRegistry,
    buildApiCandidates,
    loadSnapshot,
    saveSnapshot,
    createFailureTracker,
  };
});
```

- [ ] **Step 4: Run focused and full tests**

Run:

```powershell
node --test test/status-connection.test.js
npm.cmd test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- public/status-connection.js test/status-connection.test.js
git commit -m "feat: add resilient status connection core"
```

---

### Task 3: Integrate Registry Discovery, Persistent Offline State, and Pages Sync

**Files:**
- Modify: `public/index.html:1029-1208`
- Create: `scripts/sync-pages.js`
- Modify: `package.json`
- Create: `test/pages-sync.test.js`
- Generate: `docs/index.html`
- Generate: `docs/status-connection.js`

**Interfaces:**
- Consumes: `window.CodexStatusConnection` from Task 2 and the raw registry URL.
- Produces: a canonical public page, generated Pages assets, 30-second registry refresh, one-second non-overlapping status polling, and persistent yellow offline state after three failures.

- [ ] **Step 1: Write the failing Pages contract test**

Create `test/pages-sync.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("published assets match canonical public assets", () => {
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "index.html"), "utf8"),
    fs.readFileSync(path.join(root, "public", "index.html"), "utf8")
  );
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "status-connection.js"), "utf8"),
    fs.readFileSync(path.join(root, "public", "status-connection.js"), "utf8")
  );
});

test("published page discovers live endpoint without a compiled tunnel URL", () => {
  const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
  assert.match(html, /status-connection\.js/);
  assert.match(
    html,
    /raw\.githubusercontent\.com\/molanjie\/AI-Status-light\/live-status\/endpoint\.json/
  );
  assert.doesNotMatch(html, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  assert.match(html, /采集端离线/);
});
```

- [ ] **Step 2: Run the Pages test and verify it fails**

Run:

```powershell
node --test test/pages-sync.test.js
```

Expected: FAIL because `docs/status-connection.js` does not exist and `docs/index.html` still contains the stale tunnel.

- [ ] **Step 3: Add the external connection script and connection state**

In `public/index.html`, load the module immediately before the existing inline script:

```html
<script src="./status-connection.js"></script>
<script>
```

Replace the compiled endpoint constants with:

```js
var connectionApi = window.CodexStatusConnection;
var ENDPOINT_REGISTRY_URL =
  "https://raw.githubusercontent.com/molanjie/AI-Status-light/live-status/endpoint.json";
var STATUS_API_STORAGE_KEY = "codex_status_api_base";
var STATUS_REFRESH_MS = 1000;
var REGISTRY_REFRESH_MS = 30000;
var registryApiBase = "";
var statusRequestInFlight = false;
var failureTracker = connectionApi.createFailureTracker(3);
```

Replace candidate construction with:

```js
function getStatusApiBases() {
  var params = new URLSearchParams(window.location.search);
  var storedBase = "";
  try {
    storedBase = localStorage.getItem(STATUS_API_STORAGE_KEY);
  } catch (error) {}
  return connectionApi.buildApiCandidates({
    explicitBase: params.get("api"),
    registryBase: registryApiBase,
    storedBase: storedBase,
    isFile: window.location.protocol === "file:",
  });
}
```

Add registry refresh:

```js
async function refreshEndpointRegistry() {
  try {
    var response = await fetch(
      ENDPOINT_REGISTRY_URL + "?t=" + Date.now(),
      { cache: "no-store" }
    );
    if (!response.ok) throw new Error("HTTP " + response.status);
    var parsed = connectionApi.parseRegistry(await response.json());
    if (!parsed) throw new Error("Invalid endpoint registry");
    var changed = parsed.apiBase !== registryApiBase;
    registryApiBase = parsed.apiBase;
    if (changed) fetchStatus();
  } catch (error) {}
}
```

Restore cached status once after all render functions are defined:

```js
function restoreLastGoodSnapshot() {
  var snapshot = null;
  try {
    snapshot = connectionApi.loadSnapshot(window.localStorage);
  } catch (error) {}
  if (!snapshot) return;
  lastGoodStatus = snapshot.data;
  lastSyncAt = snapshot.savedAt;
  renderStatus(lastGoodStatus);
  el("status-time").textContent = "上次同步 " + formatSyncTime(lastSyncAt);
}
```

- [ ] **Step 4: Make polling non-overlapping and apply the three-failure threshold**

Replace `fetchStatus()` with logic that:

```js
async function fetchStatus() {
  if (statusRequestInFlight) return;
  statusRequestInFlight = true;
  var triedUrls = [];
  try {
    var bases = getStatusApiBases();
    for (var i = 0; i < bases.length; i += 1) {
      var base = bases[i];
      var apiUrl = getStatusApiUrl(base);
      triedUrls.push(apiUrl);
      try {
        var response = await fetchStatusFromApi(apiUrl);
        if (!response.ok) throw new Error("HTTP " + response.status);
        var data = await response.json();
        rememberStatusApiBase(base);
        lastGoodStatus = data;
        lastSyncAt = Date.now();
        try {
          connectionApi.saveSnapshot(window.localStorage, data, lastSyncAt);
        } catch (storageError) {}
        failureTracker.recordSuccess();
        renderStatus(data);
        el("status-time").textContent = "已同步 " + formatSyncTime(lastSyncAt);
        return;
      } catch (error) {}
    }

    if (!failureTracker.recordFailure()) return;
    renderConnectionState(
      "disconnected",
      "采集端离线",
      lastGoodStatus ? "正在显示上次有效状态" : "等待本机恢复连接",
      triedUrls
    );
  } finally {
    statusRequestInFlight = false;
  }
}
```

Update `stateLabels.disconnected` and capsule labels to `采集端离线`. Initialize in this order:

```js
restoreLastGoodSnapshot();
refreshEndpointRegistry();
fetchStatus();
setInterval(fetchStatus, STATUS_REFRESH_MS);
setInterval(refreshEndpointRegistry, REGISTRY_REFRESH_MS);
```

- [ ] **Step 5: Add deterministic Pages synchronization**

Create `scripts/sync-pages.js`:

```js
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pairs = [
  ["public/index.html", "docs/index.html"],
  ["public/status-connection.js", "docs/status-connection.js"],
];

for (const [source, target] of pairs) {
  fs.copyFileSync(path.join(root, source), path.join(root, target));
}
```

Add to `package.json`:

```json
{
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "build:pages": "node scripts/sync-pages.js",
    "test": "node --test"
  }
}
```

- [ ] **Step 6: Generate Pages assets and run tests**

Run:

```powershell
npm run build:pages
node --test test/pages-sync.test.js
npm.cmd test
git diff --check
```

Expected: all commands PASS; `public/index.html` and `docs/index.html` are byte-identical; neither contains a concrete Quick Tunnel URL.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- package.json public/index.html public/status-connection.js docs/index.html docs/status-connection.js scripts/sync-pages.js test/pages-sync.test.js
git commit -m "feat: persist status and discover live endpoint"
```

---

### Task 4: Publish Runtime Endpoint Data Without Touching `master`

**Files:**
- Create: `scripts/endpoint-registry.js`
- Create: `test/endpoint-registry.test.js`

**Interfaces:**
- Consumes: a verified `https://*.trycloudflare.com` URL, GitHub token from `gh auth token`, injected `fetch`, and injected clock.
- Produces: `validateApiBase(value): string`, `buildRegistry(apiBase, now): object`, `publishEndpoint(options): Promise<{ changed, apiBase }>`, and CLI `publish https://name.trycloudflare.com`.

- [ ] **Step 1: Write failing publisher tests with a deterministic GitHub mock**

Create `test/endpoint-registry.test.js` with a response helper:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRegistry,
  publishEndpoint,
  validateApiBase,
} = require("../scripts/endpoint-registry");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("validates only HTTPS Quick Tunnel API bases", () => {
  assert.equal(
    validateApiBase("https://valid-name.trycloudflare.com/"),
    "https://valid-name.trycloudflare.com"
  );
  assert.throws(() => validateApiBase("http://valid-name.trycloudflare.com"));
  assert.throws(() => validateApiBase("https://example.com"));
});

test("creates an orphan live-status branch when it is missing", async () => {
  const calls = [];
  const replies = [
    response(404, { message: "Not Found" }),
    response(201, { sha: "blob-sha" }),
    response(201, { sha: "tree-sha" }),
    response(201, { sha: "commit-sha" }),
    response(201, { ref: "refs/heads/live-status" }),
  ];
  const result = await publishEndpoint({
    apiBase: "https://first.trycloudflare.com",
    token: "test-token",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    apiBase: "https://first.trycloudflare.com",
  });
  assert.equal(calls.length, 5);
  assert.match(calls[4].options.body, /refs\/heads\/live-status/);
  assert.match(calls[2].options.body, /endpoint\.json/);
});

test("does not commit when the registered endpoint already matches", async () => {
  const registry = buildRegistry(
    "https://same.trycloudflare.com",
    new Date("2026-07-31T12:00:00.000Z")
  );
  const content = Buffer.from(JSON.stringify(registry, null, 2) + "\n").toString("base64");
  const calls = [];
  const result = await publishEndpoint({
    apiBase: "https://same.trycloudflare.com",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, { object: { sha: "head-sha" } });
      return response(200, { sha: "file-sha", content });
    },
  });

  assert.deepEqual(result, {
    changed: false,
    apiBase: "https://same.trycloudflare.com",
  });
  assert.equal(calls.length, 2);
});
```

Add this fourth test for an existing branch with a different endpoint:

```js
test("updates only endpoint.json when the registered endpoint changes", async () => {
  const oldRegistry = buildRegistry(
    "https://old.trycloudflare.com",
    new Date("2026-07-31T11:00:00.000Z")
  );
  const oldContent = Buffer.from(
    JSON.stringify(oldRegistry, null, 2) + "\n"
  ).toString("base64");
  const calls = [];
  const replies = [
    response(200, { object: { sha: "head-sha" } }),
    response(200, { sha: "file-sha", content: oldContent }),
    response(200, { content: { sha: "new-file-sha" } }),
  ];
  const result = await publishEndpoint({
    apiBase: "https://new.trycloudflare.com",
    token: "test-token",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    apiBase: "https://new.trycloudflare.com",
  });
  assert.equal(calls[2].options.method, "PUT");
  const requestBody = JSON.parse(calls[2].options.body);
  assert.equal(requestBody.branch, "live-status");
  assert.equal(requestBody.sha, "file-sha");
});
```

- [ ] **Step 2: Run the publisher test and verify it fails**

Run:

```powershell
node --test test/endpoint-registry.test.js
```

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement validation, GitHub requests, root-commit creation, and updates**

`scripts/endpoint-registry.js` must define these constants:

```js
const OWNER = "molanjie";
const REPO = "AI-Status-light";
const BRANCH = "live-status";
const FILE_PATH = "endpoint.json";
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
```

Use this registry format:

```js
function buildRegistry(apiBase, now = new Date()) {
  return {
    schemaVersion: 1,
    apiBase: validateApiBase(apiBase),
    publishedAt: now.toISOString(),
  };
}
```

Implement `request()` so a `404` can be returned to branch-creation logic while all other non-2xx responses throw an error containing the method, path, status, and GitHub message.

For a missing branch, make these exact REST calls:

```text
GET  /git/ref/heads/live-status
POST /git/blobs
POST /git/trees
POST /git/commits
POST /git/refs
```

The tree request contains one entry:

```json
{
  "path": "endpoint.json",
  "mode": "100644",
  "type": "blob",
  "sha": "blob-sha"
}
```

The commit request uses `parents: []`, creating a root commit that contains no `master` files. The ref request uses `ref: "refs/heads/live-status"`.

For an existing branch, read:

```text
GET /contents/endpoint.json?ref=live-status
```

Decode and validate the current JSON. Return without writing when `apiBase` matches. Otherwise update with:

```text
PUT /contents/endpoint.json
```

The body contains `message`, Base64 `content`, `branch: "live-status"`, and the current file `sha`.
Strip whitespace from GitHub's Base64 response before decoding. If the branch
exists but `endpoint.json` returns `404`, create the file with the same `PUT`
request and omit `sha`.

The CLI obtains the token without storing it:

```js
const token =
  process.env.GH_TOKEN ||
  execFileSync(resolveGhPath(), ["auth", "token"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
```

Export all test interfaces and execute the CLI only when `require.main === module`.

- [ ] **Step 4: Run focused and full tests**

Run:

```powershell
node --test test/endpoint-registry.test.js
npm.cmd test
```

Expected: all tests PASS and no network request occurs in tests.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- scripts/endpoint-registry.js test/endpoint-registry.test.js
git commit -m "feat: publish tunnel endpoint on isolated branch"
```

---

### Task 5: Supervise Only Owned Node and Tunnel Processes

**Files:**
- Create: `scripts/CodexStatusWatchdog.psm1`
- Create: `scripts/codex-status-watchdog.ps1`
- Create: `test/watchdog.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: project root, local health URL, cloudflared executable, Node executable, and Task 4 publisher CLI.
- Produces: `Get-TunnelUrlFromText`, `Test-ExpectedCommandLine`, `Get-OwnedProcessFromPidFile`, `Test-HttpEndpoint`, and a single-instance watchdog with `-CheckConfiguration`, `-RunOnce`, and continuous modes.

- [ ] **Step 1: Write failing PowerShell boundary tests**

Create `test/watchdog.test.js`:

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const modulePath = path.join(root, "scripts", "CodexStatusWatchdog.psm1");
const watchdogPath = path.join(root, "scripts", "codex-status-watchdog.ps1");

function powershell(script) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("extracts the newest valid Quick Tunnel URL", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `Get-TunnelUrlFromText 'old https://old.trycloudflare.com new https://new.trycloudflare.com'`
  );
  assert.equal(output, "https://new.trycloudflare.com");
});

test("command-line ownership requires every expected fragment", () => {
  const escaped = modulePath.replace(/'/g, "''");
  const output = powershell(
    `Import-Module '${escaped}' -Force; ` +
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\app\\server.js' @('node.exe','C:\\app\\server.js')); ` +
      `[string](Test-ExpectedCommandLine '"node.exe" C:\\other\\server.js' @('node.exe','C:\\app\\server.js'))`
  ).split(/\r?\n/);
  assert.deepEqual(output, ["True", "False"]);
});

test("configuration check returns dependency paths without starting processes", () => {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      watchdogPath,
      "-CheckConfiguration",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = JSON.parse(result.stdout);
  assert.equal(config.projectRoot, root);
  assert.match(config.nodePath.toLowerCase(), /node\.exe$/);
  assert.match(config.cloudflaredPath.toLowerCase(), /cloudflared\.exe$/);
  assert.match(config.publisherPath, /endpoint-registry\.js$/);
  assert.equal(config.localHealthUrl, "http://127.0.0.1:3456/api/health");
});
```

- [ ] **Step 2: Run the watchdog test and verify it fails**

Run:

```powershell
node --test test/watchdog.test.js
```

Expected: FAIL because the module and script do not exist.

- [ ] **Step 3: Implement focused functions in `CodexStatusWatchdog.psm1`**

Export these functions:

```powershell
Export-ModuleMember -Function @(
  'Get-TunnelUrlFromText',
  'Test-ExpectedCommandLine',
  'Get-OwnedProcessFromPidFile',
  'Test-HttpEndpoint',
  'Resolve-WatchdogConfiguration'
)
```

`Get-TunnelUrlFromText` must collect all matches of:

```regex
https://[a-z0-9-]+\.trycloudflare\.com
```

and return the last match.

`Test-ExpectedCommandLine` returns `$true` only when the command line contains every non-empty expected fragment using ordinal case-insensitive comparison.

`Get-OwnedProcessFromPidFile` must:

1. Return `$null` when the PID file is absent or invalid.
2. Read exactly one integer PID.
3. Query only that PID through `Win32_Process`.
4. Return `$null` unless `Test-ExpectedCommandLine` accepts the process command line.
5. Never enumerate and stop processes by executable name.

`Resolve-WatchdogConfiguration` must resolve:

- `node.exe` through `Get-Command`.
- `cloudflared.exe` from `tools\cloudflared.exe`, `C:\Users\Administrator\Documents\Codex\tools\cloudflared.exe`, or `Get-Command`.
- `gh.exe` through `Get-Command`.
- `scripts\endpoint-registry.js`.
- the absolute repository `server.js` path.
- state directory `%LOCALAPPDATA%\CodexStatusLight`.

It throws one actionable error listing any missing dependency.

- [ ] **Step 4: Implement the single-instance watchdog loop**

`scripts/codex-status-watchdog.ps1` starts with:

```powershell
[CmdletBinding()]
param(
  [switch]$CheckConfiguration,
  [switch]$RunOnce,
  [int]$IntervalSeconds = 10
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$modulePath = Join-Path $projectRoot 'scripts\CodexStatusWatchdog.psm1'
Import-Module $modulePath -Force
$config = Resolve-WatchdogConfiguration -ProjectRoot $projectRoot
```

`-CheckConfiguration` serializes the resolved public paths and URLs as JSON, then exits before creating a mutex or process.

Continuous and `-RunOnce` modes acquire:

```powershell
New-Object System.Threading.Mutex($false, 'Local\CodexStatusLightWatchdog')
```

with a zero-timeout `WaitOne`. A second instance exits successfully after logging `watchdog already running`.

Use state files:

```text
%LOCALAPPDATA%\CodexStatusLight\server.pid
%LOCALAPPDATA%\CodexStatusLight\tunnel.pid
%LOCALAPPDATA%\CodexStatusLight\server.out.log
%LOCALAPPDATA%\CodexStatusLight\server.err.log
%LOCALAPPDATA%\CodexStatusLight\tunnel.out.log
%LOCALAPPDATA%\CodexStatusLight\tunnel.err.log
%LOCALAPPDATA%\CodexStatusLight\watchdog.log
```

Before starting a replacement tunnel, remove only the exact owned
`tunnel.out.log` and `tunnel.err.log` files so a stale URL cannot be parsed as
the new process URL. Do not remove any repository log.

Each loop performs this state machine:

1. Check `http://127.0.0.1:3456/api/health` with a 3-second timeout.
2. If unhealthy, validate the stored server PID and stop only that owned process, then start `node.exe` with the absolute repository `server.js`, `-WorkingDirectory $config.projectRoot`, and hidden window; write its PID.
3. When local health is good, validate the tunnel PID and start `cloudflared tunnel --url http://127.0.0.1:3456 --no-autoupdate` when absent.
4. Parse both tunnel logs for the newest URL.
5. Check `<tunnel-url>/api/status` with a 5-second timeout.
6. Reset the public failure counter on success and invoke:

```powershell
& $config.nodePath $config.publisherPath publish $tunnelUrl
```

only when the URL differs from the last successfully published URL.
7. After three consecutive public failures, stop only the owned tunnel process, clear its PID file, and allow the next loop to create a new tunnel.
8. Sleep for `IntervalSeconds`, capped to at least 5 seconds.

`-RunOnce` executes one loop and exits. The mutex is always released in `finally`.

- [ ] **Step 5: Ignore legacy runtime logs and run tests**

Append to `.gitignore`:

```gitignore
codex-status-server.*.log
```

Run:

```powershell
node --test test/watchdog.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/codex-status-watchdog.ps1 -CheckConfiguration
npm.cmd test
```

Expected: all tests PASS; configuration JSON resolves the installed Node, GitHub CLI, and cloudflared; no service or tunnel process is started by the check.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- .gitignore scripts/CodexStatusWatchdog.psm1 scripts/codex-status-watchdog.ps1 test/watchdog.test.js
git commit -m "feat: add owned-process status watchdog"
```

---

### Task 6: Install an Idempotent Current-User Scheduled Task

**Files:**
- Create: `scripts/install-codex-status-watchdog.ps1`
- Modify: `test/watchdog.test.js`

**Interfaces:**
- Consumes: Task 5 watchdog and current Windows identity.
- Produces: `CodexStatusLightWatchdog` scheduled task plus `-Describe`, `-StartNow`, and `-Uninstall` modes.

- [ ] **Step 1: Add the failing installer descriptor test**

Append to `test/watchdog.test.js`:

```js
test("installer describes the exact current-user task without mutating Task Scheduler", () => {
  const installerPath = path.join(
    root,
    "scripts",
    "install-codex-status-watchdog.ps1"
  );
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installerPath,
      "-Describe",
    ],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const descriptor = JSON.parse(result.stdout);
  assert.equal(descriptor.taskName, "CodexStatusLightWatchdog");
  assert.equal(descriptor.trigger, "AtLogOn");
  assert.equal(descriptor.restartIntervalMinutes, 1);
  assert.equal(descriptor.restartCount, 999);
  assert.match(descriptor.arguments, /codex-status-watchdog\.ps1/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
node --test test/watchdog.test.js
```

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement describe, install, start, and uninstall modes**

Start `scripts/install-codex-status-watchdog.ps1` with:

```powershell
[CmdletBinding()]
param(
  [switch]$Describe,
  [switch]$StartNow,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'CodexStatusLightWatchdog'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watchdogPath = Join-Path $projectRoot 'scripts\codex-status-watchdog.ps1'
$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogPath`""
```

`-Describe` returns this JSON shape without calling Task Scheduler:

```json
{
  "taskName": "CodexStatusLightWatchdog",
  "trigger": "AtLogOn",
  "restartIntervalMinutes": 1,
  "restartCount": 999,
  "arguments": "-NoProfile -ExecutionPolicy Bypass -File \"...codex-status-watchdog.ps1\""
}
```

Normal install first invokes the watchdog with `-CheckConfiguration`. It then creates:

```powershell
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 999 `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
```

Register with `-Force` so a repeated install updates the same task. `-StartNow` calls `Start-ScheduledTask` after registration. `-Uninstall` removes only the exact task name after confirming it exists.

- [ ] **Step 4: Test descriptor and install idempotence**

Run:

```powershell
node --test test/watchdog.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-codex-status-watchdog.ps1 -Describe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-codex-status-watchdog.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-codex-status-watchdog.ps1
Get-ScheduledTask -TaskName CodexStatusLightWatchdog
npm.cmd test
```

Expected: one task exists, its state is `Ready`, repeated installation creates no duplicate, and all tests PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- scripts/install-codex-status-watchdog.ps1 test/watchdog.test.js
git commit -m "feat: install status watchdog at user logon"
```

---

### Task 7: Deploy and Prove Self-Recovery End to End

**Files:**
- Verify all files from Tasks 1-6.
- Create: `scripts/verify-live-page.js`
- Runtime-only writes: `%LOCALAPPDATA%\CodexStatusLight`.
- Remote runtime branch: `live-status`.
- Published source: `master/docs`.

**Interfaces:**
- Consumes: all implementation tasks, current `gh` authentication, installed cloudflared, and GitHub Pages.
- Produces: a live fixed page, initialized endpoint registry, running scheduled task, Playwright verification output, and evidence for every acceptance criterion.

- [ ] **Step 1: Add the executable live-page verifier**

Create `scripts/verify-live-page.js`:

```js
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const pageUrl =
  process.argv[2] || "https://molanjie.github.io/AI-Status-light/";

async function waitForText(page, selector, pattern, timeout = 90000) {
  await page.waitForFunction(
    ({ selector, source, flags }) => {
      const value = document.querySelector(selector)?.textContent || "";
      return new RegExp(source, flags).test(value);
    },
    { selector, source: pattern.source, flags: pattern.flags },
    { timeout }
  );
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await waitForText(page, "#status-time", /已同步/);
    const previousSessionCount = await page.locator("#session-count").textContent();

    await page.route("**/*", async (route) => {
      const hostname = new URL(route.request().url()).hostname;
      if (hostname.endsWith(".trycloudflare.com")) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForText(page, "#status-label", /采集端离线/, 30000);
    await waitForText(page, "#status-time", /上次同步/, 30000);
    assert.equal(
      await page.locator("#session-count").textContent(),
      previousSessionCount
    );

    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      assert.ok(
        dimensions.scrollWidth <= dimensions.innerWidth,
        `horizontal overflow at ${width}px`
      );
    }

    await page.unroute("**/*");
    await waitForText(page, "#status-time", /已同步/);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /采集端离线/
    );

    process.stdout.write(
      JSON.stringify({
        pageUrl,
        offlineSnapshotPreserved: true,
        recoveredWithoutReload: true,
        widths: [320, 390, 1280],
      }) + "\n"
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Run:

```powershell
node --check scripts/verify-live-page.js
```

Expected: syntax check PASS.

- [ ] **Step 2: Commit the live verifier**

```powershell
git add -- scripts/verify-live-page.js
git commit -m "test: add live status recovery smoke check"
```

- [ ] **Step 3: Run the complete pre-deployment gate**

```powershell
npm run build:pages
npm.cmd test
git diff --check
git status --short
```

Expected:

- All tests PASS.
- `public/index.html` equals `docs/index.html`.
- `public/status-connection.js` equals `docs/status-connection.js`.
- No concrete `trycloudflare.com` URL exists in either HTML file.
- Only intended implementation files are staged or committed.
- Existing runtime logs remain ignored and uncommitted.

- [ ] **Step 4: Confirm repository and authentication targets**

```powershell
git remote get-url origin
gh auth status
gh repo view molanjie/AI-Status-light --json nameWithOwner,defaultBranchRef
```

Expected:

- Origin is `https://github.com/molanjie/AI-Status-light.git`.
- GitHub CLI is authenticated as the account with push permission.
- Default branch is `master`.

- [ ] **Step 5: Push the reviewed implementation to GitHub Pages source**

```powershell
git push origin HEAD:master
```

Expected: push succeeds without force and remote `master` points at the final implementation commit.

- [ ] **Step 6: Install and start the watchdog**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-codex-status-watchdog.ps1 -StartNow
Get-ScheduledTask -TaskName CodexStatusLightWatchdog
```

Expected: task is `Running` or `Ready`, and exactly one watchdog mutex owner exists.

- [ ] **Step 7: Verify local service, registry branch, and public API**

Within 90 seconds, run:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3456/api/health -TimeoutSec 5
gh api "repos/molanjie/AI-Status-light/contents/endpoint.json?ref=live-status" --jq .content
```

Decode and validate the registry with:

```powershell
$encoded = gh api "repos/molanjie/AI-Status-light/contents/endpoint.json?ref=live-status" --jq .content
$registryJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($encoded -replace '\s', '')))
$registry = $registryJson | ConvertFrom-Json
if ($registry.schemaVersion -ne 1) { throw 'Unexpected registry schema' }
if ($registry.apiBase -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') { throw 'Invalid registry API base' }
[void][DateTimeOffset]::Parse($registry.publishedAt)
$publicStatus = Invoke-RestMethod -Uri ($registry.apiBase + '/api/status') -TimeoutSec 10
if (-not $publicStatus.state) { throw 'Public status payload has no state' }
```

Expected: every assertion passes and `$publicStatus.state` contains a current Codex state.

- [ ] **Step 8: Prove Node self-recovery**

Run this exact owned-process fault injection:

```powershell
$stateDirectory = Join-Path $env:LOCALAPPDATA 'CodexStatusLight'
$serverPidPath = Join-Path $stateDirectory 'server.pid'
$oldServerPid = [int](Get-Content -LiteralPath $serverPidPath -Raw)
$oldServer = Get-CimInstance Win32_Process -Filter "ProcessId=$oldServerPid"
$expectedServerPath = Join-Path (Get-Location) 'server.js'
if (-not $oldServer -or $oldServer.CommandLine -notlike "*$expectedServerPath*") {
  throw 'Refusing to stop an unowned Node process'
}
Stop-Process -Id $oldServerPid
$serverDeadline = (Get-Date).AddSeconds(90)
do {
  Start-Sleep -Seconds 2
  $localHealthy = $false
  try {
    $health = Invoke-RestMethod -Uri http://127.0.0.1:3456/api/health -TimeoutSec 3
    $localHealthy = $health.ok -eq $true
  } catch {}
  $newServerPid = if (Test-Path -LiteralPath $serverPidPath) {
    [int](Get-Content -LiteralPath $serverPidPath -Raw)
  } else {
    0
  }
} until (($localHealthy -and $newServerPid -ne $oldServerPid) -or (Get-Date) -ge $serverDeadline)
if (-not $localHealthy -or $newServerPid -eq $oldServerPid) {
  throw 'Node service did not recover within 90 seconds'
}
```

Expected: recovery completes within 90 seconds and no unrelated Node process changes.

- [ ] **Step 9: Prove tunnel rotation and automatic endpoint discovery**

Run:

```powershell
$stateDirectory = Join-Path $env:LOCALAPPDATA 'CodexStatusLight'
$currentEncoded = gh api "repos/molanjie/AI-Status-light/contents/endpoint.json?ref=live-status" --jq .content
$currentJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($currentEncoded -replace '\s', '')))
$currentRegistry = $currentJson | ConvertFrom-Json
$oldApiBase = $currentRegistry.apiBase
$tunnelPidPath = Join-Path $stateDirectory 'tunnel.pid'
$oldTunnelPid = [int](Get-Content -LiteralPath $tunnelPidPath -Raw)
$oldTunnel = Get-CimInstance Win32_Process -Filter "ProcessId=$oldTunnelPid"
if (
  -not $oldTunnel -or
  $oldTunnel.CommandLine -notmatch 'cloudflared' -or
  $oldTunnel.CommandLine -notlike '*http://127.0.0.1:3456*'
) {
  throw 'Refusing to stop an unowned tunnel process'
}
Stop-Process -Id $oldTunnelPid
$tunnelDeadline = (Get-Date).AddSeconds(90)
$newRegistry = $null
do {
  Start-Sleep -Seconds 3
  try {
    $newEncoded = gh api "repos/molanjie/AI-Status-light/contents/endpoint.json?ref=live-status" --jq .content
    $newJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($newEncoded -replace '\s', '')))
    $candidateRegistry = $newJson | ConvertFrom-Json
    if ($candidateRegistry.apiBase -ne $oldApiBase) {
      $candidateStatus = Invoke-RestMethod -Uri ($candidateRegistry.apiBase + '/api/status') -TimeoutSec 10
      if ($candidateStatus.state) { $newRegistry = $candidateRegistry }
    }
  } catch {}
} until ($newRegistry -or (Get-Date) -ge $tunnelDeadline)
if (-not $newRegistry) { throw 'Tunnel did not rotate within 90 seconds' }
```

Expected: both conditions pass within 90 seconds without a `master` commit or local worktree change.

- [ ] **Step 10: Verify offline persistence and responsive layout**

Run:

```powershell
node scripts/verify-live-page.js https://molanjie.github.io/AI-Status-light/
```

Expected: exit code `0` and JSON reports `offlineSnapshotPreserved: true`, `recoveredWithoutReload: true`, and all three widths.

- [ ] **Step 11: Verify Pages build and remote invariants**

```powershell
gh api repos/molanjie/AI-Status-light/pages
gh api repos/molanjie/AI-Status-light/pages/builds/latest
git fetch origin master
git status --short --branch
```

Expected:

- Pages status is `built`.
- The latest build source is `master/docs`.
- The fixed URL returns `200`.
- `origin/master` contains the implementation.
- The local worktree has no implementation changes.
- `live-status` updates did not add commits to `master`.

- [ ] **Step 12: Record final evidence and complete the goal**

Report:

- Final `master` commit SHA.
- Pages build status and fixed URL.
- Local and public health results.
- Scheduled task name and state.
- Measured Node recovery time.
- Measured tunnel rotation time.
- Current `live-status` endpoint publication time.
- Test totals.
- Responsive/offline smoke-test results.

Only after every item above is proven, mark the persistent goal complete.
