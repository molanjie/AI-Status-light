const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const CODEX_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const ACTIVE_STALE_MS = 30 * 60 * 1000;
const WAITING_WINDOW_MS = 5 * 60 * 1000;
const RECENT_THREAD_MS = 24 * 60 * 60 * 1000;
const MAX_INITIAL_READ = 32 * 1024 * 1024;
const DATABASE_CACHE_MS = 30 * 1000;
const PROCESS_CACHE_MS = 5 * 1000;
const STATUS_CACHE_MS = 500;
const rolloutCache = new Map();
let databaseCache = { path: "", expiresAt: 0 };
let processCache = { running: false, expiresAt: 0 };
let statusCache = { value: null, expiresAt: 0 };

function normalizeRolloutPath(filePath) {
  return filePath.startsWith("\\\\?\\") ? filePath.slice(4) : filePath;
}

function findLatestStateDatabase(now = Date.now()) {
  if (databaseCache.path && now < databaseCache.expiresAt && fs.existsSync(databaseCache.path)) {
    return databaseCache.path;
  }

  const candidates = fs.readdirSync(CODEX_HOME, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(CODEX_HOME, entry.name);
      return {
        filePath,
        version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)[1]),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    })
    .sort((a, b) => b.version - a.version || b.mtimeMs - a.mtimeMs);

  if (!candidates.length) throw new Error("未找到 Codex 状态数据库");
  databaseCache = { path: candidates[0].filePath, expiresAt: now + DATABASE_CACHE_MS };
  return databaseCache.path;
}

function getRecentThreads(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT id, title, rollout_path, recency_at_ms, updated_at_ms, tokens_used, model
      FROM threads
      WHERE archived = 0 AND MAX(recency_at_ms, updated_at_ms) >= ?
      ORDER BY MAX(recency_at_ms, updated_at_ms) DESC
      LIMIT 30
    `).all(Date.now() - RECENT_THREAD_MS);
  } finally {
    db.close();
  }
}

function getTokenStats(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const now = Date.now();
    const total = db.prepare(
      "SELECT COALESCE(SUM(tokens_used),0) as t FROM threads WHERE archived=0 AND tokens_used>0"
    ).get();
    const day = db.prepare(
      "SELECT COALESCE(SUM(tokens_used),0) as t FROM threads WHERE archived=0 AND tokens_used>0 AND updated_at_ms>=?"
    ).get(now - 86400000);
    const byModel = db.prepare(
      "SELECT model, SUM(tokens_used) as t FROM threads WHERE archived=0 AND tokens_used>0 GROUP BY model ORDER BY t DESC"
    ).all();

    // 5-hour rolling window
    const h5rows = db.prepare(
      "SELECT tokens_used, updated_at_ms FROM threads WHERE archived=0 AND tokens_used>0 AND updated_at_ms>=? ORDER BY updated_at_ms ASC"
    ).all(now - 5 * 3600000);
    let h5total = 0, h5oldest = Infinity;
    for (const r of h5rows) { h5total += r.tokens_used; if (r.updated_at_ms < h5oldest) h5oldest = r.updated_at_ms; }
    const h5recoverAt = h5rows.length > 0 ? h5oldest + 5 * 3600000 : null;

    // 7-day rolling window
    const w7rows = db.prepare(
      "SELECT tokens_used, updated_at_ms FROM threads WHERE archived=0 AND tokens_used>0 AND updated_at_ms>=? ORDER BY updated_at_ms ASC"
    ).all(now - 7 * 86400000);
    let w7total = 0, w7oldest = Infinity;
    for (const r of w7rows) { w7total += r.tokens_used; if (r.updated_at_ms < w7oldest) w7oldest = r.updated_at_ms; }
    const w7recoverAt = w7rows.length > 0 ? w7oldest + 7 * 86400000 : null;

    // Estimated limits for Plus plan (calibrated from Codex app display)
    // 5h limit: ~500M tokens (53% remaining at 242.8M used → 242.8/0.47 ≈ 516M)
    // 7d limit: ~400M tokens (0% remaining at 395.6M used → limit ≈ 396M)
    const H5_LIMIT = 500000000;
    const W7_LIMIT = 400000000;
    const h5pct = Math.max(0, Math.round((1 - h5total / H5_LIMIT) * 100));
    const w7pct = Math.max(0, Math.round((1 - w7total / W7_LIMIT) * 100));

    return {
      totalTokens: total.t,
      tokens24h: day.t,
      tokens5h: h5total,
      tokens7d: w7total,
      h5recoverAt,
      w7recoverAt,
      h5limit: H5_LIMIT,
      w7limit: W7_LIMIT,
      h5remaining: h5pct,
      w7remaining: w7pct,
      byModel: byModel.map((r) => ({ model: r.model || "unknown", tokens: r.t })),
    };
  } finally {
    db.close();
  }
}

function getPlanInfo() {
  try {
    const authPath = path.join(CODEX_HOME, "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const idToken = auth.tokens && auth.tokens.id_token;
    if (!idToken) return null;
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    const ai = payload["https://api.openai.com/auth"];
    if (!ai) return null;
    return {
      plan: ai.chatgpt_plan_type || "unknown",
      activeSince: ai.chatgpt_subscription_active_start || null,
      activeUntil: ai.chatgpt_subscription_active_until || null,
      email: payload.email || null,
      name: payload.name || null,
    };
  } catch {
    return null;
  }
}

function parseEventLine(line, state) {
  if (!line.includes('"task_started"') && !line.includes('"task_complete"')) return;

  try {
    const event = JSON.parse(line);
    const type = event.payload && event.payload.type;
    const eventTime = Date.parse(event.timestamp) || Date.now();

    if (type === "task_started") {
      state.active = true;
      state.turnId = event.payload.turn_id || "";
      state.lastStartedAt = eventTime;
    } else if (type === "task_complete") {
      state.active = false;
      state.turnId = "";
      state.lastCompletedAt = eventTime;
    }
  } catch {
    // A partially written final JSONL line will be picked up on the next poll.
  }
}

function updateRolloutState(thread) {
  const filePath = normalizeRolloutPath(thread.rollout_path);
  const stat = fs.statSync(filePath);
  let cached = rolloutCache.get(filePath);

  if (!cached || stat.size < cached.offset) {
    cached = {
      offset: Math.max(0, stat.size - MAX_INITIAL_READ),
      remainder: "",
      active: false,
      turnId: "",
      lastStartedAt: 0,
      lastCompletedAt: 0,
    };
  }

  if (stat.size > cached.offset) {
    const length = stat.size - cached.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, cached.offset);
    } finally {
      fs.closeSync(fd);
    }

    let text = cached.remainder + buffer.toString("utf8");
    if (cached.offset > 0 && !cached.remainder) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }

    const lines = text.split(/\r?\n/);
    cached.remainder = lines.pop() || "";
    for (const line of lines) parseEventLine(line, cached);
    cached.offset = stat.size;
  }

  rolloutCache.set(filePath, cached);
  return {
    title: normalizeTitle(thread.title),
    active: cached.active && Date.now() - Math.max(cached.lastStartedAt, stat.mtimeMs) < ACTIVE_STALE_MS,
    lastStartedAt: cached.lastStartedAt,
    lastCompletedAt: cached.lastCompletedAt,
    updatedAt: stat.mtimeMs,
  };
}

function normalizeTitle(title) {
  const normalized = String(title || "未命名会话")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/[*_`#>\[\]]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 160 ? normalized.slice(0, 157) + "..." : normalized;
}

function cleanupRolloutCache(threads) {
  const currentPaths = new Set(threads.map((thread) => normalizeRolloutPath(thread.rollout_path)));
  for (const filePath of rolloutCache.keys()) {
    if (!currentPaths.has(filePath) || !fs.existsSync(filePath)) rolloutCache.delete(filePath);
  }
}

function isCodexRunning(now = Date.now()) {
  if (now < processCache.expiresAt) return processCache.running;

  if (process.platform !== "win32") {
    const running = fs.existsSync(CODEX_HOME);
    processCache = { running, expiresAt: now + PROCESS_CACHE_MS };
    return running;
  }

  try {
    const output = execFileSync("tasklist", ["/FI", "IMAGENAME eq Codex.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    });
    const running = /Codex\.exe/i.test(output);
    processCache = { running, expiresAt: now + PROCESS_CACHE_MS };
    return running;
  } catch {
    const running = fs.existsSync(CODEX_HOME);
    processCache = { running, expiresAt: now + PROCESS_CACHE_MS };
    return running;
  }
}

function buildCodexStatus(running, threads, totalThreads, now = Date.now()) {
  const allCompletedAt = threads
    .map((t) => t.lastCompletedAt)
    .filter((t) => t > 0);
  const lastCompletedAt = allCompletedAt.length > 0 ? Math.max(...allCompletedAt) : null;

  if (!running) {
    return {
      source: "codex-local",
      state: "offline",
      light: "red",
      label: "Codex 未运行",
      sessionCount: 0,
      sessions: [],
      totalThreads,
      hostname: os.hostname(),
      lastCompletedAt,
      updatedAt: now,
      error: "",
    };
  }

  const activeSessions = threads.filter((thread) => thread.active);
  const waitingSessions = threads.filter((thread) =>
    !thread.active && thread.lastCompletedAt && now - thread.lastCompletedAt < WAITING_WINDOW_MS
  );

  const toPublicSession = (thread, state) => ({
    title: thread.title,
    state,
    lastStartedAt: thread.lastStartedAt,
    lastCompletedAt: thread.lastCompletedAt,
    updatedAt: Math.max(thread.lastStartedAt, thread.lastCompletedAt, thread.updatedAt),
  });

  if (activeSessions.length > 0) {
    const sessions = activeSessions
      .map((thread) => toPublicSession(thread, "processing"))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      source: "codex-local",
      state: "processing",
      light: "red",
      label: "正在处理",
      sessionCount: sessions.length,
      sessions,
      totalThreads,
      hostname: os.hostname(),
      lastCompletedAt,
      updatedAt: now,
      error: "",
    };
  }

  if (waitingSessions.length > 0) {
    const sessions = waitingSessions
      .map((thread) => toPublicSession(thread, "waiting"))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      source: "codex-local",
      state: "waiting",
      light: "yellow",
      label: "等待输入",
      sessionCount: sessions.length,
      sessions,
      totalThreads,
      hostname: os.hostname(),
      lastCompletedAt,
      updatedAt: now,
      error: "",
    };
  }

  return {
    source: "codex-local",
    state: "idle",
    light: "green",
    label: "空闲",
    sessionCount: 0,
    sessions: [],
    totalThreads,
    hostname: os.hostname(),
    lastCompletedAt,
    updatedAt: now,
    error: "",
  };
}

function readCodexStatus() {
  const now = Date.now();
  if (statusCache.value && now < statusCache.expiresAt) return statusCache.value;

  const running = isCodexRunning(now);
  const planInfo = getPlanInfo();
  if (!running) {
    const value = buildCodexStatus(false, [], 0, now);
    value.plan = planInfo;
    statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
    return value;
  }

  try {
    const dbPath = findLatestStateDatabase(now);
    const threadRows = getRecentThreads(dbPath);
    const tokenStats = getTokenStats(dbPath);
    cleanupRolloutCache(threadRows);
    const threads = threadRows.flatMap((thread) => {
      try {
        return [updateRolloutState(thread)];
      } catch {
        return [];
      }
    });
    const value = buildCodexStatus(true, threads, threadRows.length, now);
    value.tokenStats = tokenStats;
    value.plan = planInfo;
    statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
    return value;
  } catch (err) {
    const value = {
      source: "codex-local",
      state: "error",
      light: "yellow",
      label: "状态不可用",
      sessionCount: 0,
      sessions: [],
      totalThreads: 0,
      hostname: os.hostname(),
      lastCompletedAt: null,
      updatedAt: now,
      error: err.message,
      plan: planInfo,
    };
    statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
    return value;
  }
}

module.exports = { buildCodexStatus, findLatestStateDatabase, readCodexStatus };
