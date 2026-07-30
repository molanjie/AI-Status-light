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
