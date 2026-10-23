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
* **실측(macOS 14.8.7 가상 머신, 2026-10-22)**: 사용자가 드롭한 파일은 helper가 받아도 앱 전체(main·worker)가
  대화상자 없이 읽는다. 보호 폴더에 **새 파일을 만들거나 이름을 바꾸거나 복사하는 것**은 대화상자가 없지만,
  **하드 링크(`link`)를 만들면** 위 대화상자가 뜨고 사용자가 답할 때까지 작업이 멈춘다(거절하면 `link`만 EPERM).
  0.1.0의 첫 패키지는 결과 이름을 하드 링크로 확정해, 바탕화면·문서·다운로드에서 처음 변환할 때마다 이 대화상자가
  떴다. 이제 macOS에서는 결과 이름을 배타적으로 만들어 예약한 뒤(O_EXCL, 빈 파일) 완성된 임시 파일을 그 위로
  `rename`해 확정한다(`packages/core/src/node/output.ts`) — 원자성·덮어쓰기 금지는 그대로이고 대화상자는 뜨지 않는다.
  시험: 같은 가상 머신에서 작은 AppleScript 앱 5개(새 파일, `ln`, `cp -c`, `cp -n`, 예약 후 `mv`)를 각각 처음
  실행해 `ln`만 대화상자를 띄움을 확인했다.
* **폴더 목록 읽기도 대화상자를 띄운다**(같은 VM, 2026-10-24): 처리 프로세스를 강제로 끝냈더니 main이 남은 임시 파일을
  찾으려고 출력 폴더 목록을 읽었고(`readdir`), 바탕화면 폴더 접근 대화상자가 떠 정리가 10초 제한에 걸렸다 — 작업은
  자동 재시도 없이 `OUTPUT_WRITE_FAILED`로 끝나고 임시 파일 하나가 남았다. 이제 처리 프로세스가 임시 파일 경로를
  쓰기 전에 main에 알리고(`tempFile` 메시지), main은 충돌 뒤 그 경로만 지운다. macOS에서는 폴더 목록을 읽지 않는다.
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
* 현재 방식은 필수 권한이 없으므로 "권한 회수"로 휠을 닫는 경로는 없다(프로토콜의 `permissionLost` 취소
  사유는 예약만 되어 있고 보내지 않는다). 잠자기·부모 종료·IPC 단절에서는 휠을 숨기고 세션을 폐기하며,
  대체 경로(파일 열기, Drop Zone)는 언제나 동작한다.
* 입력 모니터링이 없으면 포인터가 휠 밖에 있을 때 Esc를 감지하지 못한다. 이때는 마우스를 놓으면 휠이
  정리된다. 설정에서 이 제약과 시스템 설정 열기 버튼을 안내한다(자동 권한 요청 없음).
* 개발 중에는 터미널에서 실행한 앱이 아니라 **패키지된 OrbitDrop.app**으로 권한을 확인해야 한다
  (TCC는 책임 프로세스 기준으로 기록되며, 미서명 빌드는 다시 빌드할 때마다 서명이 달라져 권한이
  초기화될 수 있다).

### 기타

* 로그인 시 실행(`launchAtLogin`, 기본 꺼짐): 사용자가 설정에서 켤 때만 로그인 항목으로 등록한다.
  macOS가 실제 상태를 갖고 있어(시스템 설정 › 일반 › 로그인 항목에서도 바꿀 수 있음) OrbitDrop은 시작할 때 그 상태를 따른다.
  미서명(ad-hoc) 빌드는 새 빌드로 바꿔 설치하면 코드 서명이 달라져 macOS가 로그인 항목을 끄므로 다시 켜야 한다(VM 실측, 2026-10-24).
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
* 관리자 권한으로 실행된 OrbitDrop은 일반 탐색기에서 끌어온 파일을 받지 못하므로, helper가
  `ready.globalDrag.available: false`를 보고하면 설정 창이 사유와 함께 경고하고 대체 경로(파일 열기,
  Drop Zone)를 안내한다.
* 실측 결과: **미실측** — 이 프로젝트에는 Windows 기기가 없어 위 동작은 MinGW 교차 컴파일과 macOS 호스트
  테스트로만 확인했다. Windows 11 빌드 번호·배율(100/125/150/200%)별 결과는
  [windows-helper.md](workstreams/windows-helper.md)의 수동 점검표로 기록한다.

## 4. 무엇을 하지 않는가

* 다른 프로세스에 코드 주입, 합성 마우스·키 입력(mouse-up, Esc) 주입, 클립보드 덮어쓰기를 하지 않는다.
* 상시 전체 화면 투명 창으로 입력을 가로채지 않는다. 휠 창은 드래그 중에만 보인다.
* 키 입력·마우스 위치·창 정보를 파일로 기록하지 않는다. 로그에는 문서 내용과 전체 경로를 남기지 않는다.
* 열린 TCP 포트를 쓰지 않는다. helper ↔ main 통신은 부모가 만든 stdio 파이프(NDJSON)다.
