<script setup lang="ts">
import { useWsStore } from '@client/store/ws'

const wsStore = useWsStore()
const { signalLight } = storeToRefs(wsStore)
wsStore.init()

const expanded = ref(false)

// ─── 6 种状态判定（与 desktop/dynamic_island.py 对齐） ───

const isPermission = computed(() =>
  signalLight.value.signal === 'permission',
)

const isAttention = computed(() =>
  signalLight.value.aggregate === 'attention'
  || signalLight.value.signal === 'attention'
  || signalLight.value.signal === 'done',
)

const isError = computed(() =>
  ['error', 'failed', 'failure'].includes(signalLight.value.signal),
)

const isInterrupted = computed(() =>
  ['blocked', 'interrupted', 'interrupt'].includes(signalLight.value.signal) && !isPermission.value,
)

const isAlert = computed(() =>
  signalLight.value.aggregate === 'blocked'
  || isPermission.value
  || isError.value
  || isInterrupted.value
  || isAttention.value,
)

const isWorking = computed(() =>
  !isAlert.value && signalLight.value.aggregate === 'working',
)

const hasSessions = computed(() =>
  (signalLight.value.session_counts?.total ?? 0) > 0,
)

// ─── 状态标签和颜色 ───

const statusLabel = computed(() => {
  if (isPermission.value) return '等待权限确认'
  if (isError.value) return '运行出错'
  if (isInterrupted.value) return '中断或阻塞'
  if (isAttention.value) return '需要关注'
  if (isWorking.value) return '正在处理'
  if (hasSessions.value) return '空闲'
  return 'Codex'
})

const accentColor = computed(() => {
  if (isPermission.value || isAttention.value) return '#ffd45a'
  if (isError.value) return '#ff453a'
  if (isInterrupted.value) return '#ff7a45'
  return '#32f47e'
})

const softColor = computed(() => {
  if (isPermission.value || isAttention.value) return '#ffe2a3'
  if (isError.value) return '#ffb4ae'
  if (isInterrupted.value) return '#ffc1a8'
  return '#32f47e'
})

// ─── CSS 自定义属性样式对象（解决 v-bind() 不支持方法调用的问题） ───
const capsuleStyle = computed(() => ({
  '--accent-r': Number.parseInt(accentColor.value.slice(1, 3), 16),
  '--accent-g': Number.parseInt(accentColor.value.slice(3, 5), 16),
  '--accent-b': Number.parseInt(accentColor.value.slice(5, 7), 16),
  '--accent-color': accentColor.value,
} as Record<string, string | number>))

// ─── 展开详情 ───

const expandedDetail = computed(() => {
  if (isPermission.value) return '等待你在 Codex 中确认权限'
  if (isError.value) return '回到 Codex 查看错误详情'
  if (isInterrupted.value) return '任务被中断或阻塞'
  if (isAttention.value) return 'Codex 等待下一步操作'
  if (isWorking.value) return '红绿灯循环，任务正在执行'
  return '绿灯常亮，系统空闲'
})

const sessionText = computed(() => {
  const c = signalLight.value.session_counts
  if (!c || c.total === 0) return ''
  return `${c.total} 个会话`
})

const topSessions = computed(() =>
  (signalLight.value.session_summaries ?? []).slice(0, 3),
)

// ─── 会话状态中文标签 ───

function sessionStateLabel(state: string): string {
  const map: Record<string, string> = {
    working: '正在处理',
    permission: '等待确认',
    error: '运行出错',
    interrupted: '中断或阻塞',
    attention: '需要关注',
    idle: '空闲',
  }
  return map[state] ?? '空闲'
}

function sessionDotColor(state: string): string {
  const map: Record<string, string> = {
    working: '#32f47e',
    permission: '#ffd45a',
    attention: '#ffd45a',
    error: '#ff453a',
    interrupted: '#ff7a45',
  }
  return map[state] ?? '#6e6e73'
}

function toggleExpand() {
  expanded.value = !expanded.value
}
</script>

<template>
  <Teleport to="body">
    <div
      class="traffic-light-capsule"
      :class="{
        'is-alert': isAlert,
        'is-working': isWorking,
        'is-expanded': expanded,
        'is-idle': !isAlert && !isWorking && !hasSessions,
      }"
      :style="capsuleStyle"
      @click="toggleExpand"
    >
      <!-- 光晕 -->
      <div
        v-if="isAlert || isWorking"
        class="capsule-halo"
        :style="{ borderColor: isAlert ? accentColor : 'transparent' }"
      />

      <!-- 外壳 -->
      <div class="capsule-shell">
        <!-- 紧凑模式 -->
        <div v-if="!expanded" class="capsule-compact">
          <span
            class="capsule-dot"
            :class="{ 'animate-working': isWorking }"
            :style="{ backgroundColor: accentColor }"
          />
          <span class="capsule-label">{{ statusLabel }}</span>
          <span v-if="hasSessions" class="capsule-session-count">
            {{ sessionText }}
          </span>
          <!-- 工作态进度条 -->
          <div v-if="isWorking" class="capsule-progress">
            <div class="capsule-progress-bar" />
          </div>
        </div>

        <!-- 展开模式 -->
        <div v-else class="capsule-expanded">
          <div class="expanded-header">
            <span
              class="expanded-dot"
              :style="{ backgroundColor: accentColor }"
            />
            <span class="expanded-meta">
              Codex · {{ sessionText || '无活跃会话' }}
            </span>
          </div>
          <div class="expanded-title">
            {{ statusLabel }}
          </div>
          <div class="expanded-detail">
            {{ expandedDetail }}
          </div>

          <!-- 工作态进度条 -->
          <div v-if="isWorking" class="expanded-progress">
            <div class="expanded-progress-bar" />
          </div>

          <!-- 会话列表 -->
          <div v-if="topSessions.length" class="expanded-sessions">
            <div
              v-for="session in topSessions"
              :key="session.session_id"
              class="expanded-session-row"
            >
              <span
                class="session-dot"
                :style="{ backgroundColor: sessionDotColor(session.state) }"
              />
              <span class="session-label">{{ session.label }}</span>
              <span
                class="session-badge"
                :style="{ color: sessionDotColor(session.state) }"
              >
                {{ sessionStateLabel(session.state) }}
              </span>
            </div>
          </div>
          <div v-else class="expanded-sessions">
            <div class="expanded-session-row">
              <span class="session-dot" style="background-color: #6e6e73" />
              <span class="session-label">没有活跃会话</span>
              <span class="session-badge" style="color: #6e6e73">空闲</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ── 根容器：居中顶部悬浮 ── */
.traffic-light-capsule {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  min-height: 32px;
  border-radius: 9999px;
  background: linear-gradient(180deg, #1d1d20 0%, #0b0b0d 18%, #050506 58%, #020203 100%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    0 0 30px rgba(0, 0, 0, 0.45),
    0 0 10px rgba(0, 0, 0, 0.3);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}

/* ── 状态宽度 ── */
.traffic-light-capsule.is-idle {
  width: 108px;
}
.traffic-light-capsule:not(.is-idle):not(.is-alert):not(.is-working) {
  width: 140px;
}
.traffic-light-capsule.is-working {
  width: 168px;
}
.traffic-light-capsule.is-alert {
  width: 186px;
}
.traffic-light-capsule.is-expanded {
  width: min(344px, calc(100vw - 24px));
}

/* ── 光晕（alert / working 时出现在外层） ── */
.capsule-halo {
  position: absolute;
  inset: -3px -2px -1px -2px;
  border-radius: 9999px;
  border: 1px solid transparent;
  pointer-events: none;
  opacity: 0.45;
}
.traffic-light-capsule.is-alert .capsule-halo {
  animation: halo-pulse 2s ease-in-out infinite;
}
@keyframes halo-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 0.55; }
}

/* ── 外壳内部 padding ── */
.capsule-shell {
  position: relative;
  padding: 7px 16px;
  min-height: 32px;
  display: flex;
  align-items: center;
}

/* 顶部高光 */
.capsule-shell::before {
  content: '';
  position: absolute;
  top: 1px;
  left: 6px;
  right: 6px;
  height: 10px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.07);
  pointer-events: none;
}

/* ── 紧凑模式 ── */
.capsule-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  position: relative;
  overflow: hidden;
}

.capsule-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 8px var(--accent-color), 0 0 16px rgba(var(--accent-r), var(--accent-g), var(--accent-b), 0.35);
  transition: all 0.3s ease;
}

.capsule-dot.animate-working {
  animation: dot-breathe 1.2s ease-in-out infinite;
}
@keyframes dot-breathe {
  0%, 100% { box-shadow: 0 0 6px var(--accent-color), 0 0 12px rgba(var(--accent-r), var(--accent-g), var(--accent-b), 0.2); }
  50% { box-shadow: 0 0 14px var(--accent-color), 0 0 28px rgba(var(--accent-r), var(--accent-g), var(--accent-b), 0.55); }
}

.capsule-label {
  font-size: 12px;
  font-weight: 600;
  color: #e8e8ed;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1;
}

.capsule-session-count {
  font-size: 11px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  margin-left: auto;
}

/* ── 工作态进度条 ── */
.capsule-progress {
  position: absolute;
  bottom: -7px;
  left: 16px;
  right: 12px;
}

.capsule-progress-bar {
  height: 2px;
  border-radius: 1px;
  background: linear-gradient(
    90deg,
    rgba(50, 244, 126, 0) 0%,
    rgba(98, 244, 206, 0.75) 45%,
    rgba(114, 215, 255, 0.6) 100%
  );
  animation: progress-scan 2.2s ease-in-out infinite;
}
@keyframes progress-scan {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

/* ── 展开模式 ── */
.capsule-expanded {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.expanded-header {
  display: flex;
  align-items: center;
  gap: 7px;
}

.expanded-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px var(--accent-color);
}

.expanded-meta {
  font-size: 10px;
  font-weight: 600;
  color: #a1a1a6;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.expanded-title {
  font-size: 15px;
  font-weight: 700;
  color: #f5f5f7;
}

.expanded-detail {
  font-size: 10px;
  color: #a1a1a6;
  font-weight: 500;
}

/* ── 展开态进度条 ── */
.expanded-progress {
  margin-top: 2px;
  margin-bottom: 2px;
}

.expanded-progress-bar {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(
    90deg,
    rgba(50, 244, 126, 0) 0%,
    rgba(98, 244, 206, 0.8) 45%,
    rgba(114, 215, 255, 0.65) 100%
  );
  background-size: 200% 100%;
  animation: expanded-progress-scan 2.2s ease-in-out infinite;
}
@keyframes expanded-progress-scan {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* ── 会话列表 ── */
.expanded-sessions {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 2px;
}

.expanded-session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
}

.session-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.session-label {
  flex: 1;
  font-size: 11px;
  font-weight: 600;
  color: #e8e8ed;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-badge {
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

/* ── 响应式：手机小屏适配 ── */
@media (max-width: 360px) {
  .traffic-light-capsule.is-expanded {
    width: calc(100vw - 16px);
  }
  .capsule-shell {
    padding: 6px 12px;
  }
}
</style>
