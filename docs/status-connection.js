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
    add(options.registryBase);
    add(options.storedBase);
    if (options.isFile) add("http://127.0.0.1:3456");
    return result;
  }

  function loadSnapshot(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(SNAPSHOT_KEY));
      if (!parsed || !parsed.data || !Number.isFinite(parsed.savedAt)) return null;
      return { data: parsed.data, savedAt: parsed.savedAt };
    } catch (error) {
      return null;
    }
  }

  function saveSnapshot(storage, data, savedAt) {
    if (!data || !Number.isFinite(savedAt)) return;
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

  return {
    SNAPSHOT_KEY,
    normalizeApiBase,
    parseRegistry,
    buildApiCandidates,
    loadSnapshot,
    saveSnapshot,
    createFailureTracker,
  };
});
