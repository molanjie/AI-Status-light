@echo off
cd /d "%~dp0"

if exist gradlew.bat (
  call gradlew.bat :app:assembleDebug
  goto :done
)

where gradle >nul 2>nul
if %errorlevel%==0 (
  call gradle :app:assembleDebug
  goto :done
)

echo.
echo [ERROR] Gradle not found.
echo Install Android Studio, open this folder once, then build the app from Android Studio.
echo Project folder: %cd%
exit /b 1

:done
echo.
echo APK: app\build\outputs\apk\debug\app-debug.apk
