# OrbitDrop

**파일을 드래그하고 → 보조키를 누르면 → 커서 옆에 원형 메뉴가 나타나고 → 형식이나 도구 위에 놓으면 →
원본 옆에 결과 파일이 생기는** 로컬 파일 변환·편집 데스크톱 앱입니다(Windows 11 x64, macOS 14+).
모든 처리는 내 컴퓨터에서만 일어나며 원본은 이동·덮어쓰기·삭제되지 않습니다.

> A local file converter/editor: drag a file in Finder or Explorer, hold Shift, drop it on a ring
> sector (JPG, PNG, CROP, ADD BG, …) and the result is written next to the original.
> "OrbitDrop" is a working name. It is an independent app inspired by a workflow seen in a
> reference video of another product; it uses its own name, icon and code.

<p align="center"><img src="apps/desktop/build/icon.png" width="128" alt="OrbitDrop icon"></p>

## 상태 (2026-10-21)

**개발 중.** 기능별·OS별 상태는 [docs/support-matrix.md](docs/support-matrix.md)가 기준입니다.

| 영역 | 상태 |
|---|---|
| macOS 패키지 (arm64, x64) | dmg/zip 생성, helper·sharp/libvips·@napi-rs/canvas가 대상 아키텍처로 포함, ad-hoc 서명, DMG 안의 앱으로 smoke test(helper `ready`, PNG→JPEG, PDF→PNG) **자동 검증됨**(개발 Mac, x64는 Rosetta 2). 코드 서명·공증 자격 증명 없음 → **미서명** 산출물 |
| Windows 패키지 (x64) | NSIS 사용자별 설치 프로그램 설정·CI(빌드, smoke, 무인 설치/제거) 작성, **아직 Windows에서 실행되지 않음** |
| 실제 Finder/Explorer 전역 드래그 | 네이티브 helper 구현됨(macOS는 권한 없이 동작하는 관찰 방식), **실제 OS GUI 검증 전** — [verification.md](docs/verification.md) 절차 |
| 변환·편집 엔진 | sharp(libvips), PDF.js + @napi-rs/canvas, pdf-lib, docx — 패키지 안에서 엔진 probe와 PNG→JPG 작업 파이프라인 확인 |

미서명 빌드는 로컬 테스트용이며 파일 이름에 `-unsigned`가 붙습니다. Gatekeeper/SmartScreen을 끄는 방법은
안내하지 않습니다([docs/packaging.md](docs/packaging.md)).

## 기능

| 등급 | 기능 |
|---|---|
| **P0** | PDF → JPG/PNG(1쪽은 같은 이름, 여러 쪽은 `report-p001.jpg`…, 300/150 DPI) · JPG/PNG/WebP 상호 변환 · **Crop** 편집기(Free, 1:1, 16:9, 9:16, 4:3, 3:4, 픽셀 W/H) · **Add Background** 편집기(프리셋/단색/이미지 배경, Padding·Corners·Shadow, Auto/1:1/16:9/4:5, 기본 PNG) · 트레이/메뉴 막대, 설정, 작업 진행·취소·결과 위치 열기 · 대체 입력(파일 열기, Drop Zone) · 네이티브 전역 드래그 |
| **P1** | Compress · Metadata(읽기/제거) · Edit(회전·반전·밝기·대비·채도) · Annotate(텍스트·화살표·사각형, 한글) · Redact(가림·모자이크) · TIFF/AVIF · 이미지 → PDF · 텍스트 PDF → TXT · 여러 파일 제한 병렬 처리 |
| **P2** | HEIC/BMP(플랫폼 코덱이 지원하는 방향만) · PDF/이미지 → DOCX(텍스트 중심) |

| 형식 선택(PDF) | 자르기 | 배경 추가 | macOS helper 휠 |
|---|---|---|---|
| <img src="docs/screenshots/desktop-renderer-electron-picker-pdf.png" width="200" alt="PDF 변환 휠"> | <img src="docs/screenshots/desktop-renderer-electron-crop.png" width="200" alt="자르기 편집기"> | <img src="docs/screenshots/desktop-renderer-electron-add-background-16x9.png" width="200" alt="배경 추가 편집기"> | <img src="docs/screenshots/macos-helper-jpg-convert.png" width="200" alt="네이티브 휠 렌더링"> |

앞의 세 장은 실제 Electron 앱 창, 마지막은 macOS helper의 휠 렌더링 스냅샷입니다(실제 Finder 드래그 검증 기록이 아님).

번들 엔진이 실제로 지원하지 않는 메뉴는 사유와 함께 비활성화됩니다. 확장자만 바꾸는 "변환"은 없습니다.
기본 조작: 드래그 중 **Shift** = 변환 휠, **Option+Shift**(macOS) / **Alt+Shift**(Windows) = 도구 휠(설정에서 변경 가능).
관찰된 사실과 제품 결정의 구분: [docs/requirements.md](docs/requirements.md).

## 요구 사항

* 사용: **macOS 14 이상**(Apple Silicon; Intel x64 산출물은 별도 검증 상태) · **Windows 11 x64**(사용자별 설치, 관리자 권한 불필요).
  Electron 44 자체는 macOS 13+, Windows 10+를 지원하지만 OrbitDrop의 검증 대상은 위와 같습니다([ADR-10](docs/decisions.md#adr-10-최소-os-버전)).
* 개발: Node.js 22.12+(24 권장), pnpm 11, macOS helper는 Xcode/Swift 6, Windows helper는 Visual Studio C++ + CMake.

## 개발 명령

```sh
pnpm install            # Electron 바이너리가 없으면: node node_modules/electron/install.js
pnpm dev                # 개발 실행
pnpm test               # 단위·통합 테스트 (Vitest)
pnpm typecheck
pnpm build              # electron-vite 번들
pnpm native:mac         # macOS helper 빌드·스테이징 (Windows: pnpm native:win)
pnpm package:mac        # = node scripts/package.mjs mac [--arch arm64|x64|all]
pnpm package:win        # Windows에서 실행
```

자세한 내용: [docs/development.md](docs/development.md) · 패키징/서명: [docs/packaging.md](docs/packaging.md).

## 저장소 구조

```
apps/desktop/        Electron 앱: main · preload · renderer(React) · electron-builder.yml · build/(아이콘, entitlements)
packages/contracts/  공통 타입·스키마·디자인 토큰 (IPC, 작업, capability, helper/processor 프로토콜)
packages/core/       작업 큐 · 파일 이름 · 입력 검증 · 좌표/휠 기하 · capability registry
packages/processors/ 이미지·PDF 처리 (utilityProcess worker에서 실행)
native/macos/        Swift/AppKit 드래그 helper
native/windows/      C++/Win32/OLE 드래그 helper
tests/               통합 테스트 · 픽스처 · 휠 골든 벡터
scripts/             build-native · package · after-pack · gen-icons · licenses · gen-golden · gen-fixtures
docs/                요구사항 · 결정(ADR) · 개발 · 지원표 · 검증 · 권한 · 패키징
```

## 문서

* [requirements.md](docs/requirements.md) — 영상에서 확인한 사실 / 확인되지 않은 사항 / OrbitDrop의 결정
* [architecture.md](docs/architecture.md) — 프로세스 구조, 파이프라인, 소유권
* [decisions.md](docs/decisions.md) — 기술 결정(Electron, electron-builder, pnpm, sharp, PDF.js, helper, 최소 OS)
* [support-matrix.md](docs/support-matrix.md) — P0/P1/P2 × macOS arm64 / macOS x64 / Windows x64 검증 상태
* [verification.md](docs/verification.md) — 수동 GUI 검증 절차·기록표, 자동 검증 증거
* [permissions.md](docs/permissions.md) — 파일 접근과 입력 관찰 권한
* [conversion-policy.md](docs/conversion-policy.md) — 변환·편집별 메타데이터·색상 프로파일·투명도·방향 정책
* [packaging.md](docs/packaging.md) — 산출물, 리소스 배치, 서명·공증, SmartScreen, 미서명 표시
* [PROGRESS.md](docs/PROGRESS.md) — 진행 기록

## 라이선스

* OrbitDrop 자체 코드의 라이선스는 **아직 정해지지 않았습니다**(프로젝트 소유자 결정 사항). 정해지기 전에는 별도 허가 없이
  재배포할 수 없습니다.
* 함께 배포되는 제3자 구성요소와 라이선스: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
  (`node scripts/licenses.mjs`로 생성, 설치본에도 포함). libvips와 일부 라이브러리는 **LGPL-3.0-or-later**이며
  교체 가능한 동적 라이브러리로 포함됩니다. Electron/Chromium 고지는 `LICENSES.chromium.html`로 함께 배포됩니다.
* 앱 아이콘(`apps/desktop/build/icon.svg`)은 이 프로젝트의 자체 디자인입니다.
