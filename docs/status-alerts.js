(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexStatusAlerts = api;
})(typeof window === "object" ? window : globalThis, function () {
  function createAlertTracker() {
    let previous = null;
    const seen = new Set();
    function remember(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > 256) seen.delete(seen.values().next().value);
      return true;
    }
    function waitingKey(session) {
      return "waiting:" + (session.sessionKey || "legacy") + ":" + (session.waitingSince || session.lastStartedAt || session.title);
    }
    return {
      reset() { previous = null; seen.clear(); },
      consume(data) {
        if (["syncing", "disconnected", "offline"].includes(data.state)) return [];
        if (previous && data.updatedAt < previous.updatedAt) return [];
        const results = [];
        const fresh = previous && data.updatedAt >= previous.updatedAt;
        for (const result of data.history || []) {
          if (!["completed", "error"].includes(result.state)) continue;
          const key = result.state + ":" + (result.sessionKey || "legacy") + ":" + result.finishedAt + ":" + (result.startedAt || 0);
          if (remember(key) && fresh && result.finishedAt > previous.updatedAt &&
              result.finishedAt <= data.updatedAt && data.updatedAt - result.finishedAt < 30000) {
            results.push({ kind: result.state, title: result.title, eventAt: result.finishedAt });
          }
        }
        for (const session of data.sessions || []) {
          if (session.state !== "waiting") continue;
          if (remember(waitingKey(session)) && fresh) results.push({ kind: "waiting", title: session.title, eventAt: data.updatedAt });
        }
        if (fresh && data.state === "error" && previous.state !== "error" && !results.some(e => e.kind === "error")) {
          results.push({ kind: "error", title: "运行或状态读取异常", eventAt: data.updatedAt });
        }
        if (fresh && !Array.isArray(data.history) && data.lastCompletedAt > (previous.lastCompletedAt || 0) &&
            data.lastCompletedAt > previous.updatedAt && data.updatedAt - data.lastCompletedAt < 30000) {
          results.push({ kind: "completed", title: "任务已完成", eventAt: data.lastCompletedAt });
        }
        previous = { state: data.state, updatedAt: data.updatedAt, lastCompletedAt: data.lastCompletedAt };
        return results;
      },
    };
  }
  return { createAlertTracker };
});
