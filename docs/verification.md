# 검증 절차와 기록 (Verification)

두 종류를 구분한다.

* **자동 검증**: 테스트·패키지 검사·smoke test. 결과물을 다시 읽어 확인한다. → 아래 [자동 검증 증거](#자동-검증-증거)
* **실제 OS GUI 검증**: 사람이 **설치본**으로 실제 Finder/Explorer 파일을 드래그해 확인한다. CI·빌드·단위 테스트 통과는
  이것을 대신하지 못한다. → 아래 [수동 GUI 검증 절차](#수동-gui-검증-절차)

결과는 [support-matrix.md](support-matrix.md)의 등급(구현됨 / 자동 검증됨 / 실제 OS GUI 검증됨 / 미검증 / 미지원)에 반영한다.

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
| 1 | 설치본을 새로 실행한다(설정 폴더가 없는 상태). | 창 없이 메뉴 막대/알림 영역에 아이콘만 나타난다. 필요한 권한이 있으면 설정 창에 안내가 보이며, 실행만으로 시스템 권한 대화상자를 강제로 띄우지 않는다([permissions.md](permissions.md)). |
| 2 | Finder/탐색기에서 `Page 001.pdf`를 드래그하는 중 **Shift**를 누른다. | 포인터 근처에 휠이 나타난다. 드래그가 끊기지 않고 포커스를 빼앗지 않는다. PDF 메뉴는 위부터 시계방향 DOCX, JPG, PNG, TXT. |
| 3 | JPG 조각에 놓는다. | 강조가 주황색, 중앙 캡슐에 "JPG". 놓으면 `Page 001.jpg`가 원본 옆에 생기고 `Page 001.pdf`는 그대로 남는다(해시 동일). |
| 4 | `Page 001.jpg`를 다시 드래그 → **Option+Shift**(Windows: **Alt+Shift**) → CROP에 놓는다 → 1:1로 선택 → Apply. | 편집 창(이미지 자르기)이 드롭 후 열린다. Apply 전에는 파일이 생기지 않는다. `Page 001 Cropped.jpg`가 정사각형으로 생긴다. |
| 5 | `Page 001 Cropped.jpg`를 드래그 → 도구 휠 → ADD BG → 배경·Padding·Corners·Shadow 변경 → Save with Background. | `Page 001 Cropped With Background.png`가 생긴다. 미리보기와 같은 구성(비율·여백·둥근 모서리·잘리지 않은 그림자). |
| 6 | 폴더를 확인하고 결과 4개를 기본 뷰어로 연다. | 원본 PDF + JPG + 잘린 JPG + 배경 PNG가 모두 존재하고 올바르게 열린다. 원본 해시 변화 없음. |
| 7 | 보조키 해제(휠 유지), Esc(취소), 휠 밖으로 나갔다 재진입, 텍스트/웹 링크 같은 **비파일** 드래그, 빠른 반복 드롭. | 키를 놓아도 휠 유지, Esc·드래그 종료 시 휠이 사라지고 남는 창이 없다. 비파일 드래그는 휠을 띄우지 않거나 중립 상태 후 거부. 반복 드롭마다 작업이 정확히 1개씩. 휠 밖에 놓으면 원본 앱의 일반 동작(앱 작업 없음). |
| 8 | 배율·모니터: Windows 100/125/150/200%, macOS Retina/비 Retina, 보조 모니터, 화면 네 모서리 근처. | 휠이 화면 안에 완전히 보이고 포인터 아래 섹터가 정확히 강조된다(경계·중심 dead zone 포함). **사용 가능한 구성만 표에 기록하고 나머지는 미검증으로 남긴다.** |
| 9 | 권한 거절(macOS 손쉬운 사용/입력 모니터링 거절, 보호 폴더 접근 거절), helper 강제 종료, 네트워크 끊기, Drop Zone/파일 열기 사용. | 권한이 없으면 안내 + 대체 경로 사용 가능. helper가 죽으면 휠이 남지 않고 재시작 또는 안내. 네트워크 없이 모든 기능 동작. Drop Zone으로 같은 변환·편집 가능(이것은 전역 드래그 검증을 대신하지 않는다). |
| 10 | 창과 수명 주기(2차 점검에서 추가): 주석·가리기에서 도형을 그린 뒤 저장하지 않고 창 닫기 버튼, ⌘W(Windows: Alt+F4)로 닫기 / 실행 중인 앱을 Finder·시작 메뉴에서 다시 열기 / 파일을 Dock 아이콘에 놓거나 "다음으로 열기" / 휠을 띄운 채 화면 잠금, 잠자기 후 깨우기. | 닫기 전에 ×·Esc와 같은 확인 창이 뜨고 "계속 편집"을 고르면 작업이 남는다(앱 종료는 묻지 않음). 다시 열면 설정 창 등 기존 창이 앞으로 온다. 넘긴 파일은 일반 파일 입력과 같은 검증을 거친다. 잠금·잠자기에서 휠이 사라지고 세션이 끝나며, 깨운 뒤 다음 드래그가 정상 동작한다. |

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

---

## PoC 결과 — 실제 외부 드래그 (스펙 §3)

| 항목 | macOS | Windows |
|---|---|---|
| 구현 | Swift/AppKit helper: 전역 마우스 모니터 + 보조키 폴링 + 드래그 페이스트보드 changeCount로 후보 감지, 포커스를 빼앗지 않는 NSPanel이 휠이자 드롭 대상, Copy만 수락, 세션당 drop 1회 | C++/Win32: 폴링 관찰(훅·주입 없음), 레이어드 비활성 창(디스크 밖 알파 0), OLE `IDropTarget`(CF_HDROP), Copy 또는 None만 반환 |
| 권한 실측 | 필요 권한 없음(손쉬운 사용·입력 모니터링 요청 안 함). Esc는 입력 모니터링이 이미 허용된 경우에만 전역 감지 | 해당 없음(권한 대화상자 없음). 관리자 권한 실행 시 UIPI로 일반 탐색기 드래그 불가 |
| 자동 확인 | 드롭 대상(가짜 `NSDraggingInfo`), 실제 이벤트 순서를 재생하는 관찰자 테스트, 세션 상태 기계, 휠 기준값 전 구간, 패키지 안 helper `ready`·`globalDrag.available: true` | 포터블 코어(세션·좌표·프로토콜) 86개 테스트와 골든 기준값을 macOS 호스트에서 실행. OLE 드롭 테스트는 컴파일만 |
| **실제 Finder/탐색기 드래그** | **미실시** — 사용자가 `node --import tsx native/macos/scripts/poc-harness.mjs`(`--guided`면 단계별 안내와 자동 판정, 끝에 `RESULT: PASS/FAIL`)로 [macos-helper.md §8](workstreams/macos-helper.md) 24단계를 수행하고 아래 표에 기록(1–20 기존, 21–24는 2차 점검에서 추가: 드래그 중 화면 잠금, 보안 키보드 입력, 배율이 다른 보조 모니터, iCloud 클라우드 전용 파일) | **미실시** — Windows 기기 없음. [windows-helper.md](workstreams/windows-helper.md) 점검표 33항목 |

자동 확인으로 대신할 수 없는 핵심 질문은 셋이다. 실제 드래그 중에 전역 마우스 이벤트가 오는지, 드래그 도중 나타난
패널이 drag-enter를 받는지, 휠 바깥 투명 영역에 놓은 드롭이 아래 Finder 창으로 가는지(§8 9단계). 사용자 실측 전까지
지원표의 전역 드래그 칸은 **GUI 미검증**이다.

---

## 자동 검증 증거

### 패키징 (macOS, 이 저장소의 개발 Mac)

환경: macOS 26.6 (25G72) arm64, Xcode 27.1, Node 24.7.0, pnpm 11.27.1, electron-builder 26.15.3, Electron 44.9.0.

명령: `node scripts/package.mjs mac --arch all` (2026-10-23 01:15 CST, 소스 커밋 `7faf031` — 미커밋 변경은 문서뿐, 건너뛴 단계 없음: 라이선스 목록 재생성 → 아이콘 검증 →
`scripts/build-native.mjs mac`로 helper 빌드·서명·stdio smoke → `electron-vite build`(현재 소스) → before-pack(의존성 수집기 보정) → arm64·x64 electron-builder →
after-pack 검사(의존성 트리 포함) → DMG 안의 앱으로 smoke test(숨긴 창 렌더링 포함) → 네이티브 모듈 검사). 종료 코드 0, 미완료 항목 없음. 산출물은 **미서명(ad-hoc)** 이며
이름에 `-unsigned`가 붙는다.

> **이전 0.1.0 패키지(소스 `d4f6d1e`, DMG sha256 `234836d3…`/`b3cfebbc…`)는 쓰지 말 것.** 설치해 실행하면 **모든 창이 빈 화면**이었다
> (`GrantFileProtocolExtraPrivileges` fuse가 꺼져 app.asar 안의 `file://` 화면을 읽지 못함 — `ERR_FILE_NOT_FOUND`). 당시 smoke test는 창을
> 열지 않아 통과했고 E2E는 패키지가 아닌 `out/`으로 돌았다. 2차 점검(패키징)에서 발견해 fuse를 켜고, `package.mjs`가 fuse를 다시 읽어 확인하며,
> smoke test가 숨긴 창을 실제로 그려 보도록 고쳤다(아래 `window`).

| 항목 | macOS arm64 | macOS x64 |
|---|---|---|
| DMG | `apps/desktop/release/OrbitDrop-0.1.0-mac-arm64-unsigned.dmg` 135.4 MB, sha256 `d725a4b4ffe5506e9ee23685565384f32b1a7b069dbc61d3031e2b6625cf669a` | `apps/desktop/release/OrbitDrop-0.1.0-mac-x64-unsigned.dmg` 144.2 MB, sha256 `acea39227b66ffbfd9f9adc8d9b302c98c20da02dc7ae4a79891a6ce5e0688e1` |
| ZIP | `…-mac-arm64-unsigned.zip` 135.1 MB, sha256 `49dccf794afac97ec96621510fc8317371fc81158a7b36053a2c0386d63a6d03` | `…-mac-x64-unsigned.zip` 144.0 MB, sha256 `bf7cf925ff1322130d482588a7727d27e6bd7d7e434cb3b7f25571331911cb9b` |
| 빌드 보고서 | `build-report-darwin-arm64.json` (`source.commit` 7faf031…, `dirty: true` = 문서만) | `build-report-darwin-x64.json` |
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
| smoke test (DMG 안의 앱을 직접 실행) | 종료 0, 앱 내부 1,092 ms, `helper.ready: true`, **숨긴 About 창 렌더링 190 ms** | `arch -x86_64`(Rosetta 2) 종료 0, 앱 내부 24.9초(첫 번역 포함), `helper.ready: true`, 창 렌더링 6.8초 |
| 네이티브 모듈 검사 | librsvg 2.63.2 / libvips 8.18.7, 그라데이션·둥근 모서리 마스크 정상, canvas `app.asar.unpacked`에서 로드, Apple SD Gothic Neo 한글, 패키지 안의 pdf-lib로 PDF 1쪽·docx로 DOCX 생성 | 동일(Rosetta 2) |

패키지된 앱의 smoke test 출력(arm64, 한 줄):

```text
ORBITDROP_SMOKE {"ok":true,"version":"0.1.0","platform":"darwin","arch":"arm64","packaged":true,"durationMs":1092,"probe":{"ok":true,"decode":["jpeg","png","webp","gif","tiff","avif","heic","bmp","pdf"],"encode":["jpeg","png","webp","gif","tiff","avif","heic","bmp","pdf","docx","txt"],"pdfRender":true,"pdfText":true,"enabledActions":["convert.jpeg","convert.png","convert.webp","convert.heic","convert.tiff","convert.avif","convert.bmp","convert.pdf","convert.docx","convert.txt","tool.compress","tool.metadata","tool.edit","tool.annotate","tool.addBackground","tool.crop","tool.redact"],"errors":[]},"helper":{"ok":true,"required":true,"found":true,"source":"packaged","ready":true,"version":"0.1.0","globalDrag":{"available":true,"reason":null},"error":null},"conversion":{"ok":true,"actionId":"convert.jpeg","state":"completed","width":64,"height":48,"bytes":865,"ms":219,"error":null},"pdfConversion":{"ok":true,"actionId":"convert.png","state":"completed","width":300,"height":150,"bytes":1395,"ms":258,"error":null},"window":{"ok":true,"view":"about","ms":190,"loaded":true,"preload":true,"rendered":true,"shown":false,"error":null,"consoleErrors":[]}}
```

x64(Rosetta 2)도 같은 내용(`"arch":"x64"`, `durationMs` 24931, `helper.ready: true`, `window.rendered: true`)이다. 의미:
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

이 환경에는 Windows가 없다. `.github/workflows/ci.yml`의 `windows` 작업이 Windows Server(windows-latest)에서
helper 빌드·테스트, NSIS 패키지, smoke test, 무인 사용자별 설치/HKCU 확인/설치본 smoke/제거를 수행하도록 작성되어 있으나
**아직 실행 결과가 없다**. 실행 후 결과(작업 요약 표, `build-report-win32-x64.json`)를 여기에 기록한다.
