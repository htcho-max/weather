"""행정구역 데이터(REGIONS)를 다시 만들어 index.html에 넣어요.

사용법:  python tools/build_regions.py [버전]      예) python tools/build_regions.py 20260201
- 원본: https://github.com/vuski/admdongkor (행정안전부 행정동 경계, 버전 폴더 verYYYYMMDD)
- 구조: [이름, 위도, 경도, 하위목록]  시/도 → 시/군/구 → 읍/면/동, 마지막에 '해외'
- 좌표: 동 = 경계 면적 중심 / 시군구 = 소속 동 중심점의 단순 평균 / 시도 = 시청·도청
"""
import json, re, sys, urllib.request, pathlib

ver = sys.argv[1] if len(sys.argv) > 1 else '20260201'
url = f'https://raw.githubusercontent.com/vuski/admdongkor/master/ver{ver}/HangJeongDong_ver{ver}.geojson'
print('내려받는 중:', url)
geo = json.load(urllib.request.urlopen(url))

def ring(r):
    a = cx = cy = 0
    for (x0, y0), (x1, y1) in zip(r, r[1:] + r[:1]):
        c = x0 * y1 - x1 * y0; a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c
    return a / 2, cx, cy

def centroid(g):
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    A = X = Y = 0
    for p in polys:
        a, cx, cy = ring(p[0]); A += a; X += cx; Y += cy
    return X / (6 * A), Y / (6 * A)

tree = {}
for f in geo['features']:
    p = f['properties']; x, y = centroid(f['geometry'])
    sgg = re.sub(r'^(.+?[시])(.+[구])$', r'\1 \2', p['sggnm'])      # 수원시장안구 → 수원시 장안구
    dong = p['adm_nm'].split(' ')[-1]
    tree.setdefault((p['sido'], p['sidonm']), {}).setdefault(sgg, []).append((dong, y, x))

HALL = {'서울특별시':(37.5665,126.9780),'부산광역시':(35.1798,129.0750),'대구광역시':(35.8714,128.6014),'인천광역시':(37.4563,126.7052),
'광주광역시':(35.1601,126.8514),'대전광역시':(36.3504,127.3845),'울산광역시':(35.5396,129.3115),'세종특별자치시':(36.4801,127.2890),
'경기도':(37.2894,127.0535),'충청북도':(36.6358,127.4914),'충청남도':(36.6588,126.6728),'전라남도':(34.8161,126.4629),
'경상북도':(36.5760,128.5056),'경상남도':(35.2383,128.6924),'제주특별자치도':(33.4890,126.4983),'강원특별자치도':(37.8853,127.7298),'전북특별자치도':(35.8203,127.1088)}

out = []
for (code, sido), sggs in sorted(tree.items()):
    lst = []
    for sgg, ds in sorted(sggs.items()):
        ds = sorted([n, round(a, 3), round(b, 3)] for n, a, b in ds)
        lst.append([sgg, round(sum(d[1] for d in ds)/len(ds), 3), round(sum(d[2] for d in ds)/len(ds), 3), ds])
    lat, lon = HALL.get(sido, (lst[0][1], lst[0][2]))
    out.append([sido, lat, lon, lst])

WORLD = [["일본",[["도쿄",35.68,139.69],["오사카",34.69,135.50],["후쿠오카",33.59,130.40],["삿포로",43.06,141.35],["오키나와(나하)",26.21,127.68]]],
["중국",[["베이징",39.90,116.40],["상하이",31.23,121.47],["칭다오",36.07,120.38]]],
["홍콩·대만",[["홍콩",22.32,114.17],["타이베이",25.03,121.57]]],
["동남아시아",[["방콕",13.76,100.50],["싱가포르",1.35,103.82],["하노이",21.03,105.85],["다낭",16.05,108.20],["세부",10.32,123.89],["발리",-8.65,115.22]]],
["미국",[["뉴욕",40.71,-74.01],["로스앤젤레스",34.05,-118.24],["샌프란시스코",37.77,-122.42],["하와이(호놀룰루)",21.31,-157.86],["괌",13.44,144.79]]],
["유럽",[["런던",51.51,-0.13],["파리",48.86,2.35],["로마",41.90,12.50],["바르셀로나",41.39,2.17],["베를린",52.52,13.40],["프라하",50.08,14.44]]],
["오세아니아",[["시드니",-33.87,151.21],["멜버른",-37.81,144.96],["오클랜드",-36.85,174.76]]]]
out.append(["해외", None, None, [[c, cs[0][1], cs[0][2], [[n, a, b, []] for n, a, b in cs]] for c, cs in WORLD]])

data = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
html = pathlib.Path(__file__).resolve().parent.parent / 'index.html'
src = html.read_text(encoding='utf-8')
new, n = re.subn(r'^const REGIONS = .*;$', lambda m: f'const REGIONS = {data};', src, count=1, flags=re.M)
assert n == 1, 'index.html에서 const REGIONS 줄을 찾지 못했어요'
html.write_text(new, encoding='utf-8')
print(f'완료: 시도 {len(out)-1}곳, 읍면동 {sum(len(s[3]) for d in out[:-1] for s in d[3])}곳 → index.html 갱신')
