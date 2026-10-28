// 하늘 앱 — 기상청 공식 데이터 중계 서버 (Cloudflare Workers)
//
// 하는 일
//  - 공공데이터포털 '기상청_단기예보 조회서비스'를 대신 불러서 앱이 쓰기 쉬운 모양으로 돌려줘요.
//  - 인증키는 Worker 환경변수(KMA_KEY)에만 있어요. 앱(브라우저)에는 키가 드러나지 않아요.
//  - 브라우저가 직접 부를 수 있게 CORS 헤더를 붙여요.
//
// 주소
//  GET /                          → 상태 확인 {ok, keySet}
//  GET /now?lat=37.56&lon=126.97  → 초단기실황(지금 관측값): 기온·습도·바람·1시간 강수·강수 형태
//  GET /fcst?lat=37.56&lon=126.97 → 단기예보(약 3~4일, 1시간 간격) + 일 최고·최저
//
// 환경변수
//  KMA_KEY          (필수, 비밀) 공공데이터포털 인증키. '일반 인증키(Decoding)' 값을 넣어 주세요.
//                   Encoding 값(%가 들어 있음)을 넣어도 알아서 처리해요.
//  ALLOWED_ORIGINS  (선택) 앱 주소를 쉼표로. 예: https://아이디.github.io
//                   비워 두면 어느 사이트에서나 부를 수 있어요(* 허용).

const API = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';
const memo = new Map();   // 같은 격자·같은 발표 시각 응답을 잠깐 기억 (Worker가 살아 있는 동안만)

export default {
  // 테스트용 (Cloudflare는 fetch만 써요)
  _test: { toGrid: (...a) => toGrid(...a), nowBase: (...a) => nowBase(...a), fcstBase: (...a) => fcstBase(...a), amount: (...a) => amount(...a) },

  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = !allowed.length ? '*' : allowed.includes(origin) ? origin : null;
    const cors = allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin' } : {};

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (origin && !allowOrigin) return json({ ok: false, error: '허용되지 않은 사이트에서 온 요청이에요' }, 403, cors);
    if (request.method !== 'GET') return json({ ok: false, error: 'GET 요청만 받아요' }, 405, cors);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') return json({ ok: true, service: 'haneul-kma', keySet: !!env.KMA_KEY }, 200, cors);
    if (path !== '/now' && path !== '/fcst') return json({ ok: false, error: '없는 주소예요 (/now, /fcst)' }, 404, cors);
    if (!env.KMA_KEY) return json({ ok: false, error: 'Worker에 KMA_KEY(인증키)가 설정되지 않았어요' }, 500, cors);

    const lat = parseFloat(url.searchParams.get('lat')), lon = parseFloat(url.searchParams.get('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return json({ ok: false, error: 'lat, lon 값이 필요해요' }, 400, cors);
    const { nx, ny } = toGrid(lat, lon);
    if (nx < 1 || nx > 149 || ny < 1 || ny > 253) return json({ ok: false, error: '기상청 예보 범위(한반도) 밖이에요' }, 400, cors);

    try {
      const out = path === '/now' ? await getNow(env.KMA_KEY, nx, ny) : await getFcst(env.KMA_KEY, nx, ny);
      return json({ ok: true, nx, ny, ...out }, 200, { ...cors, 'Cache-Control': `public, max-age=${path === '/now' ? 300 : 900}` });
    } catch (e) {
      return json({ ok: false, error: e.message || String(e) }, 502, cors);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

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

/* ---------- 발표 시각 계산 (한국 시각) ---------- */
const kstNow = () => new Date(Date.now() + 9 * 3600e3);          // getUTC*로 읽으면 한국 시각
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const pad = n => String(n).padStart(2, '0');

// 초단기실황: 매시 정각 자료가 약 40분 뒤에 나와요
function nowBase(d = kstNow(), back = 0) {
  const t = new Date(d.getTime() - (d.getUTCMinutes() < 40 ? 3600e3 : 0) - back * 3600e3);
  return { date: ymd(t), time: pad(t.getUTCHours()) + '00' };
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
async function callKma(key, op, base, nx, ny, rows) {
  const id = `${op}|${base.date}${base.time}|${nx},${ny}`;
  const hit = memo.get(id);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.items;
  const k = key.includes('%') ? key : encodeURIComponent(key);
  const u = `${API}/${op}?serviceKey=${k}&pageNo=1&numOfRows=${rows}&dataType=JSON&base_date=${base.date}&base_time=${base.time}&nx=${nx}&ny=${ny}`;
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  // 인증 오류 등은 dataType=JSON이어도 XML로 와요
  if (text.trim().startsWith('<')) {
    const msg = (text.match(/<returnAuthMsg>([^<]*)</) || text.match(/<errMsg>([^<]*)</) || text.match(/<resultMsg>([^<]*)</) || [])[1] || `응답 ${res.status}`;
    throw new Error(explain(msg));
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`기상청 응답을 읽지 못했어요 (${res.status})`); }
  const h = j?.response?.header;
  if (h?.resultCode === '03') return null;                        // NO_DATA: 아직 발표 전
  if (h?.resultCode !== '00') throw new Error(explain(h?.resultMsg || '알 수 없는 오류'));
  const items = j.response.body?.items?.item || [];
  memo.set(id, { at: Date.now(), items });
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  return items;
}
function explain(msg) {
  if (/SERVICE_KEY_IS_NOT_REGISTERED|SERVICE KEY IS NOT REGISTERED/i.test(msg)) return '인증키가 등록되지 않았어요. 키 값을 확인하거나, 발급 직후라면 1~2시간 뒤 다시 해 보세요';
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

/* ---------- 지금 관측값 ---------- */
async function getNow(key, nx, ny) {
  for (let back = 0; back < 3; back++) {
    const base = nowBase(kstNow(), back);
    const items = await callKma(key, 'getUltraSrtNcst', base, nx, ny, 20);
    if (!items || !items.length) continue;
    const v = {}; items.forEach(it => { v[it.category] = it.obsrValue; });
    if (num(v.T1H) == null) continue;
    return {
      base: iso(base.date, base.time),
      obs: { t: num(v.T1H), rh: num(v.REH), wind: num(v.WSD), vec: num(v.VEC), rain1h: amount(v.RN1), pty: num(v.PTY) ?? 0 },
    };
  }
  throw new Error('최근 3시간 안의 관측 자료가 없어요');
}

/* ---------- 단기예보 ---------- */
async function getFcst(key, nx, ny) {
  for (let back = 0; back < 2; back++) {
    const base = fcstBase(kstNow(), back);
    const items = await callKma(key, 'getVilageFcst', base, nx, ny, 2000);
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
        sky: col('SKY', num), pty: col('PTY', num), reh: col('REH', num), wsd: col('WSD', num),
      },
      daily: { time: days, tmx: days.map(d => tmx.get(d) ?? null), tmn: days.map(d => tmn.get(d) ?? null) },
    };
  }
  throw new Error('단기예보 자료를 받지 못했어요');
}
