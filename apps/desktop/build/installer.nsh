; OrbitDrop NSIS customisation (included automatically by electron-builder).
; Always install for the current user only: no administrator rights, no UAC prompt,
; no "install for all users" page. Files go to %LOCALAPPDATA%\Programs\OrbitDrop by default
; and the folder can be changed on the directory page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
