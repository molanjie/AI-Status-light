import { describeRoute } from 'hono-openapi'
import { createRouter } from '@/lib/create-app'
import { storage } from '@/lib/cache'
import { logger } from '@/lib/logger'
import { broadcastToAll } from './websocket'

const log = logger.child('signal-light')
const router = createRouter()

const KEY_SESSIONS = 'signal_light:sessions'
const KEY_QUOTA = 'signal_light:quota'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const FIVE_HOUR_MINUTES = 5 * 60
const WEEKLY_MINUTES = 7 * 24 * 60

// 灯语聚合规则：红色阻塞 > 黄色确认/关注 > 工作循环 > 空闲绿灯。
const RED = new Set(['blocked', 'interrupted', 'interrupt', 'error', 'failed', 'failure'])
const YELLOW = new Set(['permission', 'attention', 'done'])
const WORKING = new Set(['thinking', 'working', 'tool_done'])
const END = new Set(['session_end', 'turn_end'])
const CLEAR = new Set(['off'])

interface SessionEntry {
  signal: string
  updated_at: number
  label?: string
}
type Sessions = Record<string, SessionEntry>

type SessionState = 'error' | 'interrupted' | 'permission' | 'attention' | 'working' | 'idle'

interface SessionSummary {
  session_id: string
  label: string
  signal: string
  state: SessionState
  updated_at: number
  age_ms: number
  priority: number
}

interface SessionCounts {
  total: number
  working: number
  permission: number
  error: number
  attention: number
  idle: number
}

interface QuotaWindow {
  used_percent: number | null
  remaining_percent: number | null
  limit_window_seconds: number | null
  reset_at: number | string | null
}

interface QuotaState {
  five_hour: QuotaWindow | null
  weekly: QuotaWindow | null
  source: string
  updated_at: number
}

function aggregate(sessions: Sessions): string {
  const vals = Object.values(sessions).map(s => s.signal)
  if (vals.some(v => RED.has(v))) return 'blocked'
  if (vals.some(v => YELLOW.has(v))) return 'attention'
  if (vals.some(v => WORKING.has(v))) return 'working'
  return 'idle'
}

function sessionState(signal: string): SessionState {
  if (new Set(['error', 'failed', 'failure']).has(signal)) return 'error'
  if (new Set(['blocked', 'interrupted', 'interrupt']).has(signal)) return 'interrupted'
  if (signal === 'permission') return 'permission'
  if (YELLOW.has(signal)) return 'attention'
  if (WORKING.has(signal)) return 'working'
  return 'idle'
}

function priorityFor(state: SessionState): number {
  if (state === 'error' || state === 'interrupted') return 50
  if (state === 'permission') return 40
  if (state === 'attention') return 30
  if (state === 'working') return 20
  return 0
}

function shortSessionId(sessionId: string): string {
  const clean = sessionId.replace(/^codex[:_-]?/i, '').replace(/[^a-zA-Z0-9]/g, '')
  if (!clean) return 'main'
  return clean.length <= 6 ? clean : clean.slice(-6)
}

function sessionLabel(sessionId: string, entry: SessionEntry): string {
  const label = entry.label?.trim()
  return label || `会话 ${shortSessionId(sessionId)}`
}

function summarizeSessions(sessions: Sessions, now = Date.now()): SessionSummary[] {
  return Object.entries(sessions)
    .map(([sessionId, entry]) => {
      const state = sessionState(entry.signal)
      return {
        session_id: sessionId,
        label: sessionLabel(sessionId, entry),
        signal: entry.signal,
        state,
        updated_at: entry.updated_at,
        age_ms: Math.max(0, now - entry.updated_at),
        priority: priorityFor(state),
      }
    })
    .sort((a, b) => b.priority - a.priority || b.updated_at - a.updated_at || a.session_id.localeCompare(b.session_id))
}

function countSessions(summaries: SessionSummary[]): SessionCounts {
  const counts: SessionCounts = {
    total: summaries.length,
    working: 0,
    permission: 0,
    error: 0,
    attention: 0,
    idle: 0,
  }

  for (const session of summaries) {
    if (session.state === 'working') counts.working += 1
    else if (session.state === 'permission') counts.permission += 1
    else if (session.state === 'error' || session.state === 'interrupted') counts.error += 1
    else if (session.state === 'attention') counts.attention += 1
    else counts.idle += 1
  }

  return counts
}

function sessionPayload(sessions: Sessions, now = Date.now()) {
  const sessionSummaries = summarizeSessions(sessions, now)
  return {
    sessions,
    session_summaries: sessionSummaries,
    session_counts: countSessions(sessionSummaries),
    active_sessions: sessionSummaries.length,
  }
}

function prune(sessions: Sessions, now: number): Sessions {
  const out: Sessions = {}
  for (const [k, v] of Object.entries(sessions)) {
    if (now - v.updated_at < SESSION_TTL_MS) out[k] = v
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function field(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key]
  }
  return undefined
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function percent(value: number | null): number | null {
  if (value == null) return null
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function normalizeQuotaWindow(value: unknown): QuotaWindow | null {
  const obj = asRecord(value)
  if (!obj) return null

  const used = percent(numberFrom(field(obj, ['used_percent', 'usedPercent', 'usage_percent', 'usagePercent'])))
  const explicitRemaining = percent(numberFrom(field(obj, ['remaining_percent', 'remainingPercent', 'remaining_pct', 'remainingPct'])))
  const remaining = explicitRemaining ?? (used == null ? null : percent(100 - used))
  const limitSeconds = numberFrom(field(obj, ['limit_window_seconds', 'limitWindowSeconds', 'window_seconds', 'windowSeconds']))
  const windowMinutes = numberFrom(field(obj, ['window_minutes', 'windowMinutes', 'limit_window_minutes', 'limitWindowMinutes']))
  const resetValue = field(obj, ['reset_at', 'resetAt', 'resets_at', 'resetsAt'])
  const resetAt = typeof resetValue === 'number' || typeof resetValue === 'string' ? resetValue : null
  const normalizedLimitSeconds = limitSeconds ?? (windowMinutes == null ? null : windowMinutes * 60)

  if (used == null && remaining == null && normalizedLimitSeconds == null && resetAt == null) return null

  return {
    used_percent: used,
    remaining_percent: remaining,
    limit_window_seconds: normalizedLimitSeconds,
    reset_at: resetAt,
  }
}

function collectQuotaWindows(value: unknown, out: QuotaWindow[] = [], depth = 0): QuotaWindow[] {
  if (depth > 6 || out.length >= 32) return out

  if (Array.isArray(value)) {
    for (const item of value) collectQuotaWindows(item, out, depth + 1)
    return out
  }

  const obj = asRecord(value)
  if (!obj) return out

  const direct = normalizeQuotaWindow(obj)
  if (direct) out.push(direct)

  const primary = normalizeQuotaWindow(field(obj, ['primary_window', 'primaryWindow']))
  const secondary = normalizeQuotaWindow(field(obj, ['secondary_window', 'secondaryWindow']))
  if (primary) out.push(primary)
  if (secondary) out.push(secondary)

  for (const nested of Object.values(obj)) {
    if (nested && typeof nested === 'object') collectQuotaWindows(nested, out, depth + 1)
  }

  return out
}

function quotaWindowMinutes(window: QuotaWindow): number | null {
  return window.limit_window_seconds == null ? null : window.limit_window_seconds / 60
}

function normalizeQuota(value: unknown, now = Date.now()): QuotaState | null {
  const obj = asRecord(value)
  if (!obj) return null

  if (obj.clear === true) {
    return { five_hour: null, weekly: null, source: 'clear', updated_at: now }
  }

  let fiveHour = normalizeQuotaWindow(field(obj, ['five_hour', 'fiveHour', 'five_hours', 'fiveHours']))
  let weekly = normalizeQuotaWindow(field(obj, ['weekly', 'week']))

  for (const window of collectQuotaWindows(obj)) {
    const minutes = quotaWindowMinutes(window)
    if (minutes == null) continue
    if (!fiveHour && Math.abs(minutes - FIVE_HOUR_MINUTES) <= 45) fiveHour = window
    if (!weekly && (minutes >= WEEKLY_MINUTES - 1 || Math.abs(minutes - WEEKLY_MINUTES) <= 720)) weekly = window
  }

  if (!fiveHour && !weekly) return null

  const sourceValue = field(obj, ['source', 'plan_type', 'planType'])
  const source = typeof sourceValue === 'string' && sourceValue.trim()
    ? sourceValue.trim()
    : 'codex'

  return {
    five_hour: fiveHour,
    weekly,
    source,
    updated_at: now,
  }
}

router.post(
  '/api/signal-light/state',
  describeRoute({
    description: 'AI Agent 灯语事件上报（Claude Code hook 调用）',
    tags: ['Signal Light'],
  }),
  async c => {
    let body: any
    try { body = await c.req.json() }
    catch { return c.json({ error: 'invalid_json' }, 400) }

    const signalName = String(body?.signal ?? '').trim()
    const sessionId = String(body?.session_id ?? body?.sessionId ?? 'global').trim() || 'global'
    const labelValue = String(body?.label ?? body?.session_label ?? body?.sessionLabel ?? '').trim()
    const label = labelValue ? labelValue.slice(0, 160) : undefined
    if (!signalName) return c.json({ error: 'missing_signal' }, 400)

    const now = Date.now()
    let sessions = await storage.getItem<Sessions>(KEY_SESSIONS) ?? {}
    sessions = prune(sessions, now)

    if (END.has(signalName) || CLEAR.has(signalName)) {
      delete sessions[sessionId]
    }
    else {
      sessions[sessionId] = {
        signal: signalName,
        updated_at: now,
        label: label ?? sessions[sessionId]?.label,
      }
    }

    const agg = aggregate(sessions)
    const payload = sessionPayload(sessions, now)
    await storage.setItem(KEY_SESSIONS, sessions)

    log.info(`session=${sessionId} signal=${signalName} aggregate=${agg} active=${payload.active_sessions}`)

    // 推 ws：手机 / web 都收到
    broadcastToAll({
      type: 'signal_light',
      aggregate: agg,
      session_id: sessionId,
      signal: signalName,
      ...payload,
      ts: now,
    })

    const quota = await storage.getItem<QuotaState>(KEY_QUOTA) ?? null
    return c.json({ aggregate: agg, ...payload, quota })
  },
)

router.post(
  '/api/signal-light/quota',
  describeRoute({
    description: 'Codex 剩余额度上报',
    tags: ['Signal Light'],
  }),
  async c => {
    let body: unknown
    try { body = await c.req.json() }
    catch { return c.json({ error: 'invalid_json' }, 400) }

    const quota = normalizeQuota(body)
    if (!quota) return c.json({ error: 'missing_quota' }, 400)

    await storage.setItem(KEY_QUOTA, quota)
    broadcastToAll({
      type: 'quota_update',
      quota,
      ts: quota.updated_at,
    })

    return c.json({ quota })
  },
)

router.get(
  '/api/signal-light/quota',
  describeRoute({
    description: '查询 Codex 剩余额度',
    tags: ['Signal Light'],
  }),
  async c => {
    const quota = await storage.getItem<QuotaState>(KEY_QUOTA) ?? null
    return c.json({ quota })
  },
)

router.get(
  '/api/signal-light/state',
  describeRoute({
    description: '查询当前聚合灯语状态',
    tags: ['Signal Light'],
  }),
  async c => {
    const now = Date.now()
    const storedSessions = await storage.getItem<Sessions>(KEY_SESSIONS) ?? {}
    const quota = await storage.getItem<QuotaState>(KEY_QUOTA) ?? null
    const sessions = prune(storedSessions, now)
    if (Object.keys(sessions).length !== Object.keys(storedSessions).length) {
      await storage.setItem(KEY_SESSIONS, sessions)
    }
    const agg = aggregate(sessions)
    const payload = sessionPayload(sessions, now)
    return c.json({
      aggregate: agg,
      ...payload,
      quota,
    })
  },
)

export default router
