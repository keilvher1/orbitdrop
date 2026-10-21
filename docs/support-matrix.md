# 지원·검증 상태표 (Support matrix)

> 기준일 2026-10-21, 커밋 `3f35f65` 이후. 단위 테스트·CI·빌드 성공을 "실제 OS GUI 검증됨"으로
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

현재 **실제 OS GUI 검증됨** 칸은 하나도 없다. 아래 "자동 검증됨"은 모두 개발 Mac에서 실행한 결과다.

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
| `swift test --package-path native/macos` | Core 80 · Kit · Process 묶음 모두 0 실패(116개) |
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
| 전역 드래그 + Shift → 휠(실제 Finder/Explorer) | 구현됨 · 자동 검증됨(AppKit 경계까지) · **GUI 미검증** | 구현됨(Rosetta에서 stdio만) · GUI 미검증 | 구현됨(교차 컴파일·호스트 테스트만) · 미검증 | Swift `DropTargetGlueTests`(가짜 `NSDraggingInfo`), `SessionControllerTests`, E2E `helper-drop`(stub)·`helper-real`(실제 헬퍼 configure·종료) |
| 휠 hit-test·배치·다중 모니터 좌표 | 자동 검증됨 | 자동 검증됨(Rosetta) | 자동 검증됨(호스트 테스트, macOS clang) · MSVC 미실행 | `tests/fixtures/wheel-golden.json` — TS·Swift·C++ 모두 0 불일치 |
| 드롭 → 작업 정확히 1회, Copy만, 원본 이동 없음 | 자동 검증됨(헬퍼·main) · GUI 미검증 | GUI 미검증 | 미검증 | core `DragSessionTracker` 테스트, Swift drop-target 테스트, E2E `helper-drop` "one job per session" |
| PDF → JPG/PNG(여러 쪽, 150/300 DPI, 회전) | 자동 검증됨 | 자동 검증됨(패키지 smoke PDF→PNG) | 미검증 | `convert-pdf-image.test.ts`, E2E PDF→JPG 2550×3300, 패키지 smoke |
| JPG/PNG/WebP 상호 변환(+ EXIF 회전, 투명 PNG→JPEG) | 자동 검증됨 | 자동 검증됨(smoke PNG→JPG) | 미검증 | `convert-image.test.ts` |
| Crop 편집기(비율, W/H, EXIF 회전) | 자동 검증됨 | 미검증 | 미검증 | `tools-crop`, `cropMath.test.ts`, E2E `ui-flow` 1:1 → 2550×2550 |
| Add Background(패딩·모서리·그림자·비율, 미리보기=최종) | 자동 검증됨 | 미검증 | 미검증 | `tools-add-background`, `composition-layout`(무작위 3000건), electron-verify 16:9 → 2400×1350 |
| 트레이, 설정, 작업 진행·취소·결과 열기 | 자동 검증됨 | 미검증 | 미검증 | E2E `shell`(트레이 메뉴, 설정 전파, 기록), `job-manager.test.ts` |
| 대체 입력(파일 열기, Drop Zone) | 자동 검증됨(Drop Zone) · 파일 열기 대화상자는 단위 테스트만 | 미검증 | 미검증 | electron-verify dropzone, `file-registry.test.ts` |
| 영상 흐름 재현(PDF→JPG→Crop→Add BG, 결과 4개) | 자동 검증됨 · **GUI 미검증** | 미검증 | 미검증 | `tests/integration/video-flow.test.ts`, E2E `ui-flow` "four files side by side" |

## P1 — 일상 도구

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| Compress(실제 크기 예측) | 자동 검증됨 | 미검증 | 미검증 | `tools-compress`, electron-verify compress |
| Metadata(읽기·제거, 가능하면 무손실) | 자동 검증됨 | 미검증 | 미검증 | `tools-metadata`(14) |
| Edit(회전·반전·밝기·대비·채도, 16비트·광색역) | 자동 검증됨 | 미검증 | 미검증 | `tools-edit`, `tools-colour` |
| Annotate(한글 텍스트) | 자동 검증됨(Apple SD Gothic Neo) | 미검증 | 미검증(Malgun Gothic 필요) | `tools-annotate`, electron-verify 한글 주석 저장 |
| Redact(단색·모자이크) | 자동 검증됨 | 미검증 | 미검증 | `tools-redact` |
| TIFF / AVIF 출력 | 자동 검증됨 | 미검증 | 미검증 | `convert-image.test.ts` |
| 이미지 → PDF(여러 장, 순서) | 자동 검증됨 | 미검증 | 미검증 | `convert-images-pdf.test.ts`(진행형·CMYK·EXIF 회전 포함 6쪽), electron-verify 3쪽 |
| 텍스트 PDF → TXT | 자동 검증됨 | 미검증 | 미검증 | `convert-pdf-text.test.ts`(한글 PDF 포함) |
| 여러 파일 제한 병렬, 부분 실패, 취소·시간 초과·재시도 | 자동 검증됨 | 미검증 | 미검증 | core `queue.test.ts`, `pool.test.ts`, `job-manager.test.ts` |

## P2 — 엔진 확인 후 확장

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| HEIC 읽기/쓰기 | 자동 검증됨(헬퍼 ImageIO: 실제 HEVC 파일 생성, HEIC→PNG 바로 선 방향) | 구현됨(probe만, Rosetta) | 미지원(번들 libheif에 HEVC 없음 — 실측) | `codecs-imageio.test.ts`, 패키지 probe |
| BMP 읽기/쓰기 | 자동 검증됨(자체 코덱, macOS ImageIO와 상호 확인) | 미검증 | 미검증 | `codecs-bmp.test.ts` |
| PDF → DOCX(텍스트 중심) / 이미지 → DOCX(그림 삽입, OCR 없음) | 자동 검증됨(경고 `DOCX_TEXT_ONLY` / `DOCX_IMAGE_ONLY`) | 미검증 | 미검증 | `convert-docx.test.ts` |
| OCR, 영상·음성, AI, 클라우드, 계정 | 미지원(범위 밖) | 미지원 | 미지원 | [requirements.md](requirements.md) |
| Windows ARM64, Linux | — | — | 미지원(범위 밖) | [decisions.md](decisions.md) |

## 알려진 제약

- macOS에서 Input Monitoring 권한이 없으면 Esc는 포인터가 휠 위에 있을 때만 감지된다. 그 밖의 경우 마우스를 놓으면 휠이 닫힌다.
- macOS에서는 Control·Command가 들어간 보조키 조합을 쓸 수 없다. AppKit이 이를 Link/Generic 드래그로 바꿔 Copy 드롭이 거부되기 때문이다.
- PDF 안에 글꼴이 포함되지 않은 한글은 시스템 글꼴로 그린다. 한글 글꼴이 없는 시스템에서는 빈칸으로 보일 수 있다(텍스트 추출은 동작).
- 서명·공증 자격 증명이 없어 macOS 산출물은 ad-hoc 서명이다. Gatekeeper가 차단하며, 이를 끄라고 안내하지 않는다.
