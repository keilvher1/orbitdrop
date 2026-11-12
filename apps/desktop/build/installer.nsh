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
; installer-preferences.json (below) goes with the installation folder, which the uninstaller
; removes as a whole.
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

; ------------------------------------------------------------------------------------------------
; Privacy notice and the automatic update check (installer only).
;
; OrbitDrop's only network use is the automatic update check against GitHub (on by default). An
; interactive install shows a short privacy notice after the folder page, in the installer's
; language, with a link to the privacy statement and the box "업데이트 자동 확인 / Check for updates
; automatically" (ticked). Unattended installs keep the default; `/NOUPDATECHECK` turns it off:
;   OrbitDrop-<version>-win-x64-setup.exe /S /NOUPDATECHECK
; The choice is written to $INSTDIR\installer-preferences.json:
;   {"version":1,"updates":{"autoCheck":true|false}}
; The app reads it on its first run only (no settings file yet) and never lets it override settings
; that exist (apps/desktop/src/main/settings/installer-preferences.ts). An update installed by the
; app itself (--updated) shows no page and writes the default; the app has settings by then.
; The page functions live inside customPageAfterChangeDir: electron-builder inserts that macro after
; MUI2/LogicLib/FileFunc are included, while this file itself is included before them.
; Nothing of this is compiled into the uninstaller (makensis runs with -WX: unused code would fail).
; ------------------------------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER
  !define ORBITDROP_PREFERENCES_FILE "installer-preferences.json"

  Var orbitdropUpdateCheck ; "1" = automatic update checks on (default), "0" = off
  Var orbitdropUpdateCheckBox

  ; Language ids as electron-builder writes its own messages (1042 Korean, 1033 English).
  LangString orbitdropPrivacyTitle 1042 "개인정보와 업데이트"
  LangString orbitdropPrivacyTitle 1033 "Privacy and updates"
  LangString orbitdropPrivacySubtitle 1042 "OrbitDrop이 인터넷을 쓰는 곳을 확인하세요."
  LangString orbitdropPrivacySubtitle 1033 "When OrbitDrop uses the internet."
  LangString orbitdropPrivacyText 1042 "OrbitDrop은 파일을 이 컴퓨터에서만 처리합니다. 파일, 파일 이름, 사용 기록은 어디로도 보내지 않습니다.$\r$\n$\r$\n인터넷을 쓰는 곳은 업데이트 자동 확인 하나뿐입니다. 켜 두면 실행 1분 뒤와 그 뒤 6시간마다 GitHub(github.com)에 새 버전이 있는지 묻습니다. 이때 GitHub에는 IP 주소 같은 일반 접속 정보와 이 운영체제용 업데이트 파일 요청만 전달되며, 기기 식별자는 보내지 않습니다. 설치한 뒤에도 설정 › 일반에서 바꿀 수 있습니다."
  LangString orbitdropPrivacyText 1033 "OrbitDrop processes your files on this computer only. It never sends files, file names or usage data anywhere.$\r$\n$\r$\nIts only network use is the automatic update check. When it is on, OrbitDrop asks GitHub (github.com) for a newer version one minute after it starts and every six hours after that. GitHub then receives only standard connection details such as your IP address and a request for this system's update file, no device ID. You can change this later in Settings › General."
  LangString orbitdropPrivacyLink 1042 "개인정보 처리방침 전문 보기"
  LangString orbitdropPrivacyLink 1033 "Read the privacy statement"
  LangString orbitdropPrivacyUrl 1042 "https://keilvher1.github.io/orbitdrop/privacy/"
  LangString orbitdropPrivacyUrl 1033 "https://keilvher1.github.io/orbitdrop/en/privacy/"
  LangString orbitdropUpdateCheckLabel 1042 "업데이트 자동 확인"
  LangString orbitdropUpdateCheckLabel 1033 "Check for updates automatically"

  ; .onInit: the default, or off with /NOUPDATECHECK (any letter case).
  !macro customInit
    StrCpy $orbitdropUpdateCheck "1"
    Push $R0
    Push $R1
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/NOUPDATECHECK" $R1
    ${IfNot} ${Errors}
      StrCpy $orbitdropUpdateCheck "0"
    ${EndIf}
    ClearErrors
    Pop $R1
    Pop $R0
  !macroend

  ; End of the install section, after the application files: record the choice for the app.
  !macro customInstall
    Push $R0
    Push $R1
    ${If} $orbitdropUpdateCheck == "0"
      StrCpy $R1 "false"
    ${Else}
      StrCpy $R1 "true"
    ${EndIf}
    ClearErrors
    FileOpen $R0 "$INSTDIR\${ORBITDROP_PREFERENCES_FILE}" w
    ${IfNot} ${Errors}
      FileWrite $R0 '{"version":1,"updates":{"autoCheck":$R1}}$\r$\n'
      FileClose $R0
      DetailPrint "${ORBITDROP_PREFERENCES_FILE}: automatic update checks $R1"
    ${Else}
      DetailPrint "could not write ${ORBITDROP_PREFERENCES_FILE}; OrbitDrop starts with its defaults"
    ${EndIf}
    ClearErrors
    Pop $R1
    Pop $R0
  !macroend

  !macro customPageAfterChangeDir
    !include nsDialogs.nsh

    Page custom orbitdropPrivacyPageCreate orbitdropPrivacyPageLeave

    Function orbitdropPrivacyPageCreate
      ; An update started by the app (--updated) goes straight to installing, like the folder page.
      ${if} ${isUpdated}
        Abort
      ${endif}
      Push $R0
      !insertmacro MUI_HEADER_TEXT "$(orbitdropPrivacyTitle)" "$(orbitdropPrivacySubtitle)"
      nsDialogs::Create 1018
      Pop $R0
      ${If} $R0 == error
        Pop $R0
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 84u "$(orbitdropPrivacyText)"
      Pop $R0
      ${NSD_CreateLink} 0 90u 100% 12u "$(orbitdropPrivacyLink)"
      Pop $R0
      ${NSD_OnClick} $R0 orbitdropOpenPrivacy
      ${NSD_CreateCheckbox} 0 110u 100% 14u "$(orbitdropUpdateCheckLabel)"
      Pop $orbitdropUpdateCheckBox
      ${If} $orbitdropUpdateCheck == "1"
        ${NSD_Check} $orbitdropUpdateCheckBox
      ${EndIf}
      Pop $R0
      nsDialogs::Show
    FunctionEnd

    Function orbitdropPrivacyPageLeave
      Push $R0
      ${NSD_GetState} $orbitdropUpdateCheckBox $R0
      ${If} $R0 == ${BST_CHECKED}
        StrCpy $orbitdropUpdateCheck "1"
      ${Else}
        StrCpy $orbitdropUpdateCheck "0"
      ${EndIf}
      Pop $R0
    FunctionEnd

    ; nsDialogs passes the link's window handle on the stack.
    Function orbitdropOpenPrivacy
      Exch $R0
      Pop $R0
      ExecShell "open" "$(orbitdropPrivacyUrl)"
    FunctionEnd
  !macroend
!endif
