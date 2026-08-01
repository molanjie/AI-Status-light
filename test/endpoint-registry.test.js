const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRegistry,
  publishEndpoint,
  validateApiBase,
} = require("../scripts/endpoint-registry");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("validates only HTTPS Quick Tunnel API bases", () => {
  assert.equal(
    validateApiBase("https://valid-name.trycloudflare.com/"),
    "https://valid-name.trycloudflare.com"
  );
  assert.throws(() => validateApiBase("http://valid-name.trycloudflare.com"));
  assert.throws(() => validateApiBase("https://example.com"));
  assert.throws(() => validateApiBase("https://a.b.trycloudflare.com"));
});

test("creates an orphan live-status branch when it is missing", async () => {
  const calls = [];
  const replies = [
    response(404, { message: "Not Found" }),
    response(201, { sha: "blob-sha" }),
    response(201, { sha: "tree-sha" }),
    response(201, { sha: "commit-sha" }),
    response(201, { ref: "refs/heads/live-status" }),
  ];
  const result = await publishEndpoint({
    apiBase: "https://first.trycloudflare.com",
    token: "test-token",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    apiBase: "https://first.trycloudflare.com",
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map(({ url, options }) => ({
      method: options.method,
      url,
    })),
    [
      {
        method: "GET",
        url: "https://api.github.com/repos/molanjie/AI-Status-light/git/ref/heads/live-status",
      },
      {
        method: "POST",
        url: "https://api.github.com/repos/molanjie/AI-Status-light/git/blobs",
      },
      {
        method: "POST",
        url: "https://api.github.com/repos/molanjie/AI-Status-light/git/trees",
      },
      {
        method: "POST",
        url: "https://api.github.com/repos/molanjie/AI-Status-light/git/commits",
      },
      {
        method: "POST",
        url: "https://api.github.com/repos/molanjie/AI-Status-light/git/refs",
      },
    ]
  );
  const treeBody = JSON.parse(calls[2].options.body);
  assert.deepEqual(treeBody.tree, [
    {
      path: "endpoint.json",
      mode: "100644",
      type: "blob",
      sha: "blob-sha",
    },
  ]);
  const commitBody = JSON.parse(calls[3].options.body);
  assert.deepEqual(commitBody.parents, []);
  assert.equal(commitBody.tree, "tree-sha");
  const refBody = JSON.parse(calls[4].options.body);
  assert.deepEqual(refBody, {
    ref: "refs/heads/live-status",
    sha: "commit-sha",
  });
});

test("does not commit when the registered endpoint already matches", async () => {
  const registry = buildRegistry(
    "https://same.trycloudflare.com",
    new Date("2026-07-31T12:00:00.000Z")
  );
  const content = Buffer.from(JSON.stringify(registry, null, 2) + "\n").toString("base64");
  const calls = [];
  const result = await publishEndpoint({
    apiBase: "https://same.trycloudflare.com",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return response(200, { object: { sha: "head-sha" } });
      return response(200, { sha: "file-sha", content });
    },
  });

  assert.deepEqual(result, {
    changed: false,
    apiBase: "https://same.trycloudflare.com",
  });
  assert.equal(calls.length, 2);
});

test("updates only endpoint.json when the registered endpoint changes", async () => {
  const oldRegistry = buildRegistry(
    "https://old.trycloudflare.com",
    new Date("2026-07-31T11:00:00.000Z")
  );
  const oldContent = Buffer.from(
    JSON.stringify(oldRegistry, null, 2) + "\n"
  ).toString("base64");
  const calls = [];
  const replies = [
    response(200, { object: { sha: "head-sha" } }),
    response(200, { sha: "file-sha", content: oldContent }),
    response(200, { content: { sha: "new-file-sha" } }),
  ];
  const result = await publishEndpoint({
    apiBase: "https://new.trycloudflare.com",
    token: "test-token",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  assert.deepEqual(result, {
    changed: true,
    apiBase: "https://new.trycloudflare.com",
  });
  assert.equal(calls[2].options.method, "PUT");
  const requestBody = JSON.parse(calls[2].options.body);
  assert.equal(requestBody.branch, "live-status");
  assert.equal(requestBody.sha, "file-sha");
});

test("creates endpoint.json on an existing branch without a file SHA", async () => {
  const calls = [];
  const replies = [
    response(200, { object: { sha: "head-sha" } }),
    response(404, { message: "Not Found" }),
    response(201, { content: { sha: "new-file-sha" } }),
  ];
  await publishEndpoint({
    apiBase: "https://new.trycloudflare.com",
    token: "test-token",
    now: () => new Date("2026-07-31T12:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return replies.shift();
    },
  });

  const requestBody = JSON.parse(calls[2].options.body);
  assert.equal(requestBody.branch, "live-status");
  assert.equal(Object.hasOwn(requestBody, "sha"), false);
});

test("ignores whitespace in GitHub Base64 content", async () => {
  const registry = buildRegistry(
    "https://same.trycloudflare.com",
    new Date("2026-07-31T12:00:00.000Z")
  );
  const encoded = Buffer.from(JSON.stringify(registry, null, 2) + "\n").toString("base64");
  const spacedContent = `${encoded.slice(0, 8)}\n${encoded.slice(8)}  `;
  let calls = 0;
  const result = await publishEndpoint({
    apiBase: "https://same.trycloudflare.com",
    token: "test-token",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response(200, { object: { sha: "head-sha" } });
      return response(200, { sha: "file-sha", content: spacedContent });
    },
  });

  assert.equal(result.changed, false);
});

test("reports malformed endpoint.json", async () => {
  const calls = [];
  const malformed = Buffer.from("not JSON", "utf8").toString("base64");
  await assert.rejects(
    publishEndpoint({
      apiBase: "https://same.trycloudflare.com",
      token: "test-token",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) return response(200, { object: { sha: "head-sha" } });
        return response(200, { sha: "file-sha", content: malformed });
      },
    }),
    /Invalid endpoint\.json/
  );
});

test("includes GitHub method, path, status, and message in errors", async () => {
  await assert.rejects(
    publishEndpoint({
      apiBase: "https://same.trycloudflare.com",
      token: "secret-token",
      fetchImpl: async () => response(403, { message: "Bad credentials" }),
    }),
    (error) => {
      assert.match(error.message, /GitHub GET \/git\/ref\/heads\/live-status failed with 403/);
      assert.match(error.message, /Bad credentials/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    }
  );
});

test("preserves non-JSON GitHub error body after reading a real Response", async () => {
  await assert.rejects(
    publishEndpoint({
      apiBase: "https://same.trycloudflare.com",
      token: "test-token",
      fetchImpl: async () => new Response("upstream gateway failure", { status: 502 }),
    }),
    (error) => {
      assert.match(error.message, /GitHub GET \/git\/ref\/heads\/live-status failed with 502/);
      assert.match(error.message, /upstream gateway failure/);
      return true;
    }
  );
});
