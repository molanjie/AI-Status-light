const { execFileSync } = require("node:child_process");

const OWNER = "molanjie";
const REPO = "AI-Status-light";
const BRANCH = "live-status";
const FILE_PATH = "endpoint.json";
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;

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

async function request({ method, path, token, fetchImpl, body, allowNotFound = false }) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = await readResponseBody(response);

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

  try {
    parsed.apiBase = validateApiBase(parsed.apiBase);
  } catch (error) {
    throw new Error(`Invalid ${FILE_PATH}: ${error.message}`);
  }

  return parsed;
}

async function createBranch(registry, { token, fetchImpl }) {
  const blob = await request({
    method: "POST",
    path: "/git/blobs",
    token,
    fetchImpl,
    body: {
      content: encodeRegistry(registry),
      encoding: "base64",
    },
  });
  const tree = await request({
    method: "POST",
    path: "/git/trees",
    token,
    fetchImpl,
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
    method: "POST",
    path: "/git/commits",
    token,
    fetchImpl,
    body: {
      message: "Publish tunnel endpoint",
      tree: tree.body.sha,
      parents: [],
    },
  });
  await request({
    method: "POST",
    path: "/git/refs",
    token,
    fetchImpl,
    body: {
      ref: `refs/heads/${BRANCH}`,
      sha: commit.body.sha,
    },
  });
}

async function updateEndpoint(registry, file, { token, fetchImpl }) {
  const body = {
    message: "Publish tunnel endpoint",
    content: encodeRegistry(registry),
    branch: BRANCH,
  };
  if (file.sha) {
    body.sha = file.sha;
  }

  await request({
    method: "PUT",
    path: `/contents/${FILE_PATH}`,
    token,
    fetchImpl,
    body,
  });
}

async function publishEndpoint(options) {
  const {
    apiBase,
    token,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
  } = options;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function");
  }

  const publishedAt = typeof now === "function" ? now() : now;
  const registry = buildRegistry(apiBase, publishedAt);
  const branch = await request({
    method: "GET",
    path: `/git/ref/heads/${BRANCH}`,
    token,
    fetchImpl,
    allowNotFound: true,
  });

  if (branch.status === 404) {
    await createBranch(registry, { token, fetchImpl });
    return { changed: true, apiBase: registry.apiBase };
  }

  const file = await request({
    method: "GET",
    path: `/contents/${FILE_PATH}?ref=${BRANCH}`,
    token,
    fetchImpl,
    allowNotFound: true,
  });
  if (file.status === 404) {
    await updateEndpoint(registry, {}, { token, fetchImpl });
    return { changed: true, apiBase: registry.apiBase };
  }

  const current = decodeRegistry(file.body.content);
  if (current.apiBase === registry.apiBase) {
    return { changed: false, apiBase: registry.apiBase };
  }

  await updateEndpoint(registry, file.body, { token, fetchImpl });
  return { changed: true, apiBase: registry.apiBase };
}

function resolveGhPath() {
  return process.platform === "win32" ? "gh.exe" : "gh";
}

function cliUsage() {
  return "Usage: node scripts/endpoint-registry.js publish https://name.trycloudflare.com";
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "publish") {
    throw new Error(cliUsage());
  }

  const token =
    process.env.GH_TOKEN ||
    execFileSync(resolveGhPath(), ["auth", "token"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
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
  FILE_PATH,
  OWNER,
  REPO,
  buildRegistry,
  publishEndpoint,
  validateApiBase,
};
