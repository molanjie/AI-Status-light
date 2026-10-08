const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applySubscriptionRenewalDate,
  buildCodexStatus,
  normalizePlanInfo,
  parseEventLine,
  updateRolloutState,
} = require("../codex-status");

test("does not report an expired Plus subscription from a pre-refresh expiry claim", () => {
  assert.equal(
    typeof normalizePlanInfo,
    "function",
    "plan normalizer must be exported for subscription metadata"
  );

  if (typeof normalizePlanInfo !== "function") return;

  const result = normalizePlanInfo(
    {
      last_refresh: "2026-07-25T14:19:41.472Z",
      tokens: {},
    },
    {
      email: "user@example.com",
      name: "Test User",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_subscription_active_start: "2026-06-12T03:30:45+00:00",
        chatgpt_subscription_active_until: "2026-07-12T03:30:45+00:00",
      },
    },
    null,
    Date.parse("2026-07-25T14:19:41.472Z")
  );

  assert.equal(result.activeUntil, null);
  assert.equal(result.subscriptionStatus, "renewal_pending");
  assert.equal(result.refreshedAt, "2026-07-25T14:19:41.472Z");
});

test("keeps a current subscription end date after the latest token refresh", () => {
  assert.equal(typeof normalizePlanInfo, "function");
  if (typeof normalizePlanInfo !== "function") return;

  const result = normalizePlanInfo(
    {
      last_refresh: "2026-07-25T14:19:41.472Z",
      tokens: {},
    },
    {
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_subscription_active_until: "2026-08-12T03:30:45+00:00",
      },
    },
    null,
    Date.parse("2026-07-25T14:19:41.472Z")
  );

  assert.equal(result.activeUntil, "2026-08-12T03:30:45+00:00");
  assert.equal(result.subscriptionStatus, "active");
});

test("uses the confirmed billing renewal date instead of stale token metadata", () => {
  assert.equal(typeof applySubscriptionRenewalDate, "function");
  if (typeof applySubscriptionRenewalDate !== "function") return;

  const result = applySubscriptionRenewalDate(
    {
      plan: "plus",
      activeUntil: null,
      subscriptionStatus: "renewal_pending",
    },
    "2026-08-12",
    Date.parse("2026-07-25T00:00:00Z")
  );

  assert.equal(result.activeUntil, null);
  assert.equal(result.renewalDate, "2026-08-12");
  assert.equal(result.renewalDateOnly, true);
  assert.equal(result.subscriptionStatus, "active");
  assert.equal(result.subscriptionSource, "billing");
});

test("does not let a stale billing date override a newer active token subscription", () => {
  const result = applySubscriptionRenewalDate(
    {
      plan: "plus",
      activeUntil: "2026-09-12T03:30:45+00:00",
      subscriptionStatus: "active",
    },
    "2026-08-12",
    Date.parse("2026-07-25T00:00:00Z")
  );

  assert.equal(result.activeUntil, "2026-09-12T03:30:45+00:00");
  assert.equal(result.renewalDate, undefined);
  assert.equal(result.subscriptionSource, undefined);
});

test("tracks request_user_input until its matching response arrives", () => {
  assert.equal(typeof parseEventLine, "function");
  if (typeof parseEventLine !== "function") return;

  const state = { active: true, waiting: false, waitingCallId: "", waitingAt: 0 };
  parseEventLine(JSON.stringify({
    timestamp: "2026-08-22T00:00:00Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: "call_waiting",
    },
  }), state);

  assert.equal(state.waiting, true);
  assert.equal(state.waitingCallId, "call_waiting");

  parseEventLine(JSON.stringify({
    timestamp: "2026-08-22T00:00:05Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_waiting",
    },
  }), state);

  assert.equal(state.waiting, false);
  assert.equal(state.waitingCallId, "");
});

test("explicit waiting input takes priority over an active task", () => {
  const now = Date.parse("2026-08-22T00:00:10Z");
  const result = buildCodexStatus(true, [{
    title: "Need confirmation",
    active: true,
    waiting: true,
    lastStartedAt: now - 10000,
    lastCompletedAt: 0,
    updatedAt: now,
  }], 1, now);

  assert.equal(result.state, "waiting");
  assert.equal(result.light, "yellow");
  assert.equal(result.label, "等待输入");
  assert.equal(result.sessions[0].state, "waiting");
});

test("keeps processing and waiting sessions together while real work is running", () => {
  const now = Date.now();
  const result = buildCodexStatus(true, [
    { title: "Needs input", active: true, waiting: true, lastStartedAt: now - 2000, lastCompletedAt: 0, updatedAt: now },
    { title: "Working", active: true, waiting: false, lastStartedAt: now - 1000, lastCompletedAt: 0, updatedAt: now - 1000 },
  ], 2, now);
  assert.equal(result.state, "processing");
  assert.equal(result.sessionCount, 2);
  assert.deepEqual(result.sessions.map(s => [s.title, s.state]), [
    ["Needs input", "waiting"], ["Working", "processing"],
  ]);
});

test("an expired token date waits for fresh subscription data even before token refresh", () => {
  const result = normalizePlanInfo({ last_refresh: "2026-09-01T00:00:00Z" }, {
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "plus",
      chatgpt_subscription_active_until: "2026-09-12T03:30:45Z",
    },
  }, null, Date.parse("2026-10-08T00:00:00Z"));
  assert.equal(result.activeUntil, null);
  assert.equal(result.subscriptionStatus, "renewal_pending");
});

test("a past manual billing date cannot turn pending renewal into active", () => {
  const plan = { plan: "plus", activeUntil: null, subscriptionStatus: "renewal_pending" };
  assert.deepEqual(applySubscriptionRenewalDate(plan, "2026-09-12", Date.parse("2026-10-08T00:00:00Z")), plan);
});

function rolloutFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "status-rollout-"));
  const file = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(file, "");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { file, thread: { rollout_path: file, title: "Test" } };
}

function taskEvent(type, timestamp = new Date().toISOString()) {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type } }) + "\n";
}

test("does not drop the first complete event appended after a previous poll", t => {
  assert.equal(typeof updateRolloutState, "function");
  if (!updateRolloutState) return;
  const { file, thread } = rolloutFixture(t);
  fs.appendFileSync(file, taskEvent("task_started"));
  assert.equal(updateRolloutState(thread).active, true);
  fs.appendFileSync(file, taskEvent("task_complete"));
  const result = updateRolloutState(thread);
  assert.equal(result.active, false);
  assert.ok(result.lastCompletedAt > 0);
});

test("preserves partial JSON and split UTF-8 characters across reads", t => {
  assert.equal(typeof updateRolloutState, "function");
  if (!updateRolloutState) return;
  const { file, thread } = rolloutFixture(t);
  const event = Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(),
    type: "event_msg", payload: { type: "task_started", turn_id: "中文" } }) + "\n");
  const splitAt = event.indexOf(Buffer.from("中文")) + 1;
  fs.appendFileSync(file, event.subarray(0, splitAt));
  assert.equal(updateRolloutState(thread).active, false);
  fs.appendFileSync(file, event.subarray(splitAt));
  assert.equal(updateRolloutState(thread).active, true);
  fs.appendFileSync(file, taskEvent("task_complete"));
  assert.equal(updateRolloutState(thread).active, false);
});
