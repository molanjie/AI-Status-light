const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const DEFAULT_PAGE_URL = "https://molanjie.github.io/AI-Status-light/";
const FAILURE_PROBE_KEY = "__codexStatusFailureProbe";
const SNAPSHOT_KEY = "codex_status_last_good_v1";
const widths = [320, 390, 1280];

function installFailureCycleProbe(probeKey = FAILURE_PROBE_KEY) {
  const root = window;
  const probe = {
    failureCount: 0,
    successCount: 0,
    failureEvents: [],
  };
  const wrappedApis = new WeakSet();
  root[probeKey] = probe;

  function wrapTracker(tracker) {
    if (!tracker || typeof tracker.recordFailure !== "function") return tracker;
    const originalRecordFailure = tracker.recordFailure;
    if (originalRecordFailure.__codexStatusProbeWrapped) return tracker;
    const wrappedRecordFailure = function (...args) {
      let result;
      try {
        result = Reflect.apply(originalRecordFailure, this, args);
        return result;
      } finally {
        probe.failureCount += 1;
        probe.failureEvents.push({
          count: probe.failureCount,
          result,
        });
      }
    };
    try {
      Object.defineProperty(wrappedRecordFailure, "__codexStatusProbeWrapped", {
        value: true,
      });
      tracker.recordFailure = wrappedRecordFailure;
    } catch (error) {
      return tracker;
    }
    return tracker;
  }

  function wrapApi(api) {
    if (!api || typeof api.createFailureTracker !== "function") return api;
    if (wrappedApis.has(api)) return api;
    const originalCreateFailureTracker = api.createFailureTracker;
    const wrappedCreateFailureTracker = function (...args) {
      return wrapTracker(
        Reflect.apply(originalCreateFailureTracker, this, args)
      );
    };
    try {
      api.createFailureTracker = wrappedCreateFailureTracker;
      wrappedApis.add(api);
      return api;
    } catch (error) {
      const proxy = new Proxy(api, {
        get(target, property, receiver) {
          if (property === "createFailureTracker") {
            return wrappedCreateFailureTracker;
          }
          return Reflect.get(target, property, receiver);
        },
      });
      wrappedApis.add(api);
      return proxy;
    }
  }

  const previousDescriptor = Object.getOwnPropertyDescriptor(
    root,
    "CodexStatusConnection"
  );
  if (previousDescriptor?.configurable === false) {
    if ("value" in previousDescriptor && previousDescriptor.writable) {
      root.CodexStatusConnection = wrapApi(previousDescriptor.value);
    }
    return probe;
  }

  let currentValue;
  try {
    currentValue = root.CodexStatusConnection;
  } catch (error) {}
  try {
    Object.defineProperty(root, "CodexStatusConnection", {
      configurable: true,
      enumerable: previousDescriptor?.enumerable ?? true,
      get() {
        return currentValue;
      },
      set(value) {
        currentValue = wrapApi(value);
      },
    });
    if (currentValue !== undefined) currentValue = wrapApi(currentValue);
  } catch (error) {
    if (currentValue !== undefined) wrapApi(currentValue);
  }
  return probe;
}

function createTunnelBlockRouteHandler() {
  return async function blockTunnelTraffic(route) {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname.endsWith(".trycloudflare.com")) {
      await route.abort();
      return;
    }
    await route.continue();
  };
}

async function waitForFailureEvent(page, expected, timeout = 30000) {
  await page.waitForFunction(
    ({ expectedCount, probeKey }) => {
      return (window[probeKey]?.failureCount || 0) >= expectedCount;
    },
    { expectedCount: expected, probeKey: FAILURE_PROBE_KEY },
    { timeout }
  );
}

async function waitForText(page, selector, pattern, timeout = 90000) {
  await page.waitForFunction(
    ({ selector: elementSelector, source, flags }) => {
      const value = document.querySelector(elementSelector)?.textContent || "";
      return new RegExp(source, flags).test(value);
    },
    { selector, source: pattern.source, flags: pattern.flags },
    { timeout }
  );
}

async function readPageState(page) {
  return page.evaluate((snapshotKey) => {
    let snapshot = null;
    try {
      snapshot = JSON.parse(localStorage.getItem(snapshotKey) || "null");
    } catch (error) {
      snapshot = null;
    }
    return {
      statusLabel: document.querySelector("#status-label")?.textContent || "",
      statusTime: document.querySelector("#status-time")?.textContent || "",
      sessionCount: document.querySelector("#session-count")?.textContent || "",
      snapshot,
    };
  }, SNAPSHOT_KEY);
}

async function assertResponsive(page) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      dimensions.scrollWidth <= dimensions.innerWidth,
      `horizontal overflow at ${width}px: scrollWidth=${dimensions.scrollWidth}, innerWidth=${dimensions.innerWidth}`
    );
  }
}

async function main() {
  const pageUrl = process.argv[2] || DEFAULT_PAGE_URL;
  let browser;
  let page;
  let stage = "launching Chromium";

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });

    stage = `initial live sync at ${pageUrl}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    await waitForText(page, "#status-time", /^已同步\s/);
    const initial = await readPageState(page);
    assert.ok(initial.snapshot?.data, "initial live sync did not save a snapshot");
    assert.equal(
      initial.snapshot.data.sessionCount,
      Number.parseInt(initial.sessionCount, 10),
      "saved snapshot does not match the initial session count"
    );

    await page.addInitScript({
      content: `(${installFailureCycleProbe.toString()})(${JSON.stringify(
        FAILURE_PROBE_KEY
      )});`,
    });
    const blockTunnelTraffic = createTunnelBlockRouteHandler();
    await page.route("**/*", blockTunnelTraffic);

    stage = "authoritative complete failure cycles";
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFailureEvent(page, 1);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );
    await waitForFailureEvent(page, 2);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );
    await waitForFailureEvent(page, 3);
    await waitForText(page, "#status-label", /^采集端离线$/, 30000);
    await waitForText(page, "#status-time", /^上次同步\s/, 30000);

    const offline = await readPageState(page);
    assert.equal(
      offline.sessionCount,
      initial.sessionCount,
      "offline state changed the cached session count"
    );
    assert.equal(
      offline.snapshot?.data?.sessionCount,
      initial.snapshot.data.sessionCount,
      "offline failures replaced the cached snapshot"
    );

    stage = "responsive offline layout";
    await assertResponsive(page);

    stage = "automatic recovery without reload";
    await page.unroute("**/*", blockTunnelTraffic);
    await waitForText(page, "#status-time", /^已同步\s/, 30000);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );

    const probe = await page.evaluate((probeKey) => {
      return window[probeKey];
    }, FAILURE_PROBE_KEY);
    process.stdout.write(
      JSON.stringify({
        pageUrl,
        initialLiveSync: true,
        authoritativeFailureEvents: probe.failureCount,
        offlineSnapshotPreserved: true,
        sessionCount: initial.sessionCount,
        recoveredWithoutReload: true,
        widths,
      }) + "\n"
    );
  } catch (error) {
    const details = {
      pageUrl,
      stage,
      currentUrl: page?.url() || null,
      failureCount: page
        ? await page
            .evaluate((probeKey) => window[probeKey]?.failureCount || 0, FAILURE_PROBE_KEY)
            .catch(() => null)
        : null,
      statusLabel: page
        ? await page.locator("#status-label").textContent().catch(() => null)
        : null,
      statusTime: page
        ? await page.locator("#status-time").textContent().catch(() => null)
        : null,
      error: error?.stack || String(error),
    };
    console.error("Live page verification failed:\n" + JSON.stringify(details, null, 2));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = {
  DEFAULT_PAGE_URL,
  FAILURE_PROBE_KEY,
  SNAPSHOT_KEY,
  createTunnelBlockRouteHandler,
  installFailureCycleProbe,
  waitForFailureEvent,
  waitForText,
};

if (require.main === module) main();
