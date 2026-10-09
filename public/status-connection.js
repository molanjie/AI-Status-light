(function attach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexStatusConnection = api;
})(typeof window === "object" ? window : globalThis, function createApi() {
  const SNAPSHOT_KEY = "codex_status_last_good_v1";

  function normalizeApiBase(value) {
    return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  }

  function parseRegistry(value) {
    if (!value || value.schemaVersion !== 1) return null;
    const apiBase = normalizeApiBase(value.apiBase);
    const publishedAt = value.publishedAt;
    try {
      const url = new URL(apiBase);
      const allowedHost =
        url.hostname.length > ".trycloudflare.com".length &&
        url.hostname.endsWith(".trycloudflare.com");
      if (url.protocol !== "https:" || !allowedHost || url.username || url.password) return null;
      if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) return null;
      return { apiBase, publishedAt };
    } catch (error) {
      return null;
    }
  }

  function buildApiCandidates(options = {}) {
    const result = [];
    function add(value) {
      const normalized = normalizeApiBase(value);
      if (normalized && !result.includes(normalized)) result.push(normalized);
    }
    add(options.explicitBase);
    try {
      const page = new URL(options.pageOrigin);
      if ((page.protocol === "http:" || page.protocol === "https:") &&
          ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname)) add(page.origin);
    } catch (error) {}
    add(options.registryBase);
    add(options.storedBase);
    if (options.isFile) add("http://127.0.0.1:3456");
    return result;
  }

  function loadSnapshot(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(SNAPSHOT_KEY));
      if (!parsed || !isValidStatus(parsed.data) || !Number.isFinite(parsed.savedAt)) return null;
      return { data: parsed.data, savedAt: parsed.savedAt };
    } catch (error) {
      return null;
    }
  }

  function saveSnapshot(storage, data, savedAt) {
    if (!isValidStatus(data) || !Number.isFinite(savedAt)) return;
    try {
      storage.setItem(SNAPSHOT_KEY, JSON.stringify({ data, savedAt }));
    } catch (error) {}
  }

  function createFailureTracker(limit) {
    let failures = 0;
    return {
      recordFailure() {
        failures += 1;
        return failures >= limit;
      },
      recordSuccess() {
        failures = 0;
      },
      count() {
        return failures;
      },
    };
  }

  function isValidStatus(data) {
    function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
    function optionalStrings(value, fields) {
      return fields.every(field => value[field] == null || typeof value[field] === "string");
    }
    function optionalNumbers(value, fields) {
      return fields.every(field => value[field] == null || (Number.isFinite(value[field]) && value[field] >= 0));
    }
    function validSessionKey(value) { return value == null || (typeof value === "string" && /^[a-f0-9]{32}$/.test(value)); }
    const states = ["idle", "processing", "waiting", "completed", "cancelled", "syncing", "disconnected", "offline", "error"];
    if (!data || !states.includes(data.state) || !["red", "yellow", "green"].includes(data.light)) return false;
    if (typeof data.label !== "string" || !Number.isInteger(data.sessionCount) || data.sessionCount < 0) return false;
    if (!Number.isFinite(data.updatedAt) || data.updatedAt <= 0 || !Array.isArray(data.sessions)) return false;
    if (!data.sessions.every(session => object(session) && typeof session.title === "string" && states.includes(session.state) &&
      optionalNumbers(session, ["updatedAt", "lastStartedAt", "lastCompletedAt", "lastFinishedAt", "waitingSince"]) &&
      optionalStrings(session, ["model"]) && validSessionKey(session.sessionKey) && (session.currentAction == null || (object(session.currentAction) &&
        ["read", "write", "command", "search", "tool", "processing", "input", "approval"].includes(session.currentAction.kind) &&
        typeof session.currentAction.label === "string" && optionalNumbers(session.currentAction, ["startedAt"]))))) return false;
    if (!optionalStrings(data, ["error", "hostname", "source"])) return false;
    if (data.tokenStats != null) {
      const stats = data.tokenStats;
      if (!object(stats) || !optionalNumbers(stats, ["tokens24h", "totalTokens", "h5remaining", "w7remaining", "tokens5h", "tokens7d", "h5limit", "w7limit", "h5recoverAt", "w7recoverAt"])) return false;
      if (stats.byModel !== undefined && (!Array.isArray(stats.byModel) || !stats.byModel.every(model =>
        object(model) && typeof model.model === "string" && Number.isFinite(model.tokens) && model.tokens >= 0
      ))) return false;
      if (stats.trend != null) {
        const trend = stats.trend;
        const fields = ["tokensToday", "tokens7d", "tokens24h", "inputTokens", "outputTokens", "cachedInputTokens", "unreadableFiles", "updatedAt"];
        if (!object(trend) || !["ready", "loading", "partial"].includes(trend.status) ||
            typeof trend.timeZone !== "string" || !fields.every(field => Number.isFinite(trend[field]) && trend[field] >= 0) ||
            !Array.isArray(trend.days) || trend.days.length !== 7 || !trend.days.every(day => object(day) &&
              /^\d{4}-\d{2}-\d{2}$/.test(day.date || "") && ["tokens", "inputTokens", "outputTokens", "cachedInputTokens"].every(
                field => Number.isFinite(day[field]) && day[field] >= 0))) return false;
      }
    }
    if (data.plan != null && (!object(data.plan) || !optionalStrings(data.plan,
      ["plan", "name", "email", "activeUntil", "activeSince", "renewalDate", "refreshedAt", "subscriptionStatus", "subscriptionSource"]))) return false;
    if (data.diagnostics != null && (!object(data.diagnostics) || !optionalStrings(data.diagnostics, ["code", "state"]) ||
      !optionalNumbers(data.diagnostics, ["readableThreads", "unreadableThreads", "staleTasks"]))) return false;
    if (data.history !== undefined && (!Array.isArray(data.history) || !data.history.every(result =>
      result && typeof result.title === "string" && validSessionKey(result.sessionKey) && ["completed", "cancelled", "error"].includes(result.state) &&
      Number.isFinite(result.finishedAt) && result.finishedAt > 0 &&
      (result.durationMs == null || (Number.isFinite(result.durationMs) && result.durationMs >= 0))
    ))) return false;
    return true;
  }

  return {
    SNAPSHOT_KEY,
    normalizeApiBase,
    parseRegistry,
    buildApiCandidates,
    loadSnapshot,
    saveSnapshot,
    createFailureTracker,
    isValidStatus,
  };
});
