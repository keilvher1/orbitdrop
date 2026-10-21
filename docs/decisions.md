# 기술 결정 기록 (ADR)

각 항목: 결정 · 이유 · 대안 · 결과/검증. 날짜는 모두 2026-10-21 기준.
버전 근거: [PROGRESS.md](PROGRESS.md) "Chosen versions"와 `pnpm-lock.yaml`.

---

## ADR-01. Electron + TypeScript + electron-vite (+ React 19)

* **결정**: Electron 44.9.0(Chromium 152, Node 24.x), electron-vite 6.0.0(Vite 8), React 19, TypeScript 7.
  main/preload는 CJS 번들, renderer는 React 번들. 워크스페이스 패키지(`@orbitdrop/*`)는 번들에 포함되고,
  런타임 의존성(sharp, pdfjs-dist, @napi-rs/canvas, pdf-lib, docx, …)은 `node_modules`로 배포한다.
* **이유**: 양 OS 공통 편집 UI·트레이·설정·작업 관리를 한 코드로 만들고, 드래그 중 OS 통합만 네이티브
  helper에 맡긴다(ADR-07). electron-vite는 main/preload/renderer 3개 타깃과 `utilityProcess` 진입점
  (`processor-host`)을 한 설정으로 빌드한다.
* **대안**: Tauri(WebView 차이로 편집 UI·Canvas 동작이 OS마다 달라지고 Node 이미지/PDF 생태계를 쓰기 어려움),
  순수 네이티브 2벌(UI 중복).
* **보안**: renderer `nodeIntegration` 끔, `contextIsolation`·`sandbox` 유지, preload에서 최소 API만 노출,
  IPC는 zod로 검증. 패키지에는 Electron fuses(ADR-02)를 적용한다.

## ADR-02. 패키저: electron-builder

* **결정**: electron-builder 26.15.3 하나만 사용한다(Electron Forge 미사용). 설정은
  `apps/desktop/electron-builder.yml`, 검사 훅은 `scripts/after-pack.cjs`.
* **이유**:
  1. 요구 산출물을 한 설정으로 만든다 — macOS dmg+zip(arm64/x64 별도), Windows **NSIS 사용자별 설치 +
     설치 경로 선택 + 제거 프로그램**. Forge의 기본 Windows maker(Squirrel.Windows)는 경로 선택이 없고
     업데이트 중심 동작이라 요구와 맞지 않는다(WiX MSI maker는 별도 도구 체인 필요).
  2. `asarUnpack`, 아키텍처별 `files` 규칙, `extraResources`(helper), `afterPack` 훅으로 네이티브 모듈과
     helper 배치를 선언적으로 검증할 수 있다.
  3. 서명·공증을 환경 변수(`CSC_LINK`, `APPLE_API_KEY…`, `WIN_CSC_LINK`)로 켜고 끌 수 있어 "자격 증명이 없으면
     미서명" 정책을 단순하게 구현한다. Electron fuses도 설정 한 곳에서 켠다.
  4. pnpm 11 워크스페이스(hoisted)의 운영 의존성 수집기를 내장한다(실측: pnpm collector 사용).
* **결과**: Apple Silicon Mac에서 arm64·x64 dmg/zip 생성, ad-hoc 서명 검증, DMG 레이아웃, 패키지 smoke
  test까지 자동화(증거: [verification.md](verification.md#자동-검증-증거)). Windows 산출물은 Windows CI에서만 만든다.

## ADR-03. pnpm 11 + `nodeLinker: hoisted`

* **결정**: pnpm 워크스페이스, `node_modules`는 평평한(hoisted) 구조. 라이프사이클 스크립트는
  `allowBuilds`(electron, esbuild)만 허용. `supportedArchitectures`로 x64·arm64 바이너리를 함께 설치.
* **이유**: electron-builder가 `node_modules`를 앱에 복사할 때 심볼릭 링크 기반 레이아웃은 네이티브 프리빌트
  패키지(`@img/*`, `@napi-rs/canvas-*`) 경로가 꼬이기 쉽다. Apple Silicon 한 대에서 x64 패키지도 만들기 위해
  양 아키텍처 바이너리가 필요하다(대상 외 아키텍처는 패키지에서 제외, ADR-02의 after-pack 훅이 확인).
* **주의**: pnpm 11은 허용하지 않은 postinstall을 실행하지 않는다. Electron 바이너리가 없으면
  `node node_modules/electron/install.js`([development.md](development.md)).

## ADR-04. 이미지 엔진: sharp(libvips) + 실측 기반 capability

* **결정**: 래스터 변환·편집은 sharp 0.35.5(libvips 8.18.7). 메뉴는 번들 엔진을 실측한
  `probeEngines()` → `buildCapabilitySnapshot()` 결과로만 활성화한다.
* **실측 (darwin-arm64, sharp 단독)**: 인코딩 JPEG/PNG/WebP/TIFF/GIF/AVIF 가능, **HEIC(HEVC) 인코딩 실패**
  ("Unsupported compression"), **BMP 없음**, **PDF 없음**. 따라서:
  * BMP는 processors의 자체 코덱(`codecs/bmp.ts`), 이미지 PDF는 pdf-lib(ADR-05)로 구현.
  * HEIC(P2)는 macOS helper의 ImageIO 모드(`OrbitDropHelper imageio …`)가 지원 방향을 보고할 때만 활성화.
    Windows에서는 번들 디코더/인코더가 없으면 비활성(사유 표시).
  * 패키지된 앱의 smoke probe(arm64, helper 없음) 결과: decode `jpeg,png,webp,gif,tiff,avif,bmp,pdf`,
    encode `jpeg,png,webp,gif,tiff,avif,bmp,pdf,docx,txt`.
* **이유**: "sharp 기본 배포만으로 영상의 모든 메뉴를 지원한다"고 가정하지 않기 위해. 확장자만 바꾸는 변환 금지.

## ADR-05. PDF: PDF.js(렌더링·텍스트) + @napi-rs/canvas, pdf-lib(쓰기)

* **결정**: PDF → 이미지/텍스트는 pdfjs-dist 6.4.299(**legacy build**)를 processor worker(utilityProcess)에서
  실행하고, 래스터화는 @napi-rs/canvas(Skia). 이미지 → PDF는 pdf-lib. 두 라이브러리의 역할을 섞지 않는다.
  CMap·표준 폰트·wasm 디코더(JPX/JBIG2)·ICC는 패키지 안의 로컬 파일을 `fs`로 읽는다(네트워크·CDN 없음).
* **측정된 함정**: utilityProcess에서는 `process.type === 'utility'`라 PDF.js가 Node 환경을 감지하지 못한다
  (`isNodeJS === false`, `document`/`Worker`/`XMLHttpRequest` 없음). processors는 CanvasFactory·
  BinaryDataFactory를 직접 넘기고 worker 모듈을 프로세스 안에서 로드한다(`packages/processors/src/pdf/engine.ts`).
  Vitest(순수 Node)만으로는 이 경로가 검증되지 않으므로 패키지 smoke probe(`pdfRender`, `pdfText`)로 확인한다.
* **대안**: pdfium 네이티브 바인딩(라이선스·빌드 부담), Chromium 내장 PDF 뷰어 캡처(스크린샷 기반이라 금지).

## ADR-06. DOCX: `docx` 라이브러리, "텍스트 중심"

* **결정**: PDF/이미지 → DOCX는 `docx` 9.12로 문단 중심 문서를 만들고 UI에 "텍스트 중심"이라고 표시한다(P2).
  레이아웃(표·다단) 복원과 OCR은 범위 밖이며 스캔 PDF를 빈 성공 파일로 만들지 않는다.

## ADR-07. 네이티브 helper가 드래그 중 휠 창의 단일 소유자 + stdio NDJSON

* **결정**: macOS(Swift/AppKit)·Windows(C++/Win32/OLE) helper 프로세스 하나가 드래그 관찰, 휠 창(시각 +
  드롭 대상이 **같은 창**), 좌표 변환, hit-test, 선택 상태, 드롭 수락을 모두 소유한다. main은 휠용 드롭
  타깃을 따로 등록하지 않고 드래그 중 휠을 그리지 않는다. 통신은 부모가 만든 **stdin/stdout 파이프의
  NDJSON**(`packages/contracts/src/helper-protocol.ts`, 버전·길이·타입·action ID 검증). TCP 포트 없음.
* **이유**: 시각 창과 입력 창을 따로 겹치면 좌표·배율·투명 영역 hit-test가 OS마다 어긋난다. 단일 소유자가
  같은 좌표계에서 그리고 받는다. 휠 기하는 `packages/core/src/geometry.ts` 참조 구현과
  `tests/fixtures/wheel-golden.json` 골든 테스트로 세 구현(TS·Swift·C++)이 일치하게 한다.
* **드롭 정책**: **Copy만** 수락한다. 원본이 Copy를 허용하지 않으면 None으로 거부하고, Shift의 기본 Move
  의미로 원본이 삭제되지 않게 한다. 드롭 콜백 안에서 경로를 앱 소유 값으로 복사하고 즉시 반환하며,
  창 표시·포커스 변경은 다음 이벤트 루프에서 한다. main의 `DragSessionTracker`는 세션당 드롭 1회만 받는다.

## ADR-08. 처리 격리: utilityProcess 풀

* **결정**: 변환·편집은 Electron `utilityProcess`(`out/main/processor-host.js`)에서 실행한다. 작업자 수 =
  `settings.processing.concurrency`(1–4, 기본 2), 작업자당 한 번에 한 작업, 기본 제한 시간 600초.
  작업 중 작업자가 죽으면 `WORKER_CRASHED`로 실패 처리하고 한 번 재시도하며, 작업자를 다시 띄우고
  `cleanupTempFiles(dir, jobId)`로 임시 파일을 정리한 뒤 재시도한다.
* **이유**: 손상 파일·메모리 폭증이 UI나 앱 전체를 죽이지 않게. main/renderer 스레드에서 무거운 작업 금지.

## ADR-09. 설정: 버전 있는 JSON

* **결정**: `app.getPath('userData')/settings.json`, `SETTINGS_VERSION = 1`, `migrateSettings()`가 이전 형식을
  변환하고 잘못된 필드는 기본값으로 되돌린다(앱이 죽지 않음). 로그인 시 실행 기본 꺼짐, 기본 언어 한국어.

## ADR-10. 최소 OS 버전

* **Electron 44 공식 지원 범위**(node_modules/electron/README.md "Platform support"): macOS **Ventura(13) 이상**
  (Intel x64, Apple Silicon arm64), Windows **10 이상**(x64, arm64). Electron 앱 번들의 기본
  `LSMinimumSystemVersion`은 13.0.
* **OrbitDrop 결정**:
  * macOS **14.0 이상** — 명세의 필수 목표(macOS 14+ Apple Silicon)에 맞춘 제품 결정이며 Electron 하한(13)보다
    높다. `mac.minimumSystemVersion: "14.0"`, Swift helper도 `.macOS(.v14)`로 빌드. Intel(x64) 산출물도 14.0 이상.
  * Windows **11 x64**가 검증 대상. Windows 10 x64는 Electron이 지원하므로 설치·실행은 가능할 것으로 보이나
    **미검증**으로 표기한다. Windows ARM64와 Linux는 범위 밖.
* **결과**: 지원표([support-matrix.md](support-matrix.md))는 OS 버전·아키텍처·빌드 번호와 함께 검증 수준을 따로 적는다.

## ADR-11. 아이콘과 트레이 아이콘

* **결정**: 독자적인 OrbitDrop 아이콘(4분할 궤도 링 + 내려놓는 파일, 디자인 토큰의 크림/살구/주황)을
  `apps/desktop/build/icon.svg`로 관리하고 `scripts/gen-icons.mjs`가 sharp로 렌더링해 PNG/ICNS/ICO를 만든다
  (자체 ICNS/ICO 기록기, PNG 압축 항목, 추가 의존성 없음). macOS 메뉴 막대는 템플릿 이미지(검정+알파),
  Windows 알림 영역은 컬러 ICO. 참고 앱(Tangerine)의 아이콘·이름은 쓰지 않는다.
