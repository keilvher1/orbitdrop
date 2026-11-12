# 패키징 · 서명 · 배포 (Packaging, signing, distribution)

OrbitDrop은 **electron-builder 26.15.3** 하나로 패키징한다(선택 이유: [decisions.md ADR-02](decisions.md#adr-02-패키저-electron-builder)).
설정: [`apps/desktop/electron-builder.yml`](../apps/desktop/electron-builder.yml) ·
구동 스크립트: [`scripts/package.mjs`](../scripts/package.mjs) ·
훅: [`apps/desktop/build/before-pack.cjs`](../apps/desktop/build/before-pack.cjs)(node_modules 수집 우회),
[`scripts/after-pack.cjs`](../scripts/after-pack.cjs)(검사) ·
라이선스: [`scripts/licenses.mjs`](../scripts/licenses.mjs), [`scripts/licenses-fetch.mjs`](../scripts/licenses-fetch.mjs),
[`scripts/third-party-sources.mjs`](../scripts/third-party-sources.mjs)(LGPL·MPL 대응 소스 묶음) ·
CI: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`release.yml`](../.github/workflows/release.yml) ·
릴리스 절차: [RELEASING.md](RELEASING.md) · 자동 업데이트: [§9](#9-자동-업데이트).

> 원칙: macOS 패키지는 macOS에서, Windows 패키지는 Windows에서만 만든다. 서명 자격 증명이 없으면
> **미서명(unsigned)** 산출물을 만들고 파일 이름에 그 사실을 적는다. 서명·공증을 꾸며내지 않고,
> Gatekeeper/SmartScreen을 끄라고 안내하지 않으며, 아무것도 자동으로 공개 배포하지 않는다(빌드는 언제나 `--publish never`,
> 릴리스는 초안까지만 자동 — [RELEASING.md](RELEASING.md)).

## 1. 명령

```sh
pnpm package:mac                      # = node scripts/package.mjs mac  (호스트 아키텍처)
node scripts/package.mjs mac --arch all   # arm64 + x64 별도 산출물
node scripts/package.mjs win --arch x64   # Windows에서 실행
```

| 옵션 | 의미 |
|---|---|
| `--arch arm64\|x64\|all` | macOS 아키텍처(기본: 호스트). Windows는 `x64`만 |
| `--dir` | 설치 파일 없이 앱 폴더만 생성(빠른 확인용) |
| `--unsigned` | 자격 증명이 있어도 미서명으로 빌드 |
| `--require-signing` | 자격 증명이 없으면 실패 |
| `--require-notarization` | (macOS) 앱과 DMG가 공증·staple되지 않으면 실패. `CSC_NAME`(키체인의 신원)과 `APPLE_*` 공증 자격 증명이 필요하다. `--require-signing` 포함 |
| `--skip-native` / `--skip-build` | 이미 스테이징된 helper / 이미 빌드된 `apps/desktop/out` 재사용 |
| `--skip-smoke` | 패키지 실행 검사 생략 |
| `--install-test` | (Windows) NSIS 무인 설치 → HKCU 제거 항목, `installer-preferences.json`(업데이트 확인 켬), 설치된 실행 파일의 버전 정보·서명 → 설치본 smoke test → 제거(파일도 사라짐) → `/S /NOUPDATECHECK`로 한 번 더(파일이 끔) |
| `--signpath prepare\|installer\|finish`, `--signed <dir>` | (Windows 릴리스) SignPath로 서명하는 세 단계(§5 "Windows 코드 서명") |
| `--allow-incomplete` | helper나 `--smoke-test` 구현이 아직 없을 때 파이프라인만 시험(산출물에 `-incomplete` 표시) |

`package.mjs`의 단계: 사전 점검(호스트 OS, 대상 아키텍처의 sharp/libvips/canvas 바이너리 설치 여부,
Rosetta) → `scripts/licenses.mjs`로 `THIRD_PARTY_LICENSES.md` 재생성(오프라인) → 아이콘 검증 →
`scripts/build-native.mjs`로 helper 빌드·스테이징 → `electron-vite build` → **제품 ID 일치 검사**(아래 "제품 ID") →
아키텍처별 electron-builder(before-pack·after-pack 훅 포함) → 검사(macOS: Info.plist, `lipo`, `codesign --verify`,
`spctl`, DMG 읽기 전용 마운트; 공통: **Electron fuse 되읽기**) → **패키지된 앱의 `--smoke-test`**(macOS는 읽기 전용으로
마운트한 DMG 안의 앱을 그대로 실행, Apple Silicon에서 x64는 `arch -x86_64`) → **네이티브 모듈 검사**(아래) →
**DMG 서명·공증·staple**(Developer ID + 공증 자격 증명일 때, §4) → **업데이트 메타데이터 검사**(§9: 아키텍처별 `latest-mac.yml`을 하나로
합치고 `latest*.yml`이 가리키는 파일·크기·sha512를 대조) →
`apps/desktop/release/build-report-<os>-<arch>.json`(GitHub Actions에서는 작업 요약 표도 작성).
모든 패키지에는 `Resources/build-info.json`(`{version, commit, dirty, signing, builtAt}`; `package.mjs`가 `ORBITDROP_BUILD_INFO`로
넘기고 after-pack 훅이 서명 전에 쓴다)과 `Resources/app-update.yml`(electron-builder가 `publish` 설정으로 쓴다)이 들어가며, 검사 단계가
둘 다 확인한다. 앱은 정보 창에 커밋을 보여 주고, 서명 방식으로 자동 업데이트 가능 여부를 정한다(§9).
다른 작업이 패키징 도중 `apps/desktop/out`을 다시 빌드하면 감지해 실패시킨다.

네이티브 모듈 검사: 패키지된 실행 파일은 임의 스크립트를 실행할 수 없으므로(fuses), 같은 버전의 기본 Electron 런타임이
[`apps/desktop/build/native-check`](../apps/desktop/build/native-check)를 utilityProcess로 실행해 패키지 Resources 안의
sharp/libvips/@napi-rs/canvas 파일을 앱과 같은 경로 해석으로 불러온다. librsvg(배경 추가의 SVG 그라데이션·둥근 모서리 마스크),
canvas의 `app.asar.unpacked` 로드와 시스템 한글 글꼴(macOS Apple SD Gothic Neo, Windows Malgun Gothic), 실제로 매핑된
네이티브 파일 경로를 확인하고, smoke test가 거치지 않는 순수 JS 기록기도 패키지 안의 사본으로 실행한다: pdf-lib가 PNG를 넣은
PDF를 쓰고 다시 읽으며(이미지 → PDF), docx가 한글 문단을 ZIP으로 묶는다(PDF → DOCX). 잘못된 버전으로 복사되었거나
`files` 제외 규칙에 잘려 나간 의존성은 여기서 실패한다. macOS x64는 electron-builder가 내려받은 darwin-x64 런타임을 Rosetta 2로 쓴다.

Electron fuse 되읽기: `@electron/fuses`로 패키지 실행 파일(macOS는 Electron Framework, Windows는 exe)의 fuse 값을 읽어
`electron-builder.yml`의 `electronFuses`와 하나라도 다르면 실패시키고 build report의 `inspection.fuses`에 기록한다.
UI를 `loadFile()`로 `app.asar` 안에서 여는 동안 `GrantFileProtocolExtraPrivileges`가 꺼져 있으면 별도로 실패시킨다(§3 참고).

## 2. 산출물

| 대상 | 파일 (`apps/desktop/release/`) | 비고 |
|---|---|---|
| macOS arm64 | `OrbitDrop-<ver>-mac-arm64[-unsigned].dmg`, `.zip` | 최소 macOS 14.0 |
| macOS x64 | `OrbitDrop-<ver>-mac-x64[-unsigned].dmg`, `.zip` | 최소 macOS 14.0, Intel 실기 검증은 별도 기록. Apple 실리콘에서 실행하면 Rosetta 2로 동작하지만 첫 실행이 느리고(가상 머신에서 약 1분 40초), 앱이 시작 알림·설정·정보 창으로 arm64 설치본을 안내한다 |
| Windows x64 | `OrbitDrop-<ver>-win-x64[-unsigned]-setup.exe` | NSIS, 사용자별 설치. SignPath로 서명한 릴리스는 `-unsigned` 없음(`-rehearsal`은 서명 흐름 시험용, 배포 안 함) |
| 업데이트 메타데이터 | `latest-mac.yml`(두 아키텍처의 zip), `OrbitDrop-<ver>-mac-<arch>[-unsigned].zip.blockmap`, `latest.yml`(setup.exe) | §9. DMG는 업데이트 파일이 아니다(`dmg.writeUpdateInfo: false`). Windows 설치 프로그램에는 blockmap이 없다(`nsis.differentialPackage: false`) |
| 릴리스에만 | `SHA256SUMS.txt` | 릴리스의 모든 파일의 SHA-256. CI(`release-assets.mjs`)와 `release-mac.mjs`가 다시 쓴다 |

universal 바이너리는 만들지 않는다(네이티브 모듈과 helper를 아키텍처별로 검증하기 위해).

## 3. 앱 안에 들어가는 것 (리소스 경로)

| 항목 | macOS (`OrbitDrop.app/Contents/Resources/`) | Windows (설치 폴더) |
|---|---|---|
| 번들 JS (main/preload/renderer/processor-host) | `app.asar/out/**` | `resources\app.asar\out\**` |
| 런타임 JS 의존성 (pdfjs-dist, pdf-lib, docx, zod, …) | `app.asar/node_modules/**` | 동일 |
| sharp + libvips, @napi-rs/canvas 네이티브 바이너리 | `app.asar.unpacked/node_modules/@img/sharp-darwin-<arch>`, `@img/sharp-libvips-darwin-<arch>`, `@napi-rs/canvas-darwin-<arch>` | `resources\app.asar.unpacked\node_modules\@img\sharp-win32-x64`(libvips DLL 포함), `@napi-rs\canvas-win32-x64-msvc` |
| PDF.js 리소스(cmaps, standard_fonts, wasm, iccs, legacy build) | `app.asar/node_modules/pdfjs-dist/**` | 동일 |
| 네이티브 드래그 helper | `helper/OrbitDropHelper` | `resources\helper\OrbitDropHelper.exe` |
| 트레이/메뉴 막대 아이콘 (OS별로 쓰는 파일만) | `tray/trayTemplate.png`, `tray/trayTemplate@2x.png` | `resources\tray\tray.ico`, `tray.png`, `tray@2x.png` |
| 라이선스 | `THIRD_PARTY_LICENSES.md`, `LICENSE.electron.txt`, `LICENSES.chromium.html` | `resources\THIRD_PARTY_LICENSES.md`, `LICENSE.electron.txt`, `LICENSES.chromium.html` |
| 업데이트 설정 (electron-builder) | `app-update.yml` (github, keilvher1/orbitdrop) | `resources\app-update.yml` |
| 빌드 정보 (after-pack) | `build-info.json` | `resources\build-info.json` |

* **ASAR**: 켜져 있다. 네이티브 코드는 asar 내부를 읽을 수 없으므로 네이티브 패키지만
  `asarUnpack`. Electron 44의 `utilityProcess`에서도 `fs`/`fs/promises`/`import()`/`require`가
  asar 내부 파일을 읽는 것을 실측했다(2026-10-21). `fetch(file://)`는 Node에서 지원되지 않으므로
  리소스는 `fs`로 읽는다. 네이티브 코드(sharp, canvas의 `registerFromPath` 등)에 **경로**를 넘기는
  파일은 asar 밖에 있어야 한다 — 가능하면 Buffer로 넘긴다.
* **아키텍처**: pnpm `supportedArchitectures` 때문에 Apple Silicon 체크아웃에는 darwin-arm64와
  darwin-x64 바이너리가 함께 설치된다. `files`의 `${platform}-${arch}` 제외 규칙이 대상 외 패키지를
  빼고, after-pack 훅이 남은 모든 Mach-O/PE를 검사해 다른 아키텍처면 제거(알려진 플랫폼 패키지)하거나
  빌드를 실패시킨다.
* **npmRebuild: false**: sharp와 @napi-rs/canvas는 N-API 프리빌트라 Electron에서 재컴파일하지 않는다.
  설치본은 Homebrew·시스템 Node·외부 변환기를 쓰지 않는다(sharp는 자체 libvips 사용).
* **node_modules 수집(electron-builder 26.15.3 + pnpm 11 hoisted 버그 우회)**: `pnpm list --json`은 hoisted 배치에도
  존재하지 않는 가상 저장소 경로(`node_modules/.pnpm/<이름>@<버전>/…`)를 보고하고, electron-builder의 pnpm 수집기는
  정확한 버전을 못 찾으면 "선언 범위 밖 버전 허용" 대체 경로로 최상위에 hoist된 사본을 복사한다(로그는 debug 수준뿐).
  0.1.0 패키지(소스 d4f6d1e)는 그래서 pdf-lib 1.17.1에 tslib 1.14.1 대신 2.8.1을, docx 9.12.0에 nanoid 6.0.2 대신
  3.3.20을 담았다(둘 다 개발 도구용 사본; 현재는 우연히 동작). [`build/before-pack.cjs`](../apps/desktop/build/before-pack.cjs)
  (`beforePack`)가 수집기에 hoisted 트리에서 정확한 이름@버전을 찾게 하고(대상 app-builder-lib 버전에서만 적용, 다른 버전이면 경고),
  after-pack 훅이 결과를 검증한다(아래). electron-builder를 올리면 우회가 여전히 필요한지 확인하고 `PATCHED_VERSIONS`를 갱신한다.
* **번들에서 뺀 파일(크기)**: pdf.js 최신 빌드·뷰어·스크립팅 샌드박스(QuickJS), 그리고 Node가 읽지 않는 브라우저/ESM 중복본 —
  docx의 다른 진입점(`docx/layout` 등, `index.cjs`/`index.mjs`는 유지), `pdf-lib/es`, `@pdf-lib/*`의 `dist`/`es`,
  `pako`·`jszip`·`xml-js`의 `dist`, CLI·테스트·도구 설정 파일. 실측(arm64 사본에서 같은 규칙으로 재구성): `app.asar`
  24.9 MB → 14.9 MB, node_modules 1,117 → 911 파일. 재구성한 사본으로 smoke test·패키지 안 pdf-lib/docx 실행·의존성 검사 통과.
* **Electron fuses**: `runAsNode`, `NODE_OPTIONS`, `--inspect` 계열을 끄고 asar 무결성 검증과
  `onlyLoadAppFromAsar`를 켠다. 사용자가 OrbitDrop에 준 권한(예: 손쉬운 사용)을 다른 프로세스가
  `ELECTRON_RUN_AS_NODE`로 재사용하지 못하게 하기 위함. **`GrantFileProtocolExtraPrivileges`는 켜 둔다**: 창들이 UI를
  `loadFile()`로 `app.asar` 안의 `file://`에서 여는데, 이 fuse를 끄면 Electron의 `file://` 처리기가 asar를 읽지 않아 모든 창이
  `ERR_FILE_NOT_FOUND`로 빈 화면이 된다(asar 밖에서는 모듈 스크립트·CSS가 CORS로 막힌다). 0.1.0 패키지가 이 상태로 나갔다 —
  smoke test는 창을 열지 않아 통과했다(실측: [workstreams/hardening-packaging.md](workstreams/hardening-packaging.md)).
  이 fuse를 끄려면 먼저 UI를 사용자 정의 프로토콜(예: `app://`)로 제공해야 한다.
* **언어 리소스**: Chromium UI 문자열은 `ko`, `en-US`만 남긴다(`electronLanguages`).

### after-pack 훅이 실패시키는 경우

* `app.asar`에 필수 항목(`out/main/index.js`, `out/main/processor-host.js`, `out/preload/index.js`,
  `out/renderer/index.html`, sharp·pdfjs-dist(legacy build, 폰트, wasm)·pdf-lib·canvas·docx)이 없거나
  `src/`, `test/`, 소스맵, 빌드 도구가 들어간 경우
* **패키지 안의 의존성 트리**가 깨진 경우: 앱과 패키지에 든 모든 패키지의 `dependencies`(설치된 `optionalDependencies` 포함)를
  Node 방식으로 패키지 안에서 찾아, 없거나 선언 범위 밖 버전이면 실패(타입 전용 `@types/*`, `undici-types`는 제외).
  실험용 우회 `ORBITDROP_ALLOW_DEPENDENCY_MISMATCH=1`(경고로 낮춤, 배포용 아님)
* 대상 OS/아키텍처의 sharp `.node`, libvips, canvas `.node`가 없거나 아키텍처가 다른 경우
* helper가 없거나, 실행 권한이 없거나(macOS), 다른 아키텍처인 경우
* Windows 바이너리가 Visual C++ 재배포 패키지나 MinGW 런타임 DLL(`vcruntime140.dll`,
  `msvcp140*.dll`, `libstdc++-6.dll` 등)을 옆에 두지 않고 import하는 경우, 또는 디버그 CRT를 쓰는 경우
* `THIRD_PARTY_LICENSES.md`, `LICENSE.electron.txt`, `LICENSES.chromium.html`이 빠진 경우

**C++ 런타임 정책(Windows)**: 설치 프로그램은 VC++ 재배포 패키지를 설치하지 않는다. helper는 CRT를
정적 링크(`/MT`)하거나 필요한 DLL을 helper 옆에 app-local로 둔다. UCRT(`api-ms-win-crt-*`)는
Windows 10/11에 포함되어 있어 허용한다. 훅이 PE import 표를 읽어 이 정책을 강제한다.

## 4. macOS: 서명 · hardened runtime · 공증

| 모드 | 조건 | 서명 | 공증 | 산출물 이름 |
|---|---|---|---|---|
| 미서명(로컬/CI 기본) | `CSC_LINK`/`CSC_NAME` 없음 또는 `--unsigned` | ad-hoc(`-`) + hardened runtime | 안 함 | `…-unsigned.dmg` |
| Developer ID 서명 | `CSC_LINK`(+`CSC_KEY_PASSWORD`) 또는 키체인의 `CSC_NAME` | Developer ID Application(앱; `CSC_NAME`이면 DMG도) | `APPLE_*`가 있으면 notarytool(앱; `CSC_NAME`이면 DMG도 공증·staple) | `….dmg` |

* ad-hoc 서명은 신원 증명이 아니다. Apple Silicon에서 실행에 필요한 최소 서명일 뿐이며,
  인터넷에서 내려받은(격리 속성이 붙은) 미서명 앱은 Gatekeeper가 차단한다(`spctl`: rejected).
  미서명 빌드는 **로컬 테스트 전용**이며 배포하지 않는다. Gatekeeper를 끄거나 격리 속성을 지우라고
  사용자에게 안내하지 않는다.
* `package.mjs`는 미서명 모드에서 `CSC_IDENTITY_AUTO_DISCOVERY=false`로 키체인 인증서 자동 선택을
  막고, `mac.notarize=false`, `build/entitlements.mac.adhoc.plist`를 적용한다. PR CI에서도 ad-hoc
  서명이 건너뛰어지지 않게 `CSC_FOR_PULL_REQUEST=true`를 설정한다(자격 증명이 전혀 관여하지 않으므로 안전).
* **네이티브 드래그 helper**(`Contents/Resources/helper/OrbitDropHelper`, 번들 ID `io.github.keilvher1.orbitdrop.helper`):
  [`build/sign.cjs`](../apps/desktop/build/sign.cjs)(`mac.sign`)가 electron-builder 기본 서명과 같은 osx-sign 호출에서 helper만
  **entitlements 없이**(빈 사전 [`build/entitlements.helper.plist`](../apps/desktop/build/entitlements.helper.plist)) hardened runtime으로
  서명한다. Electron용 상속 entitlements는 적용하지 않는다. Developer ID 서명에서는 osx-sign이 모든 파일에 보안 타임스탬프
  (`--timestamp`)를 붙이므로 helper는 Developer ID + hardened runtime + 보안 타임스탬프가 된다. helper는 JIT를 쓰지 않고 시스템
  프레임워크와 OS의 Swift 런타임만 링크하므로 ad-hoc 빌드에서도 entitlements가 필요 없다. `package.mjs`가 서명 후 helper의
  entitlements가 비어 있고 hardened runtime인지 확인한다. 공증은 앱 전체(helper 포함)를 대상으로 한다.
* **Entitlements** (필요한 것만):
  * `com.apple.security.cs.allow-jit` — V8(main, renderer, utilityProcess)의 JIT. 앱과 Electron 하위 코드.
  * `com.apple.security.cs.disable-library-validation` — **ad-hoc 빌드의 앱과 Electron 하위 코드에만**. Team ID가 없는
    ad-hoc 코드끼리는 hardened runtime의 라이브러리 검증을 통과하지 못하기 때문. Developer ID 빌드에서는 모든 중첩 코드
    (Electron Framework, `.node`, `libvips-cpp.dylib`)가 같은 Team ID로 서명되므로 쓰지 않는다.
  * App Sandbox는 쓰지 않는다(드래그한 파일 옆에 결과를 쓰는 동작과 맞지 않음, Mac App Store 비대상).
  * 손쉬운 사용/입력 모니터링은 entitlement가 아니라 TCC 권한이다 → [permissions.md](permissions.md).
* **Info.plist** (`mac.extendInfo`, `package.mjs`가 검사):
  * `LSUIElement=true`(메뉴 막대 앱, Dock 아이콘 없음; main도 `app.dock.hide()`), `LSMinimumSystemVersion=14.0`
    (ADR-10, helper도 minos 14.0), `LSApplicationCategoryType=public.app-category.utilities`,
    `NSHumanReadableCopyright`(`copyright`), `CFBundleIdentifier`=appId.
  * Electron 템플릿의 권한 설명(`NSCamera…`, `NSMicrophone…`, `NSBluetoothAlways…`, `NSBluetoothPeripheral…`,
    `NSAudioCapture…UsageDescription`)은 지운다: OrbitDrop은 모든 권한 요청을 거부하고(`src/main/security.ts`) hardened runtime에
    장치 entitlement도 없다. 남아 있으면 `package.mjs`가 실패시킨다.
  * `NSAppTransportSecurity`(`NSAllowsArbitraryLoads`, localhost 예외)는 electron-builder가 항상 넣는다(electron-updater용: Squirrel.Mac이
    electron-updater의 127.0.0.1 서버에서 내려받은 업데이트를 가져간다). Apple의 URL 로딩 API에만 적용되고 Chromium 네트워크에는 영향이
    없다. OrbitDrop의 네트워크 사용은 업데이트 확인(§9)과, 사용자가 직접 켠 경우의 Claude 분석(§10)뿐이다.
  * Electron 하위 앱(`OrbitDrop Helper*.app`)의 `CFBundleName`은 electron-builder가 "Electron Helper …"로 남긴다(실행 파일 이름과
    표시 이름은 OrbitDrop Helper …). 보이는 곳이 없어 그대로 둔다.

### 서명·공증하기

릴리스용 패키지는 소유자의 Mac에서 `node scripts/release-mac.mjs <tag>`로 만든다([RELEASING.md](RELEASING.md) — Developer ID 개인 키가
로그인 키체인을 떠나지 않는다). 직접 실행하려면:

1. 로그인 키체인에 "Developer ID Application" 인증서가 있어야 한다.
2. `CSC_NAME="Your Name (TEAMID)"`(접두어 없이), 공증(권장: App Store Connect API 키)
   `APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<key id>.p8 APPLE_API_KEY_ID=<key id> APPLE_API_ISSUER=<issuer uuid>`
   — 또는 `APPLE_KEYCHAIN_PROFILE`(notarytool 키체인 프로필), 또는 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
   실제 값은 환경 변수로만 주고 저장소에 쓰지 않는다.
3. `node scripts/package.mjs mac --arch all --require-signing --require-notarization`. electron-builder가 앱(helper 포함)을 서명·공증하고
   staple한다. 이어서 [`scripts/mac-dmg.mjs`](../scripts/mac-dmg.mjs)가 **DMG마다** 같은 신원으로 서명(`codesign --timestamp`) →
   `xcrun notarytool submit --wait` → `xcrun stapler staple` → `spctl -a -t open --context context:primary-signature -v`(accepted, Notarized
   Developer ID)·`xcrun stapler validate`로 확인하고 build report의 `dmgNotarization`에 적는다. staple은 DMG 바이트를 바꾸므로 크기와
   SHA-256은 그 뒤에 계산하며, `latest-mac.yml`은 DMG를 가리키지 않는다(업데이트는 zip). DMG 서명에는 키체인의 신원(`CSC_NAME`)이 필요하다:
   `CSC_LINK` 인증서는 electron-builder의 임시 키체인에만 있다가 빌드가 끝나면 사라진다(그러면 DMG는 공증하지 않고 이유를 report에 적으며,
   `--require-notarization`은 실패한다). notarytool 자격 증명 값은 출력에 `***`로만 나온다.
4. CI에서 만들려면 macOS 서명·공증 시크릿을 모두 넣는다(RELEASING.md 부록: 워크플로가 인증서를 임시 키체인에 넣고 `CSC_NAME`으로 빌드).
   시크릿이 없으면 Release 워크플로는 macOS 작업을 건너뛰고 로컬 빌드를 안내한다.
5. 확인(`release-mac.mjs`가 모두 한다): `codesign --verify --deep --strict --verbose=2 OrbitDrop.app`,
   `spctl --assess --type execute -vv OrbitDrop.app`(accepted, source=Notarized Developer ID), `xcrun stapler validate OrbitDrop.dmg`,
   `spctl -a -t open --context context:primary-signature -v OrbitDrop.dmg`, 격리 속성을 붙인 사본으로 `syspolicy_check distribution`.

## 5. Windows: NSIS 설치 프로그램 · Authenticode · SmartScreen

* **사용자별 설치**: `oneClick: false`, `perMachine: false`, `allowElevation: false` +
  [`build/installer.nsh`](../apps/desktop/build/installer.nsh)의 `customInstallMode`로 "현재 사용자" 모드를 강제(설치 대상
  선택 페이지 없음; NSIS 매크로 이름은 대소문자를 가리지 않아 템플릿의 `!ifmacrodef customInstallmode`와 맞는 것을 makensis로
  확인). `RequestExecutionLevel user` → UAC 프롬프트 없음. 기본 위치 `%LOCALAPPDATA%\Programs\OrbitDrop`,
  디렉터리 페이지에서 변경 가능(관리자 권한이 필요한 폴더를 고르면 설치가 실패할 수 있다 — 권한 상승은 하지 않는다).
  고른 경로에 `OrbitDrop`이 없으면 설치 프로그램이 `\OrbitDrop` 하위 폴더를 붙인다.
* 시작 메뉴·바탕 화면 바로가기(AppUserModelID = appId), 제거 프로그램(`Uninstall OrbitDrop.exe`, HKCU 제거 항목,
  GUID는 appId에서 만들어진다).
* **제거가 지우는 것**: 설치 폴더 전체(`RMDir /r` — 설치 폴더에 다른 파일을 두지 않는다), 바로가기, HKCU 제거 항목과 설치 정보,
  그리고 "로그인 시 실행"을 켰다면 남는 시작 항목(`HKCU\…\CurrentVersion\Run`과 `…\Explorer\StartupApproved\Run`의 appId 값;
  `installer.nsh`의 `customUnInstall`, 새 버전 설치가 이전 버전을 `--updated`로 제거할 때는 남긴다).
  **남기는 것**: 사용자 데이터 `%APPDATA%\OrbitDrop`(설정 `settings.json`, 작업 기록 `history.json`, `logs\main.log`, Chromium
  캐시; `deleteAppDataOnUninstall: false`). 함께 지우려면 폴더를 직접 지우거나 `"…\Uninstall OrbitDrop.exe" --delete-app-data`로 실행한다.
  원본·결과 파일은 사용자 폴더에 있으므로 제거와 무관하다.
* 설치 언어: 한국어(기본) / 영어.
* 무인 설치/제거(테스트용): `OrbitDrop-…-setup.exe /S /D=C:\경로`, `"…\Uninstall OrbitDrop.exe" /S`.
  CI는 `--install-test`로 이를 자동 검사한다.
* **C++ 런타임**: helper는 `/MT`(정적 CRT, CMake 프리셋 `msvc-x64`). 함께 들어가는 sharp(`sharp-win32-x64-0.35.5.node`,
  `libvips-42.dll`, `libvips-cpp-8.18.7.dll`)와 `skia.win32-x64-msvc.node`의 import 표에도 VC++ 재배포 DLL이 없다(npm 배포본을
  after-pack 판별기로 확인, UCRT `api-ms-win-crt-*`만 사용). Electron의 `electron.exe`도 마찬가지.
* **개인정보 안내와 업데이트 확인 선택(설치 프로그램)**: 대화형 설치는 폴더 페이지 다음에 짧은 안내 페이지를 보여 준다
  ([`build/installer.nsh`](../apps/desktop/build/installer.nsh)의 `customPageAfterChangeDir`, nsDialogs, 설치 프로그램 언어에 맞춰
  한국어/영어): 파일은 이 컴퓨터에서만 처리, 업데이트 자동 확인이 GitHub에 연결하는 때와 GitHub이 받는 정보, 개인정보 처리방침
  링크(`/privacy/`, `/en/privacy/`), 그리고 **"업데이트 자동 확인 / Check for updates automatically"** 상자(기본 선택).
  선택은 설치 폴더의 `installer-preferences.json`(`{"version":1,"updates":{"autoCheck":true|false}}`)에 기록되고, 앱은 **첫 실행에만**
  (설정 파일이 아직 없을 때) 이를 읽어 `updates.autoCheck`를 정한다. 이미 있는 설정은 절대 덮어쓰지 않고, 결과는 로그에 남긴다
  ([`installer-preferences.ts`](../apps/desktop/src/main/settings/installer-preferences.ts)). 무인 설치(`/S`)는 기본값(켬)을 쓰며
  `/NOUPDATECHECK`로 끌 수 있다: `OrbitDrop-<ver>-win-x64-setup.exe /S /NOUPDATECHECK`. 앱이 설치하는 업데이트(`--updated`, 무인)는
  페이지를 건너뛴다. 제거 프로그램이 설치 폴더째 지우므로 파일도 함께 사라진다. 환영 창(모든 OS)과 설정 › 일반에도 같은 스위치가 있다.
  `--install-test`가 `/S`(켬)와 `/S /NOUPDATECHECK`(끔), 제거 후 파일 삭제를 확인하고, windows-gui 워크플로가 실제 설치 화면에서 상자를
  해제해 첫 실행이 끔으로 시작하는지 확인한다.
* **버전 정보(직접 만드는 실행 파일 네 개)**: `OrbitDrop.exe`, `resources\helper\OrbitDropHelper.exe`, 설치 프로그램, 제거
  프로그램(`Uninstall OrbitDrop.exe`)은 모두 ProductName `OrbitDrop`, ProductVersion = `apps/desktop/package.json`의 버전(프리릴리스
  접미사 포함)을 가진다(SignPath Foundation 조건: 제품 이름 = 프로젝트 이름, 한 빌드의 모든 파일에 같은 제품 버전). electron-builder는
  `OrbitDrop.exe`의 ProductVersion 문자열을 `x.y.z.0`으로 쓰므로, 서명 훅
  [`scripts/win-sign.cjs`](../scripts/win-sign.cjs)(`win.signtoolOptions.sign`, electron-builder가 서명할 파일마다 부른다)가 그 문자열을
  릴리스 버전으로 고친다. helper는 CMake의 `ORBITDROP_VERSION_STRING`(VERSIONINFO 문자열, `scripts/set-version.mjs`가 함께 바꾼다)을 쓴다.
  `package.mjs`가 PowerShell `(Get-Item …).VersionInfo`와 `Get-AuthenticodeSignature`로 네 파일을 읽어(제거 프로그램은 훅이 남긴 사본)
  하나라도 다르거나 서명 상태가 빌드 방식과 맞지 않으면 실패시키고, build report의 `signatures`에 남긴다
  ([`scripts/win-files.mjs`](../scripts/win-files.mjs)). 설치 시험은 설치된 파일을 다시 확인한다.
* **서명**: SignPath Foundation(아래)을 쓰기로 했다. 그 밖에 `WIN_CSC_LINK`(또는 `CSC_LINK`) + `WIN_CSC_KEY_PASSWORD`가 있으면
  서명 훅이 electron-builder의 signtool 호출을 그대로 실행해 exe·제거 프로그램·설치 프로그램에 Authenticode 서명한다(인증서를 산 경우;
  SignPath가 설정되어 있으면 쓰지 않는다). Azure Trusted Signing을 쓰려면
  `win.azureSignOptions`(endpoint, certificateProfileName, codeSigningAccountName)를 설정하고
  `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`을 제공한다(아직 설정하지 않음).
* **SmartScreen**: 미서명이거나 평판이 쌓이지 않은 인증서로 서명된 설치 프로그램은 "Windows의 PC 보호"
  경고가 뜰 수 있다. 미서명 빌드는 테스트용이며, SmartScreen을 끄라고 안내하지 않는다.

### Windows 코드 서명 (SignPath Foundation)

**왜 SignPath Foundation인가**: 오픈 소스 프로젝트에 무료로 코드 서명 인증서(SignPath Foundation 명의)와 서명 서비스(SignPath.io)를
준다. 개인 키는 SignPath의 하드웨어 보안 모듈에만 있어 소유자가 인증서를 사거나 키를 보관·갱신할 필요가 없고, 서명은 GitHub이 확인해 준
빌드 출처(이 저장소, 태그, 커밋, 워크플로 실행)와 사람의 승인을 거쳐서만 일어난다. Windows가 보여 주는 게시자는 **SignPath Foundation**이다.
조건(<https://signpath.org/terms>, 2026-11 확인): OSI 라이선스(상업 이중 라이선스 없음 — MIT), 공개·문서화된 릴리스, 모든 팀원의
GitHub·SignPath 다단계 인증, 홈페이지·다운로드·릴리스 페이지의 "Code signing policy"(아래 웹페이지), 사용자가 지정하지 않은 곳에 보내는
기능의 개인정보 안내·설치 중 표시·설치 옵션(위), 자기 소스로 빌드한 파일만 서명(상위 프로젝트의 DLL은 서명 없이 포함 가능), 파일 메타데이터
제한(제품 이름·버전), 릴리스마다 승인자의 수동 승인.

**웹페이지**: [`site/code-signing-policy/`](../site/code-signing-policy/index.html)와 [`site/en/code-signing-policy/`](../site/en/code-signing-policy/index.html)
(다운로드 영역·바닥글·FAQ·릴리스 노트에서 링크). 지금은 "아직 서명 안 됨, 신청함"을 말하는 상태 줄(`<p class="status" data-state="pending">`)
하나와 그 아래의 SignPath 문구로 되어 있다. **첫 서명 릴리스를 공개할 때 각 페이지에서 그 한 줄만 바꾼다**: 바로 위 주석에 바꿀 줄이 있다
(`data-state="active"`, "OrbitDrop 1.0.1부터 Windows 릴리스는 아래 방식으로 서명합니다." / "since OrbitDrop 1.0.1, Windows releases are
signed as described below."). 같은 때 홈페이지 FAQ "Windows 판은 왜 베타인가요?"와 README의 "아직 코드 서명 없음" 문장도 고친다.

**서명하는 것 / 하지 않는 것**: `OrbitDrop.exe`, `OrbitDropHelper.exe`, 제거 프로그램, 설치 프로그램만. Electron의 DLL(`ffmpeg.dll`,
`d3dcompiler_47.dll`, `dxcompiler.dll`, `dxil.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`), sharp/libvips(`sharp-win32-x64-<ver>.node`,
`libvips-42.dll`, `libvips-cpp-<ver>.dll`), `@napi-rs/canvas`의 `skia.win32-x64-msvc.node`는 상위 프로젝트 배포본 그대로 둔다.
electron-builder도 이 파일들에는 서명 훅을 부르지 않는다(`signExts` 없음: `.exe`만).

**흐름**(`.github/workflows/release.yml`의 Windows 작업, SignPath가 설정되어 있고 실행이 태그 자체일 때):

| 단계 | 하는 일 |
|---|---|
| `package.mjs win --signpath prepare` | 보통 빌드(앱 폴더 + 버리는 설치 프로그램), 모든 검사와 smoke test·네이티브 모듈 검사. 서명 훅이 남긴 제거 프로그램과 함께 `OrbitDrop.exe`·`OrbitDropHelper.exe`를 `release/signpath/request-1/`에 둔다 |
| 요청 1 | `actions/upload-artifact`로 올린 산출물(ZIP)을 [`signpath/github-action-submit-signing-request@v3`](https://github.com/SignPath/github-action-submit-signing-request)가 아티팩트 구성 `windows-binaries`로 보내고 승인·서명을 기다린다(최대 90분) |
| `--signpath installer --signed …/signed-1` | 돌아온 파일마다 "보낸 파일 + 서명"인지(서명이 바꾸는 PE 체크섬·인증서 표 항목 밖의 모든 바이트가 같은지), 서명 Valid·버전 정보를 확인하고 앱 폴더에 넣는다. electron-builder가 그 폴더로 설치 프로그램을 만들고(`--prepackaged`), NSIS가 다시 만든 제거 프로그램 대신 서명된 사본을 넣는다(서명 훅이 같은 파일 + 서명인지 확인). 설치 프로그램을 `request-2/`에 둔다 |
| 요청 2 | 아티팩트 구성 `windows-installer`로 설치 프로그램 서명 |
| `--signpath finish --signed …/signed-2 --install-test` | 서명된 설치 프로그램으로 바꾸고 `latest.yml`의 sha512·크기를 다시 계산(`refreshUpdateInfo`), 네 파일 모두 서명 Valid를 요구하는 전체 검사, smoke test, 설치 시험, build report. 파일 이름에 `-unsigned`가 붙지 않는다 |

제거 프로그램이 요청 1에 들어가는 이유: electron-builder의 NSIS 대상은 제거 프로그램을 먼저 만들어 서명 훅에 넘긴 뒤 설치 프로그램 안에
넣는다. NSIS는 SignPath가 안쪽까지 서명하는(deep signing) 형식이 아니므로 설치 프로그램을 만든 뒤에는 제거 프로그램을 서명할 수 없다.
서명 훅이 그 순간 SignPath REST API를 부르는 방법은 쓰지 않았다: Foundation 프로젝트에는 출처 검증이 필수이고(Open Source Code Signing:
origin verification required), SignPath의 GitHub 연동은 GitHub 작업 산출물과 공식 action이 전하는 GitHub의 실행 정보로 출처를 확인하는데,
빌드 도구 안에서 보내는 요청에는 그 정보가 없다. 그래서 prepare 단계의 NSIS 실행에서 제거 프로그램을 받아 실행 파일들과 함께 서명하고,
installer 단계에서 같은 제거 프로그램(서명만 더해진)을 넣는다.

**시험(리허설)**: SignPath 자격 증명 없이 같은 단계를 GitHub 러너에서 돌린다 — Actions › Release › Run workflow, `tag`는 비우고
`signpath_rehearsal`을 켠다(`gh workflow run Release --ref <branch> -f signpath_rehearsal=true`). SignPath action 대신
[`scripts/signpath-rehearsal.ps1`](../scripts/signpath-rehearsal.ps1)이 그 러너만 신뢰하는 임시 자체 서명 인증서로 서명한다. 산출물은
`-rehearsal`로 표시되고 릴리스에 올라가지 않는다(`release-assets.mjs`도 거부). SignPath 쪽 설정(승인, 아티팩트 구성, 출처 검증)은 실제
릴리스에서만 확인된다.

**업데이트와 게시자**: electron-builder가 인증서를 직접 보지 않으므로 `app-update.yml`에 게시자 이름(`publisherName`)이 들어가지 않는다.
설치본은 지금처럼 HTTPS로 받은 `latest.yml`의 sha512로 설치 프로그램을 확인한다(미서명 → 서명 전환에 문제없음). 업데이트를
"SignPath Foundation이 서명한 설치 프로그램만"으로 묶으려면 나중에 `win.signtoolOptions.publisherName: SignPath Foundation`을 따로
결정한다(그 뒤 다른 인증서로 바꾸면 그 설치본들은 업데이트를 받지 못한다).

**소유자가 할 일(순서대로)** — 비밀 값은 저장소·문서에 쓰지 않는다:

1. GitHub 계정에 2단계 인증이 켜져 있는지 확인한다(Settings › Password and authentication).
2. <https://signpath.org/apply>에서 신청한다: 저장소 `https://github.com/keilvher1/orbitdrop`, 라이선스 MIT, 홈페이지
   `https://keilvher1.github.io/orbitdrop/`, 코드 서명 정책 `https://keilvher1.github.io/orbitdrop/en/code-signing-policy/`, 릴리스
   `https://github.com/keilvher1/orbitdrop/releases`, 서명할 파일(위 네 개)과 빌드 방법(GitHub Actions, GitHub 호스팅 러너, 태그 빌드).
   승인 메일을 기다린다.
3. SignPath(<https://app.signpath.io>) 계정을 만들고 다단계 인증을 켠다. 승인 안내에 따라 OrbitDrop 프로젝트가 있는 조직에 들어간다.
4. SignPath에서:
   * **Trusted Build Systems**: 미리 정의된 **GitHub.com**을 조직에 추가하고 OrbitDrop 프로젝트에 연결한다.
   * **프로젝트**: 저장소 URL `https://github.com/keilvher1/orbitdrop`. 프로젝트 슬러그를 적어 둔다.
   * **Artifact Configurations**: 두 개를 만든다 — 슬러그 `windows-binaries`에
     [`apps/desktop/build/signpath/windows-binaries.xml`](../apps/desktop/build/signpath/windows-binaries.xml), 슬러그
     `windows-installer`에 [`windows-installer.xml`](../apps/desktop/build/signpath/windows-installer.xml)을 붙여 넣는다(워크플로가 이
     슬러그로 고른다. 매개변수 `version`은 워크플로가 넘긴다).
   * **Signing Policy**(Foundation의 릴리스 정책, 예: `release-signing`): 승인자 keilvher1, 승인 필수, 출처 검증(Verify origin) 켬, 허용
     브랜치/태그는 릴리스 태그(`v*`)로 제한할 수 있으면 제한한다. GitHub 파이프라인 정책을 쓸 수 있으면
     `github-build-policies: { version: '1.0', runners: { require_github_hosted: true } }`(재실행을 막으려면 `disallow_reruns: true`).
     정책 슬러그를 적어 둔다.
   * **API 토큰**: 그 정책에 제출(Submitter) 권한이 있는 사용자(가능하면 CI 전용 사용자)의 API 토큰을 만든다. 조직 ID를 적어 둔다.
5. GitHub 저장소 Settings › Secrets and variables › Actions: 시크릿 `SIGNPATH_API_TOKEN`, 변수 `SIGNPATH_ORGANIZATION_ID`,
   `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`. 넷이 모두 있어야 켜지고, 하나라도 없으면 Windows 작업은 지금과 같다(일부만 있으면
   경고). `WIN_CSC_LINK`가 함께 있어도 SignPath가 우선한다.
6. (권장) 리허설을 한 번 돌린다(위).
7. 첫 서명 릴리스(1.0.1): [RELEASING.md](RELEASING.md)대로 버전을 올리고 태그를 push한다. Release 워크플로의 Windows 작업이 요청 1을
   보내면 SignPath에서 승인하고, 몇 분 뒤 요청 2도 승인한다. 초안의 `OrbitDrop-1.0.1-win-x64-setup.exe`(이름에 `-unsigned` 없음)를
   내려받아 서명(Valid, SignPath Foundation)을 확인하고 공개한 뒤, 웹페이지의 상태 줄(위)을 바꾼다.

## 6. 미서명 빌드 표시

미서명 빌드는 (1) 파일 이름에 `-unsigned`, (2) DMG 볼륨 이름에 `(unsigned)`, (3) `build-report-*.json`의
`signing.mode`로 표시된다. `-incomplete`는 helper 또는 smoke test 구현이 빠진 파이프라인 시험 빌드다.
배포 전 체크리스트:

- [ ] `--require-signing`으로 빌드했고(Windows는 SignPath 단계) `build-report`의 `signing.mode`가 Developer ID / Authenticode /
      Authenticode (SignPath), Windows는 `signatures.ok`(네 실행 파일 모두 Valid, 같은 제품 이름·버전)
- [ ] macOS: `--require-notarization`으로 빌드, 앱·DMG 모두 `spctl` accepted(Notarized), `stapler validate` 통과
- [ ] `latest-mac.yml`(arm64·x64 zip)·`latest.yml`이 릴리스 파일과 일치(`package.mjs`·릴리스 스크립트가 검사) — [RELEASING.md](RELEASING.md) 5단계
- [ ] smoke test와 [verification.md](verification.md)의 수동 GUI 검증 결과 기록(설치본에서 창이 실제로 그려지는지 포함)
- [ ] `THIRD_PARTY_LICENSES.md`가 최신(`node scripts/licenses.mjs --check`)
- [x] LGPL/MPL 구성요소의 소스 제공 방법: 릴리스마다 대응 소스 묶음을 함께 공개(아래 "LGPL·MPL 소스 제공", 2026-11-12 결정)
- [ ] 패키지와 같은 소스 커밋에서 `node scripts/third-party-sources.mjs`로 만든 `OrbitDrop-<ver>-third-party-sources.tar.gz`를
  설치 파일과 같은 GitHub 릴리스에 올림
- [x] OrbitDrop 자체 라이선스: MIT(루트 `LICENSE`, 2026-11-12). 제품명 OrbitDrop, 제품 ID 확정(아래 "제품 ID")

## 제품 ID

제품 ID는 **`io.github.keilvher1.orbitdrop`**(2026-11-12 확정, 공개 저장소 `github.com/keilvher1/orbitdrop`과 웹페이지
`keilvher1.github.io/orbitdrop`을 거꾸로 쓴 이름)이고 다시 바꾸지 않는다. 쓰이는 곳:

| 위치 | 쓰임 |
|---|---|
| `apps/desktop/electron-builder.yml`의 `appId` | macOS `CFBundleIdentifier`(Electron 하위 앱은 `<appId>.helper…`), Windows NSIS 제거 항목 GUID, 바로가기 AppUserModelID |
| `apps/desktop/src/main/index.ts`의 `app.setAppUserModelId(…)` | Windows 알림·작업 표시줄 묶음·로그인 시 실행 레지스트리 값 이름. **`package.mjs`가 빌드된 main 번들의 값과 appId가 다르면 실패시킨다** |
| `native/macos/Support/Info.plist`, `scripts/build-native-mac.mjs`의 `BUNDLE_ID` (`io.github.keilvher1.orbitdrop.helper`) | macOS 드래그 helper의 번들 ID·서명 식별자 |

공개 전 0.1.0 시험 빌드는 임시 ID `app.orbitdrop.desktop`(helper `com.orbitdrop.helper`)를 썼다. 그 빌드를 설치했던 Mac에서는
새 빌드가 다른 앱으로 취급된다. 데이터 폴더 `~/Library/Application Support/OrbitDrop`은 제품명을 따르므로 그대로 쓰이고,
"로그인 시 실행"은 설정에서 다시 켜야 할 수 있다.

ID를 바꾸면: Windows에서는 제거 항목 GUID와 설치 정보 키가 달라져 새 버전이 이전 설치를 찾지 못한다(제거 항목이 둘이 됨, 이전
설치 폴더 경로를 이어받지 못함). macOS에서는 손쉬운 사용·입력 모니터링 허용과 로그인 항목이 새 ID로 다시 필요하다. 사용자 데이터
폴더 이름은 제품명(`OrbitDrop`)을 따르므로 ID만 바꾸면 그대로다.

## LGPL·MPL 소스 제공

**결정(2026-11-12): 릴리스마다 대응 소스를 함께 공개한다.** 설치본에는 **LGPL** 구성요소(libvips와, 그 안에 정적으로 든
glib·pango·fribidi·libexif·libheif·librsvg·proxy-libintl — macOS `libvips-cpp.<ver>.dylib`, Windows `libvips-42.dll`·`libvips-cpp-<ver>.dll`;
Electron의 FFmpeg `libffmpeg.dylib` / `ffmpeg.dll`)와 **MPL** 구성요소(libvips 안의 cairo MPL-1.1, librsvg·@napi-rs/canvas에 정적 링크된
MPL-2.0 크레이트 cssparser·cssparser-color·cssparser-macros·dtoa-short·selectors)가 있다. 모두 업스트림 배포본을 수정하지 않고 쓴다.
LGPL(LGPL-2.1 §6 / GPL-3.0 §6)은 바이너리를 배포하는 쪽에 대응 소스를 제공할 책임을 지우고, 이 책임은 업스트림 서버가 사라져도 남으므로
업스트림 링크만으로 두지 않는다.

* **배포 위치**: 각 GitHub 릴리스(https://github.com/keilvher1/orbitdrop/releases)에 설치 파일과 함께 자산
  **`OrbitDrop-<ver>-third-party-sources.tar.gz`** 를 올린다. 설치본에 든 `THIRD_PARTY_LICENSES.md` 머리말이 이 위치와, 그곳에서 받을 수
  없을 때의 서면 제공(written offer, 릴리스 후 3년, 요청 창구 https://github.com/keilvher1/orbitdrop/issues)을 알린다(§7).
* **교체**: libvips와 FFmpeg는 동적 링크된 별도 파일이므로 사용자가 수정한, 인터페이스가 호환되는 빌드로 바꿀 수 있다 — macOS
  `Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-<arch>/lib/`와
  `Contents/Frameworks/Electron Framework.framework/Libraries/libffmpeg.dylib`, Windows 설치 폴더의
  `resources\app.asar.unpacked\node_modules\@img\sharp-win32-x64\lib\`와 `ffmpeg.dll`. macOS에서는 교체 후 서명이 깨지므로
  `codesign --force --deep --sign - OrbitDrop.app`으로 ad-hoc 재서명해 실행한다. 이 방법은 묶음의 `MANIFEST.md`에도 적힌다.
* **만들기**: `node scripts/third-party-sources.mjs`(기본 `apps/desktop/release/`, `--out <dir>`). `--list`는 원본 아카이브를 내려받지
  않고 목록만 출력한다(CI 확인용; 태그의 빌드 스크립트·DEPS·체크섬 파일 같은 작은 메타데이터만 읽음). 정확한 버전으로 맞출 수 없는
  구성요소가 있거나 내려받은 파일이 공개된 SHA-256과 다르면 종료 코드 1이고 묶음을 쓰지 않는다. 내려받기는 Node `fetch`만 쓰고, 임시
  폴더에 받아 검증한 뒤 `apps/desktop/release/.third-party-cache/`(gitignore)에 보관한다 — 다시 실행하면 몇 초면 끝난다. 받은 것은
  실행하거나 디스크에 풀지 않는다(라이선스 파일과 빌드 설정만 메모리에서 읽음). `GITHUB_TOKEN`이 있으면 api.github.com 요청(릴리스 자산
  digest)에만 쓴다. 0.1.0 실측: 구성요소 18개, 원본 27개, 묶음 116.2 MB, 첫 실행 약 40초.
* **내용**: (1) libvips 8.18.7과 LGPL/MPL 라이브러리 8개의 업스트림 tarball, sharp-libvips `build/posix.sh`가 받아 적용하는 패치(glib,
  librsvg, libvips), 빌드 스크립트 — sharp-libvips v1.3.4(macOS), libvips/build-win64-mxe v8.18.7과 그 MXE 커밋(Windows `libvips-42.dll`),
  sharp 0.35.5와 `@img/sharp-libvips-dev` 1.3.4(Windows `libvips-cpp-<ver>.dll`은 sharp의 `src/binding.gyp`가 빌드); (2) Chromium FFmpeg
  (Electron 44.9.0의 Chromium 152.0.7977.167 `DEPS`가 고정한 리비전)과 Electron v44.9.0 소스(FFmpeg 패치 `patches/ffmpeg/`, GN 인자
  `ffmpeg_branding = "Chrome"`·`is_component_ffmpeg = true`); (3) static.crates.io의 MPL-2.0 `.crate`; (4) `MANIFEST.md`(구성요소, 버전,
  라이선스, 업스트림 URL, SHA-256, 검증 근거, 들어 있는 패키지·아키텍처), `SHA256SUMS`, 라이선스 원문.
* **무엇이 들어가는지는 계산한다**: 대상(`electron-builder.yml`) → 대상별 sharp 패키지의 `versions.json`과 canvas SBOM(이 OS에 설치되지
  않은 대상은 `pnpm-lock.yaml`의 integrity로 확인한 npm tarball) → 그 sharp-libvips 태그의 `build/posix.sh`가 받는 URL·패치와 `build/win.sh`가
  받는 build-win64-mxe 릴리스 → Electron `DEPS` → Chromium `DEPS`의 FFmpeg 리비전. 라이선스는 sharp-libvips 표·`licenses-sources.mjs`, SBOM,
  `docs/licenses/upstream`에서 온다. 손으로 적은 것은 Rust target triple, Electron 런타임 안 FFmpeg 경로, build-win64-mxe가 켜는 플러그인 목록뿐이다.
* **검증**: 공개된 SHA-256(GNOME·cairo `.sha256sum`, GitHub 릴리스 자산 digest, crates.io 인덱스, librsvg `Cargo.lock`, canvas SBOM, npm
  integrity)과 모두 같아야 하고, LGPL/MPL tarball은 Windows 빌드(MXE 패키지 정의)가 고정한 SHA-256과도 같아야 한다(두 OS가 같은 원본을
  씀). `@img/sharp-win32-x64`의 `libvips-42.dll`은 build-win64-mxe 릴리스 zip 안의 것과 바이트 단위로 같아야 하고, 쓰인 FFmpeg 설정
  (`chromium/config/Chrome/{mac,win}/<arch>/config.h`)은 GPL·version3·nonfree가 꺼져 있어야 한다. 공개된 해시가 없는 파일(GitHub 태그
  아카이브, googlesource 아카이브, 패치)은 내려받은 해시를 `MANIFEST.md`에 기록한다. googlesource는 아카이브를 요청마다 새로 만들어
  바이트가 달라질 수 있으므로 릴리스에 올린 묶음의 해시가 기준이다.
* **묶음에 없는 것**: Electron Framework에 정적으로 든 나머지 Chromium의 LGPL/MPL 코드(Blink의 WebKit 유래 부분, hunspell, url_parse 등).
  대응 소스는 Chromium 152.0.7977.167 태그와 Electron 패치(묶음의 Electron 소스)인데 수 GB라 미러하지 않고 서면 제공으로 덮는다. libvips에
  정적으로 든 허용형 라이브러리(aom, harfbuzz, libpng 등)는 `MANIFEST.md`에 버전과 원본 URL만 적는다(소스 제공 의무 없음).
* **sharp·@napi-rs/canvas·Electron을 올리면**: §7 순서로 라이선스 스냅숏을 먼저 갱신하고(`librsvg-crates.json` 포함) 이 스크립트를 다시
  실행한다. 빌드 방식이 바뀌어 맞출 수 없는 구성요소가 생기면 스크립트가 실패하므로 그때 스크립트를 고친다.

## 7. 제3자 라이선스 목록

`node scripts/licenses.mjs`가 [`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md)를 만든다(`--check`: 최신인지 확인, CI에서 실행;
네트워크를 쓰지 않음). 범위:

* `apps/desktop`의 운영 의존성 트리(앱의 `node_modules`)와 각 패키지의 LICENSE/NOTICE 원문;
* 번들에 들어가는 런타임 라이브러리(React, lucide-react 등 `devDependencies` 중 빌드 도구가 아닌 것과 워크스페이스 패키지의 의존성);
* 대상별 네이티브 패키지(sharp/libvips/canvas의 darwin-arm64·darwin-x64·win32-x64);
* **다른 패키지의 배포 파일에 이미 컴파일되어 들어 있는 npm 패키지** — docx의 `dist`(buffer, ieee754, events, jszip 등 45개)와
  pdf.js legacy 빌드의 core-js. 배포 파일의 모듈 표시(`//#region node_modules/…`, `// MODULE: ./node_modules/…`)로 찾고,
  `electron-builder.yml`의 `files` 제외 규칙에서 빠지는 파일만 본다;
* Electron/Chromium(FFmpeg 포함), libvips와 그 라이브러리, librsvg에 링크된 Rust 크레이트, @napi-rs/canvas의 Skia·C/C++ 라이브러리·
  크레이트, Rust 표준 라이브러리, pdf.js의 폰트·CMap·wasm. LGPL-3.0/GPL-3.0 원문은 `docs/licenses/`(gnu.org 원본과 동일).

npm 패키지에 원문이 없는 구성요소의 라이선스 원문은 **`docs/licenses/upstream/`** 스냅숏에서 가져온다(파일마다 출처 URL과 SHA-256을
`index.json`에 기록, 줄 끝은 LF). 스냅숏은 `node scripts/licenses-fetch.mjs`(네트워크 읽기: GitHub/GitLab/googlesource 원본, npm·crates.io
tarball — 압축은 메모리에서 풀고 라이선스 파일만 쓴다)로 갱신해 커밋한다. librsvg가 링크하는 크레이트 목록은
`node scripts/licenses-fetch.mjs --librsvg-crates`(cargo 필요)가 librsvg 소스의 `cargo tree -p librsvg-c -e normal --locked`를 대상 3개
(aarch64/x86_64-apple-darwin, x86_64-pc-windows-gnullvm)에 대해 실행해 `docs/licenses/librsvg-crates.json`에 적는다(기본 기능 가정).
sharp·canvas·docx·pdf.js를 올리면 `licenses.mjs --check`가 "run node scripts/licenses-fetch.mjs"로 실패하므로 이 순서로 갱신한다:
`node scripts/licenses.mjs`(macOS, native-components.json 갱신) → 필요하면 `--librsvg-crates` → `node scripts/licenses-fetch.mjs` →
`node scripts/licenses.mjs`.

* 출력은 macOS와 Windows에서 같다. 각 체크아웃에는 자기 OS의 네이티브 패키지만 설치되므로, 대상별 패키지의 라이선스는
  스크립트의 고정 표(설치된 패키지와 대조)로, libvips 구성요소 표와 canvas SBOM은 darwin 패키지에서 갱신해 커밋하는
  `docs/licenses/native-components.json`으로 만든다(Windows 배포본의 versions.json·SBOM이 같은 내용임을 1.3.4 / 1.0.11에서 확인).
* 머리말의 "Source code of LGPL and MPL components" 절이 대응 소스의 위치(릴리스 자산 `OrbitDrop-<ver>-third-party-sources.tar.gz`)와
  서면 제공(3년, GitHub issues)을 알린다(위 "LGPL·MPL 소스 제공").
* 같은 원문(공백 무시)은 한 번만 싣고 이후에는 "same text as …"로 가리킨다. 패키지와 저장소 어디에도 원문이 없는 구성요소(block,
  objc_id, objc-foundation — MIT, selectors — MPL-2.0)는 메타데이터의 라이선스·저자와 표준 원문으로 표시한다.
* 새 런타임 의존성을 추가하면 다시 생성해 커밋한다. `package.mjs`는 패키징할 때마다 재생성하고, 앱에 `Resources/THIRD_PARTY_LICENSES.md`로 넣는다.

## 8. 로컬 검증 기록

실측 결과(명령과 출력)는 [verification.md §자동 검증 증거](verification.md#자동-검증-증거)에 있다.

## 9. 자동 업데이트

[electron-updater](https://www.electron.build/auto-update) 6.8.12(`apps/desktop` 의존성, 정확한 버전 고정)가 GitHub Releases
(`keilvher1/orbitdrop`)에서 업데이트를 받는다. 코드: [`apps/desktop/src/main/update/`](../apps/desktop/src/main/update/).

**동작**

* 확인: 실행 60초 뒤, 그 뒤 6시간마다(설정 › 일반 › "업데이트 자동 확인", 기본 켬). 잠자기에서 깨어났을 때 확인할 때가 지났으면 60초 뒤.
  정보 창의 "지금 확인"과 트레이의 "업데이트 확인…"은 자동 확인이 꺼져 있어도 동작한다.
* 새 버전이 있으면 바로 내려받고(`autoDownload`), **종료할 때 설치**한다(`autoInstallOnAppQuit`). 내려받기가 끝나면 시스템 알림 한 번
  ("OrbitDrop {version} 업데이트 준비 완료", 알림 설정을 따른다)과 트레이 항목 "재시작하여 업데이트". macOS에서는 Squirrel.Mac이
  업데이트를 받아들인(서명 확인) 뒤에야 "준비 완료"가 된다.
* **재시작해도 작업을 잃지 않는다**: 대기·실행 중인 작업(놓았지만 아직 확인·제출 중인 파일 포함), 열린 편집기나 형식 선택 창,
  진행 중인 드래그(휠)가 있으면 재시작을 미루고
  (`restartPending` — 정보 창과 트레이에 표시, 트레이에서 취소 가능) 모두 끝난 뒤 3초 동안 아무 일이 없을 때 재시작한다. 대화상자는
  띄우지 않는다(드래그 중 모달 없음). 아무것도 없으면 바로 재시작한다. Windows는 NSIS 설치 프로그램이 약 1초 뒤 실행 중인 앱을 강제로
  끝내므로 OrbitDrop이 먼저 정상 종료 절차(설정·기록 저장, 작업자 종료)를 마치고 넘긴다. 넘기기에 실패하면 지금 버전을 다시 시작한다.
* 확인·내려받기 실패(오프라인, GitHub 접속 불가, 그 밖)는 조용한 상태다: 정보 창의 한 줄과 로그(`logs/main.log`)뿐, 대화상자 없음.
  공개된 릴리스가 없거나 이 OS용 파일이 아직 없으면 "최신 버전입니다"로 본다. 5분 넘게 끝나지 않는 확인은 포기한다.
* 초안과 pre-release는 정식 버전에 제공되지 않는다(GitHub의 `releases/latest`). `-alpha.n`/`-beta.n` 설치본은 더 새 프리릴리스와
  정식 버전을 받는다. 그 밖의 프리릴리스 이름(`-rc.n` 등)은 electron-updater에서 별도 채널이라 같은 이름의 프리릴리스만 따라간다 —
  그래서 프리릴리스는 `-beta`로 낸다. 낮은 버전으로는 내려가지 않는다.
* electron-updater가 쓰는 Electron `net` 요청에는 자체 시간 제한이 없다: 5분 안에 끝나지 않는 확인이나 10분 동안 진행이 없는 내려받기는
  포기하고(오류 상태, 버튼은 다시 쓸 수 있음) 다음 확인은 새 업데이트 객체로 한다.

**네트워크와 개인정보** — 업데이트 확인은 OrbitDrop이 스스로 하는 유일한 네트워크 사용이다(그 밖에는 사용자가 켜고 쓰는 Claude 분석뿐, §10).

* 요청: `https://github.com/keilvher1/orbitdrop/releases.atom`, `…/releases/latest`, 그 릴리스의 `latest-mac.yml` 또는 `latest.yml`,
  새 버전이 있으면 해당 zip/설치 프로그램(GitHub가 자산 서버로 리디렉션; macOS는 두 번째 업데이트부터 이전 zip과의 차이만 받기 위해
  blockmap 두 개). User-Agent는 electron-updater 고정값(`electron-builder`)이고 쿠키는 보내지 않는다.
* electron-updater는 원래 설치마다 무작위 ID(`<userData>/.updaterId`)를 만들어 `x-user-staging-id` 헤더로 보내는데(단계적 배포용),
  OrbitDrop은 그 ID를 만들지도 보내지도 않는다([`privacy.ts`](../apps/desktop/src/main/update/privacy.ts), 실제 라이브러리로 테스트).
  GitHub에 전달되는 것은 IP 주소 같은 일반 접속 정보와 어느 OS·아키텍처의 업데이트 파일을 요청했는지뿐이다.
* electron-updater는 창들과 다른 자체 세션(`electron-updater` 파티션, 메모리 전용)으로 요청한다. 렌더러는 그대로 네트워크에 닿지 못한다
  (CSP `connect-src 'self'`, 원격 이미지 없음, 탐색·리디렉션·`window.open`·webview 차단 — `src/main/security.ts`; 오프라인 E2E가 창 세션의
  http(s) 요청 0을 확인). 업데이트를 지원하지 않는 실행은 electron-updater를 불러오지도 않는다.

**업데이트하지 않는 실행**(정보 창에 이유 표시, 요청 없음): 개발 실행(패키지 아님, E2E 포함), `--smoke-test`, Linux, `app-update.yml`이
없는 패키지, macOS에서 Developer ID 서명이 아닌 빌드(`build-info.json`의 `signing`이 `adhoc` — Squirrel.Mac은 실행 중인 앱과 같은 서명
요구 사항을 만족하는 업데이트만 설치하므로 ad-hoc 빌드는 절대 설치할 수 없다)나 빌드 정보가 없는 빌드, DMG 같은 읽기 전용 위치나
App Translocation에서 실행 중인 앱(번들을 바꿀 수 없다; 응용 프로그램 폴더로 옮기라고 안내), Windows에서 설치 프로그램으로 설치하지 않은
사본(옆에 `Uninstall OrbitDrop.exe`가 없음 — 예: `win-unpacked`).

**서명과 파일 이름**

* macOS 미서명(`-unsigned`) 패키지는 업데이트 대상도 원본도 아니다: 그런 설치본은 확인하지 않고, 릴리스에는 Developer ID + 공증된 패키지만
  올라간다(릴리스 스크립트가 build report로 확인). `latest-mac.yml`은 zip만 가리키므로 DMG를 staple해도 그대로 유효하다.
* Windows는 SignPath 서명이 시작될 때까지 미서명으로 배포하며 업데이트도 된다: 설치본은 HTTPS로 받은 `latest.yml`의 sha512로 설치 프로그램을
  확인한다. `latest.yml`은 electron-builder가 실제 파일 이름(`…-unsigned-setup.exe` 포함)으로 쓰고 `package.mjs`가 대조한다(SignPath가 서명한
  설치 프로그램은 finish 단계가 sha512·크기를 다시 쓴다). 인증서 파일(`WIN_CSC_LINK`)로 서명하면 `app-update.yml`에 게시자 이름(`publisherName`)이
  들어가 그 뒤 설치본은 같은 게시자가 서명한 설치 프로그램만 받는다. SignPath 서명에서는 들어가지 않는다(§5 "업데이트와 게시자").
* 파일 이름이나 형식을 바꾸면 `latest*.yml`과 어긋나지 않는지 `package.mjs`의 검사로 확인한다.

**설치본에 남는 것**: 내려받은 업데이트는 `~/Library/Caches/@orbitdropdesktop-updater`(macOS),
`%LOCALAPPDATA%\@orbitdropdesktop-updater`(Windows; NSIS 설치 프로그램도 차이 업데이트용 사본 `installer.exe`를 여기에 둔다)에 있고 지워도
된다(이름은 electron-builder가 `apps/desktop/package.json`의 `name`에서 만든다).

**시험**: 개발 실행과 미서명 빌드는 업데이트하지 않으므로, 끝까지 시험하려면 Developer ID 빌드와 pre-release 두 개를 쓴다
([RELEASING.md](RELEASING.md) 5단계). 단위 테스트: `apps/desktop/test/main/update-*.test.ts`(상태 기계·지원 판정·개인정보),
`tests/integration/release-scripts.test.ts`(메타데이터·공증·릴리스 스크립트, 가짜 실행기).

## 10. Claude 분석 (선택 기능 · 네트워크)

사용자가 설정 › Claude 분석에서 직접 켜고 자신의 Anthropic API 키를 저장했을 때만 쓰는 기능이다(기본으로 꺼짐, 백엔드·계정 없음).
휠의 "Claude 분석"에 이미지나 PDF를 놓으면 작업자가 그 파일을 Anthropic Messages API로 보내고, 답을 원본 옆
`<이름> Analysis.md`로 저장한다. 코드: `packages/processors/src/analyze/`, `apps/desktop/src/main/analysis/`.

**의존성** — [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) 1.8.0(Apache-2.0, 정확한 버전 고정)을
`packages/processors`와 `apps/desktop`의 `dependencies`에 둔다. 번들에 넣지 않고 `app.asar/node_modules`로 들어가며(작업자의 처리기와
main의 키 확인이 CommonJS 빌드를 `require`), 함께 들어가는 의존성은 `@opentelemetry/api`, `json-schema-to-ts`(+ `@babel/runtime`,
`ts-algebra`), `standardwebhooks`(+ `@stablelib/base64`, `fast-sha256`)다. SDK의 TypeScript 소스(`src/`), CLI(`bin/`), 타입 정의(`*.d.ts`)는
`electron-builder.yml`의 `files`에서 뺀다. after-pack 훅은 `node_modules/@anthropic-ai/sdk/package.json`과 `index.js`가 없으면 빌드를
실패시킨다. 라이선스: `node scripts/licenses.mjs`(THIRD_PARTY_LICENSES.md에 node_modules로 8개 패키지 추가).

**네트워크** — 요청은 `https://api.anthropic.com`으로만 간다. 클라이언트는 기본 URL을 고정하고(`ANTHROPIC_BASE_URL` 무시) 키를 직접
넘기며(환경 변수·프로필의 다른 자격 증명을 찾지 않음) 로그(`ANTHROPIC_LOG`)와 추적(OpenTelemetry)을 끈다. 작업자는 상속받은 `ANTHROPIC_*`
변수를 하나도 받지 않는다(`workerEnv`). 보내는 것: 이미지는 방향을 적용한 첫 프레임을 긴 변 1568px 이하로 줄인 사본(JPEG q85, 투명하면
PNG, 메타데이터 없음), PDF는 파일 그대로(100쪽·20MB 초과는 보내지 않음 — base64로 약 28MB, API 요청 한도 32MB 안, 암호 PDF는 `PDF_ENCRYPTED`), 파일 이름, 설정의 추가 요청,
보고서 언어(앱 언어). 한 번의 스트리밍 요청(`claude-opus-5-5`, `max_tokens` 16000, effort `medium`, 서버 측 거절 대체
`fallbacks: "default"`), SDK의 자동 재시도 2회. 설정의 "연결 확인"은 main에서 `models.retrieve`(무료)를 부른다. 요금은 키의 계정에 청구된다.
`ANALYSIS_*` 오류 코드로 실패를 알린다(429·연결/5xx/529는 작업 창에서 다시 시도 가능).

**키 보관** — 설정이 아니다. `<userData>/claude-api-key.json`(모드 0600, 원자적 쓰기)에 Electron `safeStorage`(macOS 키체인의 키,
Windows DPAPI) 암호문과 마지막 네 글자만 둔다. `isEncryptionAvailable()`이 false면(Linux의 `basic_text` 포함) 저장을 거부한다. 렌더러는
`{ hasKey, keyHint: '…abcd' }`만 받고, 키는 작업 시도마다 main이 복호화해 작업자의 `run` 메시지에 작업 **옆에**(`credentials`) 실어 보낸다 —
작업 객체·옵션·작업 기록·history.json·settings.json·로그·진단 정보·렌더러 오류 기록·IPC 응답에는 들어가지 않는다(`test/main/analysis-leak.test.ts`;
로그·오류 문구의 `sk-ant-…`는 마지막 방어선으로 가린다). 키는 요청하는 동안만 main·작업자 메모리에 있으므로, 그때 프로세스가 비정상 종료하면
이 컴퓨터에만 남는 메모리 덤프(crashpad)에 들어 있을 수 있다.
자동화(E2E, electron-verify)는 키체인과 API 대신 스크립트된 대역을 쓴다. 실제 API 확인은 CI에서 돌리지 않는
`scripts/analysis-live-check.mjs`로 한다.
