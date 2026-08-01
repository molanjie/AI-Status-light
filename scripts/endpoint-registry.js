const { execFileSync } = require("node:child_process");

const OWNER = "molanjie";
const REPO = "AI-Status-light";
const BRANCH = "live-status";
const FILE_PATH = "endpoint.json";
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_PUBLICATION_TIMEOUT_MS = 30000;
const GH_TOKEN_TIMEOUT_MS = 5000;

function validateApiBase(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("apiBase must be an HTTPS trycloudflare.com URL");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("apiBase must be an HTTPS trycloudflare.com URL");
  }

  const hostname = parsed.hostname.toLowerCase();
  const labels = hostname.split(".");
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const isTryCloudflareHost =
    labels.length === 3 &&
    validLabel.test(labels[0]) &&
    labels[1] === "trycloudflare" &&
    labels[2] === "com";

  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !isTryCloudflareHost
  ) {
    throw new Error("apiBase must be an HTTPS trycloudflare.com URL");
  }

  return parsed.origin;
}

function buildRegistry(apiBase, now = new Date()) {
  return {
    schemaVersion: 1,
    apiBase: validateApiBase(apiBase),
    publishedAt: now.toISOString(),
  };
}

async function readResponseBody(response) {
  let text;
  try {
    text = await response.text();
  } catch (error) {
    return { message: `Unable to read response body: ${error.message}` };
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function githubMessage(body) {
  if (body && typeof body.message === "string" && body.message.length > 0) {
    return body.message;
  }
  if (typeof body === "string" && body.length > 0) {
    return body;
  }
  return "Unknown GitHub error";
}

function requirePositiveTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
}

async function runWithDeadline(operation, options) {
  const {
    label,
    timeoutMs,
    overallSignal,
    overallTimeoutMs,
  } = options;
  const controller = new AbortController();
  let rejectDeadline;
  const deadlinePromise = new Promise((resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = (error) => {
    if (controller.signal.aborted) return;
    rejectDeadline(error);
    controller.abort(error);
  };
  const timeoutId = setTimeout(() => {
    abort(new Error(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const onOverallAbort = () => {
    abort(new Error(`Endpoint publication timed out after ${overallTimeoutMs}ms`));
  };

  if (overallSignal.aborted) {
    onOverallAbort();
  } else {
    overallSignal.addEventListener("abort", onOverallAbort, { once: true });
  }

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadlinePromise,
    ]);
  } finally {
    clearTimeout(timeoutId);
    overallSignal.removeEventListener("abort", onOverallAbort);
  }
}

async function request({
  method,
  path,
  token,
  fetchImpl,
  body,
  allowNotFound = false,
  requestTimeoutMs,
  overallSignal,
  overallTimeoutMs,
}) {
  const { response, responseBody } = await runWithDeadline(
    async (signal) => {
      const response = await fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, responseBody: await readResponseBody(response) };
    },
    {
      label: `GitHub ${method} ${path}`,
      timeoutMs: requestTimeoutMs,
      overallSignal,
      overallTimeoutMs,
    }
  );

  if (response.status === 404 && allowNotFound) {
    return { status: response.status, body: responseBody };
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `GitHub ${method} ${path} failed with ${response.status}: ${githubMessage(responseBody)}`
    );
  }

  return { status: response.status, body: responseBody };
}

function registryContent(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function encodeRegistry(registry) {
  return Buffer.from(registryContent(registry), "utf8").toString("base64");
}

function decodeRegistry(content) {
  if (typeof content !== "string") {
    throw new Error(`Invalid ${FILE_PATH}: GitHub returned no Base64 content`);
  }

  let parsed;
  try {
    const decoded = Buffer.from(content.replace(/\s+/g, ""), "base64").toString("utf8");
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`Invalid ${FILE_PATH}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${FILE_PATH}: expected a JSON object`);
  }

  let apiBase;
  try {
    apiBase = validateApiBase(parsed.apiBase);
  } catch (error) {
    throw new Error(`Invalid ${FILE_PATH}: ${error.message}`);
  }

  const publishedAtIsValid =
    typeof parsed.publishedAt === "string" &&
    Number.isFinite(Date.parse(parsed.publishedAt));
  return {
    apiBase,
    publishedAt: parsed.publishedAt,
    schemaVersion: parsed.schemaVersion,
    valid: parsed.schemaVersion === 1 && publishedAtIsValid,
  };
}

async function createBranch(registry, requestOptions) {
  const blob = await request({
    ...requestOptions,
    method: "POST",
    path: "/git/blobs",
    body: {
      content: encodeRegistry(registry),
      encoding: "base64",
    },
  });
  const tree = await request({
    ...requestOptions,
    method: "POST",
    path: "/git/trees",
    body: {
      tree: [
        {
          path: FILE_PATH,
          mode: "100644",
          type: "blob",
          sha: blob.body.sha,
        },
      ],
    },
  });
  const commit = await request({
    ...requestOptions,
    method: "POST",
    path: "/git/commits",
    body: {
      message: "Publish tunnel endpoint",
      tree: tree.body.sha,
      parents: [],
    },
  });
  await request({
    ...requestOptions,
    method: "POST",
    path: "/git/refs",
    body: {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.body.sha,
    },
  });
}

async function updateEndpoint(registry, file, requestOptions) {
  const body = {
    message: "Publish tunnel endpoint",
    content: encodeRegistry(registry),
    branch: BRANCH,
  };
  if (file.sha) {
    body.sha = file.sha;
  }

  await request({
    ...requestOptions,
    method: "PUT",
    path: `/contents/${FILE_PATH}`,
    body,
  });
}

async function publishEndpoint(options) {
  const {
    apiBase,
    token,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    overallTimeoutMs = DEFAULT_PUBLICATION_TIMEOUT_MS,
  } = options;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function");
  }

  const boundedRequestTimeoutMs = requirePositiveTimeout(
    requestTimeoutMs,
    "requestTimeoutMs"
  );
  const boundedOverallTimeoutMs = requirePositiveTimeout(
    overallTimeoutMs,
    "overallTimeoutMs"
  );
  const overallController = new AbortController();
  const overallTimeoutId = setTimeout(
    () => overallController.abort(),
    boundedOverallTimeoutMs
  );
  const requestOptions = {
    token,
    fetchImpl,
    requestTimeoutMs: boundedRequestTimeoutMs,
    overallSignal: overallController.signal,
    overallTimeoutMs: boundedOverallTimeoutMs,
  };

  try {
    const publishedAt = typeof now === "function" ? now() : now;
    const registry = buildRegistry(apiBase, publishedAt);
    const branch = await request({
      ...requestOptions,
      method: "GET",
      path: `/git/ref/heads/${BRANCH}`,
      allowNotFound: true,
    });

    if (branch.status === 404) {
      await createBranch(registry, requestOptions);
      return { changed: true, apiBase: registry.apiBase };
    }

    const file = await request({
      ...requestOptions,
      method: "GET",
      path: `/contents/${FILE_PATH}?ref=${BRANCH}`,
      allowNotFound: true,
    });
    if (file.status === 404) {
      await updateEndpoint(registry, {}, requestOptions);
      return { changed: true, apiBase: registry.apiBase };
    }

    const current = decodeRegistry(file.body.content);
    if (current.valid && current.apiBase === registry.apiBase) {
      return { changed: false, apiBase: registry.apiBase };
    }

    await updateEndpoint(registry, file.body, requestOptions);
    return { changed: true, apiBase: registry.apiBase };
  } finally {
    clearTimeout(overallTimeoutId);
  }
}

function resolveGhPath() {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

function cliUsage() {
  return "Usage: node scripts/endpoint-registry.js publish https://name.trycloudflare.com";
}

function getGitHubToken(options = {}) {
  const {
    env = process.env,
    execFileSyncImpl = execFileSync,
    timeoutMs = GH_TOKEN_TIMEOUT_MS,
  } = options;
  const environmentToken =
    typeof env.GH_TOKEN === "string" ? env.GH_TOKEN.trim() : "";
  if (environmentToken) return environmentToken;

  try {
    const token = String(
      execFileSyncImpl(resolveGhPath(), ["auth", "token"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: requirePositiveTimeout(timeoutMs, "timeoutMs"),
      })
    ).trim();
    if (token) return token;
  } catch {}

  throw new Error(
    "GitHub authentication token lookup failed or timed out. Run gh auth login or set GH_TOKEN."
  );
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "publish") {
    throw new Error(cliUsage());
  }

  const token = getGitHubToken();
  const result = await publishEndpoint({ apiBase: argv[1], token });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  API_ROOT,
  BRANCH,
  DEFAULT_PUBLICATION_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FILE_PATH,
  GH_TOKEN_TIMEOUT_MS,
  OWNER,
  REPO,
  buildRegistry,
  getGitHubToken,
  publishEndpoint,
  validateApiBase,
};
