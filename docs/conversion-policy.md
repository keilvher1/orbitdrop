# 변환·편집별 메타데이터·색상·투명도·방향 정책

스펙 §9("메타데이터 제거, 색상 프로파일, 투명도, EXIF orientation 정책을 변환별로 명시한다")에 따른
사용자용 정리다. 구현 근거와 실측은 [processors-convert](workstreams/processors-convert.md),
[processors-edit](workstreams/processors-edit.md), [hardening-processors](workstreams/hardening-processors.md)
상태 문서에 있다. 모든 작업은 원본을 바꾸지 않고 원본 폴더에 새 파일을 만든다(같은 이름이 있으면 `이름 (2).확장자`).

## 공통 원칙

| 항목 | 정책 |
|---|---|
| EXIF 방향 | 픽셀에 먼저 적용한다. 결과 파일에는 다시 적용될 방향 태그가 남지 않는다(`keepMetadata`로 메타데이터를 유지해도 Orientation은 1). 자르기·주석·가리기 좌표는 방향을 적용한 뒤(화면에 보이는) 좌표다. HEIC는 macOS ImageIO가 회전(irot/imir)까지 적용해 디코딩한다. |
| 메타데이터 | 변환은 기본적으로 EXIF(GPS 포함)·XMP·IPTC를 제거하고, 입력에 있었으면 `METADATA_REMOVED {kinds}` 경고를 남긴다. 편집 도구는 EXIF·XMP·IPTC를 복사하지 않는다. |
| 색상 프로파일 | 변환은 sRGB로 바꾼다(내장 프로파일 기준). 자르기·편집·주석·가리기는 RGB 프로파일(Display P3, Adobe RGB 등)을 유지한다. CMYK·회색 프로파일은 sRGB로 바꾼다. 그려 넣는 색(주석·단색 가림)은 sRGB에서 유지한 프로파일로 변환해 미리보기와 같은 색으로 보이게 한다. 프로파일 없는 CMYK는 libvips 내장 CMYK 프로파일로 해석한다(정해진 모양이 없는 데이터라 macOS ColorSync의 Generic CMYK와는 최대 58단계 다르게 보일 수 있음). |
| `keepMetadata`와 색 | RGB 프로파일은 픽셀 값과 함께 그대로 유지한다. CMYK 입력은 내장 CMYK 프로파일로 sRGB로 바꾸고 sRGB 프로파일을 붙인다(EXIF·XMP·IPTC 유지). |
| 투명도 | 대상 형식에 알파가 없으면(JPEG, 불투명 BMP) `flattenBackground`(기본 흰색)에 합성한다. 실제로 투명한 픽셀이 있을 때만 `ALPHA_FLATTENED {background}` 경고를 남긴다. |
| 비트 깊이 | 출력은 채널당 8비트다. 16비트·실수형 입력과 HEIC(10비트 HEIC는 ImageIO가 16비트 PNG로 디코딩)는 처음에 한 번 무손실 8비트 사본으로 바꾼 뒤 처리한다(프로파일 유지, 회전 없음). 변환도 같다. 예외: 메타데이터 무손실 제거는 원본 압축 데이터를 그대로 두므로 16비트 PNG는 16비트로 남는다. |
| 애니메이션·여러 페이지 | GIF·WebP·APNG 애니메이션은 첫 프레임, 여러 페이지 TIFF(HEIF 묶음)는 첫 페이지만 변환·편집하고 `FIRST_FRAME_ONLY {frames, files}` / `FIRST_PAGE_ONLY {pages, files}` 경고를 남긴다. 메타데이터 무손실 제거는 모든 프레임을 그대로 둔다(경고 없음). |
| 확장자 불일치 | 실제 헤더 형식으로 처리하고 `EXTENSION_MISMATCH {detected, extension}` 경고를 남긴다. 확장자만 바꾸는 "변환"은 하지 않는다. |
| 손상·빈 파일 | 빈 파일은 `FILE_EMPTY`(검증 뒤 비워진 경우 포함), 잘리거나 깨진 이미지는 `IMAGE_CORRUPT`다. EOI 마커만 없는 JPEG도 잘린 파일로 본다. 데이터가 마커로 끝나는 잘린 세그먼트는 libjpeg가 회색으로 채워 처리한다(경고로 끝나는 libjpeg 복구, 실측). 헤더의 픽셀 수가 한도(약 2.68억)를 넘으면 디코딩 전에 `IMAGE_TOO_LARGE`, 파일 크기가 한도를 넘으면 읽기 전에 `FILE_TOO_LARGE`다(검증 뒤 커진 파일 포함). |

## 변환

| 작업 | 메타데이터 | 색상 | 투명도 | 기타 |
|---|---|---|---|---|
| 이미지 → JPG/PNG/WebP/TIFF/AVIF/BMP/HEIC | 제거(기본). `keepMetadata`면 EXIF·XMP·ICC 유지 | sRGB | JPEG: 배경색에 합성 · PNG/WebP/TIFF/AVIF: 유지 · BMP: 불투명이면 24비트, 아니면 32비트 V5 | HEIC는 macOS ImageIO 헬퍼가 있을 때만. 애니메이션·여러 페이지는 첫 프레임·첫 페이지(경고) |
| PDF → JPG/PNG | 해당 없음(페이지를 새로 렌더링) | sRGB(PDF 안 ICC 색 관리는 Node에서 꺼져 PDF.js 기본 변환 사용) | 흰 배경의 불투명 페이지 | 기본 300 DPI(설정 150/300). 크기는 크롭 박스·`/Rotate`·UserUnit 기준, 가장 가까운 픽셀로 반올림(Letter 300 DPI → 2550×3300). DPI를 파일에 기록(JPEG: JFIF 밀도 + EXIF 해상도, PNG: pHYs). JPEG 품질 90 이상은 크로마 4:4:4(글자 번짐 없음), 미만은 4:2:0. 한 페이지가 1.5억 픽셀을 넘으면 DPI를 낮춰 렌더링하고 `DOWNSCALED`. 여러 페이지는 `report-p001.jpg`…, 실패·취소 시 이 작업이 만든 페이지만 모두 되돌림 |
| PDF 주석·양식 필드 | — | — | — | 화면 표시와 같이 외관 스트림(appearance stream)을 페이지에 그린다(숨김 주석 제외, 팝업 내용은 그리지 않음). TXT/DOCX에는 페이지 본문 텍스트만 들어가고 주석·필드 값은 추출하지 않는다 |
| 암호화된 PDF | — | — | — | 열 때 사용자 암호가 필요하면 `PDF_ENCRYPTED`. 소유자 암호만 있는 PDF(인쇄·복사 제한 등 권한만 설정)는 다른 뷰어처럼 열어서 변환한다 — 사용자가 이미 볼 수 있는 자기 문서를 로컬에서 변환하는 앱이고 PDF.js에는 권한 적용 기능이 없다 |
| 이미지 → PDF | 바로 선 sRGB/무프로파일 JPEG는 원본 데이터 그대로 넣고 EXIF·XMP·IPTC 구간만 제거. 그 밖의 JPEG는 방향 적용·sRGB 변환 후 q95 JPEG | sRGB | PNG(알파 유지)로 넣음 | 사용자가 정한 순서로 한 장당 한 페이지. 그대로 넣을 JPEG도 먼저 끝까지 디코딩해 보고 잘렸으면 `IMAGE_CORRUPT`(깨진 그림이 든 "성공" PDF를 만들지 않음) |
| PDF → TXT | 해당 없음 | — | — | 페이지 구분자(표시/폼피드/빈 줄). 텍스트가 없는 스캔 PDF는 빈 성공 파일 대신 `PDF_NO_TEXT` 오류 |
| PDF → DOCX | 해당 없음 | — | — | 텍스트 중심 문서(페이지마다 쪽 나눔). 레이아웃·표·이미지는 재현하지 않음 → `DOCX_TEXT_ONLY` |
| 이미지 → DOCX | 제거 | sRGB | PNG로 넣음(알파 유지) | 그림 삽입 문서, OCR 없음 → `DOCX_IMAGE_ONLY`. 32MB를 넘는 그림은 쪽에 놓인 크기 기준 300ppi로 줄여 넣는다(`DOWNSCALED`; DOCX 라이브러리가 그림 바이트를 JS 배열로 해시해 그보다 크면 실패하던 문제) |

## 편집 도구

| 도구 | 메타데이터 | 색상 | 투명도 | 기타 |
|---|---|---|---|---|
| 자르기 | 복사 안 함 | RGB 프로파일 유지 | PNG 입력은 투명도 유지. JPEG 출력은 배경색에 합성 | 방향 보정 뒤 좌표 기준, 업스케일 없음 |
| 배경 추가 | 복사 안 함 | sRGB | 기본 PNG(투명 모서리 없음, 배경이 채움). JPEG는 불투명 배경 + 품질 | 미리보기와 최종이 같은 합성 명세. 최대 변 기본 2400px |
| 압축 | 기본 제거, `keepMetadata`면 유지(CMYK는 위 `keepMetadata`와 색 규칙) | 유지하지 않으면 sRGB | 형식에 따름 | 입력/예상/최종 크기를 구분. 결과가 더 크면 `OUTPUT_LARGER_THAN_INPUT` |
| 메타데이터 제거 | 같은 형식(JPEG/PNG/WebP/GIF)·방향 1·색 변환 불필요면 무손실로 메타데이터 구간만 제거(모든 프레임·원래 비트 깊이 유지), 아니면 다시 인코딩(첫 프레임만, 경고) | `convertToSrgb` 또는 `keep` 선택 | 유지 | 썸네일(IFD1)·GPS·XMP·IPTC·MPF 보조 이미지까지 제거. 결과를 다시 읽어 확인 |
| 편집(회전·반전·밝기·대비·채도) | 복사 안 함 | RGB 프로파일 유지 | 유지 | CSS filter와 같은 의미 |
| 주석 | 복사 안 함 | RGB 프로파일 유지, 그린 색은 프로파일로 변환 | 유지 | 한글을 실제로 그리는 설치 글꼴 사용(macOS: Apple SD Gothic Neo) |
| 가리기 | 복사 안 함(썸네일·GPS·XMP 남지 않음) | RGB 프로파일 유지 | 투명 이미지는 영역을 먼저 지움 | 모자이크는 정보 삭제를 보장하지 않는다는 안내 표시 |

모든 도구는 처리 전에 저장 폴더를 확인한다: 쓸 수 없거나 없는 폴더는 디코딩 전에 `OUTPUT_DIR_NOT_WRITABLE`(변환과 같음).
