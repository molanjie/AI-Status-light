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
