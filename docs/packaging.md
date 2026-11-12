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
| `--install-test` | (Windows) NSIS 설치 → HKCU 제거 항목 확인 → 설치본 smoke test → 제거 |
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
| Windows x64 | `OrbitDrop-<ver>-win-x64[-unsigned]-setup.exe` | NSIS, 사용자별 설치 |
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
    없다. OrbitDrop의 네트워크 사용은 업데이트 확인뿐이다(§9).
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
* **서명**: `WIN_CSC_LINK`(또는 `CSC_LINK`) + `WIN_CSC_KEY_PASSWORD`가 있으면 electron-builder가
  signtool로 exe·설치 프로그램에 Authenticode 서명한다. Azure Trusted Signing을 쓰려면
  `win.azureSignOptions`(endpoint, certificateProfileName, codeSigningAccountName)를 설정하고
  `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`을 제공한다(아직 설정하지 않음).
* **SmartScreen**: 미서명이거나 평판이 쌓이지 않은 인증서로 서명된 설치 프로그램은 "Windows의 PC 보호"
  경고가 뜰 수 있다. 미서명 빌드는 테스트용이며, SmartScreen을 끄라고 안내하지 않는다.

## 6. 미서명 빌드 표시

미서명 빌드는 (1) 파일 이름에 `-unsigned`, (2) DMG 볼륨 이름에 `(unsigned)`, (3) `build-report-*.json`의
`signing.mode`로 표시된다. `-incomplete`는 helper 또는 smoke test 구현이 빠진 파이프라인 시험 빌드다.
배포 전 체크리스트:

- [ ] `--require-signing`으로 빌드했고 `build-report`의 `signing.mode`가 Developer ID / Authenticode
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

**네트워크와 개인정보** — 업데이트 확인이 OrbitDrop의 유일한 네트워크 사용이다.

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
* Windows는 서명 인증서를 살 때까지 미서명으로 배포하며 업데이트도 된다: 설치본은 HTTPS로 받은 `latest.yml`의 sha512로 설치 프로그램을
  확인한다. `latest.yml`은 electron-builder가 실제 파일 이름(`…-unsigned-setup.exe` 포함)으로 쓰고 `package.mjs`가 대조한다. 서명을 시작하면
  `app-update.yml`에 게시자 이름(`publisherName`)이 들어가 그 뒤 설치본은 같은 게시자가 서명한 설치 프로그램만 받는다(미서명 → 서명 전환은
  문제없음; 나중에 게시자 이름이 다른 인증서로 바꿀 때는 주의).
* 파일 이름이나 형식을 바꾸면 `latest*.yml`과 어긋나지 않는지 `package.mjs`의 검사로 확인한다.

**설치본에 남는 것**: 내려받은 업데이트는 `~/Library/Caches/@orbitdropdesktop-updater`(macOS),
`%LOCALAPPDATA%\@orbitdropdesktop-updater`(Windows; NSIS 설치 프로그램도 차이 업데이트용 사본 `installer.exe`를 여기에 둔다)에 있고 지워도
된다(이름은 electron-builder가 `apps/desktop/package.json`의 `name`에서 만든다).

**시험**: 개발 실행과 미서명 빌드는 업데이트하지 않으므로, 끝까지 시험하려면 Developer ID 빌드와 pre-release 두 개를 쓴다
([RELEASING.md](RELEASING.md) 5단계). 단위 테스트: `apps/desktop/test/main/update-*.test.ts`(상태 기계·지원 판정·개인정보),
`tests/integration/release-scripts.test.ts`(메타데이터·공증·릴리스 스크립트, 가짜 실행기).
