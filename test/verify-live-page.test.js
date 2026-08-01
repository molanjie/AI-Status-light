const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadVerifier() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "verify-live-page.js"),
    "utf8"
  );
  const module = { exports: {} };
  const context = {
    console,
    URL,
    module,
    exports: module.exports,
    process: { argv: ["node", "verify-live-page.js"] },
    require(request) {
      if (request === "node:assert/strict") return assert;
      if (request === "playwright") return { chromium: {} };
      return require(request);
    },
  };
  vm.runInNewContext(source.replace(/\nmain\(\);\s*$/, "\n"), context, {
    filename: "scripts/verify-live-page.js",
  });
  return module.exports;
}

test("outage plan preserves existing query params and deduplicates its registry base", () => {
  const verifier = loadVerifier();
  const plan = verifier.buildDeterministicOutagePlan(
    "https://pages.example/status/?view=compact&api=stale",
    "https://selected.trycloudflare.com/",
    "https://raw.githubusercontent.com/example/status/endpoint.json"
  );

  const outageUrl = new URL(plan.pageUrl);
  assert.equal(outageUrl.searchParams.get("view"), "compact");
  assert.equal(
    outageUrl.searchParams.get("api"),
    "https://selected.trycloudflare.com"
  );
  assert.equal(plan.registryPayload.apiBase, "https://selected.trycloudflare.com");
  assert.equal(plan.candidateBases.length, 1);
  assert.equal(plan.candidateBases[0], "https://selected.trycloudflare.com");
  assert.equal(plan.registryUrl, "https://raw.githubusercontent.com/example/status/endpoint.json");
});

test("failure cycle observer waits for idle, in-flight, then idle", async () => {
  const verifier = loadVerifier();
  const calls = [];
  const page = {
    async waitForFunction(predicate, arg, options) {
      calls.push({ predicate: predicate.toString(), arg, options });
    },
  };
  const observer = verifier.createFailureCycleObserver(page);

  assert.equal(await observer.waitForCompleteCycle(1234), 1);
  assert.equal(await observer.waitForCompleteCycle(1234), 2);
  assert.deepEqual(
    calls.map((call) => call.arg.expectedState),
    [false, true, false, false, true, false]
  );
  assert.ok(calls.every((call) => call.options.timeout === 1234));
});

test("failure cycle observer consumes an already in-flight first cycle", async () => {
  const verifier = loadVerifier();
  const expectedStates = [];
  const page = {
    async waitForFunction(predicate, arg) {
      expectedStates.push(arg.expectedState);
    },
  };
  const observer = verifier.createFailureCycleObserver(page, {
    initiallyInFlight: true,
  });

  assert.equal(await observer.waitForCompleteCycle(), 1);
  assert.equal(await observer.waitForCompleteCycle(), 2);
  assert.deepEqual(expectedStates, [false, false, true, false]);
});

test("outage route aborts only the selected API and keeps registry and page reachable", async () => {
  const verifier = loadVerifier();
  const plan = verifier.buildDeterministicOutagePlan(
    "https://pages.example/status/",
    "https://selected.trycloudflare.com",
    "https://raw.githubusercontent.com/example/status/endpoint.json"
  );
  const handler = verifier.createOutageRouteHandler(plan);
  async function dispatch(url) {
    const actions = [];
    await handler({
      request: () => ({ url: () => url }),
      abort: async () => actions.push("abort"),
      continue: async () => actions.push("continue"),
      fulfill: async (options) => actions.push({ fulfill: options }),
    });
    return actions;
  }

  assert.deepEqual(
    await dispatch("https://selected.trycloudflare.com/api/status"),
    ["abort"]
  );
  const registryActions = await dispatch(`${plan.registryUrl}?t=1`);
  assert.equal(registryActions.length, 1);
  assert.equal(registryActions[0].fulfill.status, 200);
  assert.match(registryActions[0].fulfill.body, /selected\.trycloudflare\.com/);
  assert.deepEqual(await dispatch("https://pages.example/status/"), ["continue"]);
});
