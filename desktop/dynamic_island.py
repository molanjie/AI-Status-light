"""
Codex 红绿灯 - Windows 桌面灵动岛
任务栏右侧吸附，5 种状态：idle / processing / waiting / offline / error
通过 HTTP 轮询 http://localhost:3456/api/status 驱动状态变化
"""

import ctypes
import json
import math
import sys
import threading
import time
import urllib.error
import urllib.request
from ctypes import wintypes

from PySide6.QtCore import QPoint, QRect, QRectF, Qt, QTimer
from PySide6.QtGui import (
    QAction, QColor, QFont, QFontDatabase,
    QLinearGradient, QPainter, QPainterPath, QPen, QPixmap,
    QRadialGradient, QIcon,
)
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon, QWidget


# ─── 配置 ────────────────────────────────────────────────────────────────

API_URL = "http://localhost:3456/api/status"
TRAY_GAP = 10
TRAY_FALLBACK_WIDTH = 260
POLL_INTERVAL_MS = 2000
TICK_MS = 16

# 状态颜色映射（与 public/index.html 保持一致）
STATE_COLORS = {
    "idle":       "#32f47e",  # 绿色
    "processing": "#ff453a",  # 红色
    "waiting":    "#ffd60a",  # 黄色
    "offline":    "#8e8e93",  # 灰色
    "error":      "#ff7a45",  # 橙色
}

STATE_LABELS = {
    "idle":       "空闲",
    "processing": "正在处理",
    "waiting":    "等待输入",
    "offline":    "离线",
    "error":      "异常",
}


# ─── Island 主类 ─────────────────────────────────────────────────────────

class Island(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Codex 红绿灯")
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.WindowStaysOnTopHint
            | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setMouseTracking(True)

        # 状态
        self.state = "idle"
        self.signal = "idle"
        self.sessions = []
        self.session_count = 0
        self.updated_at = 0
        self.online = False
        self.error_msg = ""

        # 动画
        self.phase = 0.0
        self.drag_offset = None
        self.locked = False
        self.hovered = False
        self.needs_tray_update = True

        # 系统托盘
        self.tray = None
        self.tray_status_action = None
        self.tray_lock_action = None

        # 尺寸
        self.outer_w = 100.0
        self.outer_h = 28.0
        self.target_w = self.outer_w
        self.target_h = self.outer_h

        self.canvas_pad_x = 14
        self.canvas_pad_top = 8
        self.canvas_pad_bottom = 14
        self.min_canvas_w = 128
        self.min_canvas_h = 56

        # 屏幕 / 任务栏
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

        # 动画定时器
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(TICK_MS)

        # HTTP 轮询
        self.fetch_timer = QTimer(self)
        self.fetch_timer.timeout.connect(self.fetch_state)
        self.fetch_timer.start(POLL_INTERVAL_MS)

        self.setup_tray()
        self.fetch_state()

    # ─── 字体 ─────────────────────────────────────────────────────────

    def pick_font(self):
        preferred = ["Microsoft YaHei UI", "Segoe UI Variable", "Segoe UI"]
        families = set(QFontDatabase.families())
        for family in preferred:
            if family in families:
                return family
        return QApplication.font().family()

    # ─── 系统托盘 ─────────────────────────────────────────────────────

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
        if self.session_count:
            parts.append(f"{self.session_count} 会话")
        return " · ".join(parts)

    def tray_lock_text(self):
        return "解除锁定位置" if self.locked else "锁定位置"

    def tray_tooltip(self):
        parts = [f"Codex 红绿灯 - {self.status_label()}"]
        if self.session_count:
            parts.append(f"{self.session_count} 会话")
        return " · ".join(parts)

    def tray_color(self):
        if self.state in STATE_COLORS:
            c = QColor(STATE_COLORS[self.state])
        else:
            c = QColor("#8e8e93")
        if not self.online:
            c = QColor("#8e8e93")
        return c

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

    # ─── 网络（HTTP 轮询，无 WebSocket） ──────────────────────────────

    def fetch_state(self):
        threading.Thread(target=self._fetch, daemon=True).start()

    def _fetch(self):
        try:
            req = urllib.request.Request(API_URL, headers={"cache-control": "no-store"})
            with urllib.request.urlopen(req, timeout=1.5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            self._apply(data, online=True)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
            self._apply_offline()

    def _apply(self, data, online):
        state = data.get("state") or "error"
        if state not in STATE_COLORS:
            state = "error"

        sessions = data.get("sessions") or []
        session_count = data.get("sessionCount") or len(sessions)
        updated_at = data.get("updatedAt") or int(time.time() * 1000)
        error_msg = data.get("error") or ""

        changed = (
            state != self.state
            or online != self.online
            or session_count != self.session_count
        )
        self.state = state
        self.signal = state
        self.sessions = sessions
        self.session_count = session_count
        self.updated_at = updated_at
        self.online = online
        self.error_msg = error_msg
        if changed:
            self.needs_tray_update = True

    def _apply_offline(self):
        if self.online:
            self.state = "offline"
            self.online = False
            self.needs_tray_update = True

    # ─── 状态查询 ─────────────────────────────────────────────────────

    def status_label(self):
        return STATE_LABELS.get(self.state, "未知")

    def is_processing(self):
        return self.state == "processing"

    def is_waiting(self):
        return self.state == "waiting"

    def is_error(self):
        return self.state == "error"

    def is_offline(self):
        return self.state == "offline"

    def is_idle(self):
        return self.state == "idle"

    def is_alert(self):
        return self.state in ("waiting", "error", "offline")

    def accent_color(self):
        return QColor(STATE_COLORS.get(self.state, "#8e8e93"))

    def soft_color(self):
        c = QColor(STATE_COLORS.get(self.state, "#8e8e93"))
        c.setAlpha(160)
        return c

    # ─── 动画 / 布局 ──────────────────────────────────────────────────

    def tick(self):
        self.phase += 0.024
        self.target_w, self.target_h = self._target_size()
        self.outer_w += (self.target_w - self.outer_w) * 0.16
        self.outer_h += (self.target_h - self.outer_h) * 0.16
        self.update_window_frame()
        if self.needs_tray_update:
            self.update_tray()
            self.needs_tray_update = False
        self.update()

    def _target_size(self):
        if self.hovered:
            return 320.0, 108.0
        if self.is_processing():
            return 156.0, 32.0
        if self.is_waiting() or self.is_error() or self.is_offline():
            return 175.0, 34.0
        if self.session_count > 0:
            return 136.0, 30.0
        return 100.0, 28.0

    def canvas_size(self):
        width = max(self.min_canvas_w, int(math.ceil(self.outer_w + self.canvas_pad_x * 2)))
        height = max(self.min_canvas_h, int(math.ceil(self.outer_h + self.canvas_pad_top + self.canvas_pad_bottom)))
        max_w = self.max_island_width()
        if width > max_w:
            width = max_w
        return width, height

    def max_island_width(self):
        if self.taskbar_edge not in {"top", "bottom"}:
            return 9999
        tray_left = self.tray_boundary
        if tray_left is None:
            taskbar_right = self.taskbar_rect.x() + self.taskbar_rect.width()
            tray_left = taskbar_right - TRAY_FALLBACK_WIDTH
        raw_max = tray_left - self.taskbar_rect.x() - TRAY_GAP
        if not self.hovered and self.outer_h < 80:
            return min(raw_max, 220)
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
        self.tray_boundary = self._system_tray_left(rect) if edge in {"top", "bottom"} else None
        if reset_axis or not self.dock_axis_pos:
            self.dock_axis_pos = self._default_dock_axis()

    def _system_tray_left(self, taskbar_rect):
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

    def _default_dock_axis(self):
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
            maximum = self._default_dock_axis()
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

    # ─── 交互 ─────────────────────────────────────────────────────────

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
                title = session.get("title") or "未命名会话"
                st = session.get("state") or "idle"
                label = STATE_LABELS.get(st, st)
                session_action = QAction(f"{title}：{label}", self)
                session_action.setEnabled(False)
                menu.addAction(session_action)

        menu.addSeparator()
        lock_action = QAction("解除锁定位置" if self.locked else "锁定位置", self)
        lock_action.triggered.connect(self.toggle_lock)
        menu.addAction(lock_action)
        home_action = QAction("回到任务栏右侧", self)
        home_action.triggered.connect(self.return_home)
        menu.addAction(home_action)
        menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(QApplication.quit)
        menu.addAction(quit_action)
        menu.exec(event.globalPos())

    def toggle_lock(self):
        self.locked = not self.locked
        if self.locked:
            self.dock_to_taskbar()
        self.needs_tray_update = True

    def return_home(self):
        self.manual_dock_position = False
        self.refresh_taskbar_geometry(reset_axis=True)
        self.dock_to_taskbar()

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

    # ─── 绘制 ─────────────────────────────────────────────────────────

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

        self._draw_shadow(painter, rect)
        self._draw_shell(painter, rect)

        painter.save()
        painter.setClipPath(self._shell_path(rect))
        self._draw_ambient(painter, rect)

        if self._is_expanded():
            self._draw_expanded(painter, rect)
        else:
            self._draw_compact(painter, rect)
        painter.restore()

    def _shell_path(self, rect):
        path = QPainterPath()
        path.addRoundedRect(rect, rect.height() / 2, rect.height() / 2)
        return path

    def _draw_shadow(self, painter, rect):
        for i, alpha in enumerate([34, 18, 8], start=1):
            glow_rect = rect.adjusted(-i * 5, i * 3, i * 5, i * 7)
            c = QColor(0, 0, 0, alpha + (5 if self._is_expanded() else 0))
            painter.setPen(Qt.NoPen)
            painter.setBrush(c)
            painter.drawRoundedRect(glow_rect, glow_rect.height() / 2, glow_rect.height() / 2)

        if self.is_alert() or self.is_processing():
            accent = self.accent_color()
            accent.setAlpha(13 if self._is_expanded() else 9)
            painter.setPen(QPen(accent, 1.0))
            painter.setBrush(Qt.NoBrush)
            halo = rect.adjusted(-2, -1, 2, 2)
            painter.drawRoundedRect(halo, halo.height() / 2, halo.height() / 2)

    def _draw_shell(self, painter, rect):
        body = QLinearGradient(rect.left(), rect.top(), rect.left(), rect.bottom())
        body.setColorAt(0.0, QColor("#1d1d20"))
        body.setColorAt(0.18, QColor("#0b0b0d"))
        body.setColorAt(0.58, QColor("#050506"))
        body.setColorAt(1.0, QColor("#020203"))
        painter.setPen(QPen(QColor(255, 255, 255, 42 if self._is_expanded() else 30), 1))
        painter.setBrush(body)
        painter.drawRoundedRect(rect, rect.height() / 2, rect.height() / 2)

        shine = QRectF(rect.left() + 1, rect.top() + 1, rect.width() - 2, max(8, rect.height() * 0.34))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(255, 255, 255, 18 if self._is_expanded() else 13))
        painter.drawRoundedRect(shine, shine.height() / 2, shine.height() / 2)

    def _draw_ambient(self, painter, rect):
        if self.is_processing():
            scan_x = rect.left() + ((math.sin(self.phase * 1.15) * 0.5 + 0.5) * rect.width())
            grad = QLinearGradient(scan_x - 44, rect.top(), scan_x + 44, rect.top())
            grad.setColorAt(0.0, QColor(255, 255, 255, 0))
            grad.setColorAt(0.5, QColor(255, 255, 255, 10))
            grad.setColorAt(1.0, QColor(255, 255, 255, 0))
            painter.setPen(Qt.NoPen)
            painter.setBrush(grad)
            painter.drawRoundedRect(QRectF(scan_x - 44, rect.top() + 1, 88, rect.height() - 2), rect.height() / 2, rect.height() / 2)
        elif self.is_alert():
            alpha = 12 + int(6 * (math.sin(self.phase * 2.3) * 0.5 + 0.5))
            painter.setPen(QPen(self.accent_color().lighter(120), 1.2))
            painter.setBrush(Qt.NoBrush)
            painter.drawRoundedRect(rect.adjusted(1.5, 1.5, -1.5, -1.5), rect.height() / 2, rect.height() / 2)

    def _is_expanded(self):
        return self.hovered or self.outer_h > 92

    # ─── 紧凑模式绘制 ─────────────────────────────────────────────────

    def _draw_compact(self, painter, rect):
        color = self.accent_color()
        if not self.online:
            color = QColor("#8e8e93")

        label = self.status_label()
        if self.is_idle() and not self.session_count:
            label = "Codex"
        else:
            count_str = f"{self.session_count} 会话" if self.session_count else ""
            if count_str:
                label = f"{label} · {count_str}"

        self._dot(painter, QPoint(int(rect.left() + 20), int(rect.center().y())), 4.5, color)
        text_right = rect.right() - (26 if self.locked else 12)
        self._text(
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
            self._text(painter, rect.right() - 16, rect.center().y() + 3, "锁", 7, QColor("#77777d"), weight=600, anchor="center")
        if self.is_processing():
            self._draw_progress(painter, rect.left() + 34, rect.bottom() - 5, rect.right() - 12)

    # ─── 展开模式绘制 ─────────────────────────────────────────────────

    def _draw_expanded(self, painter, rect):
        accent = self.accent_color()
        online_text = "在线" if self.online else "离线"
        meta = f"{self.session_count} 会话" if self.session_count else "无活跃会话"
        header = f"Codex · {meta} · {online_text}"
        self._text(painter, rect.left() + 18, rect.top() + 20, header, 8, QColor("#a1a1a6"), weight=700, anchor="left", max_width=rect.width() - 94)
        self._text(painter, rect.left() + 18, rect.top() + 45, self.status_label(), 15, QColor("#f5f5f7"), weight=780, anchor="left", max_width=rect.width() - 112)
        self._text(painter, rect.left() + 18, rect.top() + 61, self._expanded_detail(), 8, QColor("#a1a1a6"), weight=560, anchor="left", max_width=rect.width() - 112)

        center = QPoint(int(rect.right() - 38), int(rect.top() + 42))
        if self.is_processing():
            self._draw_orbit(painter, center, 17)
            self._draw_progress(painter, rect.left() + 18, rect.top() + 72, rect.right() - 92)
        else:
            pulse = 1.0 + math.sin(self.phase * 2.4) * (0.035 if self.is_alert() else 0.012)
            self._dot(painter, center, 12.0 * pulse, accent)

        rows = self._session_rows()
        start_y = rect.top() + 88
        for idx, (label, state, is_default) in enumerate(rows):
            y = start_y + idx * 16
            color = self._session_color(state)
            badge = STATE_LABELS.get(state, "空闲")
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor(255, 255, 255, 16 if idx == 0 and not is_default else 8))
            row_rect = QRectF(rect.left() + 14, y - 11, rect.width() - 28, 14)
            painter.drawRoundedRect(row_rect, 7, 7)
            self._dot(painter, QPoint(int(rect.left() + 25), int(y - 4)), 2.8, color)
            self._text(painter, rect.left() + 36, y, label, 8, QColor("#e8e8ed"), weight=650, anchor="left", max_width=rect.width() - 142)
            self._text(painter, rect.right() - 20, y, badge, 8, color, weight=700, anchor="right", max_width=76)

    def _expanded_detail(self):
        if self.is_processing():
            return "红绿灯循环，任务正在执行"
        if self.is_waiting():
            return "Codex 等待你的输入"
        if self.is_error():
            return "回到 Codex 查看错误详情"
        if self.is_offline():
            return "无法连接到本地服务"
        if self.session_count:
            return "绿灯常亮，系统空闲"
        return "暂无活跃会话"

    def _session_rows(self):
        if not self.sessions:
            return [("没有活跃会话", "idle", True)]
        rows = []
        for s in self.sessions[:3]:
            title = s.get("title") or "未命名会话"
            st = s.get("state") or "idle"
            rows.append((title, st, False))
        return rows or [("没有活跃会话", "idle", True)]

    def _session_color(self, state):
        if state in STATE_COLORS:
            return QColor(STATE_COLORS[state])
        return QColor("#8e8e93")

    # ─── 绘制基元 ─────────────────────────────────────────────────────

    def _draw_progress(self, painter, left, y, right):
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

    def _draw_orbit(self, painter, center, radius):
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
            self._dot(painter, point, 3.2, color)

    def _dot(self, painter, center, radius, color):
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

    def _text(self, painter, x, y, value, size, color, weight=500, anchor="center", max_width=None):
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


# ─── 入口 ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    island = Island()
    app.setWindowIcon(island.tray_icon())
    island.show()
    sys.exit(app.exec())
