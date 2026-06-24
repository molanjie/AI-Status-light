@echo off
cd /d "%~dp0"
for /f "tokens=2 delims==;" %%p in ('wmic process where "name='pythonw.exe' and commandline like '%%dynamic_island.py%%'" get processid /value ^| find "="') do taskkill /pid %%p /f >nul 2>nul
start "Mini Watch Dynamic Island" pythonw dynamic_island.py
