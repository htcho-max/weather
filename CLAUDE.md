# 하늘 — 귀여운 날씨 웹앱 (Claude용 작업 안내)

이 폴더는 claude.ai 채팅에서 만든 날씨 앱입니다. 이전 대화 내용은 이 세션에서 보이지 않으니,
작업 전에 이 파일과 `NOTES.md`(기능·결정 기록)를 먼저 읽어 주세요.

## 한눈에
- 빌드 도구 없는 정적 웹앱. `index.html` 한 파일에 HTML·CSS·JS가 모두 들어 있음
- PWA: `manifest.webmanifest`, `sw.js`, 아이콘 4개. GitHub Pages(https)에 그대로 올려 사용 예정
- 데이터: Open-Meteo 무료 API (키 없음) + 선택 사항으로 기상청 공식 데이터(중계 서버 `worker/kma-worker.js`, 설정에 주소 저장)
- 사용자는 한국어 사용자. UI 문구·주석 모두 한국어, 존댓말 '-요'체

## 파일
| 파일 | 내용 |
|---|---|
| `index.html` | 앱 전체. 약 2,090줄 |
| `sw.js` | 서비스 워커. 앱 화면은 네트워크 우선, 아이콘은 캐시 우선, 글꼴은 stale-while-revalidate. API 요청은 건드리지 않음. 아이콘을 바꾸면 `VERSION`을 올릴 것 |
| `manifest.webmanifest` | 앱 이름 "하늘", 테마색 #a8d4ff |
| `icon-192/512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | 웃는 해 마스코트 아이콘 |
| `worker/kma-worker.js`, `wrangler.toml`, `설정방법.md` | 기상청 중계 서버(Cloudflare Worker)와 사용자용 설정 안내 |
| `tools/build_regions.py` | 행정구역 데이터(REGIONS) 다시 만들기 |
| `tools/mock.js`, `tools/test.py` | 가짜 API로 화면·동작 확인 (Playwright) |

## index.html 다룰 때 주의
- **342번째 줄 `const REGIONS = [...]` 한 줄이 약 110KB**(전국 3,558개 읍면동 좌표). 파일 전체를 출력하지 말고
  `grep -n`, 줄 범위 지정 읽기로 필요한 부분만 볼 것. 수정할 때도 이 줄은 건드리지 말 것
- 구조(위→아래): `<head>`(글꼴: 구글 Jua + jsDelivr Pretendard) → `<style>`(파스텔 다꾸 디자인) → 본문 섹션들
  → `<script>`: REGIONS → 공통 유틸(store, 단위, wmo, icon, buddy 마스코트) → fetchPlace → makePicker
  → 즐겨찾기 → load(메인) → 옷차림·공기·해·24시간·7일 → 모델 비교 → 기상청 공식(loadKma·renderObs·kmaSeries·설정) → 다른 지역 비교 → SunCalc(달 계산, BSD)
  → 현지시각·평년·출퇴근·생활지수·달·성적표·주말 → 단위 → 화면 구성(카드 순서) → 서비스워커 등록 → 시작
- 본문 카드는 `<section data-unit="...">`. 순서/숨김은 `UNITS`, `layout`, `applyLayout()`이 관리.
  새 카드를 추가하면 `UNITS`에도 넣을 것 (저장된 배치가 있으면 맨 뒤에 자동 추가됨)
- 색은 모두 `:root` CSS 변수 + `@media (prefers-color-scheme: dark)` 재정의. 하늘 배경은 `body[data-sky]`
- 주아체(Jua)는 굵기가 하나뿐 → Jua 쓰는 요소에 `font-weight:600` 주지 말 것
- 브라우저 저장소 키는 모두 `weather:` 접두사 (NOTES.md 참고)

## 확인 방법
```bash
pip install playwright && python -m playwright install chromium
python tools/test.py            # 가짜 API로 열어서 화면 캡처 + 오류 확인 (screenshots/ 생성, kma.png는 기상청 연결 상태)
node --input-type=module -e "import w from './worker/kma-worker.js'; console.log(w._test.toGrid(37.5665,126.978))"   # {nx:60, ny:127}
```
실제 API 호출 확인은 사용자가 브라우저에서 직접 열어 보는 방식으로 해 왔음.
