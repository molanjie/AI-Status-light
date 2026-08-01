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
    window: {},
    module,
    exports: module.exports,
    process: { argv: ["node", "verify-live-page.js"] },
    require(request) {
      if (request === "node:assert/strict") return assert;
      if (request === "playwright") return { chromium: {} };
      return require(request);
    },
  };
  vm.runInNewContext(source.replace(/\nif \(require\.main === module\) main\(\);\s*$/, "\n"), context, {
    filename: "scripts/verify-live-page.js",
  });
  return { verifier: module.exports, window: context.window };
}

test("probe wraps assigned tracker without changing return values or this binding", () => {
  const { verifier, window } = loadVerifier();
  const probe = verifier.installFailureCycleProbe("__testProbe");
  const tracker = {
    value: 41,
    recordFailure(delta) {
      this.value += delta;
      return { value: this.value };
    },
    recordSuccess() {
      this.value = 0;
      return "success";
    },
  };
  const api = {
    createFailureTracker(limit) {
      assert.equal(limit, 3);
      return tracker;
    },
  };

  window.CodexStatusConnection = api;
  const wrappedTracker = window.CodexStatusConnection.createFailureTracker(3);
  assert.equal(wrappedTracker, tracker);
  assert.deepEqual(wrappedTracker.recordFailure(1), { value: 42 });
  assert.equal(probe.failureCount, 1);
  assert.equal(probe.failureEvents.length, 1);
  assert.equal(wrappedTracker.recordSuccess(), "success");
  assert.equal(probe.failureCount, 1);
  assert.equal(wrappedTracker.value, 0);
});

test("candidate requests do not increment the probe, while a real failure call does once", () => {
  const { verifier, window } = loadVerifier();
  const probe = verifier.installFailureCycleProbe("__testProbe");
  let failures = 0;
  window.CodexStatusConnection = {
    createFailureTracker() {
      return {
        recordFailure() {
          failures += 1;
          return failures >= 3;
        },
        recordSuccess() {},
      };
    },
  };
  const tracker = window.CodexStatusConnection.createFailureTracker(3);

  for (const candidate of ["tunnel-a", "tunnel-b", "tunnel-c"]) {
    assert.match(candidate, /^tunnel-/);
    assert.equal(probe.failureCount, 0);
  }
  assert.equal(tracker.recordFailure(), false);
  assert.equal(probe.failureCount, 1);
  assert.equal(tracker.recordFailure(), false);
  assert.equal(probe.failureCount, 2);
});

test("failure event wait is count-based and accepts an already recorded cycle", async () => {
  const { verifier, window } = loadVerifier();
  window.__codexStatusFailureProbe = { failureCount: 2 };
  const calls = [];
  const page = {
    async waitForFunction(predicate, arg, options) {
      assert.equal(predicate(arg), true);
      calls.push({ predicate: predicate.toString(), arg, options });
    },
  };

  await verifier.waitForFailureEvent(page, 2, 4321);
  assert.equal(calls[0].arg.expectedCount, 2);
  assert.equal(calls[0].arg.probeKey, "__codexStatusFailureProbe");
  assert.equal(calls[0].options.timeout, 4321);
});

test("route aborts two tunnel candidates and continues raw registry and Pages traffic", async () => {
  const { verifier } = loadVerifier();
  const handler = verifier.createTunnelBlockRouteHandler();
  async function dispatch(url) {
    const actions = [];
    await handler({
      request: () => ({ url: () => url }),
      abort: async () => actions.push("abort"),
      continue: async () => actions.push("continue"),
    });
    return actions;
  }

  assert.deepEqual(
    await dispatch("https://candidate-a.trycloudflare.com/api/status"),
    ["abort"]
  );
  assert.deepEqual(
    await dispatch("https://candidate-b.trycloudflare.com/api/status"),
    ["abort"]
  );
  assert.deepEqual(
    await dispatch("https://raw.githubusercontent.com/example/status/endpoint.json"),
    ["continue"]
  );
  assert.deepEqual(await dispatch("https://molanjie.github.io/AI-Status-light/"), ["continue"]);
});
