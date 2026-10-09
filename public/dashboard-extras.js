(function (root) {
  "use strict";
  const ACTIONS = { read: "读取文件", write: "修改文件", command: "执行命令", search: "检索资料",
    tool: "调用工具", processing: "处理中", input: "等待输入", approval: "等待确认" };
  const STATES = { processing: "处理中", waiting: "等待输入", completed: "已完成", cancelled: "已取消", idle: "空闲", error: "运行异常" };
  const ALERTS = { completed: "任务已完成", waiting: "需要输入或确认", error: "运行异常" };
  const PREFERENCE_KEY = "codex_status_alert_preferences_v1";

  function create() {
    const doc = root.document;
    const el = id => doc.getElementById(id);
    const prefs = { sound: false, browser: false, completed: true, waiting: true, error: true };
    const tracker = root.CodexStatusAlerts.createAlertTracker();
    const lastAlerts = new Map();
    const pendingAlerts = new Map();
    let planInfo = null, currentState = "syncing", trendData = null, range = "today";
    let audio = null, toastTimer = null, alertTimer = null, snapshotAt = 0;
    try {
      const stored = JSON.parse(root.localStorage.getItem(PREFERENCE_KEY));
      for (const key of Object.keys(prefs)) if (stored && typeof stored[key] === "boolean") prefs[key] = stored[key];
    } catch {}
    function savePreferences() {
      try { root.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(prefs)); } catch {}
    }
    function formatTokens(value) {
      if (!Number.isFinite(value)) return "—";
      return value >= 1e9 ? (value / 1e9).toFixed(1) + "B" : value >= 1e6 ? (value / 1e6).toFixed(1) + "M"
        : value >= 1e3 ? (value / 1e3).toFixed(1) + "K" : String(value);
    }
    function duration(ms) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      if (seconds >= 86400) return Math.floor(seconds / 86400) + "天 " + Math.floor(seconds % 86400 / 3600) + "小时 " + Math.floor(seconds % 3600 / 60) + "分";
      if (seconds >= 3600) return Math.floor(seconds / 3600) + "小时 " + Math.floor(seconds % 3600 / 60) + "分";
      if (seconds >= 60) return Math.floor(seconds / 60) + "分 " + seconds % 60 + "秒";
      return seconds + "秒";
    }
    function literal(tag, className, value) {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = value || "";
      return node;
    }

    function renderSubscription(plan) {
      planInfo = plan;
      const info = el("plan-sub-info");
      if (info.children.length !== 2) info.replaceChildren(doc.createElement("span"), doc.createElement("span"));
      info.children[0].textContent = plan ? plan.name || plan.email || "" : "";
      let label = "订阅信息待同步", date = "暂无可确认的到期或续订日期";
      let source = "来源暂不可用";
      if (plan) {
        source = plan.subscriptionSource === "billing" ? "已确认账单日期 · 仅日期" : "本地登录信息 · 非账单实时查询";
        const until = Date.parse(plan.activeUntil || "");
        if (plan.renewalDateOnly && /^\d{4}-\d{2}-\d{2}$/.test(plan.renewalDate || "")) {
          const at = new Date(plan.renewalDate + "T00:00:00").getTime();
          label = at > Date.now() ? "距续订日约 " + Math.floor((at - Date.now()) / 86400000) + " 天" : "续订时间待同步";
          date = "下次续订日 " + plan.renewalDate + "（不包含具体时刻）";
        } else if (plan.subscriptionStatus === "renewal_pending" || (Number.isFinite(until) && until <= Date.now())) {
          label = "续订时间待同步";
          date = "自动续订后的新日期尚未同步，不推测到期时间";
        } else if (Number.isFinite(until)) {
          label = "订阅剩余 " + duration(until - Date.now());
          date = "到期时间 " + new Date(until).toLocaleString();
        } else {
          label = "订阅时间未知";
        }
      }
      const stale = ["disconnected", "syncing", "offline"].includes(currentState);
      el("subscription-card").dataset.stale = stale ? "true" : "false";
      info.children[1].textContent = label;
      el("subscription-date").textContent = date;
      el("subscription-source").textContent = (stale && plan ? "缓存信息 · " : "") + source;
      const refreshedAt = plan && Date.parse(plan.refreshedAt || "");
      el("subscription-refreshed").textContent = Number.isFinite(refreshedAt)
        ? "来源更新 " + new Date(refreshedAt).toLocaleString() : "来源更新时间未知";
    }

    function renderCurrentAction(session) {
      const state = currentState;
      const action = session && session.currentAction;
      const label = action && ACTIONS[action.kind] || (session && session.state === "waiting" ? "等待输入" : state === "processing" ? "处理中" : "");
      const stale = ["syncing", "disconnected", "offline"].includes(state);
      el("current-action").textContent = label ? (stale ? "上次动作 · " : "") + label : "";
    }

    function renderSessions(sessions) {
      const list = el("session-list");
      const opened = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.key));
      const focused = list.contains(doc.activeElement) && doc.activeElement.dataset.key;
      list.className = "session-list visible";
      list.firstElementChild.textContent = "当前对话";
      while (list.children.length > 1) list.lastChild.remove();
      if (!sessions || !sessions.length) {
        list.appendChild(literal("p", "panel-note session-empty", "暂无活跃对话；任务开始后会自动出现"));
        return;
      }
      for (const session of sessions) {
        const item = doc.createElement("details");
        item.className = "session-item";
        const key = (session.sessionKey || session.title) + ":" + (session.lastStartedAt || 0);
        item.dataset.key = key;
        item.open = opened.has(key);
        const summary = doc.createElement("summary");
        summary.className = "session-summary";
        summary.dataset.key = key;
        const dot = literal("span", "session-dot " + session.state, "");
        dot.setAttribute("aria-hidden", "true");
        const info = literal("span", "session-info", "");
        const name = literal("span", "session-name", session.title || "未命名对话");
        name.title = session.title;
        info.appendChild(name);
        const timer = literal("span", "session-duration session-time", "");
        if (session.state === "processing" && session.lastStartedAt > 0) timer.dataset.startedAt = session.lastStartedAt;
        else timer.textContent = session.state === "waiting" ? "等待你的操作" : "本轮任务已结束";
        info.appendChild(timer);
        summary.append(dot, info, literal("span", "session-badge " + session.state, STATES[session.state] || "状态未知"));
        const detail = literal("div", "session-detail", "");
        detail.appendChild(literal("p", "session-detail-title", session.title || "未命名对话"));
        if (session.model) detail.appendChild(literal("p", "panel-note", "模型 · " + session.model));
        if (session.currentAction && ACTIONS[session.currentAction.kind]) {
          detail.appendChild(literal("p", "panel-note session-detail-action", "动作 · " + ACTIONS[session.currentAction.kind]));
        }
        if (session.lastStartedAt) detail.appendChild(literal("p", "panel-note", "开始 · " + new Date(session.lastStartedAt).toLocaleString()));
        if (session.updatedAt) detail.appendChild(literal("p", "panel-note", "更新 · " + new Date(session.updatedAt).toLocaleString()));
        item.append(summary, detail);
        list.appendChild(item);
        if (focused === key) summary.focus({ preventScroll: true });
      }
      updateTimers();
    }

    function renderTrend(trend) {
      trendData = trend;
      el("trend-today").setAttribute("aria-pressed", String(range === "today"));
      el("trend-week").setAttribute("aria-pressed", String(range === "week"));
      const chart = el("trend-chart");
      chart.replaceChildren();
      if (!trend) {
        el("trend-total").textContent = "—";
        el("trend-status").textContent = "趋势数据待同步；不使用对话累计值推算每日消耗";
        el("trend-breakdown").textContent = "";
        return;
      }
      const days = range === "today" ? trend.days.slice(-1) : trend.days;
      const totals = days.reduce((sum, day) => ({ input: sum.input + day.inputTokens, output: sum.output + day.outputTokens,
        cache: sum.cache + day.cachedInputTokens }), { input: 0, output: 0, cache: 0 });
      el("trend-total").textContent = formatTokens(range === "today" ? trend.tokensToday : trend.tokens7d);
      el("trend-breakdown").textContent = "输入 " + formatTokens(totals.input) + " · 输出 " + formatTokens(totals.output) +
        " · 缓存输入 " + formatTokens(totals.cache) + "（包含在输入中）";
      const description = trend.status === "loading" ? "正在统计日志，当前为已读取部分" : trend.status === "partial"
        ? "部分日志缺失或计数不完整，仅展示已确认用量" : "真实日志增量";
      el("trend-status").textContent = description + " · " + trend.timeZone;
      const max = Math.max(1, ...days.map(day => day.tokens));
      for (const day of days) {
        const column = literal("div", "trend-column", "");
        column.appendChild(literal("span", "trend-value", formatTokens(day.tokens)));
        const track = literal("div", "trend-track", "");
        const bar = literal("span", "trend-bar", "");
        bar.style.height = Math.max(2, day.tokens / max * 100) + "%";
        track.appendChild(bar);
        column.append(track, literal("span", "trend-date", day.date.slice(5)));
        column.title = day.date + " · " + day.tokens + " tokens";
        chart.appendChild(column);
      }
      chart.dataset.range = range;
      chart.dataset.status = trend.status;
    }
    el("trend-today").addEventListener("click", () => { range = "today"; renderTrend(trendData); });
    el("trend-week").addEventListener("click", () => { range = "week"; renderTrend(trendData); });

    function updateTimers() {
      for (const node of doc.querySelectorAll(".session-duration[data-started-at]")) {
        const frozen = ["syncing", "disconnected", "offline"].includes(currentState);
        node.textContent = (frozen ? "上次记录 · " : "已运行 ") + duration((frozen && snapshotAt ? snapshotAt : Date.now()) - Number(node.dataset.startedAt));
      }
      renderSubscription(planInfo);
    }

    function preferencesNote(message) {
      el("alert-status").textContent = message || (prefs.sound || prefs.browser ? "提醒已开启；只提醒新事件，本页关闭后不提醒" : "提醒已关闭；按需开启声音或浏览器通知");
    }
    async function unlockAudio() {
      const AudioContext = root.AudioContext || root.webkitAudioContext;
      if (!AudioContext) throw new Error("unsupported");
      if (!audio) audio = new AudioContext();
      if (audio.state === "suspended") await audio.resume();
    }
    function playSound(kind) {
      if (!prefs.sound || !audio || audio.state !== "running") return;
      try {
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        oscillator.frequency.value = { completed: 660, waiting: 440, error: 220 }[kind] || 440;
        gain.gain.setValueAtTime(0.0001, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.06, audio.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
        oscillator.connect(gain); gain.connect(audio.destination);
        oscillator.start(); oscillator.stop(audio.currentTime + 0.2);
      } catch { preferencesNote("声音暂不可用；可重新点击测试提醒"); }
    }
    function announce(kind, count, testOnly) {
      const label = testOnly ? "测试提醒" : ALERTS[kind] + (count > 1 ? " · " + count + " 项" : "");
      el("alert-toast").textContent = label;
      el("alert-toast").hidden = false;
      root.clearTimeout(toastTimer);
      toastTimer = root.setTimeout(() => { el("alert-toast").hidden = true; }, 5000);
      playSound(kind);
      if (prefs.browser && root.Notification && root.Notification.permission === "granted") {
        try {
          const notice = new root.Notification("Codex · " + label, { body: "请回到 Codex 查看详情。", tag: "codex-status-" + kind });
          root.setTimeout(() => notice.close(), 10000);
        } catch { preferencesNote("此浏览器不能发送系统通知，可使用声音提醒"); }
      }
    }
    function flushAlerts() {
      root.clearTimeout(alertTimer);
      let nextDelay = Infinity;
      for (const kind of Object.keys(ALERTS)) {
        const count = pendingAlerts.get(kind) || 0;
        if (!count) continue;
        if (!prefs[kind] || (!prefs.sound && !prefs.browser)) { pendingAlerts.delete(kind); continue; }
        const delay = lastAlerts.has(kind) ? 5000 - (Date.now() - lastAlerts.get(kind)) : 0;
        if (delay > 0) { nextDelay = Math.min(nextDelay, delay); continue; }
        pendingAlerts.delete(kind);
        lastAlerts.set(kind, Date.now());
        announce(kind, count, false);
      }
      if (Number.isFinite(nextDelay)) alertTimer = root.setTimeout(flushAlerts, nextDelay);
    }
    function consumeLive(data) {
      const events = tracker.consume(data);
      if (!prefs.sound && !prefs.browser) return;
      for (const event of events) {
        if (prefs[event.kind]) pendingAlerts.set(event.kind, (pendingAlerts.get(event.kind) || 0) + 1);
      }
      flushAlerts();
    }
    for (const key of Object.keys(prefs)) {
      const checkbox = el("alert-" + key);
      checkbox.checked = prefs[key];
      checkbox.addEventListener("change", async () => {
        prefs[key] = checkbox.checked;
        try {
          if (key === "sound" && prefs.sound) await unlockAudio();
          if (key === "browser" && prefs.browser) {
            if (!root.Notification || await root.Notification.requestPermission() !== "granted") {
              prefs.browser = false; checkbox.checked = false;
              preferencesNote("浏览器通知未获授权，仍可使用声音提醒");
              savePreferences(); return;
            }
          }
          savePreferences(); preferencesNote();
        } catch {
          prefs[key] = false; checkbox.checked = false; savePreferences();
          preferencesNote("当前浏览器暂不支持该提醒方式");
        }
      });
    }
    if (!root.Notification) { prefs.browser = false; el("alert-browser").checked = false; el("alert-browser").disabled = true; }
    el("alert-test").addEventListener("click", async () => {
      if (!prefs.sound && !prefs.browser) { preferencesNote("请先选择一种提醒方式"); return; }
      try { if (prefs.sound) await unlockAudio(); announce("completed", 1, true); }
      catch { preferencesNote("声音暂不可用，请检查浏览器权限"); }
    });
    preferencesNote(prefs.sound ? "声音已开启；刷新后请点击测试提醒激活声音" : "");
    return { renderSubscription, renderCurrentAction, renderSessions, renderTrend, updateTimers, consumeLive,
      setStatus(data, cached) { currentState = cached ? "syncing" : data.state; snapshotAt = data.updatedAt || snapshotAt; },
      connectionLost() { tracker.reset(); pendingAlerts.clear(); root.clearTimeout(alertTimer); }, };
  }
  root.CodexDashboardExtras = { create };
})(window);
