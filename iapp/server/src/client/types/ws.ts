/**
 * WebSocket 相关类型
 */

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface PageInfo {
  id: string
  name: string
  path: string
  index?: number
}

export interface LogItem {
  id: number
  time: string
  raw: string
}

// ─── 红绿灯信号 ───

export type SessionState = 'error' | 'interrupted' | 'permission' | 'attention' | 'working' | 'idle'

export interface SessionSummary {
  session_id: string
  label: string
  signal: string
  state: SessionState
  updated_at: number
  age_ms: number
  priority: number
}

export interface SessionCounts {
  total: number
  working: number
  permission: number
  error: number
  attention: number
  idle: number
}

export interface SignalLightState {
  aggregate: string
  signal: string
  session_id: string
  session_summaries: SessionSummary[]
  session_counts: SessionCounts
  ts: number
}
