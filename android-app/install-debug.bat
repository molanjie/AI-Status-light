@echo off
cd /d "%~dp0"
set APK=app\build\outputs\apk\debug\app-debug.apk

if not exist "%APK%" (
  echo [ERROR] APK not found: %APK%
  echo Run build-apk.bat or build Debug APK in Android Studio first.
  exit /b 1
)

where adb >nul 2>nul
if not %errorlevel%==0 (
  echo [ERROR] adb not found. Install Android SDK Platform Tools first.
  exit /b 1
)

adb install -r "%APK%"
