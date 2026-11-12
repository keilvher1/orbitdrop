# 검증 절차와 기록 (Verification)

두 종류를 구분한다.

* **자동 검증**: 테스트·패키지 검사·smoke test. 결과물을 다시 읽어 확인한다. → 아래 [자동 검증 증거](#자동-검증-증거)
* **실제 OS GUI 검증**: 사람이 **설치본**으로 실제 Finder/Explorer 파일을 드래그해 확인한다. CI·빌드·단위 테스트 통과는
  이것을 대신하지 못한다. → 아래 [수동 GUI 검증 절차](#수동-gui-검증-절차)
* 그 사이에 **스크립트 GUI 시험**이 있다: 실제 OS의 Finder/탐색기와 설치본으로 하지만, 입력은 스크립트가 합성한다 — macOS 가상 머신
  (VNC 입력, [기록](#가상-머신-gui-검증--macos-1487-2026-10-22))과 GitHub Windows 러너(`SendInput`, [기록](#windows--github-러너-gui-드래그-자동-시험-2026-11-12)).
  사람·실물 기기의 확인을 대신하지 않는다.

결과는 [support-matrix.md](support-matrix.md)의 등급(구현됨 / 자동 검증됨 / 러너 GUI 시험됨 / VM GUI 검증됨 / 실제 OS GUI 검증됨 / 미검증 / 미지원)에 반영한다.

---

## 공개 릴리스 1.0.0 (2026-11-12)

[v1.0.0](https://github.com/keilvher1/orbitdrop/releases/tag/v1.0.0) — 소스 `ba703ad`(태그 `v1.0.0`), 2026-11-12 09:17 UTC 공개.

| 항목 | 결과 |
|---|---|
| 태그 커밋의 CI | Windows·macOS job 통과(run 43184648125), native-windows 통과 |
| Windows 패키지 | 릴리스 워크플로(run 43186900907)의 Windows Server 2025 러너에서 빌드·smoke·무인 설치/제거 시험 후 초안에 업로드. **코드 서명 없음**(파일 이름 `-unsigned`). 초안 job은 첫 시도에서 "초안 목록 지연"으로 실패해 다시 실행했다(스크립트는 6adc7c4에서 고침) |
| macOS 패키지 | 이 저장소의 개발 Mac에서 `scripts/release-mac.mjs v1.0.0`: Developer ID 서명(보안 타임스탬프, hardened runtime — 앱과 helper), 앱과 DMG 공증·티켓 부착. arm64·x64 모두 DMG `spctl -t open` accepted(Notarized Developer ID), `stapler validate` 통과, DMG에서 꺼내 격리 표시를 붙인 앱이 `spctl` accepted · `stapler validate` · `syspolicy_check distribution` 통과. smoke test(x64는 Rosetta 2) 통과 |
| LGPL·MPL 소스 | `OrbitDrop-1.0.0-third-party-sources.tar.gz`(122 MB)를 초안 job이 만들어 함께 공개 |
| 공개 후 확인 | 릴리스의 12개 파일을 모두 내려받아 `shasum -a 256 -c SHA256SUMS.txt` 전부 OK. `latest-mac.yml`은 arm64·x64 zip, `latest.yml`은 설치 파일을 가리킴(버전 1.0.0, sha512·크기 일치). 웹사이트 다운로드 영역이 실제 API로 1.0.0과 세 설치 파일을 표시(헤드리스 Chromium, macOS·Windows UA) |

SHA-256(`SHA256SUMS.txt`와 같음):

| 파일 | SHA-256 |
|---|---|
| `OrbitDrop-1.0.0-mac-arm64.dmg` | `30e7a2c6db4b0699fb68abfc0029bbfa51777ca2612d62212ea5226e76fc9240` |
| `OrbitDrop-1.0.0-mac-x64.dmg` | `d9768fd219dda7c02967707a790034030ab0e926348e8f6ad50ae10512a2fa51` |
| `OrbitDrop-1.0.0-mac-arm64.zip` | `cb7bc0db015c44274a4d372d0759ef4867c043e8a0d92cd87082cf71a797d209` |
| `OrbitDrop-1.0.0-mac-x64.zip` | `a3a1632bc17142a2e86f31503ce2bcc468323690b7c4053d2c1b4dfd8262f077` |
| `OrbitDrop-1.0.0-win-x64-unsigned-setup.exe` | `2f1ba21366b86ef4b9ede255353005366337803a40a7fa61a8150ea1bf5d13cc` |
| `OrbitDrop-1.0.0-third-party-sources.tar.gz` | `86323e7588fa9ec7a308543bfc6d3b86d06f71817c1580d1204421bde49043e2` |

아직 확인하지 않은 것: 실물 Mac·Windows 11 PC에서 사람이 한 확인, 공개된 릴리스에서 다음 버전으로의 실제 자동 업데이트(다음 릴리스에서 확인).

---

## 수동 GUI 검증 절차

### 준비

1. 검사할 설치 파일과 SHA-256을 기록한다(`apps/desktop/release/build-report-<os>-<arch>.json`의 `artifacts`).
   - macOS: DMG를 열어 `OrbitDrop.app`을 `/Applications`로 복사. 미서명 빌드는 로컬에서 만든 사본만 사용하고
     인터넷에서 내려받은 미서명 사본으로 Gatekeeper를 우회하지 않는다.
   - Windows: `OrbitDrop-…-setup.exe` 실행(사용자별 설치, UAC 없음이 정상).
2. 샘플 파일: 빈 폴더(이름에 한글·공백 포함 권장, 예: `~/Desktop/검증 폴더`)에서
   `node scripts/gen-fixtures.mjs "<그 폴더>"` → `Page 001.pdf`, `photo.jpg`, `exif-orientation-6.jpg`,
   `사진 테스트 😀.jpg`, `corrupt.pdf` 등이 생성된다. 원본 해시를 기록해 둔다
   (macOS `shasum -a 256 *`, Windows `Get-FileHash *`).
3. 화면 녹화 또는 단계별 스크린샷을 `docs/screenshots/verification-<os>-<step>.png`로 남긴다.
4. 기록 칸: OS 버전과 빌드 번호(macOS `sw_vers`, Windows `winver`), 아키텍처, 디스플레이 배율, 앱 산출물 이름·SHA-256, 날짜, 검증자.

### 단계 (각 OS에서 동일하게 수행)

| # | 절차 | 기대 결과 |
|---|---|---|
| 1 | 설치본을 새로 실행한다(설정 폴더가 없는 상태). | 메뉴 막대/알림 영역에 아이콘이 나타나고 환영 창이 한 번 열린다(OS 언어: 한국어면 한국어, 그 밖은 영어; 키는 macOS Shift·Option+Shift, Windows Shift·Ctrl+Shift). macOS에서 DMG·다운로드 폴더에서 실행했다면 먼저 응용 프로그램 폴더로 옮길지 한 번 묻는다(이동 / 나중에). "로그인 시 실행"은 꺼져 있다. 환영 창을 닫고 다시 실행하면 열리지 않는다. 필요한 권한이 있으면 설정 창에 안내가 보이며, 실행만으로 시스템 권한 대화상자를 강제로 띄우지 않는다([permissions.md](permissions.md)). |
| 2 | Finder/탐색기에서 `Page 001.pdf`를 드래그하는 중 **Shift**를 누른다. | 포인터 근처에 휠이 나타난다. 드래그가 끊기지 않고 포커스를 빼앗지 않는다. PDF 메뉴는 위부터 시계방향 DOCX, JPG, PNG, TXT. |
| 3 | JPG 조각에 놓는다. | 강조가 주황색, 중앙 캡슐에 "JPG". 놓으면 `Page 001.jpg`가 원본 옆에 생기고 `Page 001.pdf`는 그대로 남는다(해시 동일). |
| 4 | `Page 001.jpg`를 다시 드래그 → **Option+Shift**(Windows: **Ctrl+Shift**) → CROP에 놓는다 → 1:1로 선택 → Apply. | 편집 창(이미지 자르기)이 드롭 후 열린다. Apply 전에는 파일이 생기지 않는다. `Page 001 Cropped.jpg`가 정사각형으로 생긴다. |
| 5 | `Page 001 Cropped.jpg`를 드래그 → 도구 휠 → ADD BG → 배경·Padding·Corners·Shadow 변경 → Save with Background. | `Page 001 Cropped With Background.png`가 생긴다. 미리보기와 같은 구성(비율·여백·둥근 모서리·잘리지 않은 그림자). |
| 6 | 폴더를 확인하고 결과 4개를 기본 뷰어로 연다. | 원본 PDF + JPG + 잘린 JPG + 배경 PNG가 모두 존재하고 올바르게 열린다. 원본 해시 변화 없음. |
| 7 | 보조키 해제(휠 유지), Esc(취소), 휠 밖으로 나갔다 재진입, 텍스트/웹 링크 같은 **비파일** 드래그, 빠른 반복 드롭. | 키를 놓아도 휠 유지, Esc·드래그 종료 시 휠이 사라지고 남는 창이 없다. 비파일 드래그는 휠을 띄우지 않거나 중립 상태 후 거부. 반복 드롭마다 작업이 정확히 1개씩. 휠 밖에 놓으면 원본 앱의 일반 동작(앱 작업 없음). |
| 8 | 배율·모니터: Windows 100/125/150/200%, macOS Retina/비 Retina, 보조 모니터, 화면 네 모서리 근처. | 휠이 화면 안에 완전히 보이고 포인터 아래 섹터가 정확히 강조된다(경계·중심 dead zone 포함). **사용 가능한 구성만 표에 기록하고 나머지는 미검증으로 남긴다.** |
| 9 | 권한 거절(macOS 손쉬운 사용/입력 모니터링 거절, 보호 폴더 접근 거절), helper 강제 종료, 네트워크 끊기, Drop Zone/파일 열기 사용. | 권한이 없으면 안내 + 대체 경로 사용 가능. helper가 죽으면 휠이 남지 않고 재시작 또는 안내. 네트워크 없이 모든 기능 동작. Drop Zone으로 같은 변환·편집 가능(이것은 전역 드래그 검증을 대신하지 않는다). |
| 10 | 창과 수명 주기(2차 점검에서 추가): 주석·가리기에서 도형을 그린 뒤 저장하지 않고 창 닫기 버튼, ⌘W(Windows: Alt+F4)로 닫기 / 실행 중인 앱을 Finder·시작 메뉴에서 다시 열기 / 파일을 Dock 아이콘에 놓거나 "다음으로 열기" / 휠을 띄운 채 화면 잠금, 잠자기 후 깨우기. | 닫기 전에 ×·Esc와 같은 확인 창이 뜨고 "계속 편집"을 고르면 작업이 남는다(앱 종료는 묻지 않음). 다시 열면 설정 창 등 기존 창이 앞으로 온다. 넘긴 파일은 일반 파일 입력과 같은 검증을 거친다. 잠금·잠자기에서 휠이 사라지고 세션이 끝나며, 깨운 뒤 다음 드래그가 정상 동작한다. |
| 11 | 도움말·진단(2026-11-12 추가): 메뉴 › 도움말의 네 항목 / 정보 창의 진단 정보 복사 → 텍스트 편집기에 붙여 넣기 / 오픈 소스 라이선스 세 버튼 / 설정 › 일반 › 데이터 폴더 열기, 설정 초기화(확인 창에서 취소, 다시 초기화). | 사용법은 환영 창, 웹사이트는 UI 언어의 페이지(ko: `/orbitdrop/`, en: `/orbitdrop/en/`), 문제 신고는 GitHub 새 이슈(제목·본문에 앱 버전·OS 버전·아키텍처만, 파일 이름·경로 없음), 로그 폴더는 Finder/탐색기. 붙여 넣은 진단 정보에 사용자 이름·파일 경로가 없다. 라이선스 파일이 기본 앱으로 열린다. 초기화는 확인 창(OS 대화상자 아님)을 거치고, 언어·작업 기록은 그대로, "로그인 시 실행"은 꺼진다. |
| 12 | 충돌 처리(2026-11-12 추가): 활동 모니터/작업 관리자에서 열린 창의 렌더러 프로세스("OrbitDrop Helper (Renderer)")를 세 번 끝낸다 / helper(`OrbitDropHelper`)를 10분 안에 여러 번 끝내 포기하게 한다 / 앱 데이터 폴더의 `Crashpad` 확인. | 첫 번째: 창이 다시 열리고 "예기치 않게 종료되어 다시 열었습니다" 안내(편집 창은 사라진 작업 설명), 두 번째: 충돌 화면(창 닫기·로그 폴더 열기), 세 번째: 창이 닫히고 알림. helper 포기 시 알림 1회, 누르면 다시 시작(설정 › 드래그에도 다시 시작 버튼). 덤프는 `Crashpad`에만 있고 네트워크 요청이 없다. |

### 결과 기록표 — macOS

환경: macOS ___ (빌드 ___) · arm64 / x64 · 디스플레이 ___ · 산출물 `__________` (SHA-256 `____`) · 날짜 ____ · 검증자 ____

| # | 결과 (통과/실패/미실시) | 메모 · 스크린샷 |
|---|---|---|
| 1 | 미실시 | |
| 2 | 미실시 | |
| 3 | 미실시 | |
| 4 | 미실시 | |
| 5 | 미실시 | |
| 6 | 미실시 | |
| 7 | 미실시 | |
| 8 | 미실시 | 구성: Retina ☐ · 비 Retina ☐ · 보조 모니터 ☐ · 화면 가장자리 ☐ |
| 9 | 미실시 | |
| 10 | 미실시 | |
| 11 | 미실시 | |
| 12 | 미실시 | |

### 결과 기록표 — Windows

환경: Windows 11 ___ (빌드 ___) · x64 · 배율 ___ · 산출물 `__________` (SHA-256 `____`) · 날짜 ____ · 검증자 ____

| # | 결과 (통과/실패/미실시) | 메모 · 스크린샷 |
|---|---|---|
| 1 | 미실시 | 설치: UAC 프롬프트 없음 ☐ · `%LOCALAPPDATA%\Programs\OrbitDrop` ☐ · 경로 변경 ☐ · 제거 프로그램 ☐ |
| 2 | 미실시 | |
| 3 | 미실시 | |
| 4 | 미실시 | |
| 5 | 미실시 | |
| 6 | 미실시 | |
| 7 | 미실시 | |
| 8 | 미실시 | 배율: 100% ☐ · 125% ☐ · 150% ☐ · 200% ☐ · 보조 모니터 ☐ · 음수 좌표 모니터 ☐ |
| 9 | 미실시 | |
| 10 | 미실시 | |
| 11 | 미실시 | |
| 12 | 미실시 | |

---

## PoC 결과 — 실제 외부 드래그 (스펙 §3)

| 항목 | macOS | Windows |
|---|---|---|
| 구현 | Swift/AppKit helper: 전역 마우스 모니터 + 보조키 폴링 + 드래그 페이스트보드 changeCount로 후보 감지, 포커스를 빼앗지 않는 NSPanel이 휠이자 드롭 대상, Copy만 수락, 세션당 drop 1회 | C++/Win32: 폴링 관찰(훅·주입 없음), 레이어드 비활성 창(디스크 밖 알파 0), OLE `IDropTarget`(CF_HDROP), Copy 또는 None만 반환 |
| 권한 실측 | 필요 권한 없음(손쉬운 사용·입력 모니터링 요청 안 함). Esc는 입력 모니터링이 이미 허용된 경우에만 전역 감지 | 해당 없음(권한 대화상자 없음). 관리자 권한 실행 시 UIPI로 일반 탐색기 드래그 불가 |
| 자동 확인 | 드롭 대상(가짜 `NSDraggingInfo`), 실제 이벤트 순서를 재생하는 관찰자 테스트, 세션 상태 기계, 휠 기준값 전 구간, 패키지 안 helper `ready`·`globalDrag.available: true` | 포터블 코어(세션·좌표·프로토콜) 86개 테스트와 골든 기준값을 macOS 호스트에서 실행. OLE 드롭 테스트는 컴파일만 |
| **실제 Finder/탐색기 드래그** | **가상 머신에서 통과**(macOS 14.8.7 — 아래 [가상 머신 GUI 검증](#가상-머신-gui-검증--macos-1487-2026-10-22), macOS 26.6.2 — [핵심 흐름 점검](#가상-머신-핵심-흐름-점검--macos-2662-2026-10-24)) · 실물 Mac에서 사람이 하는 확인은 **미실시** — 사용자가 `node --import tsx native/macos/scripts/poc-harness.mjs`(`--guided`면 단계별 안내와 자동 판정, 끝에 `RESULT: PASS/FAIL`)로 [macos-helper.md §8](workstreams/macos-helper.md) 24단계를 수행하고 아래 표에 기록(1–20 기존, 21–24는 2차 점검에서 추가: 드래그 중 화면 잠금, 보안 키보드 입력, 배율이 다른 보조 모니터, iCloud 클라우드 전용 파일) | **GitHub 러너에서 스크립트 시험 통과**(Windows Server 2025 24H2, 1024×768·100 %, `SendInput` 합성 입력, 실제 탐색기·설치본 — 아래 [기록](#windows--github-러너-gui-드래그-자동-시험-2026-11-12)) · 실물 PC에서 사람이 하는 확인은 **미실시** — [windows-helper.md](workstreams/windows-helper.md) 점검표 34항목 |

자동 확인으로 대신할 수 없는 핵심 질문은 셋이다. 실제 드래그 중에 전역 마우스 이벤트가 오는지, 드래그 도중 나타난
패널이 drag-enter를 받는지, 휠 바깥 투명 영역에 놓은 드롭이 아래 Finder 창으로 가는지(§8 9단계). **세 가지 모두 아래 가상
머신 검증(macOS 14.8.7, 26.6.2)에서 확인됐다.** 실물 Mac에서 사람이 확인하기 전까지 지원표에는 "실제 OS GUI 검증됨"이 아니라 "VM GUI 검증됨"으로 적는다.
Windows에서도 세 가지 모두 GitHub 러너의 스크립트 시험([기록](#windows--github-러너-gui-드래그-자동-시험-2026-11-12))에서 확인됐다 — helper가 탐색기 드래그 중 버튼·Shift를 읽어 휠을
띄웠고, 휠 창이 DragEnter와 Drop을 받았고, 휠 창의 투명 모서리에 놓은 드롭은 아래 탐색기로 갔다. 지원표에는 "러너 GUI 시험됨"으로 적는다.

### 가상 머신 GUI 검증 — macOS 14.8.7 (2026-10-22)

**방법.** 개발 Mac(macOS 26.6 arm64) 위의 macOS 게스트에서 **실제 Finder**와 **설치본**으로 시험했다. 입력은 Apple
Virtualization.framework의 VNC 서버(tart `--vnc-experimental`)로 넣었다 — 게스트 안에서는 가상 USB 키보드·마우스의 하드웨어
입력으로 보이며, 호스트의 입력은 건드리지 않는다. 화면은 VNC 프레임버퍼를 캡처했다(포인터는 찍히지 않음). 파일 결과와 로그는
게스트에 SSH로 들어가 확인했다. 사람이 아니라 스크립트가 조작했으므로 **실물 Mac에서 사람이 하는 GUI 검증을 대신하지 않는다.**

| 항목 | 값 |
|---|---|
| 게스트 | macOS 14.8.7 (23J520) arm64 — 최소 지원 버전인 macOS 14 계열에서 처음 실행 |
| 이미지 | `ghcr.io/cirruslabs/macos-sonoma-vanilla:latest` (manifest `sha256:7ea0d508…`), tart 2.41.1 (Cirrus Labs Developer ID, 공증됨) |
| 자원 | CPU 4 · 메모리 6 GB · 화면 1440×900 px(1×), 이어서 1440×900 pt(2×, Retina 2880×1800) |
| 설치본 | `OrbitDrop-0.1.0-mac-arm64-unsigned.dmg` sha256 `d725a4b4…`(7faf031) → 고친 뒤 `e14b0c74…`(78c83b0) → `632818a7…`(7951bd3). `hdiutil` + `ditto`로 `/Applications`에 설치(격리 속성 없음), `codesign --verify --deep --strict` 통과 |
| VNC 키 매핑(실측) | VZ VNC 서버는 **Alt → Command**, **Meta → Option**으로 보낸다(텍스트 편집기에서 Meta+b가 `∫`). 그래서 Option+Shift는 Meta+Shift로 보냈다 |

| # (위 절차) | 결과 | 확인 내용 · 스크린샷 |
|---|---|---|
| 1 첫 실행 | 통과 | 창 없이 메뉴 막대 아이콘만, 실행 시 권한 대화상자 없음. 첫 **알림**을 보낼 때 macOS 알림 허용 배너가 한 번 뜸(예상된 동작) |
| 2 Finder 드래그 + Shift | 통과 | 포인터 위치에 휠, DOCX·JPG·PNG·TXT 순서, 메뉴 막대는 계속 Finder(포커스 안 빼앗음) — `vm-macos14-01` |
| 3 JPG에 드롭 | 통과(첫 빌드는 권한 대화상자 — 아래 발견 1) | 주황 강조·캡슐·아래 캡션 "JPG"(`vm-macos14-02`), 작업 1개, `Page 001.jpg` 2550×3300, PDF 해시 그대로 |
| 4 Option+Shift → 자르기 1:1 | 통과 | 도구 휠(압축이 위, 아이콘+한글, `vm-macos14-03`), 편집 창이 그려짐, 적용 전 파일 없음, `Page 001 Cropped.jpg` 2550×2550(`vm-macos14-04`) |
| 5 배경 추가 | 통과 | 배경·여백 431·모서리 182·그림자 95 px로 바꾸자 미리보기 즉시 반영(`vm-macos14-05`), `Page 001 Cropped With Background.png` 2400×2400, 미리보기와 같은 구성 |
| 6 결과 4개 | 통과 | 원본 PDF + JPG + 자른 JPG + 배경 PNG(`vm-macos14-06`), 원본 5개 해시 모두 그대로 |
| 7 보조키 해제·Esc·이탈/재진입·비파일·반복 | 통과 | Shift를 놓아도 휠 유지 → PNG 드롭 · 휠 위에서 Esc → Finder가 드래그 취소, 휠 1초 안에 사라짐, 작업 없음(입력 모니터링 없이) · 밖으로 나갔다 들어와 JPG → 작업 정확히 1개(`Page 001 (2).jpg`) · 폴더 "폴더는 처리할 수 없음", TXT "지원하지 않는 파일", 텍스트 드래그 "파일이 아님"(`vm-macos14-08/09`) · 5회 연속 드롭 → 세션 5개·작업 5개, `(3)…(7)`, 임시 파일 0 |
| 7+ 여러 파일 | 통과 | JPG 2개를 함께 골라 Shift 드래그 → 드래그 이미지에 "2", 캡슐 "2개 파일", WEBP에 드롭 → 드롭 1회(`files=2`), 작업 2개 동시 완료(`vm-macos14-19`) |
| 7+ 휠 옆 투명 영역 | 통과 | 휠 창의 대각선 모서리(링 밖 약 30 pt) 아래 Finder 폴더가 드롭 대상으로 강조되고 파일이 폴더로 옮겨짐, OrbitDrop 작업 없음(`vm-macos14-07`). 오래 머물면 Finder의 스프링 로딩으로 폴더 창이 열림 — Finder가 드래그를 받았다는 또 다른 증거 |
| 8 배율·가장자리 | 통과(가능한 구성만) | 1×와 Retina 2×에서 휠 선명, 포인터 아래 조각 정확(`vm-macos14-15`). 오른쪽 가장자리·왼쪽 위 모서리에서 휠이 화면 안으로 이동. **보조 모니터·음수 좌표는 미검증**(게스트 화면 1개) |
| 9 helper 오류·대체 입력·보호 폴더 | 통과 | 휠이 열린 채 helper SIGKILL → 휠 즉시 사라짐, 0.55초 뒤 재시작, 새 세션 id `m1098-…`로 다음 드래그 정상(`vm-macos14-16/17`). 메뉴 막대 메뉴(파일 열기·Drop Zone·최근 작업·작업 창·전역 드래그·설정·정보·종료), Drop Zone → 앱 안 휠 → PDF→DOCX(`vm-macos14-13`), 작업 창(`vm-macos14-14`). 문서 폴더 접근 "허용 안 함"을 골라도 작업 완료(첫 빌드의 복사 대체 경로). 네트워크 끊기는 VM에서 안 함(오프라인 E2E로 확인) |
| 10 창·수명 주기 | 일부 통과 | 주석에 화살표를 그린 뒤 ⌘W → "저장하지 않고 닫을까요?"(`vm-macos14-12`), 계속 편집 → 저장 → `rotated Annotated.jpg` 400×600(EXIF 6 한 번만 적용). **화면 잠금은 미확인** — VNC로 보낸 Ctrl+⌘+Q가 잠금 단축키로 동작하지 않음 |

**발견과 조치.**
1. **보호 폴더 첫 사용 때 권한 대화상자(수정됨, 78c83b0).** 첫 빌드는 바탕화면 결과를 쓸 때 "OrbitDrop이 데스크탑 폴더의 파일에
   접근하려고 합니다"를 띄우고, 답할 때까지 작업이 멈췄다(`vm-macos14-10`). 같은 게스트에서 AppleScript 앱 5개로 원인을 좁혔다 —
   새 파일·이름 바꾸기·복사는 대화상자가 없고 **하드 링크만** 대화상자를 띄운다. macOS에서는 결과 이름을 예약한 뒤 `rename`으로
   확정하도록 바꿨고, 고친 설치본으로 한 번도 접근하지 않은 다운로드 폴더의 3쪽 PDF를 변환해 대화상자 없이 0.7초에 끝남을 확인했다
   (`vm-macos14-11`, 2쪽 90° 회전 → 3300×2550). 자세한 내용: [permissions.md](permissions.md).
2. **지원하지 않는 항목 안내가 드래그 이미지에 가림(수정됨, 7951bd3).** 이유가 가운데 캡슐에만 나와 넓은 텍스트 드래그 이미지가
   그 위를 덮었다. 이제 활성 조각처럼 링 아래 캡션에도 이유를 보인다 — 고친 설치본(Retina 2×)에서 텍스트 드래그 때 캡슐은 가려져도
   캡션의 "파일이 아님"이 보임을 확인했다(`vm-macos14-18`). Windows helper에는 이 보조 캡션 자체가 없어 따로 추가 중이다.
3. **VNC 입력 한계.** Ctrl+⌘+Q(잠금)는 동작하지 않았고, 포인터 모양(Copy의 초록 +)은 VNC 캡처에 찍히지 않는다.

### 가상 머신 전 기능 점검 — macOS 14.8.7 (2026-10-23)

같은 게스트에서 **모든 입력 형식과 모든 도구**를 실제 Finder 드래그(일부는 메뉴 막대의 파일 열기·Drop Zone)로 써 봤다. 시험 파일은
`node scripts/gen-fixtures.mjs`의 22개 + 정적 픽스처(암호·소유자 암호 PDF, JPX·CCITT PDF, BMP) + 카메라처럼 만든 사진(4032×3024,
EXIF 방향 6, GPS), CMYK JPEG, 3프레임 GIF. 결과 파일은 SSH로 꺼내 다시 디코딩해 확인했다(크기·색 평균·EXIF·PDF 쪽 수·텍스트).

| 영역 | 결과 |
|---|---|
| PDF → JPG/PNG/TXT/DOCX (14건) | 모두 기대대로: 12쪽 → `many-pages-p001…p012.jpg` 2550×3300 · 크기가 다른 3쪽(Letter·A4·A5) · 90° 회전 쪽 3300×2550 · 한글 CMap PDF → TXT "한글 CMap", PNG에 글자 · JPX·CCITT 이미지 렌더링 · 소유자 암호만 있는 PDF는 변환 · **암호 PDF → `PDF_ENCRYPTED`, 손상 PDF → `PDF_CORRUPT`, 스캔 PDF → TXT `PDF_NO_TEXT`(빈 파일 없음)** · 일부 쪽만 글자 있는 PDF → 빈 쪽도 쪽 구분 유지 · 150 DPI 설정 → 1275×1650 |
| 이미지 변환 (24건) | JPG → PNG/WEBP/HEIC/TIFF/AVIF/BMP/PDF/DOCX 전부 · 투명 PNG → JPG(흰 배경) · GIF·애니메이션 GIF(첫 프레임)·TIFF·WEBP·AVIF·BMP·CMYK·진행형 JPEG 입력 · 한글·이모지 이름 · 손상 JPEG → `IMAGE_CORRUPT` · 카메라 사진 → HEIC 3024×4032(방향 적용) · HEIC 입력 → JPG, HEIC 편집 → HEIC 저장(macOS ImageIO 헬퍼) |
| 도구 7개 | 메타데이터: 카메라 정보·GPS 표시 → 제거본에 EXIF·GPS 없음 · 압축: WEBP·긴 변 1920 → 1440×1920, 2.7 MB → 24 KB, 추정 크기 표시 · 편집: 오른쪽 회전 + 좌우 반전 + 밝기 → 픽셀이 전치 + 밝아짐 · 주석: 한글 텍스트("한글 주석 테스트 ✓")·사각형·화살표·실행 취소/다시 실행 → 결과에 합성 · 가리기: 단색·모자이크 영역 → 단색 영역 [0,0,0], 바깥은 그대로 · 자르기: 방향 6 사진에서 W/H 1000×1500 입력 후 이동 → 결과가 화면에 보이던 위치와 일치(원본에서 찾은 위치 오차 rms 2.6) · 배경 추가: 배경 이미지·16:9·JPEG → 519×292, 모서리 둥글게 |
| 여러 파일 | 이미지 3개 → PDF: 순서 편집기(썸네일·위/아래 이동)·A4·여백 → 3쪽, 이미지별 가로/세로 · JPG 2개 → WEBP 동시 처리 |
| 설정 | 영어 전환(모든 창 즉시) · 로그인 시 실행(macOS "로그인 항목 추가" 알림) · PDF 150/300 DPI · 저장 위치 "매번 묻기"(폴더 대화상자 → 문서 폴더) · 변환 키를 Option만으로 바꾸면 Shift로는 휠이 안 뜨고 Option으로 뜸 · 휠 크기 · 전역 드래그 끄기(드래그해도 휠 없음)/켜기 |
| 작업 창·메뉴 막대 | 열기(미리 보기)·Finder에서 보기·끝난 작업 지우기·알림 · 메뉴 막대 메뉴 전 항목 · 파일 열기 → 앱 안 휠 → 방향키·Enter로 실행 |
| 오류·저장 위치 | 읽기 전용 폴더 → 작업 창이 포커스 없이 열리고 "다른 폴더에 저장…" → 다운로드에 저장 · APFS 외장 볼륨(한글 이름)·exFAT 볼륨에서 변환, exFAT에 같은 이름 있으면 `photo (2).png`(원본 해시 그대로) |
| 수명 주기 | 메뉴 막대 "종료" → 프로세스 0개 · 다시 실행 → 이전 작업 기록 표시 · 휠을 띄운 채 화면 잠금(디스플레이 잠자기) → 휠 사라짐, 로그 `system suspended or locked` / `resumed or unlocked` |
| 다크 모드 | 휠·편집기·Finder 모두 다크 팔레트 |

**이 점검에서 찾아 고친 것** (각각 고친 설치본을 다시 설치해 확인):
1. **이름과 실제 형식이 다른 파일**(`png-named.jpg`, 실제로는 PNG)을 휠의 PNG에 놓으면 "지원하지 않는 형식" 알림만 뜨고 아무 일도 없었다
   → 실제 형식으로 다시 인코딩해 올바른 이름(`png-named.png`)으로 저장, 이름까지 맞는 파일은 "건너뜀(이미 같은 형식)"으로 기록(45c6990).
2. **편집기가 화면보다 길어짐**: 배경 추가에서 배경 이미지를 고르면 한 줄이 늘어 "배경과 함께 저장" 버튼이 화면 아래로 밀렸다(1440×900, Dock 표시)
   → 편집기 패널을 재서 미리보기 높이를 줄이고(4b5375d, 8379e89 — 처음 수정은 편집기에 연결되지 않아 VM 재시험에서 드러나 다시 고침),
   맨 아래 버튼 줄은 화면에 고정(049d644).
3. **포커스 없이 열린 작업 창의 첫 클릭이 버튼에 닿지 않음**: "다른 폴더에 저장…"을 두 번 눌러야 했다 → 작업 창·Drop Zone은 비활성 상태에서도
   첫 클릭을 받음(86c309b).
4. **다시 실행한 뒤의 이전 작업**에 "다른 폴더에 저장…"이 보였지만 누르면 "다시 시도할 수 없습니다"만 나왔다(입력·옵션은 일부러 저장하지 않음)
   → 이전 실행의 작업에는 다시 시도 버튼을 보이지 않음, 이번 실행에서 이미 다시 시도한 작업은 창을 다시 열어도 "다시 시도했습니다" 유지(d1ce089).

**경계 상황(2026-10-24, 같은 VM)**:
* 1억 800만 픽셀 PNG(12000×9000) → JPG 약 7초(6천만 픽셀이 넘어 흘려 쓰는 인코딩), 결과 12000×9000.
* 248바이트 한글 이름 + "With Background" → 결과 이름 254바이트(255바이트 한도 안, 글자 경계에서 자르고 꼬리와 확장자 유지).
* 80쪽 PDF → PNG(300 DPI) 3.1초에 80개.
* A0 24쪽 PDF(쪽당 약 1억 픽셀) 변환 중 작업 창에서 취소 → 이미 저장된 쪽까지 되돌려 결과 0개, 임시 파일 0개.
* 같은 작업 중 처리 프로세스를 `kill -9` → 이미 저장된 8쪽을 되돌리고 자동 재시도(attempt=2) → 24쪽, `(2)` 없음, 임시 파일 0개.
  **처음에는** 남은 임시 파일을 찾느라 출력 폴더 목록을 읽어 macOS 폴더 접근 대화상자가 떴고, 정리가 10초 제한에 걸려 작업이
  재시도 없이 `OUTPUT_WRITE_FAILED`로 끝났으며 임시 파일 하나가 남았다 → 처리 프로세스가 임시 파일 경로를 미리 알리고 main은 그
  경로만 지우도록 고침(330a892, [permissions.md](permissions.md)). 고친 설치본으로 두 번 다시 확인(저장된 쪽 0개일 때, 8개일 때).
* 로그인할 때 실행: 설정에서 켜고 OrbitDrop을 **종료한 뒤** VM을 다시 시작 → 로그인하자 OrbitDrop이 스스로 실행됨(실행 중이던 앱을
  되살리는 macOS 창 복원과 구분하려고 먼저 종료). 덧붙여, 미서명(ad-hoc) 빌드를 새 빌드로 바꿔 설치하면 macOS가 코드 서명이 다른
  앱으로 보고 로그인 항목을 끈다 — OrbitDrop은 시작할 때 이 OS 상태를 따라 설정을 끔으로 표시한다(로그 "launch at login was changed in
  the system settings"). Developer ID로 서명한 빌드는 업데이트해도 같은 앱으로 남는다.

### 가상 머신 핵심 흐름 점검 — macOS 26.6.2 (2026-10-24)

개발 Mac과 같은 계열인 macOS 26 게스트에서 같은 방법(실제 Finder, 설치본, 게스트 VNC 입력, SSH로 결과 확인)으로 핵심 흐름과
충돌 처리를 다시 확인했다. 나머지 형식·도구는 같은 코드라 macOS 14 전 기능 점검으로 갈음한다.

| 항목 | 값 |
|---|---|
| 게스트 | macOS 26.6.2 (25G83) arm64 |
| 이미지 | `ghcr.io/cirruslabs/macos-tahoe-vanilla:latest` (manifest `sha256:eeec54bf…`, 24.0 GB), tart 2.41.1 |
| 자원 | CPU 4 · 메모리 6 GB · 화면 1440×900 px(1×) |
| 설치본 | arm64 DMG sha256 `2b60660c65d6415e…`(소스 `330a892`, 아래 최종 설치본과 같은 파일), `codesign --verify --deep --strict` 통과, 격리 속성 없음 |

| 항목 | 결과 |
|---|---|
| 첫 실행 | 창 없이 메뉴 막대 아이콘, helper `ready … globalDrag=true`(실행 후 0.8초), 권한 대화상자 없음. 첫 알림 때 macOS 알림 허용 배너(옵션 → 허용) |
| 영상 흐름 | 바탕화면의 3쪽 `report.pdf`를 Shift 드래그 → 휠(DOCX·JPG·PNG·TXT), 메뉴 막대는 계속 Finder → JPG → `report-p001…p003.jpg` 2550×3300(2.6초) → Option+Shift → 자르기 1:1, 상자를 위로 옮겨 적용 → `report-p001 Cropped.jpg` 2550×2550 → 배경 추가에서 **배경 이미지**(파일 대화상자, 이미지가 아닌 파일은 흐리게 표시)를 고르자 미리보기가 줄고 "배경과 함께 저장"은 Dock 위 화면 안에 그대로 → `report-p001 Cropped With Background.png` 2400×2400. 원본 6개 해시 그대로, 임시 파일 0개, **바탕화면 폴더 접근 대화상자 없음** |
| 휠 옆 투명 영역 | 휠 창 오른쪽 위 모서리(링 밖 약 46 pt) 아래 Finder 폴더가 강조되고 파일이 폴더로 옮겨짐, OrbitDrop 작업 없음. 잠시 뒤 Finder 스프링 로딩으로 폴더 창이 열림 |
| 텍스트 드래그 | TextEdit에서 고른 글자를 Shift 드래그 → 비활성 휠, 가운데 캡슐과 링 아래 캡션 모두 "파일이 아님", 놓아도 작업·텍스트 조각 파일 없음 |
| HEIC | `IMG_1234.jpg`(4032×3024, EXIF 방향 6) → `IMG_1234.heic` 3024×4032, `public.heic`(1.7초) |
| 처리 프로세스 강제 종료 | A0 24쪽 PDF → PNG 중 `kill -9`: ① 저장된 쪽 0개일 때 → 자동 재시도(attempt=2) 24쪽 ② 4쪽 저장 뒤 → 로그 "outputs of an interrupted job removed … removed=4", "temp files … removed=1" → 재시도 24쪽. 두 번 모두 `(2)` 없음, 임시 파일 0개, 폴더 접근 대화상자 없음, 원본 해시 그대로. 쪽은 8402×11878(쪽당 1억 픽셀 제한 → 알림 "크기 제한 때문에 줄였습니다") |
| 메뉴 막대·창 | 메뉴 전 항목, 작업 창(결과·경고·Finder에서 보기), 설정 창이 그려짐 |
| 로그인할 때 실행 | 설정에서 켬 → macOS "Login Item Added" 알림 → 메뉴 막대에서 종료 → VM 다시 시작 → 로그인하자 OrbitDrop 실행(helper `ready`까지 3초) → 곧바로 PNG→JPG 드래그 정상 |
| **x64 설치본(Rosetta 2)** | 게스트에 Rosetta 2를 설치하고 x64 DMG를 설치(실행 파일·helper 모두 x86_64). macOS가 "Support Ending for Intel-based Apps" 알림을 띄움. 첫 실행은 앱을 연 뒤 약 1분 40초가 지나서야 시작됨(세 번 1:38–1:43, 그동안 Rosetta의 `oahd-helper`가 CPU 98%로 번역). 이후 PDF→JPG 3쪽 → 자르기 1:1(2550×2550) → 배경 추가(1941×2400 PNG) → JPG→HEIC(3024×4032) 모두 실제 Finder 드래그로 정상, CPU를 꽉 채운 상태(부하 평균 8, CPU 4개)에서도 휠·드롭 정상. 최종 설치본: 시작 알림 "Apple 실리콘용 OrbitDrop을 설치하세요", 정보 창 "macOS · x64(Rosetta 2) · 설치본" |
| 알림 클릭 | 작업 완료 알림 → 결과 파일이 선택된 Finder 창, 설정 초기화 알림 → 설정 창(경고 표시). 다른 창은 열리지 않음(아래 발견 2 이후). 실행 중인 앱을 다시 열면(`open -a`) Drop Zone |

**이 점검에서 찾아 고친 것** (각각 고친 설치본을 이 게스트에 다시 설치해 확인):
1. **x64 설치본의 느린 첫 실행(Rosetta 2)**: Rosetta를 막 설치한 게스트의 첫 실행에서 엔진 점검이 30초 제한에 걸려 처리 프로세스를 다시
   시작했고, 다시 점검할 때까지 30초 동안 모든 동작이 비활성이었다. 이 Mac에 맞는 설치본을 알려 주는 안내도 없었다 → 엔진 점검 제한을
   90초(전체 120초)로 늘리고, Apple 실리콘에서 x64 빌드가 실행되면 시작 알림·설정 › 일반 안내·정보 창 표시로 arm64 설치본을 안내
   (c12378d). 고친 설치본의 첫 실행 두 번은 점검이 한 번에 끝났지만(앱 시작부터 20–28초), 그때는 Rosetta 번역 캐시가 이미 있어서 맨 처음
   상황을 그대로 다시 만든 것은 아니다.
   **원인을 확정하지 못한 것**: 이 첫 실행 동안 드래그 두 번에 휠이 뜨지 않았다. 첫 번째는 점검이 끝나기 전이라 설명이 되지만(helper가 아직
   설정을 받지 못함), 두 번째(8:54 PM)는 다시 한 점검이 성공한 뒤였다. 그 시각에도 Rosetta가 Electron 프레임워크를 번역하느라 CPU를 다 쓰고
   있었고, Rosetta를 갓 설치해 helper가 쓰는 시스템 프레임워크도 처음 번역되던 중이었을 가능성이 있다. 그 뒤로는 — 디버그 기록을 켠 다시
   실행, 앱 서명을 바꿔 앱 번역을 다시 하게 한 첫 실행(드래그 8번), CPU를 꽉 채운 상태 — 점검이 끝난 뒤의 드래그에서 휠이 매번 떴다.
   다시 보려면 Rosetta가 없는 새 게스트가 필요하다.
2. **알림을 누르면 Drop Zone도 열림**: 작업 완료 알림을 누르면 Finder에 결과가 선택되면서 Drop Zone 창이 함께 떴다. macOS가 알림 클릭 뒤
   약 140 ms에 앱 다시 열기(`activate`)를 보내고, 다시 열기는 Drop Zone을 여는 동작이었다 → 알림 클릭 뒤 3초 안의 다시 열기는 무시(0a4eef3).
   Finder·Spotlight·Launchpad에서 다시 열면 그대로 Drop Zone.

macOS 26에서 따로 보지 않은 것: 다크 모드·Retina 2×·여러 파일·Esc(macOS 14에서 확인), 보조 모니터, 화면 잠금, Intel 실기(x64는
Apple 실리콘의 Rosetta 2에서만).

최종 설치본(소스 `0a4eef3`): arm64 DMG sha256 `d994495f576de3d054e569af783270bb1f7011b55bbde91463f6ea96660d62fb`, x64 DMG
`68d40625b8295ce3390b7f7ee28feb62a89b51af5ed08fbea189598887bf243a` — 이 두 파일을 macOS 26 게스트에 설치해 실제 Finder 드래그 변환·알림
클릭(arm64)과 Rosetta 안내·변환(x64)을 마지막으로 확인했다. 위 점검의 대부분은 그 전 설치본(`330a892`, arm64 `2b60660c…`)으로 했고,
그 뒤 바뀐 것은 위 발견 1·2뿐이다. 해시와 패키지 검사: 아래 [패키징](#패키징-macos-이-저장소의-개발-mac).

**재현.** 도구와 절차: [scripts/vm/README.md](../scripts/vm/README.md). 요약: `tart clone ghcr.io/cirruslabs/macos-sonoma-vanilla:latest od-sonoma`
(macOS 26은 `macos-tahoe-vanilla`) → `tart run od-sonoma --no-graphics --vnc-experimental --dir=xfer:<폴더>:ro` → 게스트(admin/admin)에서
DMG 설치 → VNC 클라이언트로 드래그(버튼 누름 → 몇 픽셀씩 이동 → Shift(또는 Meta+Shift) 누름 → 조각으로 이동 → 놓기). 회선이 느리면
tart가 연결 하나로 받아 매우 느릴 수 있어(이 Mac에서 0.5 MB/s), 이미지 조각을 여러 연결로 받아(해시 확인) 로컬 레지스트리로 넘겼다.

### Windows — GitHub 러너 GUI 드래그 자동 시험 (2026-11-12)

**방법.** GitHub Actions의 Windows 러너(가상 머신)에서 **실제 파일 탐색기**와 **설치본**(무서명 NSIS, 사용자별 무인 설치)으로
시험했다. 입력은 시험 드라이버(`tests/windows-gui/driver`, C#, 러너에서 빌드)가 `SendInput`으로 합성했다: 탐색기 항목 위에서 버튼을
누르고 `SM_CXDRAG`보다 멀리 움직여 탐색기가 OLE 드래그를 시작하게 한 뒤 Shift를 누르고, helper의 휠 창(클래스
`OrbitDropWheelWindow`)이 보이면 그 창의 사각형과 공유 기하(`packages/contracts`의 `DEFAULT_WHEEL_GEOMETRY`·메뉴 순서,
`tests/windows-gui/geometry.mjs`)로 계산한 조각 중심으로 옮겨 놓는다. 휠의 상태는 helper가 휠 창 제목에 넣는 가운데 글
(`OrbitDrop 휠: JPG`)로, 결과는 디스크의 파일(디코딩·SHA-256)과 OrbitDrop의 `main.log`(`ORBITDROP_DEBUG=1`,
`ORBITDROP_HELPER_DEBUG=1` — helper의 줄도 들어 있다)로 확인했다. 휠이 뜨기를 기다리는 시간은 최대 3초, 결과 파일은 최대 90초다.
첫 실행의 UI 언어는 OS의 언어 목록을 따르므로(한국어 → ko, 그 밖 → en) 영어 러너에서는 사용자 언어 목록 맨 앞에 한국어를 넣고
(`Set-WinUserLanguageList ko-KR, en-US` — OS 표시 언어는 영어 그대로) 설치본을 처음 실행했다.
**사람이 아니라 스크립트가, 실물 PC가 아니라 Hyper-V 가상 화면에서 조작했으므로 실물 Windows 11 PC에서 사람이 하는 GUI 검증을
대신하지 않는다.** 워크플로 `.github/workflows/windows-gui.yml`(브랜치 `ci/windows-gui`, push·수동 실행).

| 항목 | 값 |
|---|---|
| 러너 | GitHub Actions `windows-2025`, 이미지 `windows-2025-vs2026` 20261103.298.1 |
| OS | Windows Server 2025 Datacenter 24H2, 빌드 26100.33674 — Windows 11 24H2와 같은 26100 계열이지만 **서버 에디션**이다 |
| 화면 | 1024×768 px, 96 DPI(100 %), 모니터 1개(Microsoft Hyper-V Video), 작업 영역 1024×720(아래 작업 표시줄) |
| 세션·권한 | 콘솔 세션 2(활성), 입력 데스크톱 `WinSta0\Default`, 사용자 `runneradmin`(관리자). 작업·탐색기·OrbitDrop·helper 모두 **High** 무결성(UAC `EnableLUA=1`이지만 토큰 분할 없음 — elevation type `default`) |
| 설치본 | `OrbitDrop-0.1.0-win-x64-unsigned-setup.exe`(무서명) sha256 `97a02e3f4a9368a1de1c9c80bf6ecb1433452d0c2971c74f86381aa76051668f` — 같은 실행에서 소스 `56810ad`(작업 트리 깨끗함)로 빌드, `/S`로 `%LOCALAPPDATA%\Programs\OrbitDrop`에 설치. `OrbitDrop.exe` `57f35224…`, `OrbitDropHelper.exe`(MSVC) `8ffa6cdf…` |
| 프로필 | 새 러너의 `%APPDATA%\OrbitDrop`(시작 전에 없음을 확인; 설치본은 `ORBITDROP_USER_DATA_DIR`을 따르지 않는다). 드라이버가 같은 단계에서 OrbitDrop을 실행한다(아래 발견 2) |
| UI 언어 | ko(언어 목록 한국어 우선 → 첫 실행이 ko를 고름). 언어 목록을 그대로 둔 실행([43178286524](https://github.com/keilvher1/orbitdrop/actions/runs/43178286524))은 영어 UI로 열렸고(환영 창 "Get Started with OrbitDrop") 드래그 사례 2–9는 같은 동작이었다(텍스트 드래그는 "Not a file"로 거부) |
| 실행·증거 | [43181416215](https://github.com/keilvher1/orbitdrop/actions/runs/43181416215)(브랜치 끝 `56810ad`) — 9개 사례 모두 통과. 바로 전 커밋 `8f8d312`로 빌드한 [43180012036](https://github.com/keilvher1/orbitdrop/actions/runs/43180012036)도 모두 통과. 아티팩트 `windows-gui-evidence`(스크린샷·`results.json`·`summary.md`·`driver.log`, OrbitDrop의 `main.log`·`helper.log`·stdout/stderr, 탐지 결과), `windows-gui-app`(설치본·`build-report-win32-x64.json`). 스크린샷 일부는 `docs/screenshots/runner-win2025-*.png`(05는 고치기 전 실행 43176700062, 07은 43180012036, 나머지는 43181416215) |

| # | 사례 | 결과 | 확인 내용 · 스크린샷 |
|---|---|---|---|
| 0 | 탐지 | 통과 | 위 세션·권한·화면 값, 그리고 합성 입력으로 탐색기에서 파일을 하위 폴더로 끌어 옮김(이동 확인) — 아티팩트 `probe/screenshots/probe-03-dragging.png` |
| 1 | 첫 실행 | 통과 | 환영 창 "OrbitDrop 시작하기"만 열림(다른 OrbitDrop 창 없음) → 제목 표시줄 클릭 + Esc로 닫히고 남는 창 없음, helper `ready … globalDrag=true`(실행 후 0.3–0.4초, 엔진 점검 `capabilities ready`는 4–5초), helper 1개, helper와 셸(탐색기)의 무결성 수준 같음, 휠 창(레이어드·최상위·비활성)이 숨은 채 존재, 휠 제목이 앱 언어를 따름("OrbitDrop 휠") |
| 2 | PDF → JPG(Shift를 누른 채 놓기) | 통과 | Shift 뒤 약 40–170 ms에 휠이 포인터 위치에(중심 오차 0 px), 탐색기가 포커스 유지, 가운데 "PDF", 위부터 시계방향 DOCX·JPG·PNG·TXT, JPG 조각이 주황(`#D4441C`)·가운데 캡슐과 아래 캡션 "JPG", 탐색기의 드래그 이미지(영어 UI의 "+ Copy")가 휠 위에 보임 — `runner-win2025-01` · 놓자 `Page 001.jpg` 2550×3300 JPEG, 새 파일 정확히 1개, PDF 해시 그대로(탐색기에서 Shift는 이동인데도 원본 이동 없음), `drop accepted` 1회 — `runner-win2025-02` |
| 3 | JPG → PNG | 통과 | 8조각 이미지 메뉴(위부터 시계방향 PNG·WEBP·HEIC(비활성 — Windows 미지원)·TIFF·AVIF·BMP·PDF·DOCX)의 맨 위 PNG가 강조, `photo.png` 320×240 PNG, 원본 해시 그대로 — `runner-win2025-06` |
| 4 | Esc | 통과 | JPG가 강조된 채 Esc → 버튼을 누른 상태에서 휠이 바로 사라지고 놓은 뒤에도 다시 나오지 않음, 결과 없음, 원본 그대로, `cancelled escape` |
| 5 | 링 밖에 놓기(휠 창의 투명 모서리) | 통과 | 모서리 픽셀은 클릭이 통과(`WindowFromPoint` → 탐색기, 디스크 위는 휠 창), 탐색기 드래그 이미지가 "Move to OrbitDrop GUI test"로 바뀜(탐색기가 대상) — `runner-win2025-03` · 놓아도 결과 없음, 원본이 같은 폴더에 그대로(해시 동일), `cancelled dragEnded` |
| 6 | 가운데(dead zone)에 놓기 | 통과 | 가운데로 오면 강조가 풀리고("PDF"), 놓으면 휠이 거부, 결과 없음, `cancelled outsideRing` |
| 7 | Shift를 먼저 떼기 | 통과 | Shift를 떼도 휠 유지, 이어서 JPG에 놓으면 `shift-up.jpg` |
| 8 | 텍스트(파일 아님) 드래그 | 통과 | 시험용 WinForms 창의 글자를 끌기(OLE `DoDragDrop`, 텍스트 형식만) → 휠 가운데와 아래 캡션 "파일이 아님", 조각 위에서도 강조 없음, 놓아도 결과 없음, helper `drag payload not offered: noFiles`, `cancelled invalidPayload` — `runner-win2025-04`(고친 뒤) |
| 9 | 빠른 연속 드롭 2번 | 통과 | 첫 드롭 직후 두 번째 PDF를 끌어 JPG에 놓음(드롭 간격 3.5초 — 드래그 한 번의 길이. 첫 작업은 0.2초 만에 끝나 작업끼리 겹치지는 않음) → 결과 정확히 1개씩(`rapid-a.jpg`, `rapid-b.jpg`), 세션 id 2개, `drop accepted` 2회, 원본 그대로 |

결과 표와 모든 확인 항목은 실행의 작업 요약과 `results.json`에, 스크린샷은 아티팩트 `windows-gui-evidence/suite/screenshots`에 있다
(포인터는 화면 캡처에 찍히지 않아 빨간 십자로 위치를 그렸다). 같은 시험을 여러 번 돌렸다 — 고치기 전 설치본
([43175114169](https://github.com/keilvher1/orbitdrop/actions/runs/43175114169), [43176700062](https://github.com/keilvher1/orbitdrop/actions/runs/43176700062)),
고친 설치본([43177178612](https://github.com/keilvher1/orbitdrop/actions/runs/43177178612), `a5ac7a6`), `main`을 합친 설치본
([43178286524](https://github.com/keilvher1/orbitdrop/actions/runs/43178286524) 영어 UI, [43179437101](https://github.com/keilvher1/orbitdrop/actions/runs/43179437101) 한국어 UI)에서
드래그 사례(2–7·9)는 매번 같은 결과였다. 다른 점은 캡슐 줄바꿈(아래 발견 1)과, 합친 뒤 생긴 환영 창·첫 실행 언어(발견 4)뿐이다.

**이 시험에서 찾은 것:**
1. **휠 가운데 캡슐이 한국어 단어 중간에서 줄을 바꿈(수정함, `a5ac7a6`).** "파일이 아님"이 "파일이 아" / "님"으로 그려졌다
   (`runner-win2025-05`, 화면에서 읽은 글자 줄 폭 64 px / 10 px). helper 자신의 스냅샷에서도 "먼저 내려받으세요"가 "먼저 내려" /
   "받으세요"였다. DirectWrite의 기본 줄바꿈은 한글 음절 사이 어디서나 끊는다. macOS helper(`CapsuleLayout.wrap`)처럼 공백에서만 줄을
   나누고(keep-all) 글자를 1 DIP씩 줄이며 다시 나누도록 고쳤다(`native/windows/src/core/text_wrap`, 단위 테스트 4개, 코어 테스트 103개 ·
   ASan/UBSan 통과). 조각 이름과 아래 캡션은 그대로다. 드라이버는 이제 화면에서 캡슐의 글자 줄을 읽어 단어 중간 줄바꿈을 실패로 본다 —
   고치기 전 설치본에서는 이 확인만 실패했고(실행 43176700062), 고친 설치본에서 통과했다.
2. **러너는 단계(step)가 끝나면 그 단계에서 띄운 프로세스를 끝낸다(제품 문제 아님).** 첫 실행에서 OrbitDrop을 별도 단계에서
   `Start-Process`로 띄웠더니 `native helper ready` 직후 로그가 끊기고 다음 단계에는 프로세스가 없었다(SQLite `-journal` 파일이 남음 =
   강제 종료). 같은 방법으로 띄운 `ping.exe`도 다음 단계에서 사라져 있었고, Windows 오류 보고에 OrbitDrop 충돌 기록은 없었다. 그래서
   드라이버가 시험 단계 안에서 OrbitDrop을 실행하고 종료 코드를 지켜본다.
3. **참고: 휠이 뜬 뒤 마우스를 움직이지 않았는데도 OLE가 드래그 대상을 휠로 바꿨다.** 휠이 보이고 약 0.2초 안에 가운데 글이 "PDF"로
   바뀌었다(DragEnter). 점검표 26(뜨자마자 놓기)의 전제와 관련되지만, 그 자체(움직이지 않고 바로 놓기)는 시험하지 않았다.
4. **첫 실행이 바뀜(제품 변경, 시험 쪽을 맞춤).** `main`에 들어온 첫 실행 흐름은 새 프로필에서 환영 창을 띄우고 UI 언어를 OS 언어 목록에서
   고른다. 그래서 영어 러너의 첫 합친 실행에서는 시험이 기대한 한국어 글과 달라 첫 실행·텍스트 드래그의 글 확인만 실패했다(동작은 맞았다 —
   영어 환영 창, "Not a file"로 거부). 드라이버는 이제 환영 창 제목으로 앱 언어를 알아내 그 언어의 글로 확인하고, 환영 창을 Esc로 닫는다.
5. **환영 창 본문도 한국어 단어 중간에서 줄을 바꿈(수정함, 렌더러 CSS).** 한국어 첫 실행의 환영 창에서 "남습니" / "다.", "파" / "일 열기"처럼
   끊겼다(`runner-win2025-07`; Chromium의 기본 `word-break: normal`은 한글 음절 사이에서도 줄을 바꾼다). 앱 안 휠의 캡슐(`wheel.css`)과
   두 helper처럼 환영 창(`welcome.css`)에 `word-break: keep-all`을 줬다 — 고친 설치본(실행 43181416215)에서는 "남습니다.", "파일 열기"가 한 줄 안에 그대로 있다(`runner-win2025-08`). 다른 창의 본문 글은 이번에 보지 않았다.

**다루지 않은 것**(이 기록으로 "검증됨"이 되지 않는다):
- 100 % 이외의 배율(125·150·200 %), 보조·음수 좌표 모니터, 화면 가장자리·작업 표시줄 근처(캡션이 위로 가는 경우) — 러너는 1024×768,
  96 DPI, 모니터 1개로 고정이다(점검표 14–16, 34의 일부).
- 실물 PC와 사람: 입력은 `SendInput` 합성, 화면은 가상 디스플레이다. 포인터 모양(복사 +)은 캡처되지 않는다(탐색기 드래그 이미지의
  "+ Copy" 표시로 대신 봤다). 터치·펜 미검증.
- Windows 11 클라이언트 에디션과 일반 사용자 권한: 러너는 Windows Server 2025이고 탐색기와 앱이 모두 High 무결성이다. 일반 사용자
  (Medium)와 "관리자 권한으로 실행" 때의 UIPI 거부(점검표 21·31)는 미검증.
- 도구 휠(Windows 기본 Ctrl+Shift)과 편집 창(점검표 6), 여러 파일, 폴더·가상 파일·
  OneDrive(11·27·30), 긴 경로·네트워크 드라이브(32), 잠금·잠자기(19), 고대비·애니메이션(22), 왼손잡이 버튼(23), Narrator(24).
- 브라우저·메모장에서의 텍스트 드래그: 시험한 텍스트 드래그의 출처는 시험용 WinForms 창이다(서버에는 WordPad가 없고 메모장의 편집
  컨트롤은 글자를 끌어 내보내지 않는다).

**재현.** `ci/windows-gui` 브랜치에 push하거나 `windows-gui` 워크플로를 수동 실행한다(입력 `reuse_app_run`에 이전 실행 id를 주면
설치본을 다시 빌드하지 않는다). 드라이버는 GitHub Actions 밖에서는 실행을 거부한다(마우스와 키보드를 가져가므로 개발 PC에서 돌리지 않는다).

**설치 프로그램의 개인정보 페이지 (2026-11-12, 실행 43195949011, `prep/signpath`).** 워크플로가 무인 설치 대신 드라이버의 `install`로
대화형 설치 프로그램을 끝까지 진행한다: 폴더 페이지 → "Privacy and updates" 페이지(러너는 영어 UI라 영어: 안내문에 GitHub, 개인정보
처리방침 링크, "Check for updates automatically" 상자가 기본 선택 → 해제) → 설치 → 마침 페이지("Run OrbitDrop" 해제) → 종료 코드 0,
22 s. 설치 폴더의 `installer-preferences.json`이 `{"version":1,"updates":{"autoCheck":false}}`이고, 이어진 드래그 시험의 첫 실행이
main.log에 `first run: automatic update checks off, as chosen in the installer`를 남기며, 환영 창을 닫은 뒤의 `settings.json`도
`updates.autoCheck: false`다(시작 사례의 검사). 9개 사례 모두 통과. 첫 시도(실행 43193140854)에서는 버튼을 UI Automation Invoke로 눌렀는데,
NSIS가 그 클릭을 처리하면서 nsDialogs 페이지로 넘어가는 동안 Invoke가 10초 시간 제한까지 기다렸고 다음 페이지의 "Install"이 반응하지 않았다
— 이제 버튼은 실제 마우스 클릭으로 누른다(Invoke는 한 번의 대비책). 같은 브랜치의 CI(실행 43193136046)는 `--install-test`로 `/S`(켬)와
`/S /NOUPDATECHECK`(끔), 제거 후 파일 삭제를 확인했다.

---

## 자동 검증 증거

### 패키징 (macOS, 이 저장소의 개발 Mac)

환경: macOS 26.6 (25G72) arm64, Xcode 27.1, Node 24.7.0, pnpm 11.27.1, electron-builder 26.15.3, Electron 44.9.0.

명령: `node scripts/package.mjs mac --arch all` (2026-10-24 05:45 CST, 소스 커밋 `0a4eef3` — 미커밋 변경 없음, 건너뛴 단계 없음: 라이선스 목록 재생성 → 아이콘 검증 →
`scripts/build-native.mjs mac`로 helper 빌드·서명·stdio smoke → `electron-vite build`(현재 소스) → before-pack(의존성 수집기 보정) → arm64·x64 electron-builder →
after-pack 검사(의존성 트리 포함) → DMG 안의 앱으로 smoke test(숨긴 창 렌더링 포함) → 네이티브 모듈 검사). 종료 코드 0, 미완료 항목 없음. 산출물은 **미서명(ad-hoc)** 이며
이름에 `-unsigned`가 붙는다.

> **이전 0.1.0 패키지는 쓰지 말 것** — 소스 `d4f6d1e`(DMG `234836d3…`/`b3cfebbc…`)는 창이 빈 화면, `7faf031`(`d725a4b4…`/`acea3922…`)은
> 보호 폴더 첫 사용 때 권한 대화상자(아래 가상 머신 기록 발견 1). 첫 문제의 경위: 설치해 실행하면 **모든 창이 빈 화면**이었다
> (`GrantFileProtocolExtraPrivileges` fuse가 꺼져 app.asar 안의 `file://` 화면을 읽지 못함 — `ERR_FILE_NOT_FOUND`). 당시 smoke test는 창을
> 열지 않아 통과했고 E2E는 패키지가 아닌 `out/`으로 돌았다. 2차 점검(패키징)에서 발견해 fuse를 켜고, `package.mjs`가 fuse를 다시 읽어 확인하며,
> smoke test가 숨긴 창을 실제로 그려 보도록 고쳤다(아래 `window`).

| 항목 | macOS arm64 | macOS x64 |
|---|---|---|
| DMG | `apps/desktop/release/OrbitDrop-0.1.0-mac-arm64-unsigned.dmg` 135.4 MB, sha256 `d994495f576de3d054e569af783270bb1f7011b55bbde91463f6ea96660d62fb` | `apps/desktop/release/OrbitDrop-0.1.0-mac-x64-unsigned.dmg` 144.3 MB, sha256 `68d40625b8295ce3390b7f7ee28feb62a89b51af5ed08fbea189598887bf243a` |
| ZIP | `…-mac-arm64-unsigned.zip` 135.1 MB, sha256 `2a328b94fcdd3641446246c7c743f69a1ef574d9f3aa106df47e8d9746e2ab0f` | `…-mac-x64-unsigned.zip` 144.0 MB, sha256 `fe17a3bf26a3dbac7928b774f52c157b8d80043d75630ccbfeee41e9b31253d8` |
| 빌드 보고서 | `build-report-darwin-arm64.json` (`source.commit` 0a4eef3…, `dirty: false`) | `build-report-darwin-x64.json` |
| 앱 크기(설치 시) | 320.2 MB | 333.9 MB |
| `app.asar` / `app.asar.unpacked` | 14.2 MB (1,041 항목 — 브라우저·ESM 중복 빌드 제외) / 45 MB | 14.2 MB (1,041 항목) / 52 MB |
| Info.plist | `CFBundleIdentifier=app.orbitdrop.desktop`, `LSUIElement=true`, `LSMinimumSystemVersion=14.0`, `ElectronAsarIntegrity` 있음, 개인정보 사용 설명 키 없음(`usageDescriptions: []`) | 동일 |
| 메인 실행 파일 (`lipo -archs`) | arm64 | x86_64 |
| **helper** (`Resources/helper/OrbitDropHelper`) | 있음, arm64, 0.7 MB, `Identifier=com.orbitdrop.helper`, `flags=adhoc,runtime`, **entitlements 없음**(빈 `<dict>`), 실행 권한 | 있음, x86_64, 0.8 MB, 동일 |
| helper 빌드(`build-native-mac.mjs`) | minos 14.0, stdio smoke **18/18 통과** | minos 14.0, stdio smoke **18/18 통과**(Rosetta 2) |
| **sharp / libvips** | `sharp-darwin-arm64-0.35.5.node`, `libvips-cpp.8.18.7.dylib`: arm64 (`app.asar.unpacked`) | `sharp-darwin-x64-0.35.5.node`, `libvips-cpp.8.18.7.dylib`: x86_64 |
| **@napi-rs/canvas** | `skia.darwin-arm64.node`: arm64 | `skia.darwin-x64.node`: x86_64 |
| 다른 아키텍처 바이너리 | 없음 | 없음 |
| 서명 (`codesign -dvvv`) | `Signature=adhoc`, `TeamIdentifier=not set`, `flags=adhoc,runtime` | 동일 |
| `codesign --verify --deep --strict` | valid | valid |
| Entitlements | 앱·Electron 하위 앱(`OrbitDrop Helper*.app`): `allow-jit` + `disable-library-validation`(ad-hoc 전용 파일); `OrbitDropHelper`: 없음(`build/sign.cjs`) | 동일 |
| Gatekeeper (`spctl --assess --type execute`) | **rejected** (미서명 — 예상된 결과) | **rejected** |
| Electron fuses (패키지에서 다시 읽음) | RunAsNode·NODE_OPTIONS·CLI inspect 꺼짐, asar 무결성 검증·OnlyLoadAppFromAsar·쿠키 암호화 켜짐, **GrantFileProtocolExtraPrivileges 켜짐**(창이 app.asar 안의 `file://` 화면을 읽기 위해 필요) | 동일 |
| Resources | `THIRD_PARTY_LICENSES.md`, `LICENSE.electron.txt`, `LICENSES.chromium.html`, `tray/trayTemplate{,@2x}.png`, `ko.lproj`, `en.lproj` | 동일 |
| DMG 읽기 전용 마운트 | `Applications → /Applications`, `OrbitDrop.app`; 내부 앱 `codesign --verify` valid | 동일 |
| 의존성 트리(after-pack, Node 해석 방식) | 35개 패키지, 42개 의존성, 문제 0 (`nanoid` 6.0.2, `tslib` 1.14.1 — 이전 패키지는 2건 어긋남) | 동일 |
| smoke test (DMG 안의 앱을 직접 실행) | 종료 0, `helper.ready: true`, **숨긴 About 창 렌더링 329 ms** | `arch -x86_64`(Rosetta 2) 종료 0, `helper.ready: true`, 창 렌더링 6.7초 |
| 네이티브 모듈 검사 | librsvg 2.63.2 / libvips 8.18.7, 그라데이션·둥근 모서리 마스크 정상, canvas `app.asar.unpacked`에서 로드, Apple SD Gothic Neo 한글, 패키지 안의 pdf-lib로 PDF 1쪽·docx로 DOCX 생성 | 동일(Rosetta 2) |

패키지된 앱의 smoke test 출력(arm64, 한 줄):

```text
ORBITDROP_SMOKE {"ok":true,"version":"0.1.0","platform":"darwin","arch":"arm64","packaged":true,"durationMs":1436,"probe":{"ok":true,"decode":["jpeg","png","webp","gif","tiff","avif","heic","bmp","pdf"],"encode":["jpeg","png","webp","gif","tiff","avif","heic","bmp","pdf","docx","txt"],"pdfRender":true,"pdfText":true,"enabledActions":["convert.jpeg","convert.png","convert.webp","convert.heic","convert.tiff","convert.avif","convert.bmp","convert.pdf","convert.docx","convert.txt","tool.compress","tool.metadata","tool.edit","tool.annotate","tool.addBackground","tool.crop","tool.redact"],"errors":[]},"helper":{"ok":true,"required":true,"found":true,"source":"packaged","ready":true,"version":"0.1.0","globalDrag":{"available":true,"reason":null},"error":null},"conversion":{"ok":true,"actionId":"convert.jpeg","state":"completed","width":64,"height":48,"bytes":865,"ms":215,"error":null},"pdfConversion":{"ok":true,"actionId":"convert.png","state":"completed","width":300,"height":150,"bytes":1395,"ms":255,"error":null},"window":{"ok":true,"view":"about","ms":329,"loaded":true,"preload":true,"rendered":true,"shown":false,"error":null,"consoleErrors":[]}}
```

x64(Rosetta 2)도 같은 내용(`"arch":"x64"`, `helper.ready: true`, `window.rendered: true`)이다. 의미:
패키지 안에서 엔진 probe(HEIC는 helper의 ImageIO 모드), 번들 helper 탐색·`ready` 핸드셰이크, 실제 작업 파이프라인으로
PNG→JPEG와 PDF→PNG(utilityProcess의 PDF.js + @napi-rs/canvas)가 성공했고, 실제 창 구성(app.asar의 `file://` 화면, preload, CSP, IPC)으로 숨긴 About 창이 그려졌다. **실제 Finder 드래그 검증은 아니다.**

### 네이티브 모듈 검사 (Add Background / Annotate 의존성)

패키지된 실행 파일은 임의 스크립트를 실행할 수 없으므로(RunAsNode fuse 꺼짐, asar 전용), 같은 버전의 기본 Electron 44.9.0
런타임이 `apps/desktop/build/native-check`를 utilityProcess로 실행해 **각 패키지의 Resources 안에 있는 모듈 파일**을 앱 번들과 같은
경로 해석(`app.asar/out/main` 기준)으로 불러온다(x64는 electron-builder가 내려받은 darwin-x64 런타임을 Rosetta 2로 실행).
`package.mjs`가 매 패키징마다 자동 실행하며 실패하면 빌드를 실패시킨다.

| 검사 | arm64 | x64 |
|---|---|---|
| libvips의 librsvg / SVG 입력 | 2.63.2 / 있음 | 2.63.2 / 있음 |
| `userSpaceOnUse` 선형 그라데이션(빨강→파랑) 양 끝 픽셀 | `[253,0,2,255]` → `[2,0,253,255]` | 동일 |
| 방사형 그라데이션 중심 | `[250,246,251,255]` | 동일 |
| `rx/ry` 둥근 사각형 마스크 → `extractChannel(0)` (모서리/가장자리 중앙/중심) | 0 / 255 / 255 | 동일 |
| 시스템 한글 글꼴(@napi-rs/canvas `GlobalFonts`) | Apple SD Gothic Neo, "한글 주석" 잉크 739 px | 동일 |
| 프로세스에 실제로 매핑된 네이티브 파일 | `…/mac-arm64/OrbitDrop.app/Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node`, `…/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib`, `…/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node` | `…/mac/OrbitDrop.app/…/sharp-darwin-x64-0.35.5.node`, `…/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.7.dylib`, `…/canvas-darwin-x64/skia.darwin-x64.node` |

after-pack 훅 로그(발췌, arm64):

```text
• [after-pack] checking darwin-arm64 package in release/mac-arm64
• [after-pack] app.asar 14.2 MB, 1041 entries
• [after-pack] dependency tree: 35 packages, 42 resolved dependencies, 0 problems
• [after-pack] sharp: sharp-darwin-arm64-0.35.5.node (arm64)
• [after-pack] libvips: libvips-cpp.8.18.7.dylib (arm64)
• [after-pack] @napi-rs/canvas: skia.darwin-arm64.node (arm64)
• [after-pack] helper: helper/OrbitDropHelper arm64 0.8 MB
• [after-pack] app.asar.unpacked 44.9 MB
• [after-pack] ok (darwin-arm64)
```

훅이 실제로 잡아낸 문제(수정 완료): 플랫폼별 `files` 목록 때문에 `apps/desktop/src/**`, `test/**`, tsconfig가
`app.asar`에 들어간 빌드를 "app.asar contains development files"로 실패시켰다 → 제외 규칙을 최상위 `files`로 옮김.
그 밖에 패키징 도중 다른 작업이 `apps/desktop/out`을 다시 빌드하면 `package.mjs`가 이를 감지해 실패시킨다.

### 패키지 관련 실측 (Electron 44.9.0, 이 Mac)

* `utilityProcess` 안에서 asar 읽기: `fs.readFileSync`, `fs/promises.readFile`, `process.getBuiltinModule('fs/promises')`,
  ESM `import()`, `require` 모두 `app.asar` 내부 파일을 읽음. `fetch(file://…)`는 실패(Node fetch는 `file:` 미지원).
* `utilityProcess`의 `process.type`은 `"utility"` → PDF.js의 `isNodeJS`가 `false`, `document`/`Worker`/`XMLHttpRequest` 없음.
  processors가 팩토리를 직접 넘겨 해결했고, 패키지 smoke probe의 `pdfRender:true`/`pdfText:true`로 확인.
* electron-builder의 macOS 출력에는 `LICENSES.chromium.html`/Electron `LICENSE`가 빠져 있음 → `extraResources`로 번들에 포함, after-pack이 확인.

### 아이콘

`node scripts/gen-icons.mjs` → `build/icon.png`(1024), `build/icon.icns`(PNG 항목 10개: 16–1024, TOC 포함),
`build/icon.ico`(16·20·24·32·40·48·64·128·256), `resources/tray/*`. 자체 검증(다시 읽어 크기·RGBA·템플릿은 검정+알파만 확인)과
`iconutil -c iconset`으로 ICNS 왕복 확인, `file`: "MS Windows icon resource - 9 icons … PNG image data".

### after-pack 바이너리 판별기

Mach-O/PE 판별과 PE import 표 파서를 실제 파일로 확인: Electron 44 `electron.exe`(x64, imports `KERNEL32.dll` 등, VC 런타임 없음),
MinGW로 만든 C++ 시험 exe(`libstdc++-6.dll` import → 정책 위반으로 탐지), sharp/libvips/canvas darwin 바이너리(arm64/x64),
유니버설 `/bin/ls`(x64+arm64).

### Windows

**NSIS 설정 검증(macOS에서, 설정 확인 전용)**: after-pack 훅을 끈 채 electron-builder로 NSIS 설치 프로그램을 macOS에서
컴파일했다(산출물은 Windows 네이티브 모듈이 없으므로 사용 불가, 배포하지 않음). 결과: `build/installer.nsh`의
`customInstallMode` 매크로와 한국어/영어 설치 언어를 포함한 스크립트가 오류 없이 컴파일됨, 설치 프로그램과
`OrbitDrop.exe`의 매니페스트 `requestedExecutionLevel=asInvoker`(UAC 요청 없음), Authenticode 서명 없음(인증서 표 0바이트),
`locales/`에 `en-US.pak`·`ko.pak`만 남음, `LICENSE.electron.txt`·`LICENSES.chromium.html`이 exe 옆에,
`resources/THIRD_PARTY_LICENSES.md`·`resources/tray/` 포함, asar 무결성 리소스 기록("updating asar integrity executable resource").
이 시험에서 `elevate.exe`가 포함되는 것을 보고 `nsis.packElevateHelper: false`를 추가했다. 교차 빌드에서는
`${platform}`이 호스트 OS라 darwin 바이너리가 들어갔다 — 그래서 `package.mjs`는 교차 빌드를 거부한다.

### CI — GitHub Actions에서 처음 돌린 Windows (2026-11-12)

개발 환경에는 Windows 기기가 없어서, 아래가 OrbitDrop이 **Windows에서 실제로 실행된 첫 기록**이다. 사람이 Explorer에서
드래그한 검증은 아니다(위 결과 기록표 — Windows는 여전히 미실시). 실제 탐색기 드래그는 같은 러너에서 합성 입력으로 따로 시험했다 —
[Windows — GitHub 러너 GUI 드래그 자동 시험](#windows--github-러너-gui-드래그-자동-시험-2026-11-12).

환경: GitHub Actions `windows-latest` = **Microsoft Windows Server 2025 Datacenter 10.0.26100 (빌드 26100.33674)**, x64, 러너
이미지 `windows-2025-vs2026` 20261103.298.1, Visual Studio 2026(MSVC 19.51.36260, Windows SDK 10.0.26100), Node 24.22.2,
pnpm 11.27.1, Electron 44.9.0. 레지스트리 `LongPathsEnabled=1`, 한글 글꼴 Malgun Gothic 설치됨. 작업은 관리자(runneradmin)
권한으로 돈다. 녹색 실행: https://github.com/keilvher1/orbitdrop/actions/runs/43178538763 (소스 `a41608f`, main `4b9e3a0` 병합 뒤).

| 단계 | 결과 |
|---|---|
| 단위·통합 테스트 (`pnpm test`) | 95 파일 통과·3 건너뜀, 1,167 통과·25 건너뜀 (macOS 러너와 같은 테스트, 건너뜀은 아래 표) |
| Windows helper (MSVC `/MT`) | 코어 테스트 99개(골든 벡터 포함), OLE 글루 테스트 6개, stdio smoke 47개 확인 모두 통과, Direct2D 휠 스냅숏 생성. DLL 의존성은 시스템 DLL뿐 |
| E2E (`playwright test`, 빌드된 앱 + 실제 MSVC helper) | 31 통과, 8 건너뜀 |
| NSIS 패키지 | `OrbitDrop-0.1.0-win-x64-unsigned-setup.exe` 102.3 MB(`win-unpacked` 393.1 MB), sha256 `8bd6aee5d091111b7f085668efed40b11d48aec1751e27bb2f8c1a96a182491e` (미서명). after-pack: 의존성 트리 문제 0, sharp/libvips/canvas는 x64 PE, helper 포함 |
| 패키지 smoke test (`win-unpacked\OrbitDrop.exe --smoke-test`) | 종료 0, 1.7초(보고서 1,287 ms), `ok:true` — 엔진 probe(HEIC 없음, 16개 작업 사용 가능), helper `ready`(packaged), PNG→JPG 412 ms·PDF→PNG 528 ms, 숨긴 About 창 렌더링 458 ms |
| 네이티브 모듈 검사 | librsvg 2.63.2 / libvips 8.18.7, Malgun Gothic 한글 잉크 766 px, 패키지 안의 pdf-lib·docx로 PDF·DOCX 생성, 네이티브 모듈은 `app.asar.unpacked`에서 로드 |
| 사용자별 무인 설치 → 설치본 smoke → 무인 제거 | `/S /D=<임시 폴더>` 종료 0, 설치본에 helper·라이선스 파일, **HKCU 제거 항목만**(HKLM 없음, 관리자 권한 없음), 설치본 smoke `ok:true`, `Uninstall OrbitDrop.exe /S` 뒤 파일·HKCU 항목·설치 폴더 모두 없음 |

처음 실행에서 드러난 문제와 처리(분류: **제품 버그** / **플랫폼 차이** / **POSIX를 가정한 테스트**):

- **제품 버그 — PDF의 내장되지 않은 한글 글꼴이 빈칸**: PDF.js는 내장되지 않은 글꼴(예: `UniKS-UCS2-H` CMap의 CID 글꼴)을
  `"g_d0_f1", sans-serif`로 그리는데, @napi-rs/canvas의 일반 글꼴 계열은 Windows에서 Arial 하나라 한글 잉크가 0이었다. 한글이 든
  글자열만 한글 글꼴(Malgun Gothic, `resolveAnnotationFont`)을 맨 앞에 두고 그린다. 라틴 글자는 그대로.
- **제품 버그 — 너무 긴 이름이 "파일 없음"**: Windows는 255 UTF-16 단위를 넘는 이름을 ENOENT로 알린다. 입력 검증이 NTFS 한도
  (이름 255, 경로 32,767 단위)를 직접 확인해 macOS처럼 `PATH_TOO_LONG`. MAX_PATH(260)를 넘는 경로는 계속 동작한다.
- **제품 버그 — helper MSVC 빌드 실패**: `renderer.cpp`의 변수 이름 `small`(Windows SDK `rpcndr.h`의 `#define small char`).
- **빌드 도구 버그(Windows 패키징)**: after-pack이 app.asar 항목을 `/`로 넘겨 `@electron/asar`가 찾지 못함, 네이티브 모듈 검사가
  `\\?\` 접두사 때문에 "패키지 밖에서 로드"로 판정 — 둘 다 고침.
- **플랫폼 차이 — 산술 부호화 JPEG**: sharp의 Windows libvips는 산술 부호화 디코딩 없이 빌드됐다("arithmetic coding is not
  implemented"). `IMAGE_CORRUPT`(손상) 대신 `ENGINE_UNAVAILABLE`(이 빌드에서 읽을 수 없음, `detail: jpeg-arithmetic: …`)로 알린다.
- **POSIX를 가정한 테스트**: 경로 기대값(`join`/`resolve`), `.cmd` 실행(Node는 셸 없이 `.cmd`를 실행하지 않음 — Electron 실행 파일을
  직접 실행), 읽기 전용 폴더(아래), 긴 경로를 `sharp(path)`로 읽음(libvips는 MAX_PATH 제한 — Node로 읽어 넘김), libvips 캐시가 연
  파일을 지우려다 EBUSY, utilityProcess의 `exit`가 stdout 마지막 데이터보다 먼저 와서 결과 줄 유실, 닫히는 창의 `getURL()`,
  MFT에 들어가는 작은 파일(할당 블록 0)이 macOS 흉내 테스트에서 iCloud 자리 표시자로 보임, OLE 테스트의 임시 객체 참조(MSVC에서 드러난 UB),
  설치 테스트가 레지스트리 키를 파일보다 먼저 확인(NSIS는 파일을 먼저 지움).

Windows 러너에서 측정한 사실: 폴더의 읽기 전용 특성은 쓰기를 막지 않는다. 거부 ACL(`icacls … /deny *S-1-1-0:(WD,AD)`)은
PowerShell·.NET은 막지만 **Node는 막지 못한다** — libuv가 `FILE_FLAG_BACKUP_SEMANTICS`로 열고 러너 작업 토큰은 백업/복원 권한이
켜져 있다(일반 사용자 세션에서는 ACL이 적용된다). 다른 프로세스가 삭제 공유 없이(`FileShare.Read`) 연 파일은 이름 변경·교체·삭제가
EBUSY/EPERM으로 막힌다 — 설정 파일 테스트는 Windows에서 이 방법(동기화 클라이언트·백신이 파일을 잡은 상황)을 쓴다.

같은 워크플로의 macOS 작업(GitHub `macos-26-arm64` 20261102.0473.1, macOS 26.7.2 25G332, 가상 머신): 단위·통합 96 파일·1,183 통과,
Swift 167개 통과(건너뜀 0), helper 빌드·smoke 19/19(arm64, x64는 Rosetta 2), E2E 39/39, arm64 DMG에서 패키지 smoke 통과, 두 아키텍처의
네이티브 모듈 검사 통과. 이 러너에서 처음 돈 macOS 작업은 Swift 테스트에서 60분 동안 멈췄고(아래 표의 Swift 줄), x64 패키지의 smoke는 Rosetta 2
환경 때문에 best effort로 돈다(아래 표). main 병합 뒤 드러난 E2E 두 건(창 충돌 3단계 정책, preload의 새 API 8개)은 Windows와 무관하게
두 러너에서 같이 실패해 테스트를 새 동작에 맞췄다.

### CI에서 건너뛰거나 플랫폼별로 나뉜 테스트

| 테스트 | 대상 | 이유 |
|---|---|---|
| `validate.test` 경로 길이: 경로 전체 한도 | Windows에서 더 긴 경로 사용 | macOS PATH_MAX 1,024바이트, Windows(Node는 `\\?\` 경로)는 32,767 단위 — 같은 동작, 다른 한도 |
| `validate.test` 255단위 한글 이름 + 260자 넘는 폴더, `validate-timeout` UNC·매핑 드라이브 → `NETWORK_PATH_FAILED`, `lifecycle` Windows 명령줄 | Windows만 실행 | Windows 경로 규칙에서만 성립(macOS에서는 절대 경로가 아님) |
| `hardening-inputs` 산술 부호화 JPEG | Windows: `ENGINE_UNAVAILABLE`·아무것도 쓰지 않음 확인 / 그 밖: 같은 픽셀 확인 | sharp Windows 빌드에 산술 디코딩 없음 |
| `convert-pdf-image` 내장되지 않은 한글 CID 글꼴 | 한글 글꼴이 있는 곳(macOS·Windows)에서 실행 | 글자는 시스템 글꼴에서 옴 |
| `lifecycle` 읽기 전용 앱 데이터 폴더 | 거부 ACL이 이 프로세스에 적용될 때만(POSIX 항상, Windows 일반 세션) — **GitHub Windows 러너에서는 건너뜀** | 위 측정: 러너의 Node는 ACL을 무시. "만들 수 없는 폴더" 경우는 모든 OS에서 실행 |
| `stores` 옮길 수 없는 설정 파일 | Windows: 삭제 공유 없이 열린 파일 / POSIX: 읽기 전용 폴더 | Windows에는 읽기 전용 폴더가 없음 |
| (기존) 심볼릭 링크·chmod 권한 11건: `validate` 4, `output` 1, `convert-image`·`convert-pdf-image`·`tools-preview`·`hardening-inputs` 각 1, `hardening-pipeline` 2 | Windows에서 건너뜀 | Windows 심볼릭 링크는 개발자 모드·관리자 필요, 폴더 쓰기 금지는 chmod가 아니라 ACL이고 러너의 Node에는 적용되지 않음(위 측정) |
| (기존) ImageIO helper 9건: `codecs-imageio` 6, `tools-output-format`·`tools-thumbnail` HEIC 각 1, `codecs-bmp` sips 1 | Windows에서 건너뜀 | macOS ImageIO 전용 기능(Windows는 HEIC 미지원으로 표시) |
| (기존) 실제 볼륨 테스트 4건: `output-fat` 1, `hardening-diskfull` 3 | 모든 OS에서 옵트인 | FAT32·4 MB HFS+ 볼륨을 만들어야 함(`ORBITDROP_FS_TESTS=1`) |
| (기존) E2E 8건: stub helper 4(`helper-drop`, `lifecycle` 2, `drag-failure`), `lifecycle` 쓸 수 없는 앱 데이터 폴더(chmod), `offline`(lsof), `shell` 멈춘 읽기(FIFO), `close-guard` ⌘W 메뉴 | Windows에서 건너뜀 | stub helper가 셸뱅 스크립트라 Windows에서 실행할 수 없음, chmod·lsof·FIFO는 POSIX 전용, ⌘W 메뉴는 macOS 전용 |
| Swift `ImageIOTests` 3건(probe 모양, HEIC 왕복, 품질), `HelperProcessTests` imageio 2건, helper smoke `imageio --probe` | ImageIO 왕복이 60초 안에 끝나지 않을 때만 건너뜀(사유 출력) — 마지막 macOS 러너 실행에서는 모두 실행됨(167개, 건너뜀 0, smoke 19/19) | macOS 러너(가상 머신, HEVC 하드웨어 없음)에서 probe가 수 초 걸리고, 그 stdout 파이프가 helper 종료 뒤에도 열려 있어 파이프를 끝까지 읽던 테스트가 작업 시간 제한(60분)까지 멈췄다. 이제 CLI 출력은 파일로 받고 모든 실행에 시간 제한이 있으며(Swift 단계 10분), 프로세스 안 probe는 메인 런루프를 돌리며 기다린다. 제품은 같은 probe를 3초로 제한한다(초과 시 HEIC "사용할 수 없음") |
| 패키지 smoke test, macOS x64(Rosetta 2) | CI(`--rosetta-smoke best-effort`)에서는 두 번 실행하고 결과를 보고하되 작업을 실패시키지 않음. arm64 smoke는 그대로 필수 | GitHub macOS 러너(macOS 26.7.2, 가상 머신)의 Rosetta 2에서 전체 앱이 불안정했다: 한 번은 숨긴 창이 15초 안에 로드되지 않았고(나머지 검사는 통과, 개발 Mac에서는 6.7초), 다음에는 76초쯤 모든 하위 프로세스(GPU·네트워크·작업 worker)가 SIGTERM으로 끝났다. x64 패키지의 빌드·`lipo`/codesign/fuse 검사·네이티브 모듈 검사(Rosetta 2)와 helper smoke 19/19(Rosetta 2)는 계속 필수. 로컬·release 빌드는 기본값 `strict`. x64 macOS의 창 대기 시간은 60초로 늘렸다 |
