@echo off
rem Build the desktop app (Windows). Output: dist\SceneDialog\SceneDialog.exe
rem Requires: python -m venv .venv && .venv\Scripts\pip install pywebview pyinstaller anthropic
cd /d "%~dp0\.."
if not exist ".venv\Scripts\pyinstaller.exe" (
  echo [build] creating .venv and installing pywebview + pyinstaller + anthropic ...
  python -m venv .venv || exit /b 1
  ".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check pywebview pyinstaller anthropic || exit /b 1
)
rem spec/ carries plan.schema.json (the AI prompt's grammar table is generated from it at runtime) and examples/plans
".venv\Scripts\pyinstaller.exe" --noconfirm --clean --windowed --name SceneDialog ^
  --add-data "medium;medium" --add-data "spec;spec" --add-data "tools;tools" ^
  --paths desktop --paths tools --hidden-import ai --hidden-import plans --hidden-import rules --hidden-import providers --hidden-import score_readback ^
  --collect-all webview --collect-all clr_loader --collect-all pythonnet --collect-all anthropic ^
  desktop\app.py
if errorlevel 1 exit /b 1
echo.
echo [build] done: dist\SceneDialog\SceneDialog.exe
