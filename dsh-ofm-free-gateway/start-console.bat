@echo off
rem ofm-free-gateway -- FOREGROUND launcher (keeps a console window).
rem
rem Only for debugging: use this when you want to watch the gateway log live,
rem or when the gateway refuses to start and you need to see why.
rem For normal use, use start.bat (background, silent, no window).
rem
rem Usage: start-console.bat [--port 18900] [--data-dir <目录>]

cd /d "%~dp0"

rem Same data dir as start.bat: a sibling of this directory.
rem OFM_HOME is how server.mjs and scripts/*.mjs learn where the data lives.
if not defined OFM_HOME (
  for %%I in ("%~dp0..\.ofm-free-gateway") do set "OFM_HOME=%%~fI"
)

rem Locate node: PATH first, then the optional OFM_NODE_PATH override.
set "OFM_NODE=node"
where node >nul 2>&1
if errorlevel 1 if defined OFM_NODE_PATH if exist "%OFM_NODE_PATH%" set "OFM_NODE=%OFM_NODE_PATH%"
if errorlevel 1 (
  echo [ofm] node not found in PATH. Set OFM_NODE_PATH to your node.exe and retry. 1>&2
  exit /b 1
)

"%OFM_NODE%" server.mjs %*
