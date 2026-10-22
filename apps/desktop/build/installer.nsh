; OrbitDrop NSIS customisation (included automatically by electron-builder).
; Always install for the current user only: no administrator rights, no UAC prompt,
; no "install for all users" page. Files go to %LOCALAPPDATA%\Programs\OrbitDrop by default
; and the folder can be changed on the directory page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Uninstall: remove the "launch at login" entry OrbitDrop writes when the user enables it
; (Electron's setLoginItemSettings: HKCU ...\Run, value name = the AppUserModelID = appId), and the
; StartupApproved value Task Manager adds when it is switched off there. Otherwise Windows keeps a
; startup entry pointing at the deleted OrbitDrop.exe. Not on an upgrade: the installer of a newer
; version runs this uninstaller with --updated, and the login item must survive that.
; App data (%APPDATA%\OrbitDrop) is kept unless the uninstaller gets --delete-app-data.
!macro customUnInstall
  Push $R8
  Push $R9
  ${GetParameters} $R8
  ClearErrors
  ${GetOptions} $R8 "--updated" $R9
  ${if} ${Errors}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endif}
  ClearErrors
  Pop $R9
  Pop $R8
!macroend
