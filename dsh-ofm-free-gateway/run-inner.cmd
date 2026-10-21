@echo off
rem run-inner.cmd -- the layer that actually runs the gateway.
rem Invoked by run-hidden.vbs via wscript with a hidden window, so no black
rem console ever appears.
rem
rem Env vars (set by start.bat, inherited through wscript):
rem   OFM_ARGS      arguments forwarded to server.mjs
rem   OFM_OUT_LOG   stdout destination
rem   OFM_ERR_LOG   stderr destination

cd /d "%~dp0"

rem Fall back to OFM_NODE_PATH when node is not on PATH.
set "OFM_NODE=node"
where node >nul 2>&1
if errorlevel 1 if defined OFM_NODE_PATH if exist "%OFM_NODE_PATH%" set "OFM_NODE=%OFM_NODE_PATH%"
if errorlevel 1 (
  echo [ofm] node not found in PATH. Set OFM_NODE_PATH to your node.exe. 1>&2
  exit /b 1
)

rem Overwrite the logs on each start (> instead of >>) so stale output is gone.
"%OFM_NODE%" server.mjs %OFM_ARGS% 1>"%OFM_OUT_LOG%" 2>"%OFM_ERR_LOG%"
