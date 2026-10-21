@echo off
rem ofm-free-gateway launcher (Windows)
rem Usage: start.bat [--port 18900] [--data-dir D:\ofm-data] [--key <API Key>]
rem
rem Runs the gateway in the BACKGROUND with NO console window.
rem
rem Why it used to pop up a black window:
rem   DSH (Electron) is a GUI app with no console of its own. It spawns this
rem   script with DETACHED_PROCESS, so cmd.exe ends up with NO console at all;
rem   the script then runs `node server.mjs`, and node ALLOCATES A VISIBLE
rem   CONSOLE of its own -- that is the "node server.mjs" window you saw.
rem
rem   Worse: closing that window (clicking the X) kills node AND cmd, so the
rem   gateway dies with it.
rem
rem Now the real launch goes through wscript.exe (WSH.Shell) with window style
rem 0 == CREATE_NO_WINDOW. cmd then gets a console with no visible window and
rem node inherits it instead of allocating its own -- measured: 0 windows,
rem and the gateway still answers requests.
rem
rem Logs: <data-dir>\gw.out.log and gw.err.log (overwritten on each start).
rem For live output while debugging, use start-console.bat (keeps a window).

setlocal

rem --- the script's own directory -------------------------------------------
rem MUST be captured before any `shift`: after a shift, %~dp0 expands to the
rem PARENT of the script dir and %~0 expands to an argument (cmd quirk).
set "OFM_GW_DIR=%~dp0"

rem Work from the gateway dir. server.mjs resolves a relative --data-dir
rem against its own cwd, and run-inner.cmd cds there too -- so doing it here
rem keeps the log path and the server's data dir identical.
cd /d "%OFM_GW_DIR%"

rem --- pick up --data-dir so the logs land in the SAME dir the gateway uses ---
rem Labels (not a parenthesised block): %1 inside a block is expanded at parse
rem time, which would break the argument pairing.
set "OFM_DATA_DIR_ARG="
:parse_args
if "%~1"=="" goto parse_done
if /i not "%~1"=="--data-dir" goto parse_next
shift
set "OFM_DATA_DIR_ARG=%~1"
goto parse_args
:parse_next
shift
goto parse_args
:parse_done

if defined OFM_DATA_DIR_ARG (
  set "OFM_DATA_DIR=%OFM_DATA_DIR_ARG%"
) else if defined OFM_HOME (
  set "OFM_DATA_DIR=%OFM_HOME%"
) else (
  rem Default: a sibling of this script's directory, i.e. <repo>\.ofm-free-gateway.
  rem Relative on purpose -- move the whole repo folder and the data follows.
  rem %OFM_GW_DIR% (saved before any `shift`) is used instead of %~dp0, which the
  rem argument loop above would have corrupted.
  set "OFM_DATA_DIR=%OFM_GW_DIR%..\.ofm-free-gateway"
)

rem %%~fI = fully qualified path: same result as server.mjs's path.resolve().
rem This also collapses the ".." in the fallback above.
for %%I in ("%OFM_DATA_DIR%") do set "OFM_DATA_DIR=%%~fI"

if not exist "%OFM_DATA_DIR%" mkdir "%OFM_DATA_DIR%" >nul 2>&1

rem Publish the resolved dir as OFM_HOME so every descendant agrees on it --
rem server.mjs and scripts/*.mjs all read OFM_HOME. Without this, run-inner.cmd
rem would start server.mjs with no --data-dir and it would fall back to
rem ~/.ofm-free-gateway, splitting logs and credentials across two directories.
set "OFM_HOME=%OFM_DATA_DIR%"

rem --- env vars: inherited by wscript and its descendants -------------------
rem Arguments travel as-is, so no quoting/escaping games are needed.
set "OFM_INNER_CMD=%OFM_GW_DIR%run-inner.cmd"
set "OFM_ARGS=%*"
set "OFM_OUT_LOG=%OFM_DATA_DIR%\gw.out.log"
set "OFM_ERR_LOG=%OFM_DATA_DIR%\gw.err.log"

rem --- launch ---------------------------------------------------------------
rem //nologo: skip wscript's own banner.
rem wscript is a GUI app and Run(..., False) is async, so this does not block.
"%SystemRoot%\System32\wscript.exe" //nologo "%OFM_GW_DIR%run-hidden.vbs"
exit /b 0
