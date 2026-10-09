const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getTokenStats } = require("../codex-status");
const { isValidStatus } = require("../public/status-connection");
const NOW = Date.parse("2026-10-09T04:00:00Z");
function count(total, timestamp) {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count", info: {
    total_token_usage: { total_tokens: total, input_tokens: total, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0 },
  } } }) + "\n";
}
test("database totals remain separate from calendar increments and archived consumption is included", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trend-db-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE threads (id TEXT, tokens_used INTEGER, archived INTEGER, model TEXT, rollout_path TEXT, updated_at_ms INTEGER, recency_at_ms INTEGER)");
  const a = path.join(dir, "a.jsonl"), b = path.join(dir, "b.jsonl");
  fs.writeFileSync(a, count(100, "2026-10-01T00:00:00Z") + count(110, "2026-10-08T15:59:00Z") + count(120, "2026-10-08T16:00:00Z"));
  fs.writeFileSync(b, count(50, "2026-10-01T00:00:00Z") + count(55, "2026-10-09T01:00:00Z"));
  db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run("a", 999999, 0, "gpt-test", a, NOW, NOW);
  db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?)").run("b", 55555, 1, "gpt-test", b, NOW, NOW);
  db.close();
  assert.equal(typeof getTokenStats, "function");
  const stats = getTokenStats(file, NOW);
  assert.equal(stats.totalTokens, 999999);
  assert.equal(stats.tokens24h, 25);
  assert.equal(stats.trend.tokensToday, 15);
  assert.equal(stats.trend.tokens7d, 25);
  assert.equal(stats.trend.status, "ready");
  assert.equal(isValidStatus({ state: "idle", light: "green", label: "Idle", sessionCount: 0, sessions: [], updatedAt: NOW, tokenStats: stats }), true);
  assert.doesNotMatch(JSON.stringify(stats), /jsonl|rollout_path|state.sqlite/);
  assert.equal(getTokenStats(file, NOW + 1000), stats);
  fs.appendFileSync(a, count(125, "2026-10-09T03:00:00Z"));
  assert.equal(getTokenStats(file, NOW + 5000).trend.tokensToday, 20);
});
