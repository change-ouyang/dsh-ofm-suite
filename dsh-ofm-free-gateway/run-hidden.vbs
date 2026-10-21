' run-hidden.vbs -- start the gateway with NO visible console window.
'
' Why this is needed:
'   DSH (Electron) is a GUI app with no console of its own. A cmd.exe spawned
'   from it has no console either, so `node server.mjs` ALLOCATES A VISIBLE
'   CONSOLE of its own -- that is the "node server.mjs" black window. Closing
'   that window kills node AND cmd, taking the gateway down with it.
'
'   WSH.Shell.Run with window style 0 (== CREATE_NO_WINDOW) gives cmd a console
'   that has no window, so node inherits it instead of allocating its own:
'   measured 0 visible windows, and the gateway still answers requests.
'
' The real command line comes from start.bat via the OFM_INNER_CMD env var
' (path of the inner .cmd).

Option Explicit

Dim sh, inner, cmdLine, fso, logPath, f

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Leave a breadcrumb: a silent failure here is very hard to see.
logPath = fso.BuildPath(fso.GetSpecialFolder(2), "run-hidden.log")

inner = sh.ExpandEnvironmentStrings("%OFM_INNER_CMD%")

Set f = fso.CreateTextFile(logPath, True)
f.WriteLine "--- " & Now & " ---"
f.WriteLine "OFM_INNER_CMD = [" & inner & "]"
f.WriteLine "OFM_ARGS      = [" & sh.ExpandEnvironmentStrings("%OFM_ARGS%") & "]"
f.WriteLine "OFM_OUT_LOG   = [" & sh.ExpandEnvironmentStrings("%OFM_OUT_LOG%") & "]"
f.WriteLine "OFM_ERR_LOG   = [" & sh.ExpandEnvironmentStrings("%OFM_ERR_LOG%") & "]"
f.Close

If inner = "" Or inner = "%OFM_INNER_CMD%" Then
  WScript.Echo "OFM_INNER_CMD is not set; run start.bat instead of this vbs directly."
  WScript.Quit 1
End If

' Chr(34) is a double quote. With /c the path must be wrapped in a pair of
' quotes so that spaces in it do not split the command line.
cmdLine = "cmd.exe /d /c " & Chr(34) & Chr(34) & inner & Chr(34) & Chr(34)

Set f = fso.CreateTextFile(logPath, True)
f.WriteLine "--- " & Now & " ---"
f.WriteLine "cmdLine = " & cmdLine
f.Close

' 0 = hidden window (CREATE_NO_WINDOW); False = do not wait, so cmd keeps
' running independently of this script.
sh.Run cmdLine, 0, False
