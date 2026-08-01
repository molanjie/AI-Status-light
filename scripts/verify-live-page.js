const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const pageUrl =
  process.argv[2] || "https://molanjie.github.io/AI-Status-light/";
const widths = [320, 390, 1280];

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
  return page.evaluate(() => {
    const snapshotKey = "codex_status_last_good_v1";
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
      threadTitle: document.querySelector("#thread-title")?.textContent || "",
      snapshot,
    };
  });
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

    const blockedTunnelUrls = [];
    const blockTunnelTraffic = async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.hostname.endsWith(".trycloudflare.com")) {
        blockedTunnelUrls.push(requestUrl.href);
        await route.abort();
        return;
      }
      await route.continue();
    };

    await page.route("**/*", blockTunnelTraffic);
    stage = "three public API failures and cached offline snapshot";
    await page.reload({ waitUntil: "domcontentloaded" });
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
    assert.ok(blockedTunnelUrls.length >= 3, "fewer than three tunnel failures were observed");

    stage = "responsive offline layout";
    await assertResponsive(page);

    stage = "automatic recovery without reload";
    await page.unroute("**/*", blockTunnelTraffic);
    await waitForText(page, "#status-time", /^已同步\s/, 30000);
    assert.doesNotMatch(
      await page.locator("#status-label").textContent(),
      /^采集端离线$/
    );

    process.stdout.write(
      JSON.stringify({
        pageUrl,
        initialLiveSync: true,
        offlineSnapshotPreserved: true,
        sessionCount: initial.sessionCount,
        blockedTunnelRequests: blockedTunnelUrls.length,
        recoveredWithoutReload: true,
        widths,
      }) + "\n"
    );
  } catch (error) {
    const details = {
      pageUrl,
      stage,
      currentUrl: page?.url() || null,
      statusLabel: page ? await page.locator("#status-label").textContent().catch(() => null) : null,
      statusTime: page ? await page.locator("#status-time").textContent().catch(() => null) : null,
      error: error?.stack || String(error),
    };
    console.error("Live page verification failed:\n" + JSON.stringify(details, null, 2));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

main();
