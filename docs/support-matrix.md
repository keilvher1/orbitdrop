# 지원·검증 상태표 (Support matrix)

> 기준일 2026-10-24. 독립 스펙 감사(2026-10-21), 영역별 2차 점검(2026-10-22, `docs/workstreams/hardening-*.md`), macOS 14 가상 머신 전 기능 점검(2026-10-23), macOS 26 가상 머신 핵심 흐름 점검(2026-10-24) 결과를 반영했다. 단위 테스트·CI·빌드 성공을 "실제 OS GUI 검증됨"으로
> 올리지 않는다. 실제 Finder/Explorer 드래그는 사람이 [verification.md](verification.md)의
> 절차로 확인해야 하며, 그 전까지 해당 칸은 **GUI 미검증**이다.
> Windows 열에는 2026-11-12 GitHub Actions Windows 러너의 스크립트 GUI 시험([기록](verification.md#windows--github-러너-gui-드래그-자동-시험-2026-11-12))을 반영했다 — 합성 입력이므로 "러너 GUI 시험됨"이다.

## 등급

| 등급 | 뜻 | 필요한 증거 |
|---|---|---|
| **구현됨** | 코드가 있고 빌드된다 | 소스 위치 |
| **자동 검증됨** | 자동 테스트가 실제 결과물을 다시 읽어 확인했다(단위·통합·E2E·패키지 smoke) | 테스트 이름/명령, 실행 환경 |
| **실제 OS GUI 검증됨** | 사람이 설치본에서 실제 Finder/Explorer 파일로 확인했다 | [verification.md](verification.md) 기록(OS 버전·빌드·아키텍처·날짜·스크린샷) |
| **VM GUI 검증됨** | 가상 머신의 실제 OS(실제 Finder)에서 설치본으로 확인했다. 입력은 VM의 가상 키보드·마우스로 스크립트가 넣었다 — 실물 기기·사람의 확인은 아니다 | [verification.md](verification.md#가상-머신-gui-검증--macos-1487-2026-10-22) 기록(게스트 OS·이미지·설치본 해시·스크린샷) |
| **러너 GUI 시험됨** | GitHub Actions의 Windows 러너(가상 머신)에서 실제 파일 탐색기와 설치본으로 확인했다. 입력은 시험 드라이버가 `SendInput`으로 합성했다(Windows에는 "주입된 입력"으로 표시된다 — macOS 가상 머신의 VNC 입력은 게스트에서 하드웨어 입력으로 보였다). 러너의 한 구성(Windows Server 2025, 1024×768, 100 %, 모니터 1개, 관리자·High 무결성)에서만 본 것이며 실물 PC·사람·Windows 11 클라이언트의 확인이 아니다 | [verification.md](verification.md#windows--github-러너-gui-드래그-자동-시험-2026-11-12) 기록(러너 이미지·OS 빌드·설치본 해시·실행 링크·스크린샷), `.github/workflows/windows-gui.yml` |
| **미검증** | 구현 여부와 무관하게 해당 환경에서 확인하지 않았다 | — |
| **미지원** | 해당 환경에서 제공하지 않는다(메뉴에서 비활성 + 사유 표시) | capability probe 결과 |

현재 **실제 OS GUI 검증됨**(사람·실물 기기) 칸은 하나도 없다. macOS arm64의 핵심 경로는 macOS **14.8.7**(2026-10-22·23, 최소 지원 버전
계열, 전 기능)과 macOS **26.6.2**(2026-10-24, 핵심 흐름·충돌 처리·로그인 항목) 가상 머신에서 **VM GUI 검증됨**이다. Windows x64의 핵심 드래그
흐름(Shift 휠, PDF→JPG·JPG→PNG, Esc·링 밖·가운데·텍스트 드래그, 연속 드롭)은 GitHub 러너에서 **러너 GUI 시험됨**(2026-11-12)이다. 그 밖의 "자동 검증됨"은
개발 Mac(macOS 26.6)에서 실행한 결과다.

## 검증 환경

| 환경 | OS / 빌드 | 아키텍처 | 사용 가능 여부 |
|---|---|---|---|
| 개발 Mac | macOS 26.6 (25G72), Xcode 27.1, Node 24.7.0, Electron 44.9.0 | arm64 (Rosetta 2로 x64 실행) | 있음 |
| macOS 14 가상 머신 | macOS 14.8.7 (23J520) 게스트, tart 2.41.1(Virtualization.framework), 화면 1개(1×·2×), VNC 입력 | arm64 | 있음(2026-10-22) — [기록](verification.md#가상-머신-gui-검증--macos-1487-2026-10-22) |
| macOS 26 가상 머신 | macOS 26.6.2 (25G83) 게스트, tart 2.41.1, 화면 1개(1×), VNC 입력 | arm64 | 있음(2026-10-24) — [기록](verification.md#가상-머신-핵심-흐름-점검--macos-2662-2026-10-24) |
| Intel Mac | — | x64 | **없음** — x64 설치본은 Apple 실리콘의 Rosetta 2에서만 확인(개발 Mac의 smoke, macOS 26 가상 머신의 실제 Finder 드래그) |
| Windows 10/11 | — | x64 | **없음**(실기기·사람 확인 없음) |
| Windows CI 러너 | GitHub Actions `windows-latest`: Windows Server 2025 Datacenter 10.0.26100 (빌드 26100.33674), MSVC 19.51, Node 24.22.2 | x64 | 있음(2026-11-12~) — 단위·통합·helper(MSVC)·E2E·NSIS 패키지·패키지 smoke·설치/제거. GUI 드래그는 확인하지 않음 — [기록](verification.md#ci--github-actions에서-처음-돌린-windows-2026-11-12) |
| Windows 러너 GUI 시험 | GitHub Actions `windows-2025`(이미지 `windows-2025-vs2026` 20261103.298.1): 같은 Windows Server 2025 (26100.33674), 1024×768·96 DPI(100 %), 모니터 1개, `SendInput` 합성 입력, 관리자·High 무결성 | x64 | 있음(2026-11-12, 실행마다 새 가상 머신) — 실제 탐색기 드래그로 설치본의 휠·변환·취소 확인 — [기록](verification.md#windows--github-러너-gui-드래그-자동-시험-2026-11-12) |

## 자동 검증 명령 (개발 Mac, 2026-10-23)

| 명령 | 결과 |
|---|---|
| `node_modules/.bin/vitest run` (contracts·core·processors·desktop·integration) | 89 파일, 1060 통과, 4 건너뜀(옵트인 FAT32·디스크 가득 참 테스트 — 별도 실행 시 통과) |
| `cd apps/desktop && ../../node_modules/.bin/playwright test` (빌드된 실제 앱, CDP 클릭 — OS 입력 합성 없음) | 39/39 통과 (오프라인 테스트 포함: http(s) 요청·소켓 0; 숨긴 창 smoke 검사의 성공·실패 경로 포함) |
| `node apps/desktop/src/renderer/dev/electron-verify.mjs` (실제 앱의 모든 창·편집기, 결과 파일을 디코딩해 크기·픽셀 확인) | 36/36 통과, 콘솔 오류·CSP 위반 없음 |
| `swift test --package-path native/macos` | 종료 코드 0, Core 89 · Kit 69 · Process 9 (167개). Swift 동시성 격리 검사를 치명 오류로 켠 상태(`SWIFT_UNEXPECTED_EXECUTOR_LOG_LEVEL=2`)에서도 통과 — 2차 점검 중 이 검사로만 드러나는 신호 처리 회귀를 `de7e1d7`에서 고침 |
| `node scripts/build-native-win.mjs --core-tests --parity`, `--cross` | 포터블 코어 92개 통과(일반 + ASan/UBSan 빌드 각각), zod 대조 5,061줄 + macOS 말뭉치 162줄 일치, MinGW `-Werror` 경고 0 — Win32 부분은 컴파일만 |
| `node scripts/gen-golden.mjs --check` | 휠 기준값 최신 |
| `node tests/integration/convert-electron-smoke.mjs` | node / utilityProcess / app.asar 세 모드 통과(CCITT·JBIG2·JPX 이미지와 wasm 디코더 로드 확인 포함) |
| `electron . --smoke-test` (개발 빌드, 실제 arm64 헬퍼) | `ok:true`, helper `ready`, PNG→JPG·PDF→PNG, 숨긴 About 창 렌더링(`window.rendered`) |
| `node scripts/package.mjs mac --arch all` | arm64·x64 DMG/ZIP(소스 `7faf031`), 패키지 smoke `ok:true`(숨긴 창 렌더링 포함, x64는 Rosetta 2), fuse·의존성 트리 검사 통과 — 해시는 [verification.md](verification.md#자동-검증-증거). 이전 `d4f6d1e` 패키지는 창이 빈 화면이라 폐기 |

## 패키징·설치

| 항목 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 패키지 생성 (dmg+zip / NSIS) | 자동 검증됨 | 자동 검증됨 | 자동 검증됨(CI 러너) | `node scripts/package.mjs mac --arch all` / `win --install-test`, [verification.md](verification.md#자동-검증-증거) |
| 네이티브 바이너리 배치(sharp/libvips/canvas, 대상 아키텍처만) | 자동 검증됨 | 자동 검증됨 | 자동 검증됨(CI, after-pack: x64 PE만) | after-pack 훅, `lipo -archs` |
| 패키지 smoke(엔진 probe, helper `ready`, PNG→JPG·PDF→PNG, 숨긴 창 렌더링) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 자동 검증됨(CI, 설치본도) | `ORBITDROP_SMOKE {"ok":true…,"window":{"rendered":true…}}` |
| 네이티브 모듈 검사(librsvg 그라데이션·마스크, canvas 로드, 한글 글꼴) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 자동 검증됨(CI, Malgun Gothic) | `apps/desktop/build/native-check` |
| helper 포함(대상 아키텍처, 빈 entitlements, hardened runtime) | 자동 검증됨 | 자동 검증됨 | 자동 검증됨(CI: MSVC `/MT`, 코어 99·OLE 6·stdio smoke 47) | `codesign -dv`, helper stdio smoke 18/18 |
| 코드 서명 | 미지원(자격 증명 없음, ad-hoc만, 파일명에 `-unsigned`) | 미지원(동일) | 미지원(미서명) | `build-report-*.json` |
| 공증 / SmartScreen 평판 | 미지원 | 미지원 | 미지원 | [packaging.md](packaging.md) |
| 사용자별 설치·제거(관리자 권한 없음) | 해당 없음(드래그 설치) | 해당 없음 | 자동 검증됨(CI: 무인 설치, HKCU 항목만, 설치본 smoke, 무인 제거 후 파일·항목 없음) | `build/installer.nsh`, `package.mjs --install-test` |
| 설치본 첫 실행·권한 안내 | VM GUI 검증됨(macOS 14.8.7·26.6.2: 실행 시 대화상자 없음, 첫 알림 때 알림 허용 배너 — 환영 창·응용 프로그램 폴더 이동 제안을 넣기 전 빌드 기준, 이후 미검증) | VM GUI 검증됨(Rosetta 2, macOS 26.6.2: 첫 실행 약 1분 40초, Apple 실리콘용 설치본 안내 알림·설정·정보 창) · Intel 실기 미검증 | 러너 GUI 시험됨(Windows Server 2025, 무인 사용자별 설치 → 새 프로필 첫 실행: 환영 창 "OrbitDrop 시작하기"만 열리고 Esc로 닫힘, 다른 창 없음, helper `globalDrag=true` 0.3–0.4초, 엔진 점검 4–5초. UI 언어는 OS 언어 목록을 따름 — 한국어 우선이면 ko, 영어 러너 그대로면 en) · Windows 11 실기 미검증 | verification.md 1단계, 가상 머신·러너 기록 |

## P0 — 핵심 경로

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 전역 드래그 + Shift → 휠(실제 Finder/Explorer) | **VM GUI 검증됨**(macOS 14.8.7, 1×·Retina 2×: 실제 Finder 드래그 중 Shift·Option+Shift로 휠, 포커스 유지, 휠 옆 투명 영역 드롭이 Finder로 감, Esc·이탈/재진입·비파일·반복 드롭, helper 강제 종료 · macOS 26.6.2: 휠·포커스 유지·휠 옆 드롭·텍스트 드래그 안내) · 실물 Mac **GUI 미검증** | VM GUI 검증됨(Rosetta 2, macOS 26.6.2: Shift·Option+Shift 휠, 드롭, CPU 부하 중에도 동작. Rosetta를 처음 쓰는 첫 실행 중 휠이 뜨지 않은 드래그 1번은 원인 미확정 — verification.md) · Intel 실기 미검증 | **러너 GUI 시험됨**(Windows Server 2025, 1024×768·100 %: 실제 탐색기 드래그 중 Shift → 포인터 위치에 휠, 탐색기 포커스 유지, 탐색기 드래그 이미지가 휠 위, Shift를 떼도 휠 유지, Esc 취소, 휠 창 투명 모서리의 드롭은 탐색기로, 가운데는 거부, 텍스트 드래그는 "파일이 아님") · Windows 11 실기 **GUI 미검증** | Swift `DropTargetGlueTests`, `SessionControllerTests`; C++ `test_session.cpp`(23개 시나리오); E2E `helper-drop`(stub)·`helper-real`(실제 헬퍼 configure·종료); Windows 러너: `.github/workflows/windows-gui.yml`(`tests/windows-gui`) |
| 휠 hit-test·배치·다중 모니터 좌표 | 자동 검증됨 | 자동 검증됨(Rosetta) | 구현됨(포터블 코어의 골든 테스트는 macOS clang·MinGW 호스트에서 통과) · 러너 GUI 시험됨(100 %·모니터 1개: 공유 기하로 계산한 조각 중심이 그 조각으로 강조 — PDF 4조각·JPG 8조각, 가운데·링 밖 판정도 일치, 휠 중심 = 포인터) · 다른 배율·다중 모니터·화면 가장자리 미검증 | `tests/fixtures/wheel-golden.json` — TS·Swift·C++ 모두 0 불일치; C++ `test_coords.cpp` |
| 드롭 → 작업 정확히 1회, Copy만, 원본 이동 없음 | 자동 검증됨(헬퍼·main) · **VM GUI 검증됨**(연속 5회 → 작업 5개, 원본 해시 그대로) | GUI 미검증 | 러너 GUI 시험됨(드롭마다 `drop accepted` 1회·결과 1개, 연달아 2회 → 결과 각 1개, 탐색기에서 이동을 뜻하는 Shift를 누른 채 놓아도 원본 그대로·해시 동일) | core `DragSessionTracker` 테스트, Swift drop-target 테스트, E2E `helper-drop` "one job per session" |
| PDF → JPG/PNG(여러 쪽, 150/300 DPI, 회전, 암호·손상·과대 오류) | 자동 검증됨 · VM GUI 검증됨(3쪽·90° 회전 쪽 포함) | 자동 검증됨(패키지 smoke: 1쪽 PDF→PNG만) | 러너 GUI 시험됨(1쪽 PDF → JPG 2550×3300, 실제 탐색기 드래그) · 그 밖 미검증 | `convert-pdf-image.test.ts`(손상 PDF 포함), E2E PDF→JPG 2550×3300, 패키지 smoke |
| JPG/PNG/WebP 상호 변환(+ EXIF 회전, 투명 PNG→JPEG) | 자동 검증됨 | 자동 검증됨(smoke PNG→JPG만) | 러너 GUI 시험됨(JPG → PNG 1건, 8조각 메뉴) · 그 밖 미검증 | `convert-image.test.ts` |
| Crop 편집기(비율, W/H, EXIF 회전) | 자동 검증됨 · VM GUI 검증됨(1:1 → 2550×2550, EXIF 6 사진의 W/H 입력·이동) | 미검증 | 미검증 | `tools-crop`, `cropMath.test.ts`, E2E `pipeline` 1:1 → 2550×2550(정확한 크기), `ui-flow`(정사각형) |
| Add Background(패딩·모서리·그림자·비율, 미리보기=최종) | 자동 검증됨 · VM GUI 검증됨(프리셋·배경 이미지·16:9·JPEG) | 미검증 | 미검증 | `tools-add-background`, `composition-layout`(무작위 3000건, 정확한 레이아웃), E2E `pipeline`, electron-verify(16:9 비율) |
| 트레이, 설정, 작업 진행·취소·결과 열기 | 자동 검증됨 · VM GUI 검증됨(메뉴 막대 메뉴, 작업 창) | 미검증 | 미검증 | E2E `shell`(트레이 메뉴, 설정 전파, 기록), `job-manager.test.ts` |
| 대체 입력(파일 열기, Drop Zone) | 자동 검증됨(단위) · VM GUI 검증됨: Drop Zone(Finder에서 놓기 → 앱 안 휠 → PDF→DOCX), 메뉴 막대 파일 열기(대화상자 → 앱 안 휠 → 방향키·Enter) | 미검증 | 미검증 | electron-verify dropzone, `file-registry.test.ts`, `flows.test.tsx` |
| 영상 흐름 재현(PDF→JPG→Crop→Add BG, 결과 4개) | 자동 검증됨 · **VM GUI 검증됨**(macOS 14.8.7·26.6.2, 실제 Finder 드래그로 결과 4개) · 실물 Mac GUI 미검증 | VM GUI 검증됨(Rosetta 2, macOS 26.6.2) · Intel 실기 미검증 | 미검증 | `tests/integration/video-flow.test.ts`, E2E `ui-flow` "four files side by side" |

## P1 — 일상 도구

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| Compress(실제 크기 예측) | 자동 검증됨 · VM GUI 검증됨(WEBP·긴 변 1920) | 미검증 | 미검증 | `tools-compress`, electron-verify compress |
| Metadata(읽기·제거, 가능하면 무손실) | 자동 검증됨 · VM GUI 검증됨(카메라 정보·GPS 표시 → 제거본에 EXIF 없음) | 미검증 | 미검증 | `tools-metadata`(14) |
| Edit(회전·반전·밝기·대비·채도, 16비트·광색역) | 자동 검증됨 · VM GUI 검증됨(회전+반전+밝기, HEIC 저장) | 미검증 | 미검증 | `tools-edit`, `tools-colour` |
| Annotate(한글 텍스트, 화살표·사각형, 색·두께, Undo/Redo) | 자동 검증됨(Apple SD Gothic Neo) · VM GUI 검증됨(한글 텍스트 붙여 넣기·실행 취소/다시 실행·⌘W 확인) | 미검증 | 미검증(Malgun Gothic 필요) | `tools-annotate.test.ts`(결과에서 한글 픽셀 확인), `annotate.test.tsx`(Undo/Redo) |
| Redact(단색·모자이크) | 자동 검증됨 · VM GUI 검증됨(두 영역, 단색 픽셀 [0,0,0]) | 미검증 | 미검증 | `tools-redact` |
| TIFF / AVIF 출력 | 자동 검증됨 · VM GUI 검증됨 | 미검증 | 미검증 | `convert-image.test.ts` |
| 이미지 → PDF(여러 장, 순서) | 자동 검증됨 · VM GUI 검증됨(3장, 순서 바꾸기·A4·여백) | 미검증 | 미검증 | `convert-images-pdf.test.ts`(진행형·CMYK·EXIF 회전 포함 6쪽), electron-verify 3쪽 |
| 텍스트 PDF → TXT | 자동 검증됨 · VM GUI 검증됨(한글 CMap, 스캔 PDF는 `PDF_NO_TEXT`) | 미검증 | 미검증 | `convert-pdf-text.test.ts`(한글 PDF 포함) |
| 여러 파일 제한 병렬, 부분 실패 | 자동 검증됨 | 미검증 | 미검증 | core `queue.test.ts`, `convert-pipeline.test.ts`(실제 결과 파일로 부분 실패) |
| 취소·시간 초과·worker 크래시 후 재시도 | 자동 검증됨(가짜 worker 기반 단위 테스트) · **VM GUI 검증됨**(설치본: 24쪽 변환 중 작업 창에서 취소 → 저장된 쪽까지 되돌림(macOS 14.8.7) · 처리 프로세스 `kill -9` → 저장된 쪽 되돌림 + 자동 재시도로 24쪽, `(2)`·임시 파일·폴더 접근 대화상자 없음(macOS 14.8.7·26.6.2)) | 미검증 | 미검증 | `pool.test.ts`, `job-manager.test.ts`, `output.test.ts`(임시 파일 보고), `tools-committed.test.ts` |
| 설정: PDF DPI 150/300, 배경 최대 변, 보조키 조합, 언어 | 자동 검증됨 | 미검증 | 미검증 | `settings.test.tsx`, `convert-pdf-image.test.ts`, E2E `shell`(설정 전파) |

## P2 — 엔진 확인 후 확장

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| HEIC 읽기/쓰기 | 자동 검증됨(헬퍼 ImageIO: 실제 HEVC 파일 생성, HEIC→PNG 바로 선 방향) · VM GUI 검증됨(설치본: JPG→HEIC, HEIC→JPG, HEIC 편집→HEIC — macOS 14.8.7, JPG→HEIC는 26.6.2도) | 구현됨(probe만, Rosetta) | 미지원(번들 sharp의 libheif에 HEVC 없음 — Windows CI 러너의 패키지 probe로 실측: decode·encode 목록에 heic 없음, 메뉴에서 비활성) | `codecs-imageio.test.ts`, 패키지 probe |
| BMP 읽기/쓰기 | 자동 검증됨(자체 코덱, macOS ImageIO와 상호 확인) · VM GUI 검증됨 | 미검증 | 미검증 | `codecs-bmp.test.ts` |
| PDF → DOCX(텍스트 중심) / 이미지 → DOCX(그림 삽입, OCR 없음) | 자동 검증됨(경고 `DOCX_TEXT_ONLY` / `DOCX_IMAGE_ONLY`) · VM GUI 검증됨 | 미검증 | 미검증 | `convert-docx.test.ts` |
| OCR, 영상·음성, AI, 클라우드, 계정 | 미지원(범위 밖) | 미지원 | 미지원 | [requirements.md](requirements.md) |
| Windows ARM64, Linux | — | — | 미지원(범위 밖) | [decisions.md](decisions.md) |

## 첫 실행 · 도움말 · 진단 · 충돌 처리 (2026-11-12 추가)

공개 배포 준비로 추가했다. 아래 "자동 검증됨"은 Vitest 단위·렌더러 테스트(개발 Mac)이며, 빌드된 앱의 E2E·실제 창·대화상자·알림은
아직 실행하지 않았다(**GUI 미검증**).

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 환영 창(처음 실행 1회, 도움말 › 사용법), OS 키 이름(Option / Alt·Ctrl), 로그인 시 실행 스위치(기본 꺼짐), 키보드·스크린리더 | 자동 검증됨(렌더러) · GUI 미검증 | 미검증 | 구현됨 · 미검증 | `welcome.test.tsx`, `onboarding.test.ts` |
| 처음 실행 언어 = OS 언어(한국어 → ko, 그 밖 → en), 기존 설정 파일의 언어 유지 | 자동 검증됨(main) | 미검증 | 구현됨 · 미검증 | `onboarding.test.ts` |
| Windows 도구 휠 기본 **Ctrl+Shift**([ADR-12](decisions.md#adr-12-windows-도구-휠-기본-조합-ctrlshift)) | 해당 없음(Option+Shift) | 해당 없음 | 구현됨(설정 기본값·검증 경고 없음은 자동 검증됨) · 실제 드래그 미검증 | `onboarding.test.ts`, `settings.test.tsx`, `contracts.test.ts`; helper는 `GetAsyncKeyState(VK_CONTROL)`(포터블 코어 호스트 테스트) |
| 응용 프로그램 폴더로 이동 제안(패키지, 1회, 이동 / 나중에) | 흐름 자동 검증됨(main) · 실제 이동 미검증 | 동일 | 해당 없음 | `onboarding.test.ts` |
| 도움말 메뉴(사용법·웹사이트·문제 신고·로그 폴더), 외부 URL 허용 목록(웹사이트·새 이슈만) | 자동 검증됨(main) · GUI 미검증 | 미검증 | 미검증 | `ui-logic.test.ts`, `support.test.ts`, `security.test.ts`, `contracts.test.ts` |
| 정보 창: 진단 정보 복사(경로 다시 가림), 로그 폴더, 저작권·MIT, 오픈 소스 라이선스 파일 열기, 개인정보 | 자동 검증됨(main·렌더러) · GUI 미검증 | 미검증 | 미검증 | `support.test.ts`, `support-views.test.tsx` |
| 설정 › 일반: 데이터 폴더 열기, 설정 초기화(앱 안 확인 창) · 설정 › 드래그: helper 다시 시작 | 자동 검증됨(렌더러·main) · GUI 미검증 | 미검증 | 미검증 | `support-views.test.tsx`, `onboarding.test.ts` |
| 충돌 처리: 로컬 crash dump만(업로드 없음), main 예외·시작 실패 대화상자, helper 포기 알림, 창 페이지 충돌 안내·충돌 화면, 렌더러 오류 → main.log | 자동 검증됨(단위) · 실제 충돌·대화상자 미검증 | 미검증 | 미검증 | `crash.test.ts`, `crash-screens.test.tsx`, `ipc.test.ts` |

## 시각·접근성 (§8)

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 디자인 토큰(색·크기·애니메이션), 휠 지름 320–380, 편집 창 440–560 | 자동 검증됨 | 미검증 | 미검증 | `tokens.test.ts`(모든 글자/배경 쌍 WCAG 4.5:1), Swift `ContractDriftTests`, C++ 토큰 드리프트 테스트 |
| 키보드 조작(Tab/방향키/Enter/Esc), 메뉴 ARIA, 스크린리더 레이블 | 자동 검증됨(렌더러) · VoiceOver 미검증 | 미검증 | 미검증 | `wheel.test.tsx`, `flows.test.tsx`, `shell.test.tsx` |
| Reduce Motion, 고대비, 다크 모드 | 자동 검증됨(렌더러·Swift 렌더링) | 미검증 | 미검증 | `settings.test.tsx`, Swift `RenderingTests` |
| 한국어 기본 + 영어 리소스 분리 | 자동 검증됨 | 미검증 | 미검증 | `i18n.test.ts`(키 일치, 모든 오류·경고 코드 문구) |

## 알려진 제약

- macOS에서 Input Monitoring 권한이 없으면 Esc는 포인터가 휠 위에 있을 때만 감지된다. 그 밖의 경우 마우스를 놓으면 휠이 닫힌다.
- macOS에서는 Control·Command가 들어간 보조키 조합을 쓸 수 없다. AppKit이 이를 Link/Generic 드래그로 바꿔 Copy 드롭이 거부되기 때문이다.
- PDF 안에 글꼴이 포함되지 않은 한글은 시스템 글꼴로 그린다(macOS Apple SD Gothic Neo, Windows Malgun Gothic). 한글 글꼴이 없는 시스템에서는 빈칸으로 보일 수 있다(텍스트 추출은 동작). Windows에서는 내장되지 않은 **중국어·일본어** 글자도 아직 빈칸이다(@napi-rs/canvas의 기본 글꼴 Arial에 없고, 한글만 대체 글꼴을 붙인다).
- Windows에서는 **산술 부호화 JPEG**(SOF9–SOF15, 드묾)을 읽을 수 없다. 번들 sharp의 Windows libvips가 산술 디코딩 없이 빌드됐기 때문이며, `ENGINE_UNAVAILABLE`("이 빌드에서 사용할 수 없는 기능")로 알린다. macOS는 읽는다.
- Windows에서 이름은 255 UTF-16 단위, 경로는 32,767 단위까지다(260자를 넘는 경로는 동작). 넘으면 `PATH_TOO_LONG`.
- 서명·공증 자격 증명이 없어 macOS 산출물은 ad-hoc 서명이다. Gatekeeper가 차단하며, 이를 끄라고 안내하지 않는다.
- 실행 확인: 개발 Mac macOS 26.6(자동 검증, arm64·Rosetta x64), 가상 머신 macOS 14.8.7·26.6.2(arm64 설치본). macOS 15와 Intel Mac은 미실측.
- Windows: CI 러너(Windows Server 2025)의 자동 검증과, GitHub 러너에서 합성 입력으로 핵심 드래그 흐름을 확인한 스크립트 GUI 시험
  ([기록](verification.md#windows--github-러너-gui-드래그-자동-시험-2026-11-12): 1024×768, 100 %, 모니터 1개, 관리자·High 무결성) 말고는 미실측이다 — 사람이 실기기에서 Explorer 드래그·휠·DPI를
  확인하지 않았고, 다른 배율·다중 모니터·일반 사용자(Medium) 권한·도구 휠·편집 창은 러너에서도 시험하지 않았다. 도구 휠 기본 조합은 **Ctrl+Shift**다 — Alt+Shift는 입력 언어 전환 단축키와 겹쳐 기본값에서 뺐다
  (설정에서 고르면 경고). 한 언어에 키보드 배열이 여럿이면 Ctrl+Shift가 배열 전환 단축키일 수 있어 실기기에서 확인해야 한다([ADR-12](decisions.md#adr-12-windows-도구-휠-기본-조합-ctrlshift)).
  관리자 권한으로 실행하면 일반 탐색기의 드래그를 받을 수 없다(UIPI). 드래그 이미지와 휠 창의 겹침 순서는 러너에서는 드래그 이미지가 휠 위였고, 실기기에서 확인해야 한다.
  Windows 11은 새 알림 영역 아이콘을 ^(숨겨진 아이콘) 안에 둘 수 있다 — 환영 창이 안내한다.
- 변환·편집별 메타데이터·색상·투명도 정책: [conversion-policy.md](conversion-policy.md).
