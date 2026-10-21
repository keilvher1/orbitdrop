# 지원·검증 상태표 (Support matrix)

> 기준일 2026-10-21. 독립 스펙 감사(같은 날) 결과를 반영했다. 단위 테스트·CI·빌드 성공을 "실제 OS GUI 검증됨"으로
> 올리지 않는다. 실제 Finder/Explorer 드래그는 사람이 [verification.md](verification.md)의
> 절차로 확인해야 하며, 그 전까지 해당 칸은 **GUI 미검증**이다.

## 등급

| 등급 | 뜻 | 필요한 증거 |
|---|---|---|
| **구현됨** | 코드가 있고 빌드된다 | 소스 위치 |
| **자동 검증됨** | 자동 테스트가 실제 결과물을 다시 읽어 확인했다(단위·통합·E2E·패키지 smoke) | 테스트 이름/명령, 실행 환경 |
| **실제 OS GUI 검증됨** | 사람이 설치본에서 실제 Finder/Explorer 파일로 확인했다 | [verification.md](verification.md) 기록(OS 버전·빌드·아키텍처·날짜·스크린샷) |
| **미검증** | 구현 여부와 무관하게 해당 환경에서 확인하지 않았다 | — |
| **미지원** | 해당 환경에서 제공하지 않는다(메뉴에서 비활성 + 사유 표시) | capability probe 결과 |

현재 **실제 OS GUI 검증됨** 칸은 하나도 없다. 아래 "자동 검증됨"은 모두 개발 Mac(macOS 26.6)에서 실행한 결과다.
최소 지원 버전인 macOS 14는 실행해 보지 않았다.

## 검증 환경

| 환경 | OS / 빌드 | 아키텍처 | 사용 가능 여부 |
|---|---|---|---|
| 개발 Mac | macOS 26.6 (25G72), Xcode 27.1, Node 24.7.0, Electron 44.9.0 | arm64 (Rosetta 2로 x64 실행) | 있음 |
| Intel Mac | — | x64 | **없음** — x64 패키지·헬퍼는 Rosetta 2에서만 실행 확인 |
| Windows 10/11 | — | x64 | **없음** — Windows 헬퍼는 mingw-w64 교차 컴파일과 호스트 테스트(macOS clang)까지만. CI 워크플로(`windows-latest`)는 구성만 되어 있고 실행 전 |

## 자동 검증 명령 (개발 Mac, 2026-10-21)

| 명령 | 결과 |
|---|---|
| `node_modules/.bin/vitest run` (contracts·core·processors·desktop·integration) | 65 파일, 768 통과, 1 건너뜀(옵트인 FAT32 테스트, 별도 실행 시 통과) |
| `cd apps/desktop && ../../node_modules/.bin/playwright test` (빌드된 실제 앱, CDP 클릭 — OS 입력 합성 없음) | 16/16 통과 |
| `node apps/desktop/src/renderer/dev/electron-verify.mjs` (실제 앱의 모든 창·편집기) | 26/26 통과, 콘솔 오류·CSP 위반 없음 |
| `swift test --package-path native/macos` | 종료 코드 0, Core 80 · Kit 29 · Process 7 (116개). 토큰 변경 뒤 렌더링 테스트 1개가 옛 색을 비교해 실패했던 것을 `98c0ac8`에서 고침 |
| `node scripts/gen-golden.mjs --check` | 휠 기준값 최신 |
| `node tests/integration/convert-electron-smoke.mjs` | node / utilityProcess / app.asar 세 모드 통과 |
| `electron . --smoke-test` (개발 빌드, 실제 arm64 헬퍼) | `ok:true`, helper `ready`, PNG→JPG·PDF→PNG |
| `node scripts/package.mjs mac --arch all` | arm64·x64 DMG/ZIP, 패키지 smoke `ok:true` (x64는 Rosetta 2) |

## 패키징·설치

| 항목 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 패키지 생성 (dmg+zip / NSIS) | 자동 검증됨 | 자동 검증됨 | 구현됨(설정만, Windows에서 빌드 안 함) | `node scripts/package.mjs mac --arch all`, [verification.md](verification.md#자동-검증-증거) |
| 네이티브 바이너리 배치(sharp/libvips/canvas, 대상 아키텍처만) | 자동 검증됨 | 자동 검증됨 | 구현됨(after-pack 검사) | after-pack 훅, `lipo -archs` |
| 패키지 smoke(엔진 probe, helper `ready`, PNG→JPG·PDF→PNG) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 구현됨(CI 미실행) | `ORBITDROP_SMOKE {"ok":true…}` |
| 네이티브 모듈 검사(librsvg 그라데이션·마스크, canvas 로드, 한글 글꼴) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 구현됨(CI 미실행) | `apps/desktop/build/native-check` |
| helper 포함(대상 아키텍처, 빈 entitlements, hardened runtime) | 자동 검증됨 | 자동 검증됨 | 구현됨(after-pack 검사) | `codesign -dv`, helper stdio smoke 18/18 |
| 코드 서명 | 미지원(자격 증명 없음, ad-hoc만, 파일명에 `-unsigned`) | 미지원(동일) | 미지원(미서명) | `build-report-*.json` |
| 공증 / SmartScreen 평판 | 미지원 | 미지원 | 미지원 | [packaging.md](packaging.md) |
| 사용자별 설치·제거(관리자 권한 없음) | 해당 없음(드래그 설치) | 해당 없음 | 구현됨(미실행) | `build/installer.nsh` |
| 설치본 첫 실행·권한 안내 | 미검증 | 미검증 | 미검증 | verification.md 1단계 |

## P0 — 핵심 경로

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 전역 드래그 + Shift → 휠(실제 Finder/Explorer) | 구현됨 · 드롭 대상과 세션 상태 기계만 자동 검증(가짜 `NSDraggingInfo`, 합성 이벤트 순서) · 실제 전역 이벤트 소스와 Finder 드래그는 **GUI 미검증** | 구현됨(Rosetta에서 stdio만) · GUI 미검증 | 구현됨 · 미검증(포터블 코어만 macOS 호스트에서 실행) | Swift `DropTargetGlueTests`, `SessionControllerTests`; C++ `test_session.cpp`(23개 시나리오); E2E `helper-drop`(stub)·`helper-real`(실제 헬퍼 configure·종료) |
| 휠 hit-test·배치·다중 모니터 좌표 | 자동 검증됨 | 자동 검증됨(Rosetta) | 구현됨 · 미검증(포터블 코어의 골든 테스트는 macOS clang·MinGW 호스트에서 통과, MSVC·Windows 미실행) | `tests/fixtures/wheel-golden.json` — TS·Swift·C++ 모두 0 불일치; C++ `test_coords.cpp` |
| 드롭 → 작업 정확히 1회, Copy만, 원본 이동 없음 | 자동 검증됨(헬퍼·main) · GUI 미검증 | GUI 미검증 | 미검증 | core `DragSessionTracker` 테스트, Swift drop-target 테스트, E2E `helper-drop` "one job per session" |
| PDF → JPG/PNG(여러 쪽, 150/300 DPI, 회전, 암호·손상·과대 오류) | 자동 검증됨 | 자동 검증됨(패키지 smoke: 1쪽 PDF→PNG만) | 미검증 | `convert-pdf-image.test.ts`(손상 PDF 포함), E2E PDF→JPG 2550×3300, 패키지 smoke |
| JPG/PNG/WebP 상호 변환(+ EXIF 회전, 투명 PNG→JPEG) | 자동 검증됨 | 자동 검증됨(smoke PNG→JPG만) | 미검증 | `convert-image.test.ts` |
| Crop 편집기(비율, W/H, EXIF 회전) | 자동 검증됨 | 미검증 | 미검증 | `tools-crop`, `cropMath.test.ts`, E2E `pipeline` 1:1 → 2550×2550(정확한 크기), `ui-flow`(정사각형) |
| Add Background(패딩·모서리·그림자·비율, 미리보기=최종) | 자동 검증됨 | 미검증 | 미검증 | `tools-add-background`, `composition-layout`(무작위 3000건, 정확한 레이아웃), E2E `pipeline`, electron-verify(16:9 비율) |
| 트레이, 설정, 작업 진행·취소·결과 열기 | 자동 검증됨 | 미검증 | 미검증 | E2E `shell`(트레이 메뉴, 설정 전파, 기록), `job-manager.test.ts` |
| 대체 입력(파일 열기, Drop Zone) | 부분 자동 검증: 실제 앱에서는 Drop Zone 오류 경로만, 정상 등록과 파일 열기 대화상자는 단위 테스트 | 미검증 | 미검증 | electron-verify dropzone, `file-registry.test.ts`, `flows.test.tsx` |
| 영상 흐름 재현(PDF→JPG→Crop→Add BG, 결과 4개) | 자동 검증됨 · **GUI 미검증** | 미검증 | 미검증 | `tests/integration/video-flow.test.ts`, E2E `ui-flow` "four files side by side" |

## P1 — 일상 도구

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| Compress(실제 크기 예측) | 자동 검증됨 | 미검증 | 미검증 | `tools-compress`, electron-verify compress |
| Metadata(읽기·제거, 가능하면 무손실) | 자동 검증됨 | 미검증 | 미검증 | `tools-metadata`(14) |
| Edit(회전·반전·밝기·대비·채도, 16비트·광색역) | 자동 검증됨 | 미검증 | 미검증 | `tools-edit`, `tools-colour` |
| Annotate(한글 텍스트, 화살표·사각형, 색·두께, Undo/Redo) | 자동 검증됨(Apple SD Gothic Neo) | 미검증 | 미검증(Malgun Gothic 필요) | `tools-annotate.test.ts`(결과에서 한글 픽셀 확인), `annotate.test.tsx`(Undo/Redo) |
| Redact(단색·모자이크) | 자동 검증됨 | 미검증 | 미검증 | `tools-redact` |
| TIFF / AVIF 출력 | 자동 검증됨 | 미검증 | 미검증 | `convert-image.test.ts` |
| 이미지 → PDF(여러 장, 순서) | 자동 검증됨 | 미검증 | 미검증 | `convert-images-pdf.test.ts`(진행형·CMYK·EXIF 회전 포함 6쪽), electron-verify 3쪽 |
| 텍스트 PDF → TXT | 자동 검증됨 | 미검증 | 미검증 | `convert-pdf-text.test.ts`(한글 PDF 포함) |
| 여러 파일 제한 병렬, 부분 실패 | 자동 검증됨 | 미검증 | 미검증 | core `queue.test.ts`, `convert-pipeline.test.ts`(실제 결과 파일로 부분 실패) |
| 취소·시간 초과·worker 크래시 후 재시도 | 자동 검증됨(가짜 worker 기반 단위 테스트) | 미검증 | 미검증 | `pool.test.ts`, `job-manager.test.ts` |
| 설정: PDF DPI 150/300, 배경 최대 변, 보조키 조합, 언어 | 자동 검증됨 | 미검증 | 미검증 | `settings.test.tsx`, `convert-pdf-image.test.ts`, E2E `shell`(설정 전파) |

## P2 — 엔진 확인 후 확장

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| HEIC 읽기/쓰기 | 자동 검증됨(헬퍼 ImageIO: 실제 HEVC 파일 생성, HEIC→PNG 바로 선 방향) | 구현됨(probe만, Rosetta) | 미지원(번들 sharp의 libheif에 HEVC 없음 — darwin 빌드로 실측, Windows 빌드는 같은 구성으로 예상) | `codecs-imageio.test.ts`, 패키지 probe |
| BMP 읽기/쓰기 | 자동 검증됨(자체 코덱, macOS ImageIO와 상호 확인) | 미검증 | 미검증 | `codecs-bmp.test.ts` |
| PDF → DOCX(텍스트 중심) / 이미지 → DOCX(그림 삽입, OCR 없음) | 자동 검증됨(경고 `DOCX_TEXT_ONLY` / `DOCX_IMAGE_ONLY`) | 미검증 | 미검증 | `convert-docx.test.ts` |
| OCR, 영상·음성, AI, 클라우드, 계정 | 미지원(범위 밖) | 미지원 | 미지원 | [requirements.md](requirements.md) |
| Windows ARM64, Linux | — | — | 미지원(범위 밖) | [decisions.md](decisions.md) |

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
- PDF 안에 글꼴이 포함되지 않은 한글은 시스템 글꼴로 그린다. 한글 글꼴이 없는 시스템에서는 빈칸으로 보일 수 있다(텍스트 추출은 동작).
- 서명·공증 자격 증명이 없어 macOS 산출물은 ad-hoc 서명이다. Gatekeeper가 차단하며, 이를 끄라고 안내하지 않는다.
- 실행 확인은 macOS 26.6(arm64, Rosetta x64)뿐이다. macOS 14·15와 Intel Mac은 미실측.
- Windows: 모든 동작이 미실측이다. 특히 Alt+Shift(기본 도구 메뉴 조합)는 Windows 입력 언어 전환 단축키와 겹칠 수 있고,
  관리자 권한으로 실행하면 일반 탐색기의 드래그를 받을 수 없으며(UIPI), 드래그 이미지와 휠 창의 겹침 순서는 실기기에서 확인해야 한다.
- 변환·편집별 메타데이터·색상·투명도 정책: [conversion-policy.md](conversion-policy.md).
