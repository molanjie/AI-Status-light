const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const pageHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const connectionScript = fs.readFileSync(
  path.join(root, "public", "status-connection.js"),
  "utf8"
);

const APP_ORIGIN = "http://status.test";
const STATUS_API_BASE = "https://collector.test";
const REGISTRY_URL =
  "https://raw.githubusercontent.com/molanjie/AI-Status-light/live-status/endpoint.json";
const SNAPSHOT_KEY = "codex_status_last_good_v1";
const FIXED_NOW = 1785432000000;

let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser.close();
});

function jsonResponse(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function openStatusPage(options = {}) {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors = [];
  const requestCounts = { registry: 0, status: 0, statusUrls: [] };

  await context.addInitScript(
    ({ appOrigin, fixedNow, registryUrl, snapshotKey, snapshot, stallFirstRegistryFetch }) => {
      if (window.location.origin !== appOrigin) return;
      window.__testNow = fixedNow;
      Date.now = () => window.__testNow;
      window.__testIntervals = [];
      window.setInterval = (callback, delay, ...args) => {
        window.__testIntervals.push({ callback, delay, args });
        return window.__testIntervals.length;
      };
      window.clearInterval = () => {};
      window.localStorage.clear();
      if (snapshot) {
        window.localStorage.setItem(snapshotKey, JSON.stringify(snapshot));
      }
      if (stallFirstRegistryFetch) {
        const originalFetch = window.fetch.bind(window);
        let shouldStall = true;
        window.__registryAbortCount = 0;
        window.fetch = (input, init = {}) => {
          if (shouldStall && String(input).startsWith(registryUrl)) {
            shouldStall = false;
            return new Promise((resolve, reject) => {
              const rejectOnAbort = () => {
                window.__registryAbortCount += 1;
                reject(new DOMException("Registry request aborted", "AbortError"));
              };
              if (init.signal && init.signal.aborted) {
                rejectOnAbort();
              } else if (init.signal) {
                init.signal.addEventListener("abort", rejectOnAbort, { once: true });
              }
            });
          }
          return originalFetch(input, init);
        };
      }
    },
    {
      appOrigin: APP_ORIGIN,
      fixedNow: options.now || FIXED_NOW,
      registryUrl: REGISTRY_URL,
      snapshotKey: SNAPSHOT_KEY,
      snapshot: options.snapshot || null,
      stallFirstRegistryFetch: options.stallFirstRegistryFetch || false,
    }
  );

  page.on("pageerror", (error) => pageErrors.push(error));
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());

    if (requestUrl.origin === APP_ORIGIN && requestUrl.pathname === "/index.html") {
      await route.fulfill({ contentType: "text/html", body: pageHtml });
      return;
    }
    if (
      requestUrl.origin === APP_ORIGIN &&
      requestUrl.pathname === "/status-connection.js"
    ) {
      await route.fulfill({
        contentType: "application/javascript",
        body: connectionScript,
      });
      return;
    }
    if (route.request().url().startsWith(REGISTRY_URL)) {
      requestCounts.registry += 1;
      if (options.onRegistryRequest) {
        await options.onRegistryRequest(route, requestCounts.registry);
      } else {
        await jsonResponse(route, 503, { error: "registry unavailable" });
      }
      return;
    }
    if (requestUrl.pathname === "/api/status") {
      requestCounts.status += 1;
      requestCounts.statusUrls.push(route.request().url());
      if (options.onStatusRequest) {
        await options.onStatusRequest(route, requestCounts.status);
      } else {
        await jsonResponse(route, 503, { error: "collector unavailable" });
      }
      return;
    }

    await route.abort();
  });

  const explicitBase = Object.hasOwn(options, "explicitBase")
    ? options.explicitBase
    : STATUS_API_BASE;
  const pageUrl = explicitBase
    ? `${APP_ORIGIN}/index.html?api=${encodeURIComponent(explicitBase)}`
    : `${APP_ORIGIN}/index.html`;
  await page.goto(pageUrl, { waitUntil: "load" });

  return {
    context,
    page,
    pageErrors,
    requestCounts,
    async close() {
      await context.close();
    },
  };
}

function validStatus(overrides = {}) {
  return {
    state: "processing",
    light: "red",
    label: "正在处理",
    sessionCount: 1,
    sessions: [{ state: "processing", title: "Runtime test" }],
    totalThreads: 4,
    hostname: "test-host",
    lastCompletedAt: null,
    tokenStats: {
      tokens24h: 1200,
      totalTokens: 4800,
      byModel: [],
    },
    plan: null,
    updatedAt: FIXED_NOW - 60000,
    ...overrides,
  };
}

test("refreshes session data without restarting an unchanged carousel", async t => {
  const runtime = await openStatusPage();
  t.after(() => runtime.close());
  const result = await runtime.page.evaluate(() => {
    updateSessions([{ title: "Same title", state: "processing", updatedAt: 1 }]);
    updateSessions([{ title: "Same title", state: "processing", updatedAt: 2 }]);
    return currentSessions[0].updatedAt;
  });
  assert.equal(result, 2);
});

test("renders account text literally and clears usage fields when new data is absent", async t => {
  const runtime = await openStatusPage();
  t.after(() => runtime.close());
  await runtime.page.evaluate(status => renderUsage(status), validStatus({
    plan: { plan: "plus", name: '<img src="x" onerror="window.injected=true">', activeUntil: "2026-08-12T03:30:45Z" },
  }));
  assert.equal(await runtime.page.locator("#plan-sub-info img").count(), 0);
  assert.match(await runtime.page.locator("#plan-sub-info").textContent(), /<img/);
  await runtime.page.evaluate(() => renderUsage({ tokenStats: null, plan: { plan: "plus" } }));
  assert.equal(await runtime.page.locator("#token-24h").textContent(), "—");
  assert.equal(await runtime.page.locator("#model-bars").textContent(), "");
  await runtime.page.evaluate(() => renderUsage({ plan: null, tokenStats: { totalTokens: 10, tokens24h: 2, byModel: [] } }));
  assert.equal(await runtime.page.locator("#plan-badge").textContent(), "");
});

test("cached snapshot restoration cannot abort registry refresh or status polling", async (t) => {
  const cached = validStatus({
    state: "idle",
    light: "green",
    label: "缓存空闲",
    sessionCount: 0,
    sessions: [],
  });
  const runtime = await openStatusPage({
    snapshot: { data: cached, savedAt: FIXED_NOW - 30000 },
  });
  t.after(() => runtime.close());

  await waitFor(
    () => runtime.pageErrors.length > 0 || runtime.requestCounts.status > 0,
    "page neither polled status nor reported the cached-restore error"
  );

  assert.deepEqual(
    runtime.pageErrors.map((error) => error.message),
    []
  );
  assert.equal(runtime.requestCounts.registry, 1);
  assert.equal(runtime.requestCounts.status, 1);
  assert.equal(await runtime.page.locator("#status-label").textContent(), "缓存空闲");
});

test("only the third complete polling failure renders a yellow disconnected capsule", async (t) => {
  let collectorAvailable = true;
  const status = validStatus();
  const runtime = await openStatusPage({
    onStatusRequest(route) {
      if (collectorAvailable) return jsonResponse(route, 200, status);
      return jsonResponse(route, 503, { error: "collector unavailable" });
    },
  });
  t.after(() => runtime.close());

  await runtime.page.waitForFunction(() => {
    return document.getElementById("status-label").textContent === "正在处理";
  });
  await runtime.page.evaluate(() => tcRender());
  collectorAvailable = false;
  await runtime.page.evaluate((now) => {
    window.__testNow = now;
  }, FIXED_NOW + 60000);

  await runtime.page.evaluate(() => fetchStatus());
  await runtime.page.evaluate(() => fetchStatus());
  await runtime.page.evaluate(() => tcRender());
  assert.equal(await runtime.page.locator("#status-label").textContent(), "正在处理");
  assert.doesNotMatch(
    await runtime.page.locator("#traffic-capsule").getAttribute("class"),
    /tc-disconnected/
  );

  await runtime.page.evaluate(() => fetchStatus());
  await runtime.page.evaluate(() => tcRender());

  assert.equal(await runtime.page.locator("#status-label").textContent(), "采集端离线");
  assert.match(
    await runtime.page.locator("#traffic-capsule").getAttribute("class"),
    /tc-disconnected/
  );
  assert.equal(await runtime.page.locator("#tc-label").textContent(), "采集端离线");
  assert.equal(
    await runtime.page.locator("#tc-dot").evaluate((node) => {
      return getComputedStyle(node).backgroundColor;
    }),
    "rgb(255, 214, 10)"
  );
});

test("disconnected rendering preserves the last valid data timestamp", async (t) => {
  let collectorAvailable = true;
  const runtime = await openStatusPage({
    onStatusRequest(route) {
      if (collectorAvailable) return jsonResponse(route, 200, validStatus());
      return jsonResponse(route, 503, { error: "collector unavailable" });
    },
  });
  t.after(() => runtime.close());

  await runtime.page.waitForFunction(() => {
    return document.getElementById("status-label").textContent === "正在处理";
  });
  const tokenTimestamp = await runtime.page.locator("#token-total").textContent();

  collectorAvailable = false;
  await runtime.page.evaluate((now) => {
    window.__testNow = now;
  }, FIXED_NOW + 60000);
  await runtime.page.evaluate(() => fetchStatus());
  await runtime.page.evaluate(() => fetchStatus());
  await runtime.page.evaluate(() => fetchStatus());

  assert.equal(await runtime.page.locator("#token-total").textContent(), tokenTimestamp);
});

test("status polling does not overlap while a complete polling round is pending", async (t) => {
  const releaseStatus = deferred();
  const runtime = await openStatusPage({
    async onStatusRequest(route) {
      await releaseStatus.promise;
      await jsonResponse(route, 503, { error: "collector unavailable" });
    },
  });
  t.after(async () => {
    releaseStatus.resolve();
    await runtime.close();
  });

  await waitFor(
    () => runtime.requestCounts.status === 1,
    "initial status request did not start"
  );
  await runtime.page.evaluate(() => {
    return Promise.all([fetchStatus(), fetchStatus(), fetchStatus()]);
  });

  assert.equal(runtime.requestCounts.status, 1);
  releaseStatus.resolve();
  await runtime.page.waitForFunction(() => statusRequestInFlight === false);
});

test("registry refreshes are serialized so stale responses cannot arrive out of order", async (t) => {
  const releaseFirstRegistry = deferred();
  const oldBase = "https://old-endpoint.trycloudflare.com";
  const newBase = "https://new-endpoint.trycloudflare.com";
  const runtime = await openStatusPage({
    async onRegistryRequest(route, count) {
      if (count === 1) {
        await releaseFirstRegistry.promise;
        await jsonResponse(route, 200, {
          schemaVersion: 1,
          apiBase: oldBase,
          publishedAt: "2026-07-31T12:00:00.000Z",
        });
        return;
      }
      await jsonResponse(route, 200, {
        schemaVersion: 1,
        apiBase: newBase,
        publishedAt: "2026-07-31T12:01:00.000Z",
      });
    },
  });
  t.after(async () => {
    releaseFirstRegistry.resolve();
    await runtime.close();
  });

  await waitFor(
    () => runtime.requestCounts.registry === 1,
    "initial registry refresh did not start"
  );
  await runtime.page.evaluate(() => refreshEndpointRegistry());
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(runtime.requestCounts.registry, 1);

  releaseFirstRegistry.resolve();
  await runtime.page.waitForFunction((expected) => registryApiBase === expected, oldBase);
  await runtime.page.evaluate(() => refreshEndpointRegistry());

  assert.equal(runtime.requestCounts.registry, 2);
  assert.equal(
    await runtime.page.evaluate(() => registryApiBase),
    newBase
  );
});

test("a stalled registry request aborts and a later 30-second refresh discovers the endpoint", async (t) => {
  const newBase = "https://recovered-endpoint.trycloudflare.com";
  const runtime = await openStatusPage({
    explicitBase: "",
    stallFirstRegistryFetch: true,
    onRegistryRequest(route) {
      return jsonResponse(route, 200, {
        schemaVersion: 1,
        apiBase: newBase,
        publishedAt: "2026-07-31T12:01:00.000Z",
      });
    },
    onStatusRequest(route) {
      return jsonResponse(route, 200, validStatus());
    },
  });
  t.after(() => runtime.close());

  await runtime.page.waitForFunction(
    () => window.__registryAbortCount === 1 && registryRequestInFlight === false,
    null,
    { timeout: 5000 }
  );

  await runtime.page.evaluate(() => {
    const registryInterval = window.__testIntervals.find(
      (entry) => entry.delay === REGISTRY_REFRESH_MS
    );
    if (!registryInterval) throw new Error("registry interval was not registered");
    return registryInterval.callback(...registryInterval.args);
  });

  await runtime.page.waitForFunction(
    (expected) => registryApiBase === expected,
    newBase,
    { timeout: 5000 }
  );
  await waitFor(
    () => runtime.requestCounts.status === 1,
    "recovered registry did not trigger status polling",
    5000
  );
  await runtime.page.waitForFunction(() => statusRequestInFlight === false);
  assert.deepEqual(
    runtime.pageErrors.map((error) => error.message),
    []
  );
  assert.equal(await runtime.page.locator("#status-label").textContent(), "正在处理");

  assert.equal(runtime.requestCounts.registry, 1);
  assert.equal(runtime.requestCounts.status, 1);
  assert.equal(new URL(runtime.requestCounts.statusUrls[0]).origin, newBase);
  assert.equal(await runtime.page.evaluate(() => registryRequestInFlight), false);
});

test("task results render literal titles, durations, and survive disconnection", async t => {
  let available = true;
  const status = validStatus({ history: [
    { title: '<img src="x">', state: "completed", startedAt: FIXED_NOW - 20000, finishedAt: FIXED_NOW - 10000, durationMs: 10000 },
    { title: "Cancelled task", state: "cancelled", finishedAt: FIXED_NOW - 30000, durationMs: null },
    { title: "Failed task", state: "error", finishedAt: FIXED_NOW - 40000, durationMs: 1200 },
  ] });
  const runtime = await openStatusPage({ onStatusRequest(route) {
    return jsonResponse(route, available ? 200 : 503, available ? status : {});
  } });
  t.after(() => runtime.close());
  await runtime.page.waitForFunction(() => lastGoodStatus !== null);
  assert.equal(await runtime.page.locator("#task-history .history-item").count(), 3);
  assert.equal(await runtime.page.locator("#task-history img").count(), 0);
  assert.match(await runtime.page.locator("#task-history").textContent(), /<img src="x">.*已完成.*10秒/s);
  available = false;
  for (let i = 0; i < 3; i++) await runtime.page.evaluate(() => fetchStatus());
  assert.equal(await runtime.page.locator("#task-history .history-item").count(), 3);
  assert.match(await runtime.page.locator("#connection-detail").textContent(), /HTTP 503/);
});

test("invalid successful JSON cannot poison the snapshot or visible data", async t => {
  let invalid = false;
  const runtime = await openStatusPage({ onStatusRequest(route) {
    return jsonResponse(route, 200, invalid ? { state: "processing", sessions: "invalid" } : validStatus());
  } });
  t.after(() => runtime.close());
  await runtime.page.waitForFunction(() => lastGoodStatus !== null);
  invalid = true;
  for (let i = 0; i < 3; i++) await runtime.page.evaluate(() => fetchStatus());
  assert.equal(await runtime.page.evaluate(() => lastGoodStatus.sessionCount), 1);
  assert.match(await runtime.page.locator("#connection-detail").textContent(), /数据格式/);
  assert.deepEqual(runtime.pageErrors.map(e => e.message), []);
});

test("a stalled response body times out and a later poll can recover", async t => {
  const runtime = await openStatusPage({ onStatusRequest(route) {
    return jsonResponse(route, 200, validStatus());
  } });
  t.after(() => runtime.close());
  await runtime.page.waitForFunction(() => lastGoodStatus !== null);
  await runtime.page.evaluate(() => {
    window.__originalFetch = window.fetch;
    window.fetch = (url, init) => Promise.resolve({ ok: true, json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    }) });
    window.__bodyRequest = fetchStatus();
  });
  await runtime.page.waitForFunction(() => statusRequestInFlight === false, null, { timeout: 4500 });
  await runtime.page.evaluate(async () => { window.fetch = window.__originalFetch; await fetchStatus(); });
  assert.equal(await runtime.page.locator("#status-label").textContent(), "正在处理");
});

test("manual reconnect recovers without clearing cached sessions or history", async t => {
  let available = false;
  const status = validStatus({ history: [{ title: "Previous", state: "completed", finishedAt: FIXED_NOW - 10000, durationMs: 3000 }] });
  const runtime = await openStatusPage({ snapshot: { data: status, savedAt: FIXED_NOW - 60000 }, onStatusRequest(route) {
    return jsonResponse(route, available ? 200 : 503, available ? status : {});
  } });
  t.after(() => runtime.close());
  await runtime.page.waitForFunction(() => statusRequestInFlight === false);
  for (let i = 0; i < 2; i++) await runtime.page.evaluate(() => fetchStatus());
  available = true;
  await runtime.page.locator("#reconnect-button").click();
  await runtime.page.waitForFunction(() => document.getElementById("connection-label").textContent === "已连接");
  assert.equal(await runtime.page.locator("#task-history .history-item").count(), 1);
  assert.equal(await runtime.page.evaluate(() => failureTracker.count()), 0);
});

test("diagnostics distinguish an offline Codex from a collector read failure", async t => {
  const runtime = await openStatusPage();
  t.after(() => runtime.close());
  await runtime.page.evaluate(status => {
    lastGoodStatus = status;
    updateConnectionDiagnostics(status, "http://127.0.0.1:3456", 15);
  }, validStatus({ state: "offline", light: "yellow", label: "Codex 未运行", sessions: [], sessionCount: 0, diagnostics: { code: "codex_offline" } }));
  assert.match(await runtime.page.locator("#connection-detail").textContent(), /服务已连接.*Codex 未运行/);
  await runtime.page.evaluate(status => updateConnectionDiagnostics(status, "https://collector.test", 12), validStatus({
    state: "error", diagnostics: { code: "database_unreadable" }, error: "数据库无法读取",
  }));
  assert.match(await runtime.page.locator("#connection-detail").textContent(), /状态数据库/);
});

test("history and diagnostics fit mobile and desktop without moving the top card", async t => {
  const status = validStatus({ history: [{ title: "Long task title ".repeat(40), state: "completed", finishedAt: FIXED_NOW - 10000, durationMs: 500000 }] });
  const runtime = await openStatusPage({ onStatusRequest: route => jsonResponse(route, 200, status) });
  t.after(() => runtime.close());
  await runtime.page.waitForFunction(() => lastGoodStatus !== null);
  for (const width of [320, 390, 1280]) {
    await runtime.page.setViewportSize({ width, height: 700 });
    const layout = await runtime.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      top: document.getElementById("island").getBoundingClientRect().top,
      floating: getComputedStyle(document.getElementById("traffic-capsule")).display,
    }));
    assert.deepEqual(layout, { overflow: false, top: 24, floating: "none" });
  }
});

test("manual reconnect queues behind an in-flight poll rather than ignoring the click", async t => {
  const gate = deferred();
  const runtime = await openStatusPage({ async onStatusRequest(route, count) {
    if (count === 1) await gate.promise;
    return jsonResponse(route, 200, validStatus());
  } });
  t.after(async () => { gate.resolve(); await runtime.close(); });
  await waitFor(() => runtime.requestCounts.status === 1, "initial poll not started");
  await runtime.page.locator("#reconnect-button").click();
  assert.equal(await runtime.page.locator("#reconnect-button").isDisabled(), true);
  gate.resolve();
  await runtime.page.waitForFunction(() => !reconnectInFlight && !statusRequestInFlight);
  assert.equal(runtime.requestCounts.status, 2);
});

test("completed tasks are not counted active and a waiting session cannot drive the running timer", async t => {
  const runtime = await openStatusPage();
  t.after(() => runtime.close());
  await runtime.page.evaluate(status => updateStats(status), validStatus({
    state: "completed", sessions: [{ title: "Done", state: "completed" }],
  }));
  assert.equal(await runtime.page.locator("#stat-active").textContent(), "0");
  await runtime.page.evaluate(status => updateStats(status), validStatus({
    sessions: [
      { title: "Waiting", state: "waiting", lastStartedAt: FIXED_NOW - 100000 },
      { title: "Working", state: "processing", lastStartedAt: FIXED_NOW - 20000 },
    ], sessionCount: 2,
  }));
  assert.equal(await runtime.page.evaluate(() => currentTaskStartedAt), FIXED_NOW - 20000);
});

test("malformed optional fields in cached data cannot abort initial polling", async t => {
  const runtime = await openStatusPage({ snapshot: { data: validStatus({ tokenStats: { byModel: [null] } }), savedAt: FIXED_NOW } });
  t.after(() => runtime.close());
  await waitFor(() => runtime.requestCounts.status > 0 || runtime.pageErrors.length > 0, "startup did not run");
  assert.deepEqual(runtime.pageErrors.map(e => e.message), []);
  assert.equal(runtime.requestCounts.status, 1);
});
