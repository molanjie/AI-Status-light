# Mini Watch Codex Android

这是 Codex 红绿灯的 Android 原生壳。App 内部使用系统 WebView 打开电脑上的 Mini Watch 页面，避免小米/安卓浏览器地址栏和布局兼容问题。

## 默认地址

默认连接公网地址：

```text
https://steal-position-pontiac-focusing.trycloudflare.com/phone?app=android
```

如果公网隧道地址变了，在 App 页面里长按任意位置，可以修改服务器地址。

## 功能

- 全屏 WebView，无浏览器地址栏
- 支持横屏和竖屏
- 支持公网 HTTPS 连接，也兼容局域网 HTTP 连接
- 屏幕保持常亮
- 断线时显示原生重试页
- 长按页面修改服务器地址

## 构建 APK

用 Android Studio 打开本目录：

```text
android-app
```

然后执行：

```text
Build > Build Bundle(s) / APK(s) > Build APK(s)
```

生成的 APK 通常在：

```text
app/build/outputs/apk/debug/app-debug.apk
```

如果本机已经安装 Gradle 和 Android SDK，也可以双击：

```text
build-apk.bat
```

## 安装到手机

有 adb 时可以运行：

```text
install-debug.bat
```

也可以把 `app-debug.apk` 发到手机上手动安装。
