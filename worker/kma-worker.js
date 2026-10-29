// 하늘 앱 — 기상청 공식 데이터 중계 서버 (Cloudflare Workers)
//
// 하는 일
//  - 공공데이터포털 기상청 API를 대신 불러서 앱이 쓰기 쉬운 모양으로 돌려줘요.
//  - 인증키는 Worker 환경변수(KMA_KEY)에만 있어요. 앱(브라우저)에는 키가 드러나지 않아요.
//  - 브라우저가 직접 부를 수 있게 CORS 헤더를 붙여요.
//  - (선택) 출퇴근 비 알림: 구독을 KV에 저장하고, 매시 예약 실행(cron)으로 확인해 웹 푸시를 보내요.
//
// 주소
//  GET  /                           상태 확인 {ok, keySet, push}
//  GET  /now?lat=&lon=              초단기실황(지금 관측) + 초단기예보(앞으로 6시간)
//  GET  /fcst?lat=&lon=             단기예보(약 4~5일) + 일 최고·최저
//  GET  /warn?sido=&sigungu=&dong= 기상특보 현황 중 그 지역에 해당하는 것 ('기상청_기상특보 조회서비스' 활용신청 필요)
//  GET  /obs?lat=&lon=              그 격자의 지난 날짜별 관측 최고·최저·강수 (매시 예약 실행이 쌓아요, KV 필요)
//  GET  /air?lat=&lon=              가장 가까운 에어코리아 측정소의 실시간 미세먼지 ('에어코리아 대기오염정보'·'측정소정보' 활용신청 필요)
//  GET  /push/key                   웹 푸시 공개키 (처음 부를 때 자동으로 만들어 KV에 저장)
//  POST /push/subscribe             {sub, name, lat, lon, go, back} 알림 구독 저장·갱신
//  POST /push/unsubscribe           {endpoint}
//  POST /push/test                  {endpoint} 지금 바로 시험 알림
//
// 환경변수·연결
//  KMA_KEY          (필수, 비밀) 공공데이터포털 인증키
//  ALLOWED_ORIGINS  (선택) 앱 주소를 쉼표로. 예: https://아이디.github.io  (비우면 모두 허용)
//  PUSH             (알림용, KV 연결) Worker 설정 → 바인딩 → KV 네임스페이스, 변수 이름 PUSH
//  예약 실행        (알림·관측 기록용) Worker 설정 → 트리거 → Cron: 5 * * * *  (매시 5분)

const VILAGE = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const WARN = 'https://apis.data.go.kr/1360000/WthrWrnInfoService';
const AIR = 'https://apis.data.go.kr/B552584';
const memo = new Map();   // 같은 요청 응답을 잠깐 기억 (Worker가 살아 있는 동안만)

export default {
  // 테스트용 (Cloudflare는 fetch·scheduled만 써요)
  _test: {
    toGrid: (...a) => toGrid(...a), nowBase: (...a) => nowBase(...a), fcstBase: (...a) => fcstBase(...a), ultraBase: (...a) => ultraBase(...a),
    amount: (...a) => amount(...a), matchWarnings: (...a) => matchWarnings(...a), rainCheck: (...a) => rainCheck(...a),
    encryptPayload: (...a) => encryptPayload(...a), vapidJwt: (...a) => vapidJwt(...a), memo,
    recordObs: (...a) => recordObs(...a), obsDays: (...a) => obsDays(...a), getAir: (...a) => getAir(...a), airSido: (...a) => airSido(...a),
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = !allowed.length ? '*' : allowed.includes(origin) ? origin : null;
    const cors = allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin' } : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (origin && !allowOrigin) return json({ ok: false, error: '허용되지 않은 사이트에서 온 요청이에요' }, 403, cors);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/') return json({ ok: true, service: 'haneul-kma', keySet: !!env.KMA_KEY, push: !!env.PUSH }, 200, cors);
      if (path.startsWith('/push/')) return json(await handlePush(path, request, env), 200, cors);
      if (request.method !== 'GET') return json({ ok: false, error: 'GET 요청만 받아요' }, 405, cors);
      if (!env.KMA_KEY) return json({ ok: false, error: 'Worker에 KMA_KEY(인증키)가 설정되지 않았어요' }, 500, cors);

      if (path === '/warn') {
        const out = await getWarn(env.KMA_KEY, url.searchParams.get('sido') || '', url.searchParams.get('sigungu') || '', url.searchParams.get('dong') || '');
        return json({ ok: true, ...out }, 200, { ...cors, 'Cache-Control': 'public, max-age=300' });
      }
      if (path === '/air') {
        const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
        if (!isFinite(lat) || !isFinite(lon)) throw fail('lat, lon 값이 필요해요');
        return json({ ok: true, ...(await getAir(env, lat, lon)) }, 200, { ...cors, 'Cache-Control': 'public, max-age=600' });
      }
      if (path === '/obs') {
        if (!env.PUSH) throw fail('Worker에 저장소(KV, 이름 PUSH)가 연결되지 않았어요', 500);
        const g = gridOf(url.searchParams.get('lat'), url.searchParams.get('lon'));
        await touchGrid(env, g);
        return json({ ok: true, nx: g.nx, ny: g.ny, days: await obsDays(env, g) }, 200, { ...cors, 'Cache-Control': 'public, max-age=900' });
      }
      if (path !== '/now' && path !== '/fcst') return json({ ok: false, error: '없는 주소예요 (/now, /fcst, /warn, /obs)' }, 404, cors);

      const g = gridOf(url.searchParams.get('lat'), url.searchParams.get('lon'));
      if (path === '/now' && env.PUSH) await touchGrid(env, g).catch(() => {});
      const out = path === '/now' ? await getNow(env.KMA_KEY, g.nx, g.ny) : await getFcst(env.KMA_KEY, g.nx, g.ny);
      return json({ ok: true, nx: g.nx, ny: g.ny, ...out }, 200, { ...cors, 'Cache-Control': `public, max-age=${path === '/now' ? 300 : 900}` });
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, e.status || 502, cors);
    }
  },

  // 예약 실행 (매시): 출퇴근 비 알림
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([runAlerts(env), recordObs(env)]));
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ---------- 위경도 → 기상청 격자 (Lambert 정각원추도법, 기상청 공개 공식) ---------- */
function toGrid(lat, lon) {
  const RE = 6371.00877, GRID = 5.0, SLAT1 = 30.0, SLAT2 = 60.0, OLON = 126.0, OLAT = 38.0, XO = 43, YO = 136;
  const D = Math.PI / 180, re = RE / GRID;
  const s1 = SLAT1 * D, s2 = SLAT2 * D, olon = OLON * D, olat = OLAT * D;
  let sn = Math.tan(Math.PI * 0.25 + s2 * 0.5) / Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sn = Math.log(Math.cos(s1) / Math.cos(s2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + s1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(s1) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = re * sf / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * D * 0.5);
  ra = re * sf / Math.pow(ra, sn);
  let theta = lon * D - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}
function gridOf(latS, lonS) {
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (!isFinite(lat) || !isFinite(lon)) throw fail('lat, lon 값이 필요해요');
  const g = toGrid(lat, lon);
  if (g.nx < 1 || g.nx > 149 || g.ny < 1 || g.ny > 253) throw fail('기상청 예보 범위(한반도) 밖이에요');
  return g;
}

/* ---------- 발표 시각 계산 (한국 시각) ---------- */
const kstNow = () => new Date(Date.now() + 9 * 3600e3);          // getUTC*로 읽으면 한국 시각
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const pad = n => String(n).padStart(2, '0');

// 초단기실황: 매시 정각 자료가 약 40분 뒤에 나와요
function nowBase(d = kstNow(), back = 0) {
  const t = new Date(d.getTime() - (d.getUTCMinutes() < 40 ? 3600e3 : 0) - back * 3600e3);
  return { date: ymd(t), time: pad(t.getUTCHours()) + '00' };
}
// 초단기예보: 매시 30분 발표, 약 45분 뒤에 나와요
function ultraBase(d = kstNow(), back = 0) {
  const t = new Date(d.getTime() - (d.getUTCMinutes() < 45 ? 3600e3 : 0) - back * 3600e3);
  return { date: ymd(t), time: pad(t.getUTCHours()) + '30' };
}
// 단기예보: 02·05·08·11·14·17·20·23시 발표, 약 10분 뒤에 나와요
function fcstBase(d = kstNow(), back = 0) {
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  const hours = [2, 5, 8, 11, 14, 17, 20, 23];
  let i = hours.filter(h => h * 60 + 10 <= m).length - 1 - back;
  let day = d;
  while (i < 0) { i += hours.length; day = new Date(day.getTime() - 864e5); }
  return { date: ymd(day), time: pad(hours[i]) + '00' };
}

/* ---------- 공공데이터포털 호출 ---------- */
async function callApi(key, url, params, ttl = 10 * 60e3) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const id = `${url}?${qs}`;
  const hit = memo.get(id);
  if (hit && Date.now() - hit.at < ttl) return hit.items;
  const k = key.includes('%') ? key : encodeURIComponent(key);
  const res = await fetch(`${id}&serviceKey=${k}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  // 인증 오류 등은 dataType=JSON이어도 XML로 와요
  if (text.trim().startsWith('<')) {
    const msg = (text.match(/<returnAuthMsg>([^<]*)</) || text.match(/<errMsg>([^<]*)</) || text.match(/<resultMsg>([^<]*)</) || [])[1] || `응답 ${res.status}`;
    throw new Error(explain(msg));
  }
  if (!res.ok && !text.trim().startsWith('{')) throw new Error(explain(text.trim().slice(0, 80) || `응답 ${res.status}`));
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`기상청 응답을 읽지 못했어요 (${res.status})`); }
  const h = j?.response?.header;
  if (h?.resultCode === '03') return null;                        // NO_DATA: 아직 발표 전이거나 해당 자료 없음
  if (h?.resultCode !== '00') throw new Error(explain(h?.resultMsg || '알 수 없는 오류'));
  let items = j.response.body?.items?.item || j.response.body?.items || [];
  if (!Array.isArray(items)) items = [items];
  memo.set(id, { at: Date.now(), items });
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  return items;
}
const callVilage = (key, op, base, nx, ny, rows) =>
  callApi(key, `${VILAGE}/${op}`, { pageNo: 1, numOfRows: rows, dataType: 'JSON', base_date: base.date, base_time: base.time, nx, ny });

function explain(msg) {
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE KEY IS NOT REGISTERED/i.test(msg)) return '인증키가 등록되지 않았어요. 키 값을 확인하거나, 발급 직후라면 1~2시간 뒤 다시 해 보세요';
  if (/ACCESS DENIED|ACCESS_DENIED|Unauthorized|Forbidden/i.test(msg)) return '이 기상청 서비스의 활용신청이 필요해요';
  if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|EXCEEDS/i.test(msg)) return '오늘 쓸 수 있는 요청 수를 다 썼어요';
  if (/DEADLINE|EXPIRED/i.test(msg)) return '인증키 활용 기간이 끝났어요';
  return `기상청 API 오류: ${msg}`;
}

// 강수량·적설 글자 → 숫자 (예: "강수없음" 0, "1mm 미만" 0.5, "30.0~50.0mm" 40, "50.0mm 이상" 50)
function amount(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/없음/.test(s) || s === '-' || s === '') return 0;
  const nums = (s.match(/[\d.]+/g) || []).map(Number);
  if (!nums.length) return null;
  if (/미만/.test(s)) return nums[0] / 2;
  if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
  return nums[0];
}
const num = v => { const x = parseFloat(v); return isFinite(x) && x > -900 && x < 900 ? x : null; };   // -999 등 결측 제거
const iso = (d, t) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:00`;

/* ---------- 지금 관측값 + 앞으로 6시간 ---------- */
async function getNow(key, nx, ny) {
  let out = null;
  for (let back = 0; back < 3 && !out; back++) {
    const base = nowBase(kstNow(), back);
    const items = await callVilage(key, 'getUltraSrtNcst', base, nx, ny, 20);
    if (!items || !items.length) continue;
    const v = {}; items.forEach(it => { v[it.category] = it.obsrValue; });
    if (num(v.T1H) == null) continue;
    out = { base: iso(base.date, base.time), obs: { t: num(v.T1H), rh: num(v.REH), wind: num(v.WSD), vec: num(v.VEC), rain1h: amount(v.RN1), pty: num(v.PTY) ?? 0 } };
  }
  if (!out) throw new Error('최근 3시간 안의 관측 자료가 없어요');
  out.ultra = await getUltra(key, nx, ny).catch(() => null);   // 실패해도 관측값은 보내요
  return out;
}
async function getUltra(key, nx, ny) {
  for (let back = 0; back < 2; back++) {
    const base = ultraBase(kstNow(), back);
    const items = await callVilage(key, 'getUltraSrtFcst', base, nx, ny, 60);
    if (!items || !items.length) continue;
    const H = new Map();
    items.forEach(it => { const t = iso(it.fcstDate, it.fcstTime); if (!H.has(t)) H.set(t, {}); H.get(t)[it.category] = it.fcstValue; });
    const time = [...H.keys()].sort();
    const col = (k, f) => time.map(t => f(H.get(t)[k]));
    return { base: iso(base.date, base.time).slice(0, 14) + base.time.slice(2), time,
      t: col('T1H', num), rain: col('RN1', amount), sky: col('SKY', num), pty: col('PTY', num), reh: col('REH', num), wsd: col('WSD', num), vec: col('VEC', num), lgt: col('LGT', num) };
  }
  return null;
}

/* ---------- 단기예보 ---------- */
async function getFcst(key, nx, ny) {
  for (let back = 0; back < 2; back++) {
    const base = fcstBase(kstNow(), back);
    const items = await callVilage(key, 'getVilageFcst', base, nx, ny, 2000);
    if (!items || !items.length) continue;
    const H = new Map(), tmx = new Map(), tmn = new Map();
    items.forEach(it => {
      const t = iso(it.fcstDate, it.fcstTime), day = t.slice(0, 10);
      if (it.category === 'TMX') { tmx.set(day, num(it.fcstValue)); return; }
      if (it.category === 'TMN') { tmn.set(day, num(it.fcstValue)); return; }
      if (!H.has(t)) H.set(t, {});
      H.get(t)[it.category] = it.fcstValue;
    });
    const times = [...H.keys()].sort();
    const col = (k, f) => times.map(t => f(H.get(t)[k]));
    const days = [...new Set([...times.map(t => t.slice(0, 10)), ...tmx.keys(), ...tmn.keys()])].sort();
    return {
      base: iso(base.date, base.time),
      hourly: {
        time: times,
        tmp: col('TMP', num), pop: col('POP', num), pcp: col('PCP', amount), sno: col('SNO', amount),
        sky: col('SKY', num), pty: col('PTY', num), reh: col('REH', num), wsd: col('WSD', num), vec: col('VEC', num),
      },
      daily: { time: days, tmx: days.map(d => tmx.get(d) ?? null), tmn: days.map(d => tmn.get(d) ?? null) },
    };
  }
  throw new Error('단기예보 자료를 받지 못했어요');
}

/* ---------- 기상특보 ---------- */
// 특보 현황(getPwnStatus)의 글을 읽어 그 지역에 해당하는 특보만 골라요.
// 글 모양 예: "o 건조주의보 : 서울, 인천, 강원도(강릉시평지, 동해시평지), 경상북도(포항, 경주)"
async function getWarn(key, sido, sigungu, dong) {
  const items = await callApi(key, `${WARN}/getPwnStatus`, { pageNo: 1, numOfRows: 10, dataType: 'JSON' }, 5 * 60e3);
  const it = (items || [])[0] || {};
  const tm = String(it.tmFc || '');
  const m = matchWarnings(String(it.t6 || ''), String(it.t7 || ''), sido, sigungu, dong);
  return { tmFc: tm.length >= 12 ? `${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}T${tm.slice(8, 10)}:${tm.slice(10, 12)}` : null, ...m };
}
const SIDO_ALIAS = { 경기: ['경기도', '경기'], 강원: ['강원도', '강원'], 충청북: ['충청북도', '충북'], 충청남: ['충청남도', '충남'], 전북: ['전라북도', '전북'],
  전라북: ['전라북도', '전북'], 전라남: ['전라남도', '전남', '전남광주'], 광주: ['광주', '전남광주'], 경상북: ['경상북도', '경북'], 경상남: ['경상남도', '경남'], 제주: ['제주도', '제주'] };
// 시/군보다 잘게 나뉜 특보구역 (기상청 날씨누리 특보구역 안내, 2024~2026 세분화 기준)
// 시/도 줄임말 → 구역 이름 → (시군구, 읍면동) 판별
const inGu = (...gu) => (sg) => gu.includes(sg.replace(/^\S+시\s+/, '').trim()) || gu.includes(sg.trim());
const startsAny = (dong, list) => list.some(x => dong.startsWith(x));
const ZONES = {
  서울: {
    서울동남권: inGu('강동구', '송파구', '강남구', '서초구'),
    서울동북권: inGu('도봉구', '노원구', '강북구', '성북구', '동대문구', '중랑구', '성동구', '광진구'),
    서울서남권: inGu('강서구', '양천구', '구로구', '영등포구', '동작구', '관악구', '금천구'),
    서울서북권: inGu('은평구', '종로구', '마포구', '서대문구', '중구', '용산구'),
  },
  부산: {
    부산동부: inGu('기장군', '해운대구', '수영구', '남구'),
    부산중부: inGu('금정구', '동래구', '연제구', '부산진구', '사상구', '북구'),
    부산서부: inGu('강서구', '사하구', '서구', '중구', '동구', '영도구'),
  },
  인천: {
    인천영종: (sg, d) => sg === '중구' && startsAny(d, ['영종', '운서', '용유']),
    인천남부: (sg, d) => ['동구', '미추홀구', '연수구', '남동구'].includes(sg) || (sg === '중구' && !startsAny(d, ['영종', '운서', '용유'])),
    인천북부: inGu('서구', '부평구', '계양구'),
    강화: inGu('강화군'),
    옹진: (sg, d) => sg === '옹진군' && !startsAny(d, ['백령', '대청', '연평']),
    서해5도: (sg, d) => sg === '옹진군' && startsAny(d, ['백령', '대청', '연평']),
    '백령도.대청도': (sg, d) => sg === '옹진군' && startsAny(d, ['백령', '대청']),
    '연평도.우도': (sg, d) => sg === '옹진군' && startsAny(d, ['연평']),
  },
  경기: {
    용인서북부: (sg) => /기흥구|수지구/.test(sg),
    용인동북부: (sg, d) => /처인구/.test(sg) && (startsAny(d, ['포곡', '모현', '양지']) || /동$/.test(d)),
    용인남부: (sg, d) => /처인구/.test(sg) && startsAny(d, ['이동', '남사', '원삼', '백암']),
    파주동북부: (sg, d) => /파주/.test(sg) && startsAny(d, ['문산', '법원', '파주읍', '적성', '파평']),
    파주서북부: (sg, d) => /파주/.test(sg) && startsAny(d, ['장단', '군내', '진서', '진동']),
    파주남부: (sg, d) => /파주/.test(sg) && (startsAny(d, ['조리', '광탄', '탄현', '월롱']) || /동$/.test(d)),
  },
};
function splitTop(s) {   // 괄호 밖의 쉼표로만 나눠요
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '，') && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function matchWarnings(t6, t7, sido, sigungu, dong = '') {
  const key = sido.replace(/(특별자치시|특별자치도|특별시|광역시|도)$/, '');
  const alias = SIDO_ALIAS[key] || [key];
  const zones = ZONES[key] || {};
  const metro = /(특별시|광역시|특별자치시)$/.test(sido);
  const city = (sigungu.split(/\s+/)[0] || '').replace(/(시|군|구)$/, '');
  // 구역 이름 하나가 내 동네에 해당하나: 'yes' | 'no' | null(모름)
  const zoneHit = name => {
    const z = zones[name.replace(/\s/g, '')];
    if (z) return sigungu && z(sigungu.trim(), dong.trim()) ? 'yes' : (sigungu ? 'no' : null);
    if (city && (name.startsWith(city) || name.includes(city))) return 'yes';
    return null;
  };
  const lines = t6.replace(/\r/g, '').split(/\n|(?=o\s)/).map(s => s.trim()).filter(Boolean);
  const active = []; let nation = 0;
  for (const ln of lines) {
    const m = ln.match(/^o?\s*([^:：]+?)\s*[:：]\s*(.+)$/);
    if (!m || /없음/.test(m[1])) continue;
    const name = m[1].trim();
    nation++;
    let hit = null;
    for (const area of splitTop(m[2])) {
      const am = area.match(/^([^(]+?)\s*(?:\((.*)\))?$/);
      if (!am) continue;
      const head = am[1].trim();
      // "서울동남권"처럼 구역 이름이 바로 나온 경우
      const direct = zones[head.replace(/\s/g, '')] ? zoneHit(head) : null;
      if (direct === 'yes') { hit = 'all'; break; }
      if (direct === 'no') continue;
      if (!alias.some(a => head.startsWith(a))) continue;
      if (!am[2]) { hit = 'all'; break; }
      const res = am[2].split(/[,，]/).map(s => zoneHit(s.trim()));
      if (res.includes('yes')) { hit = 'all'; break; }
      if (res.every(r => r === 'no')) continue;          // 알고 있는 구역만 나왔고 모두 아님
      if (metro || !city) hit = hit || 'part';          // 모르는 권역 이름이 섞이면 '일부 지역'
    }
    if (hit) active.push({ name, part: hit === 'part' });
  }
  const prelim = t7.replace(/\r/g, '').split(/\n/).map(s => s.trim())
    .filter(s => s && !/없음/.test(s) && alias.some(a => s.includes(a))).slice(0, 4);
  return { active, prelim, nation };
}

/* ---------- 에어코리아 실시간 미세먼지 ---------- */
// 측정소 목록(위경도 포함)은 KV에 7일 보관, 실시간 값은 시/도 단위로 한 번에 받아 그중 가까운 측정소를 골라요.
const SIDO_SHORT = [['서울','서울'],['부산','부산'],['대구','대구'],['인천','인천'],['광주','광주'],['대전','대전'],['울산','울산'],['세종','세종'],
  ['경기','경기'],['강원','강원'],['충청북','충북'],['충북','충북'],['충청남','충남'],['충남','충남'],['전라북','전북'],['전북','전북'],
  ['전라남','전남'],['전남','전남'],['경상북','경북'],['경북','경북'],['경상남','경남'],['경남','경남'],['제주','제주']];
function airSido(addr) { const t = String(addr || '').trim(); const m = SIDO_SHORT.find(([k]) => t.startsWith(k)); return m ? m[1] : null; }
const km = (a, b, c, d) => { const R = 6371, D = Math.PI / 180, x = (d - b) * D * Math.cos((a + c) / 2 * D), y = (c - a) * D; return R * Math.sqrt(x * x + y * y); };
async function airStations(env) {
  const hit = memo.get('air:stations');
  if (hit && Date.now() - hit.at < 864e5) return hit.items;
  let list = env.PUSH ? await env.PUSH.get('air:stations', 'json') : null;
  if (!list || Date.now() - list.at > 7 * 864e5) {
    const items = await callApi(env.KMA_KEY, `${AIR}/MsrstnInfoInqireSvc/getMsrstnList`, { returnType: 'json', numOfRows: 1000, pageNo: 1 }, 864e5)
      .catch(e => { throw new Error(/활용신청|등록되지/.test(e.message) ? '에어코리아 측정소정보 활용신청이 필요해요' : e.message); });
    const st = (items || []).map(it => {
      const a = parseFloat(it.dmX), b = parseFloat(it.dmY);
      if (!isFinite(a) || !isFinite(b)) return null;
      const [lat, lon] = a < b ? [a, b] : [b, a];          // 위도(33~39)가 경도(124~132)보다 작아요
      return [it.stationName, lat, lon, airSido(it.addr), it.addr || ''];
    }).filter(x => x && x[3]);
    if (!st.length) throw new Error('에어코리아 측정소 목록이 비어 있어요');
    list = { at: Date.now(), st };
    if (env.PUSH) await env.PUSH.put('air:stations', JSON.stringify(list)).catch(() => {});
  }
  memo.set('air:stations', { at: Date.now(), items: list.st });
  return list.st;
}
const airNum = v => { const x = parseFloat(v); return isFinite(x) && x >= 0 ? x : null; };   // '-'(점검·미수신) 제외
async function getAir(env, lat, lon) {
  if (!env.KMA_KEY) throw fail('Worker에 KMA_KEY(인증키)가 설정되지 않았어요', 500);
  const near = (await airStations(env)).map(s => ({ s, d: km(lat, lon, s[1], s[2]) })).sort((a, b) => a.d - b.d).slice(0, 4);
  if (!near.length || near[0].d > 40) throw fail('가까운 대기질 측정소가 없어요', 404);
  const bySido = {};
  for (const { s, d } of near) {
    if (!bySido[s[3]]) bySido[s[3]] = await callApi(env.KMA_KEY, `${AIR}/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty`,
      { returnType: 'json', numOfRows: 200, pageNo: 1, sidoName: s[3], ver: '1.3' }, 10 * 60e3)
      .catch(e => { throw new Error(/활용신청|등록되지/.test(e.message) ? '에어코리아 대기오염정보 활용신청이 필요해요' : e.message); });
    const it = (bySido[s[3]] || []).find(x => x.stationName === s[0]);
    if (!it) continue;
    const pm10 = airNum(it.pm10Value), pm25 = airNum(it.pm25Value);
    if (pm10 == null && pm25 == null) continue;            // 점검 중이면 다음으로 가까운 측정소
    return { station: s[0], addr: s[4], dist: Math.round(d * 10) / 10, dataTime: it.dataTime || null,
      pm10, pm25, pm10Grade: airNum(it.pm10Grade), pm25Grade: airNum(it.pm25Grade), khai: airNum(it.khaiValue), khaiGrade: airNum(it.khaiGrade), o3: airNum(it.o3Value) };
  }
  throw new Error('가까운 측정소들이 지금 점검 중이거나 값을 보내지 않고 있어요');
}

/* ---------- 관측 기록 (성적표 채점용) ---------- */
// 앱이 /now·/obs로 부른 격자를 'grids'에 적어 두고, 매시 예약 실행 때 초단기실황(정시 관측)을 쌓아요.
// obs:nx,ny = { "2026-10-29": { t: {"07": 12.3, ...}, r: {"07": 0, ...} }, ... }  (45일 보관)
const kstDay = () => kstNow().toISOString().slice(0, 10);
async function touchGrid(env, g) {
  const grids = (await env.PUSH.get('grids', 'json')) || {};
  const k = `${g.nx},${g.ny}`, today = kstDay();
  if (grids[k] === today) return;
  grids[k] = today;
  await env.PUSH.put('grids', JSON.stringify(grids));
}
async function recordObs(env) {
  if (!env.PUSH || !env.KMA_KEY) return;
  const grids = (await env.PUSH.get('grids', 'json')) || {};
  const cut = new Date(Date.now() + 9 * 3600e3 - 10 * 864e5).toISOString().slice(0, 10);
  let changed = false;
  for (const [k, seen] of Object.entries(grids)) {
    if (seen < cut) { delete grids[k]; changed = true; continue; }   // 열흘 넘게 안 본 곳은 그만 기록
    const [nx, ny] = k.split(',').map(Number);
    try {
      const base = nowBase();
      const items = await callVilage(env.KMA_KEY, 'getUltraSrtNcst', base, nx, ny, 20);
      if (!items || !items.length) continue;
      const v = {}; items.forEach(it => { v[it.category] = it.obsrValue; });
      const t = num(v.T1H); if (t == null) continue;
      const day = `${base.date.slice(0, 4)}-${base.date.slice(4, 6)}-${base.date.slice(6, 8)}`, hh = base.time.slice(0, 2);
      const rec = (await env.PUSH.get(`obs:${k}`, 'json')) || {};
      rec[day] = rec[day] || { t: {}, r: {} };
      if (rec[day].t[hh] === t) continue;
      rec[day].t[hh] = t; rec[day].r[hh] = amount(v.RN1) ?? 0;
      const old = new Date(Date.now() + 9 * 3600e3 - 45 * 864e5).toISOString().slice(0, 10);
      Object.keys(rec).forEach(d => { if (d < old) delete rec[d]; });
      await env.PUSH.put(`obs:${k}`, JSON.stringify(rec));
    } catch (e) { /* 다음 격자 계속 */ }
  }
  if (changed) await env.PUSH.put('grids', JSON.stringify(grids));
}
// 하루에 18시간 이상 관측이 모인 지난 날짜만 (정시 관측이라 실제 최고·최저보다 조금 덜 극단적일 수 있어요)
async function obsDays(env, g) {
  const rec = (await env.PUSH.get(`obs:${g.nx},${g.ny}`, 'json')) || {};
  const today = kstDay();
  return Object.keys(rec).sort().filter(d => d < today).map(d => {
    const ts = Object.values(rec[d].t), rs = Object.values(rec[d].r);
    return { date: d, n: ts.length, max: Math.max(...ts), min: Math.min(...ts), rain: Math.round(rs.reduce((a, b) => a + (b || 0), 0) * 10) / 10 };
  }).filter(x => x.n >= 18);
}

/* ---------- 출퇴근 비 알림 (웹 푸시) ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const enc = s => new TextEncoder().encode(s);
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0)); let o = 0; arrs.forEach(a => { out.set(a, o); o += a.length; }); return out; };
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc(s))).slice(0, 22);

async function getVapid(env) {
  let v = await env.PUSH.get('vapid', 'json');
  if (v) return v;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await env.PUSH.put('vapid', JSON.stringify(v));
  return v;
}
async function vapidJwt(privateJwk, aud, subject) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
// RFC 8291 (aes128gcm) 암호화
async function encryptPayload(p256dh, authSecret, text) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc(text), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, message) {
  const v = await getVapid(env);
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const subject = env.VAPID_SUBJECT || allowed[0] || 'mailto:haneul-weather@example.com';
  const jwt = await vapidJwt(v.privateJwk, new URL(sub.endpoint).origin, subject);
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(message));
  const res = await fetch(sub.endpoint, { method: 'POST', body, headers: {
    TTL: '21600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    Authorization: `vapid t=${jwt}, k=${v.publicKey}` } });
  return res.status;
}

// 출근·퇴근 시각 앞뒤의 비 예보를 봐요. 비/눈 형태가 있거나, 강수량이 있거나, 강수확률 60% 이상이면 '비 소식'
function rainCheck(fc, day, go, back) {
  const H = fc.hourly;
  const at = hr => {
    const hs = [hr, hr + 1].filter(h => h < 24).map(h => H.time.indexOf(`${day}T${pad(h)}:00`)).filter(i => i >= 0);
    if (!hs.length) return null;
    const pty = Math.max(...hs.map(i => H.pty[i] || 0)), pop = Math.max(...hs.map(i => H.pop[i] || 0)), pcp = hs.reduce((a, i) => a + (H.pcp[i] || 0), 0);
    const snow = hs.some(i => H.pty[i] === 3 || (H.sno[i] || 0) > 0);
    return { wet: pty > 0 || pcp > 0 || pop >= 60, pop, pcp, snow };
  };
  return { go: at(go), back: at(back) };
}
function alertMessage(c, go, back, test) {
  const what = x => x.snow ? '눈' : '비';
  const detail = (x, h) => `${h}시 강수확률 ${x.pop}%${x.pcp > 0 ? `, ${x.pcp < 1 ? '1mm 미만' : Math.round(x.pcp) + 'mm'}` : ''}`;
  const g = c.go?.wet, b = c.back?.wet;
  let title, body;
  if (g && b) { title = `☔ 출퇴근길 모두 ${what(c.go)} 소식이 있어요`; body = `${detail(c.go, go)} · 퇴근 ${detail(c.back, back)}. 우산 꼭 챙기세요`; }
  else if (g) { title = `☔ 출근길에 ${what(c.go)} 소식이 있어요`; body = `${detail(c.go, go)}. 우산 챙겨 나가세요`; }
  else if (b) { title = `☂️ 퇴근길에 ${what(c.back)} 소식이 있어요`; body = `${detail(c.back, back)}. 나갈 때 우산 챙기세요`; }
  else if (test) { title = '🌤️ 시험 알림이에요'; body = `오늘 출근(${go}시)·퇴근(${back}시) 시각엔 비 소식이 없어요. 비가 오는 평일 아침에 이렇게 알려 드려요`; }
  else return null;
  return { title: test && (g || b) ? `[시험] ${title}` : title, body, tag: 'commute-rain', url: './' };
}
async function checkSub(env, s, test = false) {
  const fc = await getFcst(env.KMA_KEY, s.nx, s.ny);
  const day = kstNow().toISOString().slice(0, 10);
  const msg = alertMessage(rainCheck(fc, day, s.go, s.back), s.go, s.back, test);
  if (msg) msg.body = `${s.name} · ${msg.body}`;
  return msg;
}
async function handlePush(path, request, env) {
  if (!env.PUSH) throw fail('Worker에 알림 저장소(KV, 이름 PUSH)가 연결되지 않았어요', 500);
  if (path === '/push/key') return { ok: true, key: (await getVapid(env)).publicKey };
  if (request.method !== 'POST') throw fail('POST 요청만 받아요', 405);
  const b = await request.json().catch(() => null);
  const endpoint = b?.sub?.endpoint || b?.endpoint;
  if (!endpoint || !/^https:\/\//.test(endpoint)) throw fail('알림 구독 정보가 없어요');
  const id = 'sub:' + await sha(endpoint);
  if (path === '/push/unsubscribe') { await env.PUSH.delete(id); return { ok: true }; }
  if (path === '/push/subscribe') {
    if (!b.sub.keys?.p256dh || !b.sub.keys?.auth) throw fail('알림 구독 키가 없어요');
    const g = gridOf(b.lat, b.lon);
    const go = Math.min(23, Math.max(0, parseInt(b.go))), back = Math.min(23, Math.max(0, parseInt(b.back)));
    if (!isFinite(go) || !isFinite(back)) throw fail('출퇴근 시각이 필요해요');
    const rec = { endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }, name: String(b.name || '').slice(0, 40), nx: g.nx, ny: g.ny, go, back, at: Date.now() };
    await env.PUSH.put(id, JSON.stringify(rec));
    return { ok: true, alertHour: (go + 23) % 24 };
  }
  if (path === '/push/test') {
    const s = await env.PUSH.get(id, 'json');
    if (!s) throw fail('저장된 구독이 없어요. 알림을 껐다가 다시 켜 주세요', 404);
    if (!env.KMA_KEY) throw fail('Worker에 KMA_KEY(인증키)가 설정되지 않았어요', 500);
    const status = await sendPush(env, s, await checkSub(env, s, true));
    if (status === 404 || status === 410) { await env.PUSH.delete(id); throw fail('휴대폰 쪽 구독이 끝났어요. 알림을 다시 켜 주세요', 410); }
    if (status >= 400) throw fail(`알림 서버가 거절했어요 (${status})`, 502);
    return { ok: true, status };
  }
  throw fail('없는 주소예요', 404);
}
// 매시 실행: 평일, 출근 1시간 전인 구독만 확인해서 비 소식이 있을 때만 보내요
async function runAlerts(env) {
  if (!env.PUSH || !env.KMA_KEY) return;
  const now = kstNow(), hour = now.getUTCHours(), wd = now.getUTCDay();
  if (wd === 0 || wd === 6) return;
  let cursor;
  do {
    const page = await env.PUSH.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const s = await env.PUSH.get(k.name, 'json');
      if (!s || (s.go + 23) % 24 !== hour) continue;
      const sentKey = `sent:${k.name.slice(4)}:${kstDay()}`;
      if (await env.PUSH.get(sentKey)) continue;            // 오늘 이미 보냈으면 건너뛰어요 (예약 실행이 겹쳐도 한 번만)
      try {
        const msg = await checkSub(env, s);
        if (!msg) continue;
        const status = await sendPush(env, s, msg);
        if (status < 300) await env.PUSH.put(sentKey, '1', { expirationTtl: 2 * 86400 });
        if (status === 404 || status === 410) await env.PUSH.delete(k.name);
      } catch (e) { /* 한 명이 실패해도 다음 사람은 계속 */ }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}
