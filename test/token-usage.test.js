const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let createUsageCollector;
try { ({ createUsageCollector } = require("../token-usage")); }
catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

const NOW = Date.parse("2026-10-09T04:00:00Z");
function collector(options = {}) {
  assert.equal(typeof createUsageCollector, "function", "collector must be exported");
  return createUsageCollector({ scanIntervalMs: 0, ...options });
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return (name, contents = "") => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    return { rollout_path: file };
  };
}
function usage(total, timestamp = "2026-10-09T03:00:00Z", extra = {}) {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count",
    info: { total_token_usage: { input_tokens: total * 0.8, cached_input_tokens: total * 0.2,
      output_tokens: total * 0.2, reasoning_output_tokens: total * 0.1, total_tokens: total, ...extra },
    last_token_usage: { total_tokens: 999999 } } } }) + "\n";
}
function meta(id) { return JSON.stringify({ type: "session_meta", payload: { id } }) + "\n"; }
function settle(c, rows, now = NOW) {
  let result;
  for (let i = 0; i < 10000; i++) {
    result = c.read(rows, { now });
    if (result.status !== "loading") return result;
  }
  assert.fail("scan did not finish");
}

test("counts only cumulative advances and excludes last_token_usage", t => {
  const row = fixture(t)("a", usage(100) + usage(100) + usage(150));
  const c = collector();
  const result = c.read([row], { now: NOW });
  assert.equal(result.status, "ready");
  assert.equal(result.tokensToday, 150);
  assert.equal(result.tokens7d, 150);
  assert.equal(result.tokens24h, 150);
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.cachedInputTokens, 30);
  assert.equal(result.days.length, 7);
  assert.deepEqual(result.days[6], { date: "2026-10-09", tokens: 150, inputTokens: 120,
    outputTokens: 30, cachedInputTokens: 30 });
  assert.equal(result.updatedAt, new Date(NOW).toISOString());
  assert.equal(c.read([row, row], { now: NOW }).tokens7d, 150);
});

test("builds old baseline before timezone day and rolling 24h deltas", t => {
  const row = fixture(t)("a", usage(100, "2026-09-01T00:00:00Z") +
    usage(150, "2026-10-08T03:59:59Z") + usage(200, "2026-10-08T04:00:00Z") +
    usage(250, "2026-10-08T15:59:59Z") + usage(300, "2026-10-08T16:00:00Z"));
  const c = collector();
  const r = c.read([row], { now: NOW });
  assert.equal(r.tokens7d, 200);
  assert.equal(r.tokensToday, 50);
  assert.equal(r.tokens24h, 150);
  assert.deepEqual(r.days.map(d => d.date), ["2026-10-03", "2026-10-04", "2026-10-05",
    "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.equal(r.days[5].tokens, 150);
  assert.equal(c.read([row], { now: Date.parse("2026-10-09T16:00:00Z") }).tokensToday, 0);
  assert.equal(collector({ timeZone: "UTC" }).read([row], { now: NOW }).tokensToday, 0);
});

test("deduplicates resumed copied prefixes by session metadata", t => {
  const file = fixture(t);
  const a = file("a", meta("session-private") + usage(100));
  const b = file("b", meta("session-private") + usage(100) + usage(150));
  const other = file("c", meta("independent") + usage(70, "2026-10-09T03:01:00Z"));
  const c = collector();
  const r = c.read([b, a, other], { now: NOW });
  assert.equal(r.tokens7d, 220);
  assert.equal(r.status, "ready");
  assert.doesNotMatch(JSON.stringify(r), /session-private|rollout_path|usage-|independent/);
  assert.equal(c.read([b], { now: NOW }).tokens7d, 150);
  assert.equal(c.read([], { now: NOW }).tokens7d, 0);
});

test("detects copied cumulative series without session metadata", t => {
  const file = fixture(t);
  const a = file("a", usage(100));
  const b = file("b", usage(100) + usage(150));
  const r = collector().read([a, b], { now: NOW });
  assert.equal(r.tokens7d, 150);
  assert.equal(r.status, "partial");
});

test("independent explicit session IDs with identical first observations both count", t => {
  const file = fixture(t);
  const a = file("a", meta("independent-a") + usage(100));
  const b = file("b", meta("independent-b") + usage(100));
  const r = collector().read([a, b], { now: NOW });
  assert.equal(r.tokensToday, 200);
  assert.equal(r.tokens7d, 200);
  assert.equal(r.tokens24h, 200);
  assert.equal(r.inputTokens, 160);
  assert.equal(r.outputTokens, 40);
  assert.equal(r.cachedInputTokens, 40);
  assert.equal(r.status, "ready");
});

test("a missing-ID prefix cannot transitively merge distinct known sessions", t => {
  const file = fixture(t);
  const a = file("a", meta("independent-a") + usage(100));
  const b = file("b", meta("independent-b") + usage(100));
  const unknown = file("unknown", usage(100));
  for (const rows of [[unknown, a, b], [a, unknown, b], [b, unknown, a], [a, b, unknown]]) {
    const r = collector().read(rows, { now: NOW });
    assert.equal(r.tokens7d, 200, "known sessions remain separate despite the missing-ID bridge");
    assert.equal(r.status, "partial", "unknown identity must not imply an exact total");
  }
});

test("later conflicting metadata clears heuristic ambiguity and restores independent totals", t => {
  const file = fixture(t);
  const a = file("a", meta("independent-a") + usage(100));
  const unknown = file("unknown", usage(100) + usage(150));
  const c = collector();
  const inferred = c.read([a, unknown], { now: NOW });
  assert.equal(inferred.tokens7d, 150);
  assert.equal(inferred.status, "partial");
  fs.appendFileSync(unknown.rollout_path, meta("independent-b"));
  const identified = c.read([a, unknown], { now: NOW });
  assert.equal(identified.tokens7d, 250);
  assert.equal(identified.status, "ready");
});

test("matching metadata completed after an EOF fragment clears temporary partial status", t => {
  const file = fixture(t);
  const a = file("a", meta("same-session") + usage(100));
  const unknown = file("unknown", usage(100) + usage(150));
  const c = collector();
  assert.equal(c.read([a, unknown], { now: NOW }).status, "partial");
  const identity = meta("same-session");
  fs.appendFileSync(unknown.rollout_path, identity.slice(0, -2));
  assert.equal(c.read([a, unknown], { now: NOW }).status, "partial");
  fs.appendFileSync(unknown.rollout_path, identity.slice(-2));
  const r = c.read([a, unknown], { now: NOW });
  assert.equal(r.tokens7d, 150);
  assert.equal(r.status, "ready");
});

test("bounds reads globally and completes a baseline over multiple polls", t => {
  const file = fixture(t);
  const a = file("a", usage(100));
  const b = file("b", usage(70, "2026-10-09T03:01:00Z"));
  const c = collector({ maxBytesPerRead: 64, scanIntervalMs: 5000 });
  const r = c.read([a, b], { now: NOW });
  assert.equal(r.status, "loading");
  assert.equal(r.tokens7d, 0);
  assert.equal(settle(c, [a, b]).tokens7d, 170);
});

test("reports missing or non-file paths as partial without exposing paths", t => {
  const file = fixture(t);
  const a = file("a", usage(100));
  const missing = file("missing");
  fs.unlinkSync(missing.rollout_path);
  const r = collector().read([a, missing, {}], { now: NOW });
  assert.equal(r.status, "partial");
  assert.equal(r.unreadableFiles, 2);
  assert.equal(r.tokens7d, 100);
  assert.equal(collector().read([missing], { now: NOW }).status, "partial");
});

test("preserves appended split UTF8 JSONL and resumes cached counters", t => {
  const row = fixture(t)("a", usage(100));
  const c = collector();
  assert.equal(c.read([row], { now: NOW }).tokens7d, 100);
  const next = Buffer.from(usage(150).replace('"token_count"', '"token_count","ignored":"\u4e2d\u6587"'));
  const split = next.indexOf(Buffer.from("\u4e2d")) + 1;
  fs.appendFileSync(row.rollout_path, next.subarray(0, split));
  assert.equal(c.read([row], { now: NOW }).tokens7d, 100);
  fs.appendFileSync(row.rollout_path, next.subarray(split));
  const r = c.read([row], { now: NOW });
  assert.equal(r.tokens7d, 150);
  assert.equal(r.status, "ready");
});

test("rescans truncated rollouts and drops obsolete contributions", t => {
  const row = fixture(t)("a", usage(100) + usage(150));
  const c = collector();
  assert.equal(c.read([row], { now: NOW }).tokens7d, 150);
  fs.writeFileSync(row.rollout_path, usage(70));
  assert.equal(c.read([row], { now: NOW }).tokens7d, 70);
});

test("rejects unsafe counters and marks malformed records or ambiguous resets partial", t => {
  const row = fixture(t)("a", usage(100) + "{broken JSON\n" +
    usage(120, undefined, { input_tokens: -1 }) + usage(120, undefined, { total_tokens: 1.5 }) +
    usage(120, undefined, { cached_input_tokens: Number.MAX_SAFE_INTEGER + 1 }) +
    usage(50) + usage(150));
  const r = collector().read([row], { now: NOW });
  assert.equal(r.tokens7d, 150);
  assert.equal(r.status, "partial");
  assert.equal(r.unreadableFiles, 0);
});

test("ignores dialogue and handles empty selections with the requested timezone", t => {
  const row = fixture(t)("a", JSON.stringify({ type: "response_item", payload: {
    type: "message", content: [{ text: "SECRET token_count total_token_usage" }] } }) + "\n");
  const r = collector().read([row], { now: NOW });
  assert.equal(r.tokens7d, 0);
  assert.equal(r.status, "ready");
  assert.equal(r.timeZone, "Asia/Shanghai");
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test("shares one byte budget between files rather than a budget per file", t => {
  const file = fixture(t);
  const a = file("a", usage(100));
  const b = file("b", usage(70, "2026-10-09T03:01:00Z"));
  const c = collector({ maxBytesPerRead: fs.statSync(a.rollout_path).size });
  const first = c.read([a, b], { now: NOW });
  assert.equal(first.tokens7d, 100);
  assert.equal(first.status, "loading");
  assert.equal(settle(c, [a, b]).tokens7d, 170);
});

test("refresh interval throttles append scanning but not calendar rollover", t => {
  const row = fixture(t)("a", usage(100));
  const c = collector({ scanIntervalMs: 5000 });
  assert.equal(c.read([row], { now: NOW }).tokens7d, 100);
  fs.appendFileSync(row.rollout_path, usage(150));
  const cached = c.read([row], { now: NOW + 4999 });
  assert.equal(cached.tokens7d, 100);
  assert.equal(cached.updatedAt, new Date(NOW).toISOString());
  assert.equal(c.read([row], { now: NOW + 5000 }).tokens7d, 150);
});

test("accepts valid usage envelopes regardless of JSON property order", t => {
  const event = JSON.parse(usage(100));
  const reordered = JSON.stringify({ payload: event.payload, timestamp: event.timestamp, type: event.type });
  const row = fixture(t)("a", reordered + "\n");
  const r = collector().read([row], { now: NOW });
  assert.equal(r.tokens7d, 100);
  assert.equal(r.status, "ready");
});

test("a valid final record without a newline is counted once across appends", t => {
  const row = fixture(t)("a", usage(100).trimEnd());
  const c = collector();
  const first = c.read([row], { now: NOW });
  assert.equal(first.tokens7d, 100);
  assert.equal(first.status, "ready");
  fs.appendFileSync(row.rollout_path, "\n" + usage(150));
  assert.equal(c.read([row], { now: NOW }).tokens7d, 150);
});

test("out-of-order cumulative increases stay conservative and explicit", t => {
  const row = fixture(t)("a", usage(100, "2026-10-09T03:00:00Z") +
    usage(150, "2026-10-08T15:00:00Z"));
  const r = collector().read([row], { now: NOW });
  assert.equal(r.tokens7d, 150);
  assert.equal(r.status, "partial");
});

test("detects a truncated log even when it regrows beyond the cached offset", t => {
  const row = fixture(t)("a", usage(100) + usage(150));
  const c = collector({ maxBytesPerRead: 31 });
  assert.equal(settle(c, [row]).tokens7d, 150);
  fs.writeFileSync(row.rollout_path, usage(50) + usage(70) + usage(100));
  const r = settle(c, [row]);
  assert.equal(r.tokens7d, 100);
  assert.equal(r.status, "ready");
});

test("missing log recovery and fresh selections bypass stale scan caches", t => {
  const file = fixture(t);
  const row = file("a", usage(100));
  fs.unlinkSync(row.rollout_path);
  const c = collector({ scanIntervalMs: 5000 });
  assert.equal(c.read([row], { now: NOW }).unreadableFiles, 1);
  fs.writeFileSync(row.rollout_path, usage(100));
  assert.equal(c.read([row], { now: NOW + 5000 }).status, "ready");
  const other = file("b", usage(70, "2026-10-09T03:01:00Z"));
  assert.equal(c.read([row, other], { now: NOW + 5001 }).tokens7d, 170);
});

test("uses timezone calendar dates across daylight saving boundaries", t => {
  const row = fixture(t)("a", usage(100, "2026-11-01T03:59:59Z") +
    usage(150, "2026-11-01T04:00:00Z") + usage(200, "2026-11-01T06:30:00Z"));
  const r = collector({ timeZone: "America/New_York" }).read([row], {
    now: Date.parse("2026-11-01T17:00:00Z"),
  });
  assert.equal(r.tokensToday, 100);
  assert.equal(r.tokens24h, 200);
  assert.equal(r.days[5].date, "2026-10-31");
  assert.equal(r.days[6].date, "2026-11-01");
});

test("large lines stay byte bounded and do not prevent subsequent token events", t => {
  const row = fixture(t)("a", " ".repeat(1024 * 1024 + 1) + "\n" + usage(100));
  const c = collector({ maxBytesPerRead: 8192 });
  assert.equal(c.read([row], { now: NOW }).status, "loading");
  const result = settle(c, [row]);
  assert.equal(result.tokens7d, 100);
  assert.equal(result.status, "partial");
});

test("checkpoint verification and append scans obey the global byte budget", t => {
  const row = fixture(t)("a", usage(100));
  const c = collector({ maxBytesPerRead: 43 });
  settle(c, [row]);
  fs.appendFileSync(row.rollout_path, usage(150));
  const original = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args) => {
    const result = original(...args);
    bytes += result;
    return result;
  });
  let result;
  for (let i = 0; i < 50; i++) {
    bytes = 0;
    result = c.read([row], { now: NOW });
    assert.ok(bytes <= 43, "all actual filesystem reads share the same budget");
    if (result.status !== "loading") break;
  }
  assert.equal(result.tokens7d, 150);
  assert.equal(result.status, "ready");
});

test("directories are unreadable logs and numeric-only output remains sanitized", t => {
  const row = fixture(t)("a", usage(100));
  const r = collector().read([{ rollout_path: path.dirname(row.rollout_path) }], { now: NOW });
  assert.equal(r.status, "partial");
  assert.equal(r.unreadableFiles, 1);
  assert.doesNotMatch(JSON.stringify(r), /usage-|rollout_path/);
});

test("expired cached observations do not leak into a later seven-day window", t => {
  const row = fixture(t)("a", usage(100));
  const c = collector();
  assert.equal(c.read([row], { now: NOW }).tokens7d, 100);
  const r = c.read([row], { now: NOW + 10 * 86400000 });
  assert.equal(r.tokens7d, 0);
  assert.equal(r.tokens24h, 0);
  assert.equal(r.days[6].date, "2026-10-19");
  fs.appendFileSync(row.rollout_path, usage(150, "2026-10-19T03:00:00Z"));
  assert.equal(c.read([row], { now: NOW + 10 * 86400000 }).tokens7d, 50);
});

test("a split JSON record ending at an inner brace is temporarily partial only", t => {
  const row = fixture(t)("a", usage(100));
  const c = collector();
  c.read([row], { now: NOW });
  const next = usage(150);
  const split = next.indexOf("},\"last_token_usage\"") + 1;
  fs.appendFileSync(row.rollout_path, next.slice(0, split));
  const partial = c.read([row], { now: NOW });
  assert.equal(partial.tokens7d, 100);
  assert.equal(partial.status, "partial");
  fs.appendFileSync(row.rollout_path, next.slice(split));
  const complete = c.read([row], { now: NOW });
  assert.equal(complete.tokens7d, 150);
  assert.equal(complete.status, "ready");
});
