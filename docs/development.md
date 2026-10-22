# 개발 가이드 (Development)

## 1. 준비물

| 도구 | 버전 | 비고 |
|---|---|---|
| Node.js | 22.12 이상(개발은 24.x) | Electron 44는 Node 24.x를 내장 |
| pnpm | 11.27.1 (`package.json`의 `packageManager`) | `corepack enable` 또는 pnpm 단독 설치 |
| macOS helper | Xcode(Swift 6), macOS 14 이상 | `swift build`, `codesign`, `hdiutil`, `iconutil` |
| Windows helper | Visual Studio 2022 Build Tools(C++), CMake | 패키지는 Windows에서만 빌드 |
| Rosetta 2 | (Apple Silicon에서 x64 패키지 smoke test 시) | `softwareupdate --install-rosetta` |

설치본은 Homebrew·시스템 Node·외부 변환기에 의존하지 않는다. 위 도구는 **개발·빌드용**이다.

## 2. 설치

```sh
pnpm install
```

* pnpm 11은 허용 목록에 있는 라이프사이클 스크립트만 실행한다(`pnpm-workspace.yaml`의 `allowBuilds`:
  `electron`, `esbuild`). Electron의 postinstall이 런타임 바이너리를 내려받는다. 내려받기가 막혔거나
  `node_modules/electron/dist`가 비어 있으면:
  ```sh
  node node_modules/electron/install.js
  ```
  캐시 위치를 바꾸려면 `electron_config_cache`(postinstall)와 `ELECTRON_CACHE`(electron-builder)를 같은 폴더로 지정한다.
* `nodeLinker: hoisted`(평평한 `node_modules`)와 `supportedArchitectures`(x64 + arm64) 때문에 Apple Silicon
  Mac에는 darwin-arm64와 darwin-x64용 sharp/libvips/@napi-rs/canvas가 함께 설치된다. Windows 바이너리는
  Windows에서 설치할 때만 받아진다.
* 새 패키지를 추가할 때 런타임에 필요한 것은 `apps/desktop`의 `dependencies`(앱에 `node_modules`로 포함)에,
  번들에만 들어가는 UI 라이브러리는 `devDependencies`에 둔다. 그다음 `node scripts/licenses.mjs`.

## 3. 명령

| 목적 | 명령 |
|---|---|
| 개발 실행 (HMR) | `pnpm dev` |
| 단위·통합 테스트 | `pnpm test` (Vitest 프로젝트: contracts, core, processors, desktop, tests/integration) |
| 감시 모드 | `pnpm test:watch` |
| 타입 검사 | `pnpm typecheck` |
| 번들 빌드 | `pnpm build` (`apps/desktop/out`) |
| UI 자동화(Playwright + Electron) | `pnpm --filter @orbitdrop/desktop test:e2e` |
| 네이티브 helper (macOS) | `pnpm native:mac` = `node scripts/build-native.mjs mac [--arch arm64\|x64\|all\|universal] [--test] [--debug]` — 릴리스 빌드(최소 macOS 14.0), strip, hardened runtime ad-hoc 서명, 검증, stdio smoke test 후 `apps/desktop/resources/helper/darwin-<arch>/`에 스테이징 |
| 네이티브 helper (Windows) | `pnpm native:win` = `node scripts/build-native.mjs win [--arch x64]` |
| Swift 단위 테스트 | `swift test --package-path native/macos` |
| 패키지 | `pnpm package:mac` / `pnpm package:win` ([packaging.md](packaging.md)) |
| 휠 골든 벡터 | `node scripts/gen-golden.mjs` (재생성) / `--check`(TS 기하 참조 대비 오래되면 종료 코드 1, CI에서 실행; tsx로 스스로 재실행) → `tests/fixtures/wheel-golden.json` |
| 실제 FAT32 볼륨 테스트(macOS 전용, 선택) | `ORBITDROP_FS_TESTS=1 node_modules/.bin/vitest run --root packages/core test/output-fat.test.ts` (디스크 이미지를 만들어 마운트) |
| 테스트 픽스처 | `pnpm fixtures` = `node scripts/gen-fixtures.mjs [outDir]` |
| 아이콘 | `node scripts/gen-icons.mjs [--verify]` |
| 제3자 라이선스 | `node scripts/licenses.mjs [--check]` → `THIRD_PARTY_LICENSES.md` (오프라인) |
| 라이선스 원문 스냅숏 갱신 | `node scripts/licenses-fetch.mjs [--refresh]` (네트워크) → `docs/licenses/upstream/`; `--librsvg-crates`(cargo 필요) → `docs/licenses/librsvg-crates.json` ([packaging.md §7](packaging.md#7-제3자-라이선스-목록)) |

모든 스크립트는 Node `.mjs`라 macOS·Windows에서 같은 명령으로 동작한다(POSIX 셸 문법 없음).

## 4. 실행 옵션과 환경 변수 (main)

| 옵션 | 의미 | 패키지된 앱 |
|---|---|---|
| `--smoke-test` | 창 없이 엔진 probe → helper `ready` 대기(최대 5초) → 생성한 PNG를 실제 작업 파이프라인으로 JPG 변환(+ PDF→PNG) → stdout에 `ORBITDROP_SMOKE {…}` 한 줄 → 종료 코드 0/1. 창을 열지 않으므로 렌더러 로드는 검사하지 않는다 | 적용 |
| `--smoke-optional-helper` / `ORBITDROP_SMOKE_OPTIONAL_HELPER=1` | helper가 없어도 smoke test 통과(개발 체크아웃용) | 적용 |
| `ORBITDROP_DEBUG=1` | 디버그 로그(경로는 여전히 가림) | 적용 |
| `ORBITDROP_HELPER_PATH=<path>` | helper 실행 파일 경로 지정 | 무시 |
| `ORBITDROP_DISABLE_HELPER=1` | helper를 띄우지 않음(대체 경로만) | 무시 |
| `ORBITDROP_NO_TRAY=1` | 트레이 아이콘 없음 | 무시 |
| `ORBITDROP_USER_DATA_DIR=<dir>` | 설정·데이터 폴더(테스트는 임시 폴더) | 무시 |
| `ORBITDROP_E2E=1`, `ORBITDROP_E2E_TRAY=1`, `ORBITDROP_E2E_HELPER=1` | 자동화 모드(트레이·helper 없음, 포커스 빼앗지 않음, 테스트 훅) | 무시 |

패키지된 앱은 `--smoke-test`, `--smoke-optional-helper`, `ORBITDROP_DEBUG`만 따른다. 같은 사용자의 다른 프로세스가 환경 변수를
심어(`launchctl setenv` 등) 설정·기록 위치를 옮기거나 트레이를 숨기거나 전역 드래그를 끄지 못하게 하기 위함이다
(`src/main/launch-options.ts`). 패키지된 앱의 작업자(utilityProcess)는 물려받은 `ORBITDROP_*` 변수를 하나도 받지 않는다
(`ORBITDROP_PDFJS_DIR` 등은 main이 직접 정한다).

helper 탐색 순서: (개발 빌드만) `ORBITDROP_HELPER_PATH` → 패키지: `<resources>/helper/OrbitDropHelper[.exe]` →
개발: `apps/desktop/resources/helper/<platform>-<arch>/`(`darwin-arm64`, `darwin-x64`, `win32-x64`).

## 5. 디버깅

* 로그는 stderr로 나간다(stdout은 smoke test 결과 줄 전용). 문서 내용·전체 경로는 기록하지 않는다.
* main 디버깅: `pnpm --filter @orbitdrop/desktop exec electron-vite dev --inspect 9229 --sourcemap` 후
  디버거(VS Code "Attach", `chrome://inspect`)를 붙인다. `-w`는 main/preload 변경 시 재빌드.
  패키지된 앱에서는 fuses로 `--inspect` 계열과 `NODE_OPTIONS`가 꺼져 있다.
* renderer: 개발 실행 중 각 창에서 DevTools(개발 빌드만).
* processor worker(utilityProcess) 문제는 Vitest에서 재현되지 않을 수 있다(예: PDF.js의 Node 감지,
  [decisions.md ADR-05](decisions.md#adr-05-pdf-pdfjs렌더링텍스트--napi-rscanvas-pdf-lib쓰기)). 패키지 smoke test 또는
  `pnpm dev`에서 확인한다.
* helper 단독 실행: helper는 NDJSON을 stdin/stdout으로 주고받는다(`packages/contracts/src/helper-protocol.ts`).
  macOS ImageIO 모드: `OrbitDropHelper imageio --probe`.

## 6. 테스트 원칙

* 결과 파일을 다시 읽어 검증한다(이미지 디코딩·크기·픽셀, PDF 페이지 수, DOCX/TXT 내용). 구현을 다시 적는 테스트 금지.
* 실제 Finder/Explorer 드래그는 단위 테스트·빌드로 "검증됨"이라 하지 않는다 → [verification.md](verification.md)의 수동 절차.
* 지원표의 등급(구현됨 / 자동 검증됨 / 실제 OS GUI 검증됨 / 미검증 / 미지원) → [support-matrix.md](support-matrix.md).

## 7. 저장소 구조

```
apps/desktop/            Electron 앱 (main, preload, renderer, electron-builder.yml, build/, resources/)
packages/contracts/      공통 타입·스키마·디자인 토큰 (IPC, 작업, capability, helper/processor 프로토콜)
packages/core/           작업 큐, 이름 규칙, 검증, 좌표·휠 기하, capability registry
packages/processors/     이미지·PDF 처리 (sharp, PDF.js + @napi-rs/canvas, pdf-lib, docx)
native/macos/            Swift helper (SwiftPM)
native/windows/          C++ helper (CMake)
tests/fixtures, tests/integration
scripts/                 build-native, package, after-pack, gen-icons, licenses, gen-golden, gen-fixtures
docs/                    요구사항·결정·개발·지원표·검증·권한·패키징
```
