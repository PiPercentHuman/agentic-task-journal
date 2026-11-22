' Runs `board sync` with no window. Windows Task Scheduler starts it on a timer (set up by `node bin/setup.mjs`), so
' phone edits reach the PC and the PC's board reaches GitHub while no chat is open.
' Argument 1 (optional): the full path of node.exe; a scheduled task may not have node on its PATH.
' Every run's outcome is the last line of ~/.agentic-task-journal/sync.log.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
node = "node"
If WScript.Arguments.Count > 0 Then node = WScript.Arguments(0)
CreateObject("WScript.Shell").Run """" & node & """ """ & here & "\board.mjs"" sync", 0, True
