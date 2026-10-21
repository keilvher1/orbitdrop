# 지원·검증 상태표 (Support matrix)

> **상태: 초안.** packaging-docs 워크스트림이 현재 확인된 사실로 작성했다. `⟨확정 필요⟩` 칸은 각
> 워크스트림 보고서와 수동 GUI 검증 결과를 받아 lead가 확정한다. 단위 테스트·CI·빌드 성공을
> "실제 OS GUI 검증됨"으로 올리지 않는다.

## 등급

| 등급 | 뜻 | 필요한 증거 |
|---|---|---|
| **구현됨** | 코드가 있고 빌드된다 | 소스 위치 |
| **자동 검증됨** | 자동 테스트가 실제 결과물을 다시 읽어 확인했다(단위·통합·패키지 smoke) | 테스트 이름/명령, 실행 환경 |
| **실제 OS GUI 검증됨** | 사람이 설치본에서 실제 Finder/Explorer 파일로 확인했다 | [verification.md](verification.md) 기록(OS 버전·빌드·아키텍처·날짜·스크린샷) |
| **미검증** | 구현 여부와 무관하게 해당 환경에서 확인하지 않았다 | — |
| **미지원** | 해당 환경에서 제공하지 않는다(메뉴에서 숨김/비활성 + 사유) | capability probe 결과 |

## 검증 환경

| 환경 | OS / 빌드 | 아키텍처 | 사용 가능 여부 |
|---|---|---|---|
| 개발 Mac | macOS 26.6 (25G72), Xcode 27.1 | arm64 (Rosetta 2로 x64 실행 가능) | 있음 |
| Intel Mac | — | x64 | **없음** — x64 패키지는 Rosetta 2에서만 실행 확인 |
| Windows 11 | — | x64 | **없음** — Windows 산출물은 GitHub Actions `windows-latest`에서 빌드·smoke·설치 테스트하도록 구성(아직 실행 안 됨) |

## 패키징·설치

| 항목 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 패키지 생성 (dmg+zip / NSIS) | 자동 검증됨 | 자동 검증됨 | 구현됨(CI 미실행) | `node scripts/package.mjs mac --arch all`, [verification.md §자동 검증 증거](verification.md#자동-검증-증거) |
| 네이티브 바이너리 배치(sharp/libvips/canvas, 대상 아키텍처만) | 자동 검증됨 | 자동 검증됨 | 구현됨(after-pack 검사) | after-pack 훅 로그, `lipo -archs` |
| 패키지 smoke test(엔진 probe, helper `ready`, PNG→JPG·PDF→PNG 작업 파이프라인) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 구현됨(CI 미실행) | `ORBITDROP_SMOKE {"ok":true…}` — [verification.md](verification.md#자동-검증-증거) |
| 네이티브 모듈 검사(librsvg SVG 그라데이션·마스크, canvas `app.asar.unpacked` 로드, 시스템 한글 글꼴) | 자동 검증됨 | 자동 검증됨(Rosetta 2) | 구현됨(CI 미실행, Malgun Gothic) | `apps/desktop/build/native-check`, verification.md |
| helper 포함(대상 아키텍처, 서명, 실행 권한) | 자동 검증됨 | 자동 검증됨 | 구현됨(after-pack 검사, CI 미실행) | after-pack "helper:" 줄, `codesign -dv`, helper stdio smoke 18/18 |
| 코드 서명 | 미지원(자격 증명 없음; ad-hoc만) | 미지원(ad-hoc만) | 미지원(미서명) | `build-report-*.json` `signing.mode` |
| 공증 / SmartScreen 평판 | 미지원 | 미지원 | 미지원 | [packaging.md](packaging.md) |
| 사용자별 설치·제거(관리자 권한 없음) | 해당 없음(드래그 설치) | 해당 없음 | 구현됨(CI `--install-test` 미실행) | `build/installer.nsh`, HKCU 검사 |
| 설치본 첫 실행·권한 안내 | 미검증 | 미검증 | 미검증 | verification.md 1단계 |

## P0 — 핵심 경로

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| 전역 드래그 + Shift → 변환 휠(실제 Finder/Explorer) | ⟨확정 필요⟩ | 미검증 | ⟨확정 필요⟩ | macos-helper / windows-helper 보고, verification.md 2·7·8단계 |
| 드롭 → 작업 정확히 1회, Copy만 | ⟨확정 필요⟩ | 미검증 | ⟨확정 필요⟩ | core `DragSessionTracker` 테스트, helper 테스트 |
| PDF → JPG/PNG(1쪽/여러 쪽, 150/300 DPI, 회전) | 자동 검증됨(패키지 smoke: PDF→PNG 1쪽) ⟨여러 쪽·DPI·회전은 processors-convert 테스트로 확정 필요⟩ | 자동 검증됨(Rosetta, PDF→PNG 1쪽) | 미검증 | 패키지 smoke `pdfConversion.ok`, processors-convert 테스트 |
| JPG/PNG/WebP 상호 변환 | 자동 검증됨(패키지 smoke: PNG→JPG) ⟨전체 조합 확정 필요⟩ | 자동 검증됨(Rosetta, PNG→JPG) | 미검증 | smoke `conversion.ok`, processors 테스트 |
| Crop 편집기(비율, W/H, EXIF 회전) | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit / desktop-renderer 테스트 |
| Add Background 편집기(패딩·모서리·그림자·비율, PNG) | ⟨확정 필요⟩ | 미검증 | 미검증 | 동일 |
| 트레이/메뉴 막대, 설정, 작업 진행·취소·결과 열기 | ⟨확정 필요⟩ | 미검증 | 미검증 | desktop-main 보고 |
| 대체 입력(파일 열기, Drop Zone) | ⟨확정 필요⟩ | 미검증 | 미검증 | desktop-main / desktop-renderer 보고 |
| 영상 흐름 재현(PDF→JPG→Crop→Add BG, 결과 4개) | ⟨확정 필요⟩ | 미검증 | 미검증 | `tests/integration/video-flow.test.ts`, verification.md 3–6단계 |

## P1 — 일상 도구

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| Compress | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit |
| Metadata(읽기·제거) | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit |
| Edit(회전·반전·밝기·대비·채도) | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit |
| Annotate(한글 텍스트) | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit |
| Redact | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-edit |
| TIFF / AVIF 출력 | 구현됨(번들 sharp가 인코딩, probe 활성) ⟨자동 검증 확정 필요⟩ | 미검증 | 미검증 | 패키지 probe `encode` |
| 이미지 → PDF(여러 장 순서) | ⟨확정 필요⟩ | 미검증 | 미검증 | processors-convert |
| 텍스트 PDF → TXT | 구현됨(probe `pdfText: true`) ⟨확정 필요⟩ | 미검증 | 미검증 | processors-convert |
| 여러 파일 제한 병렬, 부분 실패 | ⟨확정 필요⟩ | 미검증 | 미검증 | core `JobQueue`, desktop-main |

## P2 — 엔진 확인 후 확장

| 기능 | macOS arm64 | macOS x64 | Windows x64 | 증거 |
|---|---|---|---|---|
| HEIC 읽기/쓰기 | 구현됨(helper ImageIO 모드, 패키지 probe에서 decode·encode `heic` 활성) ⟨결과 파일 검증 확정 필요⟩ | 구현됨(동일, Rosetta) ⟨확정 필요⟩ | 미지원(번들 HEIC 코덱 없음; sharp 인코딩 실패 실측) | PROGRESS.md 실측, 패키지 smoke probe |
| BMP 읽기/쓰기 | 구현됨(자체 코덱, probe 활성) ⟨확정 필요⟩ | 미검증 | 미검증 | `codecs/bmp.ts`, 패키지 probe |
| PDF/이미지 → DOCX(텍스트 중심) | 구현됨(probe `encode` 포함) ⟨확정 필요⟩ | 미검증 | 미검증 | processors-convert |
| OCR, 영상·음성, AI, 클라우드, 계정 | 미지원(범위 밖) | 미지원 | 미지원 | [requirements.md](requirements.md) |
| Windows ARM64, Linux | — | — | 미지원(범위 밖) | [decisions.md ADR-10](decisions.md#adr-10-최소-os-버전) |
