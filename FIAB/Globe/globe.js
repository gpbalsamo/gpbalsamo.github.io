// FIAB Globe: an AIFS Single forecast on a 3D globe with exaggerated relief, rain/snow/cloud or temperature or wind
// painted on it, isobars, animated 10 m wind trails, an hourly timeline (interpolated from 6-hourly steps), place
// labels, a point forecast, shareable views and a hide-controls mode. Data from build_globe.py (data/).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as C from "./core.js?v=202611060031";

const $ = (id) => document.getElementById(id);
const DEBUG = location.search.includes("debug") ? {} : null;
const DATA = "data/", RAD = Math.PI / 180, RE = 6371000;
let M, NX, NY, COLS, NS, HMAX, hour = 0, layer = 0, playing = false, playTimer = null;
let WA, WB, OR; // CPU pixels of the atlases and the terrain

// ---------- geometry: lat/lon <-> unit vector (lon 0 at +x, east towards -z, north +y) ----------
const xyz = (lat, lon, r = 1) => new THREE.Vector3(r * Math.cos(lat * RAD) * Math.cos(lon * RAD), r * Math.sin(lat * RAD), -r * Math.cos(lat * RAD) * Math.sin(lon * RAD));
const latlonOf = (p) => { const n = p.clone().normalize(); return [Math.asin(n.y) / RAD, ((Math.atan2(-n.z, n.x) / RAD) + 360) % 360]; };
const exag = () => Number($("exag").value);

// ---------- renderer ----------
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
catch (e) { $("status").textContent = "This page needs WebGL, which is not available in this browser."; $("status").style.display = "block"; throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
$("scene").append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05090f);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 1.12; controls.maxDistance = 8;

// ---------- textures ----------
function loadImage(url) {
  return new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(Error("cannot load " + url)); im.src = url; });
}
function pixels(im) {
  const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
  const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(im, 0, 0);
  return { w: im.width, h: im.height, d: cx.getImageData(0, 0, im.width, im.height).data };
}
function dataTex(im) {
  const t = new THREE.Texture(im);
  t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
function terrainTex() { // half-float (height km, land) so that the terrain filters smoothly
  const n = OR.w * OR.h, a = new Uint16Array(4 * n), off = M.orog.offset;
  for (let k = 0; k < n; k++) {
    const h = (OR.d[4 * k] * 256 + OR.d[4 * k + 1] - off) / 1000;
    a[4 * k] = THREE.DataUtils.toHalfFloat(h); a[4 * k + 1] = THREE.DataUtils.toHalfFloat(OR.d[4 * k + 2] > 127 ? 1 : 0);
    a[4 * k + 2] = 0; a[4 * k + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(a, OR.w, OR.h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}

// ---------- globe shader ----------
const rampU = (stops) => ({ c: stops.map((s) => new THREE.Vector3(...s[1])), v: stops.map((s) => Math.log10(s[0])) });
const TEMP = [[-40, "#2d0a5e"], [-25, "#3b4cc0"], [-10, "#6a9be0"], [0, "#cfe7f5"], [10, "#f3e3a1"], [20, "#f5a25d"], [30, "#d8452e"], [40, "#7a0b1d"]].map(([v, c]) => [v, C.hex(c)]);
const WSPD = [[0, "#1b2a3a"], [5, "#2f6b8f"], [10, "#46a39a"], [15, "#d7d36b"], [20, "#f09a3e"], [30, "#d23b5a"], [40, "#8e2c99"]].map(([v, c]) => [v, C.hex(c)]);
const ramp = (name, stops, log) => `
vec3 ${name}(float x){ vec3 c=${vec(stops[0][1])}; ${stops.slice(1).map((s, i) => `c = x >= ${f(val(stops[i][0], log))} ? mix(${vec(stops[i][1])}, ${vec(s[1])}, clamp((x-${f(val(stops[i][0], log))})/${f(val(s[0], log) - val(stops[i][0], log))},0.,1.)) : c;`).join(" ")} return c; }`;
const f = (x) => `(${Number(x).toFixed(6)})`; // a GLSL float literal, signed values in parentheses
const val = (x, log) => (log ? Math.log10(x) : x);
const vec = (c) => `vec3(${c.map((x) => x.toFixed(3)).join(",")})`;

const VS = `
uniform sampler2D uTer; uniform float uExag;
varying vec3 vP; varying vec2 vLL;
const float PI = 3.14159265;
void main(){
  vec3 n = normalize(position);
  float lat = asin(clamp(n.y,-1.,1.)), lon = atan(-n.z, n.x); if (lon < 0.) lon += 2.*PI;
  vec2 uv = vec2(lon/(2.*PI) + 0.5/1440., (PI/2. - lat)/PI);
  float h = max(texture2D(uTer, uv).r, 0.);
  vec3 p = n * (1.0 + h * 1000. / ${RE.toFixed(1)} * uExag);
  vP = n; vLL = vec2(lat, lon);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FS = () => `
precision highp float;
uniform sampler2D uTer, uA, uB; uniform vec3 uLight, uSun; uniform float uExag, uK0, uK1, uW, uKP, uHaveP, uLayer, uIsob, uNight;
varying vec3 vP; varying vec2 vLL;
const float PI = 3.14159265;
${ramp("rampRain", C.RAIN, true)}
${ramp("rampSnow", C.SNOW, true)}
${ramp("rampT", TEMP, false)}
${ramp("rampW", WSPD, false)}
vec3 hyps(float h){
  vec3 c0=vec3(.31,.45,.27), c1=vec3(.45,.55,.32), c2=vec3(.62,.60,.42), c3=vec3(.55,.46,.35), c4=vec3(.60,.58,.56), c5=vec3(.90,.91,.93);
  if(h<.3) return mix(c0,c1,clamp(h/.3,0.,1.));
  if(h<.9) return mix(c1,c2,(h-.3)/.6);
  if(h<1.8) return mix(c2,c3,(h-.9)/.9);
  if(h<3.) return mix(c3,c4,(h-1.8)/1.2);
  return mix(c4,c5,clamp((h-3.)/1.5,0.,1.));
}
vec2 tile(float k, float lon, float lat){ // texel position of (lon, lat) in tile k of a ${COLS} x ${M.grid.rows} atlas
  float col = mod(k, ${f(COLS)}), row = floor(k / ${f(COLS)});
  float x = clamp(lon * 180. / PI, 0., ${f(NX - 1)}), y = clamp(90. - lat * 180. / PI, 0., ${f(NY - 1)});
  return vec2((col * ${f(NX)} + x + .5) / ${f(COLS * NX)}, (row * ${f(NY)} + y + .5) / ${f(M.grid.rows * NY)});
}
vec4 atl(sampler2D t, float k, float lon, float lat){ // across 359..360 E, between the last and the first column
  float x = lon * 180. / PI, w = clamp(x - ${f(NX - 1)}, 0., 1.);
  vec4 a = texture2D(t, tile(k, lon, lat));
  return w > 0. ? mix(a, texture2D(t, tile(k, 0., lat)), w) : a;
}
void main(){
  vec3 nP = normalize(vP); // lat/lon per pixel: interpolating them breaks at the 0/360 wrap
  float lat = asin(clamp(nP.y,-1.,1.)), lon = atan(-nP.z, nP.x); if (lon < 0.) lon += 2.*PI;
  vec2 uv = vec2(lon/(2.*PI) + 0.5/1440., (PI/2. - lat)/PI);
  vec4 t = texture2D(uTer, uv);
  float h = t.r, land = t.g;
  // relief normal from the height gradient (east, north), exaggerated
  float du = 1./1440., dv = 1./721.;
  float hE = texture2D(uTer, uv + vec2(du,0.)).r, hW = texture2D(uTer, uv - vec2(du,0.)).r;
  float hN = texture2D(uTer, uv - vec2(0.,dv)).r, hS = texture2D(uTer, uv + vec2(0.,dv)).r;
  float dx = 2. * PI * ${(RE / 1000).toFixed(1)} * max(cos(lat), .05) / 1440., dy = PI * ${(RE / 1000).toFixed(1)} / 720.;
  float gx = (max(hE,0.) - max(hW,0.)) / (2.*dx) * uExag * .35, gy = (max(hN,0.) - max(hS,0.)) / (2.*dy) * uExag * .35;
  vec3 up = normalize(vP), east = normalize(vec3(-sin(lon), 0., -cos(lon))), north = cross(up, east);
  vec3 nrm = normalize(up - gx * east - gy * north);
  float diff = max(dot(nrm, uLight), 0.);
  vec3 c = land < .5 ? vec3(.05,.15,.24) : hyps(h);
  float shade = land < .5 ? .78 + .22 * diff : .35 + .75 * diff;
  c *= shade;
  // weather at hour: steps k0, k1 with weight w; precipitation window kp
  vec4 A = mix(atl(uA, uK0, lon, lat), atl(uA, uK1, lon, lat), uW), B = mix(atl(uB, uK0, lon, lat), atl(uB, uK1, lon, lat), uW);
  float t2 = mix(${f(M.scale.t2[0])}, ${f(M.scale.t2[1])}, A.r);
  float u = mix(${f(M.scale.u[0])}, ${f(M.scale.u[1])}, A.g), v = mix(${f(M.scale.v[0])}, ${f(M.scale.v[1])}, A.b);
  float msl = mix(${f(M.scale.msl[0])}, ${f(M.scale.msl[1])}, B.r), tcc = B.b;
  if (uLayer < .5) {
    c = mix(c, vec3(.93,.95,.97), smoothstep(.15, 1., tcc) * .62);
    if (uHaveP > .5) {
      float pb = atl(uB, uKP, lon, lat).g, pr = pb * pb * ${f(M.pmax)} / 6.;
      if (pr >= .1) {
        float lv = log(pr) / log(10.);
        vec3 pc = t2 < 1. ? rampSnow(lv) : rampRain(lv);
        c = mix(c, pc, .45 + .5 * clamp((lv + 1.) / 1.3, 0., 1.));
      }
    }
  } else if (uLayer < 1.5) c = mix(c, rampT(t2) * (.55 + .5 * shade), .78);
  else if (uLayer < 2.5) c = mix(c, rampW(length(vec2(u, v))) * (.55 + .5 * shade), .8);
  if (uIsob > .5) { // every 4 hPa, 1000 hPa bolder
    float q = msl / 4., fw = fwidth(q), d = abs(fract(q + .5) - .5) / max(fw, .012);
    float a = (1. - smoothstep(.5, 1.6, d)) * .55;
    float d1 = abs(msl - 1000.) / max(fwidth(msl), .05);
    a = max(a, (1. - smoothstep(.8, 2.2, d1)) * .8);
    c = mix(c, vec3(.08,.08,.1), a);
  }
  if (uNight > .5) c *= mix(.28, 1., smoothstep(-.12, .08, dot(up, uSun)));
  gl_FragColor = vec4(c, 1.);
}`;

let globe, atmo, uniforms;
function makeGlobe(texA, texB, texT) {
  uniforms = {
    uTer: { value: texT }, uA: { value: texA }, uB: { value: texB }, uExag: { value: exag() },
    uLight: { value: new THREE.Vector3(1, 1, 1).normalize() }, uSun: { value: new THREE.Vector3(1, 0, 0) },
    uK0: { value: 0 }, uK1: { value: 1 }, uW: { value: 0 }, uKP: { value: 1 }, uHaveP: { value: 0 },
    uLayer: { value: 0 }, uIsob: { value: 1 }, uNight: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader: FS() });
  globe = new THREE.Mesh(new THREE.SphereGeometry(1, 720, 360), mat);
  scene.add(globe);
  atmo = new THREE.Mesh(new THREE.SphereGeometry(1.025, 96, 48), new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "varying vec3 vN; varying vec3 vV; void main(){ float r = pow(1. - abs(dot(vN, vV)), 3.); gl_FragColor = vec4(.35,.6,1., 1.) * r * .9; }",
  }));
  scene.add(atmo);
}

// ---------- CPU sampling of the atlases ----------
function texel(P, k, ch, i, j) { // byte at grid (i lon, j lat row) of step k
  const col = k % COLS, row = Math.floor(k / COLS);
  return P.d[4 * ((row * NY + j) * P.w + col * NX + i) + ch];
}
function bil(P, k, ch, lat, lon) {
  const x = ((lon % 360) + 360) % 360, y = Math.min(NY - 1, Math.max(0, 90 - lat));
  const i0 = Math.floor(x), j0 = Math.min(NY - 2, Math.floor(y)), fx = x - i0, fy = y - j0, i1 = (i0 + 1) % NX;
  return (1 - fy) * ((1 - fx) * texel(P, k, ch, i0, j0) + fx * texel(P, k, ch, i1, j0)) + fy * ((1 - fx) * texel(P, k, ch, i0, j0 + 1) + fx * texel(P, k, ch, i1, j0 + 1));
}
const dec = (b, sc) => sc[0] + (b / 255) * (sc[1] - sc[0]);
function stepOf(h) { const k = Math.min(Math.floor(h / 6), NS - 2); return [k, h / 6 - k]; }
function valueAt(name, lat, lon, h) {
  const [k, w] = stepOf(h), S = M.scale;
  const two = (P, ch, sc) => dec((1 - w) * bil(P, k, ch, lat, lon) + w * bil(P, k + 1, ch, lat, lon), sc);
  if (name === "t2") return two(WA, 0, S.t2);
  if (name === "u") return two(WA, 1, S.u);
  if (name === "v") return two(WA, 2, S.v);
  if (name === "msl") return two(WB, 0, S.msl);
  if (name === "tcc") return two(WB, 2, S.tcc);
  if (name === "pr") { const kp = Math.ceil(h / 6); if (kp < 1) return NaN; const b = bil(WB, Math.min(kp, NS - 1), 1, lat, lon) / 255; return b * b * M.pmax / 6; }
}
function heightAt(lat, lon) {
  const x = Math.round((((lon % 360) + 360) % 360) * 4) % OR.w, y = Math.min(OR.h - 1, Math.max(0, Math.round((90 - lat) * 4)));
  const k = 4 * (y * OR.w + x);
  return Math.max(0, OR.d[k] * 256 + OR.d[k + 1] - M.orog.offset);
}

// ---------- wind trails (line segments, history of NL points) ----------
const NP = 12000, NL = 10;
let trailGeo, trails, parts = [], histClock = 0;
const BANDS = C.WIND_BANDS.map((b) => C.hex(b[1]));
function makeTrails() {
  trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NP * (NL - 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NP * (NL - 1) * 2 * 4), 4).setUsage(THREE.DynamicDrawUsage));
  trails = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  trails.frustumCulled = false; trails.renderOrder = 2;
  scene.add(trails);
  for (let i = 0; i < NP; i++) parts.push(spawn({ hist: [] }, true));
}
function spawn(p, first) {
  p.lat = Math.asin(2 * Math.random() - 1) / RAD; p.lon = Math.random() * 360;
  p.life = 2.5 + Math.random() * 4; p.age = first ? Math.random() * p.life : 0; p.hist.length = 0; p.kmh = 0;
  return p;
}
function stepTrails(dt) {
  const show = $("trails").checked; trails.visible = show;
  if (!show) return;
  const k = 0.3 * Number($("spd").value), e = exag(), nAct = Math.round(NP * Number($("dens").value));
  histClock += dt; const record = histClock > 0.07; if (record) histClock = 0;
  const P = trailGeo.attributes.position.array, Cc = trailGeo.attributes.color.array;
  const [k0, w] = stepOf(hour), S = M.scale;
  let s = 0;
  for (let ip = 0; ip < NP; ip++) {
    const p = parts[ip];
    if (ip >= nAct) { for (let q = 0; q < NL - 1; q++, s++) { Cc[8 * s + 3] = 0; Cc[8 * s + 7] = 0; } continue; }
    p.age += dt;
    if (p.age > p.life || Math.abs(p.lat) > 88) spawn(p, false);
    else {
      const u = dec((1 - w) * bil(WA, k0, 1, p.lat, p.lon) + w * bil(WA, k0 + 1, 1, p.lat, p.lon), S.u);
      const v = dec((1 - w) * bil(WA, k0, 2, p.lat, p.lon) + w * bil(WA, k0 + 1, 2, p.lat, p.lon), S.v);
      p.lat += v * k * dt; p.lon += u * k * dt / Math.max(Math.cos(p.lat * RAD), 0.05); p.kmh = Math.hypot(u, v) * 3.6;
    }
    if (record) {
      const r = 1 + heightAt(p.lat, p.lon) / RE * e + 0.0025;
      p.hist.push(xyz(p.lat, p.lon, r));
      if (p.hist.length > NL) p.hist.shift();
    }
    const col = BANDS[C.windBand(p.kmh)], fade = Math.max(0, Math.min(1, p.age / 0.6, (p.life - p.age) / 0.6));
    const H = p.hist, m = H.length;
    for (let q = 0; q < NL - 1; q++, s++) {
      if (q < m - 1 && H[q].distanceTo(H[q + 1]) < 0.08) {
        H[q].toArray(P, 6 * s); H[q + 1].toArray(P, 6 * s + 3);
        const a0 = fade * (0.1 + 0.9 * q / (m - 1)), a1 = fade * (0.1 + 0.9 * (q + 1) / (m - 1));
        Cc.set([col[0], col[1], col[2], a0, col[0], col[1], col[2], a1], 8 * s);
      } else { Cc[8 * s + 3] = 0; Cc[8 * s + 7] = 0; }
    }
  }
  trailGeo.attributes.position.needsUpdate = true; trailGeo.attributes.color.needsUpdate = true;
}

// ---------- time ----------
const FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", hourCycle: "h23" });
const DFMT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric" });
const tOf = (h) => (M.t0 + h * 3600) * 1000;
function sunDir(ms) { // subsolar point from the declination and the equation of time
  const d = ms / 86400000 - 10957.5, g = RAD * (357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const L = RAD * (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), e = RAD * (23.439 - 0.00000036 * d);
  const dec = Math.asin(Math.sin(e) * Math.sin(L)), ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  return xyz(dec / RAD, ra / RAD - gmst);
}
function showHour() {
  const [k, w] = stepOf(hour), kp = Math.ceil(hour / 6);
  uniforms.uK0.value = k; uniforms.uK1.value = k + 1; uniforms.uW.value = w;
  uniforms.uKP.value = Math.min(Math.max(kp, 1), NS - 1); uniforms.uHaveP.value = kp >= 1 ? 1 : 0;
  uniforms.uSun.value.copy(sunDir(tOf(hour)));
  $("hour").value = hour;
  $("when").textContent = FMT.format(new Date(tOf(hour))) + " UTC";
  $("lead").textContent = `+${hour} h · AIFS Single, run ${M.run.slice(6, 8)}/${M.run.slice(4, 6)} ${M.run.slice(8)} UTC`;
  $("now").disabled = nowHour() === null;
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}
function setHour(h) { hour = Math.max(0, Math.min(HMAX, Math.round(h))); showHour(); }
function nowHour() { const h = Math.round((Date.now() / 1000 - M.t0) / 3600); return h >= 0 && h <= HMAX ? h : null; }
function togglePlay(on) {
  playing = on ?? !playing;
  $("play").textContent = playing ? "❚❚ Pause" : "▶ Play"; $("play").classList.toggle("on", playing);
  clearInterval(playTimer);
  if (playing) playTimer = setInterval(() => setHour(hour >= HMAX ? 0 : hour + 1), 140);
}

// ---------- inspect ----------
let selected = null, marker = null;
const llText = (lat, lon) => { const L = lon > 180 ? lon - 360 : lon; return `${Math.abs(lat).toFixed(1)}°${lat < 0 ? "S" : "N"} ${Math.abs(L).toFixed(1)}°${L < 0 ? "W" : "E"}`; };
const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
function nearestPlace(lat, lon) {
  let best = null, bd = 1e9;
  for (const [n, la, lo] of M.places) { const d = C.distBearing(lat, lon, la, lo)[0]; if (d < bd) { bd = d; best = n; } }
  return bd < 150 ? best : null;
}
function select(lat, lon) {
  selected = { lat, lon, name: nearestPlace(lat, lon) };
  if (marker) scene.remove(marker);
  const s = 0.012, g = new THREE.ConeGeometry(s * 0.35, s, 12); g.translate(0, -s / 2, 0); g.rotateX(Math.PI);
  marker = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf0b44c }));
  const up = xyz(lat, lon), r = 1 + heightAt(lat, lon) / RE * exag();
  marker.position.copy(up.clone().multiplyScalar(r)); marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), up.clone().negate());
  scene.add(marker);
  updateInfo();
  if (!$("mg").hidden) drawMeteogram();
}
function updateInfo() {
  if (!selected) return;
  const { lat, lon } = selected, u = valueAt("u", lat, lon, hour), v = valueAt("v", lat, lon, hour), [kmh, dir] = C.windOf(u, v);
  const t2 = valueAt("t2", lat, lon, hour), pr = valueAt("pr", lat, lon, hour);
  $("info").innerHTML = `<b>${selected.name ? "Near " + selected.name : llText(lat, lon)}</b> <span class="k">${selected.name ? llText(lat, lon) : ""}</span><br>`
    + `<span class="k">2 m temperature</span> <b>${f1(t2)} °C</b><br><span class="k">Wind</span> <b>${Math.round(kmh)} km/h</b> from ${C.compass16(dir)}<br>`
    + `<span class="k">Precipitation</span> <b>${Number.isFinite(pr) ? f1(pr) + " mm/h" : "–"}</b>${Number.isFinite(pr) && pr >= 0.1 && t2 < 1 ? " (snow)" : ""}`
    + ` · <span class="k">cloud</span> <b>${Math.round(100 * valueAt("tcc", lat, lon, hour))} %</b><br><span class="k">Pressure</span> <b>${f1(valueAt("msl", lat, lon, hour), 0)} hPa</b> · <span class="k">terrain</span> ${Math.round(heightAt(lat, lon))} m`
    + `<br><button id="openMg" style="margin-top:6px">Point forecast</button>`;
  $("openMg").onclick = () => { $("mg").hidden = false; drawMeteogram(); };
}
function chart(title, unit, xs, ys, opts = {}) {
  const W = 780, H = 120, L = 42, R = 8, T = 16, B = 18;
  const fin = ys.filter(Number.isFinite), lo = opts.min ?? Math.min(...fin), hi = Math.max(opts.min !== undefined ? opts.min + 1 : -1e9, ...fin);
  const pad = (hi - lo) * 0.08 || 1, y0 = opts.min ?? lo - pad, y1 = hi + pad;
  const X = (h) => L + (W - L - R) * h / HMAX, Y = (v) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0));
  let g = `<text x="${L}" y="11" fill="#cfd8de" font-size="11">${title} (${unit})</text>`;
  const st = C.niceStep(y1 - y0, 3);
  for (let v = Math.ceil(y0 / st) * st; v <= y1; v += st) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#ffffff18"/><text x="${L - 4}" y="${Y(v) + 3}" fill="#8a9aa5" font-size="10" text-anchor="end">${+v.toFixed(1)}</text>`;
  for (let h = 0; h <= HMAX; h += 24) { g += `<line x1="${X(h)}" x2="${X(h)}" y1="${T}" y2="${H - B}" stroke="#ffffff10"/><text x="${X(h) + 2}" y="${H - 5}" fill="#8a9aa5" font-size="10">${DFMT.format(new Date(tOf(h)))}</text>`; }
  if (opts.bars) for (let i = 0; i < xs.length; i++) { if (!(ys[i] > 0)) continue; const x0 = X(xs[i] - 6), x1 = X(xs[i]); g += `<rect x="${x0 + 0.5}" y="${Y(ys[i])}" width="${Math.max(1, x1 - x0 - 1)}" height="${Y(y0) - Y(ys[i])}" fill="${opts.color}"/>`; }
  else g += `<polyline fill="none" stroke="${opts.color}" stroke-width="2" points="${xs.map((h, i) => `${X(h).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ")}"/>`;
  g += `<line x1="${X(hour)}" x2="${X(hour)}" y1="${T}" y2="${H - B}" stroke="#f0b44c" stroke-width="1.5"/>`;
  return `<svg class="ch" viewBox="0 0 ${W} ${H}">${g}</svg>`;
}
function drawMeteogram() {
  if (!selected) return;
  const { lat, lon } = selected, hs = M.steps;
  const at = (n) => hs.map((h) => valueAt(n, lat, lon, h));
  const ws = hs.map((h) => C.windOf(valueAt("u", lat, lon, h), valueAt("v", lat, lon, h))[0]);
  const pr6 = hs.map((h) => (h === 0 ? 0 : valueAt("pr", lat, lon, h) * 6));
  $("mgPlace").textContent = selected.name ? `Near ${selected.name}` : llText(lat, lon);
  $("mgSub").textContent = `${llText(lat, lon)} · AIFS Single, run ${FMT.format(new Date(M.t0 * 1000))} UTC · 10 days, 6-hourly · total precipitation ${pr6.reduce((a, b) => a + b, 0).toFixed(1)} mm`;
  $("mgCharts").innerHTML = chart("2 m temperature", "°C", hs, at("t2"), { color: "#f5a25d" })
    + chart("Precipitation in 6 h", "mm", hs, pr6, { bars: true, min: 0, color: "#2e8ef2" })
    + chart("10 m wind", "km/h", hs, ws, { color: "#ffe066", min: 0 })
    + chart("Sea-level pressure", "hPa", hs, at("msl"), { color: "#cfd8de" });
  $("mgNote").textContent = "From the 1° grid, interpolated to the point: local effects (coasts, valleys, mountains) are smoothed.";
}

// ---------- labels and search ----------
let labelEls = [];
function makeLabels() {
  for (const [n, la, lo] of M.places) {
    const d = document.createElement("div"); d.className = "lab"; d.textContent = n; $("labs").append(d);
    labelEls.push({ d, p: xyz(la, lo, 1 + heightAt(la, lo) / RE * exag() + 0.002), lat: la, lon: lo });
  }
}
const tv = new THREE.Vector3();
function updateLabels() {
  const show = $("labels").checked && !document.body.classList.contains("bare"), cam = camera.position, placed = [];
  for (const L of labelEls) {
    let vis = false;
    if (show) {
      const facing = L.p.clone().normalize().dot(tv.copy(cam).sub(L.p).normalize());
      if (facing > 0.15) {
        tv.copy(L.p).project(camera);
        const x = (tv.x + 1) / 2 * innerWidth, y = (1 - tv.y) / 2 * innerHeight;
        if (tv.z < 1 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && !placed.some(([a, b]) => Math.abs(a - x) < 70 && Math.abs(b - y) < 18)) {
          placed.push([x, y]); vis = true; L.d.style.left = x + "px"; L.d.style.top = y + "px";
        }
      }
    }
    L.d.style.display = vis ? "block" : "none";
  }
}
function searchPlaces() {
  const q = C.searchKey($("q").value.trim());
  $("matches").replaceChildren();
  if (q.length < 2) return;
  for (const [n, la, lo] of M.places.filter((p) => C.searchKey(p[0]).includes(q)).slice(0, 6)) {
    const b = document.createElement("button"); b.textContent = n;
    b.onclick = () => { flyTo(la, lo, 1.6); select(la, lo); $("matches").replaceChildren(); $("q").value = ""; };
    $("matches").append(b);
  }
}

// ---------- camera ----------
let fly = null;
function flyTo(lat, lon, dist) {
  const p1 = xyz(lat, lon, dist ?? camera.position.length());
  fly = { t: 0, p0: camera.position.clone(), p1 };
}
function resetView(instant) { if (instant) camera.position.copy(xyz(42, 12, 3.3)); else flyTo(42, 12, 3.3); }
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
function pick(ev) {
  ptr.set(ev.clientX / innerWidth * 2 - 1, -ev.clientY / innerHeight * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObject(globe)[0];
  return hit ? latlonOf(hit.point) : null;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 5) { const p = pick(e); if (p) select(p[0], p[1]); }
  downAt = null;
});
renderer.domElement.addEventListener("dblclick", (e) => { const p = pick(e); if (p) flyTo(p[0], p[1], Math.max(1.15, 1 + (camera.position.length() - 1) * 0.5)); });

// ---------- hide controls, share ----------
function toast(t) { const e = $("toast"); e.textContent = t; e.style.display = "block"; clearTimeout(toast.k); toast.k = setTimeout(() => { e.style.display = "none"; }, 2500); }
function toggleBare(on) { const b = document.body.classList.toggle("bare", on); $("hide").textContent = b ? "Show controls" : "Hide controls"; }
function viewHash() {
  const q = new URLSearchParams(), [la, lo] = latlonOf(camera.position);
  q.set("h", hour); q.set("cam", `${la.toFixed(2)},${lo.toFixed(2)},${camera.position.length().toFixed(3)}`); q.set("layer", $("layer").value);
  if (selected) q.set("p", `${selected.lat.toFixed(2)},${selected.lon.toFixed(2)}`);
  if (document.body.classList.contains("bare")) q.set("bare", 1);
  return q.toString();
}
async function share() {
  const url = location.href.split("#")[0] + "#" + viewHash();
  history.replaceState(null, "", url);
  try { await navigator.clipboard.writeText(url); toast("Link to this view copied"); } catch (e) { toast("Link in the address bar: copy it from there"); }
}
function applyHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.has("layer")) { $("layer").value = q.get("layer"); setLayer(); }
  const cam = (q.get("cam") || "").split(",").map(Number);
  if (cam.length === 3 && cam.every(Number.isFinite)) camera.position.copy(xyz(cam[0], cam[1], Math.min(8, Math.max(1.12, cam[2]))));
  const p = (q.get("p") || "").split(",").map(Number);
  if (p.length === 2 && p.every(Number.isFinite)) select(p[0], p[1]);
  if (q.has("h")) setHour(Number(q.get("h")) || 0);
  if (q.get("bare") === "1") toggleBare(true);
}

// ---------- legend, layers ----------
function setLayer() { layer = Number($("layer").value); uniforms.uLayer.value = layer; legend(); }
function legend() {
  const grad = (stops, log) => { const a = val(stops[0][0], log), b = val(stops.at(-1)[0], log); return `linear-gradient(90deg,${stops.map((s) => `rgb(${s[1].map((c) => Math.round(c * 255)).join(",")}) ${((val(s[0], log) - a) / (b - a) * 100).toFixed(0)}%`).join(",")})`; };
  const ticks = (a) => `<div class="ticks">${a.map((x) => `<span>${x}</span>`).join("")}</div>`;
  let h = "";
  if (layer === 0) h += `<b>Precipitation</b> · mm per hour (6 h mean)<div style="margin-top:4px">Rain</div><div class="bar" style="background:${grad(C.RAIN, true)}"></div>${ticks([0.1, 0.5, 2, 5, 10, 20, "40+"])}<div style="margin-top:4px">Snow (water equivalent, 2 m temperature below +1 °C)</div><div class="bar" style="background:${grad(C.SNOW, true)}"></div>${ticks([0.1, 1, 5, "20+"])}<div style="margin-top:4px">Cloud: white veil, total cover</div>`;
  if (layer === 1) h += `<b>2 m temperature</b> · °C<div class="bar" style="background:${grad(TEMP)}"></div>${ticks([-40, -25, -10, 0, 10, 20, 30, 40])}`;
  if (layer === 2) h += `<b>10 m wind speed</b> · m/s<div class="bar" style="background:${grad(WSPD)}"></div>${ticks([0, 5, 10, 15, 20, 30, 40])}`;
  const lab = ["<20", "20–40", "40–60", "60–90", "90+"];
  h += `<div style="margin-top:8px"><b>Wind trails</b> · 10 m wind, km/h</div><div class="bands">${C.WIND_BANDS.map((b, k) => `<span style="background:${b[1]}">${lab[k]}</span>`).join("")}</div>`;
  h += `<div style="margin-top:8px"><b>Isobars</b> every 4 hPa, 1000 hPa bolder</div>`;
  $("leg").innerHTML = h;
}

// ---------- loop ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (fly) {
    fly.t = Math.min(1, fly.t + dt / 1.2);
    const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
    const r = fly.p0.length() + (fly.p1.length() - fly.p0.length()) * e;
    camera.position.copy(fly.p0.clone().normalize().lerp(fly.p1.clone().normalize(), e).normalize().multiplyScalar(r));
    if (fly.t >= 1) fly = null;
  }
  const d = camera.position.length();
  controls.rotateSpeed = Math.min(1, Math.max(0.05, (d - 1) * 0.45)); controls.zoomSpeed = Math.min(1, Math.max(0.3, d - 1));
  controls.update();
  camera.near = Math.max(0.002, (d - 1) * 0.3); camera.far = d + 2; camera.updateProjectionMatrix();
  uniforms.uLight.value.copy(camera.position).normalize().applyAxisAngle(camera.up, 0.5).add(new THREE.Vector3(0, 0.4, 0)).normalize();
  stepTrails(dt); updateLabels();
  if (DEBUG && (DEBUG.n = (DEBUG.n || 0) + 1) % 5 === 0) console.log("dbg", DEBUG.n, parts.filter((p) => p.hist.length > 1).length, trails.visible, trailGeo.attributes.color.array.slice(0, 8).join(","));
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.target.tagName === "SELECT") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  if (e.key === "," || e.key === "[") setHour(hour - 1);
  if (e.key === "." || e.key === "]") setHour(hour + 1);
  if (e.key === "h" || e.key === "H") toggleBare();
});
{ // draggable point-forecast panel
  let drag = null;
  $("mgHead").addEventListener("pointerdown", (e) => { if (e.target.id === "mgClose") return; const r = $("mg").getBoundingClientRect(); drag = [e.clientX - r.left, e.clientY - r.top]; $("mgHead").setPointerCapture(e.pointerId); });
  $("mgHead").addEventListener("pointermove", (e) => { if (!drag) return; Object.assign($("mg").style, { left: `${e.clientX - drag[0]}px`, top: `${e.clientY - drag[1]}px`, bottom: "auto" }); });
  $("mgHead").addEventListener("pointerup", () => { drag = null; });
  $("mgClose").onclick = () => { $("mg").hidden = true; };
}

function status(t) { $("status").textContent = t; $("status").style.display = t ? "block" : "none"; }
async function main() {
  status("Loading the forecast…");
  try {
    M = await fetch(DATA + "meta.json").then((r) => r.json());
    const [ia, ib, io] = await Promise.all(["wx_a.png", "wx_b.png", "orog.png"].map((n) => loadImage(DATA + n + "?v=" + M.run)));
    NX = M.grid.nx; NY = M.grid.ny; COLS = M.grid.cols; NS = M.steps.length; HMAX = M.steps.at(-1);
    WA = pixels(ia); WB = pixels(ib); OR = pixels(io);
    makeGlobe(dataTex(ia), dataTex(ib), terrainTex());
  } catch (e) { status("Could not load the data: " + e.message); return; }
  status("");
  $("hour").max = HMAX;
  $("t0").textContent = FMT.format(new Date(M.t0 * 1000)) + " UTC"; $("t1").textContent = `+${HMAX} h`;
  $("runtxt").textContent = `Run of ${FMT.format(new Date(M.t0 * 1000))} UTC. Experimental, not an official forecast.`;
  makeTrails(); makeLabels(); legend();
  resetView(true);
  $("layer").onchange = setLayer;
  $("isob").onchange = () => { uniforms.uIsob.value = $("isob").checked ? 1 : 0; };
  $("night").onchange = () => { uniforms.uNight.value = $("night").checked ? 1 : 0; };
  $("exag").oninput = () => {
    uniforms.uExag.value = exag(); $("exagV").textContent = exag() + "×";
    for (const L of labelEls) L.p = xyz(L.lat, L.lon, 1 + heightAt(L.lat, L.lon) / RE * exag() + 0.002);
    if (selected) select(selected.lat, selected.lon);
  };
  $("hour").oninput = () => setHour(Number($("hour").value));
  $("prev").onclick = () => setHour(hour - 6); $("next").onclick = () => setHour(hour + 6);
  $("now").onclick = () => { const h = nowHour(); if (h !== null) setHour(h); };
  $("play").onclick = () => togglePlay();
  $("hide").onclick = () => toggleBare();
  $("share").onclick = share; $("reset").onclick = () => resetView(false);
  $("q").oninput = searchPlaces;
  setHour(nowHour() ?? 0);
  applyHash();
  for (let i = 0; i < 16; i++) stepTrails(0.075); // trails already formed on the first frame
  requestAnimationFrame(frame);
}
main();
