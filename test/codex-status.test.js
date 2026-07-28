const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizePlanInfo } = require("../codex-status");

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
