const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const DEFAULT_PAGE_URL = "https://molanjie.github.io/AI-Status-light/";
const DEFAULT_REGISTRY_URL =
  "https://raw.githubusercontent.com/molanjie/AI-Status-light/live-status/endpoint.json";
const STATUS_API_STORAGE_KEY = "codex_status_api_base";
const SNAPSHOT_KEY = "codex_status_last_good_v1";
const widths = [320, 390, 1280];

function normalizeApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildDeterministicOutagePlan(pageUrl, selectedApiBase, registryUrl = DEFAULT_REGISTRY_URL) {
  const apiBase = normalizeApiBase(selectedApiBase);
  assert.ok(apiBase, "a remembered API base is required for the outage phase");
  const selectedApi = new URL(apiBase);
  assert.equal(selectedApi.protocol, "https:", "the outage base must use HTTPS");
  assert.ok(
    selectedApi.hostname.endsWith(".trycloudflare.com"),
    "the outage base must be a Quick Tunnel endpoint"
  );
  const outageUrl = new URL(pageUrl);
  outageUrl.searchParams.set("api", apiBase);
  return {
    pageUrl: outageUrl.href,
    registryUrl,
    candidateStorageKey: STATUS_API_STORAGE_KEY,
    candidateBases: [apiBase],
    apiUrl: `${apiBase}/api/status`,
    registryPayload: {
      schemaVersion: 1,
      apiBase,
      publishedAt: new Date().toISOString(),
    },
  };
}

function createOutageRouteHandler(plan, options = {}) {
  const selectedApi = new URL(plan.apiUrl);
  const registry = new URL(plan.registryUrl);
  let firstApiRequestStarted = false;
  let releaseFirstApiRequest;
  const firstApiRequestReleased = new Promise((resolve) => {
    releaseFirstApiRequest = resolve;
  });
  let resolveFirstApiRequestStarted;
  const firstApiRequestStartedPromise = new Promise((resolve) => {
    resolveFirstApiRequestStarted = resolve;
  });
  const routeOutageTraffic = async function routeOutageTraffic(route) {
    const requestUrl = new URL(route.request().url());
    if (
      requestUrl.origin === registry.origin &&
      requestUrl.pathname === registry.pathname
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(plan.registryPayload),
      });
      return;
    }
    if (
      selectedApi.protocol === "https:" &&
      selectedApi.hostname.endsWith(".trycloudflare.com") &&
      requestUrl.origin === selectedApi.origin &&
      requestUrl.pathname === selectedApi.pathname
    ) {
      if (options.holdFirstApiRequest && !firstApiRequestStarted) {
        firstApiRequestStarted = true;
        resolveFirstApiRequestStarted();
        await firstApiRequestReleased;
      }
      await route.abort();
      return;
    }
    await route.continue();
  };
  routeOutageTraffic.waitForFirstApiRequest = () => firstApiRequestStartedPromise;
  routeOutageTraffic.releaseFirstApiRequest = () => releaseFirstApiRequest();
  return routeOutageTraffic;
}

function createFailureCycleObserver(page, options = {}) {
  let completedCycles = 0;
  let currentCycleInFlight = Boolean(options.initiallyInFlight);
  async function waitForState(expected, timeout) {
    await page.waitForFunction(
      ({ expectedState }) => window.statusRequestInFlight === expectedState,
      { expectedState: expected },
      { timeout }
    );
  }
  return {
    async waitForCompleteCycle(timeout = 10000) {
      if (currentCycleInFlight) {
        await waitForState(false, timeout);
        currentCycleInFlight = false;
      } else {
        await waitForState(false, timeout);
        await waitForState(true, timeout);
        await waitForState(false, timeout);
      }
      completedCycles += 1;
      return completedCycles;
    },
    count() {
      return completedCycles;
    },
  };
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

async function triggerAndObserveFailureCycle(page, observer) {
  const cycle = observer.waitForCompleteCycle();
  await page.evaluate(() => {
    void fetchStatus();
  });
  return cycle;
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

    const rememberedBase = await page.evaluate((storageKey) => {
      return localStorage.getItem(storageKey);
    }, STATUS_API_STORAGE_KEY);
    const outagePlan = buildDeterministicOutagePlan(pageUrl, rememberedBase);
    const routeOutageTraffic = createOutageRouteHandler(outagePlan, {
      holdFirstApiRequest: true,
    });
    await page.evaluate((storageKey) => {
      localStorage.removeItem(storageKey);
    }, outagePlan.candidateStorageKey);

    await page.route("**/*", routeOutageTraffic);
    stage = "three complete public API failure cycles";
    await page.goto(outagePlan.pageUrl, { waitUntil: "domcontentloaded" });
    await Promise.race([
      routeOutageTraffic.waitForFirstApiRequest(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("initial API request did not start")), 30000)
      ),
    ]);
    const observer = createFailureCycleObserver(page, { initiallyInFlight: true });
    routeOutageTraffic.releaseFirstApiRequest();

    assert.equal(await observer.waitForCompleteCycle(), 1);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );
    assert.equal(await triggerAndObserveFailureCycle(page, observer), 2);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );
    assert.equal(await triggerAndObserveFailureCycle(page, observer), 3);
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
    await page.unroute("**/*", routeOutageTraffic);
    await page.waitForFunction(
      () => window.statusRequestInFlight === false,
      undefined,
      { timeout: 30000 }
    );
    await triggerAndObserveFailureCycle(page, {
      waitForCompleteCycle: async () => {
        await page.waitForFunction(
          () => window.statusRequestInFlight === true,
          undefined,
          { timeout: 10000 }
        );
        await page.waitForFunction(
          () => window.statusRequestInFlight === false,
          undefined,
          { timeout: 10000 }
        );
        return true;
      },
    });
    await waitForText(page, "#status-time", /^已同步\s/, 30000);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );

    process.stdout.write(
      JSON.stringify({
        pageUrl,
        initialLiveSync: true,
        completeFailureCycles: observer.count(),
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
  DEFAULT_REGISTRY_URL,
  STATUS_API_STORAGE_KEY,
  SNAPSHOT_KEY,
  buildDeterministicOutagePlan,
  createFailureCycleObserver,
  createOutageRouteHandler,
  waitForText,
};

if (require.main === module) main();
