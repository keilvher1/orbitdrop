# 변환·편집별 메타데이터·색상·투명도·방향 정책

스펙 §9("메타데이터 제거, 색상 프로파일, 투명도, EXIF orientation 정책을 변환별로 명시한다")에 따른
사용자용 정리다. 구현 근거와 실측은 [processors-convert](workstreams/processors-convert.md),
[processors-edit](workstreams/processors-edit.md) 상태 문서에 있다. 모든 작업은 원본을 바꾸지 않고
원본 폴더에 새 파일을 만든다(같은 이름이 있으면 `이름 (2).확장자`).

## 공통 원칙

| 항목 | 정책 |
|---|---|
| EXIF 방향 | 픽셀에 먼저 적용한다. 결과 파일에는 다시 적용될 방향 태그가 남지 않는다(`keepMetadata`로 메타데이터를 유지해도 Orientation은 1). |
| 메타데이터 | 변환은 기본적으로 EXIF(GPS 포함)·XMP·IPTC를 제거하고, 입력에 있었으면 `METADATA_REMOVED {kinds}` 경고를 남긴다. 편집 도구는 EXIF·XMP·IPTC를 복사하지 않는다. |
| 색상 프로파일 | 변환은 sRGB로 바꾼다. 자르기·편집·주석·가리기는 RGB 프로파일(Display P3, Adobe RGB 등)을 유지한다. CMYK·회색 프로파일은 sRGB로 바꾼다. 그려 넣는 색(주석·단색 가림)은 sRGB에서 유지한 프로파일로 변환해 미리보기와 같은 색으로 보이게 한다. |
| 투명도 | 대상 형식에 알파가 없으면(JPEG, 불투명 BMP) `flattenBackground`(기본 흰색)에 합성한다. 실제로 투명한 픽셀이 있을 때만 `ALPHA_FLATTENED {background}` 경고를 남긴다. |
| 비트 깊이 | 출력은 채널당 8비트다. 16비트·실수형 입력과 HEIC는 처음에 한 번 무손실 8비트 사본으로 바꾼 뒤 처리한다(프로파일 유지, 회전 없음). |
| 확장자 불일치 | 실제 헤더 형식으로 처리하고 `EXTENSION_MISMATCH {detected, extension}` 경고를 남긴다. 확장자만 바꾸는 "변환"은 하지 않는다. |

## 변환

| 작업 | 메타데이터 | 색상 | 투명도 | 기타 |
|---|---|---|---|---|
| 이미지 → JPG/PNG/WebP/TIFF/AVIF/BMP/HEIC | 제거(기본). `keepMetadata`면 EXIF·XMP·ICC 유지 | sRGB | JPEG: 배경색에 합성 · PNG/WebP/TIFF/AVIF: 유지 · BMP: 불투명이면 24비트, 아니면 32비트 V5 | HEIC는 macOS ImageIO 헬퍼가 있을 때만. GIF·TIFF는 첫 프레임·첫 페이지 |
| PDF → JPG/PNG | 해당 없음(페이지를 새로 렌더링) | sRGB(PDF 안 ICC 색 관리는 Node에서 꺼져 PDF.js 기본 변환 사용) | 흰 배경의 불투명 페이지 | 기본 300 DPI(설정 150/300), DPI를 파일에 기록. 여러 페이지는 `report-p001.jpg`…, 실패·취소 시 이 작업이 만든 페이지만 모두 되돌림 |
| 이미지 → PDF | 바로 선 sRGB/무프로파일 JPEG는 원본 데이터 그대로 넣고 EXIF·XMP·IPTC 구간만 제거. 그 밖의 JPEG는 방향 적용·sRGB 변환 후 q95 JPEG | sRGB | PNG(알파 유지)로 넣음 | 사용자가 정한 순서로 한 장당 한 페이지 |
| PDF → TXT | 해당 없음 | — | — | 페이지 구분자(표시/폼피드/빈 줄). 텍스트가 없는 스캔 PDF는 빈 성공 파일 대신 `PDF_NO_TEXT` 오류 |
| PDF → DOCX | 해당 없음 | — | — | 텍스트 중심 문서(페이지마다 쪽 나눔). 레이아웃·표·이미지는 재현하지 않음 → `DOCX_TEXT_ONLY` |
| 이미지 → DOCX | 제거 | sRGB | PNG로 넣음(알파 유지) | 그림 삽입 문서, OCR 없음 → `DOCX_IMAGE_ONLY` |

## 편집 도구

| 도구 | 메타데이터 | 색상 | 투명도 | 기타 |
|---|---|---|---|---|
| 자르기 | 복사 안 함 | RGB 프로파일 유지 | PNG 입력은 투명도 유지. JPEG 출력은 배경색에 합성 | 방향 보정 뒤 좌표 기준, 업스케일 없음 |
| 배경 추가 | 복사 안 함 | sRGB | 기본 PNG(투명 모서리 없음, 배경이 채움). JPEG는 불투명 배경 + 품질 | 미리보기와 최종이 같은 합성 명세. 최대 변 기본 2400px |
| 압축 | 기본 제거, `keepMetadata`면 유지 | 유지하지 않으면 sRGB | 형식에 따름 | 입력/예상/최종 크기를 구분. 결과가 더 크면 `OUTPUT_LARGER_THAN_INPUT` |
| 메타데이터 제거 | 같은 형식(JPEG/PNG/WebP/GIF)·방향 1·색 변환 불필요면 무손실로 메타데이터 구간만 제거, 아니면 다시 인코딩 | `convertToSrgb` 또는 `keep` 선택 | 유지 | 썸네일(IFD1)·GPS·XMP·IPTC·MPF 보조 이미지까지 제거. 결과를 다시 읽어 확인 |
| 편집(회전·반전·밝기·대비·채도) | 복사 안 함 | RGB 프로파일 유지 | 유지 | CSS filter와 같은 의미 |
| 주석 | 복사 안 함 | RGB 프로파일 유지, 그린 색은 프로파일로 변환 | 유지 | 한글을 실제로 그리는 설치 글꼴 사용(macOS: Apple SD Gothic Neo) |
| 가리기 | 복사 안 함(썸네일·GPS·XMP 남지 않음) | RGB 프로파일 유지 | 투명 이미지는 영역을 먼저 지움 | 모자이크는 정보 삭제를 보장하지 않는다는 안내 표시 |
