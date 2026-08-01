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
  const requestCounts = { registry: 0, status: 0 };

  await context.addInitScript(
    ({ appOrigin, fixedNow, snapshotKey, snapshot }) => {
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
    },
    {
      appOrigin: APP_ORIGIN,
      fixedNow: options.now || FIXED_NOW,
      snapshotKey: SNAPSHOT_KEY,
      snapshot: options.snapshot || null,
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
      if (options.onStatusRequest) {
        await options.onStatusRequest(route, requestCounts.status);
      } else {
        await jsonResponse(route, 503, { error: "collector unavailable" });
      }
      return;
    }

    await route.abort();
  });

  await page.goto(
    `${APP_ORIGIN}/index.html?api=${encodeURIComponent(STATUS_API_BASE)}`,
    { waitUntil: "load" }
  );

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
