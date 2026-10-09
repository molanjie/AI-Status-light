const assert = require("node:assert/strict");
const test = require("node:test");
const { parseEventLine, updateRolloutState, buildCodexStatus } = require("../codex-status");

function event(state, type, payload, at) {
  parseEventLine(JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload }), state);
}

test("real tool actions are sanitized, paired and cleared on completion", () => {
  const now = Date.now();
  const state = {};
  event(state, "event_msg", { type: "task_started", turn_id: "turn-a" }, now - 4000);
  event(state, "response_item", { type: "function_call", name: "functions.exec_command", call_id: "read",
    arguments: JSON.stringify({ cmd: "Get-Content C:/private/secrets.txt" }) }, now - 3000);
  const { getCurrentAction } = require("../codex-activity");
  assert.deepEqual(getCurrentAction(state), { kind: "read", label: "读取文件", startedAt: now - 3000 });
  event(state, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "edit",
    input: "*** private patch content ***" }, now - 2000);
  assert.equal(getCurrentAction(state).kind, "write");
  event(state, "response_item", { type: "function_call_output", call_id: "read" }, now - 1000);
  assert.equal(getCurrentAction(state).kind, "write");
  event(state, "response_item", { type: "custom_tool_call_output", call_id: "edit" }, now);
  assert.equal(getCurrentAction(state).kind, "processing");
  event(state, "response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "edit" }, now + 10);
  assert.equal(getCurrentAction(state).kind, "processing", "a replayed completed tool must not become active again");
  event(state, "event_msg", { type: "task_complete", turn_id: "turn-a" }, now + 1000);
  assert.equal(getCurrentAction(state), null);
});

test("waiting actions override tools, and stale outputs cannot clear a new turn", () => {
  const now = Date.now();
  const state = {};
  event(state, "event_msg", { type: "task_started", turn_id: "a" }, now - 6000);
  event(state, "response_item", { type: "function_call", name: "exec_command", call_id: "a-tool" }, now - 5000);
  event(state, "event_msg", { type: "exec_approval_request", call_id: "approval", command: "private" }, now - 4000);
  const { getCurrentAction } = require("../codex-activity");
  assert.equal(getCurrentAction(state).label, "等待确认");
  event(state, "event_msg", { type: "task_complete", turn_id: "a" }, now - 3000);
  event(state, "event_msg", { type: "task_started", turn_id: "b" }, now - 2000);
  event(state, "response_item", { type: "function_call", name: "web.run", call_id: "b-tool" }, now - 1000);
  event(state, "response_item", { type: "function_call_output", call_id: "a-tool" }, now);
  assert.equal(getCurrentAction(state).kind, "search");
  event(state, "event_msg", { type: "task_started", turn_id: "b" }, now + 1);
  assert.equal(getCurrentAction(state).kind, "search");
  const result = buildCodexStatus(true, [{ title: "Current", active: true, waiting: false,
    lastStartedAt: now - 2000, updatedAt: now, currentAction: getCurrentAction(state), model: "gpt-5.5" }], 1, now);
  assert.equal(result.sessions[0].currentAction.kind, "search");
  assert.equal(result.sessions[0].model, "gpt-5.5");
  assert.doesNotMatch(JSON.stringify(result.sessions), /private|arguments|call_id|path/);
});

test("unknown tool names never expose arbitrary caller text", () => {
  const now = Date.now(), state = {};
  event(state, "event_msg", { type: "task_started" }, now - 1);
  event(state, "response_item", { type: "custom_tool_call", call_id: "x", name: "C:/secret/account@example.com" }, now);
  const { getCurrentAction } = require("../codex-activity");
  assert.deepEqual(getCurrentAction(state), { kind: "tool", label: "调用工具", startedAt: now });
});

test("public identities survive renaming without revealing source thread IDs", t => {
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "codex-action-key-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const now = Date.now();
  const file = path.join(folder, "activity.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "event_msg", timestamp: new Date(now - 1000).toISOString(),
    payload: { type: "task_started", turn_id: "private-turn" } }) + "\n");
  const first = updateRolloutState({ id: "private-thread-a", title: "First title", rollout_path: file });
  const renamed = updateRolloutState({ id: "private-thread-a", title: "Renamed", rollout_path: file });
  const other = updateRolloutState({ id: "private-thread-b", title: "Renamed", rollout_path: file });
  assert.match(first.sessionKey, /^[a-f0-9]{32}$/);
  assert.equal(first.sessionKey, renamed.sessionKey);
  assert.notEqual(first.sessionKey, other.sessionKey);
  const result = buildCodexStatus(true, [renamed, other], 2, now);
  assert.doesNotMatch(JSON.stringify(result), /private-thread|private-turn|activity\.jsonl/);
});
