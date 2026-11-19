@echo off
title Clipper Setup
setlocal EnableDelayedExpansion
set "WORK=%USERPROFILE%\ClipperApp"
if not exist "%WORK%" mkdir "%WORK%"
cd /d "%WORK%"

REM ---------- 1) Own Node.js LTS (v24) — does not touch the system Node ----------
if not exist "%WORK%\node\node.exe" (
  echo.
  echo == Node.js download ho raha hai (sirf pehli dafa)... ==
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$list = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/').Content; if ($list -match '(node-v24[^\"]*-win-x64\.zip)') { $f = $Matches[1] } else { exit 1 }; Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/latest-v24.x/' + $f) -OutFile 'node.zip'; Expand-Archive -Force 'node.zip' 'node-extract'"
  if errorlevel 1 goto fail
  for /d %%D in ("node-extract\node-*") do move "%%D" "node" >nul
  rmdir /s /q node-extract
  del node.zip
)
set "PATH=%WORK%\node;%PATH%"
for /f %%V in ('node -v') do echo Node: %%V

REM ---------- 2) Clipper code from GitHub ----------
if not exist "%WORK%\clipper-main\package.json" (
  echo.
  echo == Clipper download ho raha hai... ==
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://github.com/Danyalmalik2770/clipper/archive/refs/heads/main.zip' -OutFile 'clipper.zip'; Expand-Archive -Force 'clipper.zip' '.'"
  if errorlevel 1 goto fail
  del clipper.zip
)
cd /d "%WORK%\clipper-main"

REM ---------- 3) Install (first time / after an interrupted install) ----------
if not exist "node_modules\.clipper-setup-done" (
  echo.
  echo == Clipper install ho raha hai - kuch minute lage ge. Window band mat karna. ==
  call npm install
  if errorlevel 1 goto fail
  if not exist "node_modules\electron\path.txt" node node_modules\electron\install.js
  if not exist "node_modules\ffmpeg-static\ffmpeg.exe" node node_modules\ffmpeg-static\install.js
  for /f %%V in ('node -p "require('./node_modules/electron/package.json').version"') do set "EV=%%V"
  if defined EV (
    pushd node_modules\better-sqlite3
    call npx --yes prebuild-install --runtime electron --target !EV!
    popd
  )
  echo done> "node_modules\.clipper-setup-done"
  echo == Install mukammal. ==
)

REM ---------- 4) Run ----------
echo.
echo == Clipper khul raha hai... ==
call npm run dev
echo.
echo Clipper band ho gaya. Dobara kholne ke liye bas is file ko phir double-click karna hai.
pause
exit /b 0

:fail
echo.
echo MASLA: Kuch fail ho gaya. Internet check karo aur is file ko dobara double-click karo - kaam wahi se aage barhe ga.
pause
exit /b 1
