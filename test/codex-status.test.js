const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applySubscriptionRenewalDate,
  buildCodexStatus,
  collectRolloutStates,
  readCodexStatus,
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

function event(type, timestamp, payload = {}, envelope = "event_msg") {
  return JSON.stringify({ type: envelope, timestamp, payload: { type, ...payload } }) + "\n";
}

test("waiting persists beyond five minutes until matching input arrives", t => {
  const { file, thread } = rolloutFixture(t);
  const started = new Date(Date.now() - 10 * 60000).toISOString();
  fs.appendFileSync(file, event("task_started", started, { turn_id: "turn-a" }));
  fs.appendFileSync(file, event("function_call", started, {
    name: "functions.request_user_input", call_id: "input-a",
  }, "response_item"));
  assert.equal(updateRolloutState(thread).waiting, true);
  fs.appendFileSync(file, event("function_call_output", new Date().toISOString(), {
    call_id: "other-input",
  }, "response_item"));
  assert.equal(updateRolloutState(thread).waiting, true);
  fs.appendFileSync(file, event("function_call_output", new Date().toISOString(), {
    call_id: "input-a",
  }, "response_item"));
  assert.equal(updateRolloutState(thread).waiting, false);
});

test("async input questions do not suspend actual processing", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp));
  fs.appendFileSync(file, event("function_call", timestamp, {
    name: "request_user_input_async", call_id: "async-input",
  }, "response_item"));
  assert.equal(updateRolloutState(thread).active, true);
  assert.equal(updateRolloutState(thread).waiting, false);
});

test("approval waits end only when their matching operation resumes", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp));
  fs.appendFileSync(file, event("exec_approval_request", timestamp, { call_id: "exec-a" }));
  assert.equal(updateRolloutState(thread).waiting, true);
  fs.appendFileSync(file, event("exec_command_begin", timestamp, { call_id: "exec-other" }));
  assert.equal(updateRolloutState(thread).waiting, true);
  fs.appendFileSync(file, event("exec_command_begin", timestamp, { call_id: "exec-a" }));
  assert.equal(updateRolloutState(thread).waiting, false);
});

test("cancelled turns stop processing and remain in history without private data", t => {
  const { file, thread } = rolloutFixture(t);
  const started = Date.now() - 10000;
  fs.appendFileSync(file, event("task_started", new Date(started).toISOString(), { turn_id: "private-turn" }));
  fs.appendFileSync(file, event("turn_aborted", new Date(started + 9000).toISOString(), {
    turn_id: "private-turn", reason: "interrupted", message: "private conversation",
  }));
  const state = updateRolloutState(thread);
  assert.equal(state.active, false);
  const status = buildCodexStatus(true, [state], 1);
  assert.equal(status.state, "cancelled");
  assert.equal(status.light, "green");
  assert.equal(status.history[0].state, "cancelled");
  assert.equal(status.history[0].durationMs, 9000);
  assert.doesNotMatch(JSON.stringify(status), /private-turn|private conversation|rollout\.jsonl/);
});

test("terminal errors are red while recoverable stream and tool errors are not", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp, { turn_id: "error-turn" }));
  fs.appendFileSync(file, event("stream_error", timestamp, { message: "Retrying" }));
  fs.appendFileSync(file, event("function_call_output", timestamp, {
    call_id: "tool-a", output: "Error: command failed",
  }, "response_item"));
  assert.equal(updateRolloutState(thread).active, true);
  fs.appendFileSync(file, event("error", timestamp, { message: "SECRET C:\\private\\log" }));
  fs.appendFileSync(file, event("task_complete", timestamp, { turn_id: "error-turn" }));
  const status = buildCodexStatus(true, [updateRolloutState(thread)], 1);
  assert.equal(status.state, "error");
  assert.equal(status.light, "red");
  assert.deepEqual(status.history.map(h => h.state), ["error"]);
  assert.doesNotMatch(JSON.stringify(status), /SECRET|private/);
});

test("a completion with terminal error is not reported as success", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp, { turn_id: "a" }));
  fs.appendFileSync(file, event("task_complete", timestamp, { turn_id: "a", error: { message: "Failed" } }));
  assert.equal(buildCodexStatus(true, [updateRolloutState(thread)], 1).state, "error");
});

test("late terminal events cannot finish a newer turn", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp, { turn_id: "new-turn" }));
  fs.appendFileSync(file, event("task_complete", timestamp, { turn_id: "old-turn" }));
  assert.equal(updateRolloutState(thread).active, true);
});

test("history survives rereading logs, stays bounded, and uses current titles", t => {
  const { file, thread } = rolloutFixture(t);
  const now = Date.now();
  for (let i = 0; i < 25; i++) {
    fs.appendFileSync(file, event("task_started", new Date(now - (26 - i) * 1000).toISOString(), { turn_id: String(i) }));
    fs.appendFileSync(file, event("task_complete", new Date(now - (25 - i) * 1000).toISOString(), { turn_id: String(i) }));
  }
  const result = buildCodexStatus(true, [updateRolloutState({ ...thread, title: "Renamed" })], 1, now + 11000);
  assert.equal(result.state, "idle");
  assert.equal(result.history.length, 20);
  assert.equal(result.history[0].title, "Renamed");
  assert.ok(result.history[0].finishedAt > result.history[19].finishedAt);
  const replay = path.join(path.dirname(file), "replay.jsonl");
  fs.copyFileSync(file, replay);
  assert.deepEqual(buildCodexStatus(true, [updateRolloutState({ rollout_path: replay, title: "Renamed" })], 1, now + 11000).history, result.history);
});

test("partial and complete log read failures are explicitly diagnosed", t => {
  const { thread } = rolloutFixture(t);
  assert.equal(typeof collectRolloutStates, "function");
  if (!collectRolloutStates) return;
  const rows = [thread, { title: "Missing", rollout_path: path.join(path.dirname(thread.rollout_path), "missing") }];
  const { threads, unreadableThreads } = collectRolloutStates(rows);
  assert.equal(unreadableThreads, 1);
  const result = buildCodexStatus(true, threads, 2, Date.now(), { unreadableThreads });
  assert.equal(result.state, "error");
  assert.equal(result.diagnostics.code, "rollout_unreadable");
  assert.doesNotMatch(JSON.stringify(result), /missing|status-rollout-/);
});

test("concurrent input requests remain waiting until all are answered", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp));
  for (const call_id of ["a", "b"]) fs.appendFileSync(file, event("function_call", timestamp, { name: "request_user_input", call_id }, "response_item"));
  fs.appendFileSync(file, event("function_call_output", timestamp, { call_id: "a" }, "response_item"));
  assert.equal(updateRolloutState(thread).waiting, true);
  fs.appendFileSync(file, event("function_call_output", timestamp, { call_id: "b" }, "response_item"));
  assert.equal(updateRolloutState(thread).waiting, false);
});

test("duplicate lifecycle events do not restart completed turns or duplicate history", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  const started = event("task_started", timestamp, { turn_id: "a" });
  const completed = event("task_complete", timestamp, { turn_id: "a" });
  fs.appendFileSync(file, started + completed + completed + started);
  const status = updateRolloutState(thread);
  assert.equal(status.active, false);
  assert.equal(status.history.length, 1);
});

test("non-turn errors and old untagged completion do not stop current processing", t => {
  const { file, thread } = rolloutFixture(t);
  const now = Date.now();
  fs.appendFileSync(file, event("task_started", new Date(now).toISOString(), { turn_id: "a" }));
  fs.appendFileSync(file, event("error", new Date(now).toISOString(), { codex_error_info: "thread_rollback_failed" }));
  fs.appendFileSync(file, event("task_complete", new Date(now - 1000).toISOString()));
  assert.equal(updateRolloutState(thread).active, true);
});

test("missing or stale tasks cannot masquerade as a confident idle state", () => {
  const now = Date.now();
  const result = buildCodexStatus(true, [{ title: "Stale", stale: true, active: false, waiting: false }], 1, now);
  assert.equal(result.state, "syncing");
  assert.equal(result.diagnostics.code, "task_stale");
  const allMissing = buildCodexStatus(true, [], 3, now, { unreadableThreads: 3 });
  assert.equal(allMissing.state, "error");
  const processing = buildCodexStatus(true, [{ title: "Working", active: true, lastStartedAt: now }], 2, now, { unreadableThreads: 1 });
  assert.equal(processing.state, "processing");
  assert.equal(processing.diagnostics.state, "degraded");
});

test("a replayed old start cannot replace the latest turn or lose its completion", t => {
  const { file, thread } = rolloutFixture(t);
  const now = Date.now();
  const oldStart = event("task_started", new Date(now - 4000).toISOString(), { turn_id: "old" });
  fs.appendFileSync(file, oldStart + event("task_complete", new Date(now - 3000).toISOString(), { turn_id: "old" }) +
    event("task_started", new Date(now - 2000).toISOString(), { turn_id: "new" }) + oldStart +
    event("task_complete", new Date(now - 1000).toISOString(), { turn_id: "new" }));
  const result = updateRolloutState(thread);
  assert.equal(result.active, false);
  assert.equal(result.history.length, 2);
});

test("duplicate answered input requests do not reopen a wait", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  const request = event("function_call", timestamp, { name: "request_user_input", call_id: "q" }, "response_item");
  fs.appendFileSync(file, event("task_started", timestamp) + request +
    event("function_call_output", timestamp, { call_id: "q" }, "response_item") + request);
  assert.equal(updateRolloutState(thread).waiting, false);
});

test("input in a truncated log tail is waiting even when its start is outside the read window", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp));
  fs.appendFileSync(file, " ".repeat(32 * 1024 * 1024) + "\n");
  fs.appendFileSync(file, event("function_call", timestamp, { name: "request_user_input", call_id: "q" }, "response_item"));
  const result = updateRolloutState(thread);
  assert.equal(result.waiting, true);
  assert.equal(buildCodexStatus(true, [result], 1).state, "waiting");
});

test("an answered request without a visible start remains uncertain, not confidently idle", t => {
  const { file, thread } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("function_call", timestamp, { name: "request_user_input", call_id: "q" }, "response_item") +
    event("function_call_output", timestamp, { call_id: "q" }, "response_item"));
  assert.equal(buildCodexStatus(true, [updateRolloutState(thread)], 1).state, "syncing");
});

test("offline collector continues reconstructing history from persisted logs", t => {
  const { thread, file } = rolloutFixture(t);
  const timestamp = new Date().toISOString();
  fs.appendFileSync(file, event("task_started", timestamp) + event("task_complete", timestamp));
  const result = readCodexStatus({ running: false, threadRows: [thread], tokenStats: null, planInfo: null });
  assert.equal(result.state, "offline");
  assert.equal(result.history.length, 1);
  assert.equal(result.sessionCount, 0);
});
