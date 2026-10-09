const assert = require("node:assert/strict");
const test = require("node:test");
const { createAlertTracker } = require("../public/status-alerts");
const now = Date.now();
function status(overrides = {}) {
  return { state: "processing", updatedAt: now, sessions: [], history: [], ...overrides };
}

test("alerts only follow fresh live transitions, never startup or cached history", () => {
  const tracker = createAlertTracker();
  assert.deepEqual(tracker.consume(status({ history: [{ state: "completed", title: "Old", finishedAt: now - 1000 }] })), []);
  const next = status({ updatedAt: now + 2000, history: [{ state: "completed", title: "New", finishedAt: now + 1000, startedAt: now - 10000 }] });
  assert.deepEqual(tracker.consume(next).map(e => [e.kind, e.title]), [["completed", "New"]]);
  assert.deepEqual(tracker.consume(next), []);
  next.history[0].title = "Renamed";
  assert.deepEqual(tracker.consume(next), []);
  tracker.reset();
  assert.deepEqual(tracker.consume(status({ updatedAt: now + 3000, history: next.history })), []);
});

test("waiting and error notifications do not repeat on polling or rename", () => {
  const tracker = createAlertTracker();
  tracker.consume(status());
  const waiting = status({ state: "waiting", updatedAt: now + 1000,
    sessions: [{ title: "Need input", state: "waiting", lastStartedAt: now - 1000, waitingSince: now + 100 }] });
  assert.equal(tracker.consume(waiting)[0].kind, "waiting");
  waiting.sessions[0].title = "Current title";
  waiting.updatedAt += 500;
  assert.deepEqual(tracker.consume(waiting), []);
  const failed = status({ state: "error", error: "Unable to read status", updatedAt: now + 3000 });
  assert.equal(tracker.consume(failed)[0].kind, "error");
  assert.deepEqual(tracker.consume({ ...failed, updatedAt: now + 4000 }), []);
  assert.deepEqual(tracker.consume(status({ state: "disconnected", updatedAt: now + 5000 })), []);
});

test("one task can complete while another still runs and cancelled tasks are silent", () => {
  const tracker = createAlertTracker();
  tracker.consume(status());
  const events = tracker.consume(status({ updatedAt: now + 4000, history: [
    { title: "Done", state: "completed", finishedAt: now + 1000, startedAt: now - 2000 },
    { title: "Failed", state: "error", finishedAt: now + 2000, startedAt: now - 3000 },
    { title: "Interrupted", state: "cancelled", finishedAt: now + 3000 },
  ] }));
  assert.deepEqual(events.map(e => e.kind), ["completed", "error"]);
});

test("older snapshots cannot roll back the error baseline or consume future events", () => {
  const tracker = createAlertTracker();
  tracker.consume(status());
  assert.equal(tracker.consume(status({ state: "error", updatedAt: now + 3000 }))[0].kind, "error");
  assert.deepEqual(tracker.consume(status({ updatedAt: now + 1000 })), []);
  assert.deepEqual(tracker.consume(status({ state: "error", updatedAt: now + 4000 })), []);
});

test("opaque identities keep simultaneous waits and completions separate through renames", () => {
  const tracker = createAlertTracker();
  tracker.consume(status());
  const waiting = status({ updatedAt: now + 1000, sessions: ["a", "b"].map(sessionKey => ({
    sessionKey, title: "Same title", state: "waiting", waitingSince: now + 100, lastStartedAt: now,
  })) });
  assert.equal(tracker.consume(waiting).length, 2);
  assert.deepEqual(tracker.consume({ ...waiting, updatedAt: now + 2000,
    sessions: waiting.sessions.map(s => ({ ...s, title: "New title" })) }), []);
  assert.equal(tracker.consume(status({ updatedAt: now + 4000,
    history: ["a", "b"].map(sessionKey => ({ sessionKey, title: "Same title", state: "completed",
      finishedAt: now + 3000, startedAt: now })) })).length, 2);
});
