# 릴리스 절차 (Releasing)

OrbitDrop은 GitHub 저장소 [keilvher1/orbitdrop](https://github.com/keilvher1/orbitdrop)의 **Releases**로 배포한다.
설치된 앱은 같은 곳에서 업데이트를 찾는다([packaging.md §9](packaging.md#9-자동-업데이트)).

> 원칙: CI와 스크립트는 **초안(draft) 릴리스만** 만든다. 공개(publish)는 아래 확인을 마친 사람이 직접 한다.
> 이미 공개된 릴리스의 파일은 바꾸지 않는다(스크립트도 거부한다). 버전 번호는 다시 쓰지 않는다.

흐름은 두 부분이다.

1. **CI** — 태그 `vX.Y.Z`를 push하면 [`.github/workflows/release.yml`](../.github/workflows/release.yml)이 Windows 설치 프로그램을 만들어
   그 태그의 초안 릴리스에 올린다.
2. **릴리스용 Mac** — macOS 패키지는 소유자의 Mac에서 [`scripts/release-mac.mjs`](../scripts/release-mac.mjs)가 만들고(서명·공증·staple)
   같은 초안에 올린다. Developer ID 개인 키는 로그인 키체인에만 있고 GitHub에 올라가지 않는다.

그다음 사람이 확인하고 공개한다.

## 0. 한 번만 준비

* `gh` 로그인(`gh auth login`, 저장소 쓰기 권한), Xcode Command Line Tools(`xcrun notarytool`, `xcrun stapler`),
  로그인 키체인의 **Developer ID Application** 인증서.
* App Store Connect API 키(.p8)를 `~/.appstoreconnect/private_keys/`에 둔다(권한 600). 키 파일 내용은 어디에도 복사하거나 출력하지 않는다.
* 서명·공증 설정은 **환경 변수로만** 준다(저장소·문서·스크립트에 실제 값을 쓰지 않는다). 셸 프로필이나 비밀번호 관리자에 두고 쓴다:

  ```sh
  export CSC_NAME="Your Name (TEAMID)"            # Developer ID Application 인증서 이름(접두어 없이)
  export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<key id>.p8
  export APPLE_API_KEY_ID=<key id>
  export APPLE_API_ISSUER=<issuer uuid>
  ```

  API 키 대신 notarytool 키체인 프로필도 된다:
  `xcrun notarytool store-credentials <profile> --key … --key-id … --issuer …` 후 `export APPLE_KEYCHAIN_PROFILE=<profile>`.
* **Windows 서명(SignPath Foundation)**: 승인을 받은 뒤 한 번만 — SignPath 쪽 설정(GitHub.com 신뢰 빌드 시스템, 아티팩트 구성
  `windows-binaries`·`windows-installer`, 서명 정책, API 토큰)과 저장소의 시크릿 `SIGNPATH_API_TOKEN`, 변수 `SIGNPATH_ORGANIZATION_ID`,
  `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`. 순서는 [packaging.md §5 "Windows 코드 서명"](packaging.md#windows-코드-서명-signpath-foundation)의
  "소유자가 할 일". 넷이 모두 있어야 CI가 SignPath로 서명하고, 없으면 지금처럼 미서명(`-unsigned`)이다.
* 그 밖의 CI 시크릿은 필요 없다. Windows 서명 인증서를 사면 `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`를 넣는다(SignPath가 설정되어 있으면 쓰이지 않는다). macOS도 CI에서 서명하려면
  `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`와 공증 시크릿(`APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)을 넣는다 —
  그러면 CI의 macOS 작업이 서명·공증된 패키지를 만들고 4단계를 건너뛸 수 있다(부록).

## 1. 버전 올리기

1. `node scripts/set-version.mjs <버전>`으로 버전을 올린다(semver). `apps/desktop/package.json`과 두 네이티브 helper(macOS
   `HelperInfo.version`·`Info.plist`, Windows `CMakeLists.txt`의 `project(VERSION)`과 `ORBITDROP_VERSION_STRING` → VERSIONINFO)를 함께 바꾸며,
   어긋나면 `--check`와 테스트가 실패한다. Windows의 직접 만든 실행 파일 네 개는 모두 이 버전을 ProductVersion으로 가져야 한다(SignPath 조건,
   `package.mjs`가 확인).
   업데이트는 **더 높은 버전**만 받으므로 반드시 올라가야 한다.
   `0.2.0-beta.1` 같은 프리릴리스 버전은 GitHub에서 pre-release로 공개하며, 정식 버전 설치본은 프리릴리스를 받지 않는다.
   프리릴리스 이름은 `-alpha.N`/`-beta.N`만 쓴다: 그런 설치본은 더 새 프리릴리스와 정식 버전으로 넘어가지만, 다른 이름(`-rc.N` 등)은
   electron-updater가 별도 채널로 다뤄 같은 이름의 프리릴리스만 따라가고 정식 버전으로는 넘어가지 않는다.
2. `node scripts/licenses.mjs`로 `THIRD_PARTY_LICENSES.md`를 다시 만든다. 이 파일은 머리말과 소스 제공 약속에 앱 버전을 적으므로,
   버전만 올리고 두면 CI의 `licenses.mjs --check`가 실패한다(1.1.0 첫 태그가 이것으로 Windows 빌드에서 멈췄다).
3. 변경 내용을 문서(PROGRESS.md 등)에 적고 커밋한다.
4. 검사(버전을 올린 **뒤에**): `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `node scripts/licenses.mjs --check`,
   그리고 Mac에서 Playwright E2E와 `electron-verify`(창이 열리므로 사람이 있는 데스크톱에서).

## 2. 태그

```sh
git tag -a v0.2.0 -m "OrbitDrop 0.2.0"
git push origin main v0.2.0
```

태그는 `v` + `apps/desktop/package.json`의 버전과 정확히 같아야 한다(CI와 `release-mac.mjs`가 확인한다).

## 3. CI: 초안 릴리스 (Windows)

태그 push로 **Release** 워크플로가 돈다.

| 작업 | 하는 일 |
|---|---|
| Plan | 태그 형식·버전 일치 확인. macOS 서명·공증 시크릿이 없으면 macOS 작업을 건너뛰고 작업 요약에 "macOS packages are built locally: `node scripts/release-mac.mjs <tag>`"를 남긴다(실패 아님) |
| Windows (x64) | 검사·테스트 → helper → 번들 → `package.mjs win --install-test`. 인증서가 없으면 미서명이며 파일 이름에 `-unsigned`가 붙는다. **SignPath가 설정되어 있으면** 서명 요청 두 개(아래 "SignPath 승인")를 거쳐 서명된 설치 프로그램을 만든다(`-unsigned` 없음) |
| macOS | 시크릿이 있을 때만: 임시 키체인에 인증서를 넣고 `package.mjs mac --arch all --require-signing --require-notarization` |
| Draft release | 유일하게 쓰기 권한(`contents: write`)이 있는 작업. [`scripts/third-party-sources.mjs`](../scripts/third-party-sources.mjs)로 이 버전이 싣는 LGPL·MPL 구성요소의 대응 소스 묶음(`OrbitDrop-<버전>-third-party-sources.tar.gz`)을 만들고, [`scripts/release-assets.mjs`](../scripts/release-assets.mjs)가 초안을 만들거나 갱신하고(이미 공개된 릴리스는 거부; 소스 묶음이 없으면 올리지 않음) 파일을 올린 뒤 `SHA256SUMS.txt`를 릴리스의 **모든** 파일에 대해 다시 쓴다 |

초안에 올라가는 것(Windows): `OrbitDrop-<버전>-win-x64-unsigned-setup.exe`(SignPath로 서명했으면 `OrbitDrop-<버전>-win-x64-setup.exe`),
`latest.yml`, `build-report-win32-x64.json`, `SHA256SUMS.txt`. `-unsigned`가 없는 이름은 build report가 네 실행 파일의 Valid 서명을 보여 줄 때만
올라가고(`release-assets.mjs`), 서명 흐름 리허설(`-rehearsal`)은 올라가지 않는다. 서명되지 않은 macOS 패키지는 어떤 경우에도 릴리스에 올라가지 않는다.

### SignPath 승인 (Windows, 릴리스마다)

SignPath Foundation은 **모든 릴리스를 승인자가 직접 승인**해야 서명한다. 한 릴리스에 요청이 두 번 온다(같은 작업 안에서 몇 분 간격, 각각 최대
90분 기다린다 — 그 안에 승인하지 않으면 작업이 실패하고 Windows 파일은 초안에 올라가지 않는다).

1. 태그를 push하면 Windows 작업이 빌드·검사 뒤 **요청 1**을 보낸다: `OrbitDrop.exe`, `OrbitDropHelper.exe`, `Uninstall OrbitDrop.exe`
   (아티팩트 구성 `windows-binaries`). SignPath 알림 메일이나 <https://app.signpath.io>의 서명 요청을 연다.
2. 승인 전에 확인한다: 출처(origin)가 `github.com/keilvher1/orbitdrop`, ref가 `refs/tags/v<버전>`, 커밋이 그 태그의 커밋이고 빌드 링크가 이
   실행의 Windows 작업인지; 매개변수 `version`이 태그와 같은지; 파일이 위 세 개뿐인지. 이상하면 **거부**한다(그 실행은 실패하고 아무것도
   공개되지 않는다).
3. 승인하면 작업이 돌아온 파일을 보낸 파일과 대조하고 설치 프로그램을 만든 뒤 **요청 2**(`OrbitDrop-<버전>-win-x64-setup.exe`, 아티팩트 구성
   `windows-installer`)를 보낸다. 같은 방식으로 확인하고 승인한다.
4. 작업이 서명된 설치 프로그램으로 모든 검사·설치 시험을 다시 하고 초안에 올린다. 재실행(Re-run)은 SignPath 정책이 재실행을 막으면 서명되지
   않는다 — 필요하면 Run workflow로 같은 태그를 새로 실행한다("Use workflow from"을 그 태그로; 다른 브랜치에서 `tag` 입력만 주면 SignPath가
   출처를 확인할 수 없어 Plan 작업이 거부한다).

다시 돌리기: Actions › Release › Run workflow에서 `tag`에 `v0.2.0`을 넣는다(초안의 같은 이름 파일을 교체). SignPath가 설정되어 있으면
"Use workflow from"도 그 태그로 고른다(위 4번). `tag`를 비우면 빌드만 하고 릴리스는 건드리지 않는다(Windows는 미서명; `signpath_rehearsal`을
켜면 서명 흐름을 자체 서명 인증서로 리허설한다 — [packaging.md §5](packaging.md#windows-코드-서명-signpath-foundation)).

## 4. macOS 패키지 (릴리스용 Mac)

```sh
git checkout v0.2.0                              # 변경 사항 없는 깨끗한 작업 트리
node scripts/release-mac.mjs v0.2.0 --dry-run    # 빌드 + 검증만(업로드 없음)
node scripts/release-mac.mjs v0.2.0 --skip-build # 방금 검증한 패키지를 다시 검증하고 업로드
```

(`--dry-run` 없이 한 번에 실행해도 된다.) `release-mac.mjs`는:

1. **거부**: 작업 트리에 변경이 있음, HEAD가 태그가 아님, 태그가 GitHub(origin)에 없거나 다른 커밋, 버전 불일치,
   `CSC_NAME`·공증 설정 없음(`CSC_LINK`가 있으면 끄라고 한다), `gh` 미로그인. 문제를 한 번에 모두 보여 준다.
2. `node scripts/package.mjs mac --arch all --require-signing --require-notarization`:
   electron-builder가 앱을 서명·공증·staple하고, [`scripts/mac-dmg.mjs`](../scripts/mac-dmg.mjs)가 DMG를 같은 신원으로 서명(보안 타임스탬프)
   → `notarytool submit --wait` → `stapler staple` → `spctl -a -t open --context context:primary-signature`·`stapler validate`로 확인한다.
   공증은 보통 수 분 걸린다.
3. **검증**: build report(Developer ID, 앱·DMG 공증, smoke test, 네이티브 모듈 검사, 태그 커밋에서 빌드됨), `latest-mac.yml`(arm64·x64 zip,
   sha512·크기 일치), DMG마다 `spctl`·`stapler validate`, 그리고 DMG 안의 앱을 **격리 속성을 붙인 사본**(내려받은 파일처럼)으로 꺼내
   `spctl --assess --type execute`(Notarized Developer ID), `stapler validate`, `syspolicy_check distribution`.
4. **업로드**: DMG 2개, zip 2개, zip blockmap 2개, `latest-mac.yml`을 초안에 `gh release upload --clobber`로 올린다(초안이 아직 없으면
   만든다). 이어서 `SHA256SUMS.txt`를 릴리스의 모든 파일(Windows 포함)에 대해 다시 쓴다 — GitHub가 올린 파일마다 계산한 SHA-256(digest)을
   쓰고, 방금 올린 파일은 로컬 해시와 대조한다.
5. 공개하지 않는다.

build report(`apps/desktop/release/build-report-darwin-*.json`)는 공증 ID를 담고 있으며 로컬에 남는다(이 Mac의 경로가 들어 있어 올리지 않는다).

## 5. 공개 전 확인

- [ ] 초안의 파일: `OrbitDrop-<버전>-mac-arm64.dmg`, `…-mac-x64.dmg`, 두 `.zip`과 `.zip.blockmap`, `latest-mac.yml`,
      `…-win-x64[-unsigned]-setup.exe`, `latest.yml`, `build-report-win32-x64.json`, `OrbitDrop-<버전>-third-party-sources.tar.gz`,
      `SHA256SUMS.txt`
- [ ] 내려받아 대조: `gh release download v0.2.0 --dir /tmp/orbitdrop-v0.2.0 && cd /tmp/orbitdrop-v0.2.0 && shasum -a 256 -c SHA256SUMS.txt`
- [ ] `latest-mac.yml`이 arm64·x64 zip을, `latest.yml`이 setup.exe를 가리키고 버전이 태그와 같다(스크립트가 확인하지만 눈으로도)
- [ ] macOS(가능하면 깨끗한 Mac 또는 VM): 브라우저로 DMG를 내려받아 열고 응용 프로그램 폴더로 옮긴 뒤 실행 — Gatekeeper 경고 없음,
      정보 창에 버전과 커밋, 설정 › 일반의 "업데이트 자동 확인"
- [ ] Windows 11: 설치·실행·제거(미서명이면 SmartScreen 경고가 정상), 정보 창. 설치 중 "개인정보와 업데이트" 페이지(상자를 해제하면
      첫 실행의 설정 › 일반 "업데이트 자동 확인"이 꺼져 있다)
- [ ] SignPath로 서명했으면: `Get-AuthenticodeSignature .\OrbitDrop-<버전>-win-x64-setup.exe`가 `Valid`, 서명자 SignPath Foundation. 설치 폴더의
      `OrbitDrop.exe`·`resources\helper\OrbitDropHelper.exe`·`Uninstall OrbitDrop.exe`도 같다(build report `signatures`). 첫 서명 릴리스를
      공개한 뒤 웹페이지 코드 서명 정책의 상태 줄을 바꾼다([packaging.md §5](packaging.md#windows-코드-서명-signpath-foundation))
- [ ] 릴리스 노트(초안의 자동 문구를 다듬는다), LGPL 소스 제공 방식([packaging.md](packaging.md#lgplmpl-소스-제공--결정-필요))
- [ ] (선택) 업데이트 경로 시험: 초안은 업데이트에 보이지 않으므로, 큰 변경 전에는 `v0.2.0-beta.1`, `v0.2.0-beta.2`를 pre-release로
      공개해 beta.1 설치본이 beta.2로 업데이트되는지 본다(정식 버전 설치본은 pre-release를 받지 않고, beta 설치본은 나중에 정식 `v0.2.0`도
      받는다). `-rc`는 쓰지 않는다: rc 설치본은 rc 채널에 남는다

## 6. 공개

GitHub › Releases › 초안 › Edit › **Publish release**(최신 릴리스로 표시). 사람이 한다(`gh release edit v0.2.0 --draft=false`도 같다).

공개 후: 설치된 앱은 6시간 안에(또는 "업데이트 확인…"으로 즉시) 새 버전을 찾아 내려받고, 종료할 때 설치한다. 웹페이지의 내려받기 링크가
새 파일을 가리키는지 확인한다.

## 7. 되돌리기

**공개 전**: 초안을 지우고(`gh release delete v0.2.0 --yes`) 고친 뒤 처음부터. 태그도 다시 만들려면 공개 전에만
`git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0`.

**공개 후 문제가 있으면**:

1. **퍼짐 막기** — 릴리스를 Edit에서 pre-release로 바꾸거나 다시 초안으로 돌린다(`gh release edit v0.2.0 --prerelease` /
   `--draft=true`). 그러면 GitHub의 "latest"가 이전 릴리스로 돌아가 아직 받지 않은 설치본은 그 버전을 받지 않는다.
   이미 내려받은 설치본은 종료할 때 설치하고, 이미 설치한 사용자는 그대로 남는다(업데이트는 낮은 버전으로 내려가지 않는다).
2. **고쳐서 앞으로** — 문제를 고친 새 패치 버전(`v0.2.1`)을 같은 절차로 낸다. 이미 나쁜 버전을 설치한 사용자를 옮기는 방법은 이것뿐이다.
3. 공개된 릴리스의 파일을 바꾸거나 같은 버전 번호를 다시 쓰지 않는다: 이미 받은 파일·`latest*.yml`·`SHA256SUMS.txt`와 어긋난다.
   릴리스를 지우면 웹페이지와 기존 링크가 깨지므로 1번을 먼저 쓴다.

## 부록: CI에서 macOS까지 만들기

macOS 서명·공증 시크릿(`MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD`, 그리고 `APPLE_API_KEY_P8` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`
또는 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`)이 모두 있으면 Release 워크플로의 macOS 작업이 실행된다. 인증서를
실행마다 새로 만드는 임시 키체인에 넣고(작업 끝에 지운다) 4단계와 같은 `--require-signing --require-notarization` 빌드를 한다.
Draft release 작업은 build report가 Developer ID·앱 공증·DMG 공증을 보여 줄 때만 macOS 파일을 올린다. 이 경우에도 공개 전 확인(5단계)은
같다.
