"""가짜 API(tools/mock.js)로 앱을 열어 오류를 확인하고 화면을 캡처해요.
사용법: python tools/test.py   →  screenshots/ 폴더에 밝은·어두운 화면 저장
실제 네트워크 요청은 하지 않아요. mock.js의 window.__offline=true 로 오프라인도 흉내 낼 수 있어요."""
import pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
mock = (root / 'tools' / 'mock.js').read_text(encoding='utf-8')
out = root / 'screenshots'; out.mkdir(exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    # 마지막은 기상청 중계 서버를 연결한 상태 (가짜 주소)
    for name, scheme, kma in [('light', 'light', False), ('dark', 'dark', False), ('kma', 'light', True)]:
        pg = b.new_page(viewport={'width': 400, 'height': 900}, color_scheme=scheme)
        if kma: pg.add_init_script("localStorage.setItem('weather:kma', JSON.stringify({url:'https://kma.example'}))")
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.add_init_script(mock)
        pg.goto((root / 'index.html').as_uri()); pg.wait_for_timeout(1500)
        pg.screenshot(path=str(out / f'{name}.png'), full_page=True)
        calls = pg.evaluate('__calls.length')
        print(f'[{name}] API 요청 {calls}번, 오류 {len(errs)}개', *errs, sep='\n  ')
        if kma: print('  관측 줄:', pg.inner_text('#obs'), '/ 비교 범례:', pg.inner_text('#legend').replace(chr(10), ' | '))
        pg.close()
    b.close()
