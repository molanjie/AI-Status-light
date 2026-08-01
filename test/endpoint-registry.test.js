const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRegistry,
  getGitHubToken,
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

test("repairs same-URL registries whose browser-required metadata is invalid", async (t) => {
  const cases = [
    {
      name: "wrong schema",
      registry: {
        schemaVersion: 99,
        apiBase: "https://same.trycloudflare.com",
        publishedAt: "2026-07-31T12:00:00.000Z",
      },
    },
    {
      name: "missing schema",
      registry: {
        apiBase: "https://same.trycloudflare.com",
        publishedAt: "2026-07-31T12:00:00.000Z",
      },
    },
    {
      name: "invalid publication time",
      registry: {
        schemaVersion: 1,
        apiBase: "https://same.trycloudflare.com",
        publishedAt: "not-a-date",
      },
    },
    {
      name: "missing publication time",
      registry: {
        schemaVersion: 1,
        apiBase: "https://same.trycloudflare.com",
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const calls = [];
      const oldContent = Buffer.from(
        `${JSON.stringify(fixture.registry, null, 2)}\n`,
        "utf8"
      ).toString("base64");
      const replies = [
        response(200, { object: { sha: "head-sha" } }),
        response(200, { sha: "file-sha", content: oldContent }),
        response(200, { content: { sha: "repaired-file-sha" } }),
      ];

      const result = await publishEndpoint({
        apiBase: "https://same.trycloudflare.com",
        token: "test-token",
        now: () => new Date("2026-07-31T12:30:00.000Z"),
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          return replies.shift();
        },
      });

      assert.deepEqual(result, {
        changed: true,
        apiBase: "https://same.trycloudflare.com",
      });
      assert.equal(calls.length, 3);
      assert.equal(calls[2].options.method, "PUT");
      const requestBody = JSON.parse(calls[2].options.body);
      assert.equal(requestBody.sha, "file-sha");
      assert.equal(requestBody.branch, "live-status");
      assert.deepEqual(
        JSON.parse(Buffer.from(requestBody.content, "base64").toString("utf8")),
        {
          schemaVersion: 1,
          apiBase: "https://same.trycloudflare.com",
          publishedAt: "2026-07-31T12:30:00.000Z",
        }
      );
    });
  }
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

test("aborts a stalled GitHub request at its per-request deadline", async () => {
  let observedSignal;
  const startedAt = Date.now();

  await assert.rejects(
    publishEndpoint({
      apiBase: "https://same.trycloudflare.com",
      token: "test-token",
      requestTimeoutMs: 30,
      overallTimeoutMs: 500,
      fetchImpl: async (url, options) => {
        observedSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason || new Error("aborted")),
            { once: true }
          );
        });
      },
    }),
    /GitHub GET \/git\/ref\/heads\/live-status timed out/
  );

  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 400, "request deadline did not bound the stalled fetch");
});

test("overall publication deadline preempts a longer request deadline", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    publishEndpoint({
      apiBase: "https://same.trycloudflare.com",
      token: "test-token",
      requestTimeoutMs: 500,
      overallTimeoutMs: 30,
      fetchImpl: async (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason || new Error("aborted")),
            { once: true }
          );
        }),
    }),
    /Endpoint publication timed out/
  );

  assert.ok(Date.now() - startedAt < 400, "overall deadline did not bound publication");
});

test("gh token lookup uses a bounded hidden command and sanitizes failures", () => {
  let invocation;
  const token = getGitHubToken({
    env: {},
    execFileSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return "cli-token\n";
    },
  });

  assert.equal(token, "cli-token");
  assert.match(invocation.command, /^gh(?:\.exe)?$/);
  assert.deepEqual(invocation.args, ["auth", "token"]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.equal(invocation.options.windowsHide, true);
  assert.ok(invocation.options.timeout > 0 && invocation.options.timeout <= 10000);

  assert.throws(
    () =>
      getGitHubToken({
        env: {},
        execFileSyncImpl() {
          throw new Error("secret-token command timed out");
        },
      }),
    (error) => {
      assert.match(error.message, /GitHub authentication token lookup failed or timed out/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    }
  );
});
