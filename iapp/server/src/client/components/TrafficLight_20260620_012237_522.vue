<script setup lang="ts">
import { useWsStore } from '@client/store/ws'

const wsStore = useWsStore()
const { status: wsStatus, signalLight } = storeToRefs(wsStore)
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

// ─── 状态标签 ───

const statusLabel = computed(() => {
  if (isPermission.value) return '等待权限确认'
  if (isError.value) return '运行出错'
  if (isInterrupted.value) return '中断或阻塞'
  if (isAttention.value) return '需要关注'
  if (isWorking.value) return '正在处理'
  if (hasSessions.value) return '空闲'
  return 'Codex'
})

// ─── 颜色 ───

function hexToRGB(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}

const accentColor = computed(() => {
  if (isPermission.value || isAttention.value) return '#ffd45a'
  if (isError.value) return '#ff453a'
  if (isInterrupted.value) return '#ff7a45'
  return '#32f47e'
})

const accentRGB = computed(() => hexToRGB(accentColor.value))

// ─── 动态样式 ───

const dotStyle = computed(() => ({
  backgroundColor: accentColor.value,
  boxShadow: `0 0 8px ${accentColor.value}, 0 0 18px rgba(${accentRGB.value}, 0.4)`,
}))

const breathDotStyle = computed(() => ({
  backgroundColor: accentColor.value,
  boxShadow: `0 0 14px ${accentColor.value}, 0 0 28px rgba(${accentRGB.value}, 0.55)`,
}))

const haloBorderStyle = computed(() => ({
  borderColor: accentColor.value,
}))

const expandedDotStyle = computed(() => ({
  backgroundColor: accentColor.value,
  boxShadow: `0 0 6px ${accentColor.value}`,
}))

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
      @click="toggleExpand"
    >
      <!-- 外层光晕 (alert 态) -->
      <div
        v-if="isAlert"
        class="capsule-halo"
        :style="haloBorderStyle"
      />

      <!-- 外壳 -->
      <div class="capsule-shell">
        <!-- ── 紧凑模式 ── -->
        <div v-if="!expanded" class="capsule-compact">
          <span
            class="capsule-dot"
            :class="{ 'animate-working': isWorking }"
            :style="dotStyle"
          />
          <span class="capsule-label">{{ statusLabel }}</span>
          <span v-if="hasSessions" class="capsule-session-count">
            {{ sessionText }}
          </span>
          <!-- 工作态底部扫描进度条 -->
          <div v-if="isWorking" class="capsule-progress">
            <div class="capsule-progress-bar" />
          </div>
        </div>

        <!-- ── 展开模式 ── -->
        <div v-else class="capsule-expanded">
          <div class="expanded-header">
            <span class="expanded-dot" :style="expandedDotStyle" />
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

          <!-- 展开态进度条 -->
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
/* ── 根容器：固定顶部居中 ── */
.traffic-light-capsule {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  min-height: 32px;
  border-radius: 9999px;
  background: linear-gradient(180deg, #1d1d20 0%, #0b0b0d 18%, #050506 58%, #020203 100%);
  border: 0.5px solid rgba(255, 255, 255, 0.12);
  box-shadow:
    0 0 30px rgba(0, 0, 0, 0.5),
    0 0 8px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition: width 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  overflow: hidden;
}

/* ── 各状态宽度 ── */
.traffic-light-capsule.is-idle {
  width: 100px;
}
.traffic-light-capsule:not(.is-idle):not(.is-alert):not(.is-working):not(.is-expanded) {
  width: 138px;
}
.traffic-light-capsule.is-working:not(.is-expanded) {
  width: 164px;
}
.traffic-light-capsule.is-alert:not(.is-expanded) {
  width: 182px;
}
.traffic-light-capsule.is-expanded {
  width: min(340px, calc(100vw - 20px));
}

/* ── 光晕 ── */
.capsule-halo {
  position: absolute;
  inset: -3px -2px -1px -2px;
  border-radius: 9999px;
  border: 1.2px solid transparent;
  pointer-events: none;
  animation: halo-pulse 2s ease-in-out infinite;
}
@keyframes halo-pulse {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.5; }
}

/* ── 外壳内部 ── */
.capsule-shell {
  position: relative;
  padding: 7px 15px;
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
  background: rgba(255, 255, 255, 0.08);
  pointer-events: none;
}

/* ── 紧凑模式 ── */
.capsule-compact {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  position: relative;
}

.capsule-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: box-shadow 0.3s ease;
}

.capsule-dot.animate-working {
  animation: dot-breathe 1.2s ease-in-out infinite;
}
@keyframes dot-breathe {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.25); opacity: 0.8; }
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
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
  margin-left: auto;
}

/* ── 紧凑态进度条 ── */
.capsule-progress {
  position: absolute;
  bottom: -7px;
  left: 15px;
  right: 10px;
}
.capsule-progress-bar {
  height: 2px;
  border-radius: 1px;
  background: linear-gradient(
    90deg,
    rgba(50, 244, 126, 0) 0%,
    rgba(98, 244, 206, 0.7) 45%,
    rgba(114, 215, 255, 0.55) 100%
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
  gap: 4px;
}

.expanded-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.expanded-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.expanded-meta {
  font-size: 10px;
  font-weight: 600;
  color: #a1a1a6;
  letter-spacing: 0.4px;
}

.expanded-title {
  font-size: 15px;
  font-weight: 700;
  color: #f5f5f7;
}

.expanded-detail {
  font-size: 11px;
  color: #a1a1a6;
  font-weight: 450;
  line-height: 1.4;
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
    rgba(98, 244, 206, 0.75) 45%,
    rgba(114, 215, 255, 0.6) 100%
  );
  animation: progress-scan 2.2s ease-in-out infinite;
}

/* ── 会话列表 ── */
.expanded-sessions {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 3px;
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

/* ── 手机小屏适配 ── */
@media (max-width: 360px) {
  .traffic-light-capsule.is-expanded {
    width: calc(100vw - 16px);
  }
  .capsule-shell {
    padding: 6px 12px;
  }
  .expanded-title {
    font-size: 14px;
  }
}
</style>
