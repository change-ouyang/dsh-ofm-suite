@echo off
rem Daily one-shot check-in for ofm-free-gateway.
rem Registered by the user; safe to run repeatedly (exits at once if today is done
rem or if the resident gateway is already running).
rem Output is appended to checkin.log in the DATA dir (not next to this file),
rem so the source tree stays clean.
rem Data dir: the same one start.bat uses (a sibling of this directory), so the
rem task and the resident gateway never read two different credential stores.
if not defined OFM_HOME (
  for %%I in ("%~dp0..\.ofm-free-gateway") do set "OFM_HOME=%%~fI"
)

rem Locate node: PATH first, then the optional OFM_NODE_PATH override.
set "OFM_NODE=node"
where node >nul 2>&1
if errorlevel 1 if defined OFM_NODE_PATH if exist "%OFM_NODE_PATH%" set "OFM_NODE=%OFM_NODE_PATH%"
if errorlevel 1 (
  echo [ofm] node not found in PATH. Set OFM_NODE_PATH to your node.exe. 1>&2
  exit /b 1
)

"%OFM_NODE%" "%~dp0scripts\checkin-once.mjs" >> "%OFM_HOME%\checkin.log" 2>&1
