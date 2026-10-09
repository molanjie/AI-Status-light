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
  const data = { state: "processing", light: "red", label: "处理中", sessionCount: 0, sessions: [], updatedAt: 1785432000000 };
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

test("prefers the local page origin over tunnel discovery unless explicitly overridden", () => {
  assert.deepEqual(connection.buildApiCandidates({
    pageOrigin: "http://127.0.0.1:3456",
    explicitBase: "https://manual.example",
    registryBase: "https://live.trycloudflare.com",
  }), ["https://manual.example", "http://127.0.0.1:3456", "https://live.trycloudflare.com"]);
  assert.deepEqual(connection.buildApiCandidates({ pageOrigin: "https://molanjie.github.io" }), []);
});

test("validates status and history before replacing a good snapshot", () => {
  assert.equal(typeof connection.isValidStatus, "function");
  if (!connection.isValidStatus) return;
  const good = { state: "idle", light: "green", label: "空闲", sessionCount: 0, sessions: [], updatedAt: 1785432000000 };
  assert.equal(connection.isValidStatus(good), true);
  assert.equal(connection.isValidStatus({ ...good, state: "unknown" }), false);
  assert.equal(connection.isValidStatus({ ...good, sessions: [{ title: {}, state: "processing" }] }), false);
  assert.equal(connection.isValidStatus({ ...good, history: [{ state: "completed", title: "A", finishedAt: "bad" }] }), false);
  assert.equal(connection.isValidStatus({ ...good, updatedAt: -1 }), false);
});

test("malformed cached status cannot replace a valid stored snapshot", () => {
  const valid = { state: "idle", light: "green", label: "空闲", sessionCount: 0, sessions: [], updatedAt: 1785432000000 };
  const storage = memoryStorage();
  connection.saveSnapshot(storage, valid, 1785432000000);
  connection.saveSnapshot(storage, { state: "invalid" }, 1785432000001);
  assert.equal(connection.loadSnapshot(storage).data.state, "idle");
  const corrupted = memoryStorage({ codex_status_last_good_v1: JSON.stringify({ data: { state: "processing", sessions: {} }, savedAt: 1785432000000 }) });
  assert.equal(connection.loadSnapshot(corrupted), null);
});

test("optional renderer data is validated before cache and render", () => {
  const status = { state: "idle", light: "green", label: "空闲", sessionCount: 0, sessions: [], updatedAt: 1785432000000 };
  for (const bad of [
    { tokenStats: { byModel: [null] } },
    { tokenStats: { byModel: {} } },
    { tokenStats: { byModel: [{ model: "x", tokens: "bad" }] } },
    { plan: { name: {} } },
    { diagnostics: [] },
    { error: {} },
  ]) assert.equal(connection.isValidStatus({ ...status, ...bad }), false);
});

test("current actions and real usage trends are validated before rendering or caching", () => {
  const status = { state: "processing", light: "red", label: "Working", sessionCount: 1,
    updatedAt: Date.now(), sessions: [{ title: "Current", state: "processing" }] };
  for (const action of ["invalid", { kind: "read", label: {}, startedAt: 1 },
    { kind: "arbitrary-tool-name", label: "secret", startedAt: 1 }, { kind: "read", label: "Read", startedAt: -1 }]) {
    assert.equal(connection.isValidStatus({ ...status, sessions: [{ ...status.sessions[0], currentAction: action }] }), false);
  }
  for (const trend of [[], { status: "ready", days: [null] }, { status: "ready", days: "bad" }]) {
    assert.equal(connection.isValidStatus({ ...status, tokenStats: { trend } }), false);
  }
  for (const sessionKey of [123, {}, "private-thread-id"]) {
    assert.equal(connection.isValidStatus({ ...status, sessions: [{ ...status.sessions[0], sessionKey }] }), false);
  }
  assert.equal(connection.isValidStatus({ ...status, sessions: [{ ...status.sessions[0],
    sessionKey: "a".repeat(32), model: "gpt-5.5", currentAction: { kind: "read", label: "Read", startedAt: 1 } }] }), true);
});
