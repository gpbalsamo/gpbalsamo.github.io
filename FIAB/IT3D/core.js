// Pure helpers of the Italy 3D viewer (no DOM, no WebGL): decoding, colours, sun, places, formatting.
// Kept apart so that they can be tested with node (test_core.mjs).

export const KMDEG_LAT = 111.32;

// Byte -> physical value with the fixed ranges of meta.json enc: [lo, hi, sqrt]
export function decoder(enc) {
  const [lo, hi, sq] = enc, t = new Float32Array(256);
  for (let b = 0; b < 256; b++) { const x = b / 255; t[b] = sq ? x * x * hi : lo + x * (hi - lo); }
  return t;
}

// Frame k of an atlas (frames tiled cols per row, each ny x nx) -> offset of its (0, 0) cell in the atlas pixels
export function frameOrigin(k, cols, nx, ny, width) {
  const r = Math.floor(k / cols), c = k % cols;
  return r * ny * width + c * nx;
}

// Split an atlas (one byte per pixel, width = cols * nx) into frames: Uint8Array(n * ny * nx), frame-major
export function unpackAtlas(px, width, n, cols, nx, ny) {
  const out = new Uint8Array(n * ny * nx);
  for (let k = 0; k < n; k++) {
    const o = frameOrigin(k, cols, nx, ny, width);
    for (let j = 0; j < ny; j++) out.set(px.subarray(o + j * width, o + j * width + nx), (k * ny + j) * nx);
  }
  return out;
}

// Piecewise-linear colour ramp over stops [[value, [r, g, b]], ...] (0..1 components), in log10 of the value if log
export function ramp(stops, v, log) {
  const f = log ? Math.log10 : (x) => x;
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const a = (f(v) - f(stops[i - 1][0])) / (f(stops[i][0]) - f(stops[i - 1][0]));
      return stops[i - 1][1].map((c, n) => c + a * (stops[i][1][n] - c));
    }
  }
  return stops[stops.length - 1][1];
}

export function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); }

export const RAIN = [[0.1, "#c4ecff"], [0.5, "#7fcbff"], [2, "#2e8ef2"], [5, "#1d4fcf"], [10, "#f2c537"], [20, "#ff6b2c"], [40, "#d81f86"]]
  .map(([v, c]) => [v, hex(c)]);
export const SNOW = [[0.1, "#efe4ff"], [1, "#c8a6f4"], [5, "#9763da"], [20, "#5b27a3"]].map(([v, c]) => [v, hex(c)]);
// wind bands (km/h): upper bounds, colours, ribbon widths (px)
export const WIND_BANDS = [[20, "#eef3f7", 1.3], [40, "#ffe066", 1.9], [60, "#ffa94d", 2.6], [90, "#ff5c5c", 3.3], [Infinity, "#d63cff", 4.0]];
export function windBand(kmh) { for (let i = 0; i < WIND_BANDS.length; i++) if (kmh < WIND_BANDS[i][0]) return i; return WIND_BANDS.length - 1; }

// Solar elevation (deg) at time ms (UTC epoch) and place: low-precision almanac (declination and equation of time
// from the day angle), good to a few tenths of a degree, enough to shade the night in the meteogram.
export function sunElevation(ms, lat, lon) {
  const rad = Math.PI / 180, d = ms / 86400000 - 10957.5; // days since J2000.0
  const g = rad * (357.529 + 0.98560028 * d), q = 280.459 + 0.98564736 * d;
  const L = rad * (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)), e = rad * (23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = rad * (gmst * 15 + lon) - ra;
  return Math.asin(Math.sin(rad * lat) * Math.sin(dec) + Math.cos(rad * lat) * Math.cos(dec) * Math.cos(ha)) / rad;
}

// Great-circle distance (km) and initial bearing (deg) from (la1, lo1) to (la2, lo2)
export function distBearing(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, p1 = la1 * r, p2 = la2 * r, dl = (lo2 - lo1) * r;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  const b = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r;
  return [km, (b + 360) % 360];
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function compass8(deg) { return COMPASS[Math.round(deg / 45) % 8]; }
const COMPASS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass16(deg) { return COMPASS16[Math.round(deg / 22.5) % 16]; }

// "12 km SW of Bolzano" (or "Bolzano" when within 3 km); towns: [[name, lat, lon], ...]
export function nearTown(towns, lat, lon) {
  let best = null, bd = Infinity;
  for (const t of towns) { const [km] = distBearing(t[1], t[2], lat, lon); if (km < bd) { bd = km; best = t; } }
  if (!best) return "";
  if (bd < 3) return best[0];
  const [, brg] = distBearing(best[1], best[2], lat, lon);
  return `${Math.round(bd)} km ${compass8(brg)} of ${best[0]}`;
}

// Wind (u, v, m/s) -> [speed km/h, direction it blows from, deg]
export function windOf(u, v) { return [Math.hypot(u, v) * 3.6, (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360]; }

// Accent-insensitive key for the place search
export function searchKey(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }

export function niceStep(range, n = 4) {
  const raw = Math.max(range, 1e-6) / n, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((m) => m * p >= raw) * p;
}
