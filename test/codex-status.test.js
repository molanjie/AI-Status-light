const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applySubscriptionRenewalDate,
  buildCodexStatus,
  normalizePlanInfo,
  parseEventLine,
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
    }
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
    }
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
    "2026-08-12"
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
    "2026-08-12"
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
