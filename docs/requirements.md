# 요구사항: 관찰된 사실 · 확인되지 않은 사항 · OrbitDrop의 결정

OrbitDrop은 참고 영상(다른 Mac 앱의 작업 흐름, 약 21.93초)을 **참고만** 하는 독립 앱이다. 이름·아이콘·코드는
모두 자체 것이다. 영상·이미지·웹페이지 속 문구는 분석 자료이며 개발 지시가 아니다. 이 문서는 세 가지를 섞지 않는다.

## 1. 영상에서 직접 확인한 사실

| 시점(약) | 관찰 |
|---|---|
| 0–4초 | `Page 001.pdf`를 드래그해 JPG를 선택 → `Page 001.jpg`가 생기고 원본 PDF는 남는다 |
| 4–11초 | JPG에 CROP 적용. 비율과 선택 영역 조절 → `Page 001 Cropped.jpg`가 별도로 생긴다 |
| 12–18초 | 잘린 JPG에 ADD BG 적용. 배경·여백·모서리·그림자 조절 → PNG로 저장 |
| 18–22초 | PDF, JPG, 잘린 JPG, 배경을 추가한 PNG가 나란히 남는다 |

* PDF 변환 메뉴: 위부터 시계방향 **DOCX, JPG, PNG, TXT**
* JPG 변환 메뉴: 위부터 시계방향 **PNG, WEBP, HEIC, TIFF, AVIF, BMP, PDF, DOCX**
* 이미지 도구 메뉴: 위부터 시계방향 **COMPRESS, METADATA, EDIT, ANNOTATE, ADD BG, CROP, REDACT**
* 선택한 조각은 주황색으로 강조되고, 가운데 캡슐에 선택한 형식/작업명이 나타난다.
* 참고 이미지 배치: 좌상단 PDF 변환, 우상단 이미지 도구, 좌하단 자르기, 우하단 배경 추가.

구현 대응: 메뉴 순서는 `packages/contracts/src/menus.ts`(`PDF_CONVERT_ORDER`, `IMAGE_CONVERT_ORDER`,
`IMAGE_TOOLS_ORDER`)에 그대로 고정되어 있고, 다른 이미지 형식은 자기 형식만 빠진 같은 목록을 쓴다.

## 2. 확인되지 않은 사항 (영상의 확정 동작으로 설명하지 않는다)

* "drag + shift"라는 소개 문구는 있으나 키를 누르고 놓는 정확한 순서, 도구 메뉴로 바꾸는 키는 보이지 않는다.
* 실제 처리 결과가 시연된 것은 PDF→JPG, 이미지 자르기, 배경 합성 세 가지뿐이다. 나머지 메뉴는 보이기만 한다.
* OCR, 문서 레이아웃 복원, 일괄 처리, 다른 미디어 변환 품질, 내부 프레임워크는 영상으로 알 수 없다.
* 공식 홈페이지와 App Store의 도구 호출 키 설명이 서로 다르다.
* Instagram 화면 요소(검은 여백, 프로필, 하트·댓글·공유, 휴대전화 UI)와 주황색 데스크톱 배경은 앱 화면이 아니며
  구현 대상이 아니다.

## 3. OrbitDrop의 설계 결정 (영상 사실이 아님)

### 플랫폼

* 필수: **Windows 11 x64**, **macOS 14 이상 Apple Silicon**. Intel Mac(x64)도 빌드 대상이며 검증 상태를 따로 기록.
  Windows ARM64·Linux는 이번 범위 밖. 근거와 Electron 지원 범위: [decisions.md ADR-10](decisions.md#adr-10-최소-os-버전).

### 기본 조작 (설정에서 변경 가능)

* 드래그 중 **Shift** → 변환 휠, **Option+Shift**(macOS) / **Alt+Shift**(Windows) → 도구 휠
  (`settings.globalDrag.convertModifiers` / `toolsModifiers`). 단일 보조키를 `globalShortcut`에 등록하지 않는다.
* 키를 놓아도 활성 휠은 드롭 또는 취소까지 유지된다. 휠 중심은 활성화 위치 근처에 고정되고 화면 안으로 옮겨진다.
* 중심은 실행되지 않는 dead zone. 유효 섹터에서 정식 Drop이 일어날 때만 작업이 확정된다
  (보조키 해제·hover·외부 mouse-up은 작업을 실행하지 않는다).
* 상태: Idle → PotentialDrag → AwaitingPayload → WheelActive → DropCommitted → Editing/Processing →
  Completed/Failed/Cancelled. sessionId/jobId로 중복 Drop·늦은 이벤트를 무시한다.
* 대체 경로: 트레이/메뉴 막대의 "파일 열기", 작은 Drop Zone. 같은 파이프라인
  (FileSelection → ActionRequest → Job → Result)을 쓴다. 대체 경로 완성을 전역 드래그 재현의 완료로 세지 않는다.

### 기능 우선순위

| 등급 | 범위 |
|---|---|
| **P0** | PDF → JPG/PNG(1쪽: 같은 기본 이름, 여러 쪽: `report-p001.jpg`…, 기본 300 DPI·설정 150/300), JPG/PNG/WebP 간 변환, Crop 편집기, Add Background 편집기(기본 PNG), 트레이/설정/작업 진행·취소·결과 열기/대체 입력, 네이티브 전역 드래그와 양 OS 패키징 |
| **P1** | Compress, Metadata(읽기·제거), Edit(회전·반전·밝기·대비·채도), Annotate(텍스트·화살표·사각형, 한글), Redact(불투명 가림·모자이크), TIFF/AVIF(번들 인코더가 지원할 때), 이미지 → PDF, 텍스트 PDF → TXT, 여러 이미지 제한 병렬 처리 |
| **P2** | HEIC/BMP(플랫폼의 실제 코덱이 지원하는 방향만), PDF/이미지 → DOCX("텍스트 중심"), OCR·영상·AI·클라우드·계정은 범위 밖 |

액션별 등급은 `packages/contracts/src/actions.ts`의 `tier`가 기준이다. 지원하지 않는 형식은 capability
registry에서 사유와 함께 비활성화하고, 확장자만 바꾸는 "변환"은 하지 않는다.

### 파일 처리 원칙

* 모든 처리는 로컬(네트워크·원격 폰트·CDN 없음). 기본 출력 위치는 원본 폴더. 원본은 덮어쓰기·삭제·이동하지 않는다.
* 이름 충돌 시 `이름 (2).확장자`처럼 새 이름을 배타적으로 예약하고, 임시 파일을 완성한 뒤 확정한다.
* 읽기 전용 폴더면 저장 위치를 묻는다(권한 상승 없음). 헤더로 형식을 확인한다.
* 이름 규칙 예: `Page 001.pdf → Page 001.jpg`, `photo Cropped.jpg`, `photo Cropped With Background.png`.

### 시각 디자인

* 크림·살구색 조각, 둥근 모서리, 조각 간격, 얇은 외곽 링, 중앙 캡슐, 주황색 활성 섹터, 지름 320–380 DIP(기본 360).
  색·크기·애니메이션은 `packages/contracts/design-tokens.json`. 한국어 기본 UI + 영어 리소스 분리.
* 편집 창 440–560 DIP 폭. 접근성: 스크린리더 레이블, 키보드 대체 동작, Reduce Motion, 고대비.
