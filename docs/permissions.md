# 권한 (Permissions)

OrbitDrop이 운영체제에 요구하는 권한과 그 이유를 정리한다. 원칙: **필요한 것만, 필요할 때만** 요청하고,
**파일 접근 권한과 입력 관찰 권한을 구분**하며, 권한이 없어도 대체 경로(트레이 메뉴의 "파일 열기",
Drop Zone)로 변환·편집은 계속 쓸 수 있어야 한다.

> 상태(2026-10-21): 아래 "입력 관찰" 내용은 helper 소스(`native/macos/Sources/OrbitDropHelperKit/App/GlobalDragObserver.swift`,
> `SystemInfo.swift`, `native/windows/src/win/app.cpp`, `drop_target.cpp`)에 **구현된 방식**이다. 실제 OS에서 권한 대화상자가
> 뜨지 않는지와 드래그 동작은 [verification.md](verification.md) 1·9단계의 GUI 검증으로 확정한다(그 전까지 **미검증**).

## 1. 두 종류의 권한

| 구분 | 무엇 | 누가 사용 | 필요한 순간 |
|---|---|---|---|
| 파일 접근 | 사용자가 드래그·선택한 파일 읽기, 원본 폴더에 결과 쓰기 | processor worker(utilityProcess), main | 작업 실행 시 |
| 입력 관찰 | 드래그 중 보조키·마우스 버튼 상태, 드래그 시작 신호 관찰 | 네이티브 helper | 전역 드래그 기능이 켜져 있을 때 |

OrbitDrop은 계정·네트워크·카메라·마이크·위치·연락처 권한을 쓰지 않는다. 모든 처리는 로컬이다.

## 2. macOS

### 파일 접근

* 샌드박스 앱이 아니므로(App Sandbox 미사용, [packaging.md](packaging.md#4-macos-서명--hardened-runtime--공증))
  사용자가 드롭한 파일을 읽고 같은 폴더에 결과를 쓰는 데 별도 entitlement가 필요 없다.
* 단, macOS의 **TCC 보호 폴더**(데스크탑, 문서, 다운로드, iCloud Drive, 외장/네트워크 볼륨)는 앱이
  처음 접근할 때 "OrbitDrop이(가) '다운로드' 폴더의 파일에 접근하려고 합니다" 같은 시스템 대화상자를
  띄울 수 있다. 거절하면 해당 위치의 작업은 권한 오류로 실패하고 다른 저장 위치를 고를 수 있다
  (`OUTPUT_DIR_NOT_WRITABLE` → 폴더 선택). 권한 상승으로 우회하지 않는다.
* 권한 판단은 실제로 파일을 읽는 프로세스에서 일어난다. worker(utilityProcess)와 helper는 앱 번들
  안의 하위 프로세스이므로 TCC는 **OrbitDrop.app**을 책임 프로세스로 표시한다.
* "모든 디스크 접근 권한"(Full Disk Access)은 요구하지 않는다.

### 입력 관찰 (전역 드래그 + 보조키)

helper는 공개 API만 쓰며, 채택한 방식은 **TCC 권한이 필요 없도록** 골랐다:

| 방식(구현됨) | 용도 | TCC 권한 |
|---|---|---|
| `NSEvent.addGlobalMonitorForEvents` — 왼쪽 버튼 down/dragged/up만 | 드래그 후보(버튼+이동) | 필요 없음(마우스 이벤트만, 키 이벤트는 관찰하지 않음) |
| `NSEvent.modifierFlags` 폴링(60 Hz, 버튼이 눌렸거나 세션이 열린 동안만) | 보조키 상태 | 필요 없음 |
| `NSPasteboard(name: .drag).changeCount` | 실제 OS 드래그가 시작됐는지 확인(내용은 읽지 않음) | 필요 없음 |
| `NSEvent.pressedMouseButtons` | 놓친 mouse-up 대비 | 필요 없음 |
| NSPanel + `NSDraggingDestination` (휠 창 = 드롭 대상) | 실제 drag-enter/drop, 파일 URL | 필요 없음 |
| Esc 키 폴링 | 휠이 보일 때 Esc로 취소 | **입력 모니터링이 이미 허용된 경우에만** 사용(`CGPreflightListenEventAccess`로 상태만 읽고 요청하지 않음). 없으면 Esc 대신 드래그 종료·휠 이탈로 정리 |

* `CGEventTap`(입력 모니터링 필요)과 손쉬운 사용 API는 쓰지 않는다. `AXIsProcessTrusted()`/`CGPreflightListenEventAccess()`는
  진단용으로 **상태만 읽으며** 대화상자를 띄우지 않는다.
* helper는 `queryPermissions`에 `permissions` 메시지로 답한다: `accessibility`, `inputMonitoring` 모두 `required: false`
  (+ 현재 `granted` 값). main은 필요한 권한이 없을 때만 안내를 보여 주며, 현재 방식에서는 안내할 필수 권한이 없다.
* 패키지 smoke test(이 Mac, macOS 26.6 arm64 / Rosetta x64)에서 helper가 `ready`와 `globalDrag.available: true`를 보고했다.
  이는 helper의 자가 보고이며 실제 Finder 드래그 검증이 아니다.
* 권한이 없거나 회수되면(`permissionLost`) 휠을 숨기고 세션을 폐기하며, 대체 경로는 계속 동작한다.
* 개발 중에는 터미널에서 실행한 앱이 아니라 **패키지된 OrbitDrop.app**으로 권한을 확인해야 한다
  (TCC는 책임 프로세스 기준으로 기록되며, 미서명 빌드는 다시 빌드할 때마다 서명이 달라져 권한이
  초기화될 수 있다).

### 기타

* 로그인 시 실행(`launchAtLogin`, 기본 꺼짐): 사용자가 설정에서 켤 때만 로그인 항목으로 등록한다.
* 알림: 드래그로 시작한 작업이 끝났을 때(설정 `notifications`). 처음 보낼 때 macOS가 알림 허용을 묻는다.
* Info.plist에 남아 있는 Electron 기본 사용 설명 문자열(카메라·마이크 등)은 Electron 런타임의 기본값이며,
  OrbitDrop은 해당 API를 호출하지 않으므로 대화상자가 뜨지 않는다.

## 3. Windows

### 파일 접근

* 일반 데스크톱 앱(관리자 권한 없음, `asInvoker`)으로 실행된다. 사용자 프로필 아래 파일은 추가 권한 없이
  읽고 쓸 수 있다. 쓰기 권한이 없는 폴더(예: `C:\Program Files`)에는 결과를 쓰지 않고 다른 위치를 묻는다.
* **제어된 폴더 액세스**(Microsoft Defender 랜섬웨어 보호)가 켜져 있으면 보호 폴더에 쓰기가 차단될 수 있다.
  이 경우 Windows 알림이 뜨고 작업은 권한 오류로 실패한다. 우회하지 않으며, 사용자가 Defender에서 앱을
  허용하거나 다른 저장 위치를 고른다.
* 설치 프로그램은 사용자별 설치라 UAC 프롬프트가 없다([packaging.md](packaging.md#5-windows-nsis-설치-프로그램--authenticode--smartscreen)).

### 입력 관찰

* Windows에는 macOS TCC 같은 입력 관찰 권한 대화상자가 없다. helper는 전역 훅(`SetWindowsHookEx`)을 쓰지 않고
  `GetAsyncKeyState`(버튼·Shift/Alt/Ctrl/Win·Esc)와 `GetCursorPos`를 폴링하며, 자체 HWND에 `RegisterDragDrop`으로
  OLE `IDropTarget`을 등록해 실제 `CF_HDROP` 데이터를 받는다. 원본이 Copy를 허용할 때만 `DROPEFFECT_COPY`, 아니면
  `DROPEFFECT_NONE`. 프로세스는 Per-Monitor DPI Aware v2.
* **UIPI 제약**: 일반 권한으로 실행된 OrbitDrop은 관리자 권한으로 실행된 창(예: 관리자 탐색기)에서 시작한
  드래그를 받을 수 없다. 이는 의도된 OS 보안 경계이며 우회하지 않는다.
* 실측 결과(Windows 11 빌드 번호, 배율별): **_(windows-helper 보고 후 기입)_**

## 4. 무엇을 하지 않는가

* 다른 프로세스에 코드 주입, 합성 마우스·키 입력(mouse-up, Esc) 주입, 클립보드 덮어쓰기를 하지 않는다.
* 상시 전체 화면 투명 창으로 입력을 가로채지 않는다. 휠 창은 드래그 중에만 보인다.
* 키 입력·마우스 위치·창 정보를 파일로 기록하지 않는다. 로그에는 문서 내용과 전체 경로를 남기지 않는다.
* 열린 TCP 포트를 쓰지 않는다. helper ↔ main 통신은 부모가 만든 stdio 파이프(NDJSON)다.
