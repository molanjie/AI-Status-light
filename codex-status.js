const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { StringDecoder } = require("node:string_decoder");
const { createHmac, randomBytes } = require("node:crypto");
const { clearActivity, trackActivity, getCurrentAction } = require("./codex-activity");
const { createUsageCollector } = require("./token-usage");

const CODEX_HOME = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
const ACTIVE_STALE_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 20;
const COMPLETED_WINDOW_MS = 10 * 1000;
const RECENT_THREAD_MS = 24 * 60 * 60 * 1000;
const MAX_INITIAL_READ = 32 * 1024 * 1024;
const DATABASE_CACHE_MS = 30 * 1000;
const PROCESS_CACHE_MS = 5 * 1000;
const STATUS_CACHE_MS = 500;
const rolloutCache = new Map();
const sessionKeySalt = randomBytes(32);
let databaseCache = { path: "", expiresAt: 0 };
let processCache = { running: false, expiresAt: 0 };
let statusCache = { value: null, expiresAt: 0 };
let tokenCache = { path: "", value: null, rows: [], expiresAt: 0 };
let usageCollector = createUsageCollector();

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
    `).all(Date.now() - RECENT_THREAD_MS);
  } finally {
    db.close();
  }
}

function getTokenStats(databasePath, now = Date.now()) {
  if (tokenCache.path === databasePath && tokenCache.value && now < tokenCache.expiresAt &&
      tokenCache.value.trend && tokenCache.value.trend.status !== "loading") return tokenCache.value;
  if (tokenCache.path !== databasePath) {
    usageCollector = createUsageCollector();
    tokenCache = { path: databasePath, value: null, rows: [], expiresAt: 0 };
  }
  if (!tokenCache.value || now >= tokenCache.expiresAt) {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const total = db.prepare(
        "SELECT COALESCE(SUM(tokens_used),0) as t FROM threads WHERE archived=0 AND tokens_used>0"
      ).get();
      const byModel = db.prepare(
        "SELECT model, SUM(tokens_used) as t FROM threads WHERE archived=0 AND tokens_used>0 GROUP BY model ORDER BY t DESC"
      ).all();
      // Archived tasks also consumed tokens; filtering them would erase usage.
      tokenCache.rows = db.prepare(
        "SELECT rollout_path FROM threads WHERE MAX(updated_at_ms,recency_at_ms)>=?"
      ).all(now - 8 * 86400000);
      tokenCache.value = { totalTokens: total.t,
        byModel: byModel.map(row => ({ model: row.model || "unknown", tokens: row.t })) };
      tokenCache.expiresAt = now + 5000;
    } finally { db.close(); }
  }
  const trend = usageCollector.read(tokenCache.rows, { now });
  tokenCache.value = { ...tokenCache.value, tokens24h: trend.tokens24h,
    trend: { ...trend, updatedAt: Date.parse(trend.updatedAt) || now } };
  return tokenCache.value;
}

function normalizePlanInfo(auth, payload, fallbackRefreshedAt = null, now = Date.now()) {
  const ai = payload["https://api.openai.com/auth"];
  if (!ai) return null;

  const plan = ai.chatgpt_plan_type || "unknown";
  const activeUntil = Number.isFinite(Date.parse(ai.chatgpt_subscription_active_until))
    ? ai.chatgpt_subscription_active_until : null;
  const refreshedAt = auth.last_refresh || fallbackRefreshedAt || null;
  const activeUntilMs = activeUntil ? Date.parse(activeUntil) : NaN;
  const refreshedAtMs = refreshedAt ? Date.parse(refreshedAt) : NaN;
  const renewalPending = plan === "plus" && Number.isFinite(activeUntilMs) &&
    (activeUntilMs <= now || (Number.isFinite(refreshedAtMs) && activeUntilMs < refreshedAtMs));

  return {
    plan,
    activeSince: ai.chatgpt_subscription_active_start || null,
    activeUntil: renewalPending ? null : activeUntil,
    subscriptionStatus: renewalPending ? "renewal_pending" : activeUntil ? "active" : "unknown",
    refreshedAt,
    email: payload.email || null,
    name: payload.name || null,
  };
}

function applySubscriptionRenewalDate(planInfo, renewalDate, now = Date.now()) {
  if (!planInfo || planInfo.plan !== "plus") return planInfo;

  const normalizedDate = String(renewalDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return planInfo;

  const parsedAt = Date.parse(normalizedDate + "T00:00:00Z");
  if (!Number.isFinite(parsedAt) || new Date(parsedAt).toISOString().slice(0, 10) !== normalizedDate) {
    return planInfo;
  }
  if (parsedAt <= now) return planInfo;

  const tokenActiveUntil = Date.parse(planInfo.activeUntil || "");
  if (Number.isFinite(tokenActiveUntil) && parsedAt <= tokenActiveUntil) {
    return planInfo;
  }

  return {
    ...planInfo,
    activeUntil: null,
    renewalDate: normalizedDate,
    renewalDateOnly: true,
    subscriptionStatus: "active",
    subscriptionSource: "billing",
  };
}

function getPlanInfo() {
  try {
    const authPath = path.join(CODEX_HOME, "auth.json");
    const authStat = fs.statSync(authPath);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const idToken = auth.tokens && auth.tokens.id_token;
    if (!idToken) return null;
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
    const planInfo = normalizePlanInfo(auth, payload, authStat.mtime.toISOString());
    return applySubscriptionRenewalDate(planInfo, process.env.SUBSCRIPTION_RENEWAL_DATE);
  } catch {
    return null;
  }
}

function parseEventLine(line, state) {
  if (!/"(?:task_started|turn_started|task_complete|turn_complete|turn_aborted|error|function_call|function_call_output|custom_tool_call|custom_tool_call_output|exec_approval_request|apply_patch_approval_request|request_user_input|request_permissions|exec_command_begin|exec_command_end|patch_apply_begin|patch_apply_end)"/.test(line)) return;

  try {
    const event = JSON.parse(line);
    const payload = event.payload || {};
    const type = payload.type;
    const eventTime = Date.parse(event.timestamp);
    if (!Number.isFinite(eventTime)) return;
    if (event.type !== "event_msg" && event.type !== "response_item") return;
    const taskEvent = event.type === "event_msg";
    const callId = payload.call_id || payload.id || "";
    if (!taskEvent || !["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted", "error"].includes(type)) {
      trackActivity(event, state);
    }

    if (taskEvent && (type === "task_started" || type === "turn_started")) {
      state.seenTurns = state.seenTurns || new Set();
      if (eventTime < (state.lastStartedAt || 0) || (payload.turn_id && state.seenTurns.has(payload.turn_id))) return;
      if (state.turnId && state.turnId === payload.turn_id) return;
      if (payload.turn_id) rememberBounded(state.seenTurns, payload.turn_id);
      state.active = true;
      state.turnId = event.payload.turn_id || "";
      state.lastStartedAt = eventTime;
      state.lastOutcome = "";
      state.lifecycleUnknown = false;
      state.resolvedInputs = new Set();
      clearActivity(state);
      clearWaiting(state);
    } else if (taskEvent && ["task_complete", "turn_complete", "turn_aborted", "error"].includes(type)) {
      if (state.lastStartedAt && eventTime < state.lastStartedAt) return;
      if (payload.turn_id && state.turnId && payload.turn_id !== state.turnId) return;
      const errorInfo = payload.codex_error_info;
      const errorKind = typeof errorInfo === "string" ? errorInfo : Object.keys(errorInfo || {})[0];
      if (type === "error" && ["thread_rollback_failed", "active_turn_not_steerable"].includes(errorKind)) return;
      // A later task_complete can follow the error event for the same failed turn.
      if (!state.active && state.lastOutcome) return;
      const outcome = type === "error" || payload.error ? "error"
        : type === "turn_aborted" ? "cancelled" : "completed";
      state.active = false;
      clearActivity(state);
      state.lifecycleUnknown = false;
      clearWaiting(state);
      state.lastOutcome = outcome;
      state.lastFinishedAt = eventTime;
      if (outcome === "completed") state.lastCompletedAt = eventTime;
      const startedAt = state.lastStartedAt || (Number.isFinite(payload.started_at) ? payload.started_at * 1000 : null);
      state.history = state.history || [];
      state.history.push({
        state: outcome,
        startedAt,
        finishedAt: eventTime,
        durationMs: startedAt ? Math.max(0, eventTime - startedAt) : null,
      });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
    } else if ((event.type === "response_item" && type === "function_call" &&
        /(?:^|[.:])request_user_input$/.test(payload.name || "")) ||
        (taskEvent && ["request_user_input", "request_permissions", "exec_approval_request", "apply_patch_approval_request"].includes(type))) {
      if (eventTime < (state.lastStartedAt || 0) || (!state.active && state.lastOutcome)) return;
      if (state.resolvedInputs && state.resolvedInputs.has(callId)) return;
      if (!state.active) state.lifecycleUnknown = true;
      state.pendingInputs = state.pendingInputs || new Map();
      state.pendingInputs.set(callId, { at: eventTime, type });
      refreshWaiting(state);
    } else if ((event.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(type)) ||
        (taskEvent && ["exec_command_begin", "patch_apply_begin"].includes(type))) {
      if (state.pendingInputs) {
        if (eventTime < (state.lastStartedAt || 0)) return;
        if (state.pendingInputs.delete(callId) && callId) {
          state.resolvedInputs = state.resolvedInputs || new Set();
          rememberBounded(state.resolvedInputs, callId);
        }
        refreshWaiting(state);
      }
    }
  } catch {
    // A partially written final JSONL line will be picked up on the next poll.
  }
}

function rememberBounded(set, value) {
  set.add(value);
  if (set.size > 100) set.delete(set.values().next().value);
}

function clearWaiting(state) {
  state.pendingInputs = new Map();
  refreshWaiting(state);
}

function refreshWaiting(state) {
  const first = state.pendingInputs.entries().next().value;
  state.waiting = Boolean(first);
  state.waitingCallId = first ? first[0] : "";
  state.waitingAt = first ? first[1].at : 0;
}

function updateRolloutState(thread) {
  const filePath = normalizeRolloutPath(thread.rollout_path);
  const stat = fs.statSync(filePath);
  let cached = rolloutCache.get(filePath);

  if (!cached || stat.size < cached.offset) {
    cached = {
      offset: Math.max(0, stat.size - MAX_INITIAL_READ),
      remainder: "",
      decoder: new StringDecoder("utf8"),
      skipInitialLine: stat.size > MAX_INITIAL_READ,
      active: false,
      turnId: "",
      lastStartedAt: 0,
      lastCompletedAt: 0,
      waiting: false,
      waitingCallId: "",
      waitingAt: 0,
      pendingInputs: new Map(),
      history: [],
      lastOutcome: "",
      lastFinishedAt: 0,
      lifecycleUnknown: stat.size > MAX_INITIAL_READ,
    };
  }

  if (stat.size > cached.offset) {
    const length = stat.size - cached.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, length, cached.offset);
    } finally {
      fs.closeSync(fd);
    }

    let text = cached.remainder + cached.decoder.write(buffer.subarray(0, bytesRead));
    if (cached.skipInitialLine) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
        cached.skipInitialLine = false;
      } else {
        text = "";
      }
    }

    const lines = text.split(/\r?\n/);
    cached.remainder = lines.pop() || "";
    for (const line of lines) parseEventLine(line, cached);
    cached.offset += bytesRead;
  }

  rolloutCache.set(filePath, cached);
  const now = Date.now();
  const waiting = cached.waiting && now - cached.waitingAt < RECENT_THREAD_MS;
  const active = cached.active && now - Math.max(cached.lastStartedAt, stat.mtimeMs) < ACTIVE_STALE_MS;
  // Stable within this collector only; never expose the source thread ID.
  const sessionKey = thread.id ? createHmac("sha256", sessionKeySalt).update(thread.id).digest("hex").slice(0, 32) : undefined;
  return {
    sessionKey,
    title: normalizeTitle(thread.title),
    active,
    waiting,
    stale: !waiting && (cached.lifecycleUnknown || (cached.active && !active)),
    lastStartedAt: cached.lastStartedAt,
    lastCompletedAt: cached.lastCompletedAt,
    lastFinishedAt: cached.lastFinishedAt,
    lastOutcome: cached.lastOutcome,
    currentAction: getCurrentAction(cached),
    waitingSince: cached.waitingAt || 0,
    model: /^[\w.:-]{1,80}$/.test(thread.model || "") ? thread.model : "",
    history: cached.history.map(result => ({ ...result, sessionKey, title: normalizeTitle(thread.title) })),
    updatedAt: stat.mtimeMs,
  };
}

function collectRolloutStates(rows) {
  const threads = [];
  let unreadableThreads = 0;
  for (const row of rows) {
    try {
      threads.push(updateRolloutState(row));
    } catch {
      unreadableThreads += 1;
    }
  }
  return { threads, unreadableThreads };
}

function normalizeTitle(title) {
  const normalized = String(title || "未命名对话")
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

function buildCodexStatus(running, threads, totalThreads, now = Date.now(), options = {}) {
  const allCompletedAt = threads
    .map((t) => t.lastCompletedAt)
    .filter((t) => t > 0);
  const lastCompletedAt = allCompletedAt.length > 0 ? Math.max(...allCompletedAt) : null;

  const activeSessions = threads.filter((thread) => thread.active && !thread.waiting);
  const waitingSessions = threads.filter((thread) => thread.waiting);
  const terminalSessions = threads.filter(thread => {
    const finishedAt = thread.lastFinishedAt || thread.lastCompletedAt;
    return !thread.active && !thread.waiting && finishedAt && now >= finishedAt && now - finishedAt < COMPLETED_WINDOW_MS;
  }).sort((a, b) => (b.lastFinishedAt || b.lastCompletedAt) - (a.lastFinishedAt || a.lastCompletedAt));
  const unreadableThreads = options.unreadableThreads || 0;
  const staleTasks = threads.filter(thread => thread.stale).length;
  const history = threads.flatMap(thread => thread.history || [])
    .filter(result => result.finishedAt <= now && result.finishedAt >= now - RECENT_THREAD_MS)
    .sort((a, b) => b.finishedAt - a.finishedAt)
    .slice(0, HISTORY_LIMIT);
  const value = {
    source: "codex-local",
    state: running ? "idle" : "offline",
    light: running ? "green" : "yellow",
    label: running ? "空闲" : "Codex 未运行",
    sessionCount: 0,
    sessions: [],
    history,
    totalThreads,
    hostname: os.hostname(),
    lastCompletedAt,
    updatedAt: now,
    error: "",
    diagnostics: {
      state: unreadableThreads || staleTasks ? "degraded" : "ok",
      code: !running ? "codex_offline" : unreadableThreads ? "rollout_unreadable" : staleTasks ? "task_stale" : "ready",
      readableThreads: threads.length,
      unreadableThreads,
      staleTasks,
    },
  };
  if (!running) return value;

  const toPublicSession = (thread, state) => ({
    sessionKey: thread.sessionKey,
    title: thread.title,
    state,
    lastStartedAt: thread.lastStartedAt,
    lastCompletedAt: thread.lastCompletedAt,
    lastFinishedAt: thread.lastFinishedAt || 0,
    waitingSince: thread.waitingSince || 0,
    currentAction: state === "processing" || state === "waiting" ? thread.currentAction || null : null,
    model: thread.model || "",
    updatedAt: Math.max(thread.lastStartedAt || 0, thread.lastFinishedAt || 0, thread.lastCompletedAt || 0, thread.updatedAt || 0),
  });

  if (activeSessions.length > 0 || waitingSessions.length > 0) {
    const processing = activeSessions.length > 0;
    value.sessions = [
      ...activeSessions.map((thread) => toPublicSession(thread, "processing")),
      ...waitingSessions.map((thread) => toPublicSession(thread, "waiting")),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt);
    value.state = processing ? "processing" : "waiting";
    value.light = processing ? "red" : "yellow";
    value.label = processing ? "正在处理" : "等待输入";
  } else if (unreadableThreads) {
    value.state = "error";
    value.light = "red";
    value.label = "状态读取异常";
    value.error = "部分对话日志无法读取，不能确认全部任务状态";
  } else if (staleTasks) {
    value.state = "syncing";
    value.light = "yellow";
    value.label = "任务状态待确认";
  } else if (terminalSessions.length) {
    value.state = terminalSessions[0].lastOutcome || "completed";
    value.light = value.state === "error" ? "red" : "green";
    value.label = { completed: "已完成", cancelled: "已取消", error: "运行异常" }[value.state];
    value.sessions = terminalSessions.map(thread => toPublicSession(thread, thread.lastOutcome || "completed"));
    if (value.state === "error") value.error = "任务运行失败，请在 Codex 中查看错误详情";
  }
  value.sessionCount = value.sessions.length;
  return value;
}

function readCodexStatus(options = {}) {
  const now = options.now || Date.now();
  const injected = Object.keys(options).length > 0;
  if (!injected && statusCache.value && now < statusCache.expiresAt) return statusCache.value;

  const running = Object.hasOwn(options, "running") ? options.running : isCodexRunning(now);
  const planInfo = Object.hasOwn(options, "planInfo") ? options.planInfo : getPlanInfo();
  let value;

  try {
    const dbPath = Object.hasOwn(options, "threadRows") ? null : findLatestStateDatabase(now);
    const threadRows = options.threadRows || getRecentThreads(dbPath);
    const tokenStats = Object.hasOwn(options, "tokenStats") ? options.tokenStats : getTokenStats(dbPath, now);
    cleanupRolloutCache(threadRows);
    const { threads, unreadableThreads } = collectRolloutStates(threadRows);
    value = buildCodexStatus(running, threads, threadRows.length, now, { unreadableThreads });
    value.tokenStats = tokenStats;
    value.plan = planInfo;
  } catch (err) {
    value = {
      source: "codex-local",
      state: running ? "error" : "offline",
      light: running ? "red" : "yellow",
      label: running ? "运行异常" : "Codex 未运行",
      sessionCount: 0,
      sessions: [],
      totalThreads: 0,
      hostname: os.hostname(),
      lastCompletedAt: null,
      updatedAt: now,
      error: "无法读取 Codex 状态数据库，请检查本机采集服务",
      history: !injected && statusCache.value ? statusCache.value.history || [] : [],
      diagnostics: { state: "error", code: "database_unreadable" },
      plan: planInfo,
    };
  }
  if (!injected) statusCache = { value, expiresAt: now + STATUS_CACHE_MS };
  return value;
}

module.exports = {
  applySubscriptionRenewalDate,
  buildCodexStatus,
  collectRolloutStates,
  findLatestStateDatabase,
  getTokenStats,
  normalizePlanInfo,
  parseEventLine,
  updateRolloutState,
  readCodexStatus,
};
