import ctypes
import json
import math
import sys
import threading
import time
import urllib.error
import urllib.request
from ctypes import wintypes

from PySide6.QtCore import QPoint, QRect, QRectF, Qt, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QFont, QFontDatabase, QGuiApplication, QIcon, QLinearGradient, QPainter, QPainterPath, QPen, QPixmap, QRadialGradient
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget
from PySide6.QtWebSockets import QWebSocket


STATE_URL = "http://127.0.0.1:3001/api/signal-light/state"
POST_URL = STATE_URL
WS_URL = "ws://127.0.0.1:3001/api/ws"
ALERT_SIGNALS = {"blocked", "permission", "interrupted", "interrupt", "error", "failed", "failure"}
PERMISSION_SIGNALS = {"permission"}
ERROR_SIGNALS = {"error", "failed", "failure"}
INTERRUPT_SIGNALS = {"blocked", "interrupted", "interrupt"}
WORKING_STALE_SECONDS = 45
TRAY_GAP = 10
TRAY_FALLBACK_WIDTH = 260


def post_signal(signal: str, session_id: str = "codex") -> None:
    payload = json.dumps({"signal": signal, "session_id": session_id}).encode("utf-8")
    req = urllib.request.Request(
        POST_URL,
        data=payload,
        method="POST",
        headers={"content-type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=2).read()


class Island(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Mini Watch")
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setMouseTracking(True)

        self.mode = "idle"
        self.signal = "idle"
        self.quota = None
        self.sessions = []
        self.session_counts = {}
        self.updated_at = 0
        self.online = False
        self.ws_connected = False
        self.realtime_enabled = True
        self.phase = 0.0
        self.drag_offset = None
        self.locked = False
        self.hovered = False
        self.needs_tray_update = True
        self.tray = None
        self.tray_status_action = None
        self.tray_lock_action = None

        self.outer_w = 122.0
        self.outer_h = 34.0
        self.target_w = self.outer_w
        self.target_h = self.outer_h

        self.canvas_pad_x = 14
        self.canvas_pad_top = 8
        self.canvas_pad_bottom = 14
        self.min_canvas_w = 128
        self.min_canvas_h = 56
        self.screen = QGuiApplication.primaryScreen()
        self.taskbar_edge = "bottom"
        self.taskbar_rect = QRect()
        self.tray_boundary = None
        self.dock_axis_pos = 0
        self.manual_dock_position = False
        canvas_w, canvas_h = self.canvas_size()
        self.resize(canvas_w, canvas_h)
        self.refresh_taskbar_geometry(reset_axis=True)
        self.dock_to_taskbar()
        self.screen.availableGeometryChanged.connect(self.on_screen_geometry_changed)
        self.screen.geometryChanged.connect(self.on_screen_geometry_changed)

        self.font_family = self.pick_font()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(16)

        self.ws = QWebSocket()
        self.ws.connected.connect(self.on_ws_connected)
        self.ws.disconnected.connect(self.on_ws_disconnected)
        self.ws.textMessageReceived.connect(self.on_ws_message)
        self.ws.open(QUrl(WS_URL))

        self.reconnect_timer = QTimer(self)
        self.reconnect_timer.timeout.connect(self.ensure_ws)
        self.reconnect_timer.start(1000)

        self.fallback_timer = QTimer(self)
        self.fallback_timer.timeout.connect(self.fetch_state_async)
        self.fallback_timer.start(2500)

        self.ping_timer = QTimer(self)
        self.ping_timer.timeout.connect(self.send_ws_ping)
        self.ping_timer.start(20000)

        self.setup_tray()
        self.fetch_state_async()

    def pick_font(self):
        preferred = ["Microsoft YaHei UI", "Segoe UI Variable", "Segoe UI"]
        families = set(QFontDatabase.families())
        for family in preferred:
            if family in families:
                return family
        return QApplication.font().family()

    def setup_tray(self):
        if not QSystemTrayIcon.isSystemTrayAvailable():
            return

        menu = QMenu()
        self.tray_status_action = QAction(self.tray_status_text(), self)
        self.tray_status_action.setEnabled(False)
        menu.addAction(self.tray_status_action)

        show_action = QAction("显示 / 隐藏", self)
        show_action.triggered.connect(self.toggle_visible)
        menu.addAction(show_action)

        home_action = QAction("回到任务栏右侧", self)
        home_action.triggered.connect(self.return_home)
        menu.addAction(home_action)

        self.tray_lock_action = QAction(self.tray_lock_text(), self)
        self.tray_lock_action.triggered.connect(self.toggle_lock)
        menu.addAction(self.tray_lock_action)

        menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.quit_app)
        menu.addAction(quit_action)

        self.tray = QSystemTrayIcon(self)
        self.tray.setContextMenu(menu)
        self.tray.setToolTip(self.tray_tooltip())
        self.tray.setIcon(self.tray_icon())
        self.tray.activated.connect(self.on_tray_activated)
        self.tray.show()

    def tray_status_text(self):
        parts = [f"状态：{self.status_label()}"]
        if self.session_count_text():
            parts.append(self.session_count_text())
        if self.has_quota():
            parts.append(self.quota_text())
        return " · ".join(parts)

    def tray_lock_text(self):
        return "解除锁定位置" if self.locked else "锁定位置"

    def tray_tooltip(self):
        parts = [f"Codex 红绿灯 - {self.status_label()}"]
        if self.session_count_text():
            parts.append(self.session_count_text())
        if self.has_quota():
            parts.append(self.quota_text())
        return " · ".join(parts)

    def session_count_text(self):
        count = len(self.sessions)
        return f"{count}会话" if count else ""

    def meta_text(self):
        parts = []
        if self.session_count_text():
            parts.append(self.session_count_text())
        if self.has_quota():
            parts.append(self.quota_text())
        return " · ".join(parts)

    def tray_color(self):
        if self.is_permission():
            return QColor("#ffd45a")
        if self.is_attention():
            return QColor("#ffd45a")
        if self.is_error():
            return QColor("#ff453a")
        if self.is_interrupted():
            return QColor("#ff8a3d")
        if self.mode == "working":
            return QColor("#32f47e")
        return QColor("#34c759") if self.online else QColor("#8e8e93")

    def tray_icon(self):
        pixmap = QPixmap(64, 64)
        pixmap.fill(Qt.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setPen(QPen(QColor(255, 255, 255, 44), 2))
        painter.setBrush(QColor("#050506"))
        painter.drawRoundedRect(QRectF(6, 10, 52, 44), 22, 22)

        color = self.tray_color()
        glow = QRadialGradient(QPoint(32, 32), 24)
        soft = QColor(color)
        soft.setAlpha(150)
        glow.setColorAt(0.0, soft)
        soft_edge = QColor(color)
        soft_edge.setAlpha(0)
        glow.setColorAt(1.0, soft_edge)
        painter.setPen(Qt.NoPen)
        painter.setBrush(glow)
        painter.drawEllipse(QPoint(32, 32), 24, 24)
        painter.setBrush(color)
        painter.drawEllipse(QPoint(32, 32), 10, 10)
        painter.end()
        return QIcon(pixmap)

    def update_tray(self):
        if not self.tray:
            return
        self.tray.setIcon(self.tray_icon())
        self.tray.setToolTip(self.tray_tooltip())
        if self.tray_status_action:
            self.tray_status_action.setText(self.tray_status_text())
        if self.tray_lock_action:
            self.tray_lock_action.setText(self.tray_lock_text())

    def on_tray_activated(self, reason):
        if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick):
            self.show()
            self.raise_()
            self.activateWindow()

    def toggle_visible(self):
        if self.isVisible():
            self.hide()
        else:
            self.show()
            self.raise_()
            self.activateWindow()

    def quit_app(self):
        if self.tray:
            self.tray.hide()
        QApplication.quit()

    def on_ws_connected(self):
        self.ws_connected = True
        self.online = True
        self.ws.sendTextMessage(json.dumps({
            "type": "page_change",
            "page": {"id": "dynamic_island_desktop", "name": "Desktop Island"},
            "ts": int(time.time() * 1000),
        }))
        self.fetch_state_async()

    def on_ws_disconnected(self):
        self.ws_connected = False

    def ensure_ws(self):
        if self.realtime_enabled and not self.ws_connected:
            self.ws.open(QUrl(WS_URL))

    def send_ws_ping(self):
        if self.realtime_enabled and self.ws_connected:
            self.ws.sendTextMessage(json.dumps({
                "type": "ping",
                "ts": int(time.time() * 1000),
            }))

    def on_ws_message(self, raw):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        if msg.get("type") == "quota_update":
            self.apply_quota(msg.get("quota"))
            return
        if msg.get("type") == "signal_light":
            sessions = self.normalize_sessions(msg)
            self.apply_sessions(sessions, msg.get("session_counts"))
            self.apply_state(
                msg.get("aggregate") or "idle",
                self.best_signal(sessions, msg.get("signal") or msg.get("aggregate") or "idle"),
                int(msg.get("ts") or time.time() * 1000),
                True,
            )

    def fetch_state_async(self):
        threading.Thread(target=self.fetch_state, daemon=True).start()

    def fetch_state(self):
        try:
            with urllib.request.urlopen(STATE_URL, timeout=1.2) as response:
                data = json.loads(response.read().decode("utf-8"))
            self.apply_quota(data.get("quota"))
            sessions = self.normalize_sessions(data)
            self.apply_sessions(sessions, data.get("session_counts"))
            updated = max([int(item.get("updated_at") or 0) for item in sessions], default=0)
            mode = data.get("aggregate") or "idle"
            signal = self.best_signal(sessions, mode)
            self.apply_state(mode, signal, updated, True)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            if not self.ws_connected:
                self.apply_state("blocked", "error", int(time.time() * 1000), False)

    def apply_state(self, mode, signal, updated, online):
        changed = (mode, signal, online) != (self.mode, self.signal, self.online)
        self.mode = mode
        self.signal = signal
        self.updated_at = updated
        self.online = online
        if changed:
            self.needs_tray_update = True

    def apply_quota(self, quota):
        if self.quota is None:
            return
        self.quota = None
        self.needs_tray_update = True

    def normalize_sessions(self, data):
        now = int(time.time() * 1000)
        raw_summaries = data.get("session_summaries") if isinstance(data, dict) else None
        summaries = []
        if isinstance(raw_summaries, list):
            for item in raw_summaries:
                if not isinstance(item, dict):
                    continue
                signal = str(item.get("signal") or "idle")
                state = str(item.get("state") or self.state_from_signal(signal, data.get("aggregate")))
                summaries.append({
                    "session_id": str(item.get("session_id") or item.get("id") or "global"),
                    "label": str(item.get("label") or self.short_session_id(item.get("session_id") or "global")),
                    "signal": signal,
                    "state": state,
                    "updated_at": int(item.get("updated_at") or now),
                    "priority": int(item.get("priority") or self.priority_for(state)),
                })
        else:
            raw_sessions = data.get("sessions") if isinstance(data, dict) else None
            if isinstance(raw_sessions, dict):
                for session_id, entry in raw_sessions.items():
                    if not isinstance(entry, dict):
                        continue
                    signal = str(entry.get("signal") or "idle")
                    state = self.state_from_signal(signal, data.get("aggregate"))
                    summaries.append({
                        "session_id": str(session_id),
                        "label": str(entry.get("label") or self.short_session_id(session_id)),
                        "signal": signal,
                        "state": state,
                        "updated_at": int(entry.get("updated_at") or now),
                        "priority": self.priority_for(state),
                    })
        summaries.sort(key=lambda item: (-int(item.get("priority") or 0), -int(item.get("updated_at") or 0), str(item.get("session_id") or "")))
        return summaries

    def apply_sessions(self, sessions, counts):
        normalized_counts = counts if isinstance(counts, dict) else self.count_sessions(sessions)
        if sessions == self.sessions and normalized_counts == self.session_counts:
            return
        self.sessions = sessions
        self.session_counts = normalized_counts
        self.needs_tray_update = True

    def count_sessions(self, sessions):
        counts = {"working": 0, "permission": 0, "error": 0, "idle": 0}
        for session in sessions:
            state = session.get("state")
            if state == "working":
                counts["working"] += 1
            elif state == "permission":
                counts["permission"] += 1
            elif state in {"error", "interrupted"}:
                counts["error"] += 1
            elif state == "idle":
                counts["idle"] += 1
        counts["total"] = len(sessions)
        return counts

    def state_from_signal(self, signal, aggregate=None):
        if signal in PERMISSION_SIGNALS:
            return "permission"
        if signal in ERROR_SIGNALS:
            return "error"
        if signal in INTERRUPT_SIGNALS or aggregate == "blocked":
            return "interrupted"
        if signal in {"working", "thinking", "tool_done"} or aggregate == "working":
            return "working"
        if signal in {"attention", "done"} or aggregate == "attention":
            return "attention"
        return "idle"

    def priority_for(self, state):
        if state in {"error", "interrupted"}:
            return 50
        if state == "permission":
            return 40
        if state == "attention":
            return 30
        if state == "working":
            return 20
        return 0

    def best_signal(self, sessions, fallback):
        if sessions:
            return str(sessions[0].get("signal") or fallback or "idle")
        return fallback or "idle"

    def short_session_id(self, session_id):
        clean = "".join(ch for ch in str(session_id or "") if ch.isalnum())
        if not clean:
            return "会话 main"
        return f"会话 {clean[-6:] if len(clean) > 6 else clean}"

    def tick(self):
        self.phase += 0.024
        self.target_w, self.target_h = self.target_size()
        self.outer_w += (self.target_w - self.outer_w) * 0.16
        self.outer_h += (self.target_h - self.outer_h) * 0.16
        self.update_window_frame()
        if self.needs_tray_update:
            self.update_tray()
            self.needs_tray_update = False
        self.update()

    def target_size(self):
        if self.hovered:
            return 320.0, 108.0
        if self.is_permission():
            return 175.0, 34.0
        if self.is_alert():
            return 175.0, 34.0
        if self.mode == "working":
            return 156.0, 32.0
        if self.session_count_text():
            return 136.0, 30.0
        return 100.0, 28.0

    def canvas_size(self):
        width = max(self.min_canvas_w, int(math.ceil(self.outer_w + self.canvas_pad_x * 2)))
        height = max(self.min_canvas_h, int(math.ceil(self.outer_h + self.canvas_pad_top + self.canvas_pad_bottom)))
        # Cap width to available taskbar space so we never overlap tray icons
        max_w = self.max_island_width()
        if width > max_w:
            width = max_w
        return width, height

    def max_island_width(self):
        """Maximum island width in pixels that fits without overlapping system tray or taskbar icons.
        
        The island docks to the right of the taskbar, near the system tray.
        We reserve TRAY_GAP px from the tray and assume a safety margin for icons.
        """
        if self.taskbar_edge not in {"top", "bottom"}:
            return 9999
        tray_left = self.tray_boundary
        if tray_left is None:
            taskbar_right = self.taskbar_rect.x() + self.taskbar_rect.width()
            tray_left = taskbar_right - TRAY_FALLBACK_WIDTH
        # For compact (non-expanded) states, be conservative to avoid overlapping icons.
        # Typical gap between last taskbar icon and tray is 200-280px on a busy taskbar.
        raw_max = tray_left - self.taskbar_rect.x() - TRAY_GAP
        if not self.hovered and self.outer_h < 80:
            # Compact mode: leave extra room for taskbar icons
            return min(raw_max, 220)
        # Expanded/hovered: allow more but still cap at a reasonable absolute max
        # so we never swallow the entire taskbar even on wide screens
        return min(max(raw_max - 40, self.min_canvas_w), 360)

    def update_window_frame(self):
        width, height = self.canvas_size()
        if width == self.width() and height == self.height():
            return
        self.resize(width, height)
        if self.drag_offset is None:
            self.dock_to_taskbar()

    def on_screen_geometry_changed(self, _geometry):
        self.refresh_taskbar_geometry(reset_axis=not self.manual_dock_position)
        self.dock_to_taskbar()

    def refresh_taskbar_geometry(self, reset_axis=False):
        full = self.screen.geometry()
        available = self.screen.availableGeometry()
        full_right = full.x() + full.width()
        full_bottom = full.y() + full.height()
        available_right = available.x() + available.width()
        available_bottom = available.y() + available.height()
        gaps = {
            "left": max(0, available.x() - full.x()),
            "top": max(0, available.y() - full.y()),
            "right": max(0, full_right - available_right),
            "bottom": max(0, full_bottom - available_bottom),
        }
        edge = max(gaps, key=gaps.get)
        thickness = gaps[edge]

        if thickness <= 1:
            edge = "bottom"
            thickness = 48

        if edge == "left":
            rect = QRect(full.x(), full.y(), thickness, full.height())
        elif edge == "top":
            rect = QRect(full.x(), full.y(), full.width(), thickness)
        elif edge == "right":
            rect = QRect(full_right - thickness, full.y(), thickness, full.height())
        else:
            rect = QRect(full.x(), full_bottom - thickness, full.width(), thickness)

        self.taskbar_edge = edge
        self.taskbar_rect = rect
        self.tray_boundary = self.system_tray_left(rect) if edge in {"top", "bottom"} else None
        if reset_axis or not self.dock_axis_pos:
            self.dock_axis_pos = self.default_dock_axis()

    def system_tray_left(self, taskbar_rect):
        if sys.platform != "win32":
            return None
        try:
            user32 = ctypes.windll.user32
            user32.FindWindowW.restype = wintypes.HWND
            user32.FindWindowExW.restype = wintypes.HWND
            user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
            user32.GetWindowRect.restype = wintypes.BOOL
            taskbar = user32.FindWindowW("Shell_TrayWnd", None)
            tray = user32.FindWindowExW(taskbar, None, "TrayNotifyWnd", None)
            taskbar_win_rect = wintypes.RECT()
            tray_win_rect = wintypes.RECT()
            if not taskbar or not tray:
                return None
            if not user32.GetWindowRect(taskbar, ctypes.byref(taskbar_win_rect)):
                return None
            if not user32.GetWindowRect(tray, ctypes.byref(tray_win_rect)):
                return None
            win_width = taskbar_win_rect.right - taskbar_win_rect.left
            if win_width <= 0:
                return None
            scale = taskbar_rect.width() / win_width
            offset = (tray_win_rect.left - taskbar_win_rect.left) * scale
            boundary = taskbar_rect.x() + round(offset)
            taskbar_right = taskbar_rect.x() + taskbar_rect.width()
            if taskbar_rect.x() < boundary < taskbar_right:
                return boundary
        except (AttributeError, OSError):
            pass
        return None

    def default_dock_axis(self):
        if self.taskbar_edge in {"top", "bottom"}:
            taskbar_right = self.taskbar_rect.x() + self.taskbar_rect.width()
            tray_left = self.tray_boundary or (taskbar_right - TRAY_FALLBACK_WIDTH)
            return tray_left - TRAY_GAP
        return self.taskbar_rect.center().y()

    def dock_to_taskbar(self, axis_pos=None):
        if axis_pos is not None:
            self.dock_axis_pos = int(axis_pos)

        taskbar = self.taskbar_rect
        screen = self.screen.geometry()
        if self.taskbar_edge in {"top", "bottom"}:
            minimum = screen.x() + self.width()
            maximum = self.default_dock_axis()
            self.dock_axis_pos = max(minimum, min(maximum, self.dock_axis_pos))
            x = self.dock_axis_pos - self.width()
            compact_inset = max(3, (taskbar.height() - 34) // 2)
            if self.taskbar_edge == "bottom":
                shell_bottom = taskbar.y() + taskbar.height() - compact_inset
                y = int(shell_bottom - self.outer_h - self.canvas_pad_top)
            else:
                shell_top = taskbar.y() + compact_inset
                y = int(shell_top - self.canvas_pad_top)
        else:
            half_height = self.height() // 2
            minimum = screen.y() + half_height
            maximum = screen.y() + screen.height() - half_height
            self.dock_axis_pos = max(minimum, min(maximum, self.dock_axis_pos))
            y = self.dock_axis_pos - half_height
            if self.taskbar_edge == "left":
                x = taskbar.x() + taskbar.width() + 4 - self.canvas_pad_x
            else:
                x = int(taskbar.x() - self.outer_w - self.canvas_pad_x - 4)
        self.move(int(x), int(y))

    def has_quota(self):
        return False

    def quota_window(self, *keys):
        if not isinstance(self.quota, dict):
            return None
        for key in keys:
            value = self.quota.get(key)
            if isinstance(value, dict):
                return value
        return None

    def quota_percent_text(self, item):
        if not isinstance(item, dict):
            return "--"
        value = item.get("remaining_percent", item.get("remainingPercent"))
        try:
            return f"{round(float(value))}%"
        except (TypeError, ValueError):
            pass
        used = item.get("used_percent", item.get("usedPercent"))
        try:
            return f"{max(0, round(100 - float(used)))}%"
        except (TypeError, ValueError):
            return "--"

    def quota_text(self):
        five = self.quota_percent_text(self.quota_window("five_hour", "fiveHour", "five_hours", "fiveHours"))
        week = self.quota_percent_text(self.quota_window("weekly", "week"))
        return f"5h {five}  周 {week}"

    def session_state_label(self, state):
        if state == "working":
            return "正在处理"
        if state == "permission":
            return "等待确认"
        if state == "error":
            return "运行出错"
        if state == "interrupted":
            return "中断或阻塞"
        if state == "attention":
            return "需要关注"
        return "空闲"

    def is_alert(self):
        return self.mode == "blocked" or self.signal in ALERT_SIGNALS or self.is_attention()

    def is_permission(self):
        return self.signal in PERMISSION_SIGNALS

    def is_attention(self):
        return self.mode == "attention" or self.signal in {"attention", "done"}

    def is_error(self):
        return self.signal in ERROR_SIGNALS

    def is_interrupted(self):
        return self.signal in INTERRUPT_SIGNALS or (self.mode == "blocked" and not self.is_permission() and not self.is_error())

    def contextMenuEvent(self, event):
        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background: #1c1c1e;
                color: #f5f5f7;
                border: 1px solid #343437;
                border-radius: 10px;
                padding: 6px;
            }
            QMenu::item {
                padding: 7px 22px;
                border-radius: 7px;
            }
            QMenu::item:selected {
                background: #2c2c2e;
            }
        """)
        status_action = QAction(self.tray_status_text(), self)
        status_action.setEnabled(False)
        menu.addAction(status_action)
        if self.sessions:
            for session in self.sessions[:5]:
                state = self.session_state_label(str(session.get("state") or "idle"))
                label = str(session.get("label") or self.short_session_id(session.get("session_id")))
                session_action = QAction(f"{label}：{state}", self)
                session_action.setEnabled(False)
                menu.addAction(session_action)
        realtime_action = QAction("实时反馈：开" if self.realtime_enabled else "实时反馈：关", self)
        realtime_action.setCheckable(True)
        realtime_action.setChecked(self.realtime_enabled)
        realtime_action.triggered.connect(self.toggle_realtime)
        menu.addAction(realtime_action)
        menu.addSeparator()
        lock_action = QAction("解除锁定位置" if self.locked else "锁定位置", self)
        lock_action.triggered.connect(self.toggle_lock)
        menu.addAction(lock_action)
        home_action = QAction("回到任务栏右侧", self)
        home_action.triggered.connect(self.return_home)
        menu.addAction(home_action)
        menu.addSeparator()
        self.add_menu_action(menu, "测试：工作中", "working")
        self.add_menu_action(menu, "测试：权限确认", "permission")
        self.add_menu_action(menu, "测试：错误", "error")
        self.add_menu_action(menu, "测试：空闲", "off")
        menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(QApplication.quit)
        menu.addAction(quit_action)
        menu.exec(event.globalPos())

    def status_label(self):
        if self.is_permission():
            return "等待权限确认"
        if self.is_error():
            return "运行出错"
        if self.is_interrupted():
            return "中断或阻塞"
        if self.is_attention():
            return "需要关注"
        if self.mode == "working":
            return "正在处理"
        return "空闲"

    def add_menu_action(self, menu, label, signal):
        action = QAction(label, self)
        action.triggered.connect(lambda _checked=False, s=signal: self.send_signal(s))
        menu.addAction(action)

    def toggle_realtime(self):
        self.realtime_enabled = not self.realtime_enabled
        if self.realtime_enabled:
            self.ws.open(QUrl(WS_URL))
            self.fetch_state_async()
        else:
            self.ws.close()
            self.ws_connected = False

    def toggle_lock(self):
        self.locked = not self.locked
        if self.locked:
            self.dock_to_taskbar()
        self.needs_tray_update = True

    def return_home(self):
        self.manual_dock_position = False
        self.refresh_taskbar_geometry(reset_axis=True)
        self.dock_to_taskbar()

    def send_signal(self, signal):
        threading.Thread(target=lambda: self.safe_post(signal), daemon=True).start()

    def safe_post(self, signal):
        try:
            post_signal(signal)
        except Exception:
            pass

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton and not self.locked:
            self.drag_offset = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if self.drag_offset and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_offset)
            event.accept()

    def mouseReleaseEvent(self, event):
        self.drag_offset = None
        axis_pos = self.frameGeometry().right() + 1
        if self.taskbar_edge in {"left", "right"}:
            axis_pos = self.frameGeometry().center().y()
        self.manual_dock_position = True
        self.dock_to_taskbar(axis_pos)
        event.accept()

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.return_home()

    def enterEvent(self, _event):
        self.hovered = True
        self.update()

    def leaveEvent(self, _event):
        self.hovered = False
        self.update()

    def paintEvent(self, _event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setRenderHint(QPainter.TextAntialiasing, True)
        painter.setCompositionMode(QPainter.CompositionMode_Source)
        painter.fillRect(self.rect(), Qt.transparent)
        painter.setCompositionMode(QPainter.CompositionMode_SourceOver)

        rect = QRectF(
            (self.width() - self.outer_w) / 2,
            self.canvas_pad_top,
            self.outer_w,
            self.outer_h,
        )

        self.draw_shadow(painter, rect)
        self.draw_shell(painter, rect)

        painter.save()
        painter.setClipPath(self.shell_path(rect))
        self.draw_ambient(painter, rect)

        if self.is_expanded():
            self.draw_expanded(painter, rect)
        else:
            self.draw_compact(painter, rect)
        painter.restore()

    def shell_path(self, rect):
        path = QPainterPath()
        path.addRoundedRect(rect, rect.height() / 2, rect.height() / 2)
        return path

    def draw_shadow(self, painter, rect):
        for i, alpha in enumerate([34, 18, 8], start=1):
            glow_rect = rect.adjusted(-i * 5, i * 3, i * 5, i * 7)
            c = QColor(0, 0, 0, alpha + (5 if self.is_expanded() else 0))
            painter.setPen(Qt.NoPen)
            painter.setBrush(c)
            painter.drawRoundedRect(glow_rect, glow_rect.height() / 2, glow_rect.height() / 2)

        if self.mode == "working" or self.is_alert():
            accent = self.alert_accent() if self.is_alert() else QColor("#32f47e")
            accent.setAlpha(13 if self.is_expanded() else 9)
            painter.setPen(QPen(accent, 1.0))
            painter.setBrush(Qt.NoBrush)
            halo = rect.adjusted(-2, -1, 2, 2)
            painter.drawRoundedRect(halo, halo.height() / 2, halo.height() / 2)

    def draw_shell(self, painter, rect):
        body = QLinearGradient(rect.left(), rect.top(), rect.left(), rect.bottom())
        body.setColorAt(0.0, QColor("#1d1d20"))
        body.setColorAt(0.18, QColor("#0b0b0d"))
        body.setColorAt(0.58, QColor("#050506"))
        body.setColorAt(1.0, QColor("#020203"))
        painter.setPen(QPen(QColor(255, 255, 255, 42 if self.is_expanded() else 30), 1))
        painter.setBrush(body)
        painter.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)

        shine = QRectF(rect.left() + 1, rect.top() + 1, rect.width() - 2, max(8, rect.height() * 0.34))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(255, 255, 255, 18 if self.is_expanded() else 13))
        painter.drawRoundedRect(shine, shine.height() / 2, shine.height() / 2)

    def draw_ambient(self, painter, rect):
        if self.mode == "working":
            scan_x = rect.left() + ((math.sin(self.phase * 1.15) * 0.5 + 0.5) * rect.width())
            grad = QLinearGradient(scan_x - 44, rect.top(), scan_x + 44, rect.top())
            grad.setColorAt(0.0, QColor(255, 255, 255, 0))
            grad.setColorAt(0.5, QColor(255, 255, 255, 10))
            grad.setColorAt(1.0, QColor(255, 255, 255, 0))
            painter.setPen(Qt.NoPen)
            painter.setBrush(grad)
            painter.drawRoundedRect(QRectF(scan_x - 44, rect.top() + 1, 88, rect.height() - 2), rect.height() / 2, rect.height() / 2)
        elif self.is_permission() or self.is_attention():
            alpha = 12 + int(6 * (math.sin(self.phase * 2.3) * 0.5 + 0.5))
            painter.setPen(QPen(QColor(255, 212, 90, alpha), 1.2))
            painter.setBrush(Qt.NoBrush)
            painter.drawRoundedRect(rect.adjusted(1.5, 1.5, -1.5, -1.5), rect.height() / 2, rect.height() / 2)
        elif self.is_error():
            alpha = 16 + int(8 * (math.sin(self.phase * 3.2) * 0.5 + 0.5))
            painter.setPen(QPen(QColor(255, 69, 58, alpha), 1.4))
            painter.setBrush(Qt.NoBrush)
            painter.drawRoundedRect(rect.adjusted(1.5, 1.5, -1.5, -1.5), rect.height() / 2, rect.height() / 2)

    def draw_compact(self, painter, rect):
        if self.is_permission() or self.is_attention():
            color = QColor("#ffd45a")
        elif self.is_error():
            color = QColor("#ff453a")
        elif self.is_interrupted():
            color = QColor("#ff7a45")
        else:
            color = QColor("#32f47e") if self.online else QColor("#6e6e73")

        session_text = self.session_count_text()
        if self.mode == "idle" and not self.is_alert() and not session_text:
            label = "Codex"
        else:
            label = self.status_label()
            if session_text:
                label = f"{label} · {session_text}"

        self.dot(painter, QPoint(int(rect.left() + 20), int(rect.center().y())), 4.5, color)
        text_right = rect.right() - (26 if self.locked else 12)
        self.text(
            painter,
            rect.left() + 34,
            rect.center().y() + 4,
            label,
            9,
            QColor("#e8e8ed"),
            weight=650,
            anchor="left",
            max_width=text_right - rect.left() - 34,
        )
        if self.locked:
            self.text(painter, rect.right() - 16, rect.center().y() + 3, "锁", 7, QColor("#77777d"), weight=600, anchor="center")
        if self.mode == "working":
            self.draw_progress(painter, rect.left() + 34, rect.bottom() - 5, rect.right() - 12)

    def draw_working(self, painter, rect):
        self.text(painter, rect.left() + 18, rect.top() + 22, "Codex", 8, QColor("#8e8e93"), weight=700, anchor="left")
        if self.meta_text():
            self.text(painter, rect.left() + 72, rect.top() + 22, self.meta_text(), 8, QColor("#8e8e93"), weight=650, anchor="left")
        self.text(painter, rect.left() + 18, rect.top() + 45, "正在处理", 14, QColor("#f5f5f7"), weight=750, anchor="left")
        self.draw_progress(painter, rect.left() + 18, rect.bottom() - 12, rect.right() - 76)
        self.draw_orbit(painter, QPoint(int(rect.right() - 38), int(rect.center().y())), 17)
        self.sparkles(painter, rect.left() + 132, rect.top() + 26, rect.right() - 76, rect.bottom() - 16)

    def draw_alert(self, painter, rect):
        title, detail = self.alert_copy()
        accent = self.alert_accent()
        soft = self.alert_soft()
        header = f"Codex · {self.session_count_text()}" if self.session_count_text() else "Codex"
        self.text(painter, rect.left() + 18, rect.top() + 21, header, 8, soft, weight=700, anchor="left")
        self.text(painter, rect.left() + 18, rect.top() + 45, title, 14, QColor("#ffffff"), weight=780, anchor="left")
        self.text(painter, rect.left() + 18, rect.top() + 66, detail, 9, soft, weight=450, anchor="left")
        if self.has_quota():
            self.text(painter, rect.left() + 18, rect.top() + 81, self.quota_text(), 8, soft, weight=520, anchor="left")
        pulse = 1.0 + math.sin(self.phase * 2.8) * 0.04
        self.dot(painter, QPoint(int(rect.right() - 38), int(rect.center().y())), 14.0 * pulse, accent)
        if self.is_permission():
            self.permission_ring(painter, QPoint(int(rect.right() - 38), int(rect.center().y())), 24)

    def draw_idle(self, painter, rect):
        if self.meta_text():
            self.text(painter, rect.left() + 18, rect.top() + 19, "空闲", 12, QColor("#f5f5f7"), weight=760, anchor="left")
            self.text(painter, rect.left() + 18, rect.top() + 37, self.meta_text(), 8, QColor("#8e8e93"), weight=650, anchor="left")
            self.dot(painter, QPoint(int(rect.right() - 28), int(rect.center().y())), 8.5, QColor("#32f47e"))
        else:
            self.text(painter, rect.left() + 18, rect.top() + 21, "Codex", 8, QColor("#8e8e93"), weight=700, anchor="left")
            self.text(painter, rect.left() + 18, rect.top() + 45, "空闲", 14, QColor("#f5f5f7"), weight=760, anchor="left")
            self.dot(painter, QPoint(int(rect.right() - 34), int(rect.center().y())), 12.0, QColor("#32f47e"))

    def is_expanded(self):
        return self.hovered or self.outer_h > 92

    def session_color(self, state):
        if state in {"permission", "attention"}:
            return QColor("#ffd45a")
        if state == "error":
            return QColor("#ff453a")
        if state == "interrupted":
            return QColor("#ff7a45")
        if state == "working":
            return QColor("#32f47e")
        return QColor("#32f47e") if self.online else QColor("#7d7d84")

    def expanded_detail(self):
        if self.is_permission():
            return "等待你在 Codex 中确认权限"
        if self.is_error():
            return "回到 Codex 查看错误详情"
        if self.is_interrupted():
            return "任务被中断或阻塞"
        if self.is_attention():
            return "Codex 等待下一步操作"
        if self.mode == "working":
            return "红绿灯循环，任务正在执行"
        return "绿灯常亮，系统空闲"

    def draw_expanded(self, painter, rect):
        accent = self.alert_accent() if self.is_alert() else self.session_color("working" if self.mode == "working" else "idle")
        online_text = "实时在线" if self.online else "离线重连"
        meta = self.session_count_text() or "无活跃会话"
        header = f"Codex · {meta} · {online_text}"
        self.text(painter, rect.left() + 18, rect.top() + 20, header, 8, QColor("#a1a1a6"), weight=700, anchor="left", max_width=rect.width() - 94)
        self.text(painter, rect.left() + 18, rect.top() + 45, self.status_label(), 15, QColor("#f5f5f7"), weight=780, anchor="left", max_width=rect.width() - 112)
        self.text(painter, rect.left() + 18, rect.top() + 61, self.expanded_detail(), 8, QColor("#a1a1a6"), weight=560, anchor="left", max_width=rect.width() - 112)

        center = QPoint(int(rect.right() - 38), int(rect.top() + 42))
        if self.mode == "working":
            self.draw_orbit(painter, center, 17)
            self.draw_progress(painter, rect.left() + 18, rect.top() + 72, rect.right() - 92)
        else:
            pulse = 1.0 + math.sin(self.phase * 2.4) * (0.035 if self.is_alert() else 0.012)
            self.dot(painter, center, 12.0 * pulse, accent)
            if self.is_permission():
                self.permission_ring(painter, center, 22)

        rows = self.sessions[:3] or [{
            "label": "没有活跃会话",
            "state": "idle",
            "updated_at": self.updated_at,
        }]
        start_y = rect.top() + 88
        for idx, session in enumerate(rows):
            y = start_y + idx * 16
            state = str(session.get("state") or "idle")
            color = self.session_color(state)
            label = str(session.get("label") or self.short_session_id(session.get("session_id")))
            badge = self.session_state_label(state)
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor(255, 255, 255, 16 if idx == 0 and state != "idle" else 8))
            row_rect = QRectF(rect.left() + 14, y - 11, rect.width() - 28, 14)
            painter.drawRoundedRect(row_rect, 7, 7)
            self.dot(painter, QPoint(int(rect.left() + 25), int(y - 4)), 2.8, color)
            self.text(painter, rect.left() + 36, y, label, 8, QColor("#e8e8ed"), weight=650, anchor="left", max_width=rect.width() - 142)
            self.text(painter, rect.right() - 20, y, badge, 8, color, weight=700, anchor="right", max_width=76)

    def alert_copy(self):
        if self.signal == "permission":
            return "需要确认", "请在 Codex 中批准权限"
        if self.signal in {"error", "failed", "failure"}:
            return "运行出错", "回到 Codex 查看错误"
        if self.signal in {"blocked", "interrupted", "interrupt"}:
            return "任务已中断", "需要重新开始或处理"
        if self.signal in {"attention", "done"} or self.mode == "attention":
            return "需要关注", "Codex 等待下一步"
        return "需要处理", "Codex 暂停等待你"

    def alert_accent(self):
        if self.is_permission() or self.is_attention():
            return QColor("#ffd45a")
        if self.is_interrupted() and not self.is_error():
            return QColor("#ff7a45")
        return QColor("#ff453a")

    def alert_soft(self):
        if self.is_permission() or self.is_attention():
            return QColor("#ffe2a3")
        if self.is_interrupted() and not self.is_error():
            return QColor("#ffc1a8")
        return QColor("#ffb4ae")

    def draw_progress(self, painter, left, y, right):
        track = QRectF(left, y, right - left, 4)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor("#1c1c1e"))
        painter.drawRoundedRect(track, 2, 2)

        span = right - left
        head = (math.sin(self.phase * 1.35) * 0.5 + 0.5) * span
        start = max(left, left + head - 56)
        end = min(right, left + head + 56)
        grad = QLinearGradient(start, y, end, y)
        grad.setColorAt(0.0, QColor(50, 244, 126, 0))
        grad.setColorAt(0.45, QColor(98, 244, 206, 190))
        grad.setColorAt(1.0, QColor(114, 215, 255, 150))
        painter.setBrush(grad)
        painter.drawRoundedRect(QRectF(start, y, max(6, end - start), 4), 2, 2)

    def sparkles(self, painter, left, top, right, bottom):
        if right <= left:
            return
        colors = [QColor("#72d7ff"), QColor("#62f4ce"), QColor("#ffd45a")]
        for idx in range(2):
            t = (self.phase * 0.16 + idx * 0.46) % 1.0
            x = left + (right - left) * t
            y = top + (bottom - top) * (0.5 + 0.22 * math.sin(self.phase * 1.8 + idx))
            size = 1.2 + 0.7 * (0.5 + 0.5 * math.sin(self.phase * 2.2 + idx))
            c = QColor(colors[idx])
            c.setAlpha(58)
            painter.setPen(Qt.NoPen)
            painter.setBrush(c)
            painter.drawEllipse(QPoint(int(x), int(y)), size, size)

    def permission_ring(self, painter, center, radius):
        painter.setPen(QPen(QColor(255, 212, 90, 68), 1.4))
        painter.setBrush(Qt.NoBrush)
        span = int(120 * 16)
        start = int((-self.phase * 54) * 16)
        painter.drawArc(QRectF(center.x() - radius, center.y() - radius, radius * 2, radius * 2), start, span)

    def draw_orbit(self, painter, center, radius):
        painter.setPen(QPen(QColor(255, 255, 255, 28), 1))
        painter.setBrush(Qt.NoBrush)
        painter.drawEllipse(center, radius, radius)
        colors = [QColor("#72d7ff"), QColor("#32f47e"), QColor("#ffd45a")]
        for idx, color in enumerate(colors):
            angle = self.phase * 1.7 + idx * math.tau / 3
            point = QPoint(
                int(center.x() + math.cos(angle) * radius * 0.58),
                int(center.y() + math.sin(angle) * radius * 0.58),
            )
            self.dot(painter, point, 3.2, color)

    def dot(self, painter, center, radius, color):
        glow = QRadialGradient(center, radius * 2.6)
        c1 = QColor(color)
        c1.setAlpha(78)
        c2 = QColor(color)
        c2.setAlpha(0)
        glow.setColorAt(0.0, c1)
        glow.setColorAt(1.0, c2)
        painter.setPen(Qt.NoPen)
        painter.setBrush(glow)
        painter.drawEllipse(center, radius * 2.6, radius * 2.6)

        painter.setBrush(color)
        painter.drawEllipse(center, radius, radius)

        highlight = QColor("#ffffff")
        highlight.setAlpha(155)
        painter.setBrush(highlight)
        painter.drawEllipse(QPoint(int(center.x() - radius * 0.32), int(center.y() - radius * 0.42)), radius * 0.26, radius * 0.26)

    def text(self, painter, x, y, value, size, color, weight=500, anchor="center", max_width=None):
        font = QFont(self.font_family, size)
        font.setWeight(QFont.Weight(int(weight)))
        painter.setFont(font)
        painter.setPen(color)
        value = str(value)
        if max_width is not None:
            value = painter.fontMetrics().elidedText(value, Qt.ElideRight, max(1, int(max_width)))
        if anchor == "left":
            painter.drawText(QPoint(int(x), int(y)), value)
        elif anchor == "right":
            width = painter.fontMetrics().horizontalAdvance(value)
            painter.drawText(QPoint(int(x - width), int(y)), value)
        else:
            painter.drawText(QRectF(x - 80, y - 12, 160, 24), Qt.AlignCenter, value)


if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    island = Island()
    app.setWindowIcon(island.tray_icon())
    island.show()
    sys.exit(app.exec())
