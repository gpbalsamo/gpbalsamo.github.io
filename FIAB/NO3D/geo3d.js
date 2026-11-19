// 3D terrain-weather viewer for the FIAB domains (NZ3D, NO3D, CA3D, CONUS3D): terrain relief (IFS TCo7999 orography,
// one lattice per region) with the model precipitation painted on it (snow above the snow level), animated 10 m wind
// trails, an hourly timeline and a point meteogram. A generalisation of viz/it3d to projected grids ("lcc") and to
// model frames every S hours, the hourly values being made here (core.js). Data from build3d.py and terrain3d.py.
// 2026-11 additions: landscape colour modes (rain/snow, temperature, wind speed, terrain) with opacity, MSLP isobars
// (traced in the terrain shader), ray-marched 3D cloud from the relative humidity on pressure levels, fly-to and orbit
// around a place, playback speed, top-down view, a clear view with a floating toolbar on phones, and a text forecast
// made by rules from the point values.
// 2026-11 (3): 3D buildings from OpenStreetMap (osm3d.py tiles), Neil-style map time label, orbit readouts.
// 2026-11 (2): terrain height to 20x, cloud texture inside the cloud and see-through, falling rain (with splashes) and
// snow near the view, video recording and snapshots of the view.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as C from "./core.js";

const $ = (id) => document.getElementById(id);
const DATA = "data/", DEMDIR = "dem/", BLDDIR = "bld/"; // dem/ beside data/ (the live chain mirrors data/ with --delete)
let M, TOWNS, G, GR, N, CX, CZ, REG, terrainH, landT, COVER = null;
let model, run, R = null, hour = 0, playing = false, playTimer = null, HMAX = 72;
const runCache = new Map(), terrCache = new Map();
const DEC = {};
const PRHI = 60, ZSHI = 6000; // display texture: hourly precipitation (sqrt) and snow level ranges
const PHONE = matchMedia("(max-width: 700px)").matches || (matchMedia("(pointer: coarse)").matches && innerHeight < 500);
let MODE = 0, RLEV = [], RW = 0, RH = 0; // landscape colour mode; humidity levels (hPa, ascending height), their grid
const OPAC = { 0: 0.85, 1: 0.9, 2: 0.7 };
const isRh = (f) => /^[rh]\d+$/.test(f); // humidity and height of a pressure level, on every RSUB-th cell

// ---------- geometry: cell index (fj rows from the north, fi columns from the west) <-> scene km ----------
const xOfI = (fi) => (fi - CX) * G.kx, zOfJ = (fj) => (fj - CZ) * G.kz;
const iOfX = (x) => x / G.kx + CX, jOfZ = (z) => z / G.kz + CZ;
const sceneOf = (lat, lon) => { const [fj, fi] = GR.index(lat, lon); return [xOfI(fi), zOfJ(fj)]; };
const latlonOf = (x, z) => GR.latlon(jOfZ(z), iOfX(x));
const exag = () => Number($("exag").value);

// terrain height (m) at scene (x, z) as the mesh draws it (linear on its triangles); NaN outside the region lattice
function terrainAt(x, z) {
  const fi = iOfX(x), fj = jOfZ(z);
  if (demLev >= 0) { const d = demAt(fi, fj); if (d === d) return d; }
  const a = (fi - REG.i0) / (REG.i1 - REG.i0) * (REG.nx - 1), b = (fj - REG.j0) / (REG.j1 - REG.j0) * (REG.ny - 1);
  if (!(a >= 0 && b >= 0 && a <= REG.nx - 1 && b <= REG.ny - 1)) return NaN;
  const i = Math.min(Math.floor(a), REG.nx - 2), j = Math.min(Math.floor(b), REG.ny - 2), U = a - i, V = b - j, n = REG.nx;
  const h = (k) => Math.max(0, terrainH[k]), k00 = j * n + i, h10 = h(k00 + 1), h01 = h(k00 + n);
  // the mesh's own triangles: (i,j) (i,j+1) (i+1,j) and (i+1,j) (i,j+1) (i+1,j+1), split along the (i+1,j)-(i,j+1) diagonal
  return U + V <= 1 ? h(k00) + U * (h10 - h(k00)) + V * (h01 - h(k00)) : h(k00 + n + 1) + (1 - U) * (h01 - h(k00 + n + 1)) + (1 - V) * (h10 - h(k00 + n + 1));
}
// model cell (j, i) of a scene point, or null outside the grid
function cellAt(x, z) {
  const i = Math.round(iOfX(x)), j = Math.round(jOfZ(z));
  return i >= 0 && j >= 0 && i < G.nx && j < G.ny ? [j, i] : null;
}

// ---------- three.js scene ----------
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
catch (e) {
  $("status").textContent = "This page needs WebGL2 (3D graphics), which this browser could not start: try another browser or enable hardware acceleration.";
  $("status").style.display = "block";
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, PHONE ? 1.25 : 2));
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
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
renderer.domElement.style.touchAction = "none";
let dragging = false;
controls.addEventListener("start", () => { dragging = true; });
controls.addEventListener("end", () => { dragging = false; lastMove = performance.now(); });
controls.addEventListener("change", () => { lastMove = performance.now(); });

let terrainGeo = null, terrainMesh = null, wxTex = null, wxData = null;
const LIGHT = new THREE.Vector3(-0.5, 0.75, -0.35).normalize();
function rampUniform(stops) {
  return { cols: stops.map((s) => new THREE.Vector3(...s[1])), vals: stops.map((s) => Math.log10(s[0])) };
}
const RU = rampUniform(C.RAIN), SU = rampUniform(C.SNOW);
const linUniform = (stops) => ({ cols: stops.map((s) => new THREE.Vector3(...s[1])), vals: stops.map((s) => s[0]) });
const TU = linUniform(C.TEMP), WU = linUniform(C.WSPD);

const terrainVS = `
attribute float land; attribute float dem;
varying vec2 vUv; varying float vH; varying float vLand; varying vec3 vN; varying vec2 vXZ; varying float vDem;
uniform float uScale;
void main(){
  vDem = dem; vUv = uv; vH = position.y / uScale * 1000.0; vLand = land; vN = normalize(normal); vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const terrainFS = `
precision highp float;
varying vec2 vUv; varying float vH; varying float vLand; varying vec3 vN; varying vec2 vXZ;
varying float vDem; uniform sampler2D uDemMask; uniform float uDemOn; uniform vec4 uDemK; uniform sampler2D uCoast; uniform vec4 uCoastK;
uniform float uDayLight; uniform float uSunUp; uniform sampler2D uShadow; uniform float uShadowOn; uniform vec4 uShadowBox; uniform float uCover;
uniform sampler2D uWx; uniform sampler2D uWx2; uniform vec3 uLight; uniform float uHaveWx;
uniform float uMode; uniform float uOpac; uniform float uIso; uniform float uIsoStep; uniform vec2 uMs;
uniform vec3 uTemp[${C.TEMP.length}]; uniform float uTempV[${C.TEMP.length}];
uniform vec3 uWind[${C.WSPD.length}]; uniform float uWindV[${C.WSPD.length}];
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
vec3 rampT(float v){
  vec3 c=uTemp[0];
  for(int i=1;i<${C.TEMP.length};i++){ c = v>=uTempV[i-1] ? mix(uTemp[i-1],uTemp[i],clamp((v-uTempV[i-1])/(uTempV[i]-uTempV[i-1]),0.,1.)) : c; }
  return c;
}
vec3 rampW(float v){
  vec3 c=uWind[0];
  for(int i=1;i<${C.WSPD.length};i++){ c = v>=uWindV[i-1] ? mix(uWind[i-1],uWind[i],clamp((v-uWindV[i-1])/(uWindV[i]-uWindV[i-1]),0.,1.)) : c; }
  return c;
}
vec3 rampSnow(float lv){
  vec3 c=uSnow[0];
  for(int i=1;i<${C.SNOW.length};i++){ c = lv>=uSnowV[i-1] ? mix(uSnow[i-1],uSnow[i],clamp((lv-uSnowV[i-1])/(uSnowV[i]-uSnowV[i-1]),0.,1.)) : c; }
  return c;
}
void main(){
  // the base lattice gives way to the close-up tiles where they are loaded
  if(uDemOn > 0.5 && vDem < 0.5){
    // nearest lookups (linear filtering would cut into empty texels at inner corners); the hole is eroded by ~0.06 cell
    // towards tiles that are not shown, so that the base overlaps their outer edges instead of leaving a crack
    vec2 mc = (vUv * uDemK.xy - 0.5) / uDemK.zw, e = vec2(0.06) / uDemK.zw;
    if(texture2D(uDemMask, mc).r > 0.5 && texture2D(uDemMask, mc + vec2(e.x, 0.0)).r > 0.5 && texture2D(uDemMask, mc - vec2(e.x, 0.0)).r > 0.5
       && texture2D(uDemMask, mc + vec2(0.0, e.y)).r > 0.5 && texture2D(uDemMask, mc - vec2(0.0, e.y)).r > 0.5) discard;
  }
  // land or sea: the OpenStreetMap coastline masks near the view (coast3d.py), else the DEM's land at the vertices
  float lnd = vLand;
  if(uCoastK.w > 0.5){
    vec2 cc = (vUv * uDemK.xy - 0.5 - uCoastK.xy) / uCoastK.z;
    if(cc.x > 0.0 && cc.y > 0.0 && cc.x < 1.0 && cc.y < 1.0){ vec2 m = texture2D(uCoast, cc).rg; if(m.g > 0.99) lnd = m.r > 0.5 ? 1.0 : 0.0; }
  }
  vec3 n = normalize(vN);
  float diff = max(dot(n, uLight), 0.0);
  vec3 c = lnd < 0.5 ? vec3(.07,.19,.27) : hyps(vH);
  float shade = lnd < 0.5 ? 0.75 + 0.25 * diff : 0.32 + 0.78 * diff;
  if(uHaveWx > 0.5){
    vec4 w = texture2D(uWx, vUv), w2 = texture2D(uWx2, vUv);
    if(uMode < 0.5){
      float pr = w.r * w.r * ${PRHI.toFixed(1)}, zs = w.g * ${ZSHI.toFixed(1)};
      if(pr >= 0.1){
        float lv = log(pr) / log(10.0);
        vec3 pc = (lnd > 0.5 && vH >= zs) ? rampSnow(lv) : rampRain(lv);
        c = mix(c, pc, clamp(uOpac / 0.85 * (0.35 + 0.5 * clamp((lv + 1.0) / 1.3, 0.0, 1.0)), 0.0, 1.0)); // light rain lets the terrain show through
      }
    } else if(uMode < 1.5){
      c = mix(c, rampT(w2.r * 80.0 - 33.15), uOpac) * (lnd < 0.5 ? 0.78 : 1.0); shade = 0.62 + 0.42 * diff;
    } else if(uMode < 2.5){
      c = mix(c, rampW(w2.g * 180.0), uOpac) * (lnd < 0.5 ? 0.8 : 1.0); shade = lnd < 0.5 ? 0.8 + 0.2 * diff : 0.5 + 0.6 * diff;
    }
    if(uCover > 0.5){ // fallback without volumetric clouds: total cloud cover as a white veil
      c = mix(c, vec3(.93,.95,.97), smoothstep(.15, 1., w2.a) * .5);
    }
    if(uIso > 0.5){
      float msl = mix(uMs.x, uMs.y, w2.b), q = msl / uIsoStep, fw = max(fwidth(q), 1e-4);
      float d = abs(fract(q + 0.5) - 0.5) / fw, line = (1.0 - smoothstep(0.6, 1.7, d)) * (1.0 - smoothstep(1500.0, 2600.0, vH));
      vec3 ic = (uMode > 0.5 && uMode < 2.5) ? vec3(0.08, 0.1, 0.13) : vec3(0.97);
      c = mix(c, ic / max(shade, 0.3), 0.85 * line);
    }
  }
  if(uShadowOn > 0.5){ // cloud shadows on the terrain (sunlight transmitted through the cloud volume)
    float T = texture2D(uShadow, (vXZ - uShadowBox.xy) / (uShadowBox.zw - uShadowBox.xy)).r;
    shade = mix(shade, shade * (0.45 + 0.55 * T), uSunUp);
  }
  gl_FragColor = vec4(c * shade * uDayLight, 1.0);
}`;

let wx2Tex = null, wx2Data = null;
function makeWxTexture() {
  wxData = new Uint8Array(G.nx * G.ny * 4);
  wxTex = new THREE.DataTexture(wxData, G.nx, G.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  wxTex.magFilter = wxTex.minFilter = THREE.LinearFilter;
  wxTex.needsUpdate = true;
  // second display texture: R 2 m temperature (240..320 K), G 10 m wind speed (0..50 m/s), B MSLP (uMs range)
  wx2Data = new Uint8Array(G.nx * G.ny * 4);
  wx2Tex = new THREE.DataTexture(wx2Data, G.nx, G.ny, THREE.RGBAFormat, THREE.UnsignedByteType);
  wx2Tex.magFilter = wx2Tex.minFilter = THREE.LinearFilter;
  wx2Tex.needsUpdate = true;
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
  terrainGeo.setAttribute("dem", new THREE.BufferAttribute(new Float32Array(n), 1));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: terrainVS, fragmentShader: terrainFS,
    uniforms: {
      uWx: { value: wxTex }, uWx2: { value: wx2Tex }, uLight: { value: LIGHT }, uHaveWx: { value: R ? 1 : 0 }, uScale: { value: 1 },
      uRain: { value: RU.cols }, uRainV: { value: RU.vals }, uSnow: { value: SU.cols }, uSnowV: { value: SU.vals },
      uTemp: { value: TU.cols }, uTempV: { value: TU.vals }, uWind: { value: WU.cols }, uWindV: { value: WU.vals },
      uDayLight: { value: 1 }, uSunUp: { value: 1 }, uShadow: { value: null }, uShadowOn: { value: 0 }, uShadowBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uCover: { value: 0 },
      uDemMask: { value: demMaskTex }, uDemOn: { value: 0 }, uDemK: { value: new THREE.Vector4(G.nx, G.ny, 1, 1) },
      uCoast: { value: coastTex }, uCoastK: { value: new THREE.Vector4(0, 0, 1, 0) },
      uMode: { value: MODE }, uOpac: { value: OPAC[MODE] ?? 1 }, uIso: { value: 0 }, uIsoStep: { value: 4 }, uMs: { value: new THREE.Vector2(980, 1040) },
    },
  });
  mat.extensions = { derivatives: true };
  mat.uniforms.uLight.value = LIGHT.clone();
  terrainMesh = new THREE.Mesh(terrainGeo, mat);
  scene.add(terrainMesh);
  for (const t of demTiles.values()) if (t.mesh) t.mesh.material = mat;
  demKey = "";
  setHeights();
  if (R) { applyIso(); showHour(); }
}

let lastE = null;
function setHeights() {
  const p = terrainGeo.attributes.position.array, e = exag();
  // the view follows the new height scale (the look-at point and the camera keep their place above the ground)
  if (lastE && lastE !== e && camera) { const r = e / lastE, h0 = camera.position.y - controls.target.y; controls.target.y *= r; camera.position.y = controls.target.y + h0; }
  lastE = e;
  for (let k = 0; k < terrainH.length; k++) p[3 * k + 1] = Math.max(0, terrainH[k]) / 1000 * e; // sea ~0 m, lakes at their height
  terrainGeo.attributes.position.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  terrainGeo.computeBoundingSphere();
  terrainMesh.material.uniforms.uScale.value = e;
  for (const t of demTiles.values()) if (t.mesh) demHeights(t, e);
  for (const t of bldTiles.values()) if (t.mesh) bldHeights(t, e);
  for (const L of LMK) lmkHeights(L, e);
  $("exagV").textContent = e + "×";
  for (const q of particles || []) q.hist.length = 0;
  placeMarker();
  if (typeof updateCloudBox === "function") updateCloudBox();
}

// ---------- close-up terrain (Copernicus DEM GLO-90): tiles around the look-at point, two levels of detail ----------
// dem3d.py cuts the DEM into square tiles of the grid's cell-index space (level 0: 32 cells, ~415 m vertices; level 1:
// 8 cells, ~105 m). When the camera comes close, the tiles of the level that suits the distance are loaded around the
// point it looks at and drawn with the terrain's own material; the base lattice is masked out under them (a texture of
// 8-cell texels), so the weather, light and cloud shadows carry over unchanged.
let DEM = null, demLev = -1, demKey = "", demClock = 0, demMaskTex = null, demMaskData = null, demMx = 1, demMy = 1, demLoading = 0;
const demTiles = new Map(), demIdx = [];
async function loadDemMeta() {
  try { const r = await fetch(DEMDIR + "dem.json"); DEM = r.ok ? await r.json() : null; } catch (e) { DEM = null; }
  $("demRow").hidden = !DEM;
  if (!DEM) return;
  DEM.sets = DEM.levels.map((L) => new Set(L.tiles.map((t) => t[0] + "_" + t[1])));
  const Tm = Math.min(...DEM.levels.map((L) => L.T));
  DEM.Tm = Tm; demMx = Math.ceil((G.nx - 1) / Tm); demMy = Math.ceil((G.ny - 1) / Tm);
  demMaskData = new Uint8Array(demMx * demMy);
  demMaskTex = new THREE.DataTexture(demMaskData, demMx, demMy, THREE.RedFormat, THREE.UnsignedByteType);
  demMaskTex.minFilter = demMaskTex.magFilter = THREE.NearestFilter; demMaskTex.unpackAlignment = 1; demMaskTex.needsUpdate = true;
  if (terrainMesh) { const u = terrainMesh.material.uniforms; u.uDemMask.value = demMaskTex; u.uDemK.value.set(G.nx, G.ny, Tm * demMx, Tm * demMy); }
}
function demIndex(S) {
  if (demIdx[S]) return demIdx[S];
  const idx = new Uint32Array((S - 1) * (S - 1) * 6);
  let q = 0;
  for (let j = 0; j < S - 1; j++) for (let i = 0; i < S - 1; i++) { const k = j * S + i; idx[q++] = k; idx[q++] = k + S; idx[q++] = k + 1; idx[q++] = k + 1; idx[q++] = k + S; idx[q++] = k + S + 1; }
  return (demIdx[S] = new THREE.BufferAttribute(idx, 1));
}
function demHeights(t, e) {
  const p = t.mesh.geometry.attributes.position.array;
  for (let k = 0; k < t.h.length; k++) p[3 * k + 1] = Math.max(0, t.h[k]) / 1000 * e;
  t.mesh.geometry.attributes.position.needsUpdate = true;
  t.mesh.geometry.computeVertexNormals();
}
async function loadDemTile(lev, tj, ti) {
  const key = `${lev}/${tj}_${ti}`, L = DEM.levels[lev], S = L.S, T = L.T;
  const t = { lev, tj, ti, mesh: null, h: null, used: performance.now() };
  demTiles.set(key, t);
  demLoading++;
  try {
    const im = await loadPixels(`${DEMDIR}${lev}/${tj}_${ti}.png`);
    const n = S * S, h = new Float32Array(n), land = new Float32Array(n), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const k = j * S + i, fi = ti * T + i / (S - 1) * T, fj = tj * T + j / (S - 1) * T;
      h[k] = im.rgba[4 * k] * 256 + im.rgba[4 * k + 1] - DEM.offset;
      land[k] = im.rgba[4 * k + 2] > 127 ? 1 : 0;
      pos[3 * k] = xOfI(fi); pos[3 * k + 2] = zOfJ(fj);
      uv[2 * k] = (fi + 0.5) / G.nx; uv[2 * k + 1] = (fj + 0.5) / G.ny;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("land", new THREE.BufferAttribute(land, 1));
    g.setAttribute("dem", new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
    g.setIndex(demIndex(S));
    t.h = h;
    t.mesh = new THREE.Mesh(g, terrainMesh.material);
    t.mesh.visible = false;
    t.mesh.frustumCulled = false; // few meshes; heights change with the exaggeration
    demHeights(t, exag());
    if (demTiles.get(key) === t) scene.add(t.mesh); else g.dispose();
  } catch (e) { t.failed = true; }
  demLoading--;
  demKey = "";
}
// ---------- sharp coastline (OpenStreetMap land polygons, coast3d.py): masks of ~40 m pixels on the finest close-up
// tiles, gathered around the look-at point into one texture (R land 0..255, anti-aliased; G 255 where known) that the
// terrain shader reads per pixel; elsewhere the land of the DEM at the vertices ----------
let COAST = null, coastTex = null, coastData = null, coastKey = "", coastClock = 0;
const COAST_W = 6, coastPng = new Map();
async function loadCoastMeta() {
  COAST = null;  // dem.json says whether this page has coast masks (coast3d.py)
  if (DEM && DEM.coast) try { const r = await fetch(DEMDIR + "coast/index.json"); COAST = r.ok ? await r.json() : null; } catch (e) { COAST = null; }
  const n = COAST ? COAST_W * COAST.M : 1;
  coastData = new Uint8Array(n * n * 2);
  coastTex = new THREE.DataTexture(coastData, n, n, THREE.RGFormat, THREE.UnsignedByteType);
  coastTex.minFilter = coastTex.magFilter = THREE.LinearFilter; coastTex.unpackAlignment = 1; coastTex.needsUpdate = true;
  if (terrainMesh) terrainMesh.material.uniforms.uCoast.value = coastTex;
}
function coastFill(c0, r0) {  // the W x W tiles from tile column c0, row r0
  const M = COAST.M, n = COAST_W * M;
  coastData.fill(0);
  for (let b = 0; b < COAST_W; b++) for (let a = 0; a < COAST_W; a++) {
    const tj = r0 + b, ti = c0 + a;
    if (tj < 0 || ti < 0 || tj >= COAST.ntj || ti >= COAST.nti) continue;
    const st = COAST.status[tj * COAST.nti + ti];
    let px = null;
    if (st === "2") { px = coastPng.get(tj + "_" + ti); if (!px) continue; } else if (st !== "0" && st !== "1") continue;
    for (let r = 0; r < M; r++) {
      let o = 2 * ((b * M + r) * n + a * M);
      for (let c = 0; c < M; c++, o += 2) { coastData[o] = px ? px[4 * (r * M + c)] : st === "1" ? 255 : 0; coastData[o + 1] = 255; }
    }
  }
  coastTex.needsUpdate = true;
}
function updateCoast(now) {
  if (!COAST || !terrainMesh || now - coastClock < 300) return;
  coastClock = now;
  const u = terrainMesh.material.uniforms, T = COAST.T;
  const on = DEM && $("dem").checked && camera.position.distanceTo(controls.target) < 3.0 * DEM.levels[0].T * G.kx;
  if (!on) { u.uCoastK.value.w = 0; coastKey = ""; return; }
  const c0 = Math.round(iOfX(controls.target.x) / T - COAST_W / 2), r0 = Math.round(jOfZ(controls.target.z) / T - COAST_W / 2);
  let missing = 0;
  for (let b = 0; b < COAST_W; b++) for (let a = 0; a < COAST_W; a++) {
    const tj = r0 + b, ti = c0 + a, k = tj + "_" + ti;
    if (tj < 0 || ti < 0 || tj >= COAST.ntj || ti >= COAST.nti || COAST.status[tj * COAST.nti + ti] !== "2" || coastPng.has(k)) continue;
    missing++; coastPng.set(k, null);
    loadPixels(`${DEMDIR}coast/${k}.png`).then((im) => { coastPng.set(k, new Uint8Array(im.rgba)); coastKey = ""; })
      .catch(() => coastPng.set(k, new Uint8Array(4 * COAST.M * COAST.M)));
  }
  const key = c0 + "_" + r0 + "_" + [...coastPng.values()].filter(Boolean).length;
  if (key !== coastKey) { coastKey = key; coastFill(c0, r0); }
  if (coastPng.size > 200) for (const [k, v] of coastPng) { if (coastPng.size <= 120) break; const [tj, ti] = k.split("_").map(Number); if (v && (tj < r0 || tj >= r0 + COAST_W || ti < c0 || ti >= c0 + COAST_W)) coastPng.delete(k); }
  u.uCoast.value = coastTex; u.uCoastK.value.set(c0 * T, r0 * T, COAST_W * T, 1);
}
// ---------- 3D buildings (OpenStreetMap footprints, osm3d.py): tiles of the finest close-up terrain level, loaded
// within ~20 km of the view while the close-up terrain is on; true height on the exaggerated terrain, walls reaching
// 20 m below the lowest ground of the outline ----------
let BLD = null, bldClock = 0, bldLoading = 0, bldMat = null, bldSun = null, bldAmb = null;
const bldTiles = new Map();
async function loadBldMeta() {
  BLD = null;  // dem.json says whether this page has buildings (osm3d.py), so other pages make no request
  if (DEM && DEM.bld) try { const r = await fetch(BLDDIR + "index.json"); BLD = r.ok ? await r.json() : null; } catch (e) { BLD = null; }
  $("bldRow").hidden = !BLD;
  if (!BLD) return;
  BLD.n = new Map(BLD.tiles.map((t) => [t[0] + "_" + t[1], t[2]]));
  bldMat = new THREE.MeshLambertMaterial({ color: 0xd9d3c9, side: THREE.DoubleSide });
  bldSun = new THREE.DirectionalLight(0xffffff, 2.0);
  bldAmb = new THREE.HemisphereLight(0xe4ecf2, 0x6b6258, 1.15);
  scene.add(bldSun, bldSun.target, bldAmb);
}
function bldHeights(t, e) {
  const p = t.mesh.geometry.attributes.position.array;
  for (let k = 0; k < t.b.length; k++) p[3 * k + 1] = t.b[k] * e + t.r[k];
  t.mesh.geometry.attributes.position.needsUpdate = true;
  t.mesh.geometry.computeBoundingSphere();
}
async function loadBldTile(tj, ti) {
  // typed arrays sized from a first pass over the records (an iPhone tab dies on JS arrays of millions of vertices);
  // indexed: roof rings share their vertices, each wall is one quad of 4 vertices with its own flat normal
  const key = tj + "_" + ti, t = { mesh: null, used: performance.now(), n: 0, nv: 0 };
  bldTiles.set(key, t);
  bldLoading++;
  try {
    const r = await fetch(`${BLDDIR}${key}.bin`);
    if (!r.ok) throw new Error(r.status);
    const a = new Int16Array(await r.arrayBuffer()), T = BLD.T, Q = BLD.q;
    let nv = 0, ni = 0;
    for (let p = 0; p < a.length;) {
      const nr = a[p + 2]; let L = 0;
      for (let k = 0; k < nr; k++) L += a[p + 3 + k];
      nv += 5 * L; ni += 6 * L + 3 * (L - 2 + 2 * (nr - 1));
      p += 3 + nr + 2 * L;
    }
    const pos = new Float32Array(3 * nv), nrm = new Float32Array(3 * nv), b = new Float32Array(nv), rr = new Float32Array(nv);
    const idx = new Uint32Array(ni);
    let v = 0, q = 0;
    const put = (x, z, base, rel, nx, ny, nz) => { pos[3 * v] = x; pos[3 * v + 2] = z; nrm[3 * v] = nx; nrm[3 * v + 1] = ny; nrm[3 * v + 2] = nz; b[v] = base; rr[v] = rel; return v++; };
    const X = (c) => xOfI(ti * T + c / Q * T), Z = (c) => zOfJ(tj * T + c / Q * T);
    for (let p = 0; p < a.length;) {
      const base = a[p] / 2000, h = a[p + 1] / 10000, nr = a[p + 2], lens = Array.from(a.subarray(p + 3, p + 3 + nr));
      p += 3 + nr;
      const rings = lens.map((n) => { const ring = []; for (let k = 0; k < n; k++, p += 2) ring.push(new THREE.Vector2(X(a[p]), Z(a[p + 1]))); return ring; });
      const v0 = v;
      for (const ring of rings) for (const P of ring) put(P.x, P.y, base, h, 0, 1, 0);
      const tris = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      const all = rings.flat();
      for (const tri of tris) if (q + 3 <= ni) {  // wound counter-clockwise seen from above, so the up normal is the front face's
        const A = all[tri[0]], B = all[tri[1]], C = all[tri[2]], up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y) > 0;
        idx[q++] = v0 + tri[0]; idx[q++] = v0 + (up ? tri[1] : tri[2]); idx[q++] = v0 + (up ? tri[2] : tri[1]);
      }
      for (const ring of rings) for (let k = 0; k < ring.length; k++) {
        const A = ring[k], B = ring[(k + 1) % ring.length], dx = B.x - A.x, dz = B.y - A.y, l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l, nz = dx / l;  // the front face's side for this winding
        const w0 = put(A.x, A.y, base, -0.02, nx, 0, nz), w1 = put(B.x, B.y, base, -0.02, nx, 0, nz);
        const w2 = put(B.x, B.y, base, h, nx, 0, nz), w3 = put(A.x, A.y, base, h, nx, 0, nz);
        idx[q++] = w0; idx[q++] = w1; idx[q++] = w2; idx[q++] = w0; idx[q++] = w2; idx[q++] = w3;
      }
      t.n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(q < ni ? idx.slice(0, q) : idx, 1));
    t.b = b; t.r = rr; t.nv = nv;
    t.mesh = new THREE.Mesh(g, bldMat);
    t.mesh.visible = false;
    bldHeights(t, exag());
    if (bldTiles.get(key) === t) scene.add(t.mesh); else g.dispose();
  } catch (e) { t.failed = true; }
  bldLoading--;
}
// ---------- landmarks (landmarks3d.py): structures the footprints cannot draw, e.g. the Golden Gate Bridge ----------
// indexed meshes in cell indices from an origin; heights above sea level and the ground under each vertex (m), placed as
// the buildings (ground x exaggeration + height above it). Shown with the buildings toggle and the close-up terrain,
// out to 120 km so that they stay in an orbit; the suspenders (lines) only within 8 km.
let LMK = [];
function lmkHeights(L, e) {
  const p = L.mesh.geometry.attributes.position.array;
  for (let k = 0; k < L.h.length; k++) p[3 * k + 1] = (L.g[k] * e + L.h[k] - L.g[k]) / 1000;
  L.mesh.geometry.attributes.position.needsUpdate = true;
  L.mesh.geometry.computeVertexNormals(); L.mesh.geometry.computeBoundingSphere();
  if (L.lines) { const q = L.lines.geometry.attributes.position.array;
    for (let k = 0; k < L.lh.length; k++) q[3 * k + 1] = (L.lg[k] * e + L.lh[k] - L.lg[k]) / 1000;
    L.lines.geometry.attributes.position.needsUpdate = true; L.lines.geometry.computeBoundingSphere(); }
}
async function loadLandmarks() {
  for (const L of LMK) { scene.remove(L.mesh); if (L.lines) scene.remove(L.lines); }
  LMK = [];
  if (!(DEM && DEM.landmarks)) return;
  let J; try { const r = await fetch(BLDDIR + "landmarks.json"); if (!r.ok) return; J = await r.json(); } catch (e) { return; }
  if (!bldSun) { bldSun = new THREE.DirectionalLight(0xffffff, 2.0); bldAmb = new THREE.HemisphereLight(0xe4ecf2, 0x6b6258, 1.15); scene.add(bldSun, bldSun.target, bldAmb); }
  for (const it of J.items) {
    const v = it.v, [fi0, fj0] = it.o;
    const X = (k) => xOfI(fi0 + v[4 * k]), Z = (k) => zOfJ(fj0 + v[4 * k + 1]);
    // flat-shaded: one vertex per triangle corner
    const t = it.tri, pos = new Float32Array(t.length * 3), h = new Float32Array(t.length), g = new Float32Array(t.length);
    t.forEach((k, m) => { pos[3 * m] = X(k); pos[3 * m + 2] = Z(k); h[m] = v[4 * k + 2]; g[m] = v[4 * k + 3]; });
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const col = new THREE.Color(it.color);
    const L = { mesh: new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: col })), h, g, name: it.name };
    if (it.seg && it.seg.length) {
      const sp = new Float32Array(it.seg.length * 3), lh = new Float32Array(it.seg.length), lg = new Float32Array(it.seg.length);
      it.seg.forEach((k, m) => { sp[3 * m] = X(k); sp[3 * m + 2] = Z(k); lh[m] = v[4 * k + 2]; lg[m] = v[4 * k + 3]; });
      const lgeo = new THREE.BufferGeometry(); lgeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
      L.lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: col.clone().multiplyScalar(0.8) }));
      L.lh = lh; L.lg = lg; L.lines.visible = false; scene.add(L.lines);
    }
    L.mesh.visible = false; scene.add(L.mesh);
    lmkHeights(L, exag());
    LMK.push(L);
  }
}
function updateLandmarks() {
  if (!LMK.length) return;
  const on = $("bld").checked && DEM && $("dem").checked, tx = controls.target.x, tz = controls.target.z;
  const dist = camera.position.distanceTo(controls.target);
  for (const L of LMK) {
    const c = L.mesh.geometry.boundingSphere.center, near = Math.hypot(c.x - tx, c.z - tz) < 120 && dist < 200;
    L.mesh.visible = !!(on && near); if (L.lines) L.lines.visible = !!(on && near && dist < 8);
  }
}
function updateBld(now) {
  if (!BLD || now - bldClock < 300) return;
  bldClock = now;
  const dist = camera.position.distanceTo(controls.target), on = $("bld").checked;
  const fine = DEM && demLev === DEM.levels.length - 1;
  const want = new Set();
  if (on && fine && dist < 30) {
    const T = BLD.T, rad = Math.min(dist * 1.6 + 3, PHONE ? 8 : 22), tx = controls.target.x, tz = controls.target.z;
    for (let tj = Math.floor(jOfZ(tz - rad) / T); tj <= Math.floor(jOfZ(tz + rad) / T); tj++)
      for (let ti = Math.floor(iOfX(tx - rad) / T); ti <= Math.floor(iOfX(tx + rad) / T); ti++)
        if (BLD.n.has(tj + "_" + ti)) want.add(tj + "_" + ti);
    // nearest tiles first, within the vertex budget (~45 vertices a building)
    const cx = (k) => { const [tj, ti] = k.split("_").map(Number); return Math.hypot(xOfI((ti + 0.5) * T) - tx, zOfJ((tj + 0.5) * T) - tz); };
    let est = 0; const budget = PHONE || IPAD ? 1.5e6 : 8e6;
    for (const k of [...want].sort((x, y) => cx(x) - cx(y))) { est += 45 * BLD.n.get(k); if (est > budget && est > 45 * BLD.n.get(k)) want.delete(k); }
    for (const k of want) if (!bldTiles.has(k) && bldLoading < 4) { const [tj, ti] = k.split("_").map(Number); loadBldTile(tj, ti); }
  }
  let shown = 0, nb = 0;
  for (const [k, t] of bldTiles) {
    if (!t.mesh) continue;
    t.mesh.visible = want.has(k);
    if (t.mesh.visible) { t.used = now; shown++; nb += t.n; }
  }
  // keep hidden tiles for a quick return, within a vertex budget (a phone tab has a few hundred MB)
  let total = 0; for (const t of bldTiles.values()) total += t.nv || 0;
  const budget = PHONE || IPAD ? 1.5e6 : 8e6;
  if (total > budget) {
    const old = [...bldTiles.entries()].filter(([, t]) => t.mesh && !t.mesh.visible).sort((x, y) => x[1].used - y[1].used);
    for (const [k, t] of old) { if (total <= budget) break; total -= t.nv; scene.remove(t.mesh); t.mesh.geometry.dispose(); bldTiles.delete(k); }
  }
  if (bldSun && terrainMesh) {  // the terrain's light (sun by day, dimmed fixed light at night)
    const u = terrainMesh.material.uniforms, d = u.uDayLight ? u.uDayLight.value : 1;
    bldSun.position.copy(u.uLight.value); bldSun.intensity = 2.0 * d * (u.uSunUp ? 0.35 + 0.65 * u.uSunUp.value : 1);
    bldAmb.intensity = 1.15 * d;
  }
  $("bldV").textContent = !on ? "off" : !(DEM && $("dem").checked) ? "needs close-up terrain" : !want.size ? "zoom in near a pilot city"
    : `${nb.toLocaleString("en")} · ${shown} tile${shown === 1 ? "" : "s"}`;
}
// height (m) of the shown close-up tiles at fractional cell (fi, fj), NaN where none is shown
function demAt(fi, fj) {
  const L = DEM.levels[demLev], T = L.T, S = L.S, ti = Math.floor(fi / T), tj = Math.floor(fj / T);
  const t = demTiles.get(`${demLev}/${tj}_${ti}`);
  if (!t || !t.mesh || !t.mesh.visible) return NaN;
  const a = (fi - ti * T) / T * (S - 1), b = (fj - tj * T) / T * (S - 1), i = Math.min(Math.floor(a), S - 2), j = Math.min(Math.floor(b), S - 2), u = a - i, v = b - j;
  const h = (k) => Math.max(0, t.h[k]), k = j * S + i;
  return (1 - v) * ((1 - u) * h(k) + u * h(k + 1)) + v * ((1 - u) * h(k + S) + u * h(k + S + 1));
}
function updateDem(now) {
  if (!DEM || !terrainMesh || now - demClock < 250) return;
  demClock = now;
  const dist = camera.position.distanceTo(controls.target), on = $("dem").checked;
  const kx = G.kx, T0 = DEM.levels[0].T * kx, T1 = DEM.levels[DEM.levels.length - 1].T * kx;
  let lev = -1;
  if (on) lev = dist < 2.8 * T1 ? DEM.levels.length - 1 : dist < 3.0 * T0 ? 0 : -1;
  const L = lev >= 0 ? DEM.levels[lev] : null, want = new Set();
  if (L) {
    const T = L.T, rad = Math.min(dist * 1.4 + T * kx * 0.5, 3.4 * T * kx), tx = controls.target.x, tz = controls.target.z;
    const i0 = Math.max(Math.floor(iOfX(tx - rad) / T), Math.floor(REG.i0 / T)), i1 = Math.min(Math.floor(iOfX(tx + rad) / T), Math.floor(REG.i1 / T));
    const j0 = Math.max(Math.floor(jOfZ(tz - rad) / T), Math.floor(REG.j0 / T)), j1 = Math.min(Math.floor(jOfZ(tz + rad) / T), Math.floor(REG.j1 / T));
    for (let tj = j0; tj <= j1; tj++) for (let ti = i0; ti <= i1; ti++) if (DEM.sets[lev].has(tj + "_" + ti)) want.add(`${lev}/${tj}_${ti}`);
    for (const key of want) if (!demTiles.has(key) && demLoading < 6) { const [l, r] = key.split("/"), [tj, ti] = r.split("_").map(Number); loadDemTile(Number(l), tj, ti); }
  }
  // show the wanted tiles that are ready; mask the base under them
  const key = lev + "|" + [...want].filter((k) => demTiles.get(k)?.mesh).join(",");
  if (key !== demKey) {
    demKey = key; demMaskData.fill(0);
    for (const [k, t] of demTiles) {
      const vis = want.has(k) && !!t.mesh;
      if (t.mesh) t.mesh.visible = vis;
      if (!vis) continue;
      t.used = now;
      const f = DEM.levels[t.lev].T / DEM.Tm;
      for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) { const mj = t.tj * f + b, mi = t.ti * f + a; if (mj < demMy && mi < demMx) demMaskData[mj * demMx + mi] = 255; }
    }
    demMaskTex.needsUpdate = true;
    const u = terrainMesh.material.uniforms;
    u.uDemMask.value = demMaskTex; u.uDemK.value.set(G.nx, G.ny, DEM.Tm * demMx, DEM.Tm * demMy); u.uDemOn.value = lev >= 0 ? 1 : 0;
    demLev = lev;
    for (const q of particles || []) q.hist.length = 0;
  }
  // GPU memory: drop the least recently shown tiles beyond 160
  if (demTiles.size > 160) {
    const old = [...demTiles.entries()].filter(([, t]) => t.mesh && !t.mesh.visible).sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of old.slice(0, demTiles.size - 160)) { scene.remove(t.mesh); t.mesh.geometry.dispose(); demTiles.delete(k); }
  }
  $("demV").textContent = !on ? "off" : lev < 0 ? "zoom in for close-up terrain" : `${Math.round(L.T / (L.S - 1) * kx * 1000)} m · ${key.split("|")[1] ? key.split("|")[1].split(",").length : 0} tiles`;
}

// ---------- wind trails: screen-space ribbons (instanced quads, one per trail segment) ----------
const NP = PHONE ? 2200 : 3600, NL = 12, SEG = NP * (NL - 1);
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
  const nAct = Math.round(NP * Number($("dens").value));
  for (let ip = 0; ip < NP; ip++) {
    const p = particles[ip];
    if (ip >= nAct) { for (let q = 0; q < NL - 1; q++, s++) Wd[s] = 0; continue; }
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

// ---------- falling rain and snow near the view: streaks and flakes from the hour's model precipitation ----------
// Drops are seeded around the point the camera looks at (a disc that grows with the viewing distance), kept with a
// probability that rises with the cell's hourly precipitation (all kept from 8 mm/h), as snow where the terrain is
// above the model's snow level. Sizes and speeds follow the viewing distance so that they read at every zoom; the
// slant follows the 10 m wind. Rain makes a short ring where it lands (optional splashes).
const ND = PHONE ? 6000 : 20000, NSPL = PHONE ? 600 : 2000;
let drops = null, rainGeo, rainLines, snowGeo, snowPts, splGeo, splPts, splK = 0, dropClock = 0;
const softVS = (size) => `attribute float a; varying float va; uniform float uSize; uniform float uPR;
void main(){ va = a; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; ${size} }`;
function makeDrops() {
  drops = Array.from({ length: ND }, () => ({ x: 0, y: 0, z: 0, g: 0, live: false, snow: false, ph: Math.random() * 6.283 }));
  const mk = (n, per) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * per * 3), 3)); g.setAttribute("a", new THREE.BufferAttribute(new Float32Array(n * per), 1)); return g; };
  rainGeo = mk(ND, 2); snowGeo = mk(ND, 1); splGeo = mk(NSPL, 1);
  for (const g of [rainGeo, snowGeo, splGeo]) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  rainLines = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uSize: { value: 1 }, uPR: { value: 1 } },
    vertexShader: softVS(""),
    fragmentShader: `varying float va; void main(){ gl_FragColor = vec4(0.78, 0.86, 0.95, va * 0.75); }`,
  }));
  snowPts = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uSize: { value: 30 }, uPR: { value: renderer.getPixelRatio() } },
    vertexShader: softVS("gl_PointSize = a > 0.0 ? clamp(uSize / -mv.z, 1.5, 7.0) * uPR : 0.0;"),
    fragmentShader: `varying float va; void main(){ float r = length(gl_PointCoord - 0.5); if(r > 0.5) discard; gl_FragColor = vec4(1.0, 1.0, 1.0, va * (1.0 - smoothstep(0.15, 0.5, r))); }`,
  }));
  splPts = new THREE.Points(splGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uSize: { value: 30 }, uPR: { value: renderer.getPixelRatio() } },
    vertexShader: softVS("gl_PointSize = a > 0.0 ? clamp(uSize / -mv.z, 2.0, 14.0) * (0.4 + (1.0 - a)) * uPR : 0.0;"),
    fragmentShader: `varying float va; void main(){ vec2 d = gl_PointCoord - 0.5; d.y *= 2.2; float r = length(d), w = 0.5 * (1.15 - va);
      float ring = 1.0 - smoothstep(0.0, 0.09, abs(r - w)); if(ring <= 0.01) discard; gl_FragColor = vec4(0.85, 0.92, 1.0, ring * va * 0.8); }`,
  }));
  for (const o of [rainLines, snowPts, splPts]) { o.frustumCulled = false; o.renderOrder = 2; scene.add(o); }
}
function stepDrops(dt) {
  if (!drops) return;
  const on = $("drops").checked && !!R && hour > 0;
  rainLines.visible = snowPts.visible = splPts.visible = on;
  if (!on) return;
  dropClock += dt;
  const e = exag(), dist = camera.position.distanceTo(controls.target), tx = controls.target.x, tz = controls.target.z;
  const rad = Math.min(regSize() * 0.6, Math.max(1.0, dist * 0.8)); // km around the look-at point
  const top = Math.min(3.0 * e, Math.max(0.12, dist * 0.35));     // column height (scene units) the drops fall through
  const len = Math.max(0.004, dist * 0.012), vr = top / 1.4, vs = vr * 0.18;
  const nAct = Math.round(ND * Number($("dropsN").value)), splash = $("splash").checked;
  const RP = rainGeo.attributes.position.array, RA = rainGeo.attributes.a.array;
  const SP = snowGeo.attributes.position.array, SA = snowGeo.attributes.a.array;
  const PP = splGeo.attributes.position.array, PA = splGeo.attributes.a.array;
  for (let k = 0; k < NSPL; k++) if (PA[k] > 0) PA[k] = Math.max(0, PA[k] - dt / 0.35);
  for (let i = 0; i < ND; i++) {
    const d = drops[i];
    if (i >= nAct) { d.live = false; RA[2 * i] = RA[2 * i + 1] = 0; SA[i] = 0; continue; }
    if (!d.live) {
      RA[2 * i] = RA[2 * i + 1] = 0; SA[i] = 0;
      const r = rad * Math.sqrt(Math.random()), t = Math.random() * 6.283, x = tx + r * Math.cos(t), z = tz + r * Math.sin(t);
      const cl = cellAt(x, z);
      if (!cl) continue;
      const c = cl[0] * G.nx + cl[1];
      if (COVER && !COVER[c]) continue;
      const p = (wxData[4 * c] / 255) ** 2 * PRHI;
      if (p < 0.05 || Math.random() > Math.sqrt(p / 8)) continue;
      const gm = terrainAt(x, z);
      if (!Number.isFinite(gm)) continue;
      d.x = x; d.z = z; d.g = gm / 1000 * e; d.y = d.g + top * Math.random(); d.live = true;
      d.snow = gm >= wxData[4 * c + 1] / 255 * ZSHI && (wxData[4 * c + 1] < 255);
      continue;
    }
    const w = windAt(d.x, d.z) || [0, 0];
    if (d.snow) {
      d.y -= vs * dt;
      d.x += (w[0] * 0.08 * len + Math.sin(dropClock * 1.7 + d.ph) * 0.25 * len) * dt * 3;
      d.z += (w[1] * 0.08 * len + Math.cos(dropClock * 1.3 + d.ph) * 0.25 * len) * dt * 3;
    } else { d.y -= vr * dt; d.x += w[0] * 0.04 * len * vr / len * dt; d.z += w[1] * 0.04 * len * vr / len * dt; }
    const gm = terrainAt(d.x, d.z);
    if (!Number.isFinite(gm)) { d.live = false; continue; }
    d.g = gm / 1000 * e;
    if (d.y <= d.g) {
      d.live = false; RA[2 * i] = RA[2 * i + 1] = 0; SA[i] = 0;
      if (!d.snow && splash) { const k = splK++ % NSPL; PP[3 * k] = d.x; PP[3 * k + 1] = d.g + 0.002 * e + len * 0.05; PP[3 * k + 2] = d.z; PA[k] = 1; }
      continue;
    }
    if (d.snow) { SP[3 * i] = d.x; SP[3 * i + 1] = d.y; SP[3 * i + 2] = d.z; SA[i] = Math.min(1, (d.y - d.g) / (0.05 * top) + 0.2) * 0.9; }
    else {
      const sx = w[0] * 0.04 * len, sz = w[1] * 0.04 * len; // slant with the wind
      RP[6 * i] = d.x - sx; RP[6 * i + 1] = d.y + len; RP[6 * i + 2] = d.z - sz;
      RP[6 * i + 3] = d.x; RP[6 * i + 4] = Math.max(d.g, d.y); RP[6 * i + 5] = d.z;
      RA[2 * i] = 0; RA[2 * i + 1] = 1;
    }
  }
  snowPts.material.uniforms.uSize.value = 0.004 * innerHeight * 1.0 * 6;
  splPts.material.uniforms.uSize.value = 0.004 * innerHeight * 8;
  for (const g of [rainGeo, snowGeo, splGeo]) { g.attributes.position.needsUpdate = true; g.attributes.a.needsUpdate = true; }
}

// ---------- 3D cloud: weather volume, edge detail, sunlight, self-shadowing, terrain shadows, quality tiers ----------
// Where the clouds are comes from the weather volume. For every RSUB-th cell, the humidity (or, where the data have it,
// the model's cloud liquid + ice water) of the pressure levels is put at the levels' own geopotential heights (h<p>,
// the standard height where a file has none). It is interpolated linearly in height onto NZB steps from 0 to the top:
// a 3D texture (x, y, height), drawn with the same vertical exaggeration as the terrain, and the two model frames
// around the hour are blended in the shader. Humidity clouds: the humidity passes a threshold that rises with pressure
// (60 % at 300 hPa, 90 % at 1000 hPa, times the slider / 75), soft over 8 %. Condensate clouds: liquid + ice water from
// 0.004 to 0.08 g/kg.
// Edge detail (after Guerrilla Games' Nubis): a tileable 3D noise in physical km (stable while the camera moves and the
// frames blend) erodes the soft edges of that coverage, never its core, so the eye, bands and clear slots stay where
// the weather puts them; slider 0 = the original volume.
// Light: the sun from the displayed UTC time at the view centre, in scene axes; the optical depth towards the sun
// (self-shadowing, 0-6 samples by quality tier) with a Beer-powder term, a Henyey-Greenstein phase for bright backlit
// edges, a sky ambient; twilight colours, and night = ambient only.
// Rendered into a low-resolution target (scale by quality tier) and composited over the scene; fewer steps while the
// camera or the timeline moves, full steps once it settles. Terrain shadows: a low-resolution texture over the region
// with the sunlight transmitted through the volume along the solar direction (recomputed when the frame, the sun, the
// exaggeration or the region changes). The ray-march stops at the terrain (heights of the region lattice).
const NZB = 64;
let cloudMesh = null, cloudScene = null, cloudRT = null, cloudQuad = null, volCache = new Map(), terTex = null, noiseTex = null;
let shadowRT = null, shadowScene = null, shadowCam = null, shadowKey = "";
let CSRC = "r"; // cloud source: r humidity, w condensate
const SUN = { el: 45, az: 180, dir: new THREE.Vector3(0, 1, 0) };
// quality tiers: cloud render scale, ray steps still / moving, self-shadow samples, edge detail, terrain shadow texture
const TIERS = {
  high: { scale: 0.75, steps: 128, move: 64, shadow: 6, detail: true, tshadow: 256 },
  medium: { scale: 0.5, steps: 96, move: 48, shadow: 4, detail: true, tshadow: 192 },
  low: { scale: 0.38, steps: 56, move: 32, shadow: 2, detail: false, tshadow: 0 },
  off: null,
};
const IPAD = /iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const AUTO0 = PHONE ? "low" : IPAD || matchMedia("(pointer: coarse)").matches ? "medium" : "high";
let QUAL = AUTO0, QMODE = "auto", moving = 0, lastMove = 0;
const perf = { ema: 16, slow: 0, n: 0 };

const cloudVS = `
out vec3 vWorld;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
// shared GLSL: volume lookup, coverage, edge detail
const cloudCommon = `
precision highp float; precision highp sampler3D;
uniform sampler3D uVolA; uniform sampler3D uVolB; uniform float uMix; uniform sampler3D uNoise;
uniform sampler2D uTer; uniform vec3 uBMin; uniform vec3 uBMax;
uniform vec4 uCell; uniform vec4 uLat; uniform vec2 uLatN; uniform vec3 uVol; uniform float uTop;
uniform float uExag; uniform float uThr; uniform vec2 uBand; uniform float uSrc; uniform float uDetail;
float presAt(float zkm){ return zkm < 11.0 ? 1013.25 * pow(max(1.0 - 0.0225577 * zkm, 0.01), 5.25588) : 226.3 * exp(-(zkm - 11.0) / 6.34); }
float terrainKm(vec2 xz){
  float fi = xz.x / uCell.x + uCell.z, fj = xz.y / uCell.y + uCell.w;
  vec2 ab = vec2((fi - uLat.x) / (uLat.y - uLat.x), (fj - uLat.z) / (uLat.w - uLat.z));
  if(ab.x < 0.0 || ab.y < 0.0 || ab.x > 1.0 || ab.y > 1.0) return 1e6;
  return max(texture(uTer, (ab * (uLatN - 1.0) + 0.5) / uLatN).r, 0.0) / 1000.0;
}
// coverage 0..1 from the weather volume at scene point p
float coverage(vec3 p){
  float zkm = p.y / uExag, top = uTop;
  if(zkm < uBand.x - 0.4 || zkm > min(uBand.y + 0.4, top)) return 0.0;
  float fi = p.x / uCell.x + uCell.z, fj = p.z / uCell.y + uCell.w;
  vec3 uvw = vec3((fi / uVol.z + 0.5) / uVol.x, (fj / uVol.z + 0.5) / uVol.y, zkm / uTop);
  float v = mix(texture(uVolA, uvw).r, texture(uVolB, uvw).r, uMix), c;
  if(uSrc > 0.5){ float w = v * v * 0.6; c = smoothstep(0.004, 0.08, w); }
  else { float thr = min(0.99, (0.60 + 0.30 * clamp((presAt(zkm) - 300.0) / 700.0, 0.0, 1.0)) * uThr); c = smoothstep(thr, thr + 0.08, v); }
  float edge = smoothstep(uBand.x - 0.4, uBand.x + 0.1, zkm) * (1.0 - smoothstep(min(uBand.y, top) - 0.3, min(uBand.y + 0.4, top), zkm));
  return c * edge;
}
// edge detail: erode the coverage near its edges with noise in physical km (x, z scene km; y the true height)
float detailed(vec3 p, float c, float lod){
  if(uDetail <= 0.001 || c <= 0.0) return c;
  vec3 q = vec3(p.x, p.y / uExag * 2.5, p.z); // the billows a little flatter than tall
  float n1 = texture(uNoise, q / 38.0).r, n = n1;
  if(lod > 0.5) n = 0.7 * n1 + 0.3 * texture(uNoise, q / 9.0).r;
  float lo = uDetail * 0.75 * (1.0 - n);
  return clamp((c - lo) / max(1.0 - lo, 0.05), 0.0, 1.0);
}`;
const cloudFS = `${cloudCommon}
in vec3 vWorld; out vec4 outColor;
uniform int uSteps; uniform int uShadowN; uniform float uDens; uniform float uNear;
uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uAmb; uniform float uDay; uniform float uFine; uniform float uSee;
float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
void main(){
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec3 inv = 1.0 / rd, t0s = (uBMin - ro) * inv, t1s = (uBMax - ro) * inv;
  vec3 tmin = min(t0s, t1s), tmax = max(t0s, t1s);
  float t0 = max(max(max(tmin.x, tmin.y), tmin.z), 0.0), t1 = min(min(tmax.x, tmax.y), tmax.z);
  if(t1 <= t0) discard;
  float dt = (t1 - t0) / float(uSteps);
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  // sun direction in scene units (vertical exaggerated like the terrain), per km of path
  vec3 sunStep = normalize(vec3(uSun.x, uSun.y * uExag, uSun.z));
  float kmPerUnit = length(vec3(uSun.x, uSun.y * uExag, uSun.z)) / length(uSun); // scene units per physical km along the sun
  float cosv = dot(rd, sunStep), phase = mix(0.75, 2.4 * hg(cosv, 0.6) + 0.35, 0.6);
  float T = 1.0; vec3 col = vec3(0.0);
  for(int i = 0; i < 256; i++){
    if(i >= uSteps) break;
    float tt = t0 + (float(i) + jit) * dt;
    vec3 p = ro + rd * tt;
    if(p.y / uExag < terrainKm(p.xz)) break;
    float c = coverage(p);
    if(c <= 0.002) continue;
    float a = detailed(p, c, tt < 0.6 * uNear * 6.0 ? 1.0 : 0.0) * smoothstep(0.25 * uNear, uNear, tt);
    // texture: fine billows and holes inside the cloud as well as at its edges (two octaves at ~5 and ~1.7 km)
    if(uFine > 0.001){ vec3 q = vec3(p.x, p.y / uExag * 2.5, p.z); float n2 = 0.6 * texture(uNoise, q / 5.0).r + 0.4 * texture(uNoise, q / 1.7).r;
      a *= mix(1.0, 1.7 * smoothstep(0.3, 0.8, n2), uFine); }
    if(a <= 0.002) continue;
    // optical depth towards the sun (self-shadowing), samples at growing distances up to ~8 km
    float od = 0.0;
    for(int s = 0; s < 6; s++){
      if(s >= uShadowN) break;
      float d = 0.35 * pow(1.75, float(s));
      vec3 q = p + sunStep * d * kmPerUnit;
      od += coverage(q) * d * 0.9;
    }
    // Beer's law with a multiple-scattering floor (deep cloud keeps some light, as in Nubis) and a soft powder term
    float beer = max(exp(-0.6 * od), 0.65 * exp(-0.12 * od)), powder = 1.0 - exp(-2.0 * (od + a));
    float sunl = uDay * beer * mix(1.0, powder * 1.6, 0.35) * phase;
    float h = clamp((p.y / uExag) / max(uTop, 1.0), 0.0, 1.0);
    vec3 lc = uSunCol * sunl + uAmb * (0.55 + 0.45 * h);
    float al = 1.0 - exp(-a * uDens * dt);
    col += T * al * lc;
    T *= 1.0 - al;
    if(T < 0.02) break;
  }
  if(T > 0.995) discard;
  outColor = vec4(col, 1.0 - T) * (1.0 - uSee); // premultiplied: composited with ONE, ONE_MINUS_SRC_ALPHA; see-through keeps the terrain visible
}`;
// terrain shadow texture: for each texel over the region, the sunlight transmitted from the top of the volume down to
// the terrain along the solar direction
const shadowFS = `${cloudCommon}
in vec2 vUv; out vec4 outColor;
uniform vec3 uSun; uniform float uDens;
void main(){
  vec2 xz = mix(uBMin.xz, uBMax.xz, vUv);
  float g = terrainKm(xz);
  if(g > 1e5 || uSun.y <= 0.0){ outColor = vec4(1.0); return; }
  vec3 sunStep = normalize(vec3(uSun.x, uSun.y * uExag, uSun.z));
  float kmPerUnit = length(vec3(uSun.x, uSun.y * uExag, uSun.z)) / length(uSun);
  vec3 p0 = vec3(xz.x, g * uExag, xz.y);
  float tTop = max(0.0, (uTop * uExag - p0.y) / max(sunStep.y, 0.02));
  float od = 0.0, n = 24.0, ds = tTop / n;
  for(int i = 0; i < 24; i++){
    vec3 p = p0 + sunStep * (float(i) + 0.5) * ds;
    float c = coverage(p);
    if(c > 0.0) od += detailed(p, c, 0.0) * ds / kmPerUnit;
  }
  outColor = vec4(vec3(exp(-od * uDens * 4.0)), 1.0);
}`;
const quadVS = `out vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function cloudUniforms() {
  return {
    uVolA: { value: null }, uVolB: { value: null }, uMix: { value: 0 }, uNoise: { value: noiseTex }, uTer: { value: null },
    uBMin: { value: new THREE.Vector3() }, uBMax: { value: new THREE.Vector3() },
    uCell: { value: new THREE.Vector4(G.kx, G.kz, CX, CZ) }, uLat: { value: new THREE.Vector4() }, uLatN: { value: new THREE.Vector2() },
    uVol: { value: new THREE.Vector3(RW, RH, M.rsub || 2) }, uTop: { value: cloudTop() },
    uExag: { value: 8 }, uThr: { value: 1 }, uBand: { value: new THREE.Vector2(0, 20) }, uSrc: { value: 0 }, uDetail: { value: 0.5 },
    uDens: { value: 0.06 }, uSun: { value: new THREE.Vector3(0, 1, 0) },
  };
}
function maxTex3D() {
  const gl = renderer.getContext();
  return gl.getParameter ? gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 0 : 0;
}
function makeClouds() {
  if (cloudMesh || !RLEV.length) return;
  if (!renderer.capabilities.isWebGL2 || maxTex3D() < Math.max(RW, RH, NZB)) { QUAL = "off"; QMODE = "off"; return; }
  const nn = PHONE ? 32 : 48;
  noiseTex = new THREE.Data3DTexture(C.cloudNoise(nn), nn, nn, nn);
  noiseTex.format = THREE.RedFormat; noiseTex.type = THREE.UnsignedByteType;
  noiseTex.wrapS = noiseTex.wrapT = noiseTex.wrapR = THREE.RepeatWrapping;
  noiseTex.minFilter = noiseTex.magFilter = THREE.LinearFilter; noiseTex.unpackAlignment = 1; noiseTex.needsUpdate = true;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0.5, 0.5, 0.5);
  const u = cloudUniforms();
  Object.assign(u, {
    uSteps: { value: 96 }, uShadowN: { value: 4 }, uNear: { value: 20 }, uFine: { value: 0.6 }, uSee: { value: 0.3 },
    uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.35, 0.38, 0.45) }, uDay: { value: 1 },
  });
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: cloudVS, fragmentShader: cloudFS, side: THREE.BackSide,
    transparent: false, depthWrite: false, depthTest: false, blending: THREE.NoBlending, uniforms: u,
  });
  cloudMesh = new THREE.Mesh(geo, mat);
  cloudMesh.frustumCulled = false;
  cloudScene = new THREE.Scene();
  cloudScene.add(cloudMesh);
  cloudRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, depthBuffer: false });
  cloudRT.texture.minFilter = cloudRT.texture.magFilter = THREE.LinearFilter;
  cloudQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: quadVS, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { uTex: { value: cloudRT.texture } },
    fragmentShader: `precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uTex; void main(){ o = texture(uTex, vUv); }`,
  }));
  cloudQuad.frustumCulled = false;
  // terrain shadow pass
  const su = cloudUniforms();
  shadowScene = new THREE.Scene();
  shadowScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: quadVS, fragmentShader: shadowFS, uniforms: su })));
  shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  resizeCloudRT();
}
function resizeCloudRT() {
  if (!cloudRT) return;
  const t = TIERS[QUAL], sc = t ? t.scale * (moving ? 0.75 : 1) : 0.25, pr = renderer.getPixelRatio();
  const w = Math.max(64, Math.round(innerWidth * pr * sc)), h = Math.max(64, Math.round(innerHeight * pr * sc));
  if (cloudRT.width !== w || cloudRT.height !== h) cloudRT.setSize(w, h);
}
function eachCloudMat(f) { if (cloudMesh) f(cloudMesh.material.uniforms); if (shadowScene) f(shadowScene.children[0].material.uniforms); }
function updateCloudBox() {
  if (!cloudMesh || !REG) return;
  const e = exag(), top = cloudTop() * e;
  const x0 = xOfI(REG.i0 - 0.5), z0 = zOfJ(REG.j0 - 0.5), x1 = xOfI(REG.i1 + 0.5), z1 = zOfJ(REG.j1 + 0.5);
  cloudMesh.position.set(x0, 0, z0);
  cloudMesh.scale.set(x1 - x0, top, z1 - z0);
  if (terTex) terTex.dispose();
  terTex = new THREE.DataTexture(Float32Array.from(terrainH), REG.nx, REG.ny, THREE.RedFormat, THREE.FloatType);
  // linear where the GPU can filter float textures (smooth cut of the cloud at the ridges), nearest otherwise
  terTex.minFilter = terTex.magFilter = renderer.extensions.has("OES_texture_float_linear") ? THREE.LinearFilter : THREE.NearestFilter;
  terTex.needsUpdate = true;
  eachCloudMat((u) => {
    u.uBMin.value.set(x0, 0, z0); u.uBMax.value.set(x1, top, z1); u.uExag.value = e;
    u.uLat.value.set(REG.i0, REG.i1, REG.j0, REG.j1); u.uLatN.value.set(REG.nx, REG.ny); u.uTer.value = terTex;
  });
  shadowKey = "";
}
const cloudTop = () => M.zstd[RLEV[RLEV.length - 1]] / 1000 + 1.0; // km
function volume(k) {
  const id = R.mid + "/" + R.key + "/" + k + "/" + CSRC;
  if (volCache.has(id)) return volCache.get(id);
  const n = RW * RH, nl = RLEV.length, d = new Uint8Array(n * NZB), top = cloudTop() * 1000;
  const vf = RLEV.map((p) => R.fields[CSRC + p]), hf = RLEV.map((p) => R.fields["h" + p]);
  const vd = RLEV.map((p) => DEC[CSRC + p]), hd = RLEV.map((p) => DEC["h" + p]), hs = RLEV.map((p) => M.zstd[p]);
  // humidity: 0..1; condensate: sqrt(w / 0.6 g/kg), the same as its storage
  const norm = CSRC === "w" ? (x) => Math.sqrt(Math.max(0, x) / 0.6) : (x) => x / 100;
  const hz = new Float32Array(nl), rv = new Float32Array(nl);
  for (let c = 0; c < n; c++) {
    for (let l = 0; l < nl; l++) {
      rv[l] = vf[l] ? norm(vd[l][vf[l][k * n + c]]) : 0;
      hz[l] = hf[l] ? hd[l][hf[l][k * n + c]] : hs[l];
    }
    let l = 0;
    for (let b = 0; b < NZB; b++) {
      const z = (b + 0.5) / NZB * top;
      while (l < nl - 2 && z > hz[l + 1]) l++;
      let v;
      if (z <= hz[0]) v = rv[0];
      else if (z >= hz[nl - 1]) v = rv[nl - 1] * Math.max(0, 1 - (z - hz[nl - 1]) / 600); // fades out above the top level
      else { const f = (z - hz[l]) / Math.max(1, hz[l + 1] - hz[l]); v = rv[l] + f * (rv[l + 1] - rv[l]); }
      d[b * n + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  const t = new THREE.Data3DTexture(d, RW, RH, NZB);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true;
  volCache.set(id, t);
  // GPU memory: only the frames in use stay resident (the two around the hour and the next one)
  while (volCache.size > 3) { const [key, old] = volCache.entries().next().value; old.dispose(); volCache.delete(key); }
  return t;
}
function dropVolumes() { for (const t of volCache.values()) t.dispose(); volCache.clear(); }
const BANDS = { all: [0, 25], low: [0, 3.0], mid: [3.0, 7.0], high: [7.0, 25] };

// sun at the displayed time over the view centre, in scene axes (x east along the rows, z south, y up), unexaggerated
function updateSun(ms) {
  const [lat, lon] = REG ? latlonOf(xOfI((REG.i0 + REG.i1) / 2), zOfJ((REG.j0 + REG.j1) / 2)) : [0, 0];
  const real = $("night").checked; // "Day and night" off: a fixed daylight sun (the terrain's usual light), as before
  let [el, az] = C.sunPosition(ms, lat, lon);
  if (real) {
    const r = Math.PI / 180, E = Math.cos(el * r) * Math.sin(az * r), Nn = Math.cos(el * r) * Math.cos(az * r), U = Math.sin(el * r);
    const al = G.type === "ll" ? 0 : GR.north(lon), gx = E * Math.cos(al) + Nn * Math.sin(al), gy = -E * Math.sin(al) + Nn * Math.cos(al);
    SUN.dir.set(gx, U, -gy).normalize();
  } else { SUN.dir.copy(LIGHT); el = Math.asin(LIGHT.y) * 180 / Math.PI; }
  SUN.el = el; SUN.az = az;
  // light colour and strength: white by day, warm near the horizon, fading through civil twilight, none at night
  const day = THREE.MathUtils.smoothstep(el, -4, 6), warm = 1 - THREE.MathUtils.smoothstep(el, 2, 18);
  const sunCol = new THREE.Color(1, 1 - 0.28 * warm, 1 - 0.55 * warm);
  // ambient: sky light by day, a moonlit grey-blue at night so that the cloud stays readable
  const amb = new THREE.Color().setRGB(0.30 + 0.07 * day, 0.33 + 0.07 * day, 0.43 + 0.04 * day);
  if (cloudMesh) {
    const u = cloudMesh.material.uniforms;
    u.uDay.value = day; u.uSunCol.value.copy(sunCol); u.uAmb.value.copy(amb);
  }
  eachCloudMat((u) => u.uSun.value.copy(SUN.dir));
  if (terrainMesh) {
    // terrain hillshade: the sun by day, the fixed light kept at night (dimmed) so that the relief and overlays stay legible
    const tu = terrainMesh.material.uniforms, d = THREE.MathUtils.smoothstep(el, 0, 10);
    if (!real) { tu.uLight.value.copy(LIGHT); tu.uDayLight.value = 1; tu.uSunUp.value = 1; }
    else tu.uLight.value.copy(LIGHT).lerp(new THREE.Vector3(SUN.dir.x, Math.max(SUN.dir.y, 0.15), SUN.dir.z).normalize(), d).normalize();
    if (real) { tu.uDayLight.value = 0.62 + 0.38 * day; tu.uSunUp.value = THREE.MathUtils.smoothstep(el, 0, 8); }
  }
  if ($("sunV")) $("sunV").textContent = real ? `sun ${Math.round(el)}° ${el > 0 ? `from ${C.compass8(az)}` : "(below the horizon)"}` : "fixed daylight (Day and night off)";
}

function updateClouds(h) {
  const vol = QUAL !== "off" && $("clouds").checked && RLEV.some((p) => has(CSRC + p));
  if (terrainMesh) terrainMesh.material.uniforms.uCover.value = (QUAL === "off" && $("clouds").checked && has("cc")) ? 1 : 0;
  $("cloudOpts").hidden = !$("clouds").checked;
  $("volOpts").hidden = !vol;
  if (!cloudMesh) return;
  cloudMesh.visible = vol;
  if (!vol) { if (terrainMesh) terrainMesh.material.uniforms.uShadowOn.value = 0; return; }
  const S = R.S, k = Math.min(Math.floor(h / S), R.nt - 2), t = TIERS[QUAL];
  const va = volume(k), vb = volume(k + 1);
  if (k + 2 < R.nt && !moving) setTimeout(() => R && volume(Math.min(k + 2, R.nt - 1)), 0); // prefetch the next frame
  const det = $("orig").checked ? 0 : Number($("cdet").value) * (t.detail || $("cdetOn").checked ? 1 : 0);
  eachCloudMat((u) => {
    u.uVolA.value = va; u.uVolB.value = vb; u.uMix.value = h / S - k;
    u.uThr.value = Number($("cthr").value) / 75; u.uBand.value.set(...BANDS[$("clev").value]);
    u.uSrc.value = CSRC === "w" ? 1 : 0; u.uDetail.value = det; u.uDens.value = Number($("cden").value);
  });
  cloudMesh.material.uniforms.uShadowN.value = $("cself").checked ? t.shadow : 0;
  cloudMesh.material.uniforms.uFine.value = $("orig").checked ? 0 : Number($("cfine").value);
  cloudMesh.material.uniforms.uSee.value = Number($("csee").value);
  $("cfineV").textContent = Math.round(Number($("cfine").value) * 100) + " %"; $("cseeV").textContent = Math.round(Number($("csee").value) * 100) + " %";
  $("cthrV").textContent = `${$("cthr").value} %`;
  $("cdetV").textContent = det ? Math.round(det * 100) + " %" : "off";
  shadowKey = "";
}

// terrain cloud shadows: recomputed when the frame blend, the sun, the exaggeration or the region changes
function updateTerrainShadow() {
  if (!terrainMesh) return;
  const tu = terrainMesh.material.uniforms, t = TIERS[QUAL];
  const on = !!(cloudMesh && cloudMesh.visible && t && t.tshadow && $("tshadow").checked && SUN.el > -2);
  tu.uShadowOn.value = on ? 1 : 0;
  if (!on) return;
  const u = shadowScene.children[0].material.uniforms;
  const key = [u.uVolA.value?.id, u.uVolB.value?.id, u.uMix.value.toFixed(2), SUN.dir.toArray().map((v) => v.toFixed(3)), u.uExag.value, REG.id, u.uDetail.value, u.uThr.value, u.uDens.value, t.tshadow].join("|");
  if (key === shadowKey) return;
  shadowKey = key;
  if (!shadowRT || shadowRT.width !== t.tshadow) {
    shadowRT?.dispose();
    const ar = (u.uBMax.value.z - u.uBMin.value.z) / Math.max(1, u.uBMax.value.x - u.uBMin.value.x);
    shadowRT = new THREE.WebGLRenderTarget(t.tshadow, Math.max(32, Math.round(t.tshadow * ar)), { type: THREE.UnsignedByteType, depthBuffer: false });
    shadowRT.texture.minFilter = shadowRT.texture.magFilter = THREE.LinearFilter;
  }
  renderer.setRenderTarget(shadowRT);
  renderer.render(shadowScene, shadowCam);
  renderer.setRenderTarget(null);
  tu.uShadow.value = shadowRT.texture;
  tu.uShadowBox.value.set(u.uBMin.value.x, u.uBMin.value.z, u.uBMax.value.x, u.uBMax.value.z);
}

// quality: Auto picks a tier from the device and steps down when frames stay slow; Off = cloud-cover layer
function setQuality(mode) {
  QMODE = mode;
  QUAL = mode === "auto" ? AUTO0 : mode;
  if (!cloudMesh && QUAL !== "off") QUAL = "off";
  perf.slow = 0;
  $("quality").value = mode;
  $("cdetRow").hidden = !TIERS[QUAL] || TIERS[QUAL].detail;
  $("tshadowRow").hidden = !TIERS[QUAL] || !TIERS[QUAL].tshadow;
  resizeCloudRT();
  if (R) updateClouds(hour);
  showPerf();
}
function trackPerf(dt) {
  perf.ema = 0.92 * perf.ema + 0.08 * dt * 1000;
  if (QMODE !== "auto" || QUAL === "off" || !cloudMesh?.visible) return;
  perf.slow = perf.ema > (moving ? 55 : 42) ? perf.slow + dt : Math.max(0, perf.slow - dt * 0.5);
  if (perf.slow > 2.5) {
    const order = ["high", "medium", "low", "off"], nx = order[order.indexOf(QUAL) + 1];
    QUAL = nx; perf.slow = 0; perf.ema = 20;
    $("cdetRow").hidden = !TIERS[QUAL] || TIERS[QUAL].detail;
    $("tshadowRow").hidden = !TIERS[QUAL] || !TIERS[QUAL].tshadow;
    resizeCloudRT();
    if (R) updateClouds(hour);
    toast(QUAL === "off" ? "Volumetric clouds paused (too slow here): cloud cover shown instead" : `Cloud quality lowered to ${QUAL} for smoother motion`);
  }
}
function showPerf() {
  if (!$("perf").hidden) $("perf").textContent = `${perf.ema.toFixed(1)} ms/frame · clouds ${QUAL}${QMODE === "auto" ? " (auto)" : ""}${moving ? " · moving" : ""}`
    + (cloudRT ? ` · ${cloudRT.width}×${cloudRT.height}` : "");
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
      out.fields[f] = new Uint8Array(rn.nt * (isRh(f) ? RW * RH : N));
      for (let k = 0; k < rn.nt; k++) jobs.push([f, k]);
    }
    let done = 0, next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [f, k] = jobs[next++];
        const im = await loadPixels(`${DATA}${md.id}/${rn.key}/${f}_${String(k).padStart(2, "0")}.webp`);
        const n = isRh(f) ? RW * RH : N, a = out.fields[f], o = k * n;
        if (im.w * im.h !== n) throw Error(`${f}: ${im.w} x ${im.h} pixels, expected ${n}`);
        for (let q = 0; q < n; q++) a[o + q] = im.rgba[4 * q];
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
  const o0 = k * N, o1 = (k + 1) * N, tt = R.fields.t, ms = R.fields.ms, Dt = DEC.t, Dm = DEC.ms, cc = R.fields.cc, Dc = DEC.cc;
  const msl = ms ? (mslField && mslField.length === N ? mslField : (mslField = new Float32Array(N))) : null;
  // precipitation: window kw (hour h ends in it), position m in it, neighbouring windows for the rate slope
  const kw = Math.min(Math.ceil(h / S), nt - 1), m = h - (kw - 1) * S, oP = kw * N, oPp = (kw - 1) * N, oPn = (kw + 1) * N;
  const hasPrev = kw > 1, hasNext = kw < nt - 1;
  for (let c = 0; c < N; c++) {
    if (COVER && !COVER[c]) { uField[c] = vField[c] = NaN; if (msl) msl[c] = NaN; wxData[4 * c] = 0; wxData[4 * c + 1] = 255; wxData[4 * c + 3] = 255; continue; }
    uField[c] = (1 - w) * Du[u[o0 + c]] + w * Du[u[o1 + c]];
    vField[c] = (1 - w) * Dv[v[o0 + c]] + w * Dv[v[o1 + c]];
    let p = 0;
    if (h > 0) {
      const tot = Dp[pr[oP + c]];
      p = C.prOfHour(tot, hasPrev ? Dp[pr[oPp + c]] : tot, hasNext ? Dp[pr[oPn + c]] : tot, S, m);
    }
    wxData[4 * c] = Math.min(255, Math.round(Math.sqrt(Math.min(p, PRHI) / PRHI) * 255));
    wxData[4 * c + 1] = Math.round(Math.min(ZSHI, (1 - w) * Dz[zs[o0 + c]] + w * Dz[zs[o1 + c]]) / ZSHI * 255);
    wxData[4 * c + 3] = 255;
    const T = tt ? (1 - w) * Dt[tt[o0 + c]] + w * Dt[tt[o1 + c]] : 273;
    wx2Data[4 * c] = Math.max(0, Math.min(255, Math.round((T - 240) / 80 * 255)));
    wx2Data[4 * c + 1] = Math.min(255, Math.round(Math.hypot(uField[c], vField[c]) / 50 * 255));
    if (msl) msl[c] = (1 - w) * Dm[ms[o0 + c]] + w * Dm[ms[o1 + c]];
    wx2Data[4 * c + 3] = cc ? Math.round(((1 - w) * Dc[cc[o0 + c]] + w * Dc[cc[o1 + c]]) / 100 * 255) : 0;
  }
  if (msl) {
    // isobars: smoothed (two 3 x 3 box passes) and scaled to the hour's own range
    smooth(msl, G.nx, G.ny); smooth(msl, G.nx, G.ny);
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < N; c++) if (!COVER || COVER[c]) { if (msl[c] < lo) lo = msl[c]; if (msl[c] > hi) hi = msl[c]; }
    if (!(hi > lo)) { lo = 1000; hi = 1001; }
    for (let c = 0; c < N; c++) wx2Data[4 * c + 2] = Math.round((Math.min(hi, Math.max(lo, msl[c])) - lo) / (hi - lo) * 255);
    terrainMesh.material.uniforms.uMs.value.set(lo, hi);
  }
  wx2Tex.needsUpdate = true;
  updateSun(run.t0 * 1000 + h * 3600000);
  updateClouds(h);
  wxTex.needsUpdate = true;
  terrainMesh.material.uniforms.uHaveWx.value = 1;
  const t = run.t0 * 1000 + h * 3600000;
  $("now").disabled = nowHour() === null;
  $("when").textContent = FMT.format(new Date(t)) + " " + zoneName(t);
  setClock(t, h + (run.off || 0));
  $("lead").textContent = (model.kind === "analysis" ? `${model.name}` : `+${h + (run.off || 0)} h · ${model.name}, start ${FMTUTC(startMs())}`);
  $("hour").value = h;
  $("prev").disabled = h <= 0;
  $("next").disabled = h >= HMAX;
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}

let FMT, HFMT, DFMT, ZFMT, CFMT, mslField = null, allF = new Set(), MFMT;
// 3 x 3 box smoothing in place (edges: the available neighbours)
const smTmp = { a: null };
function smooth(a, nx, ny) {
  const b = smTmp.a && smTmp.a.length === a.length ? smTmp.a : (smTmp.a = new Float32Array(a.length));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) { const jj = j + dj; if (jj < 0 || jj >= ny) continue;
      for (let di = -1; di <= 1; di++) { const ii = i + di; if (ii < 0 || ii >= nx) continue; const v = a[jj * nx + ii]; if (Number.isFinite(v)) { s += v; n++; } } }
    b[j * nx + i] = n ? s / n : NaN;
  }
  a.set(b);
}
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
    dropVolumes();
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
  const y = terrainAt(selected.x, selected.z) / 1000 * exag();
  const g = new THREE.CylinderGeometry(0.0, 2.2, 9, 12); // unit size, scaled with the camera distance every frame
  g.rotateX(Math.PI);
  g.translate(0, 4.5, 0);
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
    + `Snow level ≈ <b>${Math.round(zs / 50) * 50} m</b>${has("ms") ? ` · pressure <b>${Math.round(at("ms", c, h))} hPa</b>` : ""}<br>`
    + `<div class="row" style="margin-top:6px"><button id="openMg">Point ${model.kind === "analysis" ? "time series" : "forecast"}</button><button id="orbitHere">Orbit here</button></div>`;
  $("openMg").onclick = () => { $("mg").hidden = false; drawMeteogram(); };
  $("orbitHere").onclick = () => startOrbit(selected.x, selected.z, C.nearTown(TOWNS, lat, lon));
}

let lastSeries = null;
function showTextForecast() {
  if (!lastSeries) return;
  const { s, z, t0 } = lastSeries;
  const days = C.textForecast(s, (h) => t0 + h * 3600000, (ms) => Number(HFMT.format(new Date(ms))), (ms) => DFMT.format(new Date(ms)), z);
  $("mgText").innerHTML = `<div class="tfHead">Text forecast · ${C.nearTown(TOWNS, selected.lat, selected.lon)}</div>`
    + days.map((d) => `<p><b>${d.label}.</b> ${d.text}</p>`).join("")
    + `<p class="k">Written automatically in your browser by fixed rules from this point's hourly model values (${model.name}); `
    + `not a forecaster's text and not an official forecast. Local days, ${M.tz === "UTC" ? "UTC" : zoneName(t0)}.</p>`;
  $("mgText").hidden = false;
}
function drawMeteogram() {
  if (!selected || !R) return;
  const { c, lat, lon } = selected, n = HMAX + 1, t0 = run.t0 * 1000;
  const T = (h) => new Date(t0 + h * 3600000);
  const z = terrainAt(selected.x, selected.z);
  const s = { t: [], td: [], pr: [], sn: [], kmh: [], dir: [], zs: [], cc: [], ms: [] };
  for (let h = 0; h < n; h++) {
    s.t.push(at("t", c, h) - 273.15); s.td.push(at("td", c, h) - 273.15);
    s.pr.push(at("pr", c, h)); s.sn.push(at("sn", c, h)); s.cc.push(at("cc", c, h));
    const [k, d] = C.windOf(at("u", c, h), at("v", c, h)); s.kmh.push(k); s.dir.push(d); s.zs.push(at("zs", c, h)); s.ms.push(at("ms", c, h));
  }
  lastSeries = { s, z, t0 };
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
  if (has("ms")) panels.push({ title: "Mean sea-level pressure · hPa", lines: [[s.ms, "#cfd8de"]] });
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
  if (!$("mgText").hidden) showTextForecast();
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
function flyTo(target, dist, dir, dur) {
  const d = dir || camera.position.clone().sub(controls.target).normalize();
  fly = { t: 0, dur: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.01 : (dur || 1.1), p0: camera.position.clone(), q0: controls.target.clone(), q1: target, p1: target.clone().add(d.multiplyScalar(dist)) };
}
// ---------- time label on the map (top right, beside the controls): weekday and hour large, date small, zone below ----------
function clockParts(t) {
  const P = MFMT.formatToParts(new Date(t)), part = (k) => (P.find((p) => p.type === k) || {}).value || "";
  return { date: `${part("year")} ${part("month")} ${part("day")}`, main: `${part("weekday")} ${part("hour").padStart(2, " ")} ${part("dayPeriod").toUpperCase()}`, zone: zoneName(t) };
}
function setClock(t, lead) {
  const c = clockParts(t);
  $("cDate").textContent = c.date; $("cMain").textContent = c.main; $("cZone").textContent = `${c.zone} · +${lead} h`;
  $("clock").hidden = false; placeClock();
}
function placeClock() {  // left of the control panel when it is at the top right; below the intro when they would overlap
  const el = $("clock"); if (el.hidden) return;
  let right = 16, top = 16;
  if (!document.body.classList.contains("bare")) {
    const c = $("ctrl").getBoundingClientRect(), i = $("intro").getBoundingClientRect();
    if (c.width && c.top < 120) right = innerWidth - c.left + 14;
    el.style.right = right + "px"; el.style.top = top + "px";
    const r = el.getBoundingClientRect();
    if (i.width && !$("intro").classList.contains("open") && r.left < i.right + 8 && r.top < i.bottom) top = i.bottom + 10;
  }
  el.style.right = right + "px"; el.style.top = top + "px";
  const b = document.querySelector(".fiab-brand.fx"), r = el.getBoundingClientRect();  // the ECMWF / DestinE badge
  if (b) { const q = b.getBoundingClientRect(); if (q.width && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top) el.style.top = (q.bottom + 8) + "px"; }
}
addEventListener("resize", placeClock);
function orbitReadouts() {
  $("orbHV").textContent = `${Number($("orbH").value)} km`;
  $("orbDV").textContent = `${Number($("orbD").value)} km`;
  $("orbTV").textContent = `${Number($("orbT").value)} s`;
}
for (const id of ["orbH", "orbD", "orbT"]) $(id).addEventListener("input", orbitReadouts);
orbitReadouts();

// ---------- orbit around a place: height above sea level (km, times the terrain exaggeration; kept clear of the ground), distance (km), period (s) ----------
let orbit = null;
function orbitEye(o) {
  const e = exag(), y = Math.max(Number($("orbH").value), o.ground + 0.3) * e, D = Number($("orbD").value);
  const x = o.c.x + D * Math.sin(o.a), z = o.c.z + D * Math.cos(o.a), g = terrainAt(x, z);
  return new THREE.Vector3(x, Math.max(y, (Number.isFinite(g) ? g / 1000 : 0) * e + 0.3 * e), z);
}
function startOrbit(x, z, name) {
  const g = terrainAt(x, z), ground = Number.isFinite(g) ? Math.max(0, g) / 1000 : 0, e = exag();
  const c = new THREE.Vector3(x, ground * e, z), v = camera.position.clone().sub(c);
  orbit = { c, ground, a: Math.atan2(v.x, v.z), pending: true, on: false, name };
  const eye = orbitEye(orbit);
  fly = { t: 0, dur: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.01 : 3.5, p0: camera.position.clone(), q0: controls.target.clone(), q1: c, p1: eye };
  $("orbitBox").hidden = false;
  $("orbName").textContent = name || "";
  $("orbStop").textContent = "Stop orbit";
  if ($("orbPlay").checked && !playing) togglePlay(true);
}
function stepOrbit(dt) {
  orbit.a += 2 * Math.PI * dt / Number($("orbT").value);
  camera.position.copy(orbitEye(orbit));
  controls.target.copy(orbit.c);
}
function stopOrbit() { if (orbit) { orbit.on = false; orbit.pending = false; $("orbStop").textContent = "Resume orbit"; } }
function portraitView() {  // land principal axis -> {tgt, dir, dist}, or null (landscape screen, little land)
  if (camera.aspect >= 0.9 || !landT) return null;
  const nx = REG.nx, ny = REG.ny, st = Math.max(1, Math.floor(Math.sqrt(nx * ny / 40000))), P = [];
  for (let j = 0; j < ny; j += st) for (let i = 0; i < nx; i += st)
    if (landT[j * nx + i]) P.push([xOfI(REG.i0 + i / (nx - 1) * (REG.i1 - REG.i0)), zOfJ(REG.j0 + j / (ny - 1) * (REG.j1 - REG.j0))]);
  if (P.length < 0.03 * (nx / st) * (ny / st)) return null;
  let mx = 0, mz = 0; for (const p of P) { mx += p[0]; mz += p[1]; } mx /= P.length; mz /= P.length;
  let a = 0, b = 0, c = 0; for (const p of P) { const x = p[0] - mx, z = p[1] - mz; a += x * x; b += x * z; c += z * z; }
  const th = 0.5 * Math.atan2(2 * b, a - c);
  let u = [Math.cos(th), Math.sin(th)]; if (u[1] < 0) u = [-u[0], -u[1]];  // long axis; camera on its southern (+z) end
  if (Math.atan2(Math.abs(u[0]), u[1]) > 50 * Math.PI / 180) return null;  // turn only near-north-south land (keep north up for wide land)
  const v = [-u[1], u[0]], q = (k) => { const s = P.map((p) => (p[0] - mx) * k[0] + (p[1] - mz) * k[1]).sort((x, y) => x - y);
    return [s[Math.floor(0.01 * s.length)], s[Math.floor(0.99 * s.length)]]; };
  const [u0, u1] = q(u), [v0, v1] = q(v), cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, el = 0.78, t = Math.tan(21 * Math.PI / 180);
  const tgt = new THREE.Vector3(mx + u[0] * cu + v[0] * cv, 0, mz + u[1] * cu + v[1] * cv);
  // the land fits between the top bar (with the map time below it, ~70 px) and the time bar, not the whole screen
  const top = document.body.classList.contains("bare") ? 0 : $("intro").getBoundingClientRect().bottom + 70;
  const tb = $("time").getBoundingClientRect(), bot = tb.height && !document.body.classList.contains("bare") ? tb.top : innerHeight - 70;
  const free = Math.max(0.45, Math.min(1, (bot - top) / innerHeight));
  const dist = 1.08 * Math.max((v1 - v0) / (2 * t * camera.aspect), (u1 - u0) * el / (2 * t) / free);
  const dir = new THREE.Vector3(u[0] * 0.62, el, u[1] * 0.62).normalize();
  return { tgt, dir, dist };
}
function resetView(instant) {
  let tgt = new THREE.Vector3(xOfI((REG.i0 + REG.i1) / 2), 0, zOfJ((REG.j0 + REG.j1) / 2));
  const size = Math.max(regW() / Math.max(camera.aspect, 0.6), regH());
  let dir = new THREE.Vector3(0, 0.78, 0.62).normalize(), dist = size * 1.05;
  controls.maxDistance = size * 3;
  const pv = portraitView(); if (pv) ({ tgt, dir, dist } = pv);
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

// ---------- town labels behind the terrain ----------
// A label (an HTML overlay, outside the depth test) is hidden when the displayed terrain rises above the straight line
// from the camera to its anchor: the line is sampled every half lattice step (heights from terrainAt, the mesh's own
// triangles) until it climbs above the highest terrain. Checked every 100 ms; labels fade in and out (CSS, 180 ms).
let topH = 0, topOf = null, occClock = 0;
function occluded(x, y, z, e, step) {
  if (topOf !== terrainH) { topOf = terrainH; topH = 0; for (const v of terrainH) if (v > topH) topH = v; }
  const c = camera.position, dx = c.x - x, dy = c.y - y, dz = c.z - z, top = topH / 1000 * e, tol = 0.05;
  if (y > top) return false;
  const n = Math.min(6000, Math.ceil(Math.hypot(dx, dz) / step));
  for (let s = 1; s < n; s++) {
    const t = s / n, yy = y + dy * t;
    if (yy > top) return false;
    const h = terrainAt(x + dx * t, z + dz * t);
    if (h / 1000 * e > yy + tol) return true;
  }
  return false;
}
const tmp = new THREE.Vector3();
function updateLabels(now) {
  const on = $("labels").checked, dist = camera.position.distanceTo(controls.target), e = exag();
  const check = now - occClock > 100, step = 0.5 * Math.min((REG.i1 - REG.i0) * G.kx / (REG.nx - 1), (REG.j1 - REG.j0) * G.kz / (REG.ny - 1));
  if (check) occClock = now;
  for (const L of labelEls) {
    const y = terrainAt(L.x, L.z);
    if (!on || !Number.isFinite(y)) { L.el.style.display = "none"; continue; }
    const ya = y / 1000 * e + 0.3;
    tmp.set(L.x, ya, L.z).project(camera);
    const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    L.el.style.display = vis ? "block" : "none";
    if (!vis) continue;
    if (check) L.occ = occluded(L.x, ya, L.z, e, step);
    L.el.style.left = ((tmp.x + 1) / 2 * innerWidth) + "px"; L.el.style.top = ((1 - tmp.y) / 2 * innerHeight) + "px";
    L.sx = (tmp.x + 1) / 2 * innerWidth; L.sy = (1 - tmp.y) / 2 * innerHeight;
    L.el.style.opacity = L.occ || L.dc ? 0 : dist > 1.4 * regSize() ? 0.75 : 1;
  }
  if (check) {  // declutter: a label that overlaps one placed before it (higher in the town list) is hidden
    const put = [];  // the panels, the map time and the badge count as taken
    for (const s of ["#clock", "#intro", "#time", "#ftb", "#ctrl", ".fiab-brand"]) {
      const e = document.querySelector(s); if (!e || e.hidden) continue;
      const r = e.getBoundingClientRect(); if (r.width && getComputedStyle(e).display !== "none") put.push([r.left, r.top, r.right, r.bottom]);
    }
    for (const L of labelEls) {
      L.dc = false;
      if (L.el.style.display === "none" || L.occ) continue;
      if (!L.w) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
      const b = [L.sx - L.w / 2 - 3, L.sy - 1.4 * L.h - 2, L.sx + L.w / 2 + 3, L.sy + 4];
      if (put.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1])) L.dc = true; else put.push(b);
    }
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
      startOrbit(x, z, t[0]);
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

// ---------- hide controls, now, share ----------
function nowHour() {
  if (!run || model.kind === "analysis") return null;
  const h = Math.round((Date.now() - run.t0 * 1000) / 3600000);
  return h >= 0 && h <= HMAX ? h : null;
}
function toast(t) { const e = $("toast"); e.textContent = t; e.style.display = "block"; clearTimeout(toast.k); toast.k = setTimeout(() => { e.style.display = "none"; }, 2500); }
function toggleBare(on) {
  const bare = document.body.classList.toggle("bare", on);
  requestAnimationFrame(placeClock);
  $("hide").textContent = bare ? "Show controls" : "Hide controls";
  $("fHide").textContent = bare ? "☰ Controls" : "✕ Hide";
  for (const L of labelEls) L.y = NaN;
}
const r1 = (v) => Math.round(v * 10) / 10;
function viewHash() {
  const q = new URLSearchParams();
  q.set("m", model.id); q.set("r", run.key); q.set("h", hour); q.set("v", REG.id);
  q.set("cam", [...camera.position.toArray(), ...controls.target.toArray()].map(r1).join(","));
  if (selected) q.set("p", `${selected.lat.toFixed(3)},${selected.lon.toFixed(3)}`);
  if (document.body.classList.contains("bare")) q.set("bare", 1);
  q.set("lay", MODE); q.set("iso", $("iso").checked ? 1 : 0); q.set("cl", $("clouds").checked ? 1 : 0); q.set("dn", $("night").checked ? 1 : 0);
  return q.toString();
}
async function share() {
  const url = location.href.split("#")[0] + "#" + viewHash();
  history.replaceState(null, "", url);
  try { await navigator.clipboard.writeText(url); toast("Link to this view copied"); }
  catch (e) { toast("Link in the address bar: copy it from there"); }
}
async function applyHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.has("v") && M.terrain.regions.some((r) => r.id === q.get("v")) && q.get("v") !== REG.id) { $("view").value = q.get("v"); await loadRegion(q.get("v"), true); }
  const md = M.models.find((m) => m.id === q.get("m"));
  if (md) {
    $("model").value = md.id; $("model").onchange_fill();
    if (md.runs.some((r) => r.key === q.get("r"))) $("run").value = q.get("r");
    if (q.has("h")) hour = Number(q.get("h")) || 0;
    await selectRun();
  } else if (q.has("h")) setHour(Number(q.get("h")) || 0);
  const cam = (q.get("cam") || "").split(",").map(Number);
  if (cam.length === 6 && cam.every(Number.isFinite)) { camera.position.set(cam[0], cam[1], cam[2]); controls.target.set(cam[3], cam[4], cam[5]); controls.update(); }
  const pt = (q.get("p") || "").split(",").map(Number);
  if (pt.length === 2 && pt.every(Number.isFinite)) { const [x, z] = sceneOf(pt[0], pt[1]); select(x, z); }
  if (q.get("bare") === "1") toggleBare(true);
  if (q.has("lay")) setMode(Number(q.get("lay")) || 0);
  if (q.has("iso")) { $("iso").checked = q.get("iso") === "1"; applyIso(); }
  if (q.has("cl")) { $("clouds").checked = q.get("cl") === "1"; showHour(); }
  if (q.has("dn")) { $("night").checked = q.get("dn") === "1"; showHour(); }
}

// ---------- timeline ----------
function setHour(h) { hour = Math.max(0, Math.min(HMAX, h)); showHour(); }
function togglePlay(on) {
  playing = on ?? !playing;
  for (const id of ["play", "fPlay"]) { $(id).textContent = playing ? "❚❚" + (id === "play" ? " Pause" : "") : "▶" + (id === "play" ? " Play" : ""); $(id).classList.toggle("on", playing); }
  clearInterval(playTimer);
  if (playing) playTimer = setInterval(() => setHour(hour >= HMAX ? 0 : hour + 1), 900 / Number($("speed").value));
}

// ---------- recording and snapshots: the 3D view with the place names, the time and the credit ----------
// The WebGL canvas is copied each frame (right after it is drawn) onto a 2D canvas that adds the HTML overlays,
// which is recorded with MediaRecorder (MP4 where the browser supports it, otherwise WebM) and saved as a file.
let rec = null, snapWanted = false;
const recCv = document.createElement("canvas"), recCx = recCv.getContext("2d");
function recMime() {
  if (!window.MediaRecorder) return "";
  for (const m of ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}
function stamp() { const d = new Date(run.t0 * 1000 + hour * 3600000); return d.toISOString().slice(0, 13).replace(/[-T]/g, "") + "UTC"; }
function saveBlob(blob, name) {
  const a = document.createElement("a"), u = URL.createObjectURL(blob);
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}
function composeFrame() {
  const src = renderer.domElement, W = src.width, H = src.height, pr = W / innerWidth;
  if (recCv.width !== W || recCv.height !== H) { recCv.width = W; recCv.height = H; }
  const g = recCx;
  g.drawImage(src, 0, 0);
  g.textAlign = "center"; g.textBaseline = "alphabetic"; g.font = `${Math.round(11 * pr)}px system-ui,sans-serif`;
  for (const L of labelEls) {
    if (L.el.style.display === "none" || Number(L.el.style.opacity) === 0) continue;
    const x = parseFloat(L.el.style.left) * pr, y = parseFloat(L.el.style.top) * pr;
    g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, 2 * pr, 0, 6.283); g.fill();
    g.shadowColor = "#000"; g.shadowBlur = 4 * pr; g.fillText(L.el.textContent, x, y - 6 * pr); g.shadowBlur = 0;
  }
  // time at the top right (as the page label), model line at the bottom left, credit at the bottom right
  const t = run.t0 * 1000 + hour * 3600000, c = clockParts(t), u = pr, pad = 16 * u;
  g.shadowColor = "#07131f"; g.shadowBlur = 10 * u; g.fillStyle = "#e7f3f6"; g.textAlign = "right";
  g.font = `bold ${Math.round(32 * u)}px ui-monospace,Menlo,Consolas,monospace`; g.fillText(c.main, W - pad, pad + 27 * u);
  const tw = g.measureText(c.main).width;
  g.fillStyle = "#cfdee4"; g.font = `bold ${Math.round(19 * u)}px ui-monospace,Menlo,Consolas,monospace`; g.fillText(c.date, W - pad - tw - 10 * u, pad + 27 * u);
  g.fillStyle = "#a5c3d1"; g.font = `600 ${Math.round(15 * u)}px system-ui,sans-serif`; g.fillText(`${c.zone} · +${hour + (run.off || 0)} h`, W - pad, pad + 48 * u);
  g.shadowBlur = 0;
  const grad = g.createLinearGradient(0, H - 60 * u, 0, H); grad.addColorStop(0, "rgba(3,15,25,0)"); grad.addColorStop(1, "rgba(3,15,25,.8)");
  g.fillStyle = grad; g.fillRect(0, H - 60 * u, W, 60 * u);
  g.font = `${Math.round(12 * u)}px system-ui,sans-serif`; g.textAlign = "left"; g.fillStyle = "#c9d6de";
  g.fillText(model.kind === "analysis" ? model.name : `${model.name}, start ${FMTUTC(startMs())}`, pad, H - pad);
  g.textAlign = "right"; g.fillStyle = "#ffffffb0"; g.fillText(`${M.title} · FIAB · ECMWF`, W - pad, H - pad);
}
function recButtons() {
  const on = !!rec, s = on ? Math.floor((performance.now() - rec.t0) / 1000) : 0, txt = on ? `■ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "● Record";
  for (const id of ["rec", "fRec"]) { $(id).textContent = id === "fRec" && !on ? "●" : txt; $(id).classList.toggle("on", on); }
}
function startRec() {
  const mime = recMime();
  if (!mime || !recCv.captureStream) { toast("This browser cannot record video: use Snapshot instead"); return; }
  composeFrame();
  const stream = recCv.captureStream(30), chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Number($("recQ").value) });
  mr.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  mr.onstop = () => { saveBlob(new Blob(chunks, { type: mime.split(";")[0] }), `${M.title.replace(/\W+/g, "-")}-${stamp()}.${mime.includes("mp4") ? "mp4" : "webm"}`); toast("Video saved to your downloads"); };
  rec = { mr, t0: performance.now(), loop: $("recMode").value === "loop", lastH: hour };
  if (rec.loop) { setHour(0); togglePlay(true); }
  mr.start(1000);
  recButtons();
}
function stopRec() { if (!rec) return; rec.mr.stop(); if (rec.loop) togglePlay(false); rec = null; recButtons(); }
function recFrame() {
  if (snapWanted) { snapWanted = false; composeFrame(); recCv.toBlob((b) => b && saveBlob(b, `${M.title.replace(/\W+/g, "-")}-${stamp()}.png`), "image/png"); }
  if (!rec) return;
  composeFrame();
  if (rec.loop && hour < rec.lastH) { stopRec(); return; } // the forecast wrapped round: one loop recorded
  rec.lastH = hour;
  if ((performance.now() - rec.t0) % 1000 < 40) recButtons();
}

// ---------- start ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / (fly.dur || 1.1));
    const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
    camera.position.lerpVectors(fly.p0, fly.p1, e);
    controls.target.lerpVectors(fly.q0, fly.q1, e);
    if (fly.t >= 1) { fly = null; if (orbit && orbit.pending) { orbit.pending = false; orbit.on = true; } }
  }
  if (orbit && orbit.on && !fly) stepOrbit(dt);
  controls.update();
  const dist = camera.position.distanceTo(controls.target);
  if (REG) { // keep the camera above the ground (high terrain exaggeration, close-up tiles)
    const g = terrainAt(camera.position.x, camera.position.z), gy = g / 1000 * exag() + Math.max(0.03, dist * 0.02);
    if (g === g && camera.position.y < gy) camera.position.y = gy;
  }
  // fewer samples and a coarser cloud target while the camera or the timeline moves; refine once it settles
  const mv = !!(fly || (orbit && orbit.on) || playing || dragging || now - lastMove < 250) ? 1 : 0;
  if (mv !== moving) { moving = mv; resizeCloudRT(); }
  if (cloudMesh && TIERS[QUAL]) { const u = cloudMesh.material.uniforms; u.uNear.value = Math.max(4, 0.35 * dist); u.uSteps.value = moving ? TIERS[QUAL].move : TIERS[QUAL].steps; }
  camera.near = Math.max(0.2, dist / 2000); camera.far = dist * 20 + 2000; camera.updateProjectionMatrix();
  if (marker) marker.scale.setScalar(Math.max(0.15, camera.position.distanceTo(marker.position) / 160));
  if (REG) { updateDem(now); updateCoast(now); updateBld(now); updateLandmarks(); stepRibbons(dt); stepDrops(dt); updateLabels(performance.now()); updateCompass(); }
  renderer.render(scene, camera);
  if (cloudMesh && cloudMesh.visible) {
    updateTerrainShadow();
    renderer.setRenderTarget(cloudRT);
    renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.render(cloudScene, camera);
    renderer.setRenderTarget(null);
    renderer.autoClear = false; renderer.render(cloudQuad, camera); renderer.autoClear = true;
  }
  recFrame();
  trackPerf(dt);
  if (now - perf.n > 500) { perf.n = now; showPerf(); }
  requestAnimationFrame(frame);
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeCloudRT();
  if (ribbons) ribbons.material.uniforms.uRes.value.set(innerWidth, innerHeight);
}
addEventListener("resize", onResize);
addEventListener("orientationchange", () => setTimeout(onResize, 250)); // iOS reports the new size a little later
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.target.tagName === "SELECT") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  if (e.key === "h" || e.key === "H") toggleBare();
  if (e.key === "," || e.key === "[") setHour(hour - 1);
  if (e.key === "." || e.key === "]") setHour(hour + 1);
});

// ---------- landscape colour mode and isobars ----------
const MODES = ["Rain/snow", "Temperature", "Wind speed", "Terrain"];
function setMode(m) {
  MODE = m;
  const u = terrainMesh.material.uniforms;
  u.uMode.value = m;
  for (const b of $("modes").children) b.classList.toggle("on", Number(b.dataset.m) === m);
  $("opacRow").hidden = !(m in OPAC);
  if (m in OPAC) { $("opac").value = OPAC[m]; u.uOpac.value = OPAC[m]; $("opacV").textContent = Math.round(OPAC[m] * 100) + " %"; }
  $("legRain").hidden = m !== 0; $("legTemp").hidden = m !== 1; $("legWind").hidden = m !== 2;
}
function applyIso() {
  const u = terrainMesh.material.uniforms;
  u.uIso.value = $("iso").checked && has("ms") ? 1 : 0;
  u.uIsoStep.value = Number($("isoStep").value);
}
function topDown() {
  const d = camera.position.distanceTo(controls.target);
  flyTo(controls.target.clone(), d, new THREE.Vector3(0, 1, 0.001));
}

function legend() {
  const grad = (stops) => `linear-gradient(90deg,${stops.map((s, k) => `rgb(${s[1].map((c) => Math.round(c * 255)).join(",")}) ${(k / (stops.length - 1) * 100).toFixed(0)}%`).join(",")})`;
  $("barRain").style.background = grad(C.RAIN);
  $("barSnow").style.background = grad(C.SNOW);
  const lab = ["<20", "20–40", "40–60", "60–90", "90+"];
  const lgrad = (stops) => `linear-gradient(90deg,${stops.map((s, k) => `rgb(${s[1].map((c) => Math.round(c * 255)).join(",")}) ${((s[0] - stops[0][0]) / (stops[stops.length - 1][0] - stops[0][0]) * 100).toFixed(0)}%`).join(",")})`;
  $("barTemp").style.background = lgrad(C.TEMP);
  $("barWind").style.background = lgrad(C.WSPD);
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
  CFMT = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  MFMT = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "numeric", hour12: true });
  const rs = M.rsub || 2;
  RW = Math.ceil(G.nx / rs); RH = Math.ceil(G.ny / rs);
  allF = new Set(M.models.flatMap((m) => m.fields));
  RLEV = [...allF].filter((f) => isRh(f) && f[0] === "r").map((f) => Number(f.slice(1))).sort((a, b) => b - a);
  if (!RLEV.length) { $("clouds").checked = false; $("cloudRow").hidden = true; }
  if (![...allF].includes("ms")) $("isoRow").hidden = true;
  $("isoStep").value = Math.max(G.nx * G.kx, G.ny * G.kz) > 2500 ? "4" : "2";
  makeWxTexture();
  if (M.cover) {
    const im = await loadPixels(DATA + "cover.png");
    COVER = new Uint8Array(N);
    for (let k = 0; k < N; k++) COVER[k] = im.rgba[4 * k] > 127 ? 1 : 0;
  }
  REG = M.terrain.regions[0]; // the trails are seeded over the first region before its terrain loads
  makeRibbons();
  makeDrops();
  makeClouds();
  makeLabels();
  for (const r of M.terrain.regions) $("view").append(new Option(r.name, r.id));
  await loadDemMeta();
  await loadCoastMeta();
  await loadBldMeta();
  await loadLandmarks();
  await loadRegion("all", true);
  $("dem").onchange = () => { demKey = ""; demClock = 0; };
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
  hour = nowHour() ?? (run.peak || 0);  // the current hour when it is inside the forecast, else the wettest one
  $("model").onchange_fill = fillRuns;
  $("model").onchange = () => { fillRuns(); selectRun(); };
  $("now").onclick = () => { const h = nowHour(); if (h !== null) setHour(h); };
  $("hide").onclick = () => toggleBare();
  const sheet = (which) => {  // phone: About below the top bar, Settings above the time bar; one at a time
    const ab = which === "about" && !$("intro").classList.contains("open"), st = which === "set" && !document.body.classList.contains("sheet");
    $("intro").classList.toggle("open", ab); document.body.classList.toggle("sheet", st);
    $("aboutBtn").textContent = ab ? "Close" : "About"; $("setBtn").textContent = st ? "Close settings" : "Settings";
    $("aboutBtn").setAttribute("aria-expanded", ab); $("setBtn").setAttribute("aria-expanded", st);
    if (ab) $("intro").querySelector("details").open = true;
    placeClock();
  };
  $("aboutBtn").onclick = () => sheet("about");
  $("setBtn").onclick = () => sheet("set");
  $("cleanBtn").onclick = () => { sheet(""); toggleBare(true); };
  $("share").onclick = share;
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
  $("modes").innerHTML = MODES.map((t, k) => `<button data-m="${k}">${t}</button>`).join("");
  for (const b of $("modes").children) b.onclick = () => setMode(Number(b.dataset.m));
  $("opac").oninput = () => { OPAC[MODE] = Number($("opac").value); setMode(MODE); };
  setMode(0);
  $("iso").onchange = applyIso; $("isoStep").onchange = applyIso;
  for (const id of ["clouds", "clev", "cthr", "cden", "cdet", "cself", "orig", "cdetOn", "tshadow", "cfine", "csee"]) $(id).oninput = () => updateClouds(hour);
  for (const id of ["clouds", "cself", "orig", "cdetOn", "tshadow", "clev"]) $(id).onchange = () => updateClouds(hour);
  $("quality").onchange = () => setQuality($("quality").value);
  $("night").onchange = () => { shadowKey = ""; showHour(); };
  $("csrc").onchange = () => { CSRC = $("csrc").value; dropVolumes(); updateClouds(hour); };
  if (RLEV.some((p) => [...allF].includes("w" + p))) $("csrcRow").hidden = false;
  if (!TIERS.low || PHONE) $("tshadow").checked = false;
  setQuality(QUAL === "off" ? "off" : "auto");
  if (new URLSearchParams(location.hash.slice(1)).get("perf") === "1" || /[?&]perf/.test(location.search)) $("perf").hidden = false;
  addEventListener("keydown", (e) => { if (e.key === "p" && e.target.tagName !== "INPUT") $("perf").hidden = !$("perf").hidden; });
  $("topdown").onclick = topDown;
  $("orbStop").onclick = () => { if (orbit && (orbit.on || orbit.pending)) stopOrbit(); else if (orbit) { orbit.on = true; $("orbStop").textContent = "Stop orbit"; } };
  controls.addEventListener("start", () => { fly = null; if (orbit && (orbit.on || orbit.pending)) stopOrbit(); });
  $("speed").onchange = () => { $("fSpeed").value = $("speed").value; if (playing) togglePlay(true); };
  $("fSpeed").onchange = () => { $("speed").value = $("fSpeed").value; if (playing) togglePlay(true); };
  $("fPlay").onclick = () => togglePlay();
  $("fPrev").onclick = () => setHour(hour - 1);
  $("fNext").onclick = () => setHour(hour + 1);
  $("fNow").onclick = () => { const h = nowHour(); if (h !== null) setHour(h); };
  $("fHide").onclick = () => toggleBare();
  $("rec").onclick = $("fRec").onclick = () => (rec ? stopRec() : startRec());
  $("snap").onclick = () => { snapWanted = true; };
  if (!recMime()) $("recNote").textContent = "This browser cannot record video here; snapshots still work.";
  $("tf").onclick = () => { if ($("mgText").hidden) showTextForecast(); else $("mgText").hidden = true; };
  setTimeout(placeClock, 500);  // the brand badge arrives with a deferred script
  requestAnimationFrame(frame);
  await selectRun();
  await applyHash();
  // place the camera at once (no flight): dist km from (lat, lon), looking down at tilt degrees from the horizon
  const lookAt = (lat, lon, dist, tilt = 35, az = 200) => {
    const [fj, fi] = GR.index(lat, lon), x = xOfI(fi), z = zOfJ(fj), g = terrainAt(x, z), y = (Number.isFinite(g) ? Math.max(g, 0) : 0) / 1000 * exag();
    const r = Math.PI / 180, c = new THREE.Vector3(x, y, z);
    fly = null; if (orbit) { orbit.on = false; orbit.pending = false; }
    controls.target.copy(c);
    camera.position.copy(c).add(new THREE.Vector3(Math.sin(az * r) * Math.cos(tilt * r), Math.sin(tilt * r), Math.cos(az * r) * Math.cos(tilt * r)).multiplyScalar(dist));
    controls.update();
  };
  window.FIAB3D = { setHour, loadRegion, sceneOf, terrainAt, exag, camera, controls, lookAt, get hour() { return hour; }, get terrain() { return terrainMesh; } }; // for scripted views and tests
}
main();
