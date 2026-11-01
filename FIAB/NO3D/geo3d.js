// 3D terrain-weather viewer for the FIAB domains (NZ3D, NO3D, CA3D, CONUS3D): terrain relief (IFS TCo7999 orography,
// one lattice per region) with the model precipitation painted on it (snow above the snow level), animated 10 m wind
// trails, an hourly timeline and a point meteogram. A generalisation of viz/it3d to projected grids ("lcc") and to
// model frames every S hours, the hourly values being made here (core.js). Data from build3d.py and terrain3d.py.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as C from "./core.js";

const $ = (id) => document.getElementById(id);
const DATA = "data/";
let M, TOWNS, G, GR, N, CX, CZ, REG, terrainH, landT, COVER = null;
let model, run, R = null, hour = 0, playing = false, playTimer = null, HMAX = 72;
const runCache = new Map(), terrCache = new Map();
const DEC = {};
const PRHI = 60, ZSHI = 6000; // display texture: hourly precipitation (sqrt) and snow level ranges

// ---------- geometry: cell index (fj rows from the north, fi columns from the west) <-> scene km ----------
const xOfI = (fi) => (fi - CX) * G.kx, zOfJ = (fj) => (fj - CZ) * G.kz;
const iOfX = (x) => x / G.kx + CX, jOfZ = (z) => z / G.kz + CZ;
const sceneOf = (lat, lon) => { const [fj, fi] = GR.index(lat, lon); return [xOfI(fi), zOfJ(fj)]; };
const latlonOf = (x, z) => GR.latlon(jOfZ(z), iOfX(x));
const exag = () => Number($("exag").value);

// terrain height (m) at scene (x, z), bilinear on the region lattice; NaN outside it
function terrainAt(x, z) {
  const fi = iOfX(x), fj = jOfZ(z);
  const a = (fi - REG.i0) / (REG.i1 - REG.i0) * (REG.nx - 1), b = (fj - REG.j0) / (REG.j1 - REG.j0) * (REG.ny - 1);
  if (!(a >= 0 && b >= 0 && a <= REG.nx - 1 && b <= REG.ny - 1)) return NaN;
  const i = Math.min(Math.floor(a), REG.nx - 2), j = Math.min(Math.floor(b), REG.ny - 2), u = a - i, v = b - j, n = REG.nx;
  const h = (k) => Math.max(0, terrainH[k]);
  return (h(j * n + i) * (1 - u) + h(j * n + i + 1) * u) * (1 - v) + (h((j + 1) * n + i) * (1 - u) + h((j + 1) * n + i + 1) * u) * v;
}
// model cell (j, i) of a scene point, or null outside the grid
function cellAt(x, z) {
  const i = Math.round(iOfX(x)), j = Math.round(jOfZ(z));
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
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 1, 60000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.screenSpacePanning = false;
controls.keys = { LEFT: "ArrowLeft", UP: "ArrowUp", RIGHT: "ArrowRight", BOTTOM: "ArrowDown" };
controls.listenToKeyEvents(window);

let terrainGeo = null, terrainMesh = null, wxTex = null, wxData = null;
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
uniform sampler2D uWx; uniform vec3 uLight; uniform float uHaveWx;
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
    float pr = w.r * w.r * ${PRHI.toFixed(1)}, zs = w.g * ${ZSHI.toFixed(1)};
    if(pr >= 0.1){
      float lv = log(pr) / log(10.0);
      vec3 pc = (vLand > 0.5 && vH >= zs) ? rampSnow(lv) : rampRain(lv);
      c = mix(c, pc, 0.35 + 0.5 * clamp((lv + 1.0) / 1.3, 0.0, 1.0)); // light rain lets the terrain show through
    }
  }
  float shade = vLand < 0.5 ? 0.75 + 0.25 * diff : 0.32 + 0.78 * diff;
  gl_FragColor = vec4(c * shade, 1.0);
}`;

function makeWxTexture() {
  wxData = new Uint8Array(G.nx * G.ny * 4);
  wxTex = new THREE.DataTexture(wxData, G.nx, G.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  wxTex.magFilter = wxTex.minFilter = THREE.LinearFilter;
  wxTex.needsUpdate = true;
}

function makeTerrain() {
  if (terrainMesh) { scene.remove(terrainMesh); terrainGeo.dispose(); terrainMesh.material.dispose(); }
  const nx = REG.nx, ny = REG.ny, n = nx * ny;
  terrainGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, fi = REG.i0 + i / (nx - 1) * (REG.i1 - REG.i0), fj = REG.j0 + j / (ny - 1) * (REG.j1 - REG.j0);
    pos[3 * k] = xOfI(fi);
    pos[3 * k + 2] = zOfJ(fj);
    uv[2 * k] = (fi + 0.5) / G.nx;
    uv[2 * k + 1] = (fj + 0.5) / G.ny;
    if (i < nx - 1 && j < ny - 1) { idx[q++] = k; idx[q++] = k + nx; idx[q++] = k + 1; idx[q++] = k + 1; idx[q++] = k + nx; idx[q++] = k + nx + 1; }
  }
  terrainGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  terrainGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  terrainGeo.setAttribute("land", new THREE.BufferAttribute(landT, 1));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: terrainVS, fragmentShader: terrainFS,
    uniforms: {
      uWx: { value: wxTex }, uLight: { value: LIGHT }, uHaveWx: { value: R ? 1 : 0 }, uScale: { value: 1 },
      uRain: { value: RU.cols }, uRainV: { value: RU.vals }, uSnow: { value: SU.cols }, uSnowV: { value: SU.vals },
    },
  });
  terrainMesh = new THREE.Mesh(terrainGeo, mat);
  scene.add(terrainMesh);
  setHeights();
}

function setHeights() {
  const p = terrainGeo.attributes.position.array, e = exag();
  for (let k = 0; k < terrainH.length; k++) p[3 * k + 1] = Math.max(0, terrainH[k]) / 1000 * e; // sea ~0 m, lakes at their height
  terrainGeo.attributes.position.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  terrainGeo.computeBoundingSphere();
  terrainMesh.material.uniforms.uScale.value = e;
  $("exagV").textContent = e + "×";
  for (const q of particles || []) q.hist.length = 0;
  placeMarker();
}

// ---------- wind trails: screen-space ribbons (instanced quads, one per trail segment) ----------
const NP = 3600, NL = 12, SEG = NP * (NL - 1);
let particles = null, ribGeo, ribbons, uField = null, vField = null, histClock = 0;
const BAND_COL = C.WIND_BANDS.map((b) => C.hex(b[1]));
const regW = () => (REG.i1 - REG.i0) * G.kx, regH = () => (REG.j1 - REG.j0) * G.kz;
const regSize = () => Math.max(regW(), regH());

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
  particles = Array.from({ length: NP }, () => spawn({ hist: [] }, true));
}

function spawn(p, first) {
  p.x = xOfI(REG.i0) + Math.random() * regW();
  p.z = zOfJ(REG.j0) + Math.random() * regH();
  p.life = 2.5 + Math.random() * 4;
  p.age = first ? Math.random() * p.life : 0;
  p.hist.length = 0;
  return p;
}
function respawnAll() { for (const p of particles) spawn(p, true); }

// bilinear 10 m wind of the current hour at scene (x, z), turned to scene axes (x east along the rows, z south)
function windAt(x, z) {
  const fi = iOfX(x), fj = jOfZ(z);
  if (!(fi >= 0 && fj >= 0 && fi <= G.nx - 1 && fj <= G.ny - 1) || !uField) return null;
  const i = Math.min(Math.floor(fi), G.nx - 2), j = Math.min(Math.floor(fj), G.ny - 2), a = fi - i, b = fj - j, n = G.nx;
  const bl = (f) => (f[j * n + i] * (1 - a) + f[j * n + i + 1] * a) * (1 - b) + (f[(j + 1) * n + i] * (1 - a) + f[(j + 1) * n + i + 1] * a) * b;
  const u = bl(uField), v = bl(vField);
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  if (G.type === "ll") return [u, -v];
  const al = GR.north(GR.latlon(fj, fi)[1]), ca = Math.cos(al), sa = Math.sin(al);
  return [u * ca + v * sa, -(-u * sa + v * ca)];
}

function stepRibbons(dt) {
  if (!particles || !uField) return;
  const show = $("trails").checked;
  ribbons.visible = show;
  if (!show) return;
  const k = 2.2 * Number($("spd").value) * Math.max(1, regSize() / 900), e = exag();
  histClock += dt;
  const record = histClock > 0.06;
  if (record) histClock = 0;
  const A = ribGeo.attributes.a.array, B = ribGeo.attributes.b.array, Cc = ribGeo.attributes.c.array, Wd = ribGeo.attributes.w.array;
  let s = 0;
  for (const p of particles) {
    p.age += dt;
    const w = windAt(p.x, p.z);
    if (!w || p.age > p.life || !Number.isFinite(terrainAt(p.x, p.z))) spawn(p, false);
    else { p.x += w[0] * k * dt; p.z += w[1] * k * dt; p.kmh = Math.hypot(w[0], w[1]) * 3.6; }
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
const cv = document.createElement("canvas"), cx2 = cv.getContext("2d", { willReadFrequently: true });
async function loadPixels(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error(`${url}: ${r.status}`);
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
  cx2.drawImage(bmp, 0, 0);
  const d = cx2.getImageData(0, 0, bmp.width, bmp.height).data;
  bmp.close?.();
  return { w: cv.width, h: cv.height, rgba: d };
}

async function loadRun(md, rn, progress) {
  const id = md.id + "/" + rn.key;
  if (runCache.has(id)) return runCache.get(id);
  const p = (async () => {
    const out = { mid: md.id, key: rn.key, nt: rn.nt, S: rn.step, fields: {} };
    const jobs = [];
    for (const f of md.fields) {
      out.fields[f] = new Uint8Array(rn.nt * N);
      for (let k = 0; k < rn.nt; k++) jobs.push([f, k]);
    }
    let done = 0, next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [f, k] = jobs[next++];
        const im = await loadPixels(`${DATA}${md.id}/${rn.key}/${f}_${String(k).padStart(2, "0")}.webp`);
        const a = out.fields[f], o = k * N;
        for (let q = 0; q < N; q++) a[o + q] = im.rgba[4 * q];
        done++;
        if (progress) progress(done, jobs.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  })();
  runCache.set(id, p);
  p.catch(() => runCache.delete(id));
  if (runCache.size > 3) runCache.delete(runCache.keys().next().value);
  return p;
}

// value of field f at frame k, cell c (NaN when the model has no such field)
const fv = (f, k, c) => (R && R.fields[f] && (!COVER || COVER[c]) ? DEC[f][R.fields[f][k * N + c]] : NaN);
const has = (f) => !!(R && R.fields[f]);
// hourly values at cell c, hour h
function at(f, c, h) {
  if (!has(f)) return NaN;
  const a = (k) => fv(f, k, c);
  if (f === "pr") return C.hourlyPr(a, R.nt, R.S, h);
  if (f === "sn") { if (h <= 0) return 0; const k = Math.min(Math.ceil(h / R.S), R.nt - 1); return C.hourlyPr((q) => fv("pr", q, c), R.nt, R.S, h) * fv("ss", k, c); }
  if (f === "t" || f === "td" || f === "zs") return C.pchipAt(a, R.nt, R.S, h);
  return C.linAt(a, R.nt, R.S, h);
}

// whole-grid fields of the current hour: precipitation (hour ending at h), snow level, wind
function showHour() {
  if (!R) return;
  const S = R.S, nt = R.nt, h = hour;
  const k = Math.min(Math.floor(h / S), nt - 2), w = h / S - k;
  const zs = R.fields.zs, u = R.fields.u, v = R.fields.v, pr = R.fields.pr, Dz = DEC.zs, Du = DEC.u, Dv = DEC.v, Dp = DEC.pr;
  uField = uField && uField.length === N ? uField : new Float32Array(N);
  vField = vField && vField.length === N ? vField : new Float32Array(N);
  const o0 = k * N, o1 = (k + 1) * N;
  // precipitation: window kw (hour h ends in it), position m in it, neighbouring windows for the rate slope
  const kw = Math.min(Math.ceil(h / S), nt - 1), m = h - (kw - 1) * S, oP = kw * N, oPp = (kw - 1) * N, oPn = (kw + 1) * N;
  const hasPrev = kw > 1, hasNext = kw < nt - 1;
  for (let c = 0; c < N; c++) {
    if (COVER && !COVER[c]) { uField[c] = vField[c] = NaN; wxData[4 * c] = 0; wxData[4 * c + 1] = 255; wxData[4 * c + 3] = 255; continue; }
    uField[c] = (1 - w) * Du[u[o0 + c]] + w * Du[u[o1 + c]];
    vField[c] = (1 - w) * Dv[v[o0 + c]] + w * Dv[v[o1 + c]];
    let p = 0;
    if (h > 0) {
      const tot = Dp[pr[oP + c]];
      if (tot > 0) {
        const r = tot / S, rp = hasPrev ? Dp[pr[oPp + c]] / S : r, rn = hasNext ? Dp[pr[oPn + c]] / S : r;
        let s = 0, rm = 0;
        for (let q = 1; q <= S; q++) {
          const cc = q - 0.5, x = Math.max(cc < S / 2 ? rp + (r - rp) * (cc + S / 2) / S : r + (rn - r) * (cc - S / 2) / S, 0);
          s += x; if (q === m) rm = x;
        }
        p = s > 0 ? tot * rm / s : tot / S;
      }
    }
    wxData[4 * c] = Math.min(255, Math.round(Math.sqrt(Math.min(p, PRHI) / PRHI) * 255));
    wxData[4 * c + 1] = Math.round(Math.min(ZSHI, (1 - w) * Dz[zs[o0 + c]] + w * Dz[zs[o1 + c]]) / ZSHI * 255);
    wxData[4 * c + 3] = 255;
  }
  wxTex.needsUpdate = true;
  terrainMesh.material.uniforms.uHaveWx.value = 1;
  const t = run.t0 * 1000 + h * 3600000;
  $("when").textContent = FMT.format(new Date(t)) + " " + zoneName(t);
  $("lead").textContent = (model.kind === "analysis" ? `${model.name}` : `+${h + (run.off || 0)} h · ${model.name}, start ${FMTUTC(startMs())}`);
  $("hour").value = h;
  $("prev").disabled = h <= 0;
  $("next").disabled = h >= HMAX;
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}

let FMT, HFMT, DFMT, ZFMT;
function zoneName(t) {
  if (M.tz === "UTC") return "UTC";
  const z = ZFMT.formatToParts(new Date(t)).find((p) => p.type === "timeZoneName")?.value || "";
  return (M.zones || {})[z] || z;
}
function FMTUTC(ms) { const d = new Date(ms); return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")} UTC`; }

async function selectRun() {
  model = M.models.find((m) => m.id === $("model").value);
  run = model.runs.find((r) => r.key === $("run").value) || model.runs[0];
  status("Loading…");
  try {
    const r = await loadRun(model, run, (d, n) => status(`Loading ${Math.round(100 * d / n)} %`));
    if (r.mid !== model.id || r.key !== run.key) return;
    R = r;
    HMAX = (R.nt - 1) * R.S;
    $("hour").max = HMAX;
    $("t0").textContent = model.kind === "analysis" ? DFMT.format(new Date(run.t0 * 1000)) : `+${run.off || 0} h`;
    $("t1").textContent = model.kind === "analysis" ? DFMT.format(new Date((run.t0 + HMAX * 3600) * 1000)) : `+${HMAX + (run.off || 0)} h`;
    $("interp").textContent = `hourly frames interpolated from ${R.S}-hourly ${model.kind === "analysis" ? "data" : "model output"}`;
    hour = Math.min(hour, HMAX);
    status("");
    showHour();
  } catch (e) { status("Could not load the data: " + e.message); }
}

const startMs = () => (run.t0 - 3600 * (run.off || 0)) * 1000;
function status(t) { $("status").textContent = t; $("status").style.display = t ? "block" : "none"; }

// ---------- inspect, marker and meteogram ----------
let selected = null, marker = null;
function placeMarker() {
  if (marker) { scene.remove(marker); marker.geometry.dispose(); marker = null; }
  if (!selected) return;
  const y = terrainAt(selected.x, selected.z) / 1000 * exag(), s = Math.max(1, camera.position.distanceTo(controls.target) / 120);
  const g = new THREE.CylinderGeometry(0.0, 2.2 * s, 9 * s, 12);
  g.rotateX(Math.PI);
  g.translate(0, 4.5 * s, 0);
  marker = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf0b44c }));
  marker.position.set(selected.x, (Number.isFinite(y) ? y : 0) + 0.2, selected.z);
  scene.add(marker);
}

function select(x, z) {
  const c = cellAt(x, z);
  if (!c) return;
  const [lat, lon] = latlonOf(x, z);
  selected = { x, z, j: c[0], i: c[1], c: c[0] * G.nx + c[1], lat, lon };
  placeMarker();
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}

const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
const llText = (lat, lon, d = 2) => `${Math.abs(lat).toFixed(d)}°${lat < 0 ? "S" : "N"} ${Math.abs(lon).toFixed(d)}°${lon < 0 ? "W" : "E"}`;
function updateInfo() {
  if (!selected || !R) return;
  const { c, lat, lon } = selected, h = hour;
  const t = at("t", c, h) - 273.15, td = at("td", c, h) - 273.15, pr = at("pr", c, h), sn = at("sn", c, h);
  const [kmh, dir] = C.windOf(at("u", c, h), at("v", c, h)), zs = at("zs", c, h), cc = at("cc", c, h);
  const z = terrainAt(selected.x, selected.z);
  $("info").innerHTML = `<b>${C.nearTown(TOWNS, lat, lon)}</b><br><span class="k">${llText(lat, lon)} · terrain ${Math.round(z)} m</span><br>`
    + `Temperature <b>${f1(t)} °C</b>${Number.isFinite(td) ? ` · dewpoint <b>${f1(td)} °C</b>` : ""}<br>`
    + `Wind <b>${C.compass16(dir)} ${Math.round(kmh)} km/h</b>${Number.isFinite(cc) ? ` · cloud <b>${Math.round(cc)} %</b>` : ""}<br>`
    + `Precipitation <b>${f1(pr)} mm</b> in the hour${sn >= 0.05 ? ` (snow ${f1(sn)} mm w.e.)` : ""}<br>`
    + `Snow level ≈ <b>${Math.round(zs / 50) * 50} m</b><br><button id="openMg" style="margin-top:6px">Point ${model.kind === "analysis" ? "time series" : "forecast"}</button>`;
  $("openMg").onclick = () => { $("mg").hidden = false; drawMeteogram(); };
}

function drawMeteogram() {
  if (!selected || !R) return;
  const { c, lat, lon } = selected, n = HMAX + 1, t0 = run.t0 * 1000;
  const T = (h) => new Date(t0 + h * 3600000);
  const z = terrainAt(selected.x, selected.z);
  const s = { t: [], td: [], pr: [], sn: [], kmh: [], dir: [], zs: [], cc: [] };
  for (let h = 0; h < n; h++) {
    s.t.push(at("t", c, h) - 273.15); s.td.push(at("td", c, h) - 273.15);
    s.pr.push(at("pr", c, h)); s.sn.push(at("sn", c, h)); s.cc.push(at("cc", c, h));
    const [k, d] = C.windOf(at("u", c, h), at("v", c, h)); s.kmh.push(k); s.dir.push(d); s.zs.push(at("zs", c, h));
  }
  const tot = s.pr.reduce((a, b) => a + b, 0), snt = s.sn.reduce((a, b) => a + b, 0);
  $("mgPlace").textContent = C.nearTown(TOWNS, lat, lon);
  $("mgSub").textContent = `${llText(lat, lon, 3)} · terrain ${Math.round(z)} m · ${model.name}`
    + (model.kind === "analysis" ? "" : `, start ${FMTUTC(startMs())}`) + ` · ${HMAX} h total ${tot.toFixed(1)} mm`
    + (snt >= 0.1 ? ` (snow ${snt.toFixed(1)} mm w.e.)` : "");
  $("mgNote").textContent = `Hourly values interpolated from ${R.S}-hourly data (precipitation keeps the ${R.S} h totals; bars = the hour ending at the tick). `
    + "Values of the model cell (2.5 km or 3′), not of the finer terrain. Shading: sun below the horizon. Click a chart to choose the hour."
    + (M.tz === "UTC" ? " Times UTC." : "");
  const X0 = 52, XW = 790, x = (h) => X0 + h / (n - 1) * XW;
  const panels = [
    { title: "Temperature (orange) and dewpoint (teal) · °C", lines: [[s.t, "#f59f45"], [s.td, "#3fc1b0"]] },
    { title: "Precipitation in the hour · rain (blue), snow water equivalent (purple) · mm", bars: true },
    { title: "10 m wind · km/h · arrows show where the wind blows to (north up)", lines: [[s.kmh, "#f2d16b"]], arrows: true, zero: true },
  ];
  if (has("cc")) panels.push({ title: "Total cloud · %", lines: [[s.cc, "#c6d9ee"]], zero: true, hi: 100 });
  panels.push({ title: "Snow level (approximate) · m · dashed: terrain height here", lines: [[s.zs, "#b59cf0"]], ref: z, zero: true });
  const step = n > 100 ? 12 : 6;
  let html = "";
  for (const P of panels) {
    const vals = P.bars ? s.pr : P.lines.flatMap((l) => l[0]).concat(P.ref !== undefined ? [P.ref] : []);
    const fin = vals.filter(Number.isFinite);
    let lo = P.bars || P.zero ? 0 : Math.min(...fin), hi = P.hi || Math.max(...fin, P.bars ? 1 : lo + 1);
    const st = C.niceStep(hi - lo);
    lo = Math.floor(lo / st) * st; hi = Math.ceil(hi / st) * st;
    if (hi <= lo) hi = lo + st;
    const y = (v) => 128 - (v - lo) / (hi - lo) * 96;
    let g = `<svg class="ch" viewBox="0 0 860 150"><text x="${X0}" y="16" fill="#dfe8ee" font-size="12">${P.title}</text>`;
    for (let h = 0; h < n - 1; h++) if (C.sunElevation(t0 + (h + 0.5) * 3600000, lat, lon) < 0) g += `<rect x="${x(h)}" y="32" width="${x(h + 1) - x(h) + 0.3}" height="96" fill="#9fb3c8" opacity=".1"/>`;
    for (let v = lo; v <= hi + 1e-9; v += st) g += `<path d="M${X0} ${y(v)}H${X0 + XW}" stroke="#9fb3c8" opacity=".18"/><text x="${X0 - 6}" y="${y(v) + 4}" fill="#9fb0bd" font-size="10" text-anchor="end">${+v.toFixed(1)}</text>`;
    for (let h = 0; h < n; h++) {
      const hr = Number(HFMT.format(T(h)));
      if (hr % step === 0) {
        g += `<path d="M${x(h)} 32V132" stroke="#9fb3c8" opacity="${hr === 0 ? 0.45 : 0.15}"/><text x="${x(h)}" y="144" fill="#9fb0bd" font-size="10" text-anchor="middle">${hr === 0 ? DFMT.format(T(h)) : String(hr).padStart(2, "0")}</text>`;
      }
    }
    if (P.bars) {
      const bw = Math.max(0.6, XW / (n - 1) - (n > 100 ? 0.3 : 1.5));
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
      if (P.arrows) for (let h = 0; h < n; h += n > 100 ? 6 : 3) {
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

// ---------- regions and camera ----------
let fly = null;
function flyTo(target, dist, dir) {
  const d = dir || camera.position.clone().sub(controls.target).normalize();
  fly = { t: 0, p0: camera.position.clone(), q0: controls.target.clone(), q1: target, p1: target.clone().add(d.multiplyScalar(dist)) };
}
function resetView(instant) {
  const tgt = new THREE.Vector3(xOfI((REG.i0 + REG.i1) / 2), 0, zOfJ((REG.j0 + REG.j1) / 2));
  const size = Math.max(regW() / Math.max(camera.aspect, 0.6), regH());
  const dir = new THREE.Vector3(0, 0.78, 0.62).normalize(), dist = size * 1.05;
  controls.maxDistance = size * 3;
  if (instant) { controls.target.copy(tgt); camera.position.copy(tgt.clone().add(dir.multiplyScalar(dist))); controls.update(); }
  else flyTo(tgt, dist, dir);
}
async function loadRegion(id, instant) {
  const reg = M.terrain.regions.find((r) => r.id === id);
  status("Loading terrain…");
  try {
    let t = terrCache.get(id);
    if (!t) {
      const im = await loadPixels(`${DATA}terrain_${id}.png`);
      if (im.w !== reg.nx || im.h !== reg.ny) throw Error("terrain size mismatch");
      const h = new Float32Array(im.w * im.h), l = new Float32Array(im.w * im.h);
      for (let k = 0; k < h.length; k++) { h[k] = im.rgba[4 * k] * 256 + im.rgba[4 * k + 1] - M.terrain.offset; l[k] = im.rgba[4 * k + 2] > 127 ? 1 : 0; }
      t = { h, l };
      terrCache.set(id, t);
    }
    REG = reg; terrainH = t.h; landT = t.l;
    makeTerrain();
    respawnAll();
    for (const L of labelEls) L.y = NaN;
    resetView(instant);
    status("");
  } catch (e) { status("Could not load the terrain: " + e.message); }
}

// ---------- place labels and search ----------
let labelEls = [];
function makeLabels() {
  const box = $("labs");
  labelEls = TOWNS.filter((t) => M.labels.includes(t[0])).map((t) => {
    const el = document.createElement("div");
    el.className = "lab";
    el.textContent = t[0];
    box.append(el);
    const [x, z] = sceneOf(t[1], t[2]);
    return { el, x, z, y: NaN };
  });
}
const tmp = new THREE.Vector3();
function updateLabels() {
  const on = $("labels").checked, dist = camera.position.distanceTo(controls.target), e = exag();
  for (const L of labelEls) {
    const y = terrainAt(L.x, L.z);
    if (!on || !Number.isFinite(y)) { L.el.style.display = "none"; continue; }
    tmp.set(L.x, y / 1000 * e + 0.3, L.z).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    L.el.style.display = vis ? "block" : "none";
    if (vis) { L.el.style.left = ((tmp.x + 1) / 2 * innerWidth) + "px"; L.el.style.top = ((1 - tmp.y) / 2 * innerHeight) + "px"; L.el.style.opacity = dist > 1.4 * regSize() ? 0.75 : 1; }
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
      const [x, z] = sceneOf(t[1], t[2]);
      if (!cellAt(x, z)) { status(t[0] + " is outside the model domain"); setTimeout(() => status(""), 2500); return; }
      if (!Number.isFinite(terrainAt(x, z))) { status(t[0] + " is outside this view: choose another region"); setTimeout(() => status(""), 3000); return; }
      select(x, z);
      const y = terrainAt(x, z) / 1000 * exag();
      flyTo(new THREE.Vector3(x, Number.isFinite(y) ? y : 0, z), Math.max(120, regSize() * 0.25));
    };
    box.append(b);
  }
}

// ---------- compass: screen direction of true north at the view centre ----------
function updateCompass() {
  let al = 0;
  if (G.type !== "ll") { const [, lon] = latlonOf(controls.target.x, controls.target.z); al = GR.north(lon); }
  const d = new THREE.Vector3(50 * Math.sin(al), 0, -50 * Math.cos(al));
  const a = controls.target.clone().project(camera), b = controls.target.clone().add(d).project(camera);
  const ang = Math.atan2((b.x - a.x) * innerWidth, (b.y - a.y) * innerHeight);
  $("needle").style.transform = `rotate(${ang}rad)`;
}

// ---------- timeline ----------
function setHour(h) { hour = Math.max(0, Math.min(HMAX, h)); showHour(); }
function togglePlay(on) {
  playing = on ?? !playing;
  $("play").textContent = playing ? "❚❚ Pause" : "▶ Play";
  $("play").classList.toggle("on", playing);
  clearInterval(playTimer);
  if (playing) playTimer = setInterval(() => setHour(hour >= HMAX ? 0 : hour + 1), 450);
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
  const dist = camera.position.distanceTo(controls.target);
  camera.near = Math.max(0.2, dist / 2000); camera.far = dist * 20 + 2000; camera.updateProjectionMatrix();
  if (REG) { stepRibbons(dt); updateLabels(); updateCompass(); }
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
  if (e.target.tagName === "SELECT") return;
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
  G = M.grid; GR = C.makeGrid(G); N = G.nx * G.ny; CX = (G.nx - 1) / 2; CZ = (G.ny - 1) / 2;
  for (const f in M.enc) DEC[f] = C.decoder(M.enc[f]);
  const tz = M.tz;
  FMT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  HFMT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" });
  DFMT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
  ZFMT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" });
  makeWxTexture();
  if (M.cover) {
    const im = await loadPixels(DATA + "cover.png");
    COVER = new Uint8Array(N);
    for (let k = 0; k < N; k++) COVER[k] = im.rgba[4 * k] > 127 ? 1 : 0;
  }
  makeRibbons();
  makeLabels();
  for (const r of M.terrain.regions) $("view").append(new Option(r.name, r.id));
  await loadRegion("all", true);
  for (const m of M.models) $("model").append(new Option(m.name, m.id));
  const fillRuns = () => {
    const md = M.models.find((m) => m.id === $("model").value), cur = $("run").value || M.defaultRun;
    $("run").replaceChildren(...md.runs.map((r) => { const b = (r.t0 - 3600 * (r.off || 0)) * 1000; return new Option(md.kind === "analysis" ? r.label : FMTUTC(b) + " (" + DFMT.format(new Date(b)) + ")", r.key); }));
    $("run").value = md.runs.some((r) => r.key === cur) ? cur : md.runs[0].key;
  };
  $("model").value = M.defaultModel || M.models[0].id;
  fillRuns();
  $("run").value = M.defaultRun || $("run").value;
  model = M.models.find((m) => m.id === $("model").value);
  run = model.runs.find((r) => r.key === $("run").value) || model.runs[0];
  hour = run.peak || 0;
  $("model").onchange = () => { fillRuns(); selectRun(); };
  $("run").onchange = selectRun;
  $("hour").oninput = () => setHour(Number($("hour").value));
  $("prev").onclick = () => setHour(hour - 1);
  $("next").onclick = () => setHour(hour + 1);
  $("peak").onclick = () => setHour(run.peak || 0);
  $("play").onclick = () => togglePlay();
  $("exag").oninput = setHeights;
  $("view").onchange = () => loadRegion($("view").value, false);
  $("reset").onclick = () => resetView(false);
  $("q").oninput = searchPlaces;
  requestAnimationFrame(frame);
  await selectRun();
}
main();
