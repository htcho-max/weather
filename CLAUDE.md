# 하늘 — 귀여운 날씨 웹앱 (Claude용 작업 안내)

이 폴더는 claude.ai 채팅에서 만든 날씨 앱입니다. 이전 대화 내용은 이 세션에서 보이지 않으니,
작업 전에 이 파일과 `NOTES.md`(기능·결정 기록)를 먼저 읽어 주세요.

## 한눈에
- 빌드 도구 없는 정적 웹앱. `index.html` 한 파일에 HTML·CSS·JS가 모두 들어 있음
- PWA: `manifest.webmanifest`, `sw.js`, 아이콘 4개. https://htcho-max.github.io/weather/ (저장소 htcho-max/weather)
- 배포: main에 push → GitHub Actions(`.github/workflows/pages.yml`)가 앱 파일만 골라 Pages에 올림. 앱에 새 파일을 추가하면 이 파일의 cp 줄도 고칠 것
- 데이터: Open-Meteo 무료 API (키 없음) + 선택 사항으로 기상청 공식 데이터(중계 서버 `worker/kma-worker.js`, 설정에 주소 저장)
- 사용자는 한국어 사용자. UI 문구·주석 모두 한국어, 존댓말 '-요'체

## 파일
| 파일 | 내용 |
|---|---|
| `index.html` | 앱 전체. 약 2,600줄 |
| `sw.js` | 서비스 워커. 앱 화면은 네트워크 우선, 아이콘은 캐시 우선, 글꼴은 stale-while-revalidate. API 요청은 건드리지 않음. 출퇴근 비 알림 push·notificationclick 처리. 아이콘을 바꾸면 `VERSION`을 올릴 것 |
| `manifest.webmanifest` | 앱 이름 "하늘", 테마색 #a8d4ff |
| `icon-192/512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | 웃는 해 마스코트 아이콘 |
| `worker/kma-worker.js`, `wrangler.toml`, `설정방법.md` | 기상청 중계 서버(Cloudflare Worker: 관측·초단기·단기예보·특보·에어코리아 미세먼지·관측 기록·웹 푸시 알림)와 사용자용 설정 안내. 실제 배포본은 사용자가 대시보드에 붙여넣음 → 코드 바꾸면 다시 붙여넣기 안내 |
| `tools/build_regions.py` | 행정구역 데이터(REGIONS) 다시 만들기 |
| `tools/mock.js`, `tools/test.py` | 가짜 API로 화면·동작 확인 (Playwright) |

## index.html 다룰 때 주의
- **`const REGIONS = [...]` 한 줄(지금 약 440번째 줄, `grep -n '^const REGIONS'`로 확인)이 약 110KB**(전국 3,558개 읍면동 좌표). grep 결과에 이 줄이 섞이면 출력이 폭발하니 `| grep -v '^줄번호:'`로 빼고 볼 것. 파일 전체를 출력하지 말고
  `grep -n`, 줄 범위 지정 읽기로 필요한 부분만 볼 것. 수정할 때도 이 줄은 건드리지 말 것
- 구조(위→아래): `<head>`(글꼴: 구글 Jua + jsDelivr Pretendard) → `<style>`(파스텔 다꾸 디자인) → 본문 섹션들
  → `<script>`: REGIONS → 공통 유틸(store, 단위, wmo, icon, buddy 마스코트) → fetchPlace → makePicker
  → 즐겨찾기 → load(메인) → 옷차림·공기·해·24시간(renderHourly)·오늘 남은 하늘(renderLater)·비눈 효과(renderFx)·7일 → 모델 비교(기관 고르기 cmpOff) → 기상청 공식(loadKma·renderObs·skyKind·hourAt·에어코리아 loadAir·특보 loadWarn·kmaSeries·설정) → 비 알림(rain*) → 공유 이미지(makeShareImage) → 다른 지역 비교 → SunCalc(달 계산, BSD)
  → 현지시각·평년·출퇴근·생활지수·달·성적표·주말 → 단위 → 화면 구성(카드 순서) → 간단 보기(simpleAnswer·renderSimple) → 화면 테마 → 설정 창(startMode·openSettings) → 서비스워커 등록 → 시작
- 설정 UI는 모두 `<dialog id="setDlg">` 안(`.setBlock`). 본문 카드는 `#updated`(바닥글) 앞에 배치됨
- 본문 카드는 `<section data-unit="...">`. 순서/숨김은 `UNITS`, `layout`, `applyLayout()`이 관리.
  새 카드를 추가하면 `UNITS`에도 넣을 것 (저장된 배치가 있으면 맨 뒤에 자동 추가됨)
- 색은 모두 `:root` CSS 변수. 다크는 `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) }`와 `:root[data-theme="dark"]` **두 곳 모두** 고칠 것(설정 '화면 테마'). 하늘 배경은 `body[data-sky]`, 머리 영역 어두운 칩은 `body.skyDark`
- 하늘 영역 마스코트(buddy: 해·달·구름)는 사용자가 좋아하는 그림 → 바꾸지 말 것. 간단 보기는 `body.simple` 클래스로 CSS만 숨김/보임
- 주아체(Jua)는 굵기가 하나뿐 → Jua 쓰는 요소에 `font-weight:600` 주지 말 것
- 브라우저 저장소 키는 모두 `weather:` 접두사 (NOTES.md 참고)

## 확인 방법
```bash
pip install playwright && python -m playwright install chromium
python tools/test.py            # 가짜 API로 열어서 화면 캡처 + 오류 확인 (screenshots/ 생성, kma.png는 기상청 연결 상태)
node --input-type=module -e "import w from './worker/kma-worker.js'; console.log(w._test.toGrid(37.5665,126.978))"   # {nx:60, ny:127}
# Worker의 특보 매칭·비 판단·푸시 암호화는 w._test로 직접 확인 가능 (암호화는 npm http_ece로 복호화해 검증했음)
```
실제 API 호출 확인은 사용자가 브라우저에서 직접 열어 보는 방식으로 해 왔음.
