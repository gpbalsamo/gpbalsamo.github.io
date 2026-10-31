// Italy in 3D (FIAB/IT3D): terrain relief with the forecast precipitation painted on it, animated 10 m wind trails,
// an hourly timeline and a point meteogram. Data from build_it3d.py (meta.json, terrain.png, <model>/<run>_<f>.webp).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as C from "./core.js";

const $ = (id) => document.getElementById(id);
const DATA = "data/";
let M, TOWNS, G, KX, KY, LATC, LONC, TER, terrainH, landT; // meta, places, field grid, km per degree, terrain
let model, run, R = null, hour = 0, playing = false, playTimer = null;
const runCache = new Map();
const DEC = {};

// ---------- geometry: lon/lat <-> scene km (x east, z south, y up) ----------
const xOf = (lon) => (lon - LONC) * KX, zOf = (lat) => (LATC - lat) * KY;
const lonOf = (x) => LONC + x / KX, latOf = (z) => LATC - z / KY;
const exag = () => Number($("exag").value);

// terrain height (m) at scene (x, z), bilinear on the display terrain; NaN outside
function terrainAt(x, z) {
  const fi = (lonOf(x) - G.lon0) / G.d / (G.nx - 1) * (TER.nx - 1), fj = (G.lat0 - latOf(z)) / G.d / (G.ny - 1) * (TER.ny - 1);
  if (!(fi >= 0 && fj >= 0 && fi <= TER.nx - 1 && fj <= TER.ny - 1)) return NaN;
  const i = Math.min(Math.floor(fi), TER.nx - 2), j = Math.min(Math.floor(fj), TER.ny - 2), a = fi - i, b = fj - j, n = TER.nx;
  const h = (k) => Math.max(0, terrainH[k]);
  return (h(j * n + i) * (1 - a) + h(j * n + i + 1) * a) * (1 - b) + (h((j + 1) * n + i) * (1 - a) + h((j + 1) * n + i + 1) * a) * b;
}
// model cell (j, i) of a scene point, or null outside
function cellAt(x, z) {
  const i = Math.round((lonOf(x) - G.lon0) / G.d), j = Math.round((G.lat0 - latOf(z)) / G.d);
  return i >= 0 && j >= 0 && i < G.nx && j < G.ny ? [j, i] : null;
}

// ---------- three.js scene ----------
if (!document.createElement("canvas").getContext("webgl2")) {
  $("status").textContent = "This page needs WebGL2, which this browser does not offer.";
  $("status").style.display = "block";
  throw Error("no WebGL2");
}
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("scene").append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0d1820");
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 30000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.screenSpacePanning = false;
controls.keys = { LEFT: "ArrowLeft", UP: "ArrowUp", RIGHT: "ArrowRight", BOTTOM: "ArrowDown" };
controls.listenToKeyEvents(window);

let terrainGeo, terrainMesh, wxTex, wxData;
const LIGHT = new THREE.Vector3(-0.5, 0.75, -0.35).normalize();

function rampUniform(stops) {
  return { cols: stops.map((s) => new THREE.Vector3(...s[1])), vals: stops.map((s) => Math.log10(s[0])) };
}
const RU = rampUniform(C.RAIN), SU = rampUniform(C.SNOW);

const terrainVS = `
attribute float land;
varying vec2 vUv; varying float vH; varying float vLand; varying vec3 vN;
uniform float uScale;
void main(){
  vUv = uv; vH = position.y / uScale * 1000.0; vLand = land; vN = normalize(normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const terrainFS = `
precision highp float;
varying vec2 vUv; varying float vH; varying float vLand; varying vec3 vN;
uniform sampler2D uWx; uniform float uPrHi; uniform vec3 uLight; uniform float uHaveWx;
uniform vec3 uRain[${C.RAIN.length}]; uniform float uRainV[${C.RAIN.length}];
uniform vec3 uSnow[${C.SNOW.length}]; uniform float uSnowV[${C.SNOW.length}];
vec3 hyps(float h){
  vec3 c0=vec3(.31,.48,.29), c1=vec3(.44,.58,.33), c2=vec3(.63,.64,.42), c3=vec3(.55,.46,.35), c4=vec3(.55,.53,.51), c5=vec3(.86,.87,.89);
  if(h<300.) return mix(c0,c1,clamp(h/300.,0.,1.));
  if(h<800.) return mix(c1,c2,(h-300.)/500.);
  if(h<1500.) return mix(c2,c3,(h-800.)/700.);
  if(h<2300.) return mix(c3,c4,(h-1500.)/800.);
  return mix(c4,c5,clamp((h-2300.)/600.,0.,1.));
}
vec3 rampRain(float lv){
  vec3 c=uRain[0];
  for(int i=1;i<${C.RAIN.length};i++){ c = lv>=uRainV[i-1] ? mix(uRain[i-1],uRain[i],clamp((lv-uRainV[i-1])/(uRainV[i]-uRainV[i-1]),0.,1.)) : c; }
  return c;
}
vec3 rampSnow(float lv){
  vec3 c=uSnow[0];
  for(int i=1;i<${C.SNOW.length};i++){ c = lv>=uSnowV[i-1] ? mix(uSnow[i-1],uSnow[i],clamp((lv-uSnowV[i-1])/(uSnowV[i]-uSnowV[i-1]),0.,1.)) : c; }
  return c;
}
void main(){
  vec3 n = normalize(vN);
  float diff = max(dot(n, uLight), 0.0);
  vec3 c = vLand < 0.5 ? vec3(.07,.19,.27) : hyps(vH);
  if(uHaveWx > 0.5){
    vec4 w = texture2D(uWx, vUv);
    float pr = w.r * w.r * uPrHi, sn = w.g * w.g * uPrHi;
    if(pr >= 0.1){
      float lv = log(pr) / log(10.0);
      vec3 pc = sn >= 0.5 * pr ? rampSnow(lv) : rampRain(lv);
      c = mix(c, pc, 0.35 + 0.5 * clamp((lv + 1.0) / 1.3, 0.0, 1.0)); // light rain lets the terrain show through
    }
  }
  float shade = vLand < 0.5 ? 0.75 + 0.25 * diff : 0.32 + 0.78 * diff;
  gl_FragColor = vec4(c * shade, 1.0);
}`;

function makeTerrain() {
  const nx = TER.nx, ny = TER.ny, n = nx * ny;
  terrainGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), land = new Float32Array(n), idx = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, fi = i / (nx - 1) * (G.nx - 1), fj = j / (ny - 1) * (G.ny - 1);
    pos[3 * k] = xOf(G.lon0 + fi * G.d);
    pos[3 * k + 2] = zOf(G.lat0 - fj * G.d);
    uv[2 * k] = (fi + 0.5) / G.nx;
    uv[2 * k + 1] = (fj + 0.5) / G.ny;
    land[k] = landT[k];
    if (i < nx - 1 && j < ny - 1) idx.push(k, k + nx, k + 1, k + 1, k + nx, k + nx + 1);
  }
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  terrainGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  terrainGeo.setAttribute("land", new THREE.BufferAttribute(land, 1));
  terrainGeo.setIndex(idx);
  wxData = new Uint8Array(G.nx * G.ny * 4);
  wxTex = new THREE.DataTexture(wxData, G.nx, G.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  wxTex.magFilter = wxTex.minFilter = THREE.LinearFilter;
  wxTex.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    vertexShader: terrainVS, fragmentShader: terrainFS,
    uniforms: {
      uWx: { value: wxTex }, uPrHi: { value: M.enc.pr[1] }, uLight: { value: LIGHT }, uHaveWx: { value: 0 }, uScale: { value: 1 },
      uRain: { value: RU.cols }, uRainV: { value: RU.vals }, uSnow: { value: SU.cols }, uSnowV: { value: SU.vals },
    },
  });
  terrainMesh = new THREE.Mesh(terrainGeo, mat);
  scene.add(terrainMesh);
  setHeights();
}

function setHeights() {
  const p = terrainGeo.attributes.position.array, e = exag();
  for (let k = 0; k < terrainH.length; k++) p[3 * k + 1] = (landT[k] > 0.5 ? Math.max(0, terrainH[k]) : 0) / 1000 * e;
  terrainGeo.attributes.position.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  terrainGeo.computeBoundingSphere();
  terrainMesh.material.uniforms.uScale.value = e;
  $("exagV").textContent = e + "×";
  for (const q of particles || []) q.hist.length = 0;
  placeMarker();
}

// ---------- wind trails: screen-space ribbons (instanced quads, one per trail segment) ----------
const NP = 3200, NL = 12, SEG = NP * (NL - 1);
let particles = null, ribGeo, ribbons, uField = null, vField = null, histClock = 0;
const BAND_COL = C.WIND_BANDS.map((b) => C.hex(b[1]));

function makeRibbons() {
  ribGeo = new THREE.InstancedBufferGeometry();
  ribGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
  ribGeo.setIndex([0, 1, 2, 2, 1, 3]);
  for (const [name, size] of [["a", 3], ["b", 3], ["c", 4], ["w", 1]]) {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(SEG * size), size);
    attr.setUsage(THREE.DynamicDrawUsage);
    ribGeo.setAttribute(name, attr);
  }
  ribGeo.instanceCount = SEG;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRes: { value: new THREE.Vector2(innerWidth, innerHeight) } },
    vertexShader: `
      attribute vec3 a; attribute vec3 b; attribute vec4 c; attribute float w;
      uniform vec2 uRes; varying vec4 vC;
      void main(){
        vec4 pa = projectionMatrix * modelViewMatrix * vec4(a, 1.0);
        vec4 pb = projectionMatrix * modelViewMatrix * vec4(b, 1.0);
        vec2 sa = pa.xy / pa.w * uRes * 0.5, sb = pb.xy / pb.w * uRes * 0.5;
        vec2 d = sb - sa; float L = length(d);
        vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
        vec2 nrm = vec2(-dir.y, dir.x);
        vec4 p = mix(pa, pb, position.x);
        p.xy += nrm * position.y * w * 0.5 / (uRes * 0.5) * p.w;
        vC = (w > 0.0 && L > 1e-4) ? c : vec4(0.0);
        gl_Position = p;
      }`,
    fragmentShader: `precision highp float; varying vec4 vC; void main(){ if(vC.a < 0.01) discard; gl_FragColor = vC; }`,
  });
  ribbons = new THREE.Mesh(ribGeo, mat);
  ribbons.frustumCulled = false;
  ribbons.renderOrder = 2;
  scene.add(ribbons);
  const W = (G.nx - 1) * G.d * KX, H = (G.ny - 1) * G.d * KY;
  particles = Array.from({ length: NP }, () => spawn({ hist: [] }, W, H, true));
}

function spawn(p, W, H, first) {
  p.x = (Math.random() - 0.5) * W;
  p.z = (Math.random() - 0.5) * H;
  p.life = 2.5 + Math.random() * 4;
  p.age = first ? Math.random() * p.life : 0;
  p.hist.length = 0;
  return p;
}

// bilinear 10 m wind (m/s) of the current hour at scene (x, z)
function windAt(x, z) {
  const fi = (lonOf(x) - G.lon0) / G.d, fj = (G.lat0 - latOf(z)) / G.d;
  if (!(fi >= 0 && fj >= 0 && fi <= G.nx - 1 && fj <= G.ny - 1) || !uField) return null;
  const i = Math.min(Math.floor(fi), G.nx - 2), j = Math.min(Math.floor(fj), G.ny - 2), a = fi - i, b = fj - j, n = G.nx;
  const bl = (f) => (f[j * n + i] * (1 - a) + f[j * n + i + 1] * a) * (1 - b) + (f[(j + 1) * n + i] * (1 - a) + f[(j + 1) * n + i + 1] * a) * b;
  return [bl(uField), bl(vField)];
}

function stepRibbons(dt) {
  if (!particles || !uField) return;
  const show = $("trails").checked;
  ribbons.visible = show;
  if (!show) return;
  const W = (G.nx - 1) * G.d * KX, H = (G.ny - 1) * G.d * KY, k = 2.2 * Number($("spd").value), e = exag();
  histClock += dt;
  const record = histClock > 0.06;
  if (record) histClock = 0;
  const A = ribGeo.attributes.a.array, B = ribGeo.attributes.b.array, Cc = ribGeo.attributes.c.array, Wd = ribGeo.attributes.w.array;
  let s = 0;
  for (const p of particles) {
    p.age += dt;
    const w = windAt(p.x, p.z);
    if (!w || p.age > p.life) { spawn(p, W, H, false); }
    else {
      p.x += w[0] * k * dt;
      p.z -= w[1] * k * dt; // v > 0 blows north = -z
      p.kmh = Math.hypot(w[0], w[1]) * 3.6;
    }
    const y = terrainAt(p.x, p.z);
    if (record) {
      if (Number.isFinite(y)) p.hist.push([p.x, y / 1000 * e + 0.35 + 0.02 * e, p.z]);
      if (p.hist.length > NL) p.hist.shift();
    }
    const band = C.windBand(p.kmh || 0), col = BAND_COL[band], width = C.WIND_BANDS[band][2];
    const fade = Math.min(1, p.age / 0.6, (p.life - p.age) / 0.6);
    const h = p.hist, m = h.length;
    for (let q = 0; q < NL - 1; q++, s++) {
      if (q < m - 1) {
        const P = h[q], Q = h[q + 1];
        A[3 * s] = P[0]; A[3 * s + 1] = P[1]; A[3 * s + 2] = P[2];
        B[3 * s] = Q[0]; B[3 * s + 1] = Q[1]; B[3 * s + 2] = Q[2];
        const alpha = Math.max(0, fade) * (0.15 + 0.85 * (q + 1) / (m - 1));
        Cc[4 * s] = col[0]; Cc[4 * s + 1] = col[1]; Cc[4 * s + 2] = col[2]; Cc[4 * s + 3] = alpha;
        Wd[s] = width * (0.5 + 0.5 * (q + 1) / (m - 1));
      } else Wd[s] = 0;
    }
  }
  for (const n of ["a", "b", "c", "w"]) ribGeo.attributes[n].needsUpdate = true;
}

// ---------- data ----------
async function loadPixels(url, alpha) {
  const r = await fetch(url);
  if (!r.ok) throw Error(`${url}: ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const cv = document.createElement("canvas");
  cv.width = bmp.width; cv.height = bmp.height;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, rgba: cx.getImageData(0, 0, bmp.width, bmp.height).data };
}

async function loadRun(mid, key) {
  const id = mid + "/" + key;
  if (runCache.has(id)) return runCache.get(id);
  const md = M.models.find((m) => m.id === mid);
  const p = (async () => {
    const out = { mid, key, fields: {} };
    await Promise.all(md.fields.map(async (f) => {
      const im = await loadPixels(`${DATA}${mid}/${key}_${f}.webp`);
      const g = new Uint8Array(im.w * im.h);
      for (let k = 0; k < g.length; k++) g[k] = im.rgba[4 * k];
      out.fields[f] = C.unpackAtlas(g, im.w, M.frames, G.cols, G.nx, G.ny);
    }));
    return out;
  })();
  runCache.set(id, p);
  if (runCache.size > 6) runCache.delete(runCache.keys().next().value);
  return p;
}

const N1 = () => G.nx * G.ny;
// physical value of field f at frame h, cell (j, i); NaN when the model has no such field
function val(f, h, j, i) {
  const a = R && R.fields[f];
  return a ? DEC[f][a[h * N1() + j * G.nx + i]] : NaN;
}

function showHour() {
  if (!R) return;
  const n = N1(), o = hour * n, pr = R.fields.pr, sn = R.fields.sn, u = R.fields.u, v = R.fields.v;
  for (let k = 0; k < n; k++) { wxData[4 * k] = pr[o + k]; wxData[4 * k + 1] = sn[o + k]; wxData[4 * k + 3] = 255; }
  wxTex.needsUpdate = true;
  terrainMesh.material.uniforms.uHaveWx.value = 1;
  uField = new Float32Array(n); vField = new Float32Array(n);
  for (let k = 0; k < n; k++) { uField[k] = DEC.u[u[o + k]]; vField[k] = DEC.v[v[o + k]]; }
  const t = run.t0 * 1000 + hour * 3600000;
  $("when").textContent = FMT.format(new Date(t)) + " " + zoneName(t);
  $("lead").textContent = `+${hour} h · ${model.name}, start ${FMTUTC(run.t0 * 1000)}`;
  $("hour").value = hour;
  $("prev").disabled = hour <= 0;
  $("next").disabled = hour >= M.frames - 1;
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}

const FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const HFMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" });
const DFMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short" });
const ZFMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", timeZoneName: "short" });
function zoneName(t) { const z = ZFMT.formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value || ""; return { "GMT+2": "CEST", "GMT+1": "CET" }[z] || z; }
function FMTUTC(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")} UTC`; }

async function selectRun() {
  model = M.models.find((m) => m.id === $("model").value);
  run = model.runs.find((r) => r.key === $("run").value) || model.runs[0];
  status("Loading forecast…");
  try {
    const r = await loadRun(model.id, run.key);
    if (r.mid !== model.id || r.key !== run.key) return;
    R = r;
    status("");
    showHour();
    // prefetch the neighbouring starts
    const k = model.runs.indexOf(run);
    for (const q of [model.runs[k + 1], model.runs[k - 1]]) if (q) loadRun(model.id, q.key);
  } catch (e) { status("Could not load the forecast: " + e.message); }
}

function status(t) { $("status").textContent = t; $("status").style.display = t ? "block" : "none"; }

// ---------- inspect, marker and meteogram ----------
let selected = null, marker = null;
function placeMarker() {
  if (marker) { scene.remove(marker); marker.geometry.dispose(); marker = null; }
  if (!selected) return;
  const y = terrainAt(selected.x, selected.z) / 1000 * exag();
  const g = new THREE.CylinderGeometry(0.0, 2.2, 9, 12);
  g.translate(0, 4.5, 0);
  g.rotateX(Math.PI);
  g.translate(0, 9, 0);
  marker = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf0b44c }));
  marker.position.set(selected.x, (Number.isFinite(y) ? y : 0) + 0.2, selected.z);
  scene.add(marker);
}

function select(x, z) {
  const c = cellAt(x, z);
  if (!c) return;
  selected = { x, z, j: c[0], i: c[1], lat: latOf(z), lon: lonOf(x) };
  placeMarker();
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}

function f1(v, d = 1) { return Number.isFinite(v) ? v.toFixed(d) : "–"; }
function updateInfo() {
  if (!selected || !R) return;
  const { j, i, lat, lon } = selected, h = hour;
  const t = val("t", h, j, i) - 273.15, td = val("td", h, j, i) - 273.15, pr = val("pr", h, j, i), sn = val("sn", h, j, i);
  const [kmh, dir] = C.windOf(val("u", h, j, i), val("v", h, j, i)), zs = val("zs", h, j, i);
  const z = terrainAt(xOf(G.lon0 + i * G.d), zOf(G.lat0 - j * G.d));
  $("info").innerHTML = `<b>${C.nearTown(TOWNS, lat, lon)}</b><br><span class="k">${lat.toFixed(2)}°N ${lon.toFixed(2)}°E · model cell ${Math.round(z)} m</span><br>`
    + `Temperature <b>${f1(t)} °C</b>${Number.isFinite(td) ? ` · dewpoint <b>${f1(td)} °C</b>` : ""}<br>`
    + `Wind <b>${C.compass16(dir)} ${Math.round(kmh)} km/h</b><br>`
    + `Precipitation <b>${f1(pr)} mm</b> in the hour${sn >= 0.05 ? ` (snow ${f1(sn)} mm w.e.)` : ""}<br>`
    + `Snow level ≈ <b>${Math.round(zs / 50) * 50} m</b><br><button id="openMg" style="margin-top:6px">Point forecast</button>`;
  $("openMg").onclick = () => { $("mg").hidden = false; drawMeteogram(); };
}

function drawMeteogram() {
  if (!selected || !R) return;
  const { j, i, lat, lon } = selected, n = M.frames, t0 = run.t0 * 1000;
  const T = (h) => new Date(t0 + h * 3600000);
  const z = terrainAt(xOf(G.lon0 + i * G.d), zOf(G.lat0 - j * G.d));
  const s = { t: [], td: [], pr: [], sn: [], kmh: [], dir: [], zs: [] };
  for (let h = 0; h < n; h++) {
    s.t.push(val("t", h, j, i) - 273.15); s.td.push(val("td", h, j, i) - 273.15);
    s.pr.push(val("pr", h, j, i)); s.sn.push(val("sn", h, j, i));
    const [k, d] = C.windOf(val("u", h, j, i), val("v", h, j, i)); s.kmh.push(k); s.dir.push(d); s.zs.push(val("zs", h, j, i));
  }
  const tot = s.pr.reduce((a, b) => a + b, 0), snt = s.sn.reduce((a, b) => a + b, 0);
  $("mgPlace").textContent = C.nearTown(TOWNS, lat, lon);
  $("mgSub").textContent = `${lat.toFixed(3)}°N ${lon.toFixed(3)}°E · cell ${Math.round(z)} m · ${model.name}, start ${FMTUTC(t0)} · 72 h total ${tot.toFixed(1)} mm`
    + (snt >= 0.1 ? ` (snow ${snt.toFixed(1)} mm w.e.)` : "");
  $("mgNote").textContent = "Hourly values interpolated from 6-hourly model output (precipitation keeps the model's 6 h totals; bars = the hour ending at the tick). "
    + "Shading: sun below the horizon. Click a chart to choose the hour." + (model.id === "hres" ? " IFS HRES: no dewpoint in these data." : "");
  const X0 = 52, XW = 790, x = (h) => X0 + h / (n - 1) * XW;
  const panels = [
    { title: "Temperature (orange) and dewpoint (teal) · °C", lines: [[s.t, "#f59f45"], [s.td, "#3fc1b0"]] },
    { title: "Precipitation in the hour · rain (blue), snow water equivalent (purple) · mm", bars: true },
    { title: "10 m wind · km/h · arrows show where the wind blows to (north up)", lines: [[s.kmh, "#f2d16b"]], arrows: true, zero: true },
    { title: "Snow level (approximate) · m · dashed: model cell height", lines: [[s.zs, "#b59cf0"]], ref: z, zero: true },
  ];
  let html = "";
  for (const P of panels) {
    const vals = P.bars ? s.pr : P.lines.flatMap((l) => l[0]).concat(P.ref !== undefined ? [P.ref] : []);
    const fin = vals.filter(Number.isFinite);
    let lo = P.bars || P.zero ? 0 : Math.min(...fin), hi = Math.max(...fin, P.bars ? 1 : lo + 1);
    const st = C.niceStep(hi - lo);
    lo = Math.floor(lo / st) * st; hi = Math.ceil(hi / st) * st;
    if (hi <= lo) hi = lo + st;
    const y = (v) => 128 - (v - lo) / (hi - lo) * 96;
    let g = `<svg class="ch" viewBox="0 0 860 150" data-h="1"><text x="${X0}" y="16" fill="#dfe8ee" font-size="12">${P.title}</text>`;
    for (let h = 0; h < n - 1; h++) if (C.sunElevation(t0 + (h + 0.5) * 3600000, lat, lon) < 0) g += `<rect x="${x(h)}" y="32" width="${x(h + 1) - x(h) + 0.3}" height="96" fill="#9fb3c8" opacity=".1"/>`;
    for (let v = lo; v <= hi + 1e-9; v += st) g += `<path d="M${X0} ${y(v)}H${X0 + XW}" stroke="#9fb3c8" opacity=".18"/><text x="${X0 - 6}" y="${y(v) + 4}" fill="#9fb0bd" font-size="10" text-anchor="end">${+v.toFixed(1)}</text>`;
    for (let h = 0; h < n; h++) {
      const hr = Number(HFMT.format(T(h)));
      if (hr % 6 === 0) {
        g += `<path d="M${x(h)} 32V132" stroke="#9fb3c8" opacity="${hr === 0 ? 0.45 : 0.15}"/><text x="${x(h)}" y="144" fill="#9fb0bd" font-size="10" text-anchor="middle">${hr === 0 ? DFMT.format(T(h)) : String(hr).padStart(2, "0")}</text>`;
      }
    }
    if (P.bars) {
      const bw = Math.max(1, XW / (n - 1) - 1.5);
      for (let h = 1; h < n; h++) {
        const r = s.pr[h], q = Math.min(s.sn[h], r);
        if (r >= 0.05) {
          g += `<rect x="${x(h) - bw}" y="${y(r)}" width="${bw}" height="${y(0) - y(r)}" fill="#4aa3f0"/>`;
          if (q >= 0.05) g += `<rect x="${x(h) - bw}" y="${y(q)}" width="${bw}" height="${y(0) - y(q)}" fill="#a77ee8"/>`;
        }
      }
    } else {
      if (P.ref !== undefined) g += `<path d="M${X0} ${y(P.ref)}H${X0 + XW}" stroke="#d8dee4" stroke-dasharray="4 4" opacity=".6"/>`;
      for (const [arr, col] of P.lines) {
        let d = "", pen = false;
        arr.forEach((v, h) => { if (Number.isFinite(v)) { d += `${pen ? "L" : "M"}${x(h).toFixed(1)} ${y(v).toFixed(1)}`; pen = true; } else pen = false; });
        if (d) g += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2"/>`;
      }
      if (P.arrows) for (let h = 0; h < n; h += 3) {
        const to = (s.dir[h] + 180) % 360;
        g += `<g transform="translate(${x(h)} 40) rotate(${to})"><path d="M0 6V-6M-3 -2L0 -6L3 -2" stroke="#e8edf1" stroke-width="1.4" fill="none"/></g>`;
      }
    }
    g += `<path d="M${x(hour)} 30V132" stroke="#f0b44c" stroke-width="1.5"/></svg>`;
    html += g;
  }
  $("mgCharts").innerHTML = html;
  for (const el of $("mgCharts").querySelectorAll("svg")) {
    el.onclick = (ev) => {
      const r = el.getBoundingClientRect(), px = (ev.clientX - r.left) / r.width * 860;
      setHour(Math.round((px - X0) / XW * (n - 1)));
    };
  }
}

// movable meteogram panel
{
  let drag = null;
  $("mgHead").addEventListener("pointerdown", (e) => {
    if (e.target.id === "mgClose") return;
    const r = $("mg").getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    $("mgHead").setPointerCapture(e.pointerId);
  });
  $("mgHead").addEventListener("pointermove", (e) => {
    if (!drag) return;
    const el = $("mg");
    el.style.left = Math.max(0, Math.min(innerWidth - 80, e.clientX - drag.dx)) + "px";
    el.style.top = Math.max(0, Math.min(innerHeight - 40, e.clientY - drag.dy)) + "px";
    el.style.bottom = "auto";
  });
  $("mgHead").addEventListener("pointerup", () => { drag = null; });
  $("mgClose").onclick = () => { $("mg").hidden = true; };
}

// ---------- picking ----------
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(terrainMesh, false)[0];
  return hit ? hit.point : null;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) { const p = pick(e); if (p) select(p.x, p.z); }
  downAt = null;
});
renderer.domElement.addEventListener("dblclick", (e) => { const p = pick(e); if (p) flyTo(p.clone(), camera.position.distanceTo(controls.target) * 0.55); });

// ---------- camera views ----------
const VIEWS = { all: [43.0, 49.0, 4.0, 17.0], west: [44.0, 46.6, 6.2, 9.2], central: [45.2, 47.0, 8.5, 11.2],
  dolo: [45.9, 47.2, 10.8, 13.0], po: [43.9, 46.0, 7.5, 12.8], lig: [43.0, 44.8, 7.6, 12.0] };
let fly = null;
function flyTo(target, dist, dir) {
  const d = dir || camera.position.clone().sub(controls.target).normalize();
  fly = { t: 0, p0: camera.position.clone(), q0: controls.target.clone(), q1: target, p1: target.clone().add(d.multiplyScalar(dist)) };
}
function setView(name, instant) {
  const [s, n, w, e] = VIEWS[name];
  const tgt = new THREE.Vector3(xOf((w + e) / 2), 0, zOf((s + n) / 2));
  const size = Math.max((e - w) * KX / Math.max(camera.aspect, 0.6), (n - s) * KY);
  const dir = new THREE.Vector3(0, 0.78, 0.62).normalize();
  const dist = size * 1.05;
  if (instant) { controls.target.copy(tgt); camera.position.copy(tgt.clone().add(dir.multiplyScalar(dist))); controls.update(); }
  else flyTo(tgt, dist, dir);
}

// ---------- place labels and search ----------
const LABELS = ["Milano", "Torino", "Genova", "Bologna", "Venezia", "Trento", "Bolzano", "Aosta", "Firenze", "Verona", "Trieste",
  "Innsbruck", "Zürich", "Ljubljana", "Nice", "Grenoble", "München", "Udine", "Cortina d'Ampezzo", "Courmayeur", "Bormio", "Lugano", "Parma", "Ancona"];
let labelEls = [];
function makeLabels() {
  const box = $("labs");
  labelEls = TOWNS.filter((t) => LABELS.includes(t[0])).map((t) => {
    const el = document.createElement("div");
    el.className = "lab";
    el.textContent = t[0];
    box.append(el);
    return { el, x: xOf(t[2]), z: zOf(t[1]) };
  });
}
const tmp = new THREE.Vector3();
function updateLabels() {
  const on = $("labels").checked, dist = camera.position.distanceTo(controls.target);
  for (const L of labelEls) {
    if (!on) { L.el.style.display = "none"; continue; }
    const y = terrainAt(L.x, L.z) / 1000 * exag();
    tmp.set(L.x, (Number.isFinite(y) ? y : 0) + 0.3, L.z).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    L.el.style.display = vis ? "block" : "none";
    if (vis) { L.el.style.left = ((tmp.x + 1) / 2 * innerWidth) + "px"; L.el.style.top = ((1 - tmp.y) / 2 * innerHeight) + "px"; L.el.style.opacity = dist > 1400 ? 0.75 : 1; }
  }
}
function searchPlaces() {
  const q = C.searchKey($("q").value.trim()), box = $("matches");
  box.replaceChildren();
  if (q.length < 2) return;
  for (const t of TOWNS.filter((t) => C.searchKey(t[0]).includes(q)).slice(0, 8)) {
    const b = document.createElement("button");
    b.textContent = t[0];
    b.onclick = () => {
      box.replaceChildren(); $("q").value = t[0];
      const x = xOf(t[2]), z = zOf(t[1]);
      if (!cellAt(x, z)) { status(t[0] + " is outside the model domain"); setTimeout(() => status(""), 2500); return; }
      select(x, z);
      const y = terrainAt(x, z) / 1000 * exag();
      flyTo(new THREE.Vector3(x, Number.isFinite(y) ? y : 0, z), 160);
    };
    box.append(b);
  }
}

// ---------- compass: screen direction of north at the view centre ----------
function updateCompass() {
  const a = controls.target.clone().project(camera), b = controls.target.clone().add(new THREE.Vector3(0, 0, -50)).project(camera);
  const ang = Math.atan2((b.x - a.x) * innerWidth, (b.y - a.y) * innerHeight);
  $("needle").style.transform = `rotate(${ang}rad)`;
}

// ---------- timeline ----------
function setHour(h) { hour = Math.max(0, Math.min(M.frames - 1, h)); showHour(); }
function togglePlay(on) {
  playing = on ?? !playing;
  $("play").textContent = playing ? "❚❚ Pause" : "▶ Play";
  $("play").classList.toggle("on", playing);
  clearInterval(playTimer);
  if (playing) playTimer = setInterval(() => setHour(hour >= M.frames - 1 ? 0 : hour + 1), 450);
}

// ---------- start ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 1.1);
    const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
    camera.position.lerpVectors(fly.p0, fly.p1, e);
    controls.target.lerpVectors(fly.q0, fly.q1, e);
    if (fly.t >= 1) fly = null;
  }
  controls.update();
  stepRibbons(dt);
  updateLabels();
  updateCompass();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (ribbons) ribbons.material.uniforms.uRes.value.set(innerWidth, innerHeight);
});
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  if (e.key === "," || e.key === "[") setHour(hour - 1);
  if (e.key === "." || e.key === "]") setHour(hour + 1);
});

function legend() {
  const grad = (stops) => `linear-gradient(90deg,${stops.map((s, k) => `rgb(${s[1].map((c) => Math.round(c * 255)).join(",")}) ${(k / (stops.length - 1) * 100).toFixed(0)}%`).join(",")})`;
  $("barRain").style.background = grad(C.RAIN);
  $("barSnow").style.background = grad(C.SNOW);
  const lab = ["<20", "20–40", "40–60", "60–90", "90+"];
  $("bands").innerHTML = C.WIND_BANDS.map((b, k) => `<span style="background:${b[1]};height:${8 + 2 * b[2]}px;line-height:${8 + 2 * b[2]}px">${lab[k]}</span>`).join("");
}

async function main() {
  legend();
  try {
    [M, TOWNS] = await Promise.all([fetch(DATA + "meta.json").then((r) => r.json()), fetch(DATA + "towns.json").then((r) => r.json())]);
  } catch (e) { status("Could not load the data: " + e.message); return; }
  G = M.grid;
  for (const f in M.enc) DEC[f] = C.decoder(M.enc[f]);
  LATC = G.lat0 - (G.ny - 1) * G.d / 2; LONC = G.lon0 + (G.nx - 1) * G.d / 2;
  KY = C.KMDEG_LAT; KX = C.KMDEG_LAT * Math.cos(LATC * Math.PI / 180);
  const im = await loadPixels(DATA + "terrain.png");
  TER = { nx: im.w, ny: im.h };
  terrainH = new Float32Array(im.w * im.h); landT = new Float32Array(im.w * im.h);
  for (let k = 0; k < terrainH.length; k++) { terrainH[k] = im.rgba[4 * k] * 256 + im.rgba[4 * k + 1] - M.terrain.offset; landT[k] = im.rgba[4 * k + 2] > 127 ? 1 : 0; }
  makeTerrain();
  makeRibbons();
  makeLabels();
  for (const m of M.models) $("model").append(new Option(m.name, m.id));
  const fillRuns = () => {
    const md = M.models.find((m) => m.id === $("model").value), cur = $("run").value || "2026062900";
    $("run").replaceChildren(...md.runs.map((r) => new Option(FMTUTC(r.t0 * 1000) + " (" + DFMT.format(new Date(r.t0 * 1000)) + ")", r.key)));
    $("run").value = md.runs.some((r) => r.key === cur) ? cur : md.runs[0].key;
  };
  fillRuns();
  $("run").value = "2026062900";
  model = M.models[0];
  run = model.runs.find((r) => r.key === "2026062900") || model.runs[0];
  hour = run.peak || 0;
  $("t0").textContent = "+0 h";
  $("t1").textContent = `+${M.frames - 1} h`;
  $("model").onchange = () => { fillRuns(); selectRun(); };
  $("run").onchange = selectRun;
  $("hour").oninput = () => setHour(Number($("hour").value));
  $("prev").onclick = () => setHour(hour - 1);
  $("next").onclick = () => setHour(hour + 1);
  $("peak").onclick = () => setHour(run.peak || 0);
  $("play").onclick = () => togglePlay();
  $("exag").oninput = setHeights;
  $("view").onchange = () => setView($("view").value);
  $("reset").onclick = () => setView($("view").value);
  $("q").oninput = searchPlaces;
  setView("all", true);
  requestAnimationFrame(frame);
  await selectRun();
}

main();
