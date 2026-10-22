# macOS 가상 머신 GUI 검증 도구 (선택 사항)

[verification.md의 가상 머신 기록](../../docs/verification.md#가상-머신-gui-검증--macos-1487-2026-10-22)을 다시 만들 때 쓰는 개발용
도구다. 앱이나 빌드에는 쓰이지 않는다. **호스트 Mac의 입력은 건드리지 않는다** — 입력은 게스트 안의 가상 키보드·마우스로만 들어간다.
사람이 실물 Mac에서 하는 GUI 검증을 대신하지 않는다.

필요한 것: Apple Silicon Mac(macOS 13 이상), [tart](https://tart.run)(Cirrus Labs, 서명·공증된 배포본), Python 3 +
`vncdotool`(가상 환경에 설치), 디스크 약 30 GB.

## 1. 이미지와 가상 머신

```sh
tart clone ghcr.io/cirruslabs/macos-sonoma-vanilla:latest od-sonoma   # macOS 14, 계정 admin / admin
tart set od-sonoma --cpu 4 --memory 6144 --display 1440x900px          # Retina 시험은 1440x900pt
```

회선에 따라 `tart clone`이 매우 느릴 수 있다(2026-10-22 이 저장소의 Mac에서 0.5 MB/s). 그때는 조각을 여러 연결로 받아(조각마다 SHA-256 확인,
끊기면 이어 받기) 로컬 레지스트리로 넘긴다.

```sh
python3 oci_fetch.py <폴더> cirruslabs/macos-sonoma-vanilla latest 10
python3 oci_serve.py <폴더> cirruslabs/macos-sonoma-vanilla 5005 &
tart clone --insecure 127.0.0.1:5005/cirruslabs/macos-sonoma-vanilla:latest od-sonoma
```

## 2. 실행·설치

```sh
tart run od-sonoma --no-graphics --vnc-experimental --dir=xfer:<DMG가 있는 폴더>:ro > run.log &
grep -o 'vnc://[^ ]*' run.log > vnc.url          # Virtualization.framework의 VNC 서버(창 없음)
ssh admin@$(tart ip od-sonoma)                   # 비밀번호 admin
# 게스트 안에서: hdiutil attach -nobrowse -readonly -mountpoint /tmp/m "/Volumes/My Shared Files/xfer/<dmg>"
#               ditto /tmp/m/OrbitDrop.app /Applications/OrbitDrop.app; open -a /Applications/OrbitDrop.app
```

## 3. 드래그

```sh
python3 -m venv venv && venv/bin/pip install vncdotool
# Finder 아이콘을 집어 → 조금씩 움직이고 → Shift → JPG 조각(원 중심에서 오른쪽 117 pt)으로 → 놓기
venv/bin/python vmctl.py vnc.url "move 1375 405 ; down ; wait 0.3 ; drag 1350 408 3 0.03 ; drag 800 450 12 0.02 ; \
  keydown shift ; wait 0.6 ; drag 917 452 5 0.03 ; wait 0.5 ; shot wheel.png ; up ; keyup shift"
```

* 좌표는 VNC 프레임버퍼 **픽셀**이다. 2× 화면에서는 포인트 좌표의 두 배를 쓴다.
* **키 매핑(실측)**: VZ VNC 서버는 `alt` → **Command**, `meta` → **Option**으로 보낸다. 도구 휠(Option+Shift)은 `keydown meta ; keydown shift`.
* 한 번의 `vmctl.py` 실행 안에서 버튼을 누르고 놓는다(연결이 끊기면 버튼 상태를 보장할 수 없다). 스크린샷이 가끔 응답하지 않아 시간 제한과
  재시도를 넣었다.
* 화면 캡처에는 포인터 모양(Copy의 초록 +)이 찍히지 않는다. Ctrl+⌘+Q(화면 잠금)는 이 방식으로 동작하지 않았다.
* 결과 파일·로그는 SSH로 확인한다: `ls ~/Desktop`, `sips -g pixelWidth -g pixelHeight <파일>`,
  `~/Library/Application Support/OrbitDrop/logs/main.log`.

## 4. 정리

```sh
tart stop od-sonoma && tart delete od-sonoma && tart prune --entries caches
```
