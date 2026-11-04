/* =====================================================================
 * 부동산101 - app.js (서울 전역 / 지도 클릭 선택 / 맞춤 비교분석 버전)
 *  - 파일별 좌표계 자동 판별 후 위경도로 변환
 *  - 구 클릭 → 그 구 안의 개발구역만 표시 (같은 구 재클릭 시 줌 유지)
 *  - 개발구역 폴리곤 클릭 → 선택/해제, 2개 이상 선택 후 비교분석 실행
 *  - 예상 추가분담금·특징 등은 zone_extra.json(출처 포함)에 있을 때만 표시, 없으면 "정보 부존재"
 * ===================================================================== */

// ───────── 1. 좌표계 정의 ─────────
proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");
proj4.defs("EPSG:5181", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs");
proj4.defs("EPSG:5179", "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs");
proj4.defs("EPSG:5174", "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43 +units=m +no_defs");

// ※ 빨간 영역이 수백 m 어긋나 보이면 "EPSG:5174" 와 "EPSG:5181" 순서를 서로 바꿔보세요.
const CRS_CANDIDATES = ["EPSG:5174", "EPSG:5181", "EPSG:5186", "EPSG:5179"];
const SEOUL_BOX = { minLng: 126.7, maxLng: 127.3, minLat: 37.4, maxLat: 37.8 };

const MAX_RENDER = 2000;       // 한 번에 그릴 최대 개발구역 수
const RENDER_LINES = false;    // true면 선(LineString) 데이터도 그림
const MAX_SELECT = 6;          // 비교 가능한 최대 구역 수

// ───────── 2. 공통 유틸 ─────────
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// ───── 깨진 한글 복구 ─────
// CP949(한글) 바이트가 중국어 GBK로 잘못 읽힌 문자열을 되돌린다. (예: 瘤备窜困拌裙备开 → 지구단위계획구역)
let _gbkMap = null;
function fixKorean(s) {
  if (typeof s !== "string" || !/[^\x00-\x7F]/.test(s)) return s;
  if (/[가-힣]/.test(s)) return s;               // 이미 정상 한글이면 그대로
  try {
    if (!_gbkMap) {
      const gbk = new TextDecoder("gbk");
      _gbkMap = new Map();
      for (let a = 0x81; a <= 0xFE; a++) for (let b = 0x40; b <= 0xFE; b++) {
        if (b === 0x7F) continue;
        const ch = gbk.decode(new Uint8Array([a, b]));
        if (ch.length === 1 && ch !== "�" && !_gbkMap.has(ch)) _gbkMap.set(ch, [a, b]);
      }
    }
    const bytes = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 128) bytes.push(c);
      else if (_gbkMap.has(ch)) bytes.push(..._gbkMap.get(ch));
      else return s;
    }
    const out = new TextDecoder("euc-kr").decode(new Uint8Array(bytes));
    return /[가-힣]/.test(out) ? out : s;
  } catch (e) { return s; }
}

function fixProps(props) {
  const o = {};
  for (const k in props) o[k] = fixKorean(props[k]);
  return o;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inSeoul([lng, lat]) {
  return lng >= SEOUL_BOX.minLng && lng <= SEOUL_BOX.maxLng &&
         lat >= SEOUL_BOX.minLat && lat <= SEOUL_BOX.maxLat;
}

function firstCoord(geom) {
  let c = geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return c;
}

function detectCrs(features, label) {
  const f = features.find(f => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length);
  if (!f) return null;
  const [x, y] = firstCoord(f.geometry);

  if (x > 100 && x < 140 && y > 30 && y < 45) {
    console.log(`[CRS] ${label} → EPSG:4326 (이미 위경도)`, [x, y]);
    return "EPSG:4326";
  }
  for (const crs of CRS_CANDIDATES) {
    try {
      if (inSeoul(proj4(crs, "EPSG:4326", [x, y]))) {
        console.log(`[CRS] ${label} → ${crs}`, [x, y]);
        return crs;
      }
    } catch (e) { /* 다음 후보 */ }
  }
  console.error(`❌ [CRS] ${label}: 서울 범위에 맞는 좌표계 없음. 첫 좌표:`, [x, y]);
  return null;
}

const toLngLat = crs =>
  crs === "EPSG:4326" ? c => [c[0], c[1]] : c => proj4(crs, "EPSG:4326", [c[0], c[1]]);

// ───────── 3. 지오메트리 유틸 ─────────
function walkCoords(c, cb) {
  if (typeof c[0] === "number") cb(c);
  else c.forEach(s => walkCoords(s, cb));
}

function centerLngLat(geom, conv) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  walkCoords(geom.coordinates, ([x, y]) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  return conv([(minX + maxX) / 2, (minY + maxY) / 2]);
}

// 변환 후 약 5m 이내로 붙은 점은 제거 (렌더링 가볍게)
function thin(ring, tolDeg = 0.00005) {
  if (ring.length < 20) return ring;
  const out = [ring[0]];
  let last = ring[0];
  for (let i = 1; i < ring.length - 1; i++) {
    const p = ring[i];
    if (Math.abs(p[0] - last[0]) > tolDeg || Math.abs(p[1] - last[1]) > tolDeg) {
      out.push(p); last = p;
    }
  }
  out.push(ring[ring.length - 1]);
  return out;
}

function parseGeometry(geom, conv) {
  let raw, isArea = false;
  switch (geom.type) {
    case "Polygon":         raw = [geom.coordinates[0]]; isArea = true; break;
    case "MultiPolygon":    raw = geom.coordinates.map(p => p[0]); isArea = true; break;
    case "LineString":      raw = [geom.coordinates]; break;
    case "MultiLineString": raw = geom.coordinates; break;
    default: return null;
  }
  return { isArea, parts: raw.map(ring => thin(ring.map(conv))) };
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 위경도 링들의 면적(㎡) 근사
function areaOfParts(parts) {
  let total = 0;
  parts.forEach(ring => {
    if (ring.length < 3) return;
    const lat0 = ring[0][1], lng0 = ring[0][0];
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = (ring[i][0] - lng0) * kx, yi = (ring[i][1] - lat0) * ky;
      const xj = (ring[j][0] - lng0) * kx, yj = (ring[j][1] - lat0) * ky;
      s += xj * yi - xi * yj;
    }
    total += Math.abs(s) / 2;
  });
  return total;
}

// ───────── 4. 자치구 경계 로드 ─────────
let sggFeatures = null;
async function loadSgg() {
  if (sggFeatures) return sggFeatures;
  const data = await (await fetch("./seoul_sgg.json")).json();
  const crs = detectCrs(data.features, "seoul_sgg.json");
  if (!crs) return [];
  const conv = toLngLat(crs);
  sggFeatures = data.features
    .map(f => {
      const g = f.geometry && parseGeometry(f.geometry, conv);
      return g ? { props: f.properties || {}, ...g } : null;
    })
    .filter(Boolean);
  console.log("📋 구 properties 예시:", sggFeatures[0] && sggFeatures[0].props);
  return sggFeatures;
}

// ───────── 5. UPIS 로드 ─────────
let cachedAllUpisFeatures = null;
async function preloadUpisData() {
  if (cachedAllUpisFeatures) return cachedAllUpisFeatures;
  console.time("UPIS 로드");

  const upisFiles = [
    'UPIS_C_UQ161.json', 'UPIS_C_UQ162.json', 'UPIS_C_UQ163_AS.json', 'UPIS_C_UQ163_LM.json',
    'UPIS_C_UQ163_WA.json', 'UPIS_C_UQ163_WS.json', 'UPIS_C_UQ164_PC.json', 'UPIS_C_UQ164_PG.json',
    'UPIS_C_UQ164_PU.json', 'UPIS_C_UQ164_PW.json', 'UPIS_C_UQ164_RD.json', 'UPIS_C_UQ164_RF.json',
    'UPIS_C_UQ164_RO.json', 'UPIS_C_UQ166_AL.json', 'UPIS_C_UQ166_LM.json', 'UPIS_C_UQ166_PK.json',
    'UPIS_C_UQ167_BA.json', 'UPIS_C_UQ167_BT.json', 'UPIS_C_UQ167_DS.json', 'UPIS_C_UQ167_DT.json',
    'UPIS_C_UQ167_RC.json', 'UPIS_C_UQ167_RT.json', 'UPIS_C_UQ168_DV.json', 'UPIS_C_UQ168_EX.json',
    'UPIS_C_UQ169.json'
  ];

  const results = await Promise.all(
    upisFiles.map(file =>
      fetch("./" + file).then(r => r.json()).then(d => ({ file, d })).catch(() => null)
    )
  );

  cachedAllUpisFeatures = [];
  results.forEach(r => {
    if (!r || !r.d.features || !r.d.features.length) return;
    const crs = detectCrs(r.d.features, r.file);
    if (!crs) return;
    const conv = toLngLat(crs);
    r.d.features.forEach((f, idx) => {
      if (!f.geometry || !f.geometry.coordinates) return;
      cachedAllUpisFeatures.push({
        uid: `${r.file}#${idx}`,
        file: r.file,
        props: fixProps(f.properties || {}),
        geom: f.geometry,
        conv,
        center: centerLngLat(f.geometry, conv)
      });
    });
  });
  console.timeEnd("UPIS 로드");
  console.log(`📦 UPIS 총 ${cachedAllUpisFeatures.length}건 로드`);
  // 파일별 도형명(DGM_NM) 요약: 어떤 파일이 정비구역 경계인지 확인용
  const summary = {};
  cachedAllUpisFeatures.forEach(it => {
    const s = summary[it.file] || (summary[it.file] = { 도형명: fixKorean(String(it.props.DGM_NM || "")), 건수: 0, 형태: it.geom.type });
    s.건수++;
  });
  console.table(summary);
  return cachedAllUpisFeatures;
}

// ───────── 5-1. 정비사업 추진현황 데이터 (jeongbi.json) + 추가정보 (zone_extra.json) ─────────
// jeongbi.json : 서울시 정비사업 추진현황(엑셀)을 변환한 파일 (구역명/지번/사업유형/단계/세대수/인가일)
// zone_extra.json(선택) : { "1220": { "requiredFund": 10.5, "estContribution": 4.5, "feature": "..." } }  ← 키는 jeongbi.json의 code
let jeongbiRows = null;
async function loadJeongbi() {
  if (jeongbiRows) return jeongbiRows;
  jeongbiRows = await (await fetch("./jeongbi.json")).json();
  console.log(`🏢 정비사업 ${jeongbiRows.length}건 로드`);
  return jeongbiRows;
}

let zoneExtra = {};
fetch("./zone_extra.json").then(r => r.ok ? r.json() : {}).then(d => {
  zoneExtra = d || {};
  console.log(`🗂️ zone_extra.json ${Object.keys(zoneExtra).length}건 로드`);
}).catch(() => {});

// 서울 자치구 코드 (seoul_sgg.json에 구 이름이 없을 때 대비)
const SGG_CODE = {
  "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구", "11215": "광진구", "11230": "동대문구",
  "11260": "중랑구", "11290": "성북구", "11305": "강북구", "11320": "도봉구", "11350": "노원구", "11380": "은평구",
  "11410": "서대문구", "11440": "마포구", "11470": "양천구", "11500": "강서구", "11530": "구로구", "11545": "금천구",
  "11560": "영등포구", "11590": "동작구", "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구", "11740": "강동구"
};
const GU_NAMES = new Set(Object.values(SGG_CODE));

function sggNameOf(sgg) {
  const vals = Object.values(sgg.props || {}).map(v => fixKorean(String(v).trim()));
  for (const v of vals) if (GU_NAMES.has(v)) return v;
  for (const v of vals) { const m = v.match(/^(\d{5})/); if (m && SGG_CODE[m[1]]) return SGG_CODE[m[1]]; }
  for (const v of vals) { const m = v.match(/([가-힣]+구)$/); if (m && GU_NAMES.has(m[1])) return m[1]; }
  return null;
}

// ───────── 5-2. 주소 → 좌표 (카카오 지오코더 + 브라우저 캐시) ─────────
const GEO_KEY = "geo_v1";
let geoCache = {};
try { geoCache = JSON.parse(localStorage.getItem(GEO_KEY) || "{}"); } catch (e) { geoCache = {}; }
function saveGeo() { try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch (e) { /* 저장 실패 무시 */ } }

// '성수동1가72-10' → { dong:'성수동1가', lot:'72-10' } / '금호동3가1번지일대' → { '금호동3가', '1' }
function splitJibun(jibun) {
  const s = String(jibun || "").replace(/\s+/g, "");
  const m = s.match(/^([가-힣]+?(?:\d(?:가|동))?)(\d.*)$/);   // 성수동1가 / 중곡4동(행정동) 모두 처리
  if (!m) return { dong: s, lot: "" };
  const lot = m[2].replace(/,.*$/, "").replace(/(번지|일대|일원|일부|외.*)$/g, "").replace(/번지.*$/, "");
  return { dong: m[1], lot };
}

let _geocoder = null, _places = null;
function addrSearch(q) {
  _geocoder = _geocoder || new kakao.maps.services.Geocoder();
  return new Promise(res => _geocoder.addressSearch(q, (r, st) =>
    res(st === kakao.maps.services.Status.OK && r[0] ? { lat: Number(r[0].y), lng: Number(r[0].x) } : null)));
}
function kwSearch(q) {
  _places = _places || new kakao.maps.services.Places();
  return new Promise(res => _places.keywordSearch(q, (r, st) =>
    res(st === kakao.maps.services.Status.OK && r[0] ? { lat: Number(r[0].y), lng: Number(r[0].x) } : null)));
}

async function geocodeRow(row) {
  const key = String(row.code);
  if (geoCache[key]) return geoCache[key];
  const { dong, lot } = splitJibun(row.jibun);
  let hit = null, how = "addr";
  const legalDong = dong.replace(/\d동$/, "동");              // 중곡4동 → 중곡동 (행정동 → 법정동)
  if (lot) hit = await addrSearch(`서울 ${row.gu} ${dong} ${lot}`);
  if (!hit && lot && legalDong !== dong) hit = await addrSearch(`서울 ${row.gu} ${legalDong} ${lot}`);
  if (!hit && row.road) hit = await addrSearch(`서울 ${row.gu} ${row.road}`);
  if (!hit) { how = "keyword"; hit = await kwSearch(`${row.gu} ${row.name}`); }
  if (!hit) { how = "dong"; hit = await addrSearch(`서울 ${row.gu} ${legalDong}`); }
  if (hit) geoCache[key] = { ...hit, how };
  return geoCache[key] || null;
}

async function pool(list, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
}

// ───────── 6. 단계 가이드 / 성동구 수작업 데이터 ─────────
const stageGuideMap = {
  "구역지정": { flow: "구역지정 ➔ 조합설립 ➔ 사업시행 ➔ 관리처분 ➔ 착공/입주", remain: "입주까지 약 8~10년 이상 소요 예상 (초기 단계)" },
  "추진위": { flow: "추진위 ➔ 조합설립 ➔ 사업시행 ➔ 관리처분 ➔ 착공/입주", remain: "입주까지 약 7~9년 소요 예상 (조합설립 준비 중)" },
  "조합설립": { flow: "구역지정 ➔ 조합설립 ➔ 사업시행 ➔ 관리처분 ➔ 착공/입주", remain: "입주까지 약 6~8년 소요 예상 (본격화 단계)" },
  "건축심의": { flow: "조합설립 ➔ 건축심의 ➔ 사업시행 ➔ 관리처분 ➔ 착공/입주", remain: "입주까지 약 5~7년 소요 예상 (사업시행인가 준비 중)" },
  "사업시행": { flow: "조합설립 ➔ 사업시행인가 ➔ 관리처분 ➔ 착공/입주", remain: "입주까지 약 4~5년 소요 예상 (70% 진행 완료)" },
  "관리처분": { flow: "사업시행 ➔ 관리처분인가 ➔ 이주/철거 ➔ 착공/입주", remain: "입주까지 약 3~4년 소요 예상 (90% 진행 완료)" },
  "착공": { flow: "관리처분 ➔ 이주/철거 ➔ 착공 ➔ 준공/입주", remain: "입주까지 약 2~3년 소요 예상 (최종 단계)" }
};


// ───────── 7. 상태 ─────────
let map;
let currentSgg = null;                 // 현재 표시 중인 자치구
let renderToken = 0;                   // 구를 연달아 클릭했을 때 이전 작업 중단용
let devShapes = new Map();             // uid → [kakao shape...]
let nameOverlays = [];                 // 구역 이름 라벨
let selectedZones = new Map();         // uid → zone (선택 순서 유지)
let selectionOverlays = [];            // 선택 번호 라벨
let statusMsg = "";                    // 표 안내 문구

window.onload = function () {
  initMap();
  renderTable();
  updateSelectedCount();
  updateTotalFund();
  setTimeout(preloadUpisData, 500);    // 정비구역 경계(면)를 찾기 위한 백그라운드 로딩
};

function updateTotalFund() {
  const cap = parseFloat(document.getElementById('userCapital').value) || 0;
  const loan = parseFloat(document.getElementById('userLoan').value) || 0;
  document.getElementById('totalFundDisplay').innerText = `${(cap + loan).toFixed(1)} 억원`;
}

function handleDistrictChange() { /* 지도에서 구를 직접 클릭해 선택합니다 */ }

// ───────── 8. 지도 초기화 + 구 경계 ─────────
function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(37.566826, 126.978656),
    level: 8
  });

  loadSgg()
    .then(list => {
      console.log("🔥 자치구 경계 로드 완료. 총 구역 수:", list.length);
      list.forEach(sgg => {
        sgg.parts.forEach(ring => {
          const polygon = new kakao.maps.Polygon({
            map,
            path: ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng)),
            strokeWeight: 1.5, strokeColor: "#1e3a8a", strokeOpacity: 0.7,
            fillColor: "#3b82f6", fillOpacity: 0.05, clickable: true
          });
          kakao.maps.event.addListener(polygon, "mouseover", () => polygon.setOptions({ fillOpacity: 0.15 }));
          kakao.maps.event.addListener(polygon, "mouseout", () => polygon.setOptions({ fillOpacity: 0.05 }));
          kakao.maps.event.addListener(polygon, "click", () => {
            console.log("📌 [자치구 클릭됨]", sgg.props);
            loadAndFilterDevAreas(sgg);
          });
        });
      });
    })
    .catch(err => console.error("❌ seoul_sgg.json 로드 실패:", err));
}

// ───────── 9. 구 클릭 → 그 구의 정비사업 구역 표시 ─────────
const STAGE_SCORE = { "구역지정": 20, "추진위": 35, "조합설립": 55, "건축심의": 65, "사업시행": 75, "관리처분": 88, "착공": 98 };
const JB_LAYER_RE = /정비|재개발|재건축|주거환경/;   // UPIS 중 정비구역 경계로 볼 도형명

const STYLE_NORMAL = { strokeColor: "#ef4444", strokeWeight: 2, strokeOpacity: 1, fillColor: "#ef4444", fillOpacity: 0.45 };
const STYLE_SELECTED = { strokeColor: "#7c2d12", strokeWeight: 3, strokeOpacity: 1, fillColor: "#f97316", fillOpacity: 0.85 };

function clearDevShapes() {
  devShapes.forEach(shapes => shapes.forEach(s => s.setMap(null)));
  devShapes = new Map();
  nameOverlays.forEach(o => o.setMap(null));
  nameOverlays = [];
}

// UPIS 안의 '정비구역' 면 데이터 (있을 때만 실제 경계로 마스킹, 없으면 원으로 표시)
let jbPolys = null;
async function getJbPolys() {
  if (jbPolys) return jbPolys;
  const all = await preloadUpisData();
  jbPolys = all.filter(it =>
    (it.geom.type === "Polygon" || it.geom.type === "MultiPolygon") && JB_LAYER_RE.test(String(it.props.DGM_NM || "")));
  console.log(`🧱 UPIS 안의 정비구역 경계(면): ${jbPolys.length}건`);
  return jbPolys;
}

// 정비구역 경계(면)를 각 구역에 연결한다.
// ① 경계를 '링(독립된 조각)' 단위로 쪼개서, 조각 안에 구역 위치가 딱 하나만 있으면 그 구역의 개별 경계로 쓴다.
// ② 한 조각이 여러 구역을 한꺼번에 감싸면 개별 경계로는 못 쓰고, 묶음(그룹) 표시용으로만 보관(anyParts)한다.
async function assignPolygons(placed) {
  const polys = await getJbPolys();
  placed.forEach(it => { it.parts = null; it.anyParts = null; it.areaM2 = null; it.polyNote = polys.length ? "경계 없음" : "경계 데이터 없음"; });
  if (!polys.length) return;

  const units = [];                                           // { parts:[ring...], area, items:Set }
  for (const p of polys) {
    const near = placed.filter(it => haversineM(it.lat, it.lng, p.center[1], p.center[0]) <= 5000);
    if (!near.length) continue;
    const g = p._g || (p._g = parseGeometry(p.geom, p.conv));
    if (!g || !g.isArea) continue;
    const ringItems = g.parts.map(ring => near.filter(it => pointInRing([it.lng, it.lat], ring)));
    const all = new Set(ringItems.flat());
    if (!all.size) continue;
    if (all.size === 1) {                                     // 이 도형 전체가 한 구역 → 조각 전부 사용
      units.push({ parts: g.parts, area: areaOfParts(g.parts), items: all });
    } else {                                                  // 여러 구역이 걸림 → 조각별로 판단
      g.parts.forEach((ring, i) => { if (ringItems[i].length) units.push({ parts: [ring], area: areaOfParts([ring]), items: new Set(ringItems[i]) }); });
    }
  }
  for (const it of placed) {
    let solo = null, any = null;
    for (const u of units) {
      if (!u.items.has(it)) continue;
      if (!any || u.area < any.area) any = u;
      if (u.items.size === 1 && (!solo || u.area < solo.area)) solo = u;
    }
    if (any) it.anyParts = any.parts;
    if (solo) { it.parts = solo.parts; it.areaM2 = solo.area; it.polyNote = "개별 경계"; }
    else if (any) it.polyNote = `경계가 ${any.items.size}개 구역을 묶고 있음`;
  }
}

// ── 구역 묶음(그룹) 규칙 ──
// 개별 경계를 구할 수 없는 인접 구역들은 하나의 건으로 묶어서 표시·비교한다.
// GROUP_ALWAYS=true 로 바꾸면 개별 경계가 있어도 항상 하나로 묶는다.
const GROUP_ALWAYS = false;
const ZONE_GROUPS = [
  { id: "G-seongsu-strategy", gu: "성동구", name: "성수전략정비구역 (1~4지구)", stageLabel: "지구별 상이",
    test: r => r.gu === "성동구" && /^성수전략[1-4]$/.test(String(r.name || "").replace(/\s/g, "")) }
];

function makeGroupItem(def, members) {
  const rows = members.map(m => m.row);
  const sum = k => rows.every(r => r[k] == null) ? null : rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const scores = rows.map(r => STAGE_SCORE[r.stage]).filter(v => v != null);
  const dongs = [...new Set(rows.map(r => splitJibun(r.jibun).dong).filter(Boolean))];
  const seen = new Set(), parts = [];
  members.forEach(m => (m.parts || m.anyParts || []).forEach(ring => { if (!seen.has(ring)) { seen.add(ring); parts.push(ring); } }));
  const memberPoints = members.map(m => ({ lat: m.lat, lng: m.lng, name: m.row.name, supply: m.row.supply, existing: m.row.existing }));
  const lat = members.reduce((a, m) => a + m.lat, 0) / members.length;
  const lng = members.reduce((a, m) => a + m.lng, 0) / members.length;
  const uncovered = parts.length ? memberPoints.filter(pt => !parts.some(r => pointInRing([pt.lng, pt.lat], r))) : memberPoints;
  const row = {
    code: def.id, gu: def.gu, name: def.name,
    jibun: dongs.join("·") + " 일대", road: "", pubpriv: rows[0].pubpriv, gen: rows[0].gen,
    type: [...new Set(rows.map(r => r.type).filter(Boolean))].join(" / "),
    stage: def.stageLabel, existing: sum("existing"), supply: sum("supply"), sale: sum("sale"), rent: sum("rent"),
    d_zone: null, d_committee: null, d_assoc: null, d_review: null, d_biz: null, d_mgmt: null, d_move_s: null, d_move_e: null, d_start: null
  };
  return {
    uid: `grp#${def.id}`, row, lat, lng, parts: parts.length ? parts : null,
    areaM2: parts.length ? areaOfParts(parts) : null,
    how: members.every(m => m.how === "addr") ? "addr" : "keyword",
    isGroup: true, members: rows, memberPoints, circlePts: uncovered,
    stageScoreAvg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    polyNote: parts.length ? `${rows.length}개 지구 묶음(경계 ${parts.length}개)` : `${rows.length}개 지구 묶음(원)`
  };
}

function applyGroups(placed) {
  let out = placed.slice();
  for (const def of ZONE_GROUPS) {
    const members = out.filter(it => def.test(it.row));
    if (members.length < 2) continue;
    const individual = members.every(m => m.parts) && new Set(members.map(m => m.parts[0])).size === members.length;
    if (individual && !GROUP_ALWAYS) {
      console.log(`🧩 ${def.name}: 지구별 개별 경계(${members.length}개)를 찾아 각각 표시합니다.`);
      continue;
    }
    const g = makeGroupItem(def, members);
    out = out.filter(it => !members.includes(it));
    out.push(g);
    console.log(`🧩 ${def.name}: ${GROUP_ALWAYS ? "설정에 따라" : "지구별 개별 경계를 구할 수 없어"} 하나로 묶어 표시합니다. (구성 ${members.length}곳 / 경계 ${g.parts ? g.parts.length + "개" : "없음→원"})`);
  }
  return out;
}

async function loadAndFilterDevAreas(sgg) {
  // 같은 구를 다시 클릭하면 아무것도 하지 않음 → 줌/화면 상태 그대로 유지
  if (currentSgg === sgg) return;
  currentSgg = sgg;
  const myToken = ++renderToken;

  clearDevShapes();
  selectedZones.clear();

  if (!(kakao.maps.services && kakao.maps.services.Geocoder)) {
    statusMsg = "index.html의 카카오맵 SDK 주소 끝에 &libraries=services 를 추가해 주세요.";
    refreshSelectionUI();
    return;
  }

  const gu = sggNameOf(sgg);
  if (!gu) {
    statusMsg = "구 이름을 인식하지 못했습니다. 콘솔의 [자치구 클릭됨] 속성을 확인해 주세요.";
    console.warn("구 이름 인식 실패:", sgg.props);
    refreshSelectionUI();
    return;
  }

  statusMsg = `${gu} 정비사업 구역의 위치를 찾는 중입니다…`;
  refreshSelectionUI();

  // 다른 구로 바꿀 때만 화면을 그 구에 맞춤
  const bounds = new kakao.maps.LatLngBounds();
  sgg.parts.forEach(ring => ring.forEach(([lng, lat]) => bounds.extend(new kakao.maps.LatLng(lat, lng))));
  map.setBounds(bounds);

  const rows = (await loadJeongbi()).filter(r => r.gu === gu);
  const items = rows.map(r => ({ uid: `jb#${r.code}`, row: r, lat: null, lng: null, parts: null, areaM2: null, how: null }));

  await pool(items, 6, async it => {
    const g = await geocodeRow(it.row);
    if (g) { it.lat = g.lat; it.lng = g.lng; it.how = g.how; }
  });
  if (myToken !== renderToken) return;
  saveGeo();

  let placed = items.filter(it => it.lat != null);
  await assignPolygons(placed);
  if (myToken !== renderToken) return;
  placed = applyGroups(placed);

  // 원으로 표시할 구역은 이웃 구역과 겹치지 않도록 반지름을 제한 (가장 가까운 이웃까지 거리의 45%)
  placed.forEach(it => {
    let nn = Infinity;
    placed.forEach(o => { if (o !== it) nn = Math.min(nn, haversineM(it.lat, it.lng, o.lat, o.lng)); });
    it.nnDist = nn;
  });
  placed.forEach(drawDevItem);

  const polyCnt = placed.filter(it => it.parts).length;
  const approx = placed.filter(it => it.how && it.how !== "addr").length;
  const miss = items.filter(it => it.lat == null).length;
  statusMsg = `${gu} 정비사업 ${placed.length}곳을 표시했어요. 지도에서 구역을 눌러 선택하세요.` +
    (miss ? ` (위치를 찾지 못한 ${miss}곳 제외)` : "");
  console.log(`✨ ${gu}: 전체 ${items.length}건 / 표시 ${placed.length}건 / 경계면 ${polyCnt}건 / 대략위치 ${approx}건 / 실패 ${miss}건`);
  console.table(placed.map(it => ({ "구역": it.row.name, "표시": it.parts ? (it.circlePts && it.circlePts.length ? "경계면+원" : "경계면") : "원", "면적(㎡)": it.areaM2 ? Math.round(it.areaM2) : "", "이웃까지(m)": Math.round(it.nnDist), "비고": it.polyNote })));
  if (miss) console.log("실패:", items.filter(it => it.lat == null).map(it => `${it.row.name}(${it.row.jibun})`));
  refreshSelectionUI();
}

function drawDevItem(it) {
  const style = selectedZones.has(it.uid) ? STYLE_SELECTED : STYLE_NORMAL;
  const shapes = [];
  if (it.parts) {
    it.parts.forEach(ring => {
      if (ring.length < 3) return;
      shapes.push(new kakao.maps.Polygon({
        map, path: ring.map(([lng, lat]) => new kakao.maps.LatLng(lat, lng)), ...style, zIndex: 1000, clickable: true
      }));
    });
  }
  // 경계가 없는 구역(또는 묶음 중 경계 밖에 있는 지구)은 세대수에 비례한 원으로 표시
  const circles = it.isGroup
    ? (it.circlePts || [])
    : (it.parts ? [] : [{ lat: it.lat, lng: it.lng, supply: it.row.supply, existing: it.row.existing }]);
  circles.forEach(pt => {
    const n = pt.supply || pt.existing || 300;
    const base = Math.min(260, 50 + Math.sqrt(n) * 3.5);
    let nn = it.isGroup ? Infinity : (it.nnDist || Infinity);
    if (it.isGroup) it.memberPoints.forEach(o => { if (o !== pt) nn = Math.min(nn, haversineM(pt.lat, pt.lng, o.lat, o.lng)); });
    const radius = Math.max(40, Math.min(base, nn * 0.45));
    shapes.push(new kakao.maps.Circle({
      map, center: new kakao.maps.LatLng(pt.lat, pt.lng), radius, ...style, zIndex: 999
    }));
  });
  shapes.forEach(s => kakao.maps.event.addListener(s, "click", () => toggleDevSelection(it)));
  devShapes.set(it.uid, shapes);

  const label = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(it.lat, it.lng), yAnchor: 0.5, zIndex: 1000,
    content: `<div style="background:rgba(255,255,255,.9);color:#7f1d1d;padding:1px 6px;border-radius:8px;font-size:${it.isGroup ? 11 : 10}px;font-weight:700;border:1px solid #fca5a5;white-space:nowrap;pointer-events:none;">${esc(it.row.name)}</div>`
  });
  label.setMap(map);
  nameOverlays.push(label);
}

// ───────── 10. 선택 로직 ─────────
const normName = s => String(s || "").replace(/\s/g, "").replace(/구역$/, "");

function makeZone(it) {
  const r = it.row;
  const zone = {
    uid: it.uid, code: r.code, gu: r.gu,
    name: r.name,
    address: [r.jibun, r.road].filter(Boolean).join(" / "),
    type: r.type, stage: r.stage, stageList: it.isGroup ? it.members.map(m => m.stage) : [r.stage],
    existing: r.existing, supply: r.supply, sale: r.sale, rent: r.rent,
    pubpriv: r.pubpriv, gen: r.gen,
    dates: [
      ["구역지정", r.d_zone], ["추진위 승인", r.d_committee], ["조합설립인가", r.d_assoc], ["건축심의", r.d_review],
      ["사업시행인가", r.d_biz], ["관리처분인가", r.d_mgmt], ["이주 시작", r.d_move_s], ["착공", r.d_start]
    ].filter(x => x[1]),
    lat: it.lat, lng: it.lng, areaM2: it.areaM2, geoHow: it.how,
    requiredFund: null, estContribution: null, feature: null,
    isGroup: !!it.isGroup,
    members: it.isGroup ? it.members.map(m => ({
      name: m.name, stage: m.stage, type: m.type, existing: m.existing, supply: m.supply,
      dates: [["구역지정", m.d_zone], ["추진위 승인", m.d_committee], ["조합설립인가", m.d_assoc], ["건축심의", m.d_review],
              ["사업시행인가", m.d_biz], ["관리처분인가", m.d_mgmt], ["이주 시작", m.d_move_s], ["착공", m.d_start]].filter(x => x[1])
    })) : null
  };
  // 값의 출처 표시: ai = zone_extra.json(조사 결과, 출처 URL 포함)
  zone.prov = { contrib: null, fund: null, feature: null };
  const extra = zoneExtra[String(r.code)];
  if (extra) {
    if (extra.estContribution != null) {
      zone.estContribution = extra.estContribution; zone.prov.contrib = "ai";
      zone.contribBasis = extra.contribBasis || null; zone.contribAsOf = extra.contribAsOf || null;
    }
    if (extra.requiredFund != null) {
      zone.requiredFund = extra.requiredFund; zone.prov.fund = "ai";
      zone.fundBasis = extra.fundBasis || null;
    }
    if (extra.feature) { zone.feature = extra.feature; zone.prov.feature = "ai"; }
    zone.sources = Array.isArray(extra.sources) ? extra.sources : [];
    zone.verified = !!extra.verified;
    zone.collectedAt = extra.collectedAt || null;
    zone.confidence = extra.confidence || null;
    zone.extraNotes = extra.notes || null;
  }
  return zone;
}

function toggleDevSelection(it) {
  if (selectedZones.has(it.uid)) {
    selectedZones.delete(it.uid);
  } else {
    if (selectedZones.size >= MAX_SELECT) {
      alert(`최대 ${MAX_SELECT}개까지 비교할 수 있어요. 선택을 하나 해제한 뒤 다시 눌러주세요.`);
      return;
    }
    selectedZones.set(it.uid, makeZone(it));
  }
  refreshSelectionUI();
}

function removeZone(uid) {
  selectedZones.delete(uid);
  refreshSelectionUI();
}

function focusZone(uid) {
  const z = selectedZones.get(uid);
  if (z) map.panTo(new kakao.maps.LatLng(z.lat, z.lng));   // 줌은 그대로, 위치만 이동
}

function refreshSelectionUI() {
  devShapes.forEach((shapes, uid) => {
    const style = selectedZones.has(uid) ? STYLE_SELECTED : STYLE_NORMAL;
    shapes.forEach(s => { if (typeof s.setOptions === "function") s.setOptions(style); });
  });

  selectionOverlays.forEach(o => o.setMap(null));
  selectionOverlays = [];
  let n = 0;
  selectedZones.forEach(z => {
    n++;
    const ov = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(z.lat, z.lng),
      yAnchor: 1.9, zIndex: 2000,
      content: `<div style="background:#1e3a8a;color:#fff;padding:3px 9px;border-radius:14px;font-size:11px;font-weight:800;border:2px solid #fbbf24;white-space:nowrap;box-shadow:0 3px 6px rgba(0,0,0,.35);pointer-events:none;">${n}. ${esc(z.name)}</div>`
    });
    ov.setMap(map);
    selectionOverlays.push(ov);
  });

  renderTable();
  updateSelectedCount();
}

// ───────── 11. 선택 목록 표 ─────────
function renderTable() {
  const tbody = document.getElementById('zoneTableBody');
  if (!selectedZones.size) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-gray-400">${esc(statusMsg || "지도에서 구를 클릭한 뒤, 빨간 정비사업 구역을 눌러 선택하세요. (2개 이상 선택 시 비교 가능)")}</td></tr>`;
    return;
  }
  const dash = `<span class="text-gray-300">-</span>`;
  tbody.innerHTML = [...selectedZones.values()].map((z, i) => `
    <tr class="hover:bg-blue-50/50 transition cursor-pointer" onclick="focusZone('${z.uid}')">
      <td class="p-3 text-center" onclick="event.stopPropagation()">
        <input type="checkbox" checked onchange="removeZone('${z.uid}')" title="선택 해제">
      </td>
      <td class="p-3 font-bold text-blue-950">${i + 1}. ${esc(z.name)}</td>
      <td class="p-3">${z.type ? esc(z.type) : dash}</td>
      <td class="p-3">${z.stage ? `<span class="bg-red-50 text-red-600 font-bold px-2 py-0.5 rounded border border-red-100">${esc(z.stage)}</span>` : dash}</td>
      <td class="p-3 text-gray-500">${z.existing != null ? z.existing.toLocaleString() : dash}</td>
      <td class="p-3 font-semibold text-gray-800">${z.supply != null ? z.supply.toLocaleString() : dash}</td>
    </tr>
  `).join('');
}

function updateSelectedCount() {
  document.getElementById('selectedCount').innerText = selectedZones.size;
}

function selectAllZones(select) {
  if (select) { alert("지도에서 개발구역을 직접 클릭해 선택해 주세요."); return; }
  selectedZones.clear();
  refreshSelectionUI();
}

function toggleAllCheckboxes(master) {
  if (master.checked) { master.checked = false; alert("지도에서 개발구역을 직접 클릭해 선택해 주세요."); return; }
  selectAllZones(false);
}

// ───────── 12. 입지 지표 수집 (선택한 선호 항목만) ─────────
// 출근 경로 API(선택). 키를 넣으면 실제 경로 기준 소요시간을, 비워 두면 직선거리 기반 '추정'값을 보여줍니다.
//  - ODSAY_KEY      : ODsay 대중교통 길찾기 (웹 키, 등록한 도메인/localhost에서만 호출됨)
//  - KAKAO_REST_KEY : 카카오모빌리티 자동차 길찾기 REST 키
const COMMUTE_CFG = { ODSAY_KEY: "", KAKAO_REST_KEY: "" };

async function fetchJson(url, opt = {}, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opt, signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// 직선거리 기반 추정 (출근 시간대 서울 평균 속도 가정)
function estimateCommute(straightM) {
  const km = straightM / 1000;
  return {
    car: { min: Math.round(km * 1.35 / 25 * 60 + 5), km: +(km * 1.35).toFixed(1), src: "est" },
    transit: { min: Math.round(km * 1.4 / 22 * 60 + 12), src: "est" }
  };
}
async function apiTransit(z, wp) {
  if (!COMMUTE_CFG.ODSAY_KEY) return null;
  try {
    const u = `https://api.odsay.com/v1/api/searchPubTransPathT?SX=${z.lng}&SY=${z.lat}&EX=${wp.lng}&EY=${wp.lat}&apiKey=${encodeURIComponent(COMMUTE_CFG.ODSAY_KEY)}`;
    const info = (await fetchJson(u))?.result?.path?.[0]?.info;
    if (!info || info.totalTime == null) return null;
    return { min: Math.round(info.totalTime), src: "api" };
  } catch (e) { console.warn("ODsay 호출 실패(추정값 사용):", e.message); return null; }
}
// 키 없이 쓸 수 있는 실제 도로망 길찾기(OpenStreetMap 기반 OSRM 공개 서버). 도로 거리는 실제 경로이고,
// 소요시간은 교통량이 없는 상태의 값이라 출근 시간대 혼잡 보정(RUSH_FACTOR)을 곱해 보여준다.
const RUSH_FACTOR = 1.5;
async function osrmCar(z, wp) {
  try {
    const u = `https://router.project-osrm.org/route/v1/driving/${z.lng},${z.lat};${wp.lng},${wp.lat}?overview=false`;
    const r0 = (await fetchJson(u, {}, 9000))?.routes?.[0];
    if (!r0) return null;
    return { min: Math.round(r0.duration / 60 * RUSH_FACTOR + 3), free: Math.round(r0.duration / 60), km: +(r0.distance / 1000).toFixed(1), src: "osrm" };
  } catch (e) { console.warn("OSRM 도로 경로 조회 실패(추정값 사용):", e.message); return null; }
}
async function apiCar(z, wp) {
  if (!COMMUTE_CFG.KAKAO_REST_KEY) return osrmCar(z, wp);
  try {
    const u = `https://apis-navi.kakaomobility.com/v1/directions?origin=${z.lng},${z.lat}&destination=${wp.lng},${wp.lat}&priority=RECOMMEND`;
    const r0 = (await fetchJson(u, { headers: { Authorization: "KakaoAK " + COMMUTE_CFG.KAKAO_REST_KEY } }))?.routes?.[0];
    if (!r0 || r0.result_code !== 0) return osrmCar(z, wp);
    return { min: Math.round(r0.summary.duration / 60), km: +(r0.summary.distance / 1000).toFixed(1), src: "api" };
  } catch (e) { console.warn("카카오모빌리티 호출 실패(OSRM으로 대체):", e.message); return osrmCar(z, wp); }
}

// 평지 여부: 중심 + 반경 300m 8방향의 표고(Open-Meteo, 90m DEM)로 고저차·평균경사를 계산
async function fetchFlatness(zones) {
  const R = 300, per = 9;
  const pts = z => {
    const a = [[z.lat, z.lng]];
    for (let k = 0; k < 8; k++) {
      const t = k * Math.PI / 4;
      a.push([z.lat + R * Math.cos(t) / 111320, z.lng + R * Math.sin(t) / (111320 * Math.cos(z.lat * Math.PI / 180))]);
    }
    return a;
  };
  for (let i = 0; i < zones.length; i += 10) {              // 요청당 최대 100좌표
    const chunk = zones.slice(i, i + 10);
    const all = chunk.flatMap(pts);
    try {
      const u = `https://api.open-meteo.com/v1/elevation?latitude=${all.map(p => p[0].toFixed(5)).join(",")}&longitude=${all.map(p => p[1].toFixed(5)).join(",")}`;
      const el = (await fetchJson(u, {}, 9000)).elevation;
      chunk.forEach((z, j) => {
        const e = el.slice(j * per, j * per + per);
        if (e.length < per || e.some(v => typeof v !== "number")) return;
        const slope = e.slice(1).reduce((a, v) => a + Math.abs(v - e[0]), 0) / 8 / R * 100;
        z.m.flat = { relief: Math.max(...e) - Math.min(...e), slopePct: slope, center: e[0] };
      });
    } catch (e) { console.warn("표고 데이터 조회 실패:", e.message); }
  }
}

async function findPlace(q) {
  const S = kakao.maps.services;
  const hit = await new Promise(res => new S.Places().keywordSearch(q, (d, st) => res(st === S.Status.OK && d[0] ? d[0] : null)));
  if (hit) return { lat: Number(hit.y), lng: Number(hit.x), name: hit.place_name };
  const ad = await new Promise(res => new S.Geocoder().addressSearch(q, (d, st) => res(st === S.Status.OK && d[0] ? d[0] : null)));
  return ad ? { lat: Number(ad.y), lng: Number(ad.x), name: q } : null;
}

async function enrichGeoMetrics(zones, p) {
  const S = kakao.maps.services;
  const ps = new S.Places();
  const plan = p.plan;
  const search = fn => new Promise(res => fn((data, status, pg) => res({ data: status === S.Status.OK ? data : [], total: pg ? pg.totalCount : 0 })));
  const kw = (loc, q, r) => search(cb => ps.keywordSearch(q, cb, { location: loc, radius: r, sort: S.SortBy.DISTANCE })).then(x => x.data);
  const pick = (list, ok, cap) => {
    const f = list.filter(ok)[0];
    return f ? { found: true, m: Number(f.distance), name: f.place_name } : { found: false, m: cap, name: null };
  };
  const notShop = d => !/쇼핑|판매|수리|매장|음식|카페|서비스/.test(d.category_name || "");

  const wp = plan.commute ? await findPlace(p.workplace) : null;

  await Promise.all(zones.map(async z => {
    const loc = new kakao.maps.LatLng(z.lat, z.lng);
    z.m = {};
    const jobs = [];

    if (plan.subway) jobs.push(search(cb => ps.categorySearch('SW8', cb, { location: loc, radius: 2000, sort: S.SortBy.DISTANCE }))
      .then(x => { z.m.subway = pick(x.data, () => true, 2000); }));

    if (plan.park) jobs.push(kw(loc, '공원', 1500).then(r => {
      z.m.park = pick(r, d => /공원|숲/.test(d.place_name) && !/주차장|매점|화장실|관리|한강/.test(d.place_name), 1500);
    }));

    if (plan.water || plan.run) {
      jobs.push(Promise.all([kw(loc, '한강공원', 3000), plan.water ? kw(loc, '호수', 3000) : [], plan.run ? kw(loc, '산책로', 2000) : [], plan.run ? kw(loc, '자전거도로', 2000) : []])
        .then(([han, lake, trail, bike]) => {
          const hanOk = d => /한강/.test(d.place_name) && notShop(d);
          if (plan.water) {
            const cands = [...han.filter(hanOk), ...lake.filter(d => /호수/.test(d.place_name) && /공원|관광|명소|자연|호수/.test(d.category_name || ""))]
              .sort((a, b) => a.distance - b.distance);
            z.m.water = pick(cands, () => true, 3000);
          }
          if (plan.run) {
            const cands = [...han.filter(hanOk), ...trail.filter(d => /산책로|둘레길|천|하천/.test(d.place_name) && notShop(d)), ...bike.filter(d => /자전거/.test(d.place_name) && notShop(d))]
              .sort((a, b) => a.distance - b.distance);
            z.m.run = pick(cands, () => true, 3000);
          }
        }));
    }

    if (plan.school) {
      plan.levels.forEach(lv => jobs.push(kw(loc, `${lv}학교`, 2000).then(r => {
        const ok = d => new RegExp(`${lv}학교`).test(d.category_name || "") || new RegExp(`${lv}학교$`).test(d.place_name);
        const list = r.filter(ok);
        z.m['school_' + lv] = { ...pick(list, () => true, 2000), n1km: list.filter(d => Number(d.distance) <= 1000).length };
      })));
      jobs.push(search(cb => ps.categorySearch('AC5', cb, { location: loc, radius: 1000 })).then(x => { z.m.academy = { n: x.total || x.data.length }; }));
    }

    await Promise.all(jobs);

    if (wp) {
      const d = haversineM(z.lat, z.lng, wp.lat, wp.lng);
      const est = estimateCommute(d);
      const [t, c] = await Promise.all([apiTransit(z, wp), apiCar(z, wp)]);
      z.m.commute = { straightM: d, wp, transit: t || est.transit, car: c ? { ...est.car, ...c } : est.car };
    }
  }));

  if (plan.flat) await fetchFlatness(zones);
  return wp;
}

// ───────── 13. 투자 성향(나이 구간) / 비교 기준(criteria) / 점수 ─────────
const walkMin = m => Math.max(1, Math.round(m / 70));
const NA = `<span class="text-gray-400">데이터 없음</span>`;
const NOINFO = `<span class="text-rose-600 font-bold">정보 부존재</span><div class="text-[11px] text-gray-400 mt-0.5">확인 가능한 공개 자료를 찾지 못함</div>`;

// 나이 → 3구간. 단계별 점수표가 구간마다 다르다(공격형은 초기 단계도 높게, 안정형은 사업 확실성이 높은 단계를 높게).
const INVEST_STYLES = {
  aggressive: {
    name: "적극", range: "20~39세", icon: "🔥",
    desc: "초기 단계(추진위·조합설립)도 진입가 대비 상승 여력이 크다고 보고 높게 평가하며, 세대수 증가율(사업성)에 가중치를 둡니다. 대신 기간·변동성 리스크를 감수하는 설정입니다.",
    stage: { "구역지정": 75, "추진위": 85, "조합설립": 90, "건축심의": 85, "사업시행": 70, "관리처분": 55, "착공": 40 },
    wStage: 2.5, wRatio: 2.5, wContrib: 1, fundPenalty: 0.8
  },
  balanced: {
    name: "균형", range: "40~59세", icon: "⚖️",
    desc: "조합설립 이후 본격화되는 건축심의·사업시행 단계를 가장 높게 평가해, 상승 여력과 사업 확실성의 균형을 봅니다.",
    stage: { "구역지정": 25, "추진위": 40, "조합설립": 60, "건축심의": 75, "사업시행": 90, "관리처분": 85, "착공": 70 },
    wStage: 2, wRatio: 1.5, wContrib: 1.5, fundPenalty: 0.7
  },
  stable: {
    name: "안정", range: "60세 이상", icon: "🛡️",
    desc: "관리처분·착공처럼 사업 확실성이 높고 입주가 가까운 단계와, 추가분담금이 낮은 구역을 높게 평가합니다. 초기 단계는 기간 리스크 때문에 낮게 봅니다.",
    stage: { "구역지정": 10, "추진위": 20, "조합설립": 35, "건축심의": 50, "사업시행": 70, "관리처분": 92, "착공": 100 },
    wStage: 3, wRatio: 1, wContrib: 2.5, fundPenalty: 0.6
  }
};
function investStyle(age) {
  const a = parseInt(age, 10);
  if (!a) return INVEST_STYLES.balanced;
  return a < 40 ? INVEST_STYLES.aggressive : a < 60 ? INVEST_STYLES.balanced : INVEST_STYLES.stable;
}
function stageValue(z, style) {
  const v = (z.stageList || []).map(s => style.stage[s]).filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// 값의 출처 꼬리표 (AI 수집 / 수기 입력)
function provNote(z, key, basis) {
  const p = z.prov && z.prov[key];
  if (!p) return "";
  const tag = p === "ai"
    ? `<span class="inline-block text-[10px] px-1.5 py-0.5 rounded ${z.verified ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'} font-bold">AI 수집${z.verified ? ' · 검수됨' : ' · 미검수'}</span>`
    : `<span class="inline-block text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 font-bold">수기 입력 · 출처 미확인</span>`;
  const extra = p === "ai" && basis ? `<div class="text-[11px] text-gray-500 mt-0.5 leading-snug">${esc(basis)}</div>` : "";
  return `<div class="mt-1">${tag}</div>${extra}`;
}

const safeUrl = u => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

function sourcesCell(z) {
  const list = (z.sources || []).filter(s => safeUrl(s.url));
  if (!list.length) return `<span class="text-gray-400">수집된 출처 없음</span>`;
  const items = list.map(s => `<li class="leading-snug"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline break-all">${esc((s.title || s.url).slice(0, 60))}</a>` +
    `<span class="text-gray-400"> ${esc([s.publisher, s.date].filter(Boolean).join(' · '))}</span>` +
    (s.for && s.for.length ? `<span class="text-[10px] text-slate-500"> [${esc(s.for.join(', '))}]</span>` : "") + `</li>`).join("");
  const meta = [z.collectedAt ? `수집일 ${z.collectedAt.slice(0, 10)}` : "", z.confidence ? `신뢰도 ${({ high: '높음', medium: '보통', low: '낮음' })[z.confidence] || z.confidence}` : ""].filter(Boolean).join(" · ");
  return `<ul class="text-[11px] text-center list-none space-y-1">${items}</ul>` +
    (meta ? `<div class="text-[10px] text-gray-400 mt-1">${esc(meta)}</div>` : "") +
    (z.extraNotes ? `<div class="text-[10px] text-amber-700 mt-1">${esc(z.extraNotes)}</div>` : "");
}

function readProfile() {
  const val = id => { const el = document.getElementById(id); return el ? el.value : ""; };
  const num = id => parseFloat(val(id)) || 0;
  const cap = num('userCapital'), loan = num('userLoan');
  const prefs = new Set([...document.querySelectorAll('input[name="prefEnv"]:checked')].map(e => e.value));
  const kids = [...document.querySelectorAll('input[name="childStage"]:checked')].map(e => e.value);
  const kidLevels = [...new Set(kids.map(k => ({ "미취학": "초등", "초등": "초등", "중등": "중", "고등": "고" })[k]).filter(Boolean))];
  const workplace = val('userWorkplace').trim();
  const schoolOn = prefs.has('우수학군') || kidLevels.length > 0;
  const p = {
    age: val('userAge'), gender: val('userGender'),
    cap, loan, totalFund: cap + loan,
    workplace, kids, kidLevels, prefs,
    style: investStyle(val('userAge'))
  };
  p.plan = {
    subway: prefs.has('역세권'), park: prefs.has('공원/숲세권'), water: prefs.has('한강/호수뷰'),
    run: prefs.has('자전거/러닝길'), flat: prefs.has('평지'),
    school: schoolOn, levels: kidLevels.length ? kidLevels : ["초등", "중", "고"],
    commute: !!workplace
  };
  return p;
}

function buildCriteria(p) {
  const { plan, style } = p;
  const rows = [];
  const dist = (o, cap, empty) => o && o.found ? `${esc(o.name)}<br><b>${o.m}m</b> (도보 약 ${walkMin(o.m)}분)` : empty;

  if (plan.subway) rows.push({ key: 'subway', label: '🚇 가장 가까운 지하철역', w: 3, lowerBetter: true,
    val: z => z.m.subway ? z.m.subway.m : null,
    cell: z => dist(z.m.subway, 2000, `반경 2km 내 역 없음`),
    short: z => z.m.subway && z.m.subway.found ? `지하철역 도보 약 ${walkMin(z.m.subway.m)}분 (${z.m.subway.name})` : null });

  if (plan.water) rows.push({ key: 'water', label: '🌊 한강/호수', w: 3, lowerBetter: true,
    val: z => z.m.water ? z.m.water.m : null,
    cell: z => dist(z.m.water, 3000, `반경 3km 내 한강공원·호수 없음`),
    short: z => z.m.water && z.m.water.found ? `${z.m.water.name}까지 ${z.m.water.m}m` : null });

  if (plan.park) rows.push({ key: 'park', label: '🌳 공원/숲', w: 3, lowerBetter: true,
    val: z => z.m.park ? z.m.park.m : null,
    cell: z => dist(z.m.park, 1500, `반경 1.5km 내 공원 없음`),
    short: z => z.m.park && z.m.park.found ? `공원 도보 약 ${walkMin(z.m.park.m)}분 (${z.m.park.name})` : null });

  if (plan.run) rows.push({ key: 'run', label: '🏃 러닝/자전거 코스 접근성', w: 3, lowerBetter: true,
    val: z => z.m.run ? z.m.run.m : null,
    cell: z => dist(z.m.run, 3000, `반경 3km 내 한강공원·산책로·자전거도로 없음`) + `<div class="text-[10px] text-gray-400 mt-0.5">한강공원·산책로·자전거도로 중 최근접</div>`,
    short: z => z.m.run && z.m.run.found ? `러닝·자전거 코스(${z.m.run.name}) ${z.m.run.m}m` : null });

  if (plan.flat) rows.push({ key: 'flat', label: '⛰️ 지형 (평지 여부)', w: 3, lowerBetter: true,
    val: z => z.m.flat ? z.m.flat.slopePct : null,
    cell: z => {
      const f = z.m.flat; if (!f) return `<span class="text-gray-400">표고 데이터를 가져오지 못함</span>`;
      const g = f.slopePct < 2 ? ['평탄', 'text-emerald-700'] : f.slopePct < 5 ? ['완만', 'text-amber-700'] : ['경사 있음', 'text-rose-700'];
      return `<b class="${g[1]}">${g[0]}</b><br><span class="text-[11px] text-gray-500">반경 300m 고저차 ${f.relief.toFixed(0)}m · 평균경사 ${f.slopePct.toFixed(1)}%</span>`;
    },
    short: z => z.m.flat && z.m.flat.slopePct < 2 ? `주변 지형이 평탄(평균경사 ${z.m.flat.slopePct.toFixed(1)}%)` : null });

  if (plan.school) {
    plan.levels.forEach(lv => rows.push({ key: 'school_' + lv, label: `🏫 ${lv === '초등' ? '초등학교' : lv === '중' ? '중학교' : '고등학교'} (통학 거리)`,
      w: p.kidLevels.length ? 3 : 2, lowerBetter: true,
      val: z => z.m['school_' + lv] ? z.m['school_' + lv].m : null,
      cell: z => {
        const s = z.m['school_' + lv];
        if (!s || !s.found) return `반경 2km 내 ${lv === '초등' ? '초등' : lv}학교 없음`;
        return `${esc(s.name)}<br><b>${s.m}m</b> (도보 약 ${walkMin(s.m)}분${lv === '초등' && s.m <= 700 ? ' · 도보 10분 이내' : ''})<div class="text-[11px] text-gray-500">반경 1km 내 ${s.n1km}개</div>`;
      },
      short: z => { const s = z.m['school_' + lv]; return s && s.found ? `${lv === '초등' ? '초등' : lv}학교(${s.name}) 도보 약 ${walkMin(s.m)}분` : null; } }));
    rows.push({ key: 'academy', label: '📚 학원가 (반경 1km 학원 수)', w: 1, lowerBetter: false,
      val: z => z.m.academy ? z.m.academy.n : null,
      cell: z => z.m.academy ? `<b>${z.m.academy.n.toLocaleString()}곳</b>` : NA,
      short: z => z.m.academy && z.m.academy.n ? `반경 1km 학원 ${z.m.academy.n}곳으로 학원가 접근성 양호` : null });
  }

  if (plan.commute) {
    const srcTag = o => o.src === 'api'
      ? `<div class="mt-0.5"><span class="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">경로 API 기준</span></div>`
      : o.src === 'osrm'
      ? `<div class="mt-0.5"><span class="inline-block text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 font-bold">실제 도로 경로 · 혼잡 보정</span></div>`
      : `<div class="mt-0.5"><span class="inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">직선거리 기반 추정</span></div>`;
    rows.push({ key: 'commuteT', label: `🚇 출근 소요시간 · 대중교통<br><span class="font-normal text-[11px] text-gray-500">→ ${esc(p.workplace)}</span>`, w: 2, lowerBetter: true,
      val: z => z.m.commute ? z.m.commute.transit.min : null,
      cell: z => z.m.commute ? `<b>약 ${z.m.commute.transit.min}분</b>${srcTag(z.m.commute.transit)}<div class="text-[11px] text-gray-500">직선 ${(z.m.commute.straightM / 1000).toFixed(1)}km</div>${transitLinks(z, z.m.commute.wp)}` : `출근지를 찾지 못함`,
      short: z => z.m.commute ? `대중교통 출근 약 ${z.m.commute.transit.min}분` : null });
    rows.push({ key: 'commuteC', label: `🚗 출근 소요시간 · 자차<br><span class="font-normal text-[11px] text-gray-500">→ ${esc(p.workplace)}</span>`, w: 1.5, lowerBetter: true,
      val: z => z.m.commute ? z.m.commute.car.min : null,
      cell: z => z.m.commute ? `<b>약 ${z.m.commute.car.min}분</b>${srcTag(z.m.commute.car)}<div class="text-[11px] text-gray-500">도로 ${z.m.commute.car.km}km${z.m.commute.car.free ? ' · 무정체 ' + z.m.commute.car.free + '분' : ''}</div>` : `출근지를 찾지 못함`,
      short: z => z.m.commute ? `자차 출근 약 ${z.m.commute.car.min}분` : null });
  }

  // 사업 관련 기본 지표 (투자 성향에 따라 가중치·점수표가 달라짐)
  rows.push({ key: 'stage', label: `⚡ 추진 단계 (${style.name} 기준 점수)`, w: style.wStage, lowerBetter: false,
    val: z => stageValue(z, style),
    cell: z => {
      if (z.stage == null) return NA;
      const sc = stageValue(z, style);
      const scTxt = sc != null ? `<div class="text-[11px] text-gray-500 mt-0.5">${style.name} 기준 ${Math.round(sc)}점</div>` : '';
      if (z.isGroup) return `<div class="text-xs text-center space-y-0.5">${z.members.map(m => `<div><span class="text-gray-500">${esc(m.name.replace(/^성수전략/, '') + '지구')}</span> <b class="text-red-600">${esc(m.stage || '-')}</b></div>`).join('')}</div>${scTxt}`;
      const guide = stageGuideMap[z.stage] || { flow: "단계 진행 중" };
      return `<div class="flex items-center justify-center gap-1.5"><span class="font-extrabold text-red-600">${esc(z.stage)}</span>
        <div class="tooltip-container"><span class="tooltip-icon">i</span>
        <span class="tooltip-text"><b class="text-yellow-300">[${esc(z.stage)} 단계 가이드]</b><br>• <b>절차 흐름:</b> ${guide.flow}</span></div></div>${scTxt}`;
    },
    short: z => z.isGroup ? `구성 지구의 단계가 ${style.name} 성향에 부합` : (z.stage ? `${z.stage} 단계가 ${style.name} 성향에 부합` : null) });

  rows.push({ key: 'ratio', label: '🏠 세대수 증가율(사업성)', w: style.wRatio, lowerBetter: false,
    val: z => (z.existing > 0 && z.supply != null) ? ((z.supply - z.existing) / z.existing) * 100 : null,
    cell: z => (z.existing > 0 && z.supply != null)
      ? `<b>${(((z.supply - z.existing) / z.existing) * 100).toFixed(1)}%</b><br><span class="text-[11px] text-gray-500">기존 ${z.existing.toLocaleString()} ➔ 예정 ${z.supply.toLocaleString()}</span>` : NA,
    short: z => (z.existing > 0 && z.supply != null) ? `세대수 증가율 ${(((z.supply - z.existing) / z.existing) * 100).toFixed(0)}%` : null });

  rows.push({ key: 'contrib', label: '💸 예상 추가분담금(추정)', w: style.wContrib, lowerBetter: true,
    val: z => z.estContribution,
    cell: z => z.estContribution != null
      ? `<b>${z.estContribution < 0 ? '환급 약 ' + Math.abs(z.estContribution) : '약 ' + z.estContribution}억</b>${provNote(z, 'contrib', [z.contribBasis, z.contribAsOf ? z.contribAsOf + ' 기준' : ''].filter(Boolean).join(' · '))}`
      : NOINFO,
    short: z => z.estContribution != null ? `예상 추가분담금이 낮음(약 ${z.estContribution}억)` : null });

  return rows;
}

// 네이버지도/카카오맵의 대중교통 길찾기 화면으로 연결하는 링크 (출발: 구역, 도착: 출근지)
function transitLinks(z, wp) {
  const clean = s => String(s || "").replace(/[,\/]/g, " ").trim();
  const sn = clean(z.name), dn = clean(wp.name);
  const kakao = `https://map.kakao.com/link/by/traffic/${encodeURIComponent(sn)},${z.lat},${z.lng}/${encodeURIComponent(dn)},${wp.lat},${wp.lng}`;
  const naver = `https://map.naver.com/p/directions/${z.lng},${z.lat},${encodeURIComponent(sn)}/${wp.lng},${wp.lat},${encodeURIComponent(dn)}/-/transit`;
  const chip = (href, bg, fg, txt, title) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${title}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-extrabold no-underline shadow-sm hover:opacity-85" style="background:${bg};color:${fg}">${txt}</a>`;
  return `<div class="flex flex-wrap justify-center gap-1 mt-1.5">` +
    chip(naver, "#03C75A", "#fff", `<span style="background:#fff;color:#03C75A;border-radius:3px;padding:0 4px;font-weight:900">N</span> 네이버지도`, "네이버지도에서 대중교통 길찾기 열기") +
    chip(kakao, "#FEE500", "#191919", `<span style="background:#191919;color:#FEE500;border-radius:3px;padding:0 4px;font-weight:900">K</span> 카카오맵`, "카카오맵에서 대중교통 길찾기 열기") +
    `</div>`;
}

function badge(val, allVals, lowerBetter) {
  const mx = Math.max(...allVals), mn = Math.min(...allVals);
  if (mx === mn) return `<span class="inline-block mt-1 text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">동일</span>`;
  const best = lowerBetter ? val === mn : val === mx;
  return best
    ? `<span class="inline-block mt-1 text-[11px] bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full font-extrabold border border-emerald-200">🏆 우세</span>`
    : `<span class="inline-block mt-1 text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-semibold">보통</span>`;
}

function scoreZones(zones, p, criteria) {
  // 모든 선택 구역에 값이 있는 기준만 점수에 반영 (일부만 값이 있으면 불공정하므로 제외)
  const usable = criteria.filter(c => c.w > 0 && zones.every(z => c.val(z) != null));
  const totalW = usable.reduce((a, c) => a + c.w, 0);
  const penalty = p.style.fundPenalty;

  const ranked = zones.map(z => {
    let sum = 0;
    const parts = usable.map(c => {
      const vals = zones.map(c.val), mn = Math.min(...vals), mx = Math.max(...vals), v = c.val(z);
      const s = mx === mn ? 0.5 : (c.lowerBetter ? (mx - v) / (mx - mn) : (v - mn) / (mx - mn));
      sum += c.w * s;
      return { c, s };
    });
    let score = totalW ? (sum / totalW) * 100 : 0;
    const fundShort = z.requiredFund != null && p.totalFund < z.requiredFund;
    if (fundShort) score *= penalty;                   // 자금 부족 시 감점 (성향별로 강도 다름)
    return { z, score, parts, fundShort };
  }).sort((a, b) => b.score - a.score);

  return { ranked, usable };
}

// ───────── 14. 비교분석 실행 + 리포트 렌더링 ─────────
async function runAiComparison() {
  const zones = [...selectedZones.values()];
  if (zones.length < 2) {
    alert("비교 분석을 위해 지도에서 개발구역을 2개 이상 클릭해 선택해 주세요!");
    return;
  }
  if (!(kakao.maps.services && kakao.maps.services.Places)) {
    alert("index.html의 카카오맵 SDK 주소 끝에 &libraries=services 를 추가해 주세요.");
    return;
  }

  const p = readProfile();
  const summaryCard = document.getElementById('aiSummaryCard');
  summaryCard.innerHTML = `<div class="p-6 text-center text-yellow-300 font-bold animate-pulse">📊 선택한 구역의 입지 데이터를 수집하고 맞춤 점수를 계산하는 중입니다...</div>`;
  document.getElementById('analysisReportSection').scrollIntoView({ behavior: 'smooth' });

  const wp = await enrichGeoMetrics(zones, p);
  p.wp = wp;
  const criteria = buildCriteria(p);
  const { ranked, usable } = scoreZones(zones, p, criteria);

  document.getElementById('selectedBadges').innerHTML = zones.map((z, i) => `
    <span class="bg-blue-900 text-white font-bold text-xs px-3 py-1 rounded-xl shadow-sm">${i + 1}. ${esc(z.name)}</span>`).join('');

  renderCompareTable(zones, p, criteria);
  renderSummary(ranked, usable, p, wp, criteria);
}

function renderCompareTable(zones, p, criteria) {
  const rowHead = t => `<td class="p-4 font-bold border text-left bg-slate-100 text-slate-900 align-middle">${t}</td>`;
  let stripe = false;
  const tr = (head, cells) => { stripe = !stripe; return `<tr class="${stripe ? 'bg-slate-50/80' : ''}">${rowHead(head)}${cells}</tr>`; };
  const CELL = "p-4 border text-center align-middle";

  const staticRow = (head, fn) => tr(head, zones.map(z => `<td class="${CELL} text-gray-700">${fn(z)}</td>`).join(''));

  const ordered = [...criteria.filter(c => c.key === 'stage'), ...criteria.filter(c => c.key !== 'stage')];   // 추진 단계는 인가 이력 바로 다음
  const critRows = ordered.map(c => {
    const vals = zones.map(c.val);
    const comparable = vals.every(v => v != null);
    return tr(c.label, zones.map((z, i) => `
      <td class="${CELL} text-xs">${c.cell(z)}${comparable ? `<div>${badge(vals[i], vals, c.lowerBetter)}</div>` : ''}</td>`).join(''));
  }).join('');

  const fundRow = tr(`💰 자금 충족여부 (총가용 ${p.totalFund.toFixed(1)}억)`, zones.map(z => {
    if (z.requiredFund == null) return `<td class="${CELL}">${NOINFO}<div class="text-[11px] text-gray-500 mt-1">필요자금 자료가 없어 자금 충족 여부는 판단할 수 없음</div></td>`;
    const diff = p.totalFund - z.requiredFund;
    return `<td class="${CELL}"><div class="text-xs font-semibold text-gray-600">필요자금: 약 ${z.requiredFund}억</div>${provNote(z, 'fund', z.fundBasis)}` +
      (diff >= 0
        ? `<span class="inline-block mt-1 text-xs bg-emerald-100 text-emerald-800 font-extrabold px-2.5 py-1 rounded-full border border-emerald-300">✅ 자금 충분 (+${diff.toFixed(1)}억)</span>`
        : `<span class="inline-block mt-1 text-xs bg-rose-100 text-rose-800 font-extrabold px-2.5 py-1 rounded-full border border-rose-300">⚠️ 자본 부족 (${diff.toFixed(1)}억)</span>`) + `</td>`;
  }).join(''));

  const datesOf = z => z.dates && z.dates.length
    ? `<div class="text-xs text-center space-y-0.5">${z.dates.map(d => `<div><span class="text-gray-500">${esc(d[0])}</span> <b>${esc(d[1])}</b></div>`).join('')}</div>` : NA;

  document.getElementById('detailedCompareTable').innerHTML = `
    <thead>
      <tr class="bg-slate-900 text-white font-bold text-base">
        <th class="p-4 border border-slate-800 w-44 text-left">비교 항목</th>
        ${zones.map((z, i) => `<th class="p-4 border border-slate-800 min-w-[200px] text-yellow-300 text-lg text-center">${i + 1}. ${esc(z.name)}</th>`).join('')}
      </tr>
    </thead>
    <tbody class="divide-y text-gray-800 text-sm">
      ${staticRow('📍 소재지', z => `${z.address ? esc(z.address) : NA}${z.geoHow && z.geoHow !== 'addr' ? '<br><span class="text-[11px] text-amber-600">※ 지도 위치는 대략값</span>' : ''}`)}
      ${staticRow('🏗️ 사업 유형', z => `<b>${esc(z.type || '')}</b><br><span class="text-[11px] text-gray-500">${esc([z.pubpriv, z.gen === '재촉' ? '재정비촉진지구' : z.gen ? '일반 정비구역' : ''].filter(Boolean).join(' · '))}</span>`)}
      ${zones.some(z => z.areaM2 != null) ? staticRow('📐 구역 면적', z => z.areaM2 != null ? `<b>${Math.round(z.areaM2).toLocaleString()}㎡</b> <span class="text-[11px] text-gray-400">(약 ${(z.areaM2 / 3.3058).toLocaleString(undefined, { maximumFractionDigits: 0 })}평)</span>` : NA) : ''}
      ${zones.some(z => z.isGroup) ? staticRow('🧩 구성 지구', z => z.isGroup ? `<div class="text-xs text-center space-y-1">${z.members.map(m => `<div><b>${esc(m.name)}</b><br><span class="text-gray-500">${esc(m.type || '')} · 기존 ${m.existing != null ? m.existing.toLocaleString() : '-'} ➔ 예정 ${m.supply != null ? m.supply.toLocaleString() : '-'}세대</span></div>`).join('')}</div>` : `<span class="text-gray-300">-</span>`) : ''}
      ${staticRow('📅 주요 인가 이력', z => z.isGroup ? `<div class="text-xs text-center space-y-1.5">${z.members.map(m => `<div><b>${esc(m.name.replace(/^성수전략/, '') + '지구')}</b>${m.dates.length ? m.dates.map(d => `<div><span class="text-gray-500">${esc(d[0])}</span> <b>${esc(d[1])}</b></div>`).join('') : ' <span class="text-gray-400">-</span>'}</div>`).join('')}</div>` : datesOf(z))}
      ${critRows}
      ${fundRow}
      ${staticRow('🔗 정보 출처', z => sourcesCell(z))}
    </tbody>`;
}

function renderSummary(ranked, usable, p, wp, criteria) {
  const top = ranked[0];
  const style = p.style;

  const reasonsOf = r => r.parts
    .filter(x => x.s >= 0.75)
    .sort((a, b) => b.c.w - a.c.w)
    .map(x => x.c.short(r.z))
    .filter(Boolean)
    .slice(0, 3);

  const totalW = usable.reduce((a, c) => a + c.w, 0) || 1;
  const plain = c => c.label.replace(/<br>.*$/, '').replace(/<[^>]+>/g, '');
  const breakdown = r => `
    <div class="pt-2 border-t border-blue-700/50 space-y-1">
      <div class="text-[11px] font-bold text-yellow-200">항목별 획득 점수 <span class="font-normal text-blue-300">(획득 / 만점)</span></div>
      ${r.parts.map(x => {
        const max = x.c.w / totalW * 100, got = x.s * max;
        return `<div class="text-[11px]"><div class="flex justify-between gap-2"><span class="truncate">${esc(plain(x.c))}</span><span class="whitespace-nowrap font-bold ${x.s >= 0.75 ? 'text-emerald-300' : x.s <= 0.25 ? 'text-rose-300' : 'text-blue-100'}">${got.toFixed(1)} / ${max.toFixed(1)}</span></div>
          <div class="w-full h-1 bg-blue-950 rounded-full overflow-hidden"><div class="h-full ${x.s >= 0.75 ? 'bg-emerald-400' : x.s <= 0.25 ? 'bg-rose-400' : 'bg-sky-400'}" style="width:${x.s * 100}%"></div></div></div>`;
      }).join('')}
      ${r.fundShort ? `<div class="text-[11px] text-rose-300 flex justify-between"><span>자금 부족 감점</span><span class="font-bold">× ${style.fundPenalty}</span></div>` : ''}
      <div class="text-[10px] text-blue-300">각 항목은 선택한 구역끼리 상대 비교(최고=만점, 최저=0점)한 점수입니다.</div>
    </div>`;

  const rankCards = ranked.map((r, i) => {
    const reasons = reasonsOf(r);
    return `
      <div class="bg-blue-900/50 border ${i === 0 ? 'border-yellow-400' : 'border-blue-700/60'} rounded-xl p-4 space-y-2">
        <div class="flex justify-between items-center">
          <div class="font-extrabold text-white">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '위'} ${esc(r.z.name)}</div>
          <div class="font-black text-yellow-300 text-lg">${r.score.toFixed(0)}점</div>
        </div>
        <div class="w-full h-2 bg-blue-950 rounded-full overflow-hidden"><div class="h-full bg-yellow-400" style="width:${r.score}%"></div></div>
        ${r.fundShort ? `<div class="text-xs text-rose-300 font-semibold">⚠️ 필요자금(약 ${r.z.requiredFund}억)이 총 가용자금보다 커서 ${Math.round((1 - style.fundPenalty) * 100)}% 감점</div>` : ''}
        ${reasons.length ? `<ul class="text-xs text-blue-100 list-disc pl-4 space-y-0.5 text-left">${reasons.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${breakdown(r)}
      </div>`;
  }).join('');

  const usedChips = usable.map(c => `<span class="bg-blue-900 border border-blue-700 text-[11px] px-2 py-0.5 rounded-full">${c.label.replace(/<br>.*$/, '').replace(/<[^>]+>/g, '')} ×${c.w}</span>`).join('');
  const skipped = criteria.filter(c => c.w > 0 && !usable.includes(c)).map(c => c.label.replace(/<br>.*$/, '').replace(/<[^>]+>/g, ''));

  const prefTxt = [...p.prefs].map(esc).join(', ');
  const topReasons = reasonsOf(top);
  const verdict = usable.length === 0
    ? `선택한 구역들 사이에 공통으로 비교할 수 있는 데이터가 부족해 점수를 계산하지 못했습니다.`
    : `<b>${esc(top.z.name)}</b>이(가) ${style.name} 성향${p.age ? '(' + esc(p.age) + '세)' : '(나이 미입력 시 기본값)'}, 총 가용자금 ${p.totalFund.toFixed(1)}억` +
      (p.workplace ? `, 출근지 ${esc(p.workplace)}` : '') + (prefTxt ? `, 선호 조건(${prefTxt})` : '') +
      `을 종합했을 때 선택한 구역 중 가장 적합합니다.` +
      (topReasons.length ? ` 핵심 근거: ${topReasons.map(esc).join(' / ')}.` : '') +
      (top.fundShort ? ` 다만 필요자금이 가용자금을 넘으므로 자금 계획을 먼저 점검하세요.` : '');

  const kidTxt = p.kids.length ? ` / 자녀 ${p.kids.map(esc).join('·')}` : '';
  const notes = [
    `투자 성향은 나이로 구분했습니다 — 20~39세 적극 / 40~59세 균형 / 60세 이상 안정. 구간별로 추진 단계 점수표와 세대수 증가율·추가분담금·자금부족 감점의 강도가 다릅니다.`,
    p.plan.commute ? `출근 소요시간: <b>자차</b>는 ${COMMUTE_CFG.KAKAO_REST_KEY ? '카카오모빌리티 경로(키 설정됨, 실패 시 OSRM)' : '실제 도로망(OSRM) 경로의 거리·시간에 출근 시간대 혼잡 보정(×' + RUSH_FACTOR + ')을 적용한 값'}이며 실시간 교통은 반영하지 않습니다. <b>대중교통</b>은 ${COMMUTE_CFG.ODSAY_KEY ? 'ODsay 경로 기준(실패 시 추정)' : '무료로 쓸 수 있는 경로 API가 없어 직선거리 기반 <b>추정값</b>(직선×1.4÷22km/h+12분)'}입니다. 'API/도로 경로/추정' 표시로 구분됩니다.` : '',
    p.plan.school ? `학군은 카카오 장소검색 기준 <b>가장 가까운 학교까지의 거리·반경 내 학교 수·학원 수</b>입니다. 실제 배정 학교(학구도)나 학업성취도는 반영하지 않았으니 학교알리미·교육청 학구도 안내로 꼭 확인하세요.` : '',
    p.plan.flat ? `지형은 Open-Meteo 표고(해상도 약 90m) 기반의 반경 300m 고저차·평균경사로, 세부 경사와 다를 수 있습니다.` : '',
    `지하철·공원·학교 거리는 카카오 장소검색의 직선거리 기준입니다.`,
    `사업 유형·추진 단계·세대수·인가일은 서울시 정비사업 추진현황(2026.6월말 기준) 자료입니다. 예상 추가분담금·필요자금은 AI가 웹에서 수집해 출처와 함께 표시한 값이며(‘미검수’ 표시 주의), 출처를 찾지 못한 항목은 비워 두었습니다.`,
    `세금·대출 규제는 별도 확인이 필요합니다. 본 결과는 참고용이며 투자 권유가 아닙니다.`
  ].filter(Boolean);

  document.getElementById('aiSummaryCard').innerHTML = `
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-blue-800/80 pb-4 gap-2">
      <div>
        <span class="text-yellow-400 font-extrabold text-xs tracking-wider uppercase">맞춤 점수 분석 엔진 (규칙 기반)</span>
        <h3 class="text-xl md:text-2xl font-black mt-1">🏆 사용자 조건 기반 추천 리포트</h3>
      </div>
      ${usable.length ? `<span class="bg-yellow-400 text-blue-950 font-black text-sm px-4 py-1.5 rounded-full shadow">추천 1위 : ${esc(top.z.name)} (${top.score.toFixed(0)}점)</span>` : ''}
    </div>

    <div class="space-y-4 text-sm text-blue-100 leading-relaxed pt-2">
      <p class="font-semibold text-white">📌 <span class="text-yellow-300">사용자 조건:</span> ${p.age ? esc(p.age) + '세 ' : ''}${esc(p.gender)}${p.age || p.gender ? ' / ' : ''}자본 ${p.cap}억 + 대출 ${p.loan}억 = ${p.totalFund.toFixed(1)}억${kidTxt}${p.workplace ? ` / 출근지 ${esc(wp ? wp.name : p.workplace)}` : ''}</p>

      <div class="bg-indigo-900/50 p-3 rounded-xl border border-indigo-700/60 text-xs md:text-sm text-slate-200">
        <b>${style.icon} 투자 성향: ${style.name} (${style.range})</b> — ${style.desc}
      </div>

      <div class="bg-blue-900/60 p-4 rounded-xl border border-blue-700/60 text-xs md:text-sm text-slate-200 space-y-2">
        <p><b>[종합 진단]</b></p>
        <p>${verdict}</p>
      </div>

      ${usable.length ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">${rankCards}</div>` : ''}

      <div class="text-[11px] text-blue-200 space-y-1.5">
        <div class="flex flex-wrap gap-1.5 items-center"><b>점수에 반영한 기준(가중치):</b> ${usedChips || '없음'}</div>
        ${skipped.length ? `<p>• 일부 구역에 데이터가 없어 점수에서 제외한 항목: ${skipped.join(', ')}</p>` : ''}
        ${notes.map(n => `<p>• ${n}</p>`).join('')}
      </div>
    </div>`;
}