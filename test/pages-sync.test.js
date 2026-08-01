const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("published assets match canonical public assets", () => {
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "index.html"), "utf8"),
    fs.readFileSync(path.join(root, "public", "index.html"), "utf8")
  );
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "status-connection.js"), "utf8"),
    fs.readFileSync(path.join(root, "public", "status-connection.js"), "utf8")
  );
});

test("published page discovers live endpoint without a compiled tunnel URL", () => {
  const html = fs.readFileSync(path.join(root, "docs", "index.html"), "utf8");
  assert.match(html, /status-connection\.js/);
  assert.match(
    html,
    /raw\.githubusercontent\.com\/molanjie\/AI-Status-light\/live-status\/endpoint\.json/
  );
  assert.doesNotMatch(html, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  assert.match(html, /采集端离线/);
});
